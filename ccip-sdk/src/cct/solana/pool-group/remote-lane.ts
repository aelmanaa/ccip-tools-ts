/**
 * Reads the Solana side of an EVM multi-token pool lane, for the EVM post-state guards (design
 * §7.2): which pool the Solana registry names for the remote mint, the kind and pool-data format
 * of that pool's lane back toward the EVM chain, and what that lane trusts and allows.
 *
 * Loaded lazily by the EVM guard, only for a Solana remote, so `cct/evm` takes no static Solana
 * import. Uses only `getAccountInfo`, `getMultipleAccountsInfo` and `getAddressLookupTable`.
 *
 * @packageDocumentation
 */

import { Buffer } from 'buffer'

import { type AccountInfo, type Connection, PublicKey } from '@solana/web3.js'

import type { Chain, RateLimiterState } from '../../../chain.ts'
import { decodeTokenAdminRegistryConfig } from '../../../solana/token-admin-registry.ts'
import {
  type TokenPoolChainConfig,
  decodeTokenPoolChainConfig,
  decodeTokenPoolStateConfig,
  deriveTokenPoolChainConfigV2Pda,
} from '../../../solana/token-pool.ts'
import { convertRateLimiter } from '../../../solana/utils.ts'
import { CCTDataDecodeError } from '../../errors.ts'
import type { MultiTokenPoolRemoteFact } from '../../evm/pool-config-manager/guards.ts'
import type { PoolDataFormat } from '../../multi-token-pool.ts'
import { decodeRemoteAddress } from '../../remote-address.ts'
import { deriveTokenAdminRegistryPda } from '../programs/router.ts'
import { deriveTokenPoolChainConfigPda, deriveTokenPoolConfigPda } from '../programs/token-pool.ts'
import {
  type PolicyChainRecordAccount,
  type PoolGroupClass,
  type PoolGroupLaneExt,
  type PoolGroupLaneMarker,
  decodePoolGroupChainConfigV2,
  decodePoolGroupIdlAccount,
  decodePoolGroupLaneMarker,
  poolGroupChainAdmits,
  poolGroupPdas,
} from './accounts.ts'

/** Index of the pool `State` in a registry's pool lookup table. */
const LOOKUP_TABLE_TOKEN_POOL_INDEX = 3
/** `PolicyClass::bit` of each class carried by a policy chain record. */
const CLASS_BIT: Record<PoolGroupClass, number> = {
  connection: 1,
  fee: 2,
  rateLimit: 4,
  security: 8,
}

/** What the EVM guard asks about one EVM → Solana lane. @internal */
export type SolanaRemoteLaneQuery = {
  /** The EVM (local) chain selector: the Solana lane's remote chain. */
  remoteChainSelector: bigint
  /** The Solana mint the EVM lane names as its remote token (base58). */
  mint: string
  /** The pool `State` PDAs the EVM lane trusts (base58); the first one names the Router. */
  trustedPools: readonly string[]
  /** Also read the lane back's outbound bucket (for the lane check). */
  readRateLimits?: boolean
}

/** The Solana lane back toward the EVM chain. @internal */
export type SolanaRemoteLaneBack = {
  /** The EVM token the Solana lane names, as a checksummed `0x` address. */
  remoteToken: string
  /** The mint's decimals (the pool `State`'s), to convert rate limits into local units. */
  remoteDecimals: number
  /** The EVM pools the lane accepts: its own and, when `CONNECTION` comes from a policy, the policy's. */
  remotePools: string[]
  /** Outbound bucket, `null` when disabled; read with `readRateLimits` when `RATE_LIMIT` is inline. */
  outboundRateLimiterState?: RateLimiterState
  /** Why `outboundRateLimiterState` is absent although `readRateLimits` was set. */
  outboundUnknownReason?: string
  /** Paused toward the EVM chain: the group, its chain record, the lane, or driven lanes paused. */
  pausedOutbound: boolean
  /** Paused from the EVM chain, likewise. */
  pausedInbound: boolean
  /** Group-driven lanes: whether the group's chain record admits the member now. */
  admitted?: boolean
}

/**
 * The Solana side of one lane. `'missing'`: the lane trusts no pool, or the trusted pool does not
 * exist; `'unknown'`: the accounts cannot be read as the program writes them (fail closed).
 * @internal
 */
