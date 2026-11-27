/**
 * Reads the Solana side of an EVM multi-token pool lane, for the EVM post-state guards (design
 * §7.2): which pool the Solana registry names for the remote mint, the kind and pool-data format
 * of that pool's lane back toward the EVM chain, and what that lane trusts and allows.
 *
 * Loaded lazily by the EVM guard, only for a Solana remote, so `cct/evm` takes no static Solana
 * import. Reads accounts, and the Router's `type_version` through `getTokenAdminRegistryFor`.
 *
 * @packageDocumentation
 */

import { Buffer } from 'buffer'

import { type AccountInfo, PublicKey } from '@solana/web3.js'

import type { Chain, RateLimiterState } from '../../../chain.ts'
import {
  CCIPDataFormatUnsupportedError,
  CCIPError,
  CCIPSolanaOffRampEventsNotFoundError,
  CCIPTokenNotConfiguredError,
} from '../../../errors/index.ts'
import type { SolanaChain } from '../../../solana/index.ts'
import { getTokenAdminRegistryConfig } from '../../../solana/token-admin-registry.ts'
import {
  type TokenPoolStateConfig,
  decodeTokenPoolStateConfig,
} from '../../../solana/token-pool.ts'
import { isSimulationFailure } from '../../../solana/utils.ts'
import { toLeArray } from '../../../utils.ts'
// TODO(track merge): import MultiTokenPoolRemoteFact from '../../multi-token-pool.ts' (moved on the
// EVM stack at 9e0bfb9d; guards.ts re-exports it)
import type { MultiTokenPoolRemoteFact } from '../../evm/pool-config-manager/guards.ts'
import type { PoolDataFormat } from '../../multi-token-pool.ts'
import { decodeRemoteAddress } from '../../remote-address.ts'
import { deriveTokenPoolConfigPda } from '../programs/token-pool.ts'
import type { PoolGroupLaneMarker } from './accounts.ts'
import {
  type Unread,
  isUnread,
  laneFailsClosed,
  laneFormat,
  laneOutboundRateLimiter,
  lanePauses,
  laneSectionsFor,
  missing,
  readPoolGroupLaneState,
  tryDecode,
  unknown,
} from './lane.ts'

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

/** One EVM pool the Solana lane accepts. @internal */
export type SolanaRemoteLanePool = {
  /** Checksummed `0x` EVM address. */
  address: string
  /**
   * The stored bytes as `0x` hex: the program compares these, byte for byte, with the source pool
   * the OffRamp passes. The Solana OffRamp trims that source pool to the source chain's
   * `legacy_address_length` before the pool sees it (`normalized_address`,
   * `ccip-offramp/src/instructions/execute/token_transfer.rs:301`; EVM sources use 20,
   * `admin/source_chain.rs:268`), and does not trim the token. So for an EVM remote the lane holds
   * the token as 32 bytes, padded, and each pool at {@link SolanaRemoteLaneFacts}'
   * `sourcePoolAddressLength`, native (20).
   */
  raw: string
  /** The lane's own list, or its CONNECTION policy record's. */
  source: 'own' | 'policy'
  /**
   * Whether the lane accepts legacy (empty or 32-byte) pool data from this pool
   * (`validate_source_pool_data`): never when the lane sends the long format or has a UID; else
   * always from its own pools, and from a policy pool only with the record's
   * `allow_legacy_pool_data`.
   */
  allowLegacyPoolData: boolean
}

/** The Solana lane back toward the EVM chain. @internal */
export type SolanaRemoteLaneBack = {
  /** The EVM token the Solana lane names, as a checksummed `0x` address. */
  remoteToken: string
  /**
   * The stored remote token bytes as `0x` hex. Long pool data must name exactly these as its
   * source token (`SourceTokenMismatch`): the EVM multi-token pool sends `abi.encode(address)`, 32
   * bytes, so a 20-byte entry here refuses every long transfer.
   */
  remoteTokenRaw: string
  /** The remote decimals the lane stores; inbound pool data must report these. */
  remoteTokenDecimals: number
  /** The mint's decimals (the pool `State`'s), to convert rate limits into local units. */
  remoteDecimals: number
  /** The EVM pools the lane accepts, each with its stored bytes and legacy acceptance. */
  remotePools: SolanaRemoteLanePool[]
  /**
   * Outbound bucket as transfers consume it, `null` when disabled; read with `readRateLimits`. With
   * RATE_LIMIT from a policy record, the stored tokens under that record's config.
   */
  outboundRateLimiterState?: RateLimiterState
  /**
   * Paused toward the EVM chain: the group, its chain record, the lane, and on a driven lane
   * `driven_lanes_paused` or a chain record that does not admit the member.
   */
  pausedOutbound: boolean
  /** Paused from the EVM chain, likewise. */
  pausedInbound: boolean
  /** Group-driven lanes: whether the group's chain record admits the member now. */
  admitted?: boolean
  /**
   * Set when every transfer on the lane reverts in both directions although it is not paused: a
   * stale SECURITY record or an unsynced CCV copy. Treat the lane as not live.
   */
  failsClosed?: string
}

