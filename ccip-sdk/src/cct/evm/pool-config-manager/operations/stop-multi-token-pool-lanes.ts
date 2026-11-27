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

import type { TransferDirection } from '../../../../chain.ts'
import type { EVMChain } from '../../../../evm/index.ts'
import { canonicalHash } from '../../../canonical.ts'
import {
  type MultiTokenPoolExpectedSnapshot,
  type MultiTokenPoolRateLimits,
  type MultiTokenPoolSnapshot,
  isLaneStopped,
  verifyMultiTokenPoolSnapshot,
} from '../../../multi-token-pool.ts'
import type { RateLimitConfig } from '../../../rate-limit.ts'
import {
  type MultiTokenPoolSingleFunctionOperation,
  type PoolConfigManagerRole,
  POOL_CONFIG_MANAGER_TYPE,
  getMultiTokenPoolInterface,
  multiTokenPoolFunctionOf,
  tokenRolesGate,
} from '../../multi-token-pool/contracts.ts'
import { assertUnique, validateOneOf } from '../../validate.ts'
import type { DecodedMultiTokenPoolWrite } from '../calldata.ts'
import { type MultiTokenPoolLaneKey, toAbiLaneKey, validateLaneKeys } from '../contracts.ts'
import { encodeRateLimits } from '../decode.ts'
import {
  inlineRecordOf,
  laneKey,
  rateLimitBucketOf,
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
import { inlineLanesOf, inlineRecordsSealed } from './record-writes.ts'

/**
 * Parameters of `stopMultiTokenPoolLanes`: the lanes to stop, and the direction. A stop is the
 * emergency action: it is never refused by a lane rule (it only tightens). An inline record holds all
 * four buckets, so the direction not stopped is pinned to its values at the build until the lift
 * (policy edits no longer reach the lane): on a policy lane, stop `'both'` in an incident.
 */
export type StopMultiTokenPoolLanesParams = PoolConfigManagerWriteParams &
  MultiTokenPoolExpectedSnapshot & {
    /** The lanes, at least one, each once. */
    lanes: MultiTokenPoolLaneKey[]
    /** The direction to stop (`'both'` stops all four buckets). */
    direction: PauseDirection
  }

/**
 * Parameters of `liftMultiTokenPoolLaneStops`. With `restore` (the stop's snapshot, verified by its
 * hash), the record the stop replaced comes back: it is removed when the stop created it (a lane that
 * was on a policy goes back to the policy as it is now), or set back to what it was; refused if the
 * stopped record changed since. Without it, the lift restores from chain state: a token assigned a
 * rate limit policy gets its inline record removed, so the policy applies again; otherwise
 * `rateLimits` is required. A lift without `restore` cannot tell whose stop it lifts (another
 * operator's, or an incident's): planners use `restore`. A lift never touches a direction outside
 * `direction`. Each lane the lift makes live is judged. A restore is exact in configuration, not in
 * tokens: writing a bucket's config refills it to capacity on chain (`RateLimiter`), so a drained
 * bucket the stop held comes back full.
 */
export type LiftMultiTokenPoolLaneStopsParams = StopMultiTokenPoolLanesParams &
  MultiTokenPoolWriteGuards & {
    /** The snapshot `stopMultiTokenPoolLanes` returned for these lanes. */
    restore?: MultiTokenPoolSnapshot
    /**
     * Without `restore`: the lifted direction's buckets, for a token with no rate limit policy (or to
     * override it). The other direction keeps its current buckets.
     */
    rateLimits?: MultiTokenPoolRateLimits
  }

/** The buckets of each direction (a stop holds them; a lift writes only the lifted direction's). */
const bucketsOf = (d: TransferDirection) => [
  rateLimitBucketOf(d, false),
  rateLimitBucketOf(d, true),
]
const DIRECTION_BUCKETS: Record<PauseDirection, readonly (keyof MultiTokenPoolRateLimits)[]> = {
  outbound: bucketsOf('outbound'),
  inbound: bucketsOf('inbound'),
  both: [...bucketsOf('outbound'), ...bucketsOf('inbound')],
}

const STOP: RateLimitConfig = { enabled: true, capacity: 0n, rate: 0n }

/** `rateLimits` with the direction's buckets stopped. @internal */
export function stoppedRateLimits(
  rateLimits: MultiTokenPoolRateLimits,
  direction: PauseDirection,
): MultiTokenPoolRateLimits {
  const out = structuredClone(rateLimits)
  for (const bucket of DIRECTION_BUCKETS[direction]) out[bucket] = { ...STOP }
  return out
}

/** The snapshot path the stop seals its PoolConfigManager under (a restore must match it). */
const STOP_PCM_PATH = 'stop.poolConfigManager'
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
    return tokenRolesGate('rateLimit')
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
      return { lane, rateLimits: stoppedRateLimits(rateLimits, direction) }
    })
    return { data: this.calldata(version, [], set) }
  }

  /**
   * The record each stopped lane's set replaces (absent: `null`) and the buckets it copied: what a
   * lift restores; the PCM binds the snapshot to this pool's records (another pool may name the same
   * token).
   */
  protected sealedFrom(
    _chain: EVMChain,
    decoded: DecodedMultiTokenPoolWrite,
    { address, state }: PoolConfigManagerWriteContext,
  ): Record<string, unknown> {
    const lanes = inlineLanesOf(decoded, 'rateLimit')
    const resolved = resolveMultiTokenPoolLanes(state, lanes)
    return {
      [STOP_PCM_PATH]: getAddress(address),
      ...inlineRecordsSealed(state, 'rateLimit', lanes),
      ...Object.fromEntries(lanes.map((lane, i) => [resolvedPath(lane), resolved[i]!.rateLimits])),
    }
  }
}

