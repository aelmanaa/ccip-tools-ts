/**
 * applyMultiTokenPoolConnectionPolicyConfigUpdates — sets and removes connection policy records, and
 * removes whole connection policies.
 *
 * @packageDocumentation
 */

import { CCTParamsInvalidError } from '../../../errors.ts'
import { validateBoolean } from '../../validate.ts'
import type { ConnectionPolicyRecord } from '../records.ts'
import { type PolicyRecordWriteParams, PolicyRecordWriteOperation } from './record-writes.ts'

/** Parameters of `applyMultiTokenPoolConnectionPolicyConfigUpdates`. */
export type ApplyMultiTokenPoolConnectionPolicyConfigUpdatesParams =
  PolicyRecordWriteParams<ConnectionPolicyRecord> & {
    /**
     * Accept a record with `onlySubsetTokens: false`, which opens its chain to every current and
     * future token of the policy. Defaults to `false`.
     */
    openToAllPolicyTokens?: boolean
  }

/**
 * Writes connection policy records.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), the store would refuse
 *   (a missing record or policy, a policy in use or with records left), `sender` lacks the gate, or a
 *   lane guard refuses; `context.recordType` is `'connection'`
 */
export class ApplyMultiTokenPoolConnectionPolicyConfigUpdates extends PolicyRecordWriteOperation<
  ConnectionPolicyRecord,
  ApplyMultiTokenPoolConnectionPolicyConfigUpdatesParams
> {
  readonly name = 'applyMultiTokenPoolConnectionPolicyConfigUpdates'
  protected readonly recordType = 'connection'
  protected readonly functionName = 'applyConnectionPolicyConfigUpdates'
  protected readonly typeRole = 'CONNECTION_ROLE'
  protected readonly allowDefault = false

  protected validateRecord(
    params: ApplyMultiTokenPoolConnectionPolicyConfigUpdatesParams,
    record: ConnectionPolicyRecord,
    at: string,
  ): void {
    validateBoolean(this.name, `${at}.onlySubsetTokens`, record.onlySubsetTokens)
    if (params.openToAllPolicyTokens !== undefined)
      validateBoolean(this.name, 'openToAllPolicyTokens', params.openToAllPolicyTokens)
    if (!record.onlySubsetTokens && params.openToAllPolicyTokens !== true)
      throw new CCTParamsInvalidError(
        this.name,
        `${at}.onlySubsetTokens`,
        `is false, which opens chain ${record.remoteChainSelector} to every current and future token of policy ${record.policyName}: pass openToAllPolicyTokens: true to confirm, or list the tokens with applyMultiTokenPoolSubsetTokenUpdates`,
        { context: { recordType: 'connection' } },
      )
  }

  protected encodeRecord(record: ConnectionPolicyRecord, word: string): unknown {
    return [word, record.remoteChainSelector, record.onlySubsetTokens]
  }
}
