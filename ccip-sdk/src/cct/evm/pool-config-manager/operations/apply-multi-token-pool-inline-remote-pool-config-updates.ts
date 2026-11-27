/**
 * applyMultiTokenPoolInlineRemotePoolConfigUpdates — sets and removes inline remote pool records: the
 * pools a lane trusts, the data format it sends, and whether it also trusts its policy's pools.
 *
 * @packageDocumentation
 */

import { getAddress, hexlify } from 'ethers'

import type { EVMChain } from '../../../../evm/index.ts'
import { encodeAddressToAny } from '../../../../utils.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { parseUniqueRemoteAddresses } from '../../../remote-address.ts'
import {
  type PoolConfigManagerRole,
  POOL_CONFIG_MANAGER_TYPE,
  getMultiTokenPoolInterface,
} from '../../multi-token-pool/contracts.ts'
import { validateArray, validateBoolean, validateOneOf } from '../../validate.ts'
import type { MultiTokenPoolLaneKey } from '../contracts.ts'
import { readMultiTokenPoolRecordState } from '../record-state.ts'
import type { InlineRemotePoolConfig } from '../records.ts'
import {
  type MultiTokenPoolWriteGuards,
  type PoolConfigManagerWrite,
  type PoolConfigManagerWriteContext,
  type PoolConfigManagerWriteParams,
  PoolConfigManagerWriteOperation,
} from '../write-operation.ts'
import { checkInlineRecordWrite, validateInlineRecordWrite } from './record-writes.ts'

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
export class ApplyMultiTokenPoolInlineRemotePoolConfigUpdates extends PoolConfigManagerWriteOperation<ApplyMultiTokenPoolInlineRemotePoolConfigUpdatesParams> {
  readonly name = 'applyMultiTokenPoolInlineRemotePoolConfigUpdates'

  protected override prepare(
    params: ApplyMultiTokenPoolInlineRemotePoolConfigUpdatesParams,
  ): ApplyMultiTokenPoolInlineRemotePoolConfigUpdatesParams {
    super.prepare(params)
    validateInlineRecordWrite(this.name, params)
    params.set?.forEach((c, i) => {
      const at = `set[${i}]`
      validateBoolean(this.name, `${at}.trustPolicyRemotePools`, c.trustPolicyRemotePools)
      validateOneOf(this.name, `${at}.poolDataFormat`, c.poolDataFormat, [
        'legacy',
        'long',
      ] as const)
      validateArray(this.name, `${at}.remotePools`, c.remotePools)
      parseUniqueRemoteAddresses(
        this.name,
        `${at}.remotePools`,
        Array.from(c.remotePools, (p) => (p as { address?: unknown } | undefined)?.address),
        c.remoteChainSelector,
      )
      c.remotePools.forEach((p, j) =>
        validateBoolean(
          this.name,
          `${at}.remotePools[${j}].allowLegacyPoolData`,
          p.allowLegacyPoolData,
        ),
      )
    })
    return params
  }

  protected gate(): readonly PoolConfigManagerRole[] {
    return ['CONFIG_ROLE', 'TOKEN_MANAGER_ROLE', 'REMOTE_POOL_ROLE']
  }

  protected override errorContext(): Record<string, unknown> {
    return { recordType: 'remotePool' }
  }

  protected async encode(
    chain: EVMChain,
    params: ApplyMultiTokenPoolInlineRemotePoolConfigUpdatesParams,
    { address, version, blockTag }: PoolConfigManagerWriteContext,
  ): Promise<PoolConfigManagerWrite> {
    const { state } = await readMultiTokenPoolRecordState(chain, address, version, { blockTag })
    checkInlineRecordWrite(this.name, state, 'remotePool', params)
    const context = { recordType: 'remotePool' }
    const laneKey = (l: MultiTokenPoolLaneKey) =>
      `${getAddress(l.tokenAddress)}:${l.remoteChainSelector}`
    const current = (l: MultiTokenPoolLaneKey) =>
      state.tokens
        .find((t) => getAddress(t.tokenAddress) === getAddress(l.tokenAddress))
        ?.inline.remotePool.find((r) => r.remoteChainSelector === l.remoteChainSelector)

    ;(params.remove ?? []).forEach((l, i) => {
      // falling back to the policy, which never sends legacy data, while the remote pool still reads
      // only legacy would burn tokens it cannot process (LegacyRemotePoolRecord)
      if (current(l)?.poolDataFormat === 'legacy')
        throw new CCTParamsInvalidError(
          this.name,
          `remove[${i}]`,
          `the record sends legacy pool data; the policy it would fall back to sends long data the remote pool may not read (LegacyRemotePoolRecord): once the remote pool reads long data, set poolDataFormat: 'long' first, then remove it`,
          { context },
        )
    })

    const parsedPools = (c: InlineRemotePoolConfig, i: number) =>
      parseUniqueRemoteAddresses(
        this.name,
        `set[${i}].remotePools`,
        c.remotePools.map((p) => p.address),
        c.remoteChainSelector,
      )
    const data = getMultiTokenPoolInterface(POOL_CONFIG_MANAGER_TYPE, version).encodeFunctionData(
      'applyInlineRemotePoolConfigUpdates',
      [
        (params.remove ?? []).map((l) => ({
          localToken: getAddress(l.tokenAddress),
          remoteChainSelector: l.remoteChainSelector,
        })),
        (params.set ?? []).map((c, i) => ({
          localToken: getAddress(c.tokenAddress),
          remoteChainSelector: c.remoteChainSelector,
          trustPolicyRemotePools: c.trustPolicyRemotePools,
          remotePoolConfig: {
            useLegacyPoolDataOnSend: c.poolDataFormat === 'legacy',
            remotePools: parsedPools(c, i).map((pool, j) => ({
              remotePoolAddress: hexlify(encodeAddressToAny(pool)),
              allowLegacyPoolDataOnReceive: c.remotePools[j]!.allowLegacyPoolData,
            })),
          },
        })),
      ],
    )
    // the values the write replaces: each touched lane's inline record (absent: `null`)
    const expected = Object.fromEntries(
      [...(params.remove ?? []), ...(params.set ?? [])].map((l) => [
        `inline.remotePool.${laneKey(l)}`,
        current(l) ?? null,
      ]),
    )
    return { data, expected }
  }
}
