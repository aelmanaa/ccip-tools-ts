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
import { type MultiTokenPoolLaneKey, validateLaneKeys } from '../contracts.ts'
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

/** Flags a set may turn off on an existing record. */
const DROPPABLE_FLAGS = ['trustPolicyRemotePools', 'allowLegacyPoolData'] as const

/** What a set may drop from an existing record, confirmed by repeating it. */
export type MultiTokenPoolInlineRemotePoolDrop = {
  /** The lane. */
  lane: MultiTokenPoolLaneKey
  /** Remote pools the set no longer lists. */
  remotePools?: string[]
  /** Flags the set turns off (`allowLegacyPoolData`: on any pool the set keeps). */
  flags?: (typeof DROPPABLE_FLAGS)[number][]
}

/** Parameters of `applyMultiTokenPoolInlineRemotePoolConfigUpdates`. Removals run first. */
export type ApplyMultiTokenPoolInlineRemotePoolConfigUpdatesParams = PoolConfigManagerWriteParams &
  MultiTokenPoolWriteGuards & {
    /**
     * Lanes whose inline remote pool record to remove; refused while the record sends legacy data
     * (set `poolDataFormat: 'long'` first, once the remote pool reads it).
     */
    remove?: MultiTokenPoolLaneKey[]
    /** Records to set; a set replaces the whole record. */
    set?: InlineRemotePoolConfig[]
    /**
     * Pools and flags a set drops from an existing record: a set replaces the whole record, so each
     * dropped pool or flag must be repeated here.
     */
    confirmDropped?: MultiTokenPoolInlineRemotePoolDrop[]
  }

/**
 * Writes inline remote pool records.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), the store would refuse
 *   (no inline record, an unregistered token, a removal of a legacy-sending record), a set drops a pool
 *   or flag `confirmDropped` does not list, `sender` lacks the gate, or a lane guard refuses;
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
    if (params.confirmDropped !== undefined) {
      validateArray(this.name, 'confirmDropped', params.confirmDropped)
      validateLaneKeys(
        this.name,
        'confirmDropped',
        params.confirmDropped.map((d) => (d as { lane?: unknown } | undefined)?.lane),
        0,
      )
      params.confirmDropped.forEach((d, i) => {
        if (d.flags !== undefined) {
          validateArray(this.name, `confirmDropped[${i}].flags`, d.flags)
          Array.from(d.flags, (f, j) =>
            validateOneOf(this.name, `confirmDropped[${i}].flags[${j}]`, f, DROPPABLE_FLAGS),
          )
        }
        if (d.remotePools !== undefined)
          parseUniqueRemoteAddresses(
            this.name,
            `confirmDropped[${i}].remotePools`,
            d.remotePools,
            d.lane.remoteChainSelector,
          )
      })
    }
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

    // a set replaces the whole record: what it drops must be confirmed
    const confirmed = new Map((params.confirmDropped ?? []).map((d) => [laneKey(d.lane), d]))
    const parsedPools = (c: InlineRemotePoolConfig, i: number) =>
      parseUniqueRemoteAddresses(
        this.name,
        `set[${i}].remotePools`,
        c.remotePools.map((p) => p.address),
        c.remoteChainSelector,
      )
    ;(params.set ?? []).forEach((c, i) => {
      const was = current(c)
      if (!was) return
      const parsed = parsedPools(c, i)
      const keeps = new Set(parsed)
      const legacyKept = new Map(parsed.map((a, j) => [a, c.remotePools[j]!.allowLegacyPoolData]))
      const pools = was.remotePools.map((p) => p.address).filter((a) => !keeps.has(a))
      const flags = [
        ...(was.trustPolicyRemotePools && !c.trustPolicyRemotePools
          ? (['trustPolicyRemotePools'] as const)
          : []),
        ...(was.remotePools.some(
          (p) => p.allowLegacyPoolData && keeps.has(p.address) && !legacyKept.get(p.address),
        )
          ? (['allowLegacyPoolData'] as const)
          : []),
      ]
      const ok = confirmed.get(laneKey(c))
      const okPools = new Set(
        ok?.remotePools
          ? parseUniqueRemoteAddresses(
              this.name,
              'confirmDropped',
              ok.remotePools,
              c.remoteChainSelector,
            )
          : [],
      )
      const missingPools = pools.filter((p) => !okPools.has(p))
      const missingFlags = flags.filter((f) => !ok?.flags?.includes(f))
      if (missingPools.length || missingFlags.length)
        throw new CCTParamsInvalidError(
          this.name,
          'confirmDropped',
          `set[${i}] replaces the record of ${laneKey(c)} and drops ${[
            ...(missingPools.length ? [`remote pools ${missingPools.join(', ')}`] : []),
            ...(missingFlags.length ? [`flags ${missingFlags.join(', ')}`] : []),
          ].join(
            ' and ',
          )}: a set replaces the whole record, so in-flight messages from a dropped pool would revert. List them in confirmDropped for this lane, or keep them in the set`,
          {
            context: {
              ...context,
              lane: {
                tokenAddress: getAddress(c.tokenAddress),
                remoteChainSelector: c.remoteChainSelector,
              },
              remotePools: missingPools,
              flags: missingFlags,
            },
          },
        )
    })

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