export type SolanaRemoteLaneFacts = MultiTokenPoolRemoteFact<{
  /** The pool `State` the Router's registry names for the mint, or `null` when it names none. */
  registryPool: string | null
  /** The program owning `registryPool`. */
  poolProgram?: string
  /** The registry's pool interface for the mint: 1 (CCIP 1.6-compatible) or 2. */
  interfaceVersion?: number
  /** Kind of the registry pool's lane toward the EVM chain; `'none'` when it has no `ChainConfig`. */
  laneKind: PoolGroupLaneMarker | 'none'
  /** The format the lane sends (effective `CONNECTION`); `'legacy'` on a standard lane. */
  poolDataFormat?: PoolDataFormat
  /**
   * Whether the registry pool reads long pool data from the EVM chain, by the design rule (§7.2):
   * interface 2, a marked (linked or driven) lane, and an effective format of `'long'`.
   *
   * @remarks The program is looser: on interface 2, `validate_source_pool_data`
   * (`base-token-pool/src/pool_data.rs:151`) accepts long data on any lane of the pool-groups
   * program, and a `'legacy'` lane only refuses legacy data from policy pools. The rule here also
   * holds for a lane that later moves to interface 1, where marked lanes refuse every transfer and
   * standard pools read only empty or 32-byte data, and it is decidable from accounts without a
   * feature probe. It fails closed.
   */
  readsLongData: boolean
  /** The lane back, when the registry pool has a `ChainConfig` toward the EVM chain. */
  back?: SolanaRemoteLaneBack
}>

/** What one trusted Solana pool is, for the EVM side. @internal */
export type SolanaRemotePoolFacts = MultiTokenPoolRemoteFact<{
  /**
   * Whether the pool sends long pool data toward the EVM chain: it is the pool the registry names
   * for its mint on interface 2, its lane toward the EVM chain is marked, and that lane's effective
   * format is `'long'`. A standard or interface-1 pool is `false`.
   */
  isMultiTokenPool: boolean
}>

type Unread = { status: 'missing' | 'unknown'; reason: string }
const unknown = (reason: string): Unread => ({ status: 'unknown', reason })
const missing = (reason: string): Unread => ({ status: 'missing', reason })

/** Runs a decoder, turning a decode failure into an `'unknown'` reason. */
function tryDecode<T>(what: string, decode: () => T): T | Unread {
  try {
    return decode()
  } catch (err) {
    const reason = err instanceof CCTDataDecodeError ? err.context.reason : undefined
    const why =
      typeof reason === 'string' ? reason : err instanceof Error ? err.message : String(err)
    return unknown(`${what} cannot be decoded: ${why}`)
  }
}
const isUnread = (v: unknown): v is Unread =>
  typeof v === 'object' && v !== null && 'status' in v && 'reason' in v

function parseKey(value: string, what: string): PublicKey | Unread {
  try {
    return new PublicKey(value)
  } catch {
    return unknown(`${what} ${value} is not a Solana address`)
  }
}

type RegistryRead = {
  registryPool: PublicKey | null
  interfaceVersion?: number
}

/** The registry entry of `mint` on `router`: transport errors propagate, a missing table is no pool. */
async function readRegistry(
  remote: { connection: Connection },
  router: PublicKey,
  mint: PublicKey,
): Promise<RegistryRead | Unread> {
  const address = deriveTokenAdminRegistryPda(router, mint)
  const account = await remote.connection.getAccountInfo(address)
  if (!account) return { registryPool: null }
  if (!account.owner.equals(router))
    return unknown(`the registry account ${address.toBase58()} is not owned by the Router`)
  const config = tryDecode(`the registry account ${address.toBase58()}`, () =>
    decodeTokenAdminRegistryConfig(account.data),
  )
  if (isUnread(config)) return config
  if (!config.lookupTable) return { registryPool: null, interfaceVersion: config.interfaceVersion }
  const table = await remote.connection.getAddressLookupTable(config.lookupTable)
  const pool = table.value?.state.addresses[LOOKUP_TABLE_TOKEN_POOL_INDEX]
  return {
    registryPool: pool && !pool.equals(PublicKey.default) ? pool : null,
    interfaceVersion: config.interfaceVersion,
  }
}

type LaneRead = {
  laneKind: PoolGroupLaneMarker | 'none'
  poolDataFormat?: PoolDataFormat
  back?: SolanaRemoteLaneBack
}

/**
 * Reads the lane of pool `program` for (`mint`, `selector`) and resolves what the program resolves
 * at transfer time (`resolve_lane_policy_with`, `require_lane_not_paused`, `load_lane_group_chain`).
 */
