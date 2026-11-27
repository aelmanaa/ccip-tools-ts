/**
 * `checkMultiTokenPoolLane` on Solana: the local rules of a pool-groups lane, and the remote side.
 *
 * The EVM side of a lane is read with the EVM stack's own reads, loaded on first use (the mirror of
 * the EVM guard, which loads the Solana remote reader lazily): the registry pool and its type, the
 * remote lane as `getMultiTokenPoolLane` reads it on a multi-token pool (what it trusts, accepts and
 * sends), its token's provider verdicts (`readRemoteMultiTokenPoolSide`), and core
 * `getTokenPoolRemotes` on any other pool. The reads gather facts; {@link evaluateSolanaLaneRemote}
 * judges them.
 *
 * @packageDocumentation
 */

import { Buffer } from 'buffer'

import { type PublicKey, ComputeBudgetProgram } from '@solana/web3.js'
import { getAddress, isAddress, zeroPadValue } from 'ethers'

import type { Chain, LaneRecordType, RateLimiterState } from '../../../chain.ts'
import { CCIPError, CCIPTokenPoolChainConfigNotFoundError } from '../../../errors/index.ts'
import type { EVMChain } from '../../../evm/index.ts'
import { ChainFamily } from '../../../networks.ts'
import { buildMessageForDest } from '../../../requests.ts'
import type { SolanaChain } from '../../../solana/index.ts'
import { resolveCcipSendV2 } from '../../../solana/resolution.ts'
import { selectSendLane } from '../../../solana/send-v2.ts'
import { SIMULATION_PAYER } from '../../../solana/utils.ts'
import { scaleDecimals } from '../../../utils.ts'
import type { readRemoteMultiTokenPoolSide } from '../../evm/pool-config-manager/guard-facts.ts'
import {
  type CheckMultiTokenPoolLaneParams,
  type MultiTokenPoolFact,
  type MultiTokenPoolLane,
  type MultiTokenPoolLaneCheckResult,
  type MultiTokenPoolLaneFinding,
  type MultiTokenPoolRemoteAttestation,
  DEFAULT_MAX_TRANSFER_FEE_BPS,
  DEFAULT_MIN_DEST_GAS_OVERHEAD,
  HOOK_DEST_GAS_OVERHEAD,
  abiWord,
  isStop,
  longPoolDataBytes,
  sortFindings,
} from '../../multi-token-pool.ts'
import { laneFamilyOf } from '../../remote-address.ts'
import { deriveTokenPoolSignerPda } from '../programs/token-pool.ts'
import { readTokenMintAuthority } from '../token-admin-registry/mint-authority.ts'
import { resolvePoolProgramTypeAndVersion } from '../validate.ts'
import {
  isUnread,
  laneCcvSync,
  laneFailsClosed,
  laneFailsClosedFinding,
  lanePauses,
} from './lane.ts'
import {
  type SolanaMultiTokenPoolLaneRead,
  readSolanaMultiTokenPoolLane,
} from './multi-token-pool-lane.ts'
import { isViewRefusal, orThrow } from './operations/common.ts'
import { SOLANA_MAX_ACCOUNT_LOCKS } from './packer.ts'
import { getPoolGroupProgramFeatures } from './program.ts'
import {
  notTransient,
  readRegistry,
  readSourcePoolAddressLength,
  registryOf,
} from './remote-lane.ts'

const DIRECTIONS = ['outbound', 'inbound'] as const

/** The remote lane back, as the remote side reads it toward this chain. @internal */
export type SolanaLaneRemoteBack = {
  /** The token the remote lane names for this chain (base58 mint). */
  remoteToken: string
  /** Whether the remote lane trusts the serving pool `State`. */
  trustsServing: boolean
  /** Whether it accepts legacy pool data from the serving pool. */
  allowLegacyFromServing: boolean
  /** The pool data it sends toward this chain. */
  sends: 'legacy' | 'long'
  /** Its outbound bucket toward this chain. */
  outbound: RateLimiterState
  /** Whether a hook resolves on the remote lane (adds to the destination gas floor). */
  hasHooks: boolean
}

