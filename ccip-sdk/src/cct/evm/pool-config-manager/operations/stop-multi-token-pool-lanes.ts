/**
 * stopMultiTokenPoolLanes / liftMultiTokenPoolLaneStops — the EVM lane stop: the contracts have no
 * lane pause, so a stop writes an inline rate limit record whose buckets for the stopped direction
 * are enabled with no capacity and no rate (nothing passes). The other buckets are copied from the
 * lane's resolved values, so nothing else changes. The lift removes the record the stop created, or
 * restores the buckets it replaced.
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

import type { EVMChain } from '../../../../evm/index.ts'
import { canonicalHash } from '../../../canonical.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import {
  type MultiTokenPoolExpectedSnapshot,
  type MultiTokenPoolRateLimits,
  type MultiTokenPoolSnapshot,
  isLaneStopped,
} from '../../../multi-token-pool.ts'
import type { RateLimitConfig } from '../../../rate-limit.ts'
import {
  type MultiTokenPoolSingleFunctionOperation,
  type PoolConfigManagerRole,
  POOL_CONFIG_MANAGER_TYPE,
  TOKEN_POLICY_ROLES,
  getMultiTokenPoolInterface,
  multiTokenPoolFunctionOf,
} from '../../multi-token-pool/contracts.ts'
import { assertUnique, validateOneOf } from '../../validate.ts'
import { type MultiTokenPoolLaneKey, toAbiLaneKey, validateLaneKeys } from '../contracts.ts'
import { encodeRateLimits } from '../decode.ts'
import {
  inlineRecordOf,
  laneKey,
  resolveMultiTokenPoolLanes,
  tokenRecordsOf,
} from '../projection.ts'
import { parseMultiTokenPoolRateLimits } from '../record-values.ts'
import { type PauseDirection, PAUSE_DIRECTIONS } from '../records.ts'
import {
  type MultiTokenPoolWriteGuards,
  type PoolConfigManagerWrite,
  type PoolConfigManagerWriteContext,
  type PoolConfigManagerWriteParams,
  PoolConfigManagerWriteOperation,
} from '../write-operation.ts'

/**
 * Parameters of `stopMultiTokenPoolLanes`: the lanes to stop, and the direction. A stop is the
 * emergency action: it is never refused by a lane rule (it only tightens).
 */
export type StopMultiTokenPoolLanesParams = PoolConfigManagerWriteParams &
  MultiTokenPoolExpectedSnapshot & {
    /** The lanes, at least one, each once. */
    lanes: MultiTokenPoolLaneKey[]
    /** The direction to stop (`'both'` stops all four buckets). */
    direction: PauseDirection
  }

/**
 * Parameters of `liftMultiTokenPoolLaneStops`. With `restore` (the stop's snapshot), the exact
 * buckets come back: the record is removed when the stop created it, or set back to what it
 * replaced; refused if the stopped record changed since. Without it, the lift restores from chain
 * state: a token assigned a rate limit policy gets its inline record removed, so the policy applies
 * again; otherwise `rateLimits` is required. Each lane the lift makes live is judged.
 */
export type LiftMultiTokenPoolLaneStopsParams = StopMultiTokenPoolLanesParams &
  MultiTokenPoolWriteGuards & {
    /** The snapshot `stopMultiTokenPoolLanes` returned for these lanes. */
    restore?: MultiTokenPoolSnapshot
    /** The buckets to set, without `restore`, for a token with no rate limit policy (or to override it). */
    rateLimits?: MultiTokenPoolRateLimits
  }

/** The two buckets of each direction a stop holds. */
const STOPPED_BUCKETS = {
  outbound: ['outbound', 'fastFinalityOutbound'],
  inbound: ['inbound', 'fastFinalityInbound'],
  both: ['outbound', 'fastFinalityOutbound', 'inbound', 'fastFinalityInbound'],
} as const satisfies Record<PauseDirection, readonly (keyof MultiTokenPoolRateLimits)[]>

const STOP: RateLimitConfig = { enabled: true, capacity: 0n, rate: 0n }

/** `rateLimits` with the direction's buckets stopped. @internal */
export function stoppedRateLimits(
  rateLimits: MultiTokenPoolRateLimits,
  direction: PauseDirection,
): MultiTokenPoolRateLimits {
  const out = structuredClone(rateLimits)
  for (const bucket of STOPPED_BUCKETS[direction]) out[bucket] = { ...STOP }
  return out
}

/** The snapshot path of a lane's inline rate limit record (absent: `null`). */
const inlinePath = (l: MultiTokenPoolLaneKey) =>
  `inline.rateLimit.${laneKey(l.tokenAddress, l.remoteChainSelector)}`
/** The snapshot path of a lane's resolved rate limits before a stop. */
const resolvedPath = (l: MultiTokenPoolLaneKey) =>
  `lanes.rateLimit.${laneKey(l.tokenAddress, l.remoteChainSelector)}`

