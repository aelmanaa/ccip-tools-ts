/**
 * applyMultiTokenPoolRateLimitPolicyBucketUpdates — writes single buckets of existing rate limit
 * policy records.
 *
 * @packageDocumentation
 */

import { type PoolConfigManagerRole, policyRolesGate } from '../../multi-token-pool/contracts.ts'
import { encodePolicyName, validatePolicyRecordKey } from '../contracts.ts'
import { type MultiTokenPoolRecordState, policyRecordOf, recordKey } from '../projection.ts'
import type { MultiTokenPoolRateLimits, RateLimitPolicyBucketUpdate } from '../records.ts'
import {
  type RateLimitBucketWriteParams,
  RateLimitBucketWriteOperation,
} from './rate-limit-bucket-writes.ts'

/** Parameters of `applyMultiTokenPoolRateLimitPolicyBucketUpdates`. */
export type ApplyMultiTokenPoolRateLimitPolicyBucketUpdatesParams =
  RateLimitBucketWriteParams<RateLimitPolicyBucketUpdate>

/**
 * Writes single buckets of existing rate limit policy records, keeping the other buckets. Every token
 * on the policy follows the new bucket. A bucket enabled with no capacity and no rate stops its
 * direction; the lane rules judge only the lanes a bucket loosens (a stop lifted, a bucket disabled,
 * more capacity or rate): a write that only tightens or stops is never refused by a lane rule, so a
 * broken lane can always be clamped.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), the record does not
 *   exist, `sender` lacks the gate, or a lane guard refuses a loosened lane; `context.recordType` is
 *   `'rateLimit'`
 */
export class ApplyMultiTokenPoolRateLimitPolicyBucketUpdates extends RateLimitBucketWriteOperation<RateLimitPolicyBucketUpdate> {
  readonly name = 'applyMultiTokenPoolRateLimitPolicyBucketUpdates'
  protected readonly pathPrefix = 'policies.rateLimit'

  protected validateKey(u: RateLimitPolicyBucketUpdate, at: string): void {
    validatePolicyRecordKey(this.name, at, u)
  }

  protected keyOf(u: RateLimitPolicyBucketUpdate): string {
    return recordKey(u.policyName, u.remoteChainSelector)
  }

  protected rateLimitsOf(
    state: MultiTokenPoolRecordState,
    u: RateLimitPolicyBucketUpdate,
  ): MultiTokenPoolRateLimits | undefined {
    return policyRecordOf(state, 'rateLimit', u)?.rateLimits
  }

  protected missingRecord(u: RateLimitPolicyBucketUpdate): string {
    return `rate limit policy ${u.policyName} has no record for chain ${u.remoteChainSelector} (PolicyRecordNotFound): set the whole record with applyMultiTokenPoolRateLimitPolicyConfigUpdates first`
  }

  protected abiKey(u: RateLimitPolicyBucketUpdate): Record<string, unknown> {
    return { policyName: encodePolicyName(this.name, 'policyName', u.policyName) }
  }

  protected gate(): readonly PoolConfigManagerRole[] {
    return policyRolesGate('rateLimit')
  }
}
