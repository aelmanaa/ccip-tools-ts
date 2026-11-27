/**
 * The family-neutral multi-token pool lane reads on Solana (`getMultiTokenPoolLane`,
 * `checkMultiTokenPoolLane`, `getMultiTokenPoolTransferQuote`): the shared shapes of
 * `cct/multi-token-pool.ts`, from a pool-groups lane as its transfer paths resolve it.
 *
 * The remote side of a lane to EVM is read with core `Chain` reads on `getChain`'s chain (registry,
 * `typeAndVersion`, `getTokenPoolRemotes`, `getTokenInfo`) and the EVM guard's own helpers, loaded
 * on first use: the mirror of the EVM guard, which loads the Solana remote reader lazily.
 *
 * @packageDocumentation
 */

import { Buffer } from 'buffer'

import { BN } from '@coral-xyz/anchor'
import { ComputeBudgetProgram, PublicKey } from '@solana/web3.js'
import { getAddress, isAddress, zeroPadValue } from 'ethers'

import type {
  Chain,
  LaneRecordType,
  LaneStatus,
  RateLimiterState,
  TokenTransferFeeConfig,
} from '../../../chain.ts'
import { CCIPTokenPoolChainConfigNotFoundError } from '../../../errors/index.ts'
import { bpsFeeDeducted } from '../../../evm/multi-token-pool.ts'
import { encodeFinality } from '../../../extra-args.ts'
import { ChainFamily, networkInfo } from '../../../networks.ts'
import { buildMessageForDest } from '../../../requests.ts'
import type { SolanaChain } from '../../../solana/index.ts'
import { resolveCcipSendV2 } from '../../../solana/resolution.ts'
import { selectSendLane } from '../../../solana/send-v2.ts'
import { deriveTokenPoolChainConfigV2Pda } from '../../../solana/token-pool.ts'
import { SIMULATION_PAYER } from '../../../solana/utils.ts'
import { CCTParamsInvalidError } from '../../errors.ts'
import {
  type CheckMultiTokenPoolLaneParams,
  type GetMultiTokenPoolTransferQuoteParams,
  type MultiTokenPoolConfigSource,
  type MultiTokenPoolFact,
  type MultiTokenPoolLane,
  type MultiTokenPoolLaneCheckResult,
  type MultiTokenPoolLaneFinding,
  type MultiTokenPoolRemoteAttestation,
  type MultiTokenPoolTransferQuote,
  type PoolDataFormat,
  sortFindings,
} from '../../multi-token-pool.ts'
import { decodeRemoteAddress, laneFamilyOf } from '../../remote-address.ts'
import {
  deriveTokenPoolChainConfigPda,
  deriveTokenPoolConfigPda,
  deriveTokenPoolSignerPda,
} from '../programs/token-pool.ts'
import { readTokenMintAuthority } from '../token-admin-registry/mint-authority.ts'
import type { PoolGroupClass } from './accounts.ts'
import { decodeFeeConfig } from './decode.ts'
import {
  type PoolGroupLaneState,
  isUnread,
  laneCcvSync,
  laneFailsClosed,
  laneFormat,
  lanePauses,
  laneSectionsFor,
  readPoolGroupLaneState,
} from './lane.ts'
import { orThrow, simulationRefused } from './operations/common.ts'
import { type LaneGroupObservation, observeLane, readPolicyIds } from './operations/lane.ts'
import { createPoolGroupProgram } from './program.ts'
import {
  type PoolState,
  type SolanaRemoteLanePool,
  laneRemotePools,
  poolState,
  readRegistry,
  readSourcePoolAddressLength,
  registryOf,
} from './remote-lane.ts'

const DIRECTIONS = ['outbound', 'inbound'] as const
/** The account locks a Solana transaction may take. */
export const SOLANA_ACCOUNT_LOCK_LIMIT = 64

/** A lane read for the shared views: the lane, its accounts, and what the program applies. */
export type SolanaMultiTokenPoolLaneRead = {
  /** The family-neutral view. */
  lane: MultiTokenPoolLane
  /** The pool program. */
  program: PublicKey
  /** The mint's pool `State`. */
  pool: PoolState
  /** The lane's accounts, `null` when it has no `ChainConfig`. */
  state: PoolGroupLaneState | null
  /** The lane's remote pools with their stored bytes. */
  remotePools: SolanaRemoteLanePool[]
}

/** A parsed lane key of the shared reads. */
export type ParsedSolanaLaneKey = { program?: PublicKey; mint: PublicKey; selector: bigint }

/** `RateLimiterObservation` → core state (`null` when disabled). */
function observedBucket(b: LaneGroupObservation['outboundRateLimit']): RateLimiterState {
  if (!b.isEnabled) return null
  return {
    tokens: BigInt(b.tokens.toString()),
    capacity: BigInt(b.capacity.toString()),
    rate: BigInt(b.rate.toString()),
  }
}

/** An enabled bucket with no capacity and no rate holds the direction (a stop). */
const isStop = (b: RateLimiterState | undefined) => !!b && b.capacity === 0n && b.rate === 0n