/** The inline rate limit record struct for a lane. */
const encodeRecord = (l: MultiTokenPoolLaneKey, rateLimits: MultiTokenPoolRateLimits) => ({
  localToken: getAddress(l.tokenAddress),
  remoteChainSelector: l.remoteChainSelector,
  rateLimitConfig: encodeRateLimits(rateLimits),
})

/** The shared validation, gate and refusal context of the stop and the lift. */
abstract class LaneStopWriteOperation<
  P extends StopMultiTokenPoolLanesParams,
> extends PoolConfigManagerWriteOperation<P> {
  /** The op; its PCM function comes from the op map. */
  abstract override readonly name: MultiTokenPoolSingleFunctionOperation

  /** Validates the lanes (each once, checksummed) and the direction, before any RPC. */
  protected override prepare(params: P): P {
    super.prepare(params)
    validateLaneKeys(this.name, 'lanes', params.lanes)
    assertUnique(
      this.name,
      'lanes',
      params.lanes,
      (l) => laneKey(l.tokenAddress, l.remoteChainSelector),
      'lane',
    )
    validateOneOf(this.name, 'direction', params.direction, PAUSE_DIRECTIONS)
    return {
      ...params,
      lanes: params.lanes.map((l) => ({
        tokenAddress: getAddress(l.tokenAddress),
        remoteChainSelector: l.remoteChainSelector,
      })),
    }
  }

  protected gate(): readonly PoolConfigManagerRole[] {
    return ['CONFIG_ROLE', 'TOKEN_MANAGER_ROLE', TOKEN_POLICY_ROLES.rateLimit]
  }

  protected override errorContext(): Record<string, unknown> {
    return { recordType: 'rateLimit' }
  }

  /** The calldata: inline rate limit records removed, then set. */
  protected calldata(
    version: PoolConfigManagerWriteContext['version'],
    remove: MultiTokenPoolLaneKey[],
    set: { lane: MultiTokenPoolLaneKey; rateLimits: MultiTokenPoolRateLimits }[],
  ): string {
    return getMultiTokenPoolInterface(POOL_CONFIG_MANAGER_TYPE, version).encodeFunctionData(
      multiTokenPoolFunctionOf(this.name),
      [remove.map(toAbiLaneKey), set.map((s) => encodeRecord(s.lane, s.rateLimits))],
    )
  }

  /** A refusal at `lanes[i]`, with the record type. */
  protected refuse(param: string, reason: string): CCTParamsInvalidError {
    return new CCTParamsInvalidError(this.name, param, reason, {
      context: { recordType: 'rateLimit' },
    })
  }
}

/**
 * Stops lanes: writes an inline rate limit record with the direction's buckets stopped (enabled,
 * 0/0), the other buckets copied from the lane's resolved values. The lane leaves its rate limit
 * policy until {@link LiftMultiTokenPoolLaneStops}. The snapshot records the record it replaced (or
 * that there was none) and the resolved buckets, which is what `restore` reads back.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), a token is not
 *   registered, a lane resolves no rate limit (no connection, or no record), a lane is already
 *   stopped in the direction, or `sender` lacks the gate; `context.recordType` is `'rateLimit'`
 */
export class StopMultiTokenPoolLanes extends LaneStopWriteOperation<StopMultiTokenPoolLanesParams> {
  readonly name = 'stopMultiTokenPoolLanes'

  protected async encode(
    _chain: EVMChain,
    { lanes, direction }: StopMultiTokenPoolLanesParams,
    { version, state }: PoolConfigManagerWriteContext,
  ): Promise<PoolConfigManagerWrite> {
    const resolved = resolveMultiTokenPoolLanes(state, lanes)
    const set = lanes.map((lane, i) => {
      if (!tokenRecordsOf(state, lane.tokenAddress)?.profile?.isRegistered)
        throw this.refuse(
          `lanes[${i}].tokenAddress`,
          `${lane.tokenAddress} is not registered (LocalTokenNotRegistered): it has no lane to stop`,
        )
      const rateLimits = resolved[i]!.rateLimits
      if (!rateLimits)
        throw this.refuse(
          `lanes[${i}]`,
          `no rate limit resolves for ${lane.tokenAddress} → ${lane.remoteChainSelector} (no connection, or no rate limit record): there is no lane to stop`,
        )
      if (isLaneStopped(rateLimits, direction))
        throw this.refuse(
          `lanes[${i}]`,
          `is already stopped ${direction}: nothing to do (lift it with liftMultiTokenPoolLaneStops)`,
        )
      return { lane, rateLimits: stoppedRateLimits(rateLimits, direction), before: rateLimits }
    })
    // the record each stop replaces (absent: `null`) and the buckets it copied: what a lift restores
    const expected = Object.fromEntries(
      set.flatMap(({ lane, before }) => [
        [inlinePath(lane), inlineRecordOf(state, 'rateLimit', lane) ?? null],
        [resolvedPath(lane), before],
      ]),
    )
    return { data: this.calldata(version, [], set), expected }
  }
}

