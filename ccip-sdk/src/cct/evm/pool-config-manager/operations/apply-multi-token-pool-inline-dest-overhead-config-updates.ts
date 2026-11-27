/**
 * applyMultiTokenPoolInlineDestOverheadConfigUpdates — sets and removes inline destination overhead records.
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

import type { MultiTokenPoolLaneKey } from '../contracts.ts'
import { parseMultiTokenPoolDestOverheadConfig } from '../record-values.ts'
import type { InlineDestOverheadConfig } from '../records.ts'
import type { MultiTokenPoolWriteGuards, PoolConfigManagerWriteParams } from '../write-operation.ts'
import { InlineRecordWriteOperation } from './record-writes.ts'

/** Parameters of `applyMultiTokenPoolInlineDestOverheadConfigUpdates`. Removals run first. */
export type ApplyMultiTokenPoolInlineDestOverheadConfigUpdatesParams =
  PoolConfigManagerWriteParams &
    MultiTokenPoolWriteGuards & {
      /** Lanes whose inline destination overhead record to remove; the lane falls back to its destination overhead policy. */
      remove?: MultiTokenPoolLaneKey[]
      /** Records to set; a set replaces the lane's record. */
      set?: InlineDestOverheadConfig[]
    }

/**
 * Writes inline destination overhead records.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), the store would refuse
 *   (no inline record, an unregistered token), `sender` lacks the gate, or a lane guard refuses;
 *   `context.recordType` is `'destOverhead'`
 */
export class ApplyMultiTokenPoolInlineDestOverheadConfigUpdates extends InlineRecordWriteOperation<
  InlineDestOverheadConfig,
  ApplyMultiTokenPoolInlineDestOverheadConfigUpdatesParams
> {
  readonly name = 'applyMultiTokenPoolInlineDestOverheadConfigUpdates'
  protected readonly recordType = 'destOverhead'
  protected readonly functionName = 'applyInlineDestOverheadConfigUpdates'
  protected readonly typeRole = 'DEST_OVERHEAD_ROLE'

  protected parseRecord(
    _params: ApplyMultiTokenPoolInlineDestOverheadConfigUpdatesParams,
    record: InlineDestOverheadConfig,
    at: string,
  ): InlineDestOverheadConfig {
    return {
      ...record,
      destOverheadConfig: parseMultiTokenPoolDestOverheadConfig(
        this.name,
        `${at}.destOverheadConfig`,
        record.destOverheadConfig,
      ),
    }
  }

  protected encodeRecord(record: InlineDestOverheadConfig): unknown {
    return {
      localToken: getAddress(record.tokenAddress),
      remoteChainSelector: record.remoteChainSelector,
      destOverheadConfig: record.destOverheadConfig,
    }
  }
}