async function readLane(
  remote: { connection: Connection },
  program: PublicKey,
  mint: PublicKey,
  decimals: number,
  selector: bigint,
  readRateLimits: boolean,
): Promise<LaneRead | Unread> {
  const conn = remote.connection
  const ccAddress = deriveTokenPoolChainConfigPda(program, selector, mint)
  const v2Address = deriveTokenPoolChainConfigV2Pda(program, selector, mint)
  const [cc, v2] = await conn.getMultipleAccountsInfo([ccAddress, v2Address])
  if (!cc) return { laneKind: 'none' }
  for (const [acc, addr] of [
    [cc, ccAddress],
    [v2, v2Address],
  ] as const)
    if (acc && !acc.owner.equals(program))
      return unknown(`lane account ${addr.toBase58()} is not owned by the pool program`)
  const base = tryDecode<TokenPoolChainConfig>(`the ChainConfig ${ccAddress.toBase58()}`, () =>
    decodeTokenPoolChainConfig(cc.data),
  )
  if (isUnread(base)) return base
  const laneKind = decodePoolGroupLaneMarker(cc.data, base)
  const lane = v2
    ? tryDecode(`the ChainConfigV2 ${v2Address.toBase58()}`, () =>
        decodePoolGroupChainConfigV2(v2.data, v2Address.toBase58()),
      )
    : null
  if (isUnread(lane)) return lane
  const ext = lane?.ext ?? null
  // the program requires the two records to agree (`require_link_marker_matches`)
  if ((laneKind !== 'standard') !== (ext !== null))
    return unknown(
      `the lane's ChainConfig marker (${laneKind}) and its ChainConfigV2 ${ext ? 'tail' : 'lack of a tail'} disagree`,
    )
  if (ext && (laneKind === 'driven') !== ext.groupDriven)
    return unknown(`the lane's ChainConfig marker (${laneKind}) and its group_driven flag disagree`)

  const decode = (bytes: Buffer, what: string) =>
    tryDecode(`the lane's ${what}`, () => decodeRemoteAddress(bytes, selector))
  const remoteToken = decode(Buffer.from(base.remote.tokenAddress.address), 'remote token')
  if (isUnread(remoteToken)) return remoteToken
  const ownPools: Buffer[] = base.remote.poolAddresses.map((p) => Buffer.from(p.address))

  const inlineOutbound = () =>
    readRateLimits ? { outboundRateLimiterState: convertRateLimiter(base.outboundRateLimit) } : {}

  if (!ext || !ext.poolGroupAddress) {
    // a standard lane, or a marked lane with only its own pool-data settings: every class is
    // inline and pauses do not apply (`require_lane_not_paused` returns early when unlinked)
    const pools = decodeAll(ownPools, decode)
    if (isUnread(pools)) return pools
    return {
      laneKind,
      poolDataFormat: ext?.poolDataFormat ?? 'legacy',
      back: {
        remoteToken,
        remoteDecimals: decimals,
        remotePools: pools,
        pausedOutbound: false,
        pausedInbound: false,
        ...inlineOutbound(),
      },
    }
  }
  return readLinkedLane(
    remote,
    program,
    selector,
    new PublicKey(ext.poolGroupAddress),
    ext,
    laneKind,
    {
      remoteToken,
      decimals,
      ownPools,
      decode,
      inlineOutbound,
      readRateLimits,
    },
  )
}

function decodeAll(
  pools: readonly Buffer[],
  decode: (bytes: Buffer, what: string) => string | Unread,
): string[] | Unread {
  const out: string[] = []
  for (const pool of pools) {
    const address = decode(pool, 'remote pool')
    if (isUnread(address)) return address
    if (!out.includes(address)) out.push(address)
  }
  return out
}