/** The remote side as read, tri-state. @internal */
export type SolanaLaneRemoteSide =
  | { status: 'missing' | 'unknown'; reason: string; cause?: unknown }
  | {
      status: 'known'
      /** The pool the remote registry names for the remote token, or `null`. */
      registryPool: string | null
      /** Whether that pool is a multi-token pool (it reads long pool data). */
      readsLongData: boolean
      /** The attestation the long-data fact came from, for a family the SDK cannot read. */
      attestation?: MultiTokenPoolRemoteAttestation
      /** The remote lane back, when it exists. */
      back?: SolanaLaneRemoteBack
      /** The remote token's decimals, to compare buckets. */
      remoteDecimals?: number
      /** Trusted pools that may send legacy data and are multi-token pools. */
      legacyFromMultiTokenPools: string[]
      /** A remote multi-token pool's provider verdicts. */
      multiTokenPoolSide?: Awaited<ReturnType<typeof readRemoteMultiTokenPoolSide>>
    }

/** What the remote rules need of the local lane. @internal */
export type SolanaLaneLocalFacts = {
  /** The lane view. */
  lane: MultiTokenPoolLane
  /** The lane's factory UID, or `null`. */
  uid: string | null
  /** Whether the local pool reads long pool data from the remote side (interface 2, pool groups). */
  readsLongData: boolean
  /** The serving pool `State` (base58). */
  servingPool: string
  /** The mint's decimals. */
  localDecimals: number
}

type Add = (
  check: MultiTokenPoolLaneFinding['check'],
  severity: MultiTokenPoolLaneFinding['severity'],
  reason: string,
  recordType?: LaneRecordType,
) => void

/** The EVM stack's reads {@link readEvmRemote} uses (injectable for tests). @internal */
export type EvmRemoteReads = {
  /** The pool an EVM registry names for a token (`null`: none). */
  readRegistryPool: (remote: EVMChain, registry: string, token: string) => Promise<string | null>
  /** The EVM multi-token pool lane view (`getMultiTokenPoolLane`). */
  getMultiTokenPoolLane: (
    remote: EVMChain,
    params: { tokenAddress: string; remoteChainSelector: bigint; poolAddress: string },
  ) => Promise<MultiTokenPoolLane>
  /** The remote token provider's verdicts on what this lane sends (`readRemoteMultiTokenPoolSide`). */
  readRemoteMultiTokenPoolSide: (
    remote: EVMChain,
    pool: string,
    token: string,
    localSelector: bigint,
    sends: string,
  ) => Promise<
    NonNullable<Extract<SolanaLaneRemoteSide, { status: 'known' }>['multiTokenPoolSide']>
  >
}

/** Loads the EVM stack's reads on first use, so Solana-only callers never load the EVM stack. */
async function loadEvmRemoteReads(): Promise<EvmRemoteReads> {
  const [{ readRegistryPool }, { GetMultiTokenPoolLane }, { readRemoteMultiTokenPoolSide }] =
    await Promise.all([
      import('../../evm/pool-config-manager/serving-pools.ts'),
      import('../../evm/pool-config-manager/operations/get-multi-token-pool-lane.ts'),
      import('../../evm/pool-config-manager/guard-facts.ts'),
    ])
  return {
    readRegistryPool,
    getMultiTokenPoolLane: (remote, params) => new GetMultiTokenPoolLane().query(remote, params),
    readRemoteMultiTokenPoolSide,
  }
}

/**
 * Reads the EVM side of a Solana lane with the EVM stack's reads: the registry of the first trusted
 * pool and the pool it names, its type, the remote lane back (`getMultiTokenPoolLane` on a
 * multi-token pool, core `getTokenPoolRemotes` on any other), its token provider's verdicts on what
 * this lane sends, and each trusted legacy pool's type.
 * @internal
 */
