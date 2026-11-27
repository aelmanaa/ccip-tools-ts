/**
 * The options the existing Solana lane ops take on a pool-group lane, parsed without loading the
 * pool-group guard (which the ops load on first use: a lane without a marker never needs it).
 *
 * @packageDocumentation
 */

import { CCTParamsInvalidError } from '../../errors.ts'
import type { MultiTokenPoolLaneFinding, MultiTokenPoolSnapshot } from '../../multi-token-pool.ts'
import type { PoolGroupLaneKey } from './types.ts'
import type { PoolGroupGuardOptions, PoolGroupLiveCheckOptions } from './write-types.ts'

/** What an extended lane op reports on a pool-group lane (absent on a standard lane). */
export type PoolGroupLaneOpReport = {
  /** The guard's warnings on the lane (errors refuse the write). */
  findings: MultiTokenPoolLaneFinding[]
  /** Lanes the write makes live (each passed the lane check). */
  goingLive: PoolGroupLaneKey[]
  /**
   * The judgement as evidence: the slot, the hash of the lane accounts the guard read
   * (`guardInputsHash`) and of the instruction (`calldataHash`). `checkPoolGroupSnapshot` cannot
   * re-check it (no re-check is registered for the extended lane ops, so it refuses the snapshot):
   * a delayed proposal of an extended op has no SDK re-check; rebuild it right before execution.
   */
  snapshot?: MultiTokenPoolSnapshot
}

/** The result field the extended lane ops add on a pool-group lane. */
export type PoolGroupLaneOpResult = {
  /** The pool-group guard's report; absent on a standard lane. */
  poolGroup?: PoolGroupLaneOpReport
}

/**
 * Options the extended lane ops take on a pool-group lane (ignored on a standard lane): the lane
 * check's remote reader, and the A21 drop confirmations.
 */
export type PoolGroupLaneOpOptions = PoolGroupLiveCheckOptions &
  Pick<PoolGroupGuardOptions, 'confirmDropped'>

/**
 * Set by `applyChainUpdates` on the ops it composes. Skipping the gate is safe because every
 * instruction it composes fails on chain for a lane with a pool-group marker:
 * `init_chain_remote_config` refuses an existing `ChainConfig`, and `delete_chain_config` refuses a
 * marked lane (`LaneLinked`, delete_chain_config.rs:20). The error is then the program's, not a
 * named SDK refusal. @internal
 */
export const SKIP_POOL_GROUP_GATE = Symbol('skipPoolGroupGate')

/** The parsed {@link PoolGroupLaneOpOptions}; `confirmDropped` is sealed by the guard. @internal */
export type ParsedLaneOpOptions = PoolGroupLaneOpOptions & {
  /** The composing op skips the gate ({@link SKIP_POOL_GROUP_GATE}). */
  skip?: true
}

/**
 * Checks the pool-group options of an extended lane op before any RPC.
 * @throws {@link CCTParamsInvalidError} if one is malformed
 * @internal
 */
export function parseLaneOpOptions(
  operation: string,
  params: PoolGroupLaneOpOptions,
): ParsedLaneOpOptions {
  const { getChain, concurrency, confirmDropped } = params
  if (getChain !== undefined && typeof getChain !== 'function')
    throw new CCTParamsInvalidError(operation, 'getChain', 'must be a function')
  if (
    concurrency !== undefined &&
    (typeof concurrency !== 'number' || !Number.isInteger(concurrency) || concurrency < 1)
  )
    throw new CCTParamsInvalidError(operation, 'concurrency', 'must be a positive integer')
  if (confirmDropped !== undefined && !Array.isArray(confirmDropped))
    throw new CCTParamsInvalidError(operation, 'confirmDropped', 'must be an array')
  return {
    ...(Reflect.get(params, SKIP_POOL_GROUP_GATE) === true && { skip: true as const }),
    ...(getChain && { getChain }),
    ...(concurrency !== undefined && { concurrency }),
    ...(confirmDropped && { confirmDropped }),
  }
}
