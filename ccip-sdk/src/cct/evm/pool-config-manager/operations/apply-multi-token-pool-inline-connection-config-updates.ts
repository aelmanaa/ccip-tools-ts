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
import {
  type PoolConfigManagerRole,
  POOL_CONFIG_MANAGER_TYPE,
  getMultiTokenPoolInterface,
} from '../../multi-token-pool/contracts.ts'
import { decodeMultiTokenPoolWrite } from '../calldata.ts'
import type { MultiTokenPoolLaneKey } from '../contracts.ts'
import { fillProviderAnswers } from '../guard-run.ts'
import { applyMultiTokenPoolRecordChanges, resolveMultiTokenPoolLanes } from '../projection.ts'
import { readMultiTokenPoolRecordState } from '../record-state.ts'
import type { InlineConnectionConfig } from '../records.ts'
import {
  type MultiTokenPoolWriteGuards,
  type PoolConfigManagerWrite,
  type PoolConfigManagerWriteContext,
  type PoolConfigManagerWriteParams,
  PoolConfigManagerWriteOperation,
} from '../write-operation.ts'
import { checkInlineRecordWrite, validateInlineRecordWrite } from './record-writes.ts'

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
export class ApplyMultiTokenPoolInlineConnectionConfigUpdates extends PoolConfigManagerWriteOperation<ApplyMultiTokenPoolInlineConnectionConfigUpdatesParams> {
  readonly name = 'applyMultiTokenPoolInlineConnectionConfigUpdates'

  protected override prepare(
    params: ApplyMultiTokenPoolInlineConnectionConfigUpdatesParams,
  ): ApplyMultiTokenPoolInlineConnectionConfigUpdatesParams {
    super.prepare(params)
    validateInlineRecordWrite(this.name, params)
    params.set?.forEach((c, i) =>
      parseRemoteAddress(this.name, `set[${i}].remoteToken`, c.remoteToken, c.remoteChainSelector),
    )
    return params
  }

  protected gate(): readonly PoolConfigManagerRole[] {
    return ['CONFIG_ROLE', 'TOKEN_MANAGER_ROLE', 'CONNECTION_ROLE']
  }

  protected override errorContext(): Record<string, unknown> {
    return { recordType: 'connection' }
  }

  protected async encode(
    chain: EVMChain,
    params: ApplyMultiTokenPoolInlineConnectionConfigUpdatesParams,
    { address, version, blockTag }: PoolConfigManagerWriteContext,
  ): Promise<PoolConfigManagerWrite> {
    const { state } = await readMultiTokenPoolRecordState(chain, address, version, { blockTag })
    checkInlineRecordWrite(this.name, state, 'connection', params)
    const remove = (params.remove ?? []).map((l) => ({
      localToken: getAddress(l.tokenAddress),
      remoteChainSelector: l.remoteChainSelector,
    }))
    const data = getMultiTokenPoolInterface(POOL_CONFIG_MANAGER_TYPE, version).encodeFunctionData(
      'applyInlineConnectionConfigUpdates',
      [
        remove,
        (params.set ?? []).map((c, i) => ({
          localToken: getAddress(c.tokenAddress),
          remoteChainSelector: c.remoteChainSelector,
          remoteToken: hexlify(
            encodeAddressToAny(
              parseRemoteAddress(
                this.name,
                `set[${i}].remoteToken`,
                c.remoteToken,
                c.remoteChainSelector,
              ),
            ),
          ),
        })),
      ],
    )
    const inline = (l: MultiTokenPoolLaneKey) =>
      state.tokens
        .find((t) => getAddress(t.tokenAddress) === getAddress(l.tokenAddress))
        ?.inline.connection.find((r) => r.remoteChainSelector === l.remoteChainSelector)
    // after a removal the lane falls back to its policy, which must not resolve another remote token
    // (PolicyRemoteTokenMismatch). The store checks it in its removal loop, before any set: project
    // the removals alone
    const removals = params.remove ?? []
    if (removals.length) {
      const after = applyMultiTokenPoolRecordChanges(
        state,
        decodeMultiTokenPoolWrite(data, version).changes.filter((c) => c.kind === 'removeInline'),
      )
      await fillProviderAnswers(chain, after, removals, blockTag)
      resolveMultiTokenPoolLanes(after, removals).forEach((lane, i) => {
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
    // the values the write replaces: each touched lane's inline remote token (absent: `null`)
    const expected = Object.fromEntries(
      [...(params.remove ?? []), ...(params.set ?? [])].map((l) => [
        `inline.connection.${getAddress(l.tokenAddress)}:${l.remoteChainSelector}`,
        inline(l)?.remoteToken ?? null,
      ]),
    )
    return { data, expected }
  }
}