export async function readEvmRemote(
  remote: Chain,
  read: SolanaMultiTokenPoolLaneRead,
  localSelector: bigint,
  reads?: EvmRemoteReads,
): Promise<SolanaLaneRemoteSide> {
  const [
    { EVMChain },
    { reportsMultiTokenPool },
    { readContractTypeOrNull },
    { locateRemoteRegistry },
  ] = await Promise.all([
    import('../../../evm/index.ts'),
    import('../../evm/multi-token-pool/contracts.ts'),
    import('../../evm/query.ts'),
    import('../../evm/pool-config-manager/guard-facts.ts'),
  ])
  if (!(remote instanceof EVMChain))
    return {
      status: 'unknown',
      reason: 'getChain did not return an EVMChain for this EVM selector',
    }
  const { lane, state } = read
  const remoteToken = lane.remoteToken!
  const trusted = lane.remotePools.map((p) => p.address)
  const servingPool = read.pool.address.toBase58()
  const legacyPools = lane.remotePools.filter((p) => p.allowLegacyPoolData).map((p) => p.address)
  // a pool that reports no (or an unparseable) typeAndVersion is not a multi-token pool
  const legacyTypes = await Promise.all(legacyPools.map((p) => readContractTypeOrNull(remote, p)))
  const legacyFromMultiTokenPools = legacyPools.filter((_, i) => {
    const type = legacyTypes[i]
    return type != null && reportsMultiTokenPool(type)
  })
  // the remote registry is found from the first trusted pool, as the EVM guard finds it; an address
  // that does not answer as a CCIP pool leaves the remote side unlocated: fail closed, with the fix
  const registry = await locateRemoteRegistry(remote, trusted[0]!)
  if (typeof registry !== 'string') return registry
  const evm = reads ?? (await loadEvmRemoteReads())
  const registryPool = await evm.readRegistryPool(remote, registry, remoteToken)
  if (registryPool === null)
    return { status: 'known', registryPool, readsLongData: false, legacyFromMultiTokenPools }
  // a registry pool that does not answer as a CCIP contract is a custom pool: unread, a finding
  const type = await readContractTypeOrNull(remote, registryPool)
  if (type === null)
    return {
      status: 'unknown',
      reason: `the remote registry's pool ${registryPool} does not report a CCIP typeAndVersion, so what it reads and sends cannot be judged`,
    }
  const readsLongData = reportsMultiTokenPool(type)
  let back: SolanaLaneRemoteBack | undefined
  let multiTokenPoolSide
  if (readsLongData) {
    const sends = lane.poolDataFormat === 'long' && state?.ext?.uid ? state.ext.uid : '0x'
    const [view, side] = await Promise.all([
      evm.getMultiTokenPoolLane(remote, {
        tokenAddress: remoteToken,
        remoteChainSelector: localSelector,
        poolAddress: registryPool,
      }),
      evm.readRemoteMultiTokenPoolSide(remote, registryPool, remoteToken, localSelector, sends),
    ])
    multiTokenPoolSide = side
    if (view.exists && view.remoteToken !== null) {
      const serving = view.remotePools.find((p) => p.address === servingPool)
      back = {
        remoteToken: view.remoteToken,
        trustsServing: !!serving,
        allowLegacyFromServing: !!serving?.allowLegacyPoolData,
        sends: view.poolDataFormat,
        outbound: view.rateLimits.outbound,
        hasHooks: view.hasHooks,
      }
    }
  } else {
    const remotes = await remote
      .getTokenPoolRemotes(registryPool, localSelector, { token: remoteToken })
      .catch((err: unknown) => {
        if (err instanceof CCIPTokenPoolChainConfigNotFoundError) return undefined
        throw err
      })
    const found = remotes && Object.values(remotes)[0]
    if (found)
      back = {
        remoteToken: found.remoteToken,
        trustsServing: found.remotePools.includes(servingPool),
        // a pool that is not a multi-token pool sends and accepts legacy data only
        allowLegacyFromServing: true,
        sends: 'legacy',
        outbound: found.outboundRateLimiterState,
        hasHooks: false,
      }
  }
  // the remote decimals only matter to compare two enabled buckets
  const compare = !!back?.outbound && !!lane.rateLimits.inbound
  return {
    status: 'known',
    registryPool: getAddress(registryPool),
    readsLongData,
    ...(back && { back }),
    ...(compare && { remoteDecimals: (await remote.getTokenInfo(remoteToken)).decimals }),
    legacyFromMultiTokenPools,
    ...(multiTokenPoolSide && { multiTokenPoolSide }),
  }
}

/**
 * The remote side of the lane: an EVM remote read with the EVM stack's reads, a family the SDK
 * cannot read through an attestation for exactly this lane, else unread (fail closed).
 */
