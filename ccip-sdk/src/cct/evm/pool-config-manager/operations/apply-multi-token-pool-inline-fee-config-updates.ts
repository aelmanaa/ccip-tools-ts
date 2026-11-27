/**
 * applyMultiTokenPoolInlineFeeConfigUpdates — sets and removes inline fee records.
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

import type { MultiTokenPoolLaneKey } from '../contracts.ts'
import { parseMultiTokenPoolFeeConfig } from '../record-values.ts'
import type { InlineFeeConfig } from '../records.ts'
import type { MultiTokenPoolWriteGuards, PoolConfigManagerWriteParams } from '../write-operation.ts'
import { InlineRecordWriteOperation } from './record-writes.ts'

/** Parameters of `applyMultiTokenPoolInlineFeeConfigUpdates`. Removals run first. */
export type ApplyMultiTokenPoolInlineFeeConfigUpdatesParams = PoolConfigManagerWriteParams &
  MultiTokenPoolWriteGuards & {
    /** Lanes whose inline fee record to remove; the lane falls back to its fee policy. */
    remove?: MultiTokenPoolLaneKey[]
    /** Records to set; a set replaces the lane's record. */
    set?: InlineFeeConfig[]
  }

/**
 * Writes inline fee records.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), the store would refuse
 *   (no inline record, an unregistered token), `sender` lacks the gate, or a lane guard refuses;
 *   `context.recordType` is `'fee'`
 */
export class ApplyMultiTokenPoolInlineFeeConfigUpdates extends InlineRecordWriteOperation<
  InlineFeeConfig,
  ApplyMultiTokenPoolInlineFeeConfigUpdatesParams
> {
  readonly name = 'applyMultiTokenPoolInlineFeeConfigUpdates'
  protected readonly recordType = 'fee'
  protected readonly functionName = 'applyInlineFeeConfigUpdates'
  protected readonly typeRole = 'FEE_ROLE'

  protected parseRecord(
    _params: ApplyMultiTokenPoolInlineFeeConfigUpdatesParams,
    record: InlineFeeConfig,
    at: string,
  ): InlineFeeConfig {
    return {
      ...record,
      feeConfig: parseMultiTokenPoolFeeConfig(this.name, `${at}.feeConfig`, record.feeConfig),
    }
  }

  protected encodeRecord(record: InlineFeeConfig): unknown {
    return {
      localToken: getAddress(record.tokenAddress),
      remoteChainSelector: record.remoteChainSelector,
      feeConfig: record.feeConfig,
    }
  }
}