/**
 * The lane's status in one direction, with the shared scope mapping: pool-group pause → `'global'`;
 * chain record pause, `drivenLanesPaused` or a chain record that does not admit a driven member →
 * `'chain'`; the lane's own pause → `'token'` (this token on this chain). An unlinked lane has no
 * pause. `'incomplete'` when a transfer reverts for a missing record: a long lane sends only with an
 * enabled fee record, and a lane trusting no remote pool receives nothing.
 */
function laneStatus(
  state: PoolGroupLaneState,
  direction: 'outbound' | 'inbound',
  format: PoolDataFormat,
  fee: TokenTransferFeeConfig | undefined,
  remotePools: number,
): LaneStatus {
  const { ext, groupChain } = state
  if (ext?.poolGroupAddress && groupChain) {
    const gcp = groupChain.record
    const out = direction === 'outbound'
    if (gcp.groupPaused) return { status: 'paused', scope: 'global', direction }
    const { admitted } = lanePauses(state)
    if (
      (out ? gcp.pausedOutbound : gcp.pausedInbound) ||
      (state.kind === 'driven' && (gcp.drivenLanesPaused || admitted === false))
    )
      return { status: 'paused', scope: 'chain', direction }
    if (out ? ext.pausedOutbound : ext.pausedInbound)
      return { status: 'paused', scope: 'token', direction }
  }
  const missing: LaneRecordType[] =
    direction === 'outbound'
      ? format === 'long' && !fee?.isEnabled
        ? ['destOverhead']
        : []
      : remotePools
        ? []
        : ['remotePool']
  return missing.length ? { status: 'incomplete', missing } : { status: 'ok' }
}

/** Where each lane record type resolves from, in the family-neutral terms. */
function laneSources(
  state: PoolGroupLaneState,
  policyIds: ReadonlyMap<string, number>,
): Record<LaneRecordType, MultiTokenPoolConfigSource> {
  const of = (cls: PoolGroupClass): MultiTokenPoolConfigSource => {
    const source = state.ext?.poolGroupAddress ? state.ext.classSource[cls] : undefined
    if (!source || source.kind === 'inline') return { kind: 'inline' }
    if (source.kind === 'default') return { kind: 'default' }
    const named = state.named.get(source.slot)!
    return { kind: 'policy', policy: { id: policyIds.get(named.policy.toBase58())! } }
  }
  return bySourceClass(of)
}

/** The lane record types from their pool-group class (CONNECTION holds the remote pools, FEE the overheads). */
function bySourceClass(
  of: (cls: PoolGroupClass) => MultiTokenPoolConfigSource,
): Record<LaneRecordType, MultiTokenPoolConfigSource> {
  return {
    connection: of('connection'),
    remotePool: of('connection'),
    rateLimit: of('rateLimit'),
    fee: of('fee'),
    destOverhead: of('fee'),
    security: of('security'),
  }
}

/** The CCV lists transfers apply now: the lane's copy, or its activated pending copy. */
function laneCcvs(state: PoolGroupLaneState): { outbound: string[]; inbound: string[] } {
  const pending = state.ext?.ccvPending
  if (pending && state.now !== undefined && state.now >= pending.activatesAt)
    return { outbound: pending.outbound, inbound: pending.inbound }
  return state.v2?.lane.ccvs ?? { outbound: [], inbound: [] }
}

/**
 * Reads the mint's pool `State` under `program`, at its PDA.
 * @throws {@link CCTParamsInvalidError} if the mint has no pool there
 * @throws {@link CCTDataDecodeError} if the account is not a pool `State` at its PDA
 */
async function readPoolState(
  operation: string,
  chain: SolanaChain,
  program: PublicKey,
  mint: PublicKey,
): Promise<PoolState> {
  const address = deriveTokenPoolConfigPda(program, mint)
  const account = await chain.connection.getAccountInfo(address)
  if (!account?.owner.equals(program))
    throw new CCTParamsInvalidError(
      operation,
      'tokenAddress',
      `${mint.toBase58()} has no pool State under ${program.toBase58()}`,
    )
  return orThrow(
    poolState(address, account, `the pool State ${address.toBase58()}`),
    address.toBase58(),
  )
}

/**
 * Reads the family-neutral view of one lane of a resolved pool program: the lane's accounts (marker,
 * tail, group and named records), and what the program applies (`observe_lane_group`: buckets
 * under the configs in force, the effective fee config). A standard lane of a program without pool
 * groups is read through core (`getTokenPoolRemotes`, `getTokenPoolConfig`).
 * @throws {@link CCTParamsInvalidError} if the mint has no pool State under the program
 * @throws {@link CCTDataDecodeError} if an account is not as the program writes it
 * @throws {@link CCTOperationUnsupportedError} if the program refuses the view on a marked lane
 * @internal
 */
