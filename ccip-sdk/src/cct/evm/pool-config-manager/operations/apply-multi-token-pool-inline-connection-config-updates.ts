/**
 * applyMultiTokenPoolInlineConnectionConfigUpdates — sets and removes inline connection records: the
 * remote token of one lane.
 *
 * @packageDocumentation
 */

import { getAddress, hexlify } from 'ethers'

import type { EVMChain } from '../../../../evm/index.ts'
import { encodeAddressToAny } from '../../../../utils.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { parseRemoteAddress } from '../../../remote-address.ts'
import type { MultiTokenPoolLaneKey } from '../contracts.ts'
import { applyMultiTokenPoolRecordChanges, resolveMultiTokenPoolLanes } from '../projection.ts'
import { fillProviderAnswers } from '../record-state.ts'
import type { InlineConnectionConfig } from '../records.ts'
import type { MultiTokenPoolWriteGuards, PoolConfigManagerWriteParams } from '../write-operation.ts'
import { type RecordWriteContext, InlineRecordWriteOperation } from './record-writes.ts'

/** Parameters of `applyMultiTokenPoolInlineConnectionConfigUpdates`. Removals run first. */
export type ApplyMultiTokenPoolInlineConnectionConfigUpdatesParams = PoolConfigManagerWriteParams &
  MultiTokenPoolWriteGuards & {
    /** Lanes whose inline connection to remove; the lane falls back to its connection policy. */
    remove?: MultiTokenPoolLaneKey[]
    /** Inline connections to set. A set opens its lane once its other records resolve: write it last. */
    set?: InlineConnectionConfig[]
  }

/**
 * Writes inline connection records.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), the store would refuse
 *   (no inline record, an unregistered token, a policy that would resolve another remote token after a
 *   removal), `sender` lacks the gate, or a lane guard refuses; `context.recordType` is `'connection'`
 */
export class ApplyMultiTokenPoolInlineConnectionConfigUpdates extends InlineRecordWriteOperation<
  InlineConnectionConfig,
  ApplyMultiTokenPoolInlineConnectionConfigUpdatesParams
> {
  readonly name = 'applyMultiTokenPoolInlineConnectionConfigUpdates'
  protected readonly recordType = 'connection'
  protected readonly functionName = 'applyInlineConnectionConfigUpdates'
  protected readonly typeRole = 'CONNECTION_ROLE'

  protected validateRecord(
    _params: ApplyMultiTokenPoolInlineConnectionConfigUpdatesParams,
    record: InlineConnectionConfig,
    at: string,
  ): void {
    parseRemoteAddress(
      this.name,
      `${at}.remoteToken`,
      record.remoteToken,
      record.remoteChainSelector,
    )
  }

  protected encodeRecord(record: InlineConnectionConfig, at: string): unknown {
    return {
      localToken: getAddress(record.tokenAddress),
      remoteChainSelector: record.remoteChainSelector,
      remoteToken: hexlify(
        encodeAddressToAny(
          parseRemoteAddress(
            this.name,
            `${at}.remoteToken`,
            record.remoteToken,
            record.remoteChainSelector,
          ),
        ),
      ),
    }
  }

  /**
   * After a removal the lane falls back to its policy, which must not resolve another remote token
   * (`PolicyRemoteTokenMismatch`). The store checks it in its removal loop, before any set, so the
   * removals alone are projected.
   */
  protected override async checkState(
    chain: EVMChain,
    { remove = [] }: ApplyMultiTokenPoolInlineConnectionConfigUpdatesParams,
    { state, blockTag }: RecordWriteContext,
  ): Promise<void> {
    if (!remove.length) return
    const after = applyMultiTokenPoolRecordChanges(
      state,
      remove.map((l) => ({ kind: 'removeInline', type: 'connection', ...l })),
    )
    await fillProviderAnswers(chain, after, remove, blockTag)
    const inline = (l: MultiTokenPoolLaneKey) =>
      state.tokens
        .find((t) => getAddress(t.tokenAddress) === getAddress(l.tokenAddress))
        ?.inline.connection.find((r) => r.remoteChainSelector === l.remoteChainSelector)
    resolveMultiTokenPoolLanes(after, remove).forEach((lane, i) => {
      const was = inline(lane)?.remoteToken
      const policy = lane.connection.remoteToken
      if (policy !== null && was !== undefined && policy !== was)
        throw new CCTParamsInvalidError(
          this.name,
          `remove[${i}]`,
          `removing it falls the lane back to its connection policy, which resolves remote token ${policy}, not ${was} (PolicyRemoteTokenMismatch): in-flight messages would name the wrong token; align the policy first, or keep the inline record`,
          { context: { recordType: 'connection' } },
        )
    })
  }
}
