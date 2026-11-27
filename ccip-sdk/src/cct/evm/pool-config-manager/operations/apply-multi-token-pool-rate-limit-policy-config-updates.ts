/**
 * applyMultiTokenPoolRateLimitPolicyConfigUpdates — sets and removes rate limit policy records, and removes whole rate limit
 * policies.
 *
 * @packageDocumentation
 */

import type { EVMChain } from '../../../../evm/index.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { validateUint8 } from '../../validate.ts'
import { encodeRateLimits } from '../decode.ts'
import { policyKey } from '../projection.ts'
import { parseMultiTokenPoolRateLimits } from '../record-values.ts'
import type { PolicyRecordKey, PolicyRemovalOptions, RateLimitPolicyRecord } from '../records.ts'
import type { MultiTokenPoolWriteGuards, PoolConfigManagerWriteParams } from '../write-operation.ts'
import { type RecordWriteContext, PolicyRecordWriteOperation } from './record-writes.ts'

/** Parameters of `applyMultiTokenPoolRateLimitPolicyConfigUpdates`. Records are removed, then policies, then records set. */
export type ApplyMultiTokenPoolRateLimitPolicyConfigUpdatesParams = PoolConfigManagerWriteParams &
  MultiTokenPoolWriteGuards &
  PolicyRemovalOptions & {
    /** Records to remove (first, as on chain); `remoteChainSelector: 0n` is the policy's default. */
    recordsToRemove?: PolicyRecordKey[]
    /** Records to set; a set replaces the record. */
    recordsToSet?: RateLimitPolicyRecord[]
  }

/**
 * Writes rate limit policy records. A record changes every lane of every token of the policy on its
 * chain (or, for the default record, on every chain without its own record).
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), the store would refuse
 *   (a missing record or policy, a policy in use or with records left), `sender` lacks the gate, or a
 *   lane guard refuses a lane the write loosens (one it only tightens or stops is never refused);
 *   `context.recordType` is `'rateLimit'`
 */
export class ApplyMultiTokenPoolRateLimitPolicyConfigUpdates extends PolicyRecordWriteOperation<
  RateLimitPolicyRecord,
  ApplyMultiTokenPoolRateLimitPolicyConfigUpdatesParams
> {
  readonly name = 'applyMultiTokenPoolRateLimitPolicyConfigUpdates'
  protected readonly recordType = 'rateLimit'
  protected readonly allowDefault = true

  protected parseRecord(
    _params: ApplyMultiTokenPoolRateLimitPolicyConfigUpdatesParams,
    record: RateLimitPolicyRecord,
    at: string,
  ): RateLimitPolicyRecord {
    validateUint8(this.name, `${at}.localDecimals`, record.localDecimals)
    return {
      ...record,
      rateLimits: parseMultiTokenPoolRateLimits(this.name, `${at}.rateLimits`, record.rateLimits),
    }
  }

  protected encodeRecord(record: RateLimitPolicyRecord, word: string): unknown {
    return [
      word,
      record.remoteChainSelector,
      record.localDecimals,
      encodeRateLimits(record.rateLimits),
    ]
  }

  /**
   * A policy's decimals are fixed by its first record: a record for an existing policy must repeat
   * them (`InvalidRateLimitPolicyDecimals`); its limits are raw amounts in those token units.
   */
  protected override async checkState(
    chain: EVMChain,
    {
      recordsToSet = [],
      policiesToRemove = [],
    }: ApplyMultiTokenPoolRateLimitPolicyConfigUpdatesParams,
    { policyNames, rateLimitPolicyDecimals }: RecordWriteContext,
  ): Promise<void> {
    const names = policyNames.rateLimit
    const removed = new Set(policiesToRemove.map((n) => policyKey(n, 'policyName')))
    for (const [i, r] of recordsToSet.entries()) {
      const word = policyKey(r.policyName, `recordsToSet[${i}].policyName`)
      // a new policy (or one this call removes first) takes the record's decimals
      if (!names.has(word) || removed.has(word)) continue
      // the stored decimals, from the build's one state read
      const decimals = rateLimitPolicyDecimals.get(word)
      if (decimals !== undefined && decimals !== r.localDecimals)
        throw new CCTParamsInvalidError(
          this.name,
          `recordsToSet[${i}].localDecimals`,
          `is ${r.localDecimals}, but rate limit policy ${r.policyName} has ${decimals} decimals (InvalidRateLimitPolicyDecimals): its limits are raw amounts in those units; use the policy's decimals, or another policy`,
          { context: { recordType: 'rateLimit' } },
        )
    }
  }
}