/**
 * Lifts lane stops: removes the inline record a stop created, or restores the buckets it replaced
 * (see {@link LiftMultiTokenPoolLaneStopsParams}). Each lane it makes live is judged, with no
 * attestations.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), `restore` is not an
 *   untouched stop snapshot of these lanes (`restore.hash`), a lane is not stopped in the direction,
 *   its stopped record changed since the stop, a lift from chain state would also lift the other
 *   direction's stop, a token with no rate limit policy is given no `rateLimits`, `sender` lacks the
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
      // values are read back out of it and written to chain: an edited snapshot is refused
      const restore = verifyMultiTokenPoolSnapshot(this.name, 'restore', params.restore)
      if (restore.operation !== 'stopMultiTokenPoolLanes')
        throw this.refuse(
          'restore',
          `is not a stopMultiTokenPoolLanes snapshot (built by ${restore.operation}): pass the snapshot the stop returned`,
        )
      parsed.lanes.forEach((lane, i) => this.#restored(restore, lane, i))
    }
    return params.rateLimits === undefined
      ? parsed
      : {
          ...parsed,
          rateLimits: parseMultiTokenPoolRateLimits(this.name, 'rateLimits', params.rateLimits),
        }
  }

  /** The record a stop replaced and the buckets it copied, parsed from its snapshot. */
  #restored(
    restore: MultiTokenPoolSnapshot,
    lane: MultiTokenPoolLaneKey,
    i: number,
  ): { prior: MultiTokenPoolRateLimits | null; copied: MultiTokenPoolRateLimits } {
    const { expected } = restore
    if (!(inlinePath(lane) in expected) || !(resolvedPath(lane) in expected))
      throw this.refuse(
        `lanes[${i}]`,
        'is not in the restore snapshot: lift only the lanes that stop covered, or give rateLimits',
      )
    const prior = expected[inlinePath(lane)]
    if (prior !== null && (typeof prior !== 'object' || Array.isArray(prior)))
      throw this.refuse(
        `restore.${inlinePath(lane)}`,
        'must be the inline rate limit record the stop replaced, or null',
      )
    return {
      prior:
        prior === null
          ? null
          : parseMultiTokenPoolRateLimits(
              this.name,
              `restore.${inlinePath(lane)}`,
              (prior as { rateLimits?: unknown }).rateLimits,
            ),
      copied: parseMultiTokenPoolRateLimits(
        this.name,
        `restore.${resolvedPath(lane)}`,
        expected[resolvedPath(lane)],
      ),
    }
  }

  protected async encode(
    _chain: EVMChain,
    { lanes, direction, restore, rateLimits }: LiftMultiTokenPoolLaneStopsParams,
    { address, version, state }: PoolConfigManagerWriteContext,
  ): Promise<PoolConfigManagerWrite> {
    // a restore is this pool's stop: the same token on another pool has other records
    if (restore && restore.expected[STOP_PCM_PATH] !== getAddress(address))
      throw this.refuse(
        'restore',
        `is a stop on PoolConfigManager ${String(restore.expected[STOP_PCM_PATH])}, not ${getAddress(address)}: pass this pool's stop snapshot`,
      )
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
        const { prior, copied } = this.#restored(restore, lane, i)
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
        else set.push({ lane, rateLimits: prior })
        return
      }
      // never touch a direction the caller did not ask to lift
      const other = direction === 'both' ? null : direction === 'outbound' ? 'inbound' : 'outbound'
      if (rateLimits) {
        // only the lifted direction's buckets come from rateLimits; the other keeps its own
        const merged = structuredClone(rateLimits)
        if (other) for (const b of DIRECTION_BUCKETS[other]) merged[b] = current.rateLimits[b]
        set.push({ lane, rateLimits: merged })
      } else if (tokenRecordsOf(state, lane.tokenAddress)?.policies.rateLimit != null) {
        if (other && isLaneStopped(current.rateLimits, other))
          throw this.refuse(
            `lanes[${i}]`,
            `is also stopped ${other}: removing its inline record would lift that direction too; lift 'both', or give rateLimits (its ${other} buckets stay as they are)`,
          )
        remove.push(lane)
      } else
        throw this.refuse(
          'rateLimits',
          `${lane.tokenAddress} has no rate limit policy to fall back to, so the lift needs the buckets: give rateLimits, or restore (the stop's snapshot)`,
        )
    })
    return { data: this.calldata(version, remove, set) }
  }

  /** Each lifted lane's stopped record, as stored: the inline record the calldata removes or sets. */
  protected sealedFrom(
    _chain: EVMChain,
    decoded: DecodedMultiTokenPoolWrite,
    { state }: PoolConfigManagerWriteContext,
  ): Record<string, unknown> {
    return inlineRecordsSealed(state, 'rateLimit', inlineLanesOf(decoded, 'rateLimit'))
  }
}
