/**
 * setPoolConfigManager — `pool.setPoolConfigManager(newPcm)`: points a multi-token pool at another
 * PoolConfigManager. It takes effect at once, for every token the pool serves.
 *
 * @remarks The lanes live in the policy stores, so:
 * - the new PCM must use the same TokenAdminRegistry;
 * - over the same stores the configuration is unchanged, but each store must already authorize the
 *   new PCM, or every validate call would revert and stop the pool;
 * - over other stores it is another configuration (and none of the pauses), so it is refused while
 *   the pool serves any lane through the current PCM; otherwise every lane the new PCM resolves for
 *   the pool's tokens runs the lane check (no attestations), and any error finding refuses it.
 * The replaced PCM keeps write access to its stores until removed (F4): `followUps` lists each store
 * that still authorizes it, unless another pool still uses it. Prefer `replacePoolConfigManager`.
 * What the write is judged on is sealed: the snapshot check re-reads it.
 *
 * @packageDocumentation
 */

import { type Result, getAddress } from 'ethers'

import type { ChainGetter } from '../../../../chain.ts'
import type { EVMChain } from '../../../../evm/index.ts'
import { resultToObject } from '../../../../evm/types.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import type { MultiTokenPoolLaneFinding } from '../../../multi-token-pool.ts'
import { readAllAuthorizedCallers } from '../../advanced-pool-hooks/contracts.ts'
import { CheckMultiTokenPoolLane } from '../../pool-config-manager/operations/check-multi-token-pool-lane.ts'
import { laneKey, multiTokenPoolSupportedChains } from '../../pool-config-manager/projection.ts'
import { readMultiTokenPoolRecordState } from '../../pool-config-manager/record-state.ts'
import { readPoolsServingPoolConfigManager } from '../../pool-config-manager/serving-pools.ts'
import { validateNonZeroAddress } from '../../validate.ts'
import {
  type MultiTokenPoolVersion,
  type PolicyStoreType,
  POLICY_STORE_TYPES,
  POOL_CONFIG_MANAGER_TYPE,
  multiTokenPoolContract,
  multiTokenPoolFunctionOf,
  policyStoresOf,
  resolveMultiTokenPoolContract,
} from '../contracts.ts'
import {
  type MultiTokenPoolOwnedWriteContext,
  type MultiTokenPoolOwnedWriteImpact,
  MultiTokenPoolOwnedWriteOperation,
  ownedTargetInterface,
} from '../owned-write-operation.ts'
import type { MultiTokenPoolFollowUp, MultiTokenPoolUnsignedTx } from '../write-operation.ts'

/** `setPoolConfigManager`. Pool owner. */
export type SetPoolConfigManagerParams = {
  /** The multi-token pool. */
  poolAddress: string
  /** The PoolConfigManager the pool will call. */
  poolConfigManager: string
  /** Resolves the remote chains the lane check reads, for a PCM over other stores. */
  getChain?: ChainGetter
  /** The pool owner; optional when generating an unsigned transaction. */
  sender?: string
}

/** A PCM's registry and stores, as sealed. */
type PcmConfig = { tokenAdminRegistry: string; stores: Record<PolicyStoreType, string> }

/** A PCM read at the build block: its version, records, registry and stores. */
type PcmRead = {
  version: MultiTokenPoolVersion
  state: Awaited<ReturnType<typeof readMultiTokenPoolRecordState>>['state']
  config: PcmConfig
}

const PATHS = {
  current: 'pool.poolConfigManager',
  config: (side: 'old' | 'new') => `${side}.staticConfig`,
  callers: (side: 'old' | 'new') => `${side}.storeAuthorizes`,
  lanes: (side: 'old' | 'new') => `${side}.servedLanes`,
  shared: 'old.sharedWith',
} as const

/** Points a multi-token pool at another PoolConfigManager. Pool owner. */
export class SetPoolConfigManager extends MultiTokenPoolOwnedWriteOperation<
  'pool',
  SetPoolConfigManagerParams,
  SetPoolConfigManagerParams,
  MultiTokenPoolUnsignedTx
