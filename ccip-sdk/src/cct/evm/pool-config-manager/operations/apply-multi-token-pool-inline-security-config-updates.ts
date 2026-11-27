/**
 * applyMultiTokenPoolInlineSecurityConfigUpdates — sets and removes inline security records.
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

import type { MultiTokenPoolLaneKey } from '../contracts.ts'
import { encodeSecurityConfig } from '../decode.ts'
import { parseMultiTokenPoolSecurityConfig } from '../record-values.ts'
import type { InlineSecurityConfig } from '../records.ts'
import type { MultiTokenPoolWriteGuards, PoolConfigManagerWriteParams } from '../write-operation.ts'
import { InlineRecordWriteOperation } from './record-writes.ts'

/** Parameters of `applyMultiTokenPoolInlineSecurityConfigUpdates`. Removals run first. */
export type ApplyMultiTokenPoolInlineSecurityConfigUpdatesParams = PoolConfigManagerWriteParams &
  MultiTokenPoolWriteGuards & {
    /** Lanes whose inline security record to remove; the lane falls back to its security policy. */
    remove?: MultiTokenPoolLaneKey[]
    /** Records to set; a set replaces the lane's record. */
    set?: InlineSecurityConfig[]
  }

/**
 * Writes inline security records.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), the store would refuse
 *   (no inline record, an unregistered token), `sender` lacks the gate, or a lane guard refuses;
 *   `context.recordType` is `'security'`
 */
export class ApplyMultiTokenPoolInlineSecurityConfigUpdates extends InlineRecordWriteOperation<
  InlineSecurityConfig,
  ApplyMultiTokenPoolInlineSecurityConfigUpdatesParams
> {
  readonly name = 'applyMultiTokenPoolInlineSecurityConfigUpdates'
  protected readonly recordType = 'security'

  protected parseRecord(
    _params: ApplyMultiTokenPoolInlineSecurityConfigUpdatesParams,
    record: InlineSecurityConfig,
    at: string,
  ): InlineSecurityConfig {
    return {
      ...record,
      securityConfig: parseMultiTokenPoolSecurityConfig(
        this.name,
        `${at}.securityConfig`,
        record.securityConfig,
      ),
    }
  }

  protected encodeRecord(record: InlineSecurityConfig): unknown {
    return {
      localToken: getAddress(record.tokenAddress),
      remoteChainSelector: record.remoteChainSelector,
      securityConfig: encodeSecurityConfig(record.securityConfig),
    }
  }
}