/**
 * The Solana side of one lane. `'missing'`: the lane trusts no pool, or the trusted pool does not
 * exist; `'unknown'`: the accounts cannot be read as the program writes them (fail closed).
 * @internal
 */
export type SolanaRemoteLaneFacts = MultiTokenPoolRemoteFact<{
  /** The pool `State` the Router's registry names for the mint, or `null` when it names none. */
  registryPool: string | null
  /** The Router whose registry was read (the trusted pool's), for information. */
  router: string
  /** The program owning `registryPool`. */
  poolProgram?: string
  /** The registry's pool interface for the mint: 1 (CCIP 1.6-compatible) or 2. */
  interfaceVersion?: number
  /** Kind of the registry pool's lane toward the EVM chain; `'none'` when it has no `ChainConfig`. */
  laneKind: PoolGroupLaneMarker | 'none'
  /** The format the lane sends (effective `CONNECTION`); `'legacy'` on a standard lane. */
  poolDataFormat?: PoolDataFormat
  /**
   * The lane's factory UID as `0x` hex, or `null`. A lane with a UID requires it as the additional
   * data of every inbound long transfer (`InvalidAdditionalPoolData`) and refuses legacy data.
   */
  uid?: string | null
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
  /**
   * The `legacy_address_length` of the EVM chain in the Solana OffRamp's source-chain config: the
   * length the OffRamp trims a source pool address to before the pool compares it with
   * `remotePools[].raw`. Read from the 2.x OffRamps the Router allows for the EVM chain
   * (`getOffRampsForRouter`), when the lane back exists; `null` when none has the field or they
   * disagree. Do not assume 20 when it is `null`.
   */
  sourcePoolAddressLength?: number | null
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

function parseKey(value: string, what: string): PublicKey | Unread {
  try {
    return new PublicKey(value)
  } catch {
    return unknown(`${what} ${value} is not a Solana address`)
  }
}

/** A pool `State` at its PDA under its owner. */
type PoolState = { address: PublicKey; program: PublicKey; state: TokenPoolStateConfig }

/** Decodes a pool `State` and checks it sits at its PDA under the program that owns it. */
function poolState(
  address: PublicKey,
  account: AccountInfo<Buffer>,
  what: string,
): PoolState | Unread {
  const state = tryDecode(what, () => decodeTokenPoolStateConfig(account.data))
  if (isUnread(state)) return state
  if (!deriveTokenPoolConfigPda(account.owner, state.mint).equals(address))
    return unknown(`${what} is not the pool State PDA of its mint under its owner program`)
  return { address, program: account.owner, state }
}

/** Errors that mean "this account is not a working Router", rather than a transport failure. */

/**
 * The registry the trusted pool's Router keeps, with the SDK's `getTokenAdminRegistryFor`
 * semantics (a Router `type_version`, an OffRamp followed to its Router): an account that is not a
 * Router is `'unknown'`, transport errors propagate.
 */
async function registryOf(solana: SolanaChain, router: PublicKey): Promise<PublicKey | Unread> {
  try {
    return new PublicKey(await solana.getTokenAdminRegistryFor(router.toBase58()))
  } catch (err) {
    if (notTransient(err))
      return unknown(`the trusted pool's Router ${router.toBase58()} is not a CCIP Router`)
    throw err
  }
}

const notTransient = (err: unknown) =>
  isSimulationFailure(err) || (err instanceof CCIPError && !err.isTransient)

/**
 * `legacy_address_length` of a 2.x OffRamp's `SourceChain` account: after the discriminator,
 * version, bump and selector, `config` holds `is_enabled`, `on_ramps` (64 + 4 bytes each),
 * `default_ccvs`, `lane_mandated_ccvs`, then the length. `undefined` when the account ends before
 * it (an OffRamp that predates the field) or is truncated.
 */
function decodeLegacyAddressLength(data: Buffer): number | undefined {
  let at = 8 + 1 + 1 + 8 + 1
  const vec = (item: number) => {
    if (at + 4 > data.length) return false
    at += 4 + data.readUInt32LE(at) * item
    return at <= data.length
  }
  if (!vec(68) || !vec(32) || !vec(32) || at >= data.length) return undefined
  return data[at]
}

/**
 * The `legacy_address_length` the Router's 2.x OffRamps configure for `source` (the existing
 * `getOffRampsForRouter` discovery, then each OffRamp's `source_chain_state`).
 */
async function readSourcePoolAddressLength(
  solana: SolanaChain,
  router: PublicKey,
  source: bigint,
): Promise<number | null> {
  let offRamps
  try {
    offRamps = await solana.getOffRampsForRouter(router.toBase58(), source)
  } catch (err) {
    if (err instanceof CCIPSolanaOffRampEventsNotFoundError) return null
    throw err
  }
  const lengths = new Set<number>()
  for (const offRamp of offRamps) {
    let version
    try {
      ;[, version] = await solana.typeAndVersion(offRamp)
    } catch (err) {
      if (notTransient(err)) continue
      throw err
    }
    if (!version.startsWith('2.')) continue
    const program = new PublicKey(offRamp)
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('source_chain_state'), toLeArray(source, 8)],
      program,
    )
    const account = await solana.connection.getAccountInfo(pda)
    if (!account?.owner.equals(program)) continue
    const length = decodeLegacyAddressLength(account.data)
    if (length !== undefined) lengths.add(length)
  }
  return lengths.size === 1 ? [...lengths][0]! : null
}