export async function readSolanaMultiTokenPoolLane(
  operation: string,
  chain: SolanaChain,
  program: PublicKey,
  mint: PublicKey,
  selector: bigint,
): Promise<SolanaMultiTokenPoolLaneRead> {
  const [pool, read] = await Promise.all([
    readPoolState(operation, chain, program, mint),
    readPoolGroupLaneState(chain.connection, program, mint, selector),
  ])
  const where = `the lane of ${mint.toBase58()} toward ${selector}`
  const base = {
    family: ChainFamily.Solana,
    tokenAddress: mint.toBase58(),
    remoteChainSelector: selector,
  } as const
  if (read === null) {
    const none: LaneStatus = { status: 'incomplete', missing: ['connection'] }
    return {
      program,
      pool,
      state: null,
      remotePools: [],
      lane: {
        ...base,
        exists: false,
        remoteToken: null,
        remotePools: [],
        poolDataFormat: 'legacy',
        sources: bySourceClass(() => ({ kind: 'inline' })),
        rateLimits: { outbound: null, inbound: null },
        stopped: { outbound: false, inbound: false },
        ccvs: { outbound: [], inbound: [] },
        hasHooks: false,
        outboundStatus: none,
        inboundStatus: none,
      },
    }
  }
  const state = orThrow(read, where)
  const poolDataFormat = orThrow(laneFormat(state), where)
  const remotePools = orThrow(laneRemotePools(state, poolDataFormat), where)
  const [observation, policyIds] = await Promise.all([
    observeLane(operation, chain, state),
    readPolicyIds(chain, [state]),
  ])
  let rateLimits: MultiTokenPoolLane['rateLimits']
  let fee: TokenTransferFeeConfig | undefined
  if (observation) {
    const ftfOut = observation.ftfOutboundRateLimit
    const ftfIn = observation.ftfInboundRateLimit
    rateLimits = {
      outbound: observedBucket(observation.outboundRateLimit),
      inbound: observedBucket(observation.inboundRateLimit),
      ...(ftfOut?.isEnabled && { fastFinalityOutbound: observedBucket(ftfOut) }),
      ...(ftfIn?.isEnabled && { fastFinalityInbound: observedBucket(ftfIn) }),
    }
    fee = observation.feeConfig ? decodeFeeConfig(observation.feeConfig) : undefined
  } else {
    // a standard lane of a program without pool groups: core reads it
    const [remotes, config] = await Promise.all([
      chain.getTokenPoolRemotes(pool.address.toBase58(), selector),
      chain.getTokenPoolConfig(pool.address.toBase58(), { destChainSelector: selector }),
    ])
    const remote = remotes[networkInfo(selector).name]!
    const fastOut =
      'fastOutboundRateLimiterState' in remote ? remote.fastOutboundRateLimiterState : null
    const fastIn =
      'fastInboundRateLimiterState' in remote ? remote.fastInboundRateLimiterState : null
    rateLimits = {
      outbound: remote.outboundRateLimiterState,
      inbound: remote.inboundRateLimiterState,
      ...(fastOut && { fastFinalityOutbound: fastOut }),
      ...(fastIn && { fastFinalityInbound: fastIn }),
    }
    fee = 'tokenTransferFeeConfig' in config ? config.tokenTransferFeeConfig : undefined
  }
  const security = laneSectionsFor(state, 'security')
  const hasHooks = !isUnread(security) && !!security?.security.hook
  const tokenBytes = Buffer.from(state.chainConfig.base.remote.tokenAddress.address)
  return {
    program,
    pool,
    state,
    remotePools,
    lane: {
      ...base,
      exists: true,
      remoteToken: decodeRemoteAddress(tokenBytes, selector),
      remotePools: remotePools.map(({ address, allowLegacyPoolData }) => ({
        address,
        allowLegacyPoolData,
      })),
      poolDataFormat,
      sources: laneSources(state, policyIds),
      rateLimits,
      stopped: { outbound: isStop(rateLimits.outbound), inbound: isStop(rateLimits.inbound) },
      ...(fee?.isEnabled && { tokenTransferFeeConfig: fee }),
      ccvs: laneCcvs(state),
      hasHooks,
      outboundStatus: laneStatus(state, 'outbound', poolDataFormat, fee, remotePools.length),
      inboundStatus: laneStatus(state, 'inbound', poolDataFormat, fee, remotePools.length),
    },
  }
}

// ─── The lane check ──────────────────────────────────────────────────────────────────────────

type Add = (
  check: MultiTokenPoolLaneFinding['check'],
  severity: MultiTokenPoolLaneFinding['severity'],
  reason: string,
  recordType?: LaneRecordType,
) => void

/** The remote side as read: tri-state, with the cause of an unread side. */
type RemoteSide =
  | { status: 'missing' | 'unknown'; reason: string; cause?: unknown }
  | {
      status: 'known'
      /** The pool the remote registry names for the remote token, or `null`. */
      registryPool: string | null
      /** Whether it reads long pool data. */
      readsLongData: boolean
      /** The attestation the fact came from, for a family the SDK cannot read. */
      attestation?: MultiTokenPoolRemoteAttestation
      /** The remote lane back: its token, pools and outbound bucket (EVM remotes). */
      back?: { remoteToken: string; remotePools: string[]; outbound: RateLimiterState }
      /** The remote token's decimals. */
      remoteDecimals?: number
      /** Trusted pools that may send legacy data and are multi-token pools. */
      legacyFromMultiTokenPools: string[]
      /** Trusted pools whose type was not read. */
      unreadPools: string[]
    }

