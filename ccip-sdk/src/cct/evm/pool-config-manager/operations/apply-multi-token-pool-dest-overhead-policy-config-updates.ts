/**
 * applyMultiTokenPoolDestOverheadPolicyConfigUpdates — sets and removes destination overhead policy records, and removes whole destination overhead
 * policies.
 *
 * @packageDocumentation
 */

import { parseMultiTokenPoolDestOverheadConfig } from '../record-values.ts'
import type { DestOverheadPolicyRecord, PolicyRecordKey, PolicyRemovalOptions } from '../records.ts'
import type { MultiTokenPoolWriteGuards, PoolConfigManagerWriteParams } from '../write-operation.ts'
import { PolicyRecordWriteOperation } from './record-writes.ts'

/** Parameters of `applyMultiTokenPoolDestOverheadPolicyConfigUpdates`. Records are removed, then policies, then records set. */
export type ApplyMultiTokenPoolDestOverheadPolicyConfigUpdatesParams =
  PoolConfigManagerWriteParams &
    MultiTokenPoolWriteGuards &
    PolicyRemovalOptions & {
      /** Records to remove (first, as on chain); `remoteChainSelector: 0n` is the policy's default. */
      recordsToRemove?: PolicyRecordKey[]
      /** Records to set; a set replaces the record. */
      recordsToSet?: DestOverheadPolicyRecord[]
    }

/**
 * Writes destination overhead policy records. A record changes every lane of every token of the policy on its
 * chain (or, for the default record, on every chain without its own record).
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), the store would refuse
 *   (a missing record or policy, a policy in use or with records left), `sender` lacks the gate, or a
 *   lane guard refuses; `context.recordType` is `'destOverhead'`
 */
export class ApplyMultiTokenPoolDestOverheadPolicyConfigUpdates extends PolicyRecordWriteOperation<
  DestOverheadPolicyRecord,
  ApplyMultiTokenPoolDestOverheadPolicyConfigUpdatesParams
> {
  readonly name = 'applyMultiTokenPoolDestOverheadPolicyConfigUpdates'
  protected readonly recordType = 'destOverhead'
  protected readonly functionName = 'applyDestOverheadPolicyConfigUpdates'
  protected readonly typeRole = 'DEST_OVERHEAD_ROLE'
  protected readonly allowDefault = true

  protected parseRecord(
    _params: ApplyMultiTokenPoolDestOverheadPolicyConfigUpdatesParams,
    record: DestOverheadPolicyRecord,
    at: string,
  ): DestOverheadPolicyRecord {
    return {
      ...record,
      destOverheadConfig: parseMultiTokenPoolDestOverheadConfig(
        this.name,
        `${at}.destOverheadConfig`,
        record.destOverheadConfig,
      ),
    }
  }

  protected encodeRecord(record: DestOverheadPolicyRecord, word: string): unknown {
    return [word, record.remoteChainSelector, record.destOverheadConfig]
  }
}