async function readRemoteSide(
  params: CheckMultiTokenPoolLaneParams,
  read: SolanaMultiTokenPoolLaneRead,
  localSelector: bigint,
): Promise<SolanaLaneRemoteSide> {
  const { remoteChainOf, attestationRefusal } =
    await import('../../evm/pool-config-manager/guard-facts.ts')
  const { lane } = read
  const family = laneFamilyOf(lane.remoteChainSelector)
  if (!lane.remotePools.length)
    return {
      status: 'missing',
      reason: 'the lane trusts no remote pool, so its remote registry cannot be found',
    }
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
 * Judges the remote side of a Solana lane: the registry pool, what each side sends and the other
 * accepts (F14 in both directions, legacy allowance, UID pairing), the lane back, and inbound
 * against the remote outbound limit. Pure: every fact was read before.
 * @returns The remote fact the result reports.
 * @internal
 */
export function evaluateSolanaLaneRemote(
  local: SolanaLaneLocalFacts,
  side: SolanaLaneRemoteSide,
  add: Add,
): MultiTokenPoolFact {
  const { lane, uid } = local
  const long = lane.poolDataFormat === 'long'
  if (side.status !== 'known') {
    if (side.status === 'missing' && !lane.remotePools.length)
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
    return side.status
  }
  for (const p of side.legacyFromMultiTokenPools)
    add(
      'LEGACY_RECEIVE_FROM_MULTI_TOKEN_POOL',
      'error',
      `remote pool ${p} is a multi-token pool but the lane accepts legacy pool data from it, which names no source token`,
      'remotePool',
    )
  if (side.attestation) {
    add(
      'REMOTE_ATTESTED',
      'warning',
      `the remote long-data fact comes from an attestation, not a read: ${side.attestation.reason}`,
    )
    if (long && !side.readsLongData)
      add(
        'POOL_DATA_FORMAT_MISMATCH',
        'error',
        `the lane sends long pool data but remote pool ${side.registryPool} reads only legacy data (attested): the destination release reverts and the burned tokens are stuck`,
        'remotePool',
      )
    // an attestation supplies only the long-data fact: the reverse mapping and the UID pairing need a read
    if (!long)
      add(
        'REMOTE_LANE_MISMATCH',
        'error',
        'the lane sends legacy pool data (no source token), so it relies on the remote lane back, which an attestation does not cover: pass getChain for that chain',
        'connection',
      )
    if (uid !== null)
      add(
        'UID_MISMATCH',
        'error',
        `the lane has UID ${uid}, whose pairing with the remote token an attestation does not cover: pass getChain for that chain`,
        'connection',
      )
    return 'known'
  }
  if (side.registryPool === null) {
    // a token paused or stopped outbound whose remote side is not registered yet may wait
    // (onboarding), as on EVM: remote stays `'missing'`, and `ok` may be true. A stop holds sends
    // only when the fast-finality outbound bucket (the lane's `ChainConfigOverride`) is disabled or
    // stopped too, since an open fast bucket still sends; an inbound stop never waives
    const fast = lane.rateLimits.fastFinalityOutbound
    const fastHeld = !fast || isStop({ isEnabled: true, capacity: fast.capacity, rate: fast.rate })
    const waiting =
      (lane.outboundStatus.status === 'paused' && lane.outboundStatus.scope === 'token') ||
      (lane.stopped.outbound && fastHeld)
    if (!waiting)
      add(
        'NO_REMOTE_POOL',
        'error',
        `the remote registry names no pool for ${lane.remoteToken}: a send burns here and nothing releases it there; register the remote side first, or keep the token paused outbound`,
        'connection',
      )
    return 'missing'
  }
  if (!lane.remotePools.some((p) => p.address === side.registryPool))
    add(
      'REMOTE_LANE_MISMATCH',
      'error',
      `the remote registry names pool ${side.registryPool} for ${lane.remoteToken}, which this lane does not trust: inbound messages from it revert`,
      'remotePool',
    )
  if (long && !side.readsLongData)
    add(
      'POOL_DATA_FORMAT_MISMATCH',
      'error',
      `the lane sends long pool data but remote pool ${side.registryPool} reads only legacy data: the destination release reverts and the burned tokens are stuck`,
      'remotePool',
    )
  const { back } = side
  if (!back)
    add(
      'REMOTE_LANE_MISMATCH',
      'error',
      `remote pool ${side.registryPool} has no lane back toward this chain: sends from here revert there, and nothing comes back`,
      'connection',
    )
  else {
    if (!back.trustsServing)
      add(
        'REMOTE_LANE_MISMATCH',
        'error',
        `the remote lane back does not trust the serving pool ${local.servingPool}: every send from here reverts there`,
        'remotePool',
      )
    else if (!long && side.readsLongData && !back.allowLegacyFromServing)
      add(
        'POOL_DATA_FORMAT_MISMATCH',
        'error',
        `the lane sends legacy pool data, which remote pool ${side.registryPool} refuses from the serving pool ${local.servingPool} (no allowLegacyPoolData, LegacyPoolDataNotAllowed): every send burns here and reverts there`,
        'remotePool',
      )
    // only a legacy lane relies on the reverse mapping: long data names its source token
    if (!long && back.remoteToken !== lane.tokenAddress)
      add(
        'REMOTE_LANE_MISMATCH',
        'error',
        `the remote lane back names ${back.remoteToken}, not ${lane.tokenAddress}: the lane sends legacy pool data (no source token), so the destination cannot tell which token was sent`,
        'connection',
      )
    if (back.sends === 'legacy' && (long || uid !== null))
      add(
        'POOL_DATA_FORMAT_MISMATCH',
        'error',
        `remote pool ${side.registryPool} sends legacy pool data toward this chain, which this ${uid !== null ? 'UID' : 'long'} lane refuses (LegacyPoolDataNotAllowed): inbound transfers revert here`,
        'remotePool',
      )
    if (back.sends === 'long' && !local.readsLongData)
      add(
        'POOL_DATA_FORMAT_MISMATCH',
        'error',
        `remote pool ${side.registryPool} sends long pool data toward this chain, which this pool reads only on interface 2 of a pool-groups program: every inbound execution fails (InvalidSourcePoolData) and the tokens burned there are stuck`,
        'remotePool',
      )
  }
  // the additional pool data, judged by the providers that judge it on chain
  const mttp = side.multiTokenPoolSide
  if (mttp?.remoteSideUnread !== undefined)
    add(
      'REMOTE_UNREADABLE',
      'error',
      `the remote multi-token pool side could not be read (${mttp.remoteSideUnread}), so the UID pairing was not checked`,
      'connection',
    )
  else if (mttp) {
    if (mttp.remoteAcceptsOutbound === false)
      add(
        'UID_MISMATCH',
        'error',
        `the remote token's provider refuses the additional pool data this lane sends (${long && uid !== null ? uid : 'none'}): the release there reverts (InvalidAdditionalPoolData) and the burned tokens are stuck; pair the providers`,
        'connection',
      )
    if (mttp.remoteProviderRefused !== undefined)
      add(
        'UID_MISMATCH',
        'warning',
        `${mttp.remoteProviderRefused}: sends from the remote side revert there`,
        'connection',
      )
    else if (uid !== null && mttp.remoteSendsData?.toLowerCase() !== uid.toLowerCase())
      add(
        'UID_MISMATCH',
        'error',
        `this lane requires UID ${uid} as the additional pool data of every inbound transfer, but the remote side sends ${mttp.remoteSendsData ?? 'nothing readable'}: inbound transfers revert here (InvalidAdditionalPoolData)`,
        'connection',
      )
  }
  // a remote burst the local inbound cannot absorb waits here until the bucket refills
  const localInbound = lane.rateLimits.inbound
  const theirs = back?.outbound
  if (localInbound && theirs && side.remoteDecimals !== undefined) {
    const toLocal = (amount: bigint) =>
      scaleDecimals(amount, side.remoteDecimals!, local.localDecimals)
    const [capacity, rate] = [toLocal(theirs.capacity), toLocal(theirs.rate)]
    if (localInbound.capacity < capacity || localInbound.rate < rate)
      add(
        'INBOUND_BELOW_REMOTE_OUTBOUND',
        'warning',
        `the inbound limit (capacity ${localInbound.capacity}, rate ${localInbound.rate}) is below the remote outbound one (capacity ${capacity}, rate ${rate} in local units): a burst the remote side lets out waits here for the bucket to refill; raise the inbound limit`,
        'rateLimit',
      )
  }
  return 'known'
}

/**
 * The account locks of a token-only send of `mint` toward the lane's EVM chain, from the send the
 * core resolver builds (every account the router and the pool resolve, the sender, the Router and
 * the compute-budget program), plus `extraAccounts`. `undefined` when the lane has no CCIP 2.0 send
 * path.
 */
async function sendLocks(
  chain: SolanaChain,
  router: PublicKey,
  mint: PublicKey,
  selector: bigint,
  lockBudget: CheckMultiTokenPoolLaneParams['lockBudget'],
): Promise<number | undefined> {
  const message = buildMessageForDest(
    {
      receiver: zeroPadValue('0x01', 20),
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

/** Whether the pool program reads long pool data: pool groups present (the feature probe). */
async function programHasPoolGroups(chain: SolanaChain, program: PublicKey): Promise<boolean> {
  try {
    return (await getPoolGroupProgramFeatures(chain, program)).includes('groups')
  } catch (err) {
    // a probe that cannot answer is not "pool groups present": fail closed
    if (err instanceof CCIPError && !err.isTransient) return false
    throw err
  }
}

/**
 * Runs the lane check on one Solana lane: registry and interface, admission, CCV sync, the long-data
 * fee floor, the stored EVM token and pool bytes, mint authority (burn-mint pools), pauses and
 * stops, the send lock budget, and the remote side ({@link evaluateSolanaLaneRemote}).
 * @internal
 */
export async function checkSolanaMultiTokenPoolLane(
  operation: string,
  chain: SolanaChain,
  params: CheckMultiTokenPoolLaneParams,
  key: { program: PublicKey; mint: PublicKey; selector: bigint },
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
  const evmRemote = laneFamilyOf(lane.remoteChainSelector) === ChainFamily.EVM
  const expected = new Set(params.expectOpen ?? DIRECTIONS)
  let remote: MultiTokenPoolFact = 'unknown'

  // the Router's registry must name this pool for the mint, on interface 2 for a marked lane
  const router = await registryOf(chain, pool.state.router)
  let interfaceVersion: number | undefined
  if (isUnread(router)) add('TOKEN_NOT_REGISTERED', 'error', router.reason)
  else {
    const registry = await readRegistry(chain, router, key.mint)
    if (isUnread(registry)) add('TOKEN_NOT_REGISTERED', 'error', registry.reason)
    else {
      interfaceVersion = registry.interfaceVersion
      if (!registry.registryPool?.equals(pool.address))
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
  }

  if (!state)
    add(
      'NO_CONNECTION',
      'error',
      'no ChainConfig exists for this token and chain: the lane does not exist',
    )
  else {
    const where = `the lane of ${lane.tokenAddress} toward ${lane.remoteChainSelector}`
    const uid = state.ext?.uid ?? null
    // admission and CCV sync, which fail every transfer of a lane that is not paused
    if (state.kind === 'driven' && lanePauses(state).admitted === false)
      add(
        'LANE_NOT_ADMITTED',
        'error',
        "the pool group's chain record does not admit this member, so transfers revert (GroupLaneNotEnabled): admit it in the chain record's lane mode",
        'connection',
      )
    const failsClosed = orThrow(laneFailsClosed(state), where)
    if (failsClosed !== undefined) {
      const { check, recordType, fix } = laneFailsClosedFinding(failsClosed.code)
      const what = failsClosed.directions.length > 1 ? 'every transfer' : 'every send'
      add(check, 'error', `${what} reverts: ${failsClosed.reason}; ${fix}`, recordType)
    }
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
    if (lane.poolDataFormat === 'long') {
      const needed = longPoolDataBytes(uid ? 32 : 0)
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
      const maxBps = params.maxTransferFeeBps ?? DEFAULT_MAX_TRANSFER_FEE_BPS
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
    let tokenValid = true
    if (evmRemote) {
      const raw = `0x${Buffer.from(state.chainConfig.base.remote.tokenAddress.address).toString('hex')}`
      if (!lane.remoteToken || !isAddress(lane.remoteToken)) {
        tokenValid = false
        add(
          'REMOTE_TOKEN_ENCODING',
          'error',
          `the remote token ${lane.remoteToken ?? raw} is not an EVM address`,
          'connection',
        )
      } else if (raw !== abiWord(lane.remoteToken))
        add(
          'REMOTE_TOKEN_ENCODING',
          'error',
          `the lane stores the remote token as ${raw}, but the EVM OnRamp sends ${abiWord(lane.remoteToken)} (abi.encode of ${getAddress(lane.remoteToken)}): the program compares the bytes of the source token in long pool data, so every long inbound transfer reverts (SourceTokenMismatch); store the 32-byte form`,
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
          for (const p of read.remotePools.filter(
            (p) => p.raw.toLowerCase() !== trimmed(p.address),
          ))
            add(
              'REMOTE_LANE_MISMATCH',
              'error',
              `the lane stores remote pool ${p.address} as ${p.raw}, but the OffRamp hands the pool the trailing ${length} bytes of the 32-byte form: inbound transfers from it revert; store the ${length}-byte form`,
              'remotePool',
            )
        }
      }
    }

    // the remote side; a token that is not an address of the remote family cannot be looked up there
    let side: SolanaLaneRemoteSide | undefined
    if (tokenValid) {
      const localReadsLong =
        interfaceVersion === 2 && (await programHasPoolGroups(chain, key.program))
      side = await readRemoteSide(params, read, chain.network.chainSelector)
      remote = evaluateSolanaLaneRemote(
        {
          lane,
          uid,
          readsLongData: localReadsLong,
          servingPool: pool.address.toBase58(),
          localDecimals: pool.state.decimals,
        },
        side,
        add,
      )
    }

    // the destination gas: the release runs on the remote chain, with the remote lane's hook
    if (fee) {
      const remoteHook = side?.status === 'known' && !!side.back?.hasHooks
      const minGas =
        params.minDestGasOverhead ??
        DEFAULT_MIN_DEST_GAS_OVERHEAD + (remoteHook ? HOOK_DEST_GAS_OVERHEAD : 0)
      if (fee.destGasOverhead < minGas)
        add(
          'DEST_GAS_OVERHEAD_TOO_LOW',
          'error',
          `destGasOverhead ${fee.destGasOverhead} is below ${minGas}${remoteHook ? ' (a hook resolves on the remote lane)' : ''}: the destination release can run out of gas`,
          'destOverhead',
        )
    }

    // mint authority, on burn-mint pools only: the pool mints inbound transfers as its signer, alone
    // or m times in an SPL multisig; lock-release, CCTP and Lombard pools do not mint
    const { type } = await resolvePoolProgramTypeAndVersion(chain, key.program)
    if (type === 'burn-mint') {
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
          `the mint authority of ${lane.tokenAddress} is ${mintAuthority?.toBase58() ?? 'none'}, not the burn-mint pool signer ${signer.toBase58()} (alone, or m times in an SPL multisig): inbound transfers cannot mint`,
        )
    } else if (type === undefined)
      add(
        'POOL_CANNOT_MINT_BURN',
        'warning',
        `the pool program ${key.program.toBase58()} reports no known pool type, so its mint or release authority was not checked`,
      )

    // the send lock budget, toward EVM chains, on a lane whose outbound is not paused
    const outboundPaused = lane.outboundStatus.status === 'paused'
    if (!isUnread(router) && evmRemote && !outboundPaused) {
      const severity = expected.has('outbound') ? 'error' : 'warning'
      try {
        const locks = await sendLocks(chain, router, key.mint, key.selector, params.lockBudget)
        if (locks === undefined)
          add(
            'ACCOUNT_LOCKS_EXCEEDED',
            'warning',
            'the send lock budget was not measured: the lane has no CCIP 2.0 send path',
          )
        else if (locks > SOLANA_MAX_ACCOUNT_LOCKS)
          add(
            'ACCOUNT_LOCKS_EXCEEDED',
            severity,
            `a send of this token takes ${locks} account locks, above the ${SOLANA_MAX_ACCOUNT_LOCKS} a transaction may take: the send cannot land`,
          )
      } catch (err) {
        // the resolver's or the program's refusal is an answer; transport errors propagate
        if (!isViewRefusal(err) && !notTransient(err)) throw err
        add(
          'ACCOUNT_LOCKS_EXCEEDED',
          severity,
          `the send lock budget could not be measured: the send resolution was refused (${err instanceof Error ? err.message : String(err)})`,
        )
      }
    }
  }

  // pauses and stops, by the directions that must be open
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

  const sorted = sortFindings(findings)
  return { lane, findings: sorted, remote, ok: !sorted.some((f) => f.severity === 'error') }
}