async function readLinkedLane(
  remote: { connection: Connection },
  program: PublicKey,
  selector: bigint,
  group: PublicKey,
  ext: PoolGroupLaneExt,
  laneKind: PoolGroupLaneMarker,
  lane: {
    remoteToken: string
    decimals: number
    ownPools: Buffer[]
    decode: (bytes: Buffer, what: string) => string | Unread
    inlineOutbound: () => { outboundRateLimiterState?: RateLimiterState }
    readRateLimits: boolean
  },
): Promise<LaneRead | Unread> {
  const gcpAddress = poolGroupPdas.groupChain(program, group, selector)
  // the named records the receive and send classes read here: CONNECTION and RATE_LIMIT
  const slots = new Map<number, PublicKey>()
  for (const cls of ['connection', 'rateLimit'] as const) {
    const source = ext.classSource[cls]
    if (source.kind !== 'policy') continue
    const policy = ext.policySlots[source.slot]
    if (!policy)
      return unknown(`the lane takes ${cls} from policy slot ${source.slot}, which is empty`)
    slots.set(source.slot, poolGroupPdas.policyChain(program, new PublicKey(policy), selector))
  }
  const addresses = [gcpAddress, ...slots.values()]
  const accounts = await remote.connection.getMultipleAccountsInfo(addresses)
  const owned = (acc: AccountInfo<Buffer> | null, address: PublicKey, what: string) => {
    if (!acc) return unknown(`the lane's ${what} ${address.toBase58()} does not exist`)
    if (!acc.owner.equals(program))
      return unknown(`the lane's ${what} ${address.toBase58()} is not owned by the pool program`)
    return acc
  }
  const gcpAccount = owned(accounts[0] ?? null, gcpAddress, 'group chain record')
  if (isUnread(gcpAccount)) return gcpAccount
  const gcp = tryDecode(`the group chain record ${gcpAddress.toBase58()}`, () =>
    decodePoolGroupIdlAccount('groupChainPolicy', gcpAccount.data, gcpAddress.toBase58()),
  )
  if (isUnread(gcp)) return gcp
  if (!gcp.group.equals(group) || BigInt(gcp.remoteChainSelector.toString()) !== selector)
    return unknown(`the group chain record ${gcpAddress.toBase58()} is not the lane's`)

  const named = new Map<number, PolicyChainRecordAccount>()
  for (const [i, [slot, address]] of [...slots.entries()].entries()) {
    const acc = owned(accounts[i + 1] ?? null, address, `policy slot ${slot} chain record`)
    if (isUnread(acc)) return acc
    const record = tryDecode(`the policy chain record ${address.toBase58()}`, () =>
      decodePoolGroupIdlAccount('policyChainRecord', acc.data, address.toBase58()),
    )
    if (isUnread(record)) return record
    if (!record.group.equals(group))
      return unknown(`the policy chain record ${address.toBase58()} belongs to another group`)
    named.set(slot, record)
  }

  const sectionFor = (cls: 'connection' | 'rateLimit') => {
    const source = ext.classSource[cls]
    if (source.kind === 'inline') return undefined
    if (source.kind === 'default') return gcp.policy
    const record = named.get(source.slot)
    if (!record || (record.classes & CLASS_BIT[cls]) === 0)
      return unknown(`the policy record in slot ${source.slot} does not carry ${cls}`)
    return record.sections
  }
  const connection = sectionFor('connection')
  if (isUnread(connection)) return connection
  const rateLimit = sectionFor('rateLimit')
  if (isUnread(rateLimit)) return rateLimit

  const policyPools = (connection?.connection.remotePools ?? []).map((p) =>
    Buffer.from(p.address.address),
  )
  const pools = decodeAll([...lane.ownPools, ...policyPools], lane.decode)
  if (isUnread(pools)) return pools
  const poolDataFormat: PoolDataFormat = connection
    ? 'long' in connection.connection.poolDataFormat
      ? 'long'
      : 'legacy'
    : ext.poolDataFormat
  const driven = laneKind === 'driven'
  const drivenPaused = driven && gcp.drivenLanesPaused
  return {
    laneKind,
    poolDataFormat,
    back: {
      remoteToken: lane.remoteToken,
      remoteDecimals: lane.decimals,
      remotePools: pools,
      pausedOutbound: gcp.groupPaused || gcp.pausedOutbound || ext.pausedOutbound || drivenPaused,
      pausedInbound: gcp.groupPaused || gcp.pausedInbound || ext.pausedInbound || drivenPaused,
      ...(driven && { admitted: poolGroupChainAdmits(gcp, gcpAccount.data, ext.memberIndex) }),
      ...(rateLimit
        ? lane.readRateLimits && {
            outboundUnknownReason:
              "the lane's RATE_LIMIT comes from a policy record; its effective config is read in a later increment",
          }
        : lane.inlineOutbound()),
    },
  }
}

/** Resolves the remote chain to a `SolanaChain`, or explains why not. */
async function solanaChainOf(remote: Chain) {
  const { SolanaChain } = await import('../../../solana/index.ts')
  return remote instanceof SolanaChain
    ? remote
    : unknown(`the remote chain ${remote.network.name} is not a Solana chain`)
}

/**
 * Reads the Solana side of an EVM → Solana lane: the pool the Router's registry names for `mint`
 * (found through the first trusted pool's Router), and that pool's lane toward the EVM chain.
 *
 * @param remote - The Solana chain, from the guard's `getChain`.
 * @param query - The lane, from the EVM side.
 * @returns The facts; `'missing'` when the lane trusts no pool or the trusted pool does not exist,
 *   `'unknown'` when an account cannot be read as the program writes it, or when `remote` is not a
 *   Solana chain. A registry that names no pool is `'known'` with `registryPool: null`.
 * @throws the RPC's errors, unchanged (transport failures are never read as a fact)
 * @internal
 */