> {
  readonly name = 'setPoolConfigManager'
  protected readonly kind = 'pool'
  protected override readonly seals = true
  readonly #laneCheck = new CheckMultiTokenPoolLane()

  protected override prepare(params: SetPoolConfigManagerParams): SetPoolConfigManagerParams {
    super.prepare(params)
    validateNonZeroAddress(this.name, 'poolConfigManager', params.poolConfigManager)
    return { ...params, poolConfigManager: getAddress(params.poolConfigManager) }
  }

  /**
   * Both PCMs' registry and stores, whether each store authorizes them, the pools still sharing the
   * current PCM, and, when the stores differ, the lanes the pool serves through either PCM.
   */
  protected override async readFacts(
    chain: EVMChain,
    { poolConfigManager }: SetPoolConfigManagerParams,
    { address, version, blockTag }: Omit<MultiTokenPoolOwnedWriteContext, 'facts'>,
  ): Promise<Record<string, unknown>> {
    const current = getAddress(
      resultToObject(
        await multiTokenPoolContract(chain, address, version).getPoolConfigManager({ blockTag }),
      ),
    )
    const [old, next] = await Promise.all([
      this.#pcm(chain, current, 'poolAddress', blockTag),
      this.#pcm(chain, poolConfigManager, 'poolConfigManager', blockTag),
    ])
    const sameStores = POLICY_STORE_TYPES.every(
      (t) => old.config.stores[t] === next.config.stores[t],
    )
    const [oldCallers, newCallers, oldServed, newServed, { serving: sharedWith }] =
      await Promise.all([
        this.#storeAuthorizes(chain, old.config, current, blockTag),
        this.#storeAuthorizes(chain, next.config, poolConfigManager, blockTag),
        sameStores ? undefined : this.#servedLanes(chain, current, old, address, blockTag),
        sameStores
          ? undefined
          : this.#servedLanes(chain, poolConfigManager, next, address, blockTag),
        // the other pools the registry routes through the current PCM: its stores stay authorized
        readPoolsServingPoolConfigManager(chain, {
          poolConfigManager: current,
          version: old.version,
          tokenAdminRegistry: old.config.tokenAdminRegistry,
          tokens: old.state.tokens.map((t) => t.tokenAddress),
          targetPool: address,
          blockTag,
        }),
      ])
    return {
      [PATHS.current]: current,
      [PATHS.config('old')]: old.config,
      [PATHS.config('new')]: next.config,
      [PATHS.callers('old')]: oldCallers,
      [PATHS.callers('new')]: newCallers,
      [PATHS.shared]: sharedWith,
      ...(oldServed && { [PATHS.lanes('old')]: oldServed.map((l) => l.key) }),
      ...(newServed && { [PATHS.lanes('new')]: newServed.map((l) => l.key) }),
    }
  }

  /** A PCM's version, registry and stores, and the other pools that call it (registry-named). */
  async #pcm(chain: EVMChain, pcm: string, param: string, blockTag: number): Promise<PcmRead> {
    let version: MultiTokenPoolVersion
    try {
      ;({ version } = await resolveMultiTokenPoolContract(chain, pcm, [POOL_CONFIG_MANAGER_TYPE]))
    } catch (cause) {
      throw new CCTParamsInvalidError(this.name, param, `${pcm} is not a PoolConfigManager`, {
        cause: cause instanceof Error ? cause : undefined,
      })
    }
    const { state, staticConfig } = await readMultiTokenPoolRecordState(chain, pcm, version, {
      blockTag,
    })
    const stores = Object.fromEntries(
      policyStoresOf(staticConfig).map(([t, a]) => [t, getAddress(a)]),
    ) as Record<PolicyStoreType, string>
    return {
      version,
      state,
      config: { tokenAdminRegistry: getAddress(staticConfig.tokenAdminRegistry), stores },
    }
  }

  /** Whether each of a PCM's stores lists `pcm` among its authorized callers. */
  async #storeAuthorizes(chain: EVMChain, config: PcmConfig, pcm: string, blockTag: number) {
    return Object.fromEntries(
      await Promise.all(
        POLICY_STORE_TYPES.map(async (t) => [
          t,
          (await readAllAuthorizedCallers(chain, config.stores[t], { blockTag })).includes(pcm),
        ]),
      ),
    ) as Record<PolicyStoreType, boolean>
  }

  /** The lanes `pcm` resolves for tokens the registry routes to `pool`, as sorted keys. */
  async #servedLanes(
    chain: EVMChain,
    pcm: string,
    { version, state, config }: PcmRead,
    pool: string,
    blockTag: number,
  ) {
    const tokens = state.tokens.map((t) => t.tokenAddress)
    const { entries } = await readPoolsServingPoolConfigManager(chain, {
      poolConfigManager: pcm,
      version,
      tokenAdminRegistry: config.tokenAdminRegistry,
      tokens,
      blockTag,
    })
    return tokens
      .filter((t) => entries.get(getAddress(t))?.pool === getAddress(pool))
      .flatMap((tokenAddress) =>
        multiTokenPoolSupportedChains(state, tokenAddress).map((remoteChainSelector) => ({
          tokenAddress,
          remoteChainSelector,
          key: laneKey(tokenAddress, remoteChainSelector),
        })),
      )
      .sort((a, b) => a.key.localeCompare(b.key))
  }

  /**
   * Refuses another registry, a same-store PCM some store does not authorize, and other stores while
   * the pool serves lanes.
   */
  protected encode(
    _chain: EVMChain,
    { poolConfigManager }: SetPoolConfigManagerParams,
    ctx: MultiTokenPoolOwnedWriteContext,
  ): string {
    const old = ctx.facts[PATHS.config('old')] as PcmConfig
    const next = ctx.facts[PATHS.config('new')] as PcmConfig
    if (poolConfigManager === ctx.facts[PATHS.current])
      throw this.refuse(
        'poolConfigManager',
        `the pool already calls ${poolConfigManager}: the write changes nothing`,
      )
    if (next.tokenAdminRegistry !== old.tokenAdminRegistry)
      throw this.refuse(
        'poolConfigManager',
        `uses TokenAdminRegistry ${next.tokenAdminRegistry}, but the pool's tokens are registered in ${old.tokenAdminRegistry}`,
      )
    const served = ctx.facts[PATHS.lanes('old')] as string[] | undefined
    if (served === undefined) {
      const authorizes = ctx.facts[PATHS.callers('new')] as Record<PolicyStoreType, boolean>
      const missing = POLICY_STORE_TYPES.filter((t) => !authorizes[t])
      if (missing.length)
        throw this.refuse(
          'poolConfigManager',
          `is not an authorized caller of ${missing.map((t) => `${t} ${next.stores[t]}`).join(', ')}: every validate call would revert and stop the pool. Authorize it first (updatePolicyStoreAuthorizedCallers)`,
        )
    } else if (served.length)
      throw this.refuse(
        'poolConfigManager',
        `uses other policy stores than the pool's PoolConfigManager while the pool serves ${served.length} lane(s) (${served.join(', ')}): another configuration, and none of its pauses. Move the tokens first, or use replacePoolConfigManager`,
      )
    return ownedTargetInterface(ctx).encodeFunctionData(multiTokenPoolFunctionOf(this.name), [
      poolConfigManager,
    ])
  }

  /**
   * Over other stores, every lane the new PCM resolves for the pool's tokens runs the lane check;
   * the replaced PCM's store authorizations are follow-ups unless another pool still uses it.
   */
  protected override async judge(
    chain: EVMChain,
    { poolConfigManager, getChain }: SetPoolConfigManagerParams,
    ctx: MultiTokenPoolOwnedWriteContext,
  ): Promise<MultiTokenPoolOwnedWriteImpact> {
    const current = ctx.facts[PATHS.current] as string
    const old = ctx.facts[PATHS.config('old')] as PcmConfig
    const oldAuthorizes = ctx.facts[PATHS.callers('old')] as Record<PolicyStoreType, boolean>
    const shared = ctx.facts[PATHS.shared] as string[]
    const followUps: MultiTokenPoolFollowUp[] = shared.length
      ? []
      : POLICY_STORE_TYPES.filter((t) => oldAuthorizes[t]).map((t) => ({
          operation: 'updatePolicyStoreAuthorizedCallers',
          target: old.stores[t],
          reason: `the replaced PoolConfigManager ${current} still writes this ${t} (F4): remove it once the switch landed`,
          inputs: { policyStore: old.stores[t], removedCallers: [current] },
        }))
    const lanes = ((ctx.facts[PATHS.lanes('new')] as string[] | undefined) ?? []).map((k) => {
      const [tokenAddress, chainSelector] = k.split(':')
      return { tokenAddress: tokenAddress!, remoteChainSelector: BigInt(chainSelector!) }
    })
    const { version } = await resolveMultiTokenPoolContract(chain, poolConfigManager, [
      POOL_CONFIG_MANAGER_TYPE,
    ])
    const findings: MultiTokenPoolLaneFinding[] = []
    for (const lane of lanes) {
      const { findings: f } = await this.#laneCheck.checkWith(
        chain,
        { ...lane, poolAddress: ctx.address, ...(getChain && { getChain }) },
        ctx.address,
        { address: poolConfigManager, version },
      )
      findings.push(...f)
    }
    const errors = findings.filter((f) => f.severity === 'error')
    if (errors.length)
      throw new CCTParamsInvalidError(
        this.name,
        'guards',
        `the new PoolConfigManager serves ${lanes.length} lane(s) of the pool with ${errors.length} problem(s): ${errors
          .map((f) => `${f.check} on ${f.tokenAddress} → ${f.remoteChainSelector}: ${f.reason}`)
          .join('; ')}`,
        { context: { findings: errors } },
      )
    return {
      affectedLanes: lanes,
      goingLive: lanes.map((l) => ({ ...l, directions: ['outbound', 'inbound'] })),
      warnings: findings.filter((f) => f.severity !== 'error'),
      ...(followUps.length && { followUps }),
    }
  }

  /** The pool and the PCM are the calldata. */
  override paramsFromCalldata(
    args: Result,
    target: string,
    sender: string,
  ): SetPoolConfigManagerParams {
    return { poolAddress: target, poolConfigManager: getAddress(String(args[0])), sender }
  }
}
