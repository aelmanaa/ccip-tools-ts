/**
 * The options the existing Solana lane ops take on a pool-group lane, parsed without loading the
 * pool-group guard (which the ops load on first use: a lane without a marker never needs it).
 *
 * @packageDocumentation
 */

import { CCTParamsInvalidError } from '../../errors.ts'
import type { PoolGroupGuardOptions, PoolGroupLiveCheckOptions } from './write-types.ts'

/**
 * Options the extended lane ops take on a pool-group lane (ignored on a standard lane): the lane
 * check's remote reader, and the A21 drop confirmations.
 */
export type PoolGroupLaneOpOptions = PoolGroupLiveCheckOptions &
  Pick<PoolGroupGuardOptions, 'confirmDropped'>

/**
 * Set by `applyChainUpdates` on the ops it composes: the standard multi-chain flow resolves its
 * pool program once and reads nothing per chain, so it is not pool-group aware (a lane with a
 * marker refuses on chain with the program's error). @internal
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
