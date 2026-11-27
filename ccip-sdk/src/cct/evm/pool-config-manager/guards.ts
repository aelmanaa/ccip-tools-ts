/**
 * The post-state rules of a lane-affecting PCM write, evaluated on projected lanes.
 *
 * Pure: the lanes come from the projection, the facts the projection cannot know (remote side,
 * hook callers, provider data) are supplied, and the result is findings. The framework that reads
 * the state and the facts, and refuses on an error finding, is in `guard-run.ts`.
 *
 * @packageDocumentation
 */

import { ZeroAddress, getAddress } from 'ethers'

import type { LaneRecordType, RateLimiterState, TransferDirection } from '../../../chain.ts'
import { LANE_RECORD_TYPES } from '../../../evm/multi-token-pool.ts'
import { canonicalJson } from '../../canonical.ts'
import { CCTParamsInvalidError } from '../../errors.ts'
import {
  type MultiTokenPoolLaneFinding,
  type MultiTokenPoolRateLimits,
  type MultiTokenPoolRemoteAttestation,
  type MultiTokenPoolRemoteFact,
  DEFAULT_MAX_TRANSFER_FEE_BPS,
  DEFAULT_MIN_DEST_GAS_OVERHEAD,
  HOOK_DEST_GAS_OVERHEAD,
  LEGACY_POOL_DATA_BYTES,
  isStop,
  longPoolDataBytes,
  sortFindings,
} from '../../multi-token-pool.ts'
import type { RateLimitConfig } from '../../rate-limit.ts'
import { parseUniqueRemoteAddresses } from '../../remote-address.ts'
import {
  assertUnique,
  validateAddress,
  validateArray,
  validateBoolean,
  validateOneOf,
  validateUint32,
  validateUint64,
} from '../validate.ts'
import {
  type MultiTokenPoolInlineRemotePoolDrop,
  type MultiTokenPoolLaneDirections,
  type MultiTokenPoolLaneKey,
  DROPPABLE_REMOTE_POOL_FLAGS,
  validateLaneKeys,
} from './contracts.ts'
import {
  type MultiTokenPoolRecordChange,
  type MultiTokenPoolRecordState,
  type ProjectedMultiTokenPoolLane,
  laneKey,
  multiTokenPoolRecordChains,
  multiTokenPoolSupportedChains,
  policyKey,
  resolveMultiTokenPoolLanes,
} from './projection.ts'

// the guard defaults and pool-data sizes are family-neutral: they live in the shared module, re-exported
// here so EVM importers keep their path
export {
  DEFAULT_MAX_TRANSFER_FEE_BPS,
  DEFAULT_MIN_DEST_GAS_OVERHEAD,
  HOOK_DEST_GAS_OVERHEAD,
  LEGACY_POOL_DATA_BYTES,
  LONG_POOL_DATA_BYTES,
  longPoolDataBytes,
} from '../../multi-token-pool.ts'

/**
 * The guard thresholds and confirmations of a lane-affecting write (never switches that skip a rule);
 * part of `MultiTokenPoolWriteGuards`.
 */
export type MultiTokenPoolGuardOptions = {
  /** Accept non-empty CCV lists without the default-CCV placeholder `address(0)`. Defaults to `false`. */
  allowDroppingDefaultCCVs?: boolean
  /** Highest resolved transfer fee in bps on any affected lane, both tiers. Defaults to 1,000. */
  maxTransferFeeBps?: number
  /** Lowest resolved `destGasOverhead`. Defaults to 200,000, plus 100,000 when a hook resolves. */
  minDestGasOverhead?: number
  /** Lanes the caller agrees this write closes (connection gone after the write). */
  confirmClosing?: MultiTokenPoolLaneKey[]
  /**
   * Lanes, per direction, the caller agrees this write opens: refused when a lane it opens goes
   * live in a direction not listed. A planner passes its planned lanes.
   */
  confirmOpening?: MultiTokenPoolLaneDirections[]
  /**
   * Remote pools (and flags) the caller agrees this write drops from a lane's trusted pools: refused
   * when it drops one not listed, since in-flight inbound messages from a dropped pool revert.
   */
  confirmDropped?: MultiTokenPoolInlineRemotePoolDrop[]
  /**
   * Remote chains where a lane may accept legacy pool data from a remote multi-token pool: only for
   * a migration window.
   */
  migrationWindowChains?: bigint[]
}

// the family-neutral remote fact and the lane directions; re-exported so importers keep their path
export type {
  MultiTokenPoolInlineRemotePoolDrop,
  MultiTokenPoolLaneDirections,
} from './contracts.ts'
export type { MultiTokenPoolRemoteFact } from '../../multi-token-pool.ts'

