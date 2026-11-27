/**
 * applyMultiTokenPoolInlineRemotePoolConfigUpdates — sets and removes inline remote pool records: the
 * pools a lane trusts, the data format it sends, and whether it also trusts its policy's pools.
 *
 * @packageDocumentation
 */

import type { EVMChain } from '../../../../evm/index.ts'
import { POOL_DATA_FORMATS } from '../../../multi-token-pool.ts'
import { parseRemoteAddress } from '../../../remote-address.ts'
import { assertUnique, validateArray, validateBoolean, validateOneOf } from '../../validate.ts'
import type { MultiTokenPoolLaneKey } from '../contracts.ts'
import { encodeInlineRemotePoolConfig } from '../decode.ts'
import { inlineRecordOf } from '../projection.ts'
import type { InlineRemotePoolConfig } from '../records.ts'
import type { MultiTokenPoolWriteGuards, PoolConfigManagerWriteParams } from '../write-operation.ts'
import { type RecordWriteContext, InlineRecordWriteOperation } from './record-writes.ts'

/** Parameters of `applyMultiTokenPoolInlineRemotePoolConfigUpdates`. Removals run first. */
export type ApplyMultiTokenPoolInlineRemotePoolConfigUpdatesParams = PoolConfigManagerWriteParams &
  MultiTokenPoolWriteGuards & {
    /**
     * Lanes whose inline remote pool record to remove; refused while the record sends legacy data
     * (set `poolDataFormat: 'long'` first, once the remote pool reads it).
     */
    remove?: MultiTokenPoolLaneKey[]
    /**
     * Records to set; a set replaces the whole record, so every pool or flag it drops from the lane
     * needs `confirmDropped` (a guard option of every write).
     */
    set?: InlineRemotePoolConfig[]
  }

/**
 * Writes inline remote pool records.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), the store would refuse
 *   (no inline record, an unregistered token, a removal of a legacy-sending record), `sender` lacks
 *   the gate, or a lane guard refuses (a dropped pool `confirmDropped` does not list included);
 *   `context.recordType` is `'remotePool'`
 */
export class ApplyMultiTokenPoolInlineRemotePoolConfigUpdates extends InlineRecordWriteOperation<
  InlineRemotePoolConfig,
  ApplyMultiTokenPoolInlineRemotePoolConfigUpdatesParams
> {
  readonly name = 'applyMultiTokenPoolInlineRemotePoolConfigUpdates'
  protected readonly recordType = 'remotePool'

  protected parseRecord(
    _params: ApplyMultiTokenPoolInlineRemotePoolConfigUpdatesParams,
    c: InlineRemotePoolConfig,
    at: string,
  ): InlineRemotePoolConfig {
    validateBoolean(this.name, `${at}.trustPolicyRemotePools`, c.trustPolicyRemotePools)
    validateOneOf(this.name, `${at}.poolDataFormat`, c.poolDataFormat, POOL_DATA_FORMATS)
    validateArray(this.name, `${at}.remotePools`, c.remotePools)
    // each pool at its own path, then the list unique
    const remotePools = Array.from(c.remotePools as readonly unknown[], (p, j) => {
      const { address, allowLegacyPoolData } = (p ?? {}) as Record<string, unknown>
      validateBoolean(this.name, `${at}.remotePools[${j}].allowLegacyPoolData`, allowLegacyPoolData)
      return {
        address: parseRemoteAddress(
          this.name,
          `${at}.remotePools[${j}].address`,
          address,
          c.remoteChainSelector,
        ),
        allowLegacyPoolData,
      }
    })
    assertUnique(this.name, `${at}.remotePools`, remotePools, (p) => p.address, 'remote pool')
    return { ...c, remotePools }
  }

  protected encodeRecord(c: InlineRemotePoolConfig): unknown {
    return encodeInlineRemotePoolConfig(c)
  }

  /**
   * Falling back to the policy, which never sends legacy data, while the remote pool still reads
   * only legacy would burn tokens it cannot process (`LegacyRemotePoolRecord`).
   */
  protected override async checkState(
    _chain: EVMChain,
    { remove = [] }: ApplyMultiTokenPoolInlineRemotePoolConfigUpdatesParams,
    { state }: RecordWriteContext,
  ): Promise<void> {
    remove.forEach((l, i) => {
      const record = inlineRecordOf(state, 'remotePool', l)
      if (record?.poolDataFormat === 'legacy')
        throw this.refuse(
          `remove[${i}]`,
          `the record sends legacy pool data; the policy it would fall back to sends long data the remote pool may not read (LegacyRemotePoolRecord): once the remote pool reads long data, set poolDataFormat: 'long' first, then remove it`,
        )
    })
  }
}
