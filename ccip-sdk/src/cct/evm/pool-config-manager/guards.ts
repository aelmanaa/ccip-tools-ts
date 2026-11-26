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

import type { LaneRecordType } from '../../../chain.ts'
import { LANE_RECORD_TYPES } from '../../../evm/multi-token-pool.ts'
import {
  type MultiTokenPoolLaneFinding,
  type MultiTokenPoolRemoteAttestation,
  sortFindings,
} from '../../multi-token-pool.ts'
import { type MultiTokenPoolLaneKey, encodePolicyName } from './contracts.ts'
import {
  type MultiTokenPoolRecordState,
  type ProjectedMultiTokenPoolLane,
  multiTokenPoolSupportedChains,
  resolveMultiTokenPoolLanes,
} from './projection.ts'

/** Default {@link MultiTokenPoolGuardOptions.maxTransferFeeBps} (the token fee cap). @internal */
export const DEFAULT_MAX_TRANSFER_FEE_BPS = 1_000
/** Default {@link MultiTokenPoolGuardOptions.minDestGasOverhead} (destination gas). @internal */
export const DEFAULT_MIN_DEST_GAS_OVERHEAD = 200_000
/** Gas a resolved hook adds to the default minimum destination gas. @internal */
export const HOOK_DEST_GAS_OVERHEAD = 100_000
/** Long pool data without additional data: decimals, source token and two offsets/lengths. @internal */
export const LONG_POOL_DATA_BYTES = 192
/** Legacy pool data: the decimals word. @internal */
export const LEGACY_POOL_DATA_BYTES = 32

/** The guard options a write takes (thresholds and confirmations, never switches). @internal */
export type MultiTokenPoolGuardOptions = {
  /** Accept non-empty CCV lists without the default-CCV placeholder `address(0)`. */
  allowDroppingDefaultCCVs?: boolean
  /** Highest resolved transfer fee in bps, both tiers. */
  maxTransferFeeBps?: number
  /** Lowest resolved `destGasOverhead`. */
  minDestGasOverhead?: number
  /** Lanes the caller agrees this write closes. */
  confirmClosing?: MultiTokenPoolLaneKey[]
  /** Remote chains where a lane may accept legacy pool data from a remote multi-token pool. */
  migrationWindowChains?: bigint[]
}

/** A remote fact: read, absent on the remote chain, or unreadable. @internal */
export type MultiTokenPoolRemoteFact<T> =
  | ({ status: 'known' } & T)
  | {
      /** `'missing'`: the remote side lacks it; `'unknown'`: the SDK cannot read that chain. */
      status: 'missing' | 'unknown'
      /** What is missing or why it cannot be read. */
      reason: string
    }

/** What the remote side of one lane does. @internal */
export type MultiTokenPoolRemoteLaneFacts = MultiTokenPoolRemoteFact<{
  /** Whether the remote pool the remote registry names reads long pool data. */
  readsLongData: boolean
  /** The pool the remote registry names for the remote token, or `null` when it names none. */
  registryPool: string | null
  /** Whether that pool's lane back points at this token and trusts a local serving pool. */
  mapsBack: boolean
  /** Whether the remote token has code on the remote chain (read when the registry names no pool). */
  remoteTokenHasCode?: boolean
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
  `${getAddress(tokenAddress)}:${remoteChainSelector}`
/** The remote pool key the facts maps use. @internal */
export const guardPoolKey = (remoteChainSelector: bigint, address: string) =>
  `${remoteChainSelector}:${address}`

/** Every (token, chain) a state names, for the lanes a write could reach. */
function candidateLanes(states: readonly MultiTokenPoolRecordState[]): MultiTokenPoolLaneKey[] {
  const tokens = new Set<string>()
  const chains = new Set<bigint>()
  for (const s of states) {
    for (const t of s.tokens) {
      tokens.add(getAddress(t.tokenAddress))
      for (const type of LANE_RECORD_TYPES)
        for (const r of t.inline[type]) chains.add(r.remoteChainSelector)
    }
    for (const type of LANE_RECORD_TYPES)
      for (const r of s.policies[type]) if (r.remoteChainSelector) chains.add(r.remoteChainSelector)
  }
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
  return canonicalEqual(norm(a), norm(b))
}

function canonicalEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined)
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined)
  return (
    ka.length === kb.length &&
    ka.every((k) =>
      canonicalEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    )
  )
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

/** Bytes of long pool data with `extra` bytes of additional data (ABI-padded to 32). @internal */
export function longPoolDataBytes(extra: number): number {
  return LONG_POOL_DATA_BYTES + Math.ceil(extra / 32) * 32
}

/** A rule's failure to read a fact: the framework throws it as `CCTParamsInvalidError`. @internal */
export type MultiTokenPoolGuardFactFailure = MultiTokenPoolLaneKey & {
  /** `'missing'` or `'unknown'`. */
  status: 'missing' | 'unknown'
  /** What could not be read. */
  reason: string
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
        add('LANE_CLOSED', 'warning', 'the write closes this lane (confirmed in confirmClosing)')
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
        `remote token ${c.remoteToken} is also the remote token of ${shared.map((o) => o.tokenAddress).join(', ')} on this chain`,
        'connection',
      )

    // legacy data received from a remote multi-token pool cannot identify the source token
    for (const p of c.remotePools) {
      if (!p.allowLegacyPoolData || migration.has(lane.remoteChainSelector)) continue
      const pool = facts.remotePools.get(guardPoolKey(lane.remoteChainSelector, p.address))
      if (!pool || pool.status !== 'known') {
        factFailures.push({
          ...key,
          status: pool?.status ?? 'unknown',
          reason: pool?.status ? pool.reason : `remote pool ${p.address} was not read`,
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
    const remote = facts.remoteLanes.get(guardLaneKey(key))
    if (!remote || remote.status !== 'known') {
      factFailures.push({
        ...key,
        status: remote?.status ?? 'unknown',
        reason: remote?.status ? remote.reason : 'the remote side of this lane was not read',
      })
      continue
    }
    if (remote.attestation)
      add(
        'REMOTE_ATTESTED',
        'warning',
        `the remote long-data fact comes from an attestation, not a read: ${remote.attestation.reason}`,
      )
    // a token paused outbound whose remote registry names no pool yet may wait (the MTTP spec's
    // onboarding exception);
    // the unpause re-check runs with no exception
    const waiting = c.isTokenOutboundPaused && remote.registryPool === null
    if (remote.registryPool === null) {
      if (!waiting)
        add(
          'NO_REMOTE_POOL',
          'error',
          `the remote registry names no pool for ${c.remoteToken}${remote.remoteTokenHasCode === false ? ', which has no code on the remote chain' : ''}: a send burns here and nothing releases it there; register the remote side first, or keep the token paused outbound`,
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
    if (c.poolDataFormat === 'legacy' && !remote.mapsBack)
      add(
        'REMOTE_LANE_MISMATCH',
        'error',
        'the lane sends legacy pool data (no source token), but the remote lane back does not point at this token and a serving pool: the destination cannot tell which token was sent',
        'connection',
      )
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
  const word = encodePolicyName('evaluateMultiTokenPoolGuards', 'policyName', name).toLowerCase()
  const count = state.tokens.filter((t) => {
    const p = t.policies[type]
    return (
      p !== null &&
      encodePolicyName('evaluateMultiTokenPoolGuards', 'policyName', p).toLowerCase() === word
    )
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
