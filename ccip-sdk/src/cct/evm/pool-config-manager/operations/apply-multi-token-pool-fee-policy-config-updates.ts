/**
 * applyMultiTokenPoolFeePolicyConfigUpdates — sets and removes fee policy records, and removes whole fee
 * policies.
 *
 * @packageDocumentation
 */

import { parseMultiTokenPoolFeeConfig } from '../record-values.ts'
import type { FeePolicyRecord, PolicyRecordKey, PolicyRemovalOptions } from '../records.ts'
import type { MultiTokenPoolWriteGuards, PoolConfigManagerWriteParams } from '../write-operation.ts'
import { PolicyRecordWriteOperation } from './record-writes.ts'

/** Parameters of `applyMultiTokenPoolFeePolicyConfigUpdates`. Records are removed, then policies, then records set. */
export type ApplyMultiTokenPoolFeePolicyConfigUpdatesParams = PoolConfigManagerWriteParams &
  MultiTokenPoolWriteGuards &
  PolicyRemovalOptions & {
    /** Records to remove (first, as on chain); `remoteChainSelector: 0n` is the policy's default. */
    recordsToRemove?: PolicyRecordKey[]
    /** Records to set; a set replaces the record. */
    recordsToSet?: FeePolicyRecord[]
  }

/**
 * Writes fee policy records. A record changes every lane of every token of the policy on its
 * chain (or, for the default record, on every chain without its own record).
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), the store would refuse
 *   (a missing record or policy, a policy in use or with records left), `sender` lacks the gate, or a
 *   lane guard refuses; `context.recordType` is `'fee'`
 */
export class ApplyMultiTokenPoolFeePolicyConfigUpdates extends PolicyRecordWriteOperation<
  FeePolicyRecord,
  ApplyMultiTokenPoolFeePolicyConfigUpdatesParams
> {
  readonly name = 'applyMultiTokenPoolFeePolicyConfigUpdates'
  protected readonly recordType = 'fee'
  protected readonly functionName = 'applyFeePolicyConfigUpdates'
  protected readonly typeRole = 'FEE_ROLE'
  protected readonly allowDefault = true

  protected parseRecord(
    _params: ApplyMultiTokenPoolFeePolicyConfigUpdatesParams,
    record: FeePolicyRecord,
    at: string,
  ): FeePolicyRecord {
    return {
      ...record,
      feeConfig: parseMultiTokenPoolFeeConfig(this.name, `${at}.feeConfig`, record.feeConfig),
    }
  }

  protected encodeRecord(record: FeePolicyRecord, word: string): unknown {
    return [word, record.remoteChainSelector, record.feeConfig]
  }
}