/**
 * Reads the EVM side of a Solana lane with core reads: the registry of the first trusted pool, the
 * pool it names for the remote token and its type, each trusted legacy pool's type, and the lane
 * back toward this chain.
 */
async function readEvmRemote(
  remote: Chain,
  read: SolanaMultiTokenPoolLaneRead,
  localSelector: bigint,
): Promise<RemoteSide> {
  const [{ readRegistryPool }, { reportsMultiTokenPool }, { isNotCcipContract }] =
    await Promise.all([
      import('../../evm/pool-config-manager/serving-pools.ts'),
      import('../../evm/multi-token-pool/contracts.ts'),
      import('../../evm/query.ts'),
    ])
  const { lane } = read
  const trusted = lane.remotePools.map((p) => p.address)
  if (!trusted.length)
    return {
      status: 'missing',
      reason: 'the lane trusts no remote pool, so its remote registry cannot be found',
    }
  const typeOf = (address: string) =>
    remote.typeAndVersion(address).then(
      ([type]) => type,
      (err: unknown) => {
        // a pool that reports no (or an unparseable) typeAndVersion is not a multi-token pool
        if (isNotCcipContract(err)) return ''
        throw err
      },
    )
  const registry = await remote.getTokenAdminRegistryFor(trusted[0]!)
  const registryPool = await readRegistryPool(remote, registry, lane.remoteToken!)
  const legacyPools = lane.remotePools.filter((p) => p.allowLegacyPoolData).map((p) => p.address)
  const legacyTypes = await Promise.all(legacyPools.map(typeOf))
  const legacyFromMultiTokenPools = legacyPools.filter((_, i) =>
    reportsMultiTokenPool(legacyTypes[i]!),
  )
  if (registryPool === null)
    return {
      status: 'known',
      registryPool,
      readsLongData: false,
      legacyFromMultiTokenPools,
      unreadPools: [],
    }
  const [type, back] = await Promise.all([
    typeOf(registryPool),
    remote.getTokenPoolRemotes(registryPool, localSelector, { token: lane.remoteToken! }).then(
      (remotes) => Object.values(remotes)[0],
      (err: unknown) => {
        if (err instanceof CCIPTokenPoolChainConfigNotFoundError) return undefined
        throw err
      },
    ),
  ])
  // the remote decimals only matter to compare two enabled buckets
  const compare = !!back?.outboundRateLimiterState && !!lane.rateLimits.inbound
  return {
    status: 'known',
    registryPool: getAddress(registryPool),
    readsLongData: reportsMultiTokenPool(type),
    ...(back && {
      back: {
        remoteToken: back.remoteToken,
        remotePools: back.remotePools,
        outbound: back.outboundRateLimiterState,
      },
    }),
    ...(compare && { remoteDecimals: (await remote.getTokenInfo(lane.remoteToken!)).decimals }),
    legacyFromMultiTokenPools,
    unreadPools: [],
  }
}

/**
 * The remote side of the lane: an EVM remote read with core reads, a family the SDK cannot read
 * through an attestation for exactly this lane, else unread (fail closed).
 */
async function readRemoteSide(
  params: CheckMultiTokenPoolLaneParams,
  read: SolanaMultiTokenPoolLaneRead,
  localSelector: bigint,
): Promise<RemoteSide> {
  const { remoteChainOf, attestationRefusal } =
    await import('../../evm/pool-config-manager/guard-facts.ts')
  const { lane } = read
  const family = laneFamilyOf(lane.remoteChainSelector)
  if (family === ChainFamily.Solana)
    return { status: 'unknown', reason: 'a Solana lane toward another Solana chain is not read' }
  const remote = await remoteChainOf(params, lane.remoteChainSelector)
  if ('status' in remote) {
    const trusted = lane.remotePools.map((p) => p.address)
    const attestation = params.remoteAttestations?.find(
      (a) =>
        a.remoteChainSelector === lane.remoteChainSelector &&
        a.remoteToken === lane.remoteToken &&
        trusted.includes(a.remotePoolAddress),
    )
    if (!attestation) return remote
    const refused = attestationRefusal(attestation, { now: BigInt(Math.floor(Date.now() / 1000)) })
    if (refused)
      return { status: 'unknown', reason: `the attestation for this lane is refused: ${refused}` }
    return {
      status: 'known',
      registryPool: attestation.remotePoolAddress,
      readsLongData: attestation.acceptsLongPoolData,
      attestation,
      legacyFromMultiTokenPools: [],
      unreadPools: [],
    }
  }
  if (family !== ChainFamily.EVM)
    return {
      status: 'unknown',
      reason: `the SDK cannot read the remote side of a ${family} lane yet`,
    }
  return readEvmRemote(remote, read, localSelector)
}

