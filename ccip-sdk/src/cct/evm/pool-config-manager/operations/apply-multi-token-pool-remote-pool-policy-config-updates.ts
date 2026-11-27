/**
 * applyMultiTokenPoolRemotePoolPolicyConfigUpdates — sets and removes remote pool policy records, and
 * removes whole remote pool policies.
 *
 * @packageDocumentation
 */

import { hexlify } from 'ethers'

import { encodeAddressToAny } from '../../../../utils.ts'
import { parseUniqueRemoteAddresses } from '../../../remote-address.ts'
import { validateArray } from '../../validate.ts'
import type { RemotePoolPolicyRecord } from '../records.ts'
import { type PolicyRecordWriteParams, PolicyRecordWriteOperation } from './record-writes.ts'

/** Parameters of `applyMultiTokenPoolRemotePoolPolicyConfigUpdates`. */
export type ApplyMultiTokenPoolRemotePoolPolicyConfigUpdatesParams =
  PolicyRecordWriteParams<RemotePoolPolicyRecord>

/**
 * Writes remote pool policy records. Policy pools never send legacy data, so the lanes they serve
 * must read long data on the remote side (the lane guard checks it).
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), the store would refuse
 *   (a missing record or policy, a policy in use or with records left), `sender` lacks the gate, or a
 *   lane guard refuses; `context.recordType` is `'remotePool'`
 */
export class ApplyMultiTokenPoolRemotePoolPolicyConfigUpdates extends PolicyRecordWriteOperation<RemotePoolPolicyRecord> {
  readonly name = 'applyMultiTokenPoolRemotePoolPolicyConfigUpdates'
  protected readonly recordType = 'remotePool'
  protected readonly functionName = 'applyRemotePoolPolicyConfigUpdates'
  protected readonly typeRole = 'REMOTE_POOL_ROLE'
  protected readonly allowDefault = false

  protected validateRecord(
    _params: ApplyMultiTokenPoolRemotePoolPolicyConfigUpdatesParams,
    record: RemotePoolPolicyRecord,
    at: string,
  ): void {
    // a record without pools trusts nothing (PolicyRecordHasNoPools)
    validateArray(this.name, `${at}.remotePoolAddresses`, record.remotePoolAddresses, 1)
    parseUniqueRemoteAddresses(
      this.name,
      `${at}.remotePoolAddresses`,
      record.remotePoolAddresses,
      record.remoteChainSelector,
    )
  }

  protected encodeRecord(record: RemotePoolPolicyRecord, word: string): unknown {
    const pools = parseUniqueRemoteAddresses(
      this.name,
      'remotePoolAddresses',
      record.remotePoolAddresses,
      record.remoteChainSelector,
    )
    return [word, record.remoteChainSelector, pools.map((p) => hexlify(encodeAddressToAny(p)))]
  }
}
