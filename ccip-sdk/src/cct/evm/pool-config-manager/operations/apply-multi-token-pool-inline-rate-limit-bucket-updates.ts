/**
 * applyMultiTokenPoolInlineRateLimitBucketUpdates — writes single buckets of existing inline rate
 * limit records.
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

import { type PoolConfigManagerRole, tokenRolesGate } from '../../multi-token-pool/contracts.ts'
import { validateAddress, validateUint64 } from '../../validate.ts'
import { type MultiTokenPoolRecordState, inlineRecordOf, laneKey } from '../projection.ts'
import type { InlineRateLimitBucketUpdate, MultiTokenPoolRateLimits } from '../records.ts'
import {
  type RateLimitBucketWriteParams,
  RateLimitBucketWriteOperation,
} from './rate-limit-bucket-writes.ts'

/** Parameters of `applyMultiTokenPoolInlineRateLimitBucketUpdates`. */
export type ApplyMultiTokenPoolInlineRateLimitBucketUpdatesParams =
  RateLimitBucketWriteParams<InlineRateLimitBucketUpdate>

/**
 * Writes single buckets of existing inline rate limit records, keeping the other buckets. A bucket
 * enabled with no capacity and no rate stops its direction (see `stopMultiTokenPoolLanes`); the lane
 * rules judge only the lanes a bucket loosens (a stop lifted, a bucket disabled, more capacity or
 * rate): a write that only tightens or stops is never refused by a lane rule, so a broken lane can
 * always be clamped.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), the record does not
 *   exist, `sender` lacks the gate, or a lane guard refuses a loosened lane; `context.recordType` is
 *   `'rateLimit'`
 */
export class ApplyMultiTokenPoolInlineRateLimitBucketUpdates extends RateLimitBucketWriteOperation<InlineRateLimitBucketUpdate> {
  readonly name = 'applyMultiTokenPoolInlineRateLimitBucketUpdates'
  protected readonly pathPrefix = 'inline.rateLimit'

  protected validateKey(u: InlineRateLimitBucketUpdate, at: string): void {
    validateAddress(this.name, `${at}.tokenAddress`, u.tokenAddress)
    validateUint64(this.name, `${at}.remoteChainSelector`, u.remoteChainSelector)
  }

  protected keyOf(u: InlineRateLimitBucketUpdate): string {
    return laneKey(u.tokenAddress, u.remoteChainSelector)
  }

  protected rateLimitsOf(
    state: MultiTokenPoolRecordState,
    u: InlineRateLimitBucketUpdate,
  ): MultiTokenPoolRateLimits | undefined {
    return inlineRecordOf(state, 'rateLimit', u)?.rateLimits
  }

  protected missingRecord(u: InlineRateLimitBucketUpdate): string {
    return `${getAddress(u.tokenAddress)} has no inline rate limit record for chain ${u.remoteChainSelector} (InlineRecordNotFound): set the whole record with applyMultiTokenPoolInlineRateLimitConfigUpdates first`
  }

  protected abiKey(u: InlineRateLimitBucketUpdate): Record<string, unknown> {
    return { localToken: getAddress(u.tokenAddress) }
  }

  protected gate(): readonly PoolConfigManagerRole[] {
    return tokenRolesGate('rateLimit')
  }
}