/** What the remote side of one lane does. @internal */
export type MultiTokenPoolRemoteLaneFacts = MultiTokenPoolRemoteFact<{
  /** Whether the remote pool the remote registry names reads long pool data. */
  readsLongData: boolean
  /** The pool the remote registry names for the remote token, or `null` when it names none. */
  registryPool: string | null
  /** Whether that pool's lane back points at this token and trusts a local serving pool. */
  mapsBack: boolean
  /** Why `mapsBack` is `false`, when the reader can say (e.g. the stored bytes differ). */
  mapsBackReason?: string
  /**
   * Set when every transfer on the remote lane reverts although it is not paused (Solana: a stale
   * SECURITY record or an unsynced CCV copy): the lane is not live.
   */
  failsClosed?: string
  /** The remote lane's UID (`0x` hex), which every inbound long transfer must carry; `null`: none. */
  uid?: string | null
  /** A group-driven remote lane: whether its chain record admits the member now. */
  admitted?: boolean
  /**
   * Whether the remote token's provider accepts the additional data this lane sends (`undefined`: the
   * remote token has no provider, or the reader cannot say).
   */
  remoteAcceptsOutbound?: boolean
  /** The additional data the remote side sends (`0x`: none); `undefined` when it cannot be read. */
  remoteSendsData?: string
  /** Set when the remote provider refuses to produce data for its own token. */
  remoteProviderRefused?: string
  /** Whether the remote side sends legacy pool data (no source token) toward this chain. */
  remoteSendsLegacy?: boolean
  /** Set when what the remote side sends and accepts cannot be read: the rules never pass on it. */
  remoteSideUnread?: string
  /** Whether the remote token has code on the remote chain (read when the registry names no pool). */
  remoteTokenHasCode?: boolean
  /** The remote pool's outbound bucket toward this chain (read for the lane check), `null` when disabled. */
  remoteOutbound?: RateLimiterState
  /** Decimals of the remote token (read with `remoteOutbound`), to compare the limits in one unit. */
  remoteDecimals?: number
  /** Why the remote outbound bucket could not be read, when it was asked for and the lane back exists. */
  remoteOutboundUnknownReason?: string
  /** The attestation the long-data fact came from, for a family the SDK cannot read. */
  attestation?: MultiTokenPoolRemoteAttestation
}>

/** What one trusted remote pool is. @internal */
export type MultiTokenPoolRemotePoolFacts = MultiTokenPoolRemoteFact<{
  /** Whether it is a multi-token pool (it sends long data, so it never needs legacy receive). */
  isMultiTokenPool: boolean
}>

/** The facts the rules need beyond the projection. @internal */
export type MultiTokenPoolGuardFacts = {
  /** Per lane key (`token:chain`), for the lanes {@link requiredMultiTokenPoolGuardFacts} lists. */
  remoteLanes: ReadonlyMap<string, MultiTokenPoolRemoteLaneFacts>
  /** Per `chain:pool`, for trusted pools that may send legacy data. */
  remotePools: ReadonlyMap<string, MultiTokenPoolRemotePoolFacts>
  /** Authorized callers per resolved hook. */
  hookCallers: ReadonlyMap<string, readonly string[]>
  /** The pools that call this PCM (the target pool and every pool sharing it). */
  servingPools: readonly string[]
  /** Bytes of additional pool data the token's provider adds, per lane key, for lanes with one. */
  additionalPoolDataBytes: ReadonlyMap<string, number>
  /** The additional pool data itself (`0x` hex), per lane key, for lanes with a provider. */
  additionalPoolData?: ReadonlyMap<string, string>
  /** Why the token's provider refuses to produce data for it, per lane key. */
  providerDataRefused?: ReadonlyMap<string, string>
  /** Whether the token's provider accepts the data the remote side sends, per lane key. */
  localAcceptsInbound?: ReadonlyMap<string, boolean>
  /** Whether the token's provider accepts the empty data of legacy receive, per lane key. */
  localAcceptsLegacy?: ReadonlyMap<string, boolean>
}

/** The facts to read for a set of projected lanes. @internal */
export type MultiTokenPoolGuardFactRequests = {
  /** Lanes whose remote side to read. */
  remoteLanes: ProjectedMultiTokenPoolLane[]
  /** Trusted remote pools allowed to send legacy data, per chain. */
  remotePools: { remoteChainSelector: bigint; address: string }[]
  /** Hooks whose callers to read. */
  hooks: string[]
  /** Open lanes: the reader reads the provider data length of those whose token has a provider. */
  providerLanes: MultiTokenPoolLaneKey[]
}

/** The lane key the facts maps use. @internal */
export const guardLaneKey = ({ tokenAddress, remoteChainSelector }: MultiTokenPoolLaneKey) =>
  laneKey(tokenAddress, remoteChainSelector)
/** The remote pool key the facts maps use. @internal */
export const guardPoolKey = (remoteChainSelector: bigint, address: string) =>
  `${remoteChainSelector}:${address}`

/** Every (token, chain) a state names, for the lanes a write could reach. */
function candidateLanes(states: readonly MultiTokenPoolRecordState[]): MultiTokenPoolLaneKey[] {
  const tokens = new Set(states.flatMap((s) => s.tokens.map((t) => getAddress(t.tokenAddress))))
  const chains = new Set(states.flatMap(multiTokenPoolRecordChains))
  return [...tokens].flatMap((tokenAddress) =>
    [...chains].map((remoteChainSelector) => ({ tokenAddress, remoteChainSelector })),
  )
}