export async function readSolanaRemoteLaneFacts(
  remote: Chain,
  query: SolanaRemoteLaneQuery,
): Promise<SolanaRemoteLaneFacts> {
  const solana = await solanaChainOf(remote)
  if (isUnread(solana)) return solana
  const [first] = query.trustedPools
  if (first === undefined)
    return missing('the lane trusts no remote pool, so its remote registry cannot be found')
  const mint = parseKey(query.mint, 'the remote token')
  if (isUnread(mint)) return mint
  const trusted = parseKey(first, 'the trusted remote pool')
  if (isUnread(trusted)) return trusted

  const trustedAccount = await solana.connection.getAccountInfo(trusted)
  if (!trustedAccount) return missing(`the trusted remote pool ${first} does not exist`)
  const trustedState = tryDecode(`the trusted remote pool ${first}`, () =>
    decodeTokenPoolStateConfig(trustedAccount.data),
  )
  if (isUnread(trustedState)) return trustedState

  const registry = await readRegistry(solana, trustedState.router, mint)
  if (isUnread(registry)) return registry
  const none = { registryPool: null, laneKind: 'none' as const, readsLongData: false }
  if (!registry.registryPool)
    return {
      status: 'known',
      ...none,
      ...(registry.interfaceVersion !== undefined && {
        interfaceVersion: registry.interfaceVersion,
      }),
    }
  const registryPool = registry.registryPool
  const poolAccount = registryPool.equals(trusted)
    ? trustedAccount
    : await solana.connection.getAccountInfo(registryPool)
  if (!poolAccount)
    return missing(`the registry names pool ${registryPool.toBase58()}, which does not exist`)
  const program = poolAccount.owner
  const state = tryDecode(`the registry pool ${registryPool.toBase58()}`, () =>
    decodeTokenPoolStateConfig(poolAccount.data),
  )
  if (isUnread(state)) return state
  if (!state.mint.equals(mint) || !deriveTokenPoolConfigPda(program, mint).equals(registryPool))
    return unknown(`the registry pool ${registryPool.toBase58()} is not the mint's pool State`)

  const lane = await readLane(
    solana,
    program,
    mint,
    state.decimals,
    query.remoteChainSelector,
    !!query.readRateLimits,
  )
  if (isUnread(lane)) return lane
  return {
    status: 'known',
    registryPool: registryPool.toBase58(),
    poolProgram: program.toBase58(),
    interfaceVersion: registry.interfaceVersion,
    ...lane,
    readsLongData:
      registry.interfaceVersion === 2 &&
      (lane.laneKind === 'linked' || lane.laneKind === 'driven') &&
      lane.poolDataFormat === 'long',
  }
}

/**
 * Reads whether a trusted Solana pool sends long pool data toward the EVM chain: the pool `State`
 * at `poolAddress`, the registry entry of its mint, and its lane toward `remoteChainSelector`.
 *
 * @param remote - The Solana chain, from the guard's `getChain`.
 * @param params - `remoteChainSelector`: the EVM (local) chain selector, the Solana lane's remote
 *   chain; `poolAddress`: the trusted pool `State` PDA (base58).
 * @returns `isMultiTokenPool` (see {@link SolanaRemotePoolFacts}); `'missing'` when the pool does
 *   not exist, `'unknown'` when it cannot be read as the program writes it.
 * @throws the RPC's errors, unchanged
 * @internal
 */
export async function readSolanaRemotePoolFacts(
  remote: Chain,
  { remoteChainSelector, poolAddress }: { remoteChainSelector: bigint; poolAddress: string },
): Promise<SolanaRemotePoolFacts> {
  const solana = await solanaChainOf(remote)
  if (isUnread(solana)) return solana
  const pool = parseKey(poolAddress, 'the remote pool')
  if (isUnread(pool)) return pool
  const account = await solana.connection.getAccountInfo(pool)
  if (!account) return missing(`the remote pool ${poolAddress} does not exist`)
  const state = tryDecode(`the remote pool ${poolAddress}`, () =>
    decodeTokenPoolStateConfig(account.data),
  )
  if (isUnread(state)) return state
  const facts = await readSolanaRemoteLaneFacts(solana, {
    remoteChainSelector,
    mint: state.mint.toBase58(),
    trustedPools: [poolAddress],
  })
  if (facts.status !== 'known') return facts
  return {
    status: 'known',
    isMultiTokenPool: facts.registryPool === poolAddress && facts.readsLongData,
  }
}
