/**
 * applyMultiTokenPoolInlineRateLimitConfigUpdates — sets and removes inline rate limit records.
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

import type { MultiTokenPoolLaneKey } from '../contracts.ts'
import { encodeRateLimits } from '../decode.ts'
import { parseMultiTokenPoolRateLimits } from '../record-values.ts'
import type { InlineRateLimitConfig } from '../records.ts'
import type { MultiTokenPoolWriteGuards, PoolConfigManagerWriteParams } from '../write-operation.ts'
import { InlineRecordWriteOperation } from './record-writes.ts'

/** Parameters of `applyMultiTokenPoolInlineRateLimitConfigUpdates`. Removals run first. */
export type ApplyMultiTokenPoolInlineRateLimitConfigUpdatesParams = PoolConfigManagerWriteParams &
  MultiTokenPoolWriteGuards & {
    /** Lanes whose inline rate limit record to remove; the lane falls back to its rate limit policy. */
    remove?: MultiTokenPoolLaneKey[]
    /** Records to set; a set replaces the lane's record. */
    set?: InlineRateLimitConfig[]
  }

/**
 * Writes inline rate limit records.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), the store would refuse
 *   (no inline record, an unregistered token), `sender` lacks the gate, or a lane guard refuses a lane the write loosens (one it only tightens or stops is never refused);
 *   `context.recordType` is `'rateLimit'`
 */
export class ApplyMultiTokenPoolInlineRateLimitConfigUpdates extends InlineRecordWriteOperation<
  InlineRateLimitConfig,
  ApplyMultiTokenPoolInlineRateLimitConfigUpdatesParams
> {
  readonly name = 'applyMultiTokenPoolInlineRateLimitConfigUpdates'
  protected readonly recordType = 'rateLimit'

  protected parseRecord(
    _params: ApplyMultiTokenPoolInlineRateLimitConfigUpdatesParams,
    record: InlineRateLimitConfig,
    at: string,
  ): InlineRateLimitConfig {
    return {
      ...record,
      rateLimits: parseMultiTokenPoolRateLimits(this.name, `${at}.rateLimits`, record.rateLimits),
    }
  }

  protected encodeRecord(record: InlineRateLimitConfig): unknown {
    return {
      localToken: getAddress(record.tokenAddress),
      remoteChainSelector: record.remoteChainSelector,
      rateLimitConfig: encodeRateLimits(record.rateLimits),
    }
  }
}