/** Field-by-field equality of two projected lanes, remote pools as a set. */
function sameLane(a: ProjectedMultiTokenPoolLane, b: ProjectedMultiTokenPoolLane): boolean {
  const norm = (l: ProjectedMultiTokenPoolLane) => ({
    ...l,
    connection: {
      ...l.connection,
      remotePools: [...l.connection.remotePools].sort((x, y) => x.address.localeCompare(y.address)),
    },
  })
  return canonicalJson(norm(a)) === canonicalJson(norm(b))
}

/**
 * The lanes a write changes: every (token, chain) either state names whose projection differs
 * before and after, with both projections.
 *
 * @remarks Exact by construction: a policy record masked by an inline record changes no lane, a pair
 * with no connection before or after is not a lane, and a
 * remote pool policy reaches the lanes whose inline record trusts policy pools. A chain-0 default
 * reaches every chain of the policy's tokens. Both states need provider answers for their
 * policy-resolved lanes.
 * @internal
 */
export function multiTokenPoolAffectedLanes(
  before: MultiTokenPoolRecordState,
  after: MultiTokenPoolRecordState,
): { before: ProjectedMultiTokenPoolLane; after: ProjectedMultiTokenPoolLane }[] {
  const lanes = candidateLanes([before, after])
  const b = resolveMultiTokenPoolLanes(before, lanes)
  const a = resolveMultiTokenPoolLanes(after, lanes)
  return lanes.flatMap((_, i) => {
    const [x, y] = [b[i]!, a[i]!]
    // a lane with no connection on either side is not a lane: its pause flags alone change nothing
    if (!x.connection.hasConnection && !y.connection.hasConnection) return []
    return sameLane(x, y) ? [] : [{ before: x, after: y }]
  })
}

/**
 * Every (token, chain) a state names, for the lane projections the rules compare against (the shared-remote-token rule reads
 * every token's lane on a chain).
 * @internal
 */
export function multiTokenPoolCandidateLanes(
  ...states: MultiTokenPoolRecordState[]
): MultiTokenPoolLaneKey[] {
  return candidateLanes(states)
}

/**
 * The facts the rules need for these lanes after the write.
 * @internal
 */
export function requiredMultiTokenPoolGuardFacts(
  after: readonly ProjectedMultiTokenPoolLane[],
): MultiTokenPoolGuardFactRequests {
  const open = after.filter((l) => l.connection.hasConnection && l.connection.remoteToken !== null)
  const pools = new Map<string, { remoteChainSelector: bigint; address: string }>()
  for (const l of open)
    for (const p of l.connection.remotePools)
      if (p.allowLegacyPoolData)
        pools.set(guardPoolKey(l.remoteChainSelector, p.address), {
          remoteChainSelector: l.remoteChainSelector,
          address: p.address,
        })
  return {
    remoteLanes: open,
    remotePools: [...pools.values()],
    hooks: [...new Set(open.flatMap((l) => (l.verification.hook ? [l.verification.hook] : [])))],
    providerLanes: open.map(({ tokenAddress, remoteChainSelector }) => ({
      tokenAddress,
      remoteChainSelector,
    })),
  }
}

/** A rule's failure to read a fact: the framework throws it as `CCTParamsInvalidError`. @internal */
export type MultiTokenPoolGuardFactFailure = MultiTokenPoolLaneKey & {
  /** `'missing'` or `'unknown'`. */
  status: 'missing' | 'unknown'
  /** Whether the fact is about the remote side of the lane, or a local contract (a hook). */
  scope: 'remote' | 'local'
  /** What could not be read. */
  reason: string
  /** The error that left it unread, when one did; see {@link MultiTokenPoolRemoteFact}. */
  cause?: unknown
}

/** Inputs of {@link evaluateMultiTokenPoolGuards}. @internal */
export type EvaluateMultiTokenPoolGuardsInput = {
  /** The records after the write. */
  after: MultiTokenPoolRecordState
  /** The affected lanes, before and after. */
  lanes: readonly { before: ProjectedMultiTokenPoolLane; after: ProjectedMultiTokenPoolLane }[]
  /** Every token's lane after the write on the affected chains (for the shared-remote-token rule). */
  chainLanes: readonly ProjectedMultiTokenPoolLane[]
  /** The facts {@link requiredMultiTokenPoolGuardFacts} asked for. */
  facts: MultiTokenPoolGuardFacts
  /** The write's thresholds and confirmations. */
  options?: MultiTokenPoolGuardOptions
}

/**
 * Evaluates the post-state rules on the affected lanes.
 *
 * @returns Findings (errors refuse the write; warnings are reported) and fact failures (the framework
 *   refuses with `CCTParamsInvalidError`: a guard never passes on a fact it could not read).
 * @internal
 */