/** The registry entry of `mint`: its pool and interface, with transport errors propagating. */
async function readRegistry(
  solana: SolanaChain,
  router: PublicKey,
  mint: PublicKey,
): Promise<{ registryPool: PublicKey | null; interfaceVersion?: number } | Unread> {
  try {
    const config = await getTokenAdminRegistryConfig(solana.connection, router, mint, {
      propagateRpcErrors: true,
    })
    return { registryPool: config.tokenPool ?? null, interfaceVersion: config.interfaceVersion }
  } catch (err) {
    if (err instanceof CCIPTokenNotConfiguredError) return { registryPool: null }
    if (err instanceof CCIPDataFormatUnsupportedError)
      return unknown(`the registry entry of ${mint.toBase58()} cannot be read: ${err.message}`)
    throw err
  }
}

type LaneRead = Pick<
  Extract<SolanaRemoteLaneFacts, { status: 'known' }>,
  'laneKind' | 'poolDataFormat' | 'uid' | 'back'
>

/** The lane of pool `program` toward `selector`, in the guard's terms. */
async function readLane(
  solana: SolanaChain,
  program: PublicKey,
  mint: PublicKey,
  decimals: number,
  selector: bigint,
  readRateLimits: boolean,
): Promise<LaneRead | Unread> {
  // The lane base is decoded here rather than with `getTokenPoolRemotes`, which swallows decode
  // errors and drops the raw bytes the marker and the byte checks need.
  const state = await readPoolGroupLaneState(solana.connection, program, mint, selector)
  if (state === null) return { laneKind: 'none' }
  if (isUnread(state)) return state
  const decode = (bytes: Buffer, what: string) =>
    tryDecode(`the lane's ${what}`, () => decodeRemoteAddress(bytes, selector))
  const { remote: config } = state.chainConfig.base
  const tokenBytes = Buffer.from(config.tokenAddress.address)
  const remoteToken = decode(tokenBytes, 'remote token')
  if (isUnread(remoteToken)) return remoteToken
  const connection = laneSectionsFor(state, 'connection')
  if (isUnread(connection)) return connection
  const poolDataFormat = laneFormat(state)
  if (isUnread(poolDataFormat)) return poolDataFormat
  const uid = state.ext?.uid ?? null
  const legacyOk = poolDataFormat !== 'long' && uid === null
  const remotePools: SolanaRemoteLanePool[] = []
  for (const [bytes, source, allow] of [
    ...config.poolAddresses.map((p) => [Buffer.from(p.address), 'own', true] as const),
    ...(connection?.connection.remotePools ?? []).map(
      (p) => [Buffer.from(p.address.address), 'policy', p.allowLegacyPoolData] as const,
    ),
  ]) {
    const address = decode(bytes, 'remote pool')
    if (isUnread(address)) return address
    remotePools.push({
      address,
      raw: `0x${bytes.toString('hex')}`,
      source,
      allowLegacyPoolData: legacyOk && allow,
    })
  }
  let outbound = {}
  if (readRateLimits) {
    const bucket = laneOutboundRateLimiter(state)
    if (isUnread(bucket)) return bucket
    outbound = { outboundRateLimiterState: bucket }
  }
  const failsClosed = laneFailsClosed(state)
  if (isUnread(failsClosed)) return failsClosed
  return {
    laneKind: state.kind,
    poolDataFormat,
    uid,
    back: {
      remoteToken,
      remoteTokenRaw: `0x${tokenBytes.toString('hex')}`,
      remoteTokenDecimals: config.decimals,
      remoteDecimals: decimals,
      remotePools,
      ...lanePauses(state),
      ...outbound,
      ...(failsClosed !== undefined && { failsClosed }),
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

/** The lane facts from a trusted pool already read and checked. */
async function readFromTrusted(
  solana: SolanaChain,
  query: SolanaRemoteLaneQuery,
  mint: PublicKey,
  trusted: PoolState,
): Promise<SolanaRemoteLaneFacts> {
  const routerAddress = await registryOf(solana, trusted.state.router)
  if (isUnread(routerAddress)) return routerAddress
  const router = routerAddress.toBase58()
  const registry = await readRegistry(solana, routerAddress, mint)
  if (isUnread(registry)) return registry
  if (!registry.registryPool)
    return {
      status: 'known',
      registryPool: null,
      router,
      laneKind: 'none',
      readsLongData: false,
      ...(registry.interfaceVersion !== undefined && {
        interfaceVersion: registry.interfaceVersion,
      }),
    }
  const registryPool = registry.registryPool
  let pool: PoolState | Unread = trusted
  if (!registryPool.equals(trusted.address)) {
    const account = await solana.connection.getAccountInfo(registryPool)
    if (!account)
      return missing(`the registry names pool ${registryPool.toBase58()}, which does not exist`)
    pool = poolState(registryPool, account, `the registry pool ${registryPool.toBase58()}`)
    if (isUnread(pool)) return pool
  }
  if (!pool.state.mint.equals(mint))
    return unknown(`the registry pool ${registryPool.toBase58()} is another mint's pool State`)

  const lane = await readLane(
    solana,
    pool.program,
    mint,
    pool.state.decimals,
    query.remoteChainSelector,
    !!query.readRateLimits,
  )
  if (isUnread(lane)) return lane
  const sourcePoolAddressLength = lane.back
    ? await readSourcePoolAddressLength(solana, routerAddress, query.remoteChainSelector)
    : undefined
  return {
    status: 'known',
    ...(sourcePoolAddressLength !== undefined && { sourcePoolAddressLength }),
    registryPool: registryPool.toBase58(),
    router,
    poolProgram: pool.program.toBase58(),
    interfaceVersion: registry.interfaceVersion,
    ...lane,
    readsLongData:
      registry.interfaceVersion === 2 &&
      (lane.laneKind === 'linked' || lane.laneKind === 'driven') &&
      lane.poolDataFormat === 'long',
  }
}

/** Reads and checks a trusted pool `State`. */
async function readTrusted(solana: SolanaChain, value: string): Promise<PoolState | Unread> {
  const address = parseKey(value, 'the trusted remote pool')
  if (isUnread(address)) return address
  const account = await solana.connection.getAccountInfo(address)
  if (!account) return missing(`the trusted remote pool ${value} does not exist`)
  return poolState(address, account, `the trusted remote pool ${value}`)
}

/**
 * Reads the Solana side of an EVM → Solana lane: the pool the Router's registry names for `mint`
 * (found through the first trusted pool's Router), and that pool's lane toward the EVM chain.
 *
 * @param remote - The Solana chain, from the guard's `getChain`.
 * @param query - The lane, from the EVM side.
 * @returns The facts; `'missing'` when the lane trusts no pool or the trusted pool does not exist,
 *   `'unknown'` when an account cannot be read as the program writes it, the trusted pool is not a
 *   pool `State` at its PDA, its Router is not a CCIP Router, or `remote` is not a Solana chain.
 *   A registry that names no pool is `'known'` with `registryPool: null`.
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
  const trusted = await readTrusted(solana, first)
  if (isUnread(trusted)) return trusted
  return readFromTrusted(solana, query, mint, trusted)
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
  params: { remoteChainSelector: bigint; poolAddress: string },
): Promise<SolanaRemotePoolFacts> {
  const solana = await solanaChainOf(remote)
  if (isUnread(solana)) return solana
  const pool = await readTrusted(solana, params.poolAddress)
  if (isUnread(pool)) return pool
  const facts = await readFromTrusted(
    solana,
    { ...params, mint: pool.state.mint.toBase58(), trustedPools: [params.poolAddress] },
    pool.state.mint,
    pool,
  )
  if (facts.status !== 'known') return facts
  return {
    status: 'known',
    isMultiTokenPool: facts.registryPool === pool.address.toBase58() && facts.readsLongData,
  }
}
