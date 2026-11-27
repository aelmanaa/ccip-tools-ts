/**
 * applyMultiTokenPoolRemotePoolPolicyConfigUpdates — sets and removes remote pool policy records, and
 * removes whole remote pool policies.
 *
 * @packageDocumentation
 */

import { hexlify } from 'ethers'

import { encodeAddressToAny } from '../../../../utils.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { parseUniqueRemoteAddresses } from '../../../remote-address.ts'
import { validateArray } from '../../validate.ts'
import type { PolicyRecordKey, PolicyRemovalOptions, RemotePoolPolicyRecord } from '../records.ts'
import type { MultiTokenPoolWriteGuards, PoolConfigManagerWriteParams } from '../write-operation.ts'
import { PolicyRecordWriteOperation } from './record-writes.ts'

/** Parameters of `applyMultiTokenPoolRemotePoolPolicyConfigUpdates`. */
export type ApplyMultiTokenPoolRemotePoolPolicyConfigUpdatesParams = PoolConfigManagerWriteParams &
  MultiTokenPoolWriteGuards &
  PolicyRemovalOptions & {
    /** Records to remove (first, as on chain). */
    recordsToRemove?: PolicyRecordKey[]
    /** Records to set; a set replaces the record's pools. */
    recordsToSet?: RemotePoolPolicyRecord[]
  }

/**
 * Writes remote pool policy records. Policy pools never send legacy data, so the lanes they serve
 * must read long data on the remote side (the lane guard checks it).
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), the store would refuse
 *   (a missing record or policy, a policy in use or with records left), `sender` lacks the gate, or a
 *   lane guard refuses; `context.recordType` is `'remotePool'`
 */
export class ApplyMultiTokenPoolRemotePoolPolicyConfigUpdates extends PolicyRecordWriteOperation<
  RemotePoolPolicyRecord,
  ApplyMultiTokenPoolRemotePoolPolicyConfigUpdatesParams
> {
  readonly name = 'applyMultiTokenPoolRemotePoolPolicyConfigUpdates'
  protected readonly recordType = 'remotePool'
  protected readonly functionName = 'applyRemotePoolPolicyConfigUpdates'
  protected readonly typeRole = 'REMOTE_POOL_ROLE'
  protected readonly allowDefault = false

  protected parseRecord(
    _params: ApplyMultiTokenPoolRemotePoolPolicyConfigUpdatesParams,
    record: RemotePoolPolicyRecord,
    at: string,
  ): RemotePoolPolicyRecord {
    validateArray(this.name, `${at}.remotePoolAddresses`, record.remotePoolAddresses)
    if (!record.remotePoolAddresses.length)
      throw new CCTParamsInvalidError(
        this.name,
        `${at}.remotePoolAddresses`,
        'is empty: a remote pool policy record without pools trusts nothing (PolicyRecordHasNoPools); give at least one pool, or remove the record with recordsToRemove',
      )
    return {
      ...record,
      remotePoolAddresses: parseUniqueRemoteAddresses(
        this.name,
        `${at}.remotePoolAddresses`,
        record.remotePoolAddresses,
        record.remoteChainSelector,
      ),
    }
  }

  protected encodeRecord(record: RemotePoolPolicyRecord, word: string): unknown {
    return [
      word,
      record.remoteChainSelector,
      record.remotePoolAddresses.map((p) => hexlify(encodeAddressToAny(p))),
    ]
  }
}