export function evaluateMultiTokenPoolGuards({
  after,
  lanes,
  chainLanes,
  facts,
  options = {},
}: EvaluateMultiTokenPoolGuardsInput): {
  findings: MultiTokenPoolLaneFinding[]
  factFailures: MultiTokenPoolGuardFactFailure[]
} {
  const findings: MultiTokenPoolLaneFinding[] = []
  const factFailures: MultiTokenPoolGuardFactFailure[] = []
  const maxBps = options.maxTransferFeeBps ?? DEFAULT_MAX_TRANSFER_FEE_BPS
  const confirmed = new Set((options.confirmClosing ?? []).map(guardLaneKey))
  const migration = new Set(options.migrationWindowChains ?? [])
  const serving = facts.servingPools.map((p) => getAddress(p))

  for (const { before, after: lane } of lanes) {
    const key = { tokenAddress: lane.tokenAddress, remoteChainSelector: lane.remoteChainSelector }
    const add = (
      check: MultiTokenPoolLaneFinding['check'],
      severity: MultiTokenPoolLaneFinding['severity'],
      reason: string,
      recordType?: LaneRecordType,
    ) => findings.push({ check, severity, ...key, ...(recordType && { recordType }), reason })
    const c = lane.connection

    // a lane the write closes strands in-flight inbound messages
    if (before.connection.hasConnection && !c.hasConnection) {
      if (confirmed.has(guardLaneKey(key)))
        add(
          'LANE_CLOSED',
          'warning',
          'the write closes this lane (confirmed in confirmClosing)',
          'connection',
        )
      else
        add(
          'LANE_CLOSED',
          'error',
          'the write closes this lane: in-flight inbound messages would fail to execute; drain it, or list it in confirmClosing',
          'connection',
        )
    }
    // teardown: a lane with no connection after the write has no other rule
    if (!c.hasConnection) continue

    // a lane with a connection and a missing record reverts every transfer that reads it
    const missing = LANE_RECORD_TYPES.filter((t) => lane.levels[t] === 'none')
    if (missing.length)
      add(
        'RECORD_MISSING',
        'error',
        `the lane stays open with no ${missing.join(', ')} record: every transfer that reads it reverts`,
        missing[0],
      )
    if (c.remoteToken === null) {
      add(
        'NO_CONNECTION',
        'error',
        "the connection resolves but its remote token does not (the policy's provider has none, or answers an invalid address): every send reverts",
        'connection',
      )
      continue
    }

    const fee = lane.tokenTransferFeeConfig
    if (fee.isEnabled) {
      // pool data longer than destBytesOverhead reverts the send
      const extra = facts.additionalPoolDataBytes.get(guardLaneKey(key)) ?? 0
      const needed =
        c.poolDataFormat === 'legacy' ? LEGACY_POOL_DATA_BYTES : longPoolDataBytes(extra)
      if (fee.destBytesOverhead < needed)
        add(
          'DEST_BYTES_OVERHEAD_TOO_LOW',
          'error',
          `destBytesOverhead ${fee.destBytesOverhead} is below the ${needed} bytes of ${c.poolDataFormat} pool data this lane sends: every send reverts`,
          'destOverhead',
        )
      // too little gas for the destination releaseOrMint
      const minGas =
        options.minDestGasOverhead ??
        DEFAULT_MIN_DEST_GAS_OVERHEAD + (lane.verification.hook ? HOOK_DEST_GAS_OVERHEAD : 0)
      if (fee.destGasOverhead < minGas)
        add(
          'DEST_GAS_OVERHEAD_TOO_LOW',
          'error',
          `destGasOverhead ${fee.destGasOverhead} is below ${minGas}${lane.verification.hook ? ' (a hook resolves)' : ''}: the destination release can run out of gas`,
          'destOverhead',
        )
      // the resolved token fee, both tiers
      const bps = Math.max(fee.finalityTransferFeeBps, fee.fastFinalityTransferFeeBps)
      if (bps > maxBps)
        add(
          'TRANSFER_FEE_ABOVE_CAP',
          'error',
          `the resolved transfer fee is ${bps} bps, above maxTransferFeeBps ${maxBps}`,
          'fee',
        )
    }

    // a CCV list without address(0) drops the ramps' default CCVs
    if (!options.allowDroppingDefaultCCVs)
      for (const [direction, list] of [
        ['outbound', lane.verification.outboundCCVs],
        ['inbound', lane.verification.inboundCCVs],
      ] as const)
        if (list.length && !list.some((a) => getAddress(a) === ZeroAddress))
          add(
            'DEFAULT_CCVS_DROPPED',
            'error',
            `the ${direction} CCV list${policyBlastRadius(after, lane, 'security')} has no address(0), so it drops the default CCVs; include address(0), or set allowDroppingDefaultCCVs`,
            'security',
          )

    // hooks: a hook that does not list a serving pool reverts that pool's transfers
    if (lane.verification.hook) {
      const callers = facts.hookCallers.get(getAddress(lane.verification.hook))
      if (!callers)
        factFailures.push({
          ...key,
          status: 'unknown',
          scope: 'local',
          reason: `hook ${lane.verification.hook} callers were not read`,
        })
      else {
        const absent = serving.filter((p) => !callers.some((a) => getAddress(a) === p))
        if (absent.length)
          add(
            'HOOK_CALLER_MISSING',
            'error',
            `hook ${lane.verification.hook} does not authorize the serving pool(s) ${absent.join(', ')}: their transfers revert`,
            'security',
          )
      }
    }

    // two local tokens resolving the same remote token: the destination mints the wrong one
    const shared = chainLanes.filter(
      (o) =>
        o.remoteChainSelector === lane.remoteChainSelector &&
        getAddress(o.tokenAddress) !== getAddress(lane.tokenAddress) &&
        o.connection.hasConnection &&
        o.connection.remoteToken === c.remoteToken,
    )
    if (shared.length)
      add(
        'REMOTE_TOKEN_SHARED',
        'error',
        `remote token ${c.remoteToken} is also the remote token of ${shared.map((o) => o.tokenAddress).join(', ')} on this chain, so the destination cannot tell them apart: give each local token its own remote token`,
        'connection',
      )

    // legacy data received from a remote multi-token pool cannot identify the source token
    for (const p of c.remotePools) {
      if (!p.allowLegacyPoolData || migration.has(lane.remoteChainSelector)) continue
      const pool = facts.remotePools.get(guardPoolKey(lane.remoteChainSelector, p.address))
      if (!pool || pool.status !== 'known') {
        factFailures.push({
          ...key,
          scope: 'remote',
          status: pool?.status ?? 'unknown',
          reason: pool?.status ? pool.reason : `remote pool ${p.address} was not read`,
          ...(pool?.cause !== undefined && { cause: pool.cause }),
        })
        continue
      }
      if (pool.isMultiTokenPool)
        add(
          'LEGACY_RECEIVE_FROM_MULTI_TOKEN_POOL',
          'error',
          `remote pool ${p.address} is a multi-token pool but may send legacy pool data, which names no source token; only during a migration (migrationWindowChains)`,
          'remotePool',
        )
    }

    // remote side: the registry's pool, its pool data format, and the reverse mapping
    // a lane that trusts no remote pool accepts nothing inbound, and its remote side cannot be
    // located to check: allowed on chain, refused here (the SDK never opens what it cannot check)
    if (!c.remotePools.length) {
      add(
        'NO_REMOTE_POOL',
        'error',
        'the lane trusts no remote pool: an empty list is allowed on chain, but the SDK refuses a lane that trusts no remote pool, since nothing inbound is accepted and its remote side cannot be checked; add the remote pool (applyMultiTokenPoolInlineRemotePoolConfigUpdates, or a remote pool policy record)',
        'remotePool',
      )
      continue
    }
    const remote = facts.remoteLanes.get(guardLaneKey(key))
    if (!remote || remote.status !== 'known') {
      factFailures.push({
        ...key,
        scope: 'remote',
        status: remote?.status ?? 'unknown',
        reason: remote?.status ? remote.reason : 'the remote side of this lane was not read',
        ...(remote?.cause !== undefined && { cause: remote.cause }),
      })
      continue
    }
    if (remote.attestation)
      add(
        'REMOTE_ATTESTED',
        'warning',
        `the remote long-data fact comes from an attestation, not a read: ${remote.attestation.reason}`,
      )
    // a token paused or stopped outbound whose remote registry names no pool yet may wait (the MTTP
    // spec's onboarding exception, as on Solana): nothing is sent, so nothing burns; the unpause or
    // lift re-check runs with no exception
    const waiting =
      (c.isTokenOutboundPaused || stopsOutbound(lane.rateLimits)) && remote.registryPool === null
    if (remote.registryPool === null) {
      if (!waiting)
        add(
          'NO_REMOTE_POOL',
          'error',
          `the remote registry names no pool for ${c.remoteToken}${remote.remoteTokenHasCode === false ? ', which has no code on the remote chain' : ''}: a send burns here and nothing releases it there; register the remote side first, or keep the token paused or stopped outbound`,
          'connection',
        )
      continue
    }
    if (!c.remotePools.some((p) => p.address === remote.registryPool))
      add(
        'REMOTE_LANE_MISMATCH',
        'error',
        `the remote registry names pool ${remote.registryPool} for ${c.remoteToken}, which this lane does not trust: inbound messages from it revert`,
        'remotePool',
      )
    if (c.poolDataFormat === 'long' && !remote.readsLongData)
      add(
        'POOL_DATA_FORMAT_MISMATCH',
        'error',
        `the lane sends long pool data but remote pool ${remote.registryPool} reads only legacy data: the destination release reverts and the burned tokens are stuck`,
        'remotePool',
      )
    // the EVM reader judges the reverse mapping only on legacy lanes (`true` on long ones); a reader
    // that compares the stored bytes judges both, and says why
    if (!remote.mapsBack)
      add(
        'REMOTE_LANE_MISMATCH',
        'error',
        remote.mapsBackReason ??
          'the lane sends legacy pool data (no source token), but the remote lane back does not point at this token and a serving pool: the destination cannot tell which token was sent',
        'connection',
      )
    // the lane has a connection here: live outbound unless paused
    const liveOutbound = !c.isOutboundPaused
    if (remote.failsClosed !== undefined)
      add(
        'REMOTE_LANE_MISMATCH',
        // a send into a lane that reverts is stuck; a write that leaves the lane paused may proceed
        liveOutbound ? 'error' : 'warning',
        `the remote lane reverts every transfer in both directions: ${remote.failsClosed}`,
        'security',
      )
    if (remote.admitted === false)
      add(
        'LANE_NOT_ADMITTED',
        'warning',
        "the remote group's chain record does not admit this member now, so the remote lane is paused: transfers wait until it is admitted",
        'connection',
      )
    // the additional pool data, judged by the providers that judge it on chain: the remote token's on
    // what this lane sends, this token's on what arrives (legacy receive arrives empty)
    const laneKeyStr = guardLaneKey(key)
    const refused = facts.providerDataRefused?.get(laneKeyStr)
    if (refused !== undefined)
      add(
        'UID_MISMATCH',
        'error',
        `this token's additional pool data provider refuses to produce data for it (${refused}): every send reverts; use a provider that maps the token (a UID factory must have deployed it)`,
        'connection',
      )
    if (remote.remoteAcceptsOutbound === false)
      add(
        'UID_MISMATCH',
        'error',
        `the remote token's provider refuses the additional pool data this lane sends (${c.poolDataFormat === 'legacy' ? 'none: the lane sends legacy data' : (facts.additionalPoolData?.get(laneKeyStr) ?? 'none')}): the release there reverts (InvalidAdditionalPoolData) and the burned tokens are stuck; pair the providers, or send long data`,
        'connection',
      )
    if (facts.localAcceptsInbound?.get(laneKeyStr) === false)
      add(
        'UID_MISMATCH',
        'error',
        `this token's provider refuses the additional pool data the remote side sends (${remote.remoteSendsData}): inbound releases revert here (InvalidAdditionalPoolData); pair the providers`,
        'connection',
      )
    if (facts.localAcceptsLegacy?.get(laneKeyStr) === false)
      add(
        'UID_MISMATCH',
        'error',
        "a trusted remote pool may send legacy pool data, which carries no additional data, and this token's provider refuses empty data: such inbound releases revert; clear allowLegacyPoolData",
        'remotePool',
      )
    const hasProvider = facts.additionalPoolData?.has(laneKeyStr) === true || refused !== undefined
    if (remote.remoteProviderRefused !== undefined)
      add(
        'UID_MISMATCH',
        'warning',
        `${remote.remoteProviderRefused}: sends from the remote side revert there`,
        'connection',
      )
    // what the remote sends and accepts could not be read: fail closed, never pass
    if (
      remote.remoteSideUnread !== undefined ||
      (hasProvider && remote.remoteSendsData === undefined)
    )
      factFailures.push({
        ...key,
        scope: 'remote',
        status: 'unknown',
        reason:
          remote.remoteSideUnread ??
          "the additional pool data the remote side sends cannot be read, so this token's provider cannot be checked against it",
      })
    // legacy data names no source token: the lane must trust the sending pool with allowLegacyPoolData
    // (chainlink-ccip c950d9bc ConnectionPolicyStore._checkPoolData, LegacyPoolDataNotAllowed)
    const sender = c.remotePools.find((p) => p.address === remote.registryPool)
    if (remote.remoteSendsLegacy && sender && !sender.allowLegacyPoolData)
      add(
        'POOL_DATA_FORMAT_MISMATCH',
        'error',
        `remote pool ${remote.registryPool} sends legacy pool data, which this lane refuses from it (LegacyPoolDataNotAllowed): every inbound release reverts here; set allowLegacyPoolData on that remote pool, or have the remote side send long data`,
        'remotePool',
      )
    if (remote.uid != null && c.poolDataFormat === 'long') {
      const data = facts.additionalPoolData?.get(guardLaneKey(key))
      if (data === undefined || data.toLowerCase() !== remote.uid.toLowerCase())
        add(
          'UID_MISMATCH',
          'error',
          `the remote lane requires UID ${remote.uid} as the additional pool data of every inbound transfer, but this lane sends ${data ?? 'none'}: the destination refuses it (InvalidAdditionalPoolData); give the token the provider that answers this UID`,
          'connection',
        )
    }
  }
  return { findings: sortFindings(findings), factFailures }
}