/**
 * The account locks of a token-only send of `mint` toward the lane's remote chain, from the send
 * the core resolver builds (every account the router and the pool resolve, the sender, the Router
 * and the compute-budget program), plus `extraAccounts`. `undefined` when the lane has no CCIP 2.0
 * send path.
 */
async function sendLocks(
  chain: SolanaChain,
  router: PublicKey,
  mint: PublicKey,
  selector: bigint,
  lockBudget: CheckMultiTokenPoolLaneParams['lockBudget'],
): Promise<number | undefined> {
  if (laneFamilyOf(selector) !== ChainFamily.EVM) return undefined
  const receiver = zeroPadValue('0x01', 20)
  const message = buildMessageForDest(
    {
      receiver,
      data: '0x',
      tokenAmounts: [{ token: mint.toBase58(), amount: 1n }],
      extraArgs: { gasLimit: 0n },
      ...(lockBudget?.feeToken && { feeToken: lockBudget.feeToken }),
    },
    ChainFamily.EVM,
  )
  const lane = await selectSendLane(chain, { router, destChainSelector: selector, message })
  if (lane.version !== '2.0.0') return undefined
  const { instruction } = await resolveCcipSendV2(chain, {
    router,
    destChainSelector: selector,
    sender: SIMULATION_PAYER,
    message: lane.message,
  })
  const keys = new Set([
    SIMULATION_PAYER.toBase58(),
    instruction.programId.toBase58(),
    ComputeBudgetProgram.programId.toBase58(),
    ...instruction.keys.map((k) => k.pubkey.toBase58()),
  ])
  return keys.size + (lockBudget?.extraAccounts ?? 0)
}

/** The 32-byte word the EVM OnRamp sends for an address (`abi.encode(address)`), lowercase hex. */
const abiWord = (address: string) => zeroPadValue(getAddress(address), 32).toLowerCase()

/**
 * Runs the lane check on one Solana lane: kind, admission, pauses and stops, CCV sync, the long-data
 * fee floor, the stored EVM token and pool bytes, mint authority, the send lock budget, and the
 * remote side (registry pool, F14 long-data acceptance, legacy data from multi-token pools, the
 * lane back, inbound against the remote outbound limit).
 * @internal
 */
