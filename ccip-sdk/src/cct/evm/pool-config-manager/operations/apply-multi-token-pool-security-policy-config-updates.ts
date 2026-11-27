/**
 * applyMultiTokenPoolSecurityPolicyConfigUpdates — sets and removes security policy records, and removes whole security
 * policies.
 *
 * @packageDocumentation
 */

import { encodeSecurityConfig } from '../decode.ts'
import { parseMultiTokenPoolSecurityConfig } from '../record-values.ts'
import type { PolicyRecordKey, PolicyRemovalOptions, SecurityPolicyRecord } from '../records.ts'
import type { MultiTokenPoolWriteGuards, PoolConfigManagerWriteParams } from '../write-operation.ts'
import { PolicyRecordWriteOperation } from './record-writes.ts'

/** Parameters of `applyMultiTokenPoolSecurityPolicyConfigUpdates`. Records are removed, then policies, then records set. */
export type ApplyMultiTokenPoolSecurityPolicyConfigUpdatesParams = PoolConfigManagerWriteParams &
  MultiTokenPoolWriteGuards &
  PolicyRemovalOptions & {
    /** Records to remove (first, as on chain); `remoteChainSelector: 0n` is the policy's default. */
    recordsToRemove?: PolicyRecordKey[]
    /** Records to set; a set replaces the record. */
    recordsToSet?: SecurityPolicyRecord[]
  }

/**
 * Writes security policy records. A record changes every lane of every token of the policy on its
 * chain (or, for the default record, on every chain without its own record).
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), the store would refuse
 *   (a missing record or policy, a policy in use or with records left), `sender` lacks the gate, or a
 *   lane guard refuses; `context.recordType` is `'security'`
 */
export class ApplyMultiTokenPoolSecurityPolicyConfigUpdates extends PolicyRecordWriteOperation<
  SecurityPolicyRecord,
  ApplyMultiTokenPoolSecurityPolicyConfigUpdatesParams
> {
  readonly name = 'applyMultiTokenPoolSecurityPolicyConfigUpdates'
  protected readonly recordType = 'security'
  protected readonly functionName = 'applySecurityPolicyConfigUpdates'
  protected readonly typeRole = 'SECURITY_ROLE'
  protected readonly allowDefault = true

  protected parseRecord(
    _params: ApplyMultiTokenPoolSecurityPolicyConfigUpdatesParams,
    record: SecurityPolicyRecord,
    at: string,
  ): SecurityPolicyRecord {
    return {
      ...record,
      securityConfig: parseMultiTokenPoolSecurityConfig(
        this.name,
        `${at}.securityConfig`,
        record.securityConfig,
      ),
    }
  }

  protected encodeRecord(record: SecurityPolicyRecord, word: string): unknown {
    return [word, record.remoteChainSelector, encodeSecurityConfig(record.securityConfig)]
  }
}