/** ` (policy P, N tokens)` when the record resolves from a shared policy, for blast-radius reasons. */
function policyBlastRadius(
  state: MultiTokenPoolRecordState,
  lane: ProjectedMultiTokenPoolLane,
  type: LaneRecordType,
): string {
  if (lane.levels[type] !== 'policy-chain' && lane.levels[type] !== 'policy-default') return ''
  const token = state.tokens.find(
    (t) => getAddress(t.tokenAddress) === getAddress(lane.tokenAddress),
  )
  const name = token?.policies[type]
  if (!name) return ''
  const word = policyKey(name, 'policyName')
  const count = state.tokens.filter((t) => {
    const p = t.policies[type]
    return p !== null && policyKey(p, 'policyName') === word
  }).length
  return ` (from ${type} policy ${name}, shared by ${count} token${count === 1 ? '' : 's'})`
}

/** Every token's lane on the given chains, after the write, for the shared-remote-token rule. @internal */
export function multiTokenPoolChainLanes(
  state: MultiTokenPoolRecordState,
  chains: readonly bigint[],
): ProjectedMultiTokenPoolLane[] {
  const want = new Set(chains)
  const lanes = state.tokens.flatMap((t) =>
    multiTokenPoolSupportedChains(state, t.tokenAddress)
      .filter((c) => want.has(c))
      .map((remoteChainSelector) => ({ tokenAddress: t.tokenAddress, remoteChainSelector })),
  )
  return resolveMultiTokenPoolLanes(state, lanes)
}