export async function checkSolanaMultiTokenPoolLane(
  operation: string,
  chain: SolanaChain,
  params: CheckMultiTokenPoolLaneParams,
  key: ParsedSolanaLaneKey & { program: PublicKey },
): Promise<MultiTokenPoolLaneCheckResult> {
  const read = await readSolanaMultiTokenPoolLane(
    operation,
    chain,
    key.program,
    key.mint,
    key.selector,
  )
  const { lane, state, pool } = read
  const findings: MultiTokenPoolLaneFinding[] = []
  const add: Add = (check, severity, reason, recordType) =>
    findings.push({
      check,
      severity,
      tokenAddress: lane.tokenAddress,
      remoteChainSelector: lane.remoteChainSelector,
      reason,
      ...(recordType && { recordType }),
    })
  const guards = await import('../../evm/pool-config-manager/guards.ts')
  const localSelector = chain.network.chainSelector
  let remote: MultiTokenPoolFact = 'unknown'

  // the Router's registry must name this pool for the mint, on interface 2 for a marked lane
  const router = await registryOf(chain, pool.state.router)
  if (isUnread(router)) add('TOKEN_NOT_REGISTERED', 'error', router.reason)
  else {
    const registry = await readRegistry(chain, router, key.mint)
    if (isUnread(registry)) add('TOKEN_NOT_REGISTERED', 'error', registry.reason)
    else if (!registry.registryPool?.equals(pool.address))
      add(
        'TOKEN_NOT_REGISTERED',
        'error',
        `the Router's registry names ${registry.registryPool?.toBase58() ?? 'no pool'} for ${lane.tokenAddress}, not the pool State ${pool.address.toBase58()}: transfers do not use this pool`,
      )
    else if (state && state.kind !== 'standard' && registry.interfaceVersion !== 2)
      add(
        'TOKEN_NOT_REGISTERED',
        'error',
        `the registry serves ${lane.tokenAddress} on pool interface ${registry.interfaceVersion}, where a ${state.kind} lane refuses every transfer: set interface 2`,
      )
  }

  if (!state)
    add(
      'NO_CONNECTION',
      'error',
      'no ChainConfig exists for this token and chain: the lane does not exist',
    )
  else {
    const ext = state.ext
    const where = `the lane of ${lane.tokenAddress} toward ${lane.remoteChainSelector}`
    // admission and CCV sync, which fail every transfer of a lane that is not paused
    const { admitted } = lanePauses(state)
    if (state.kind === 'driven' && admitted === false)
      add(
        'LANE_NOT_ADMITTED',
        'error',
        "the pool group's chain record does not admit this member, so transfers revert (GroupLaneNotEnabled): admit it in the chain record's lane mode",
        'connection',
      )
    const failsClosed = orThrow(laneFailsClosed(state), where)
    if (failsClosed !== undefined)
      add(
        'CCVS_NOT_SYNCED',
        'error',
        `every transfer reverts: ${failsClosed}; sync the lane`,
        'security',
      )
    const sync = orThrow(laneCcvSync(state), where)
    if (sync?.failsClosedAt !== undefined)
      add(
        'CCVS_NOT_SYNCED',
        'warning',
        `the SECURITY record activates a new CCV set at ${sync.failsClosedAt} that the lane has not copied: transfers fail closed from then until it syncs`,
        'security',
      )

    // the long-data fee floor: the program sends long data only with an enabled fee record whose
    // destination bytes cover it (`require_dest_bytes_overhead`)
    const fee = lane.tokenTransferFeeConfig
    const uid = ext?.uid ?? null
    if (lane.poolDataFormat === 'long') {
      const needed = guards.longPoolDataBytes(uid ? 32 : 0)
      if (!fee)
        add(
          'NO_FEE_RECORD',
          'error',
          `the lane sends long pool data, which needs an enabled fee record with destBytesOverhead >= ${needed}: every send reverts (LongPoolDataNeedsDestBytesOverhead)`,
          'fee',
        )
      else if (fee.destBytesOverhead < needed)
        add(
          'DEST_BYTES_OVERHEAD_TOO_LOW',
          'error',
          `destBytesOverhead ${fee.destBytesOverhead} is below the ${needed} bytes of long pool data this lane sends: every send reverts`,
          'destOverhead',
        )
    }
    if (fee) {
      const minGas =
        params.minDestGasOverhead ??
        guards.DEFAULT_MIN_DEST_GAS_OVERHEAD + (lane.hasHooks ? guards.HOOK_DEST_GAS_OVERHEAD : 0)
      if (fee.destGasOverhead < minGas)
        add(
          'DEST_GAS_OVERHEAD_TOO_LOW',
          'error',
          `destGasOverhead ${fee.destGasOverhead} is below ${minGas}${lane.hasHooks ? ' (a hook resolves)' : ''}: the destination release can run out of gas`,
          'destOverhead',
        )
      const maxBps = params.maxTransferFeeBps ?? guards.DEFAULT_MAX_TRANSFER_FEE_BPS
      const bps = Math.max(fee.finalityTransferFeeBps, fee.fastFinalityTransferFeeBps)
      if (bps > maxBps)
        add(
          'TRANSFER_FEE_ABOVE_CAP',
          'error',
          `the resolved transfer fee is ${bps} bps, above maxTransferFeeBps ${maxBps}`,
          'fee',
        )
    }

    // the stored EVM bytes: the program compares them exactly with what the OffRamp passes
    if (laneFamilyOf(lane.remoteChainSelector) === ChainFamily.EVM) {
      const raw = `0x${Buffer.from(state.chainConfig.base.remote.tokenAddress.address).toString('hex')}`
      if (!lane.remoteToken || !isAddress(lane.remoteToken))
        add(
          'REMOTE_TOKEN_ENCODING',
          'error',
          `the remote token ${lane.remoteToken ?? raw} is not an EVM address`,
          'connection',
        )
      else if (raw !== abiWord(lane.remoteToken))
        add(
          'REMOTE_TOKEN_ENCODING',
          'error',
          `the lane stores the remote token as ${raw}, but the EVM OnRamp sends ${abiWord(lane.remoteToken)} (abi.encode of ${getAddress(lane.remoteToken)}): the program compares the bytes, so every inbound transfer reverts (SourceTokenMismatch); store the 32-byte form`,
          'connection',
        )
      if (!isUnread(router) && read.remotePools.length) {
        const length = await readSourcePoolAddressLength(chain, router, lane.remoteChainSelector)
        if (length === null || length < 20 || length > 32)
          add(
            'REMOTE_UNREADABLE',
            'error',
            `the Solana OffRamp's address length for ${lane.remoteChainSelector} could not be read (${String(length)}), so the stored remote pool bytes cannot be judged`,
            'remotePool',
          )
        else {
          const trimmed = (a: string) => `0x${abiWord(a).slice(2 + (32 - length) * 2)}`
          const wrong = read.remotePools.filter((p) => p.raw.toLowerCase() !== trimmed(p.address))
          for (const p of wrong)
            add(
              'REMOTE_LANE_MISMATCH',
              'error',
              `the lane stores remote pool ${p.address} as ${p.raw}, but the OffRamp hands the pool the trailing ${length} bytes of the 32-byte form: inbound transfers from it revert; store the ${length}-byte form`,
              'remotePool',
            )
        }
      }
    }

    // the remote side
    const side = await readRemoteSide(params, read, localSelector)
    remote = side.status
    if (side.status !== 'known') {
      if (side.status === 'missing' && read.remotePools.length === 0)
        add(
          'NO_REMOTE_POOL',
          'error',
          `${side.reason}: inbound transfers revert, and a send cannot be checked against a remote pool`,
          'remotePool',
        )
      else
        add(
          'REMOTE_UNREADABLE',
          'error',
          `the remote side could not be checked (${side.reason}): pass getChain for ${lane.remoteChainSelector}, or a remoteAttestations entry where the family has no reader`,
        )
    } else {
      const outboundPaused = lane.outboundStatus.status === 'paused'
      if (side.attestation)
        add(
          'REMOTE_ATTESTED',
          'warning',
          `the remote long-data fact comes from an attestation, not a read: ${side.attestation.reason}`,
        )
      for (const p of side.legacyFromMultiTokenPools)
        add(
          'LEGACY_RECEIVE_FROM_MULTI_TOKEN_POOL',
          'error',
          `remote pool ${p} is a multi-token pool but the lane accepts legacy pool data from it, which names no source token`,
          'remotePool',
        )
      if (side.registryPool === null) {
        remote = 'missing'
        // a token paused outbound whose remote side is not registered yet may wait (onboarding)
        if (!outboundPaused)
          add(
            'NO_REMOTE_POOL',
            'error',
            `the remote registry names no pool for ${lane.remoteToken}: a send burns here and nothing releases it there; register the remote side first, or keep the lane paused outbound`,
            'connection',
          )
      } else {
        if (!lane.remotePools.some((p) => p.address === side.registryPool))
          add(
            'REMOTE_LANE_MISMATCH',
            'error',
            `the remote registry names pool ${side.registryPool} for ${lane.remoteToken}, which this lane does not trust: inbound messages from it revert`,
            'remotePool',
          )
        if (lane.poolDataFormat === 'long' && !side.readsLongData)
          add(
            'POOL_DATA_FORMAT_MISMATCH',
            'error',
            `the lane sends long pool data but remote pool ${side.registryPool} reads only legacy data: the destination release reverts and the burned tokens are stuck`,
            'remotePool',
          )
        if (!side.attestation) {
          const back = side.back
          const servingPool = pool.address.toBase58()
          const pointsBack =
            !!back &&
            back.remoteToken === lane.tokenAddress &&
            back.remotePools.includes(servingPool)
          // only a legacy lane relies on the reverse mapping; long data names its source token
          if (lane.poolDataFormat === 'legacy' && !pointsBack)
            add(
              'REMOTE_LANE_MISMATCH',
              'error',
              back
                ? `the remote lane back names ${back.remoteToken} and pools ${back.remotePools.join(', ')}, not ${lane.tokenAddress} and ${servingPool}: the lane sends legacy pool data (no source token), so the destination cannot tell which token was sent`
                : `remote pool ${side.registryPool} has no lane back toward this chain: inbound transfers revert there`,
              'connection',
            )
          // UID pairing needs the remote provider's verdict, which the core reads do not give
          if (uid !== null && lane.poolDataFormat === 'long' && side.readsLongData)
            add(
              'UID_MISMATCH',
              'error',
              `the lane sends UID ${uid} as additional pool data, and the remote token's provider was not checked against it: the release there may revert (InvalidAdditionalPoolData); check the pairing on the EVM side (checkMultiTokenPoolLane there)`,
              'connection',
            )
          const local = lane.rateLimits.inbound
          const theirs = back?.outbound
          if (local && theirs && side.remoteDecimals !== undefined) {
            const { scaleDecimals } = await import('../../../utils.ts')
            const toLocal = (amount: bigint) =>
              scaleDecimals(amount, side.remoteDecimals!, pool.state.decimals)
            const [capacity, rate] = [toLocal(theirs.capacity), toLocal(theirs.rate)]
            if (local.capacity < capacity || local.rate < rate)
              add(
                'INBOUND_BELOW_REMOTE_OUTBOUND',
                'warning',
                `the inbound limit (capacity ${local.capacity}, rate ${local.rate}) is below the remote outbound one (capacity ${capacity}, rate ${rate} in local units): a burst the remote side lets out waits here for the bucket to refill; raise the inbound limit`,
                'rateLimit',
              )
          }
        }
      }
    }

    // mint authority: the pool mints inbound transfers as its signer, alone or in an SPL multisig
    const signer = deriveTokenPoolSignerPda(key.program, key.mint)
    const { mintAuthority, multisig } = await readTokenMintAuthority(chain, key.mint)
    const holds =
      !!mintAuthority &&
      (mintAuthority.equals(signer) ||
        (!!multisig && multisig.signers.filter((s) => s.equals(signer)).length >= multisig.m))
    if (!holds)
      add(
        'POOL_CANNOT_MINT_BURN',
        'error',
        `the mint authority of ${lane.tokenAddress} is ${mintAuthority?.toBase58() ?? 'none'}, not the pool signer ${signer.toBase58()} (alone, or m times in an SPL multisig): inbound transfers cannot mint`,
      )
  }

  // pauses and stops, by the directions that must be open
  const expected = new Set(params.expectOpen ?? DIRECTIONS)
  for (const direction of DIRECTIONS) {
    const status = direction === 'outbound' ? lane.outboundStatus : lane.inboundStatus
    const severity = expected.has(direction) ? 'error' : 'warning'
    if (status.status === 'paused')
      add(
        'LANE_PAUSED',
        severity,
        `${direction} is paused (${status.scope} pause): lift it with the matching unpause`,
      )
    else if (lane.stopped[direction])
      add(
        'LANE_STOPPED',
        severity,
        `${direction} is stopped: its rate limit bucket is enabled with no capacity and no rate; lift it by writing a non-zero bucket`,
        'rateLimit',
      )
  }

  // the send lock budget
  if (state && !isUnread(router)) {
    const severity = expected.has('outbound') ? 'error' : 'warning'
    try {
      const locks = await sendLocks(chain, router, key.mint, key.selector, params.lockBudget)
      if (locks === undefined)
        add(
          'ACCOUNT_LOCKS_EXCEEDED',
          'warning',
          'the send lock budget was not measured: the lane has no CCIP 2.0 send path toward an EVM chain',
        )
      else if (locks > SOLANA_ACCOUNT_LOCK_LIMIT)
        add(
          'ACCOUNT_LOCKS_EXCEEDED',
          severity,
          `a send of this token takes ${locks} account locks, above the ${SOLANA_ACCOUNT_LOCK_LIMIT} a transaction may take: the send cannot land`,
        )
    } catch (err) {
      // a resolution the program refuses is an answer; transport errors propagate
      try {
        simulationRefused(operation, err, 'ccip_send_v2 resolution')
      } catch (refused) {
        if (refused === err) throw err
        add(
          'ACCOUNT_LOCKS_EXCEEDED',
          severity,
          `the send lock budget could not be measured: the send resolution was refused (${err instanceof Error ? err.message : String(err)})`,
        )
      }
    }
  }

  const sorted = sortFindings(findings)
  return { lane, findings: sorted, remote, ok: !sorted.some((f) => f.severity === 'error') }
}