/**
 * Lifts lane stops: removes the inline record a stop created, or restores the buckets it replaced
 * (see {@link LiftMultiTokenPoolLaneStopsParams}). Each lane it makes live is judged, with no
 * attestations.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), `restore` is not a
 *   stop snapshot of these lanes, a lane is not stopped in the direction, its stopped record changed
 *   since the stop, a token with no rate limit policy is given no `rateLimits`, `sender` lacks the
 *   gate, or a lane guard refuses a lane the lift loosens; `context.recordType` is `'rateLimit'`
 */
export class LiftMultiTokenPoolLaneStops extends LaneStopWriteOperation<LiftMultiTokenPoolLaneStopsParams> {
  readonly name = 'liftMultiTokenPoolLaneStops'

  /** Also validates `restore` (a stop's snapshot) or `rateLimits`, never both. */
  protected override prepare(
    params: LiftMultiTokenPoolLaneStopsParams,
  ): LiftMultiTokenPoolLaneStopsParams {
    const parsed = super.prepare(params)
    if (params.restore !== undefined && params.rateLimits !== undefined)
      throw this.refuse('rateLimits', 'give restore or rateLimits, not both')
    if (params.restore !== undefined) {
      // a snapshot from JSON or another op: check its shape at run time
      const { operation, expected } = params.restore as { operation?: unknown; expected?: unknown }
      if (operation !== 'stopMultiTokenPoolLanes' || typeof expected !== 'object' || !expected)
        throw this.refuse(
          'restore',
          `is not a stopMultiTokenPoolLanes snapshot (built by ${String(operation)}): pass the snapshot the stop returned`,
        )
      parsed.lanes.forEach((lane, i) => {
        if (!(inlinePath(lane) in expected) || !(resolvedPath(lane) in expected))
          throw this.refuse(
            `lanes[${i}]`,
            'is not in the restore snapshot: lift only the lanes that stop covered, or give rateLimits',
          )
      })
    }
    return params.rateLimits === undefined
      ? parsed
      : {
          ...parsed,
          rateLimits: parseMultiTokenPoolRateLimits(this.name, 'rateLimits', params.rateLimits),
        }
  }

  // the lift makes its lanes live: no attestations
  protected override makesLive(): boolean {
    return true
  }

  protected async encode(
    _chain: EVMChain,
    { lanes, direction, restore, rateLimits }: LiftMultiTokenPoolLaneStopsParams,
    { version, state }: PoolConfigManagerWriteContext,
  ): Promise<PoolConfigManagerWrite> {
    const remove: MultiTokenPoolLaneKey[] = []
    const set: { lane: MultiTokenPoolLaneKey; rateLimits: MultiTokenPoolRateLimits }[] = []
    lanes.forEach((lane, i) => {
      const current = inlineRecordOf(state, 'rateLimit', lane)
      if (!current || !isLaneStopped(current.rateLimits, direction))
        throw this.refuse(
          `lanes[${i}]`,
          `is not stopped ${direction}${current ? '' : ' (it has no inline rate limit record)'}: nothing to lift`,
        )
      if (restore) {
        const prior = restore.expected[inlinePath(lane)] as {
          rateLimits: MultiTokenPoolRateLimits
        } | null
        const copied = restore.expected[resolvedPath(lane)] as MultiTokenPoolRateLimits
        // the record the stop wrote must still be there: anything since was someone else's write
        if (
          canonicalHash([current.rateLimits]) !==
          canonicalHash([stoppedRateLimits(copied, direction)])
        )
          throw this.refuse(
            `lanes[${i}]`,
            `its rate limit record changed since the stop (or the stop was not ${direction}), so restoring would undo that change: lift it with rateLimits, or from chain state`,
          )
        if (prior === null) remove.push(lane)
        else set.push({ lane, rateLimits: prior.rateLimits })
        return
      }
      if (rateLimits) set.push({ lane, rateLimits })
      else if (tokenRecordsOf(state, lane.tokenAddress)?.policies.rateLimit != null)
        remove.push(lane)
      else
        throw this.refuse(
          'rateLimits',
          `${lane.tokenAddress} has no rate limit policy to fall back to, so the lift needs the buckets: give rateLimits, or restore (the stop's snapshot)`,
        )
    })
    // the values the write replaces: each lane's stopped record
    const expected = Object.fromEntries(
      lanes.map((lane) => [inlinePath(lane), inlineRecordOf(state, 'rateLimit', lane) ?? null]),
    )
    return { data: this.calldata(version, remove, set), expected }
  }
}