/** Both transfer directions, outbound first. @internal */
export const TRANSFER_DIRECTIONS = [
  'outbound',
  'inbound',
] as const satisfies readonly TransferDirection[]
const DIRECTIONS = TRANSFER_DIRECTIONS

/**
 * Validates guard options before any RPC: a write's own params (`prefix` empty) or the options a
 * snapshot sealed (`prefix` naming where they sit), with the same validators the reads use.
 * @throws {@link CCTParamsInvalidError} naming the first invalid option
 * @internal
 */
export function validateMultiTokenPoolGuardOptions(
  operation: string,
  prefix: string,
  o: Record<string, unknown>,
): asserts o is MultiTokenPoolGuardOptions {
  const at = (name: string) => `${prefix}${name}`
  if (o.allowDroppingDefaultCCVs !== undefined)
    validateBoolean(operation, at('allowDroppingDefaultCCVs'), o.allowDroppingDefaultCCVs)
  if (o.maxTransferFeeBps !== undefined)
    validateUint32(operation, at('maxTransferFeeBps'), o.maxTransferFeeBps)
  if (o.minDestGasOverhead !== undefined)
    validateUint32(operation, at('minDestGasOverhead'), o.minDestGasOverhead)
  if (o.confirmClosing !== undefined)
    validateLaneKeys(operation, at('confirmClosing'), o.confirmClosing, 0)
  if (o.confirmOpening !== undefined) {
    validateLaneKeys(operation, at('confirmOpening'), o.confirmOpening, 0)
    o.confirmOpening.forEach((l, i) => {
      const { directions } = l as { directions?: unknown }
      validateArray(operation, at(`confirmOpening[${i}].directions`), directions)
      Array.from(directions, (d, j) =>
        validateOneOf(operation, at(`confirmOpening[${i}].directions[${j}]`), d, DIRECTIONS),
      )
    })
  }
  if (o.confirmDropped !== undefined) {
    validateArray(operation, at('confirmDropped'), o.confirmDropped)
    Array.from(o.confirmDropped, (d, i) => {
      const entry = at(`confirmDropped[${i}]`)
      const { lane, remotePools, flags } = (d ?? {}) as Record<string, unknown>
      if (lane === undefined)
        throw new CCTParamsInvalidError(
          operation,
          `${entry}.lane`,
          'is required: the lane the write drops pools from',
        )
      const { tokenAddress, remoteChainSelector } = lane as Record<string, unknown>
      validateAddress(operation, `${entry}.lane.tokenAddress`, tokenAddress)
      validateUint64(operation, `${entry}.lane.remoteChainSelector`, remoteChainSelector)
      if (remotePools !== undefined) {
        validateArray(operation, `${entry}.remotePools`, remotePools)
        parseUniqueRemoteAddresses(
          operation,
          `${entry}.remotePools`,
          remotePools,
          (lane as MultiTokenPoolLaneKey).remoteChainSelector,
        )
      }
      if (flags !== undefined) {
        validateArray(operation, `${entry}.flags`, flags)
        Array.from(flags, (f, j) =>
          validateOneOf(operation, `${entry}.flags[${j}]`, f, DROPPABLE_REMOTE_POOL_FLAGS),
        )
      }
    })
    assertUnique(
      operation,
      at('confirmDropped'),
      o.confirmDropped as readonly MultiTokenPoolInlineRemotePoolDrop[],
      (d) => guardLaneKey(d.lane),
      'lane',
    )
  }
  if (o.migrationWindowChains !== undefined) {
    validateArray(operation, at('migrationWindowChains'), o.migrationWindowChains)
    Array.from(o.migrationWindowChains, (c, i) =>
      validateUint64(operation, at(`migrationWindowChains[${i}]`), c),
    )
  }
}