// ─── The transfer quote ──────────────────────────────────────────────────────────────────────

/**
 * Quotes a transfer by simulating `get_pool_fee` with the lane's group and named records, the way
 * the router forwards them.
 * @throws {@link CCTParamsInvalidError} if the lane does not exist, the lane does not allow the
 *   requested finality, or it sends long data without a fee record (a send would revert)
 * @throws {@link CCTOperationUnsupportedError} if the program refuses the simulation otherwise
 * @internal
 */
export async function quoteSolanaMultiTokenPoolTransfer(
  operation: string,
  chain: SolanaChain,
  params: GetMultiTokenPoolTransferQuoteParams,
  key: ParsedSolanaLaneKey & { program: PublicKey; feeToken?: PublicKey },
): Promise<MultiTokenPoolTransferQuote> {
  const { program, mint, selector } = key
  const read = await readPoolGroupLaneState(chain.connection, program, mint, selector)
  if (read === null)
    throw new CCTParamsInvalidError(
      operation,
      'remoteChainSelector',
      `${mint.toBase58()} has no lane toward ${selector} on ${program.toBase58()}`,
    )
  const where = `the lane of ${mint.toBase58()} toward ${selector}`
  const state = orThrow(read, where)
  const finality = encodeFinality(params.finality ?? 'finalized')
  const remaining = [
    ...(state.groupChain ? [state.groupChain.address] : []),
    ...[...state.named.values()].map((n) => n.address),
  ].map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }))
  let fee
  try {
    fee = await createPoolGroupProgram(chain, program)
      .methods.getPoolFee({
        remoteChainSelector: new BN(selector.toString()),
        amount: new BN(params.amount.toString()),
        localToken: mint,
        feeToken: key.feeToken ?? PublicKey.default,
        requestedFinalityConfig: { flags: finality >>> 16, blockDepth: finality & 0xffff },
        tokenArgs: Buffer.alloc(0),
      })
      .accountsStrict({
        state: deriveTokenPoolConfigPda(program, mint),
        chainConfig: deriveTokenPoolChainConfigPda(program, selector, mint),
        chainConfigV2: deriveTokenPoolChainConfigV2Pda(program, selector, mint),
      })
      .remainingAccounts(remaining)
      .view()
  } catch (err) {
    if (err instanceof Error && /InvalidRequestedFinality/.test(err.message))
      throw new CCTParamsInvalidError(
        operation,
        'finality',
        `${mint.toBase58()} does not allow this finality on the lane`,
      )
    return simulationRefused(operation, err, 'get_pool_fee')
  }
  if (!fee.isEnabled && orThrow(laneFormat(state), where) === 'long')
    throw new CCTParamsInvalidError(
      operation,
      'remoteChainSelector',
      `the lane of ${mint.toBase58()} to ${selector} sends long pool data without a fee record, so a send would revert: set an enabled fee record with the destination overheads`,
    )
  const tokenFeeBps = fee.isEnabled ? fee.tokenFeeBps : 0
  const feeDeducted = bpsFeeDeducted(params.amount, tokenFeeBps)
  return {
    feeUSDCents: BigInt(fee.isEnabled ? fee.fee : 0),
    destGasOverhead: fee.isEnabled ? fee.destGasLimit : 0,
    destBytesOverhead: fee.isEnabled ? fee.destBytesOverhead : 0,
    tokenFeeBps,
    feeDeducted,
    netAmount: params.amount - feeDeducted,
    hasFeeRecord: fee.isEnabled,
  }
}
