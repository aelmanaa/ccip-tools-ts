/**
 * getMultiTokenPoolLaneRateLimiterStates — `getCurrentRateLimiterStateBatch`: the four raw buckets
 * per lane.
 *
 * @packageDocumentation
 */

import { resultToObject } from '../../../../evm/types.ts'
import { type TokenBucket, toTokenBucket } from '../../token-pool/contracts.ts'
import {
  type MultiTokenPoolLaneKey,
  type PoolConfigManagerReader,
  toAbiLaneKey,
} from '../contracts.ts'
import { type GetMultiTokenPoolLaneBatchParams, LaneBatchQuery } from './lane-batch.ts'

/** One lane's four raw buckets, as the shared `TokenBucket`. */
export type MultiTokenPoolLaneRateLimiterState = {
  /** Outbound bucket (finality transfers, or every transfer without a fast bucket). */
  outbound: TokenBucket
  /** Inbound bucket. */
  inbound: TokenBucket
  /** Outbound faster-than-finality bucket. */
  fastFinalityOutbound: TokenBucket
  /** Inbound faster-than-finality bucket. */
  fastFinalityInbound: TokenBucket
}

/** Result of `multiTokenPoolLaneRateLimiterStates`: one entry per lane, in input order, with its key. */
export type GetMultiTokenPoolLaneRateLimiterStatesResult = (MultiTokenPoolLaneKey &
  MultiTokenPoolLaneRateLimiterState)[]

/**
 * Reads `getCurrentRateLimiterStateBatch`.
 * @remarks A pending policy change reads as a full bucket.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC)
 * @throws {@link CCTContractTypeInvalidError} if the target is not a PCM, or `poolAddress` is not
 * a multi-token pool
 */
export class GetMultiTokenPoolLaneRateLimiterStates extends LaneBatchQuery<
  GetMultiTokenPoolLaneBatchParams,
  MultiTokenPoolLaneRateLimiterState
> {
  readonly name = 'getMultiTokenPoolLaneRateLimiterStates'

  protected async readChunk(
    pcm: PoolConfigManagerReader,
    lanes: MultiTokenPoolLaneKey[],
  ): Promise<MultiTokenPoolLaneRateLimiterState[]> {
    return (await pcm.getCurrentRateLimiterStateBatch(lanes.map(toAbiLaneKey))).map((raw) => {
      const s = resultToObject(raw)
      return {
        outbound: toTokenBucket(s.outbound),
        inbound: toTokenBucket(s.inbound),
        fastFinalityOutbound: toTokenBucket(s.fastFinalityOutbound),
        fastFinalityInbound: toTokenBucket(s.fastFinalityInbound),
      }
    })
  }
}