/** Whether a lane is live in a direction: it has a connection and no pause holds that direction. */
function liveIn(l: ProjectedMultiTokenPoolLane, d: TransferDirection): boolean {
  return (
    l.connection.hasConnection &&
    !(d === 'outbound' ? l.connection.isOutboundPaused : l.connection.isInboundPaused)
  )
}

/**
 * What a write opens and makes live, per direction: `opened` gains a connection (with the directions
 * live after it), `goingLive` is live in a direction it was not live in before (an opened lane, or an
 * unpause).
 * @internal
 */
export function multiTokenPoolLaneTransitions(
  lanes: readonly { before: ProjectedMultiTokenPoolLane; after: ProjectedMultiTokenPoolLane }[],
): { opened: MultiTokenPoolLaneDirections[]; goingLive: MultiTokenPoolLaneDirections[] } {
  const entry = (l: ProjectedMultiTokenPoolLane, directions: TransferDirection[]) => ({
    tokenAddress: l.tokenAddress,
    remoteChainSelector: l.remoteChainSelector,
    directions,
  })
  const opened: MultiTokenPoolLaneDirections[] = []
  const goingLive: MultiTokenPoolLaneDirections[] = []
  for (const { before, after } of lanes) {
    if (!before.connection.hasConnection && after.connection.hasConnection)
      opened.push(
        entry(
          after,
          DIRECTIONS.filter((d) => liveIn(after, d)),
        ),
      )
    const newly = DIRECTIONS.filter((d) => liveIn(after, d) && !liveIn(before, d))
    if (newly.length) goingLive.push(entry(after, newly))
  }
  return { opened, goingLive }
}

/**
 * What a write drops from each lane's trusted remote pools: pools trusted before and not after, and
 * `allowLegacyPoolData` turned off on a pool kept. Lanes closed or opened by the write are not
 * drops (`confirmClosing` and `confirmOpening` cover them). Addresses are canonical spellings.
 * @internal
 */
export function multiTokenPoolDroppedPools(
  lanes: readonly { before: ProjectedMultiTokenPoolLane; after: ProjectedMultiTokenPoolLane }[],
): { lane: MultiTokenPoolLaneKey; remotePools: string[]; flags: 'allowLegacyPoolData'[] }[] {
  return lanes
    .filter(
      ({ before, after }) => before.connection.hasConnection && after.connection.hasConnection,
    )
    .map(({ before, after }) => {
      const kept = new Map(
        after.connection.remotePools.map((p) => [p.address, p.allowLegacyPoolData]),
      )
      const remotePools = before.connection.remotePools
        .filter((p) => !kept.has(p.address))
        .map((p) => p.address)
      const legacyOff = before.connection.remotePools.some(
        (p) => p.allowLegacyPoolData && kept.get(p.address) === false,
      )
      return {
        lane: { tokenAddress: after.tokenAddress, remoteChainSelector: after.remoteChainSelector },
        remotePools,
        flags: legacyOff ? (['allowLegacyPoolData'] as const).slice() : [],
      }
    })
    .filter((d) => d.remotePools.length || d.flags.length)
}

/** The record types the PCM's post-write `_checkLane` requires (each store's `checkLaneRecords`). */
const PCM_CHECKED_RECORD_TYPES = [
  'remotePool',
  'fee',
  'destOverhead',
  'rateLimit',
  'security',
] as const

/**
 * The PoolConfigManager's own post-write lane check (`_checkLane`), on the projection: every lane an
 * inline connection sets or a subset adds must resolve a record of each type the three stores check
 * (chainlink-ccip c950d9bc `PoolConfigManager.sol:852`; it runs even while `onlySubsetTokens` is
 * false). Returns a `RECORD_MISSING` error per missing record, so no RPC or `eth_simulateV1` is needed.
 * @internal
 */
export function multiTokenPoolPcmLaneCheck(
  after: MultiTokenPoolRecordState,
  changes: readonly MultiTokenPoolRecordChange[],
): MultiTokenPoolLaneFinding[] {
  const keys = new Map<string, MultiTokenPoolLaneKey>()
  for (const c of changes) {
    if (c.kind === 'setInline' && c.type === 'connection')
      keys.set(guardLaneKey(c.record), {
        tokenAddress: c.record.tokenAddress,
        remoteChainSelector: c.record.remoteChainSelector,
      })
    if (c.kind === 'updateSubsetTokens')
      for (const t of c.add ?? [])
        keys.set(guardLaneKey({ tokenAddress: t, remoteChainSelector: c.remoteChainSelector }), {
          tokenAddress: getAddress(t),
          remoteChainSelector: c.remoteChainSelector,
        })
  }
  return resolveMultiTokenPoolLanes(after, [...keys.values()]).flatMap((lane) =>
    PCM_CHECKED_RECORD_TYPES.filter((type) => lane.levels[type] === 'none').map(
      (type): MultiTokenPoolLaneFinding => ({
        check: 'RECORD_MISSING',
        severity: 'error',
        tokenAddress: lane.tokenAddress,
        remoteChainSelector: lane.remoteChainSelector,
        recordType: type,
        reason: `the lane resolves no ${type} record, and the PoolConfigManager checks every record after this write (_checkLane), so it reverts: write the ${type} record first (inline or through a policy)`,
      }),
    ),
  )
}

/**
 * Whether a lane's rate limits hold every outbound send: the outbound bucket is a stop, and so is
 * the fast-finality outbound bucket when it is enabled (a disabled one sends nothing faster).
 * @internal
 */
export function stopsOutbound(rateLimits: MultiTokenPoolRateLimits | null): boolean {
  if (!rateLimits) return false
  const stop = (r: RateLimitConfig) =>
    isStop({ isEnabled: r.enabled, capacity: r.capacity ?? 0n, rate: r.rate ?? 0n })
  const fast = rateLimits.fastFinalityOutbound
  return stop(rateLimits.outbound) && (!fast.enabled || stop(fast))
}
