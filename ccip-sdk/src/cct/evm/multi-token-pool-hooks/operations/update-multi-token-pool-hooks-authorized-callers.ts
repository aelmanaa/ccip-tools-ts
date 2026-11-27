/**
 * updateMultiTokenPoolHooksAuthorizedCallers — `applyAuthorizedCallerUpdates` on a multi-token pool
 * hook contract: adds or removes the pools allowed to call it.
 *
 * @remarks A pool removed from the callers can no longer run `preflightCheck` / `postflightCheck`, so
 * every lane it serves whose resolved hook is this contract stops, and its in-flight inbound messages
 * fail. The op enumerates those lanes (of the given `poolConfigManagers`, and always of the removed
 * pool's own PCM) and refuses unless each is listed in `confirmClosing`. The lanes are sealed: the
 * snapshot check re-reads them. Validation of the lists is main's (`parseAuthorizedCallerUpdates`).
 *
 * @packageDocumentation
 */

import { type Result, getAddress } from 'ethers'

import type { EVMChain } from '../../../../evm/index.ts'
import type { MultiTokenPoolLaneKey } from '../../../multi-token-pool.ts'
import {
  parseAuthorizedCallerUpdates,
  readAllAuthorizedCallers,
} from '../../advanced-pool-hooks/contracts.ts'
import {
  MultiTokenPoolVersion,
  POOL_CONFIG_MANAGER_TYPE,
  multiTokenPoolFunctionOf,
  resolveMultiTokenPoolContract,
} from '../../multi-token-pool/contracts.ts'
import {
  type MultiTokenPoolOwnedWriteContext,
  MultiTokenPoolOwnedWriteOperation,
  ownedTargetInterface,
} from '../../multi-token-pool/owned-write-operation.ts'
import type { MultiTokenPoolUnsignedTx } from '../../multi-token-pool/write-operation.ts'
import { validateMultiTokenPoolGuardOptions } from '../../pool-config-manager/guards.ts'
import {
  laneKey,
  multiTokenPoolSupportedChains,
  resolveMultiTokenPoolLanes,
} from '../../pool-config-manager/projection.ts'
import { readMultiTokenPoolRecordState } from '../../pool-config-manager/record-state.ts'
import {
  poolConfigManagerOf,
  readPoolsServingPoolConfigManager,
} from '../../pool-config-manager/serving-pools.ts'
import { assertUnique, validateArray, validateNonZeroAddress } from '../../validate.ts'

/** `updateMultiTokenPoolHooksAuthorizedCallers`. Hooks owner. */
export type UpdateMultiTokenPoolHooksAuthorizedCallersParams = {
  /** The hook contract. */
  hooks: string
  /** Pools to authorize. */
  addedCallers?: string[]
  /** Pools to deauthorize (removed before the additions, as on chain). */
  removedCallers?: string[]
  /**
   * PCMs whose lanes may resolve to these hooks; their lanes are enumerated for the removal check.
   * A removed pool's own PCM is always enumerated.
   */
  poolConfigManagers?: string[]
  /** Lanes the caller agrees to stop by removing a serving pool (each lane whose hook is this contract). */
  confirmClosing?: MultiTokenPoolLaneKey[]
  /** The hooks owner; optional when generating an unsigned transaction. */
  sender?: string
}

type Parsed = UpdateMultiTokenPoolHooksAuthorizedCallersParams & {
  addedCallers: string[]
  removedCallers: string[]
  poolConfigManagers: string[]
  confirmClosing: MultiTokenPoolLaneKey[]
}

const CALLERS_PATH = 'hooks.authorizedCallers'
const lanesPath = (pool: string) => `removed.${pool}.lanes`

/** Adds or removes the pools allowed to call a hook contract. Hooks owner. */
export class UpdateMultiTokenPoolHooksAuthorizedCallers extends MultiTokenPoolOwnedWriteOperation<
  'hooks',
  UpdateMultiTokenPoolHooksAuthorizedCallersParams,
  Parsed,
  MultiTokenPoolUnsignedTx
> {
  readonly name = 'updateMultiTokenPoolHooksAuthorizedCallers'
  protected readonly kind = 'hooks'
  protected override readonly seals = true

  /** Validates the lists as main's authorized-callers op, the PCMs, and the confirmed lanes. */
  protected override prepare(params: UpdateMultiTokenPoolHooksAuthorizedCallersParams): Parsed {
    super.prepare(params)
    const lists = parseAuthorizedCallerUpdates(this.name, params)
    const { poolConfigManagers = [], confirmClosing = [] } = params
    validateArray(this.name, 'poolConfigManagers', poolConfigManagers)
    const pcms = poolConfigManagers.map((p, i) => {
      validateNonZeroAddress(this.name, `poolConfigManagers[${i}]`, p)
      return getAddress(p)
    })
    assertUnique(this.name, 'poolConfigManagers', pcms, (p) => p, 'PoolConfigManager')
    validateMultiTokenPoolGuardOptions(this.name, '', { confirmClosing })
    return { ...params, ...lists, poolConfigManagers: pcms, confirmClosing }
  }

  /**
   * The hooks' callers now, and for each removed pool the lanes it serves whose hook is this
   * contract: of every given PCM and the pool's own, each lane's token routed to the pool by the
   * PCM's registry.
   */
  protected override async readFacts(
    chain: EVMChain,
    { removedCallers, poolConfigManagers }: Parsed,
    { address, blockTag }: Omit<MultiTokenPoolOwnedWriteContext, 'facts'>,
  ): Promise<Record<string, unknown>> {
    const [callers, removed] = await Promise.all([
      readAllAuthorizedCallers(chain, address, { blockTag }),
      Promise.all(
        removedCallers.map(async (pool) => {
          const own = await poolConfigManagerOf(
            chain,
            pool,
            MultiTokenPoolVersion.V2_1_0_DEV,
            blockTag,
          )
          const pcms = [...new Set([...poolConfigManagers, ...(own ? [own] : [])])]
          const lanes = (
            await Promise.all(
              pcms.map((pcm) => this.#servedHookLanes(chain, pcm, pool, address, blockTag)),
            )
          )
            .flat()
            .sort()
          return [lanesPath(pool), lanes] as const
        }),
      ),
    ])
    return { [CALLERS_PATH]: [...callers].sort(), ...Object.fromEntries(removed) }
  }

  /** The lanes of `pcm` whose resolved hook is `hooks` and whose token the registry routes to `pool`. */
  async #servedHookLanes(
    chain: EVMChain,
    pcm: string,
    pool: string,
    hooks: string,
    blockTag: number,
  ): Promise<string[]> {
    const { version } = await resolveMultiTokenPoolContract(chain, pcm, [POOL_CONFIG_MANAGER_TYPE])
    const { state, staticConfig } = await readMultiTokenPoolRecordState(chain, pcm, version, {
      blockTag,
    })
    const keys = state.tokens.flatMap((t) =>
      multiTokenPoolSupportedChains(state, t.tokenAddress).map((remoteChainSelector) => ({
        tokenAddress: t.tokenAddress,
        remoteChainSelector,
      })),
    )
    const onHooks = resolveMultiTokenPoolLanes(state, keys).filter(
      (l) => l.verification.hook !== null && getAddress(l.verification.hook) === hooks,
    )
    if (!onHooks.length) return []
    const { entries } = await readPoolsServingPoolConfigManager(chain, {
      poolConfigManager: pcm,
      version,
      tokenAdminRegistry: staticConfig.tokenAdminRegistry,
      tokens: [...new Set(onHooks.map((l) => l.tokenAddress))],
      blockTag,
    })
    return onHooks
      .filter((l) => entries.get(getAddress(l.tokenAddress))?.pool === getAddress(pool))
      .map((l) => laneKey(l.tokenAddress, l.remoteChainSelector))
  }

  /** The confirmed lanes, and the PCMs the build enumerated (no calldata carries either). */
  protected override confirmations({
    confirmClosing,
    poolConfigManagers,
  }: Parsed): Record<string, unknown> {
    return {
      ...(confirmClosing.length && {
        closing: confirmClosing.map((l) => laneKey(l.tokenAddress, l.remoteChainSelector)).sort(),
      }),
      ...(poolConfigManagers.length && { poolConfigManagers: [...poolConfigManagers].sort() }),
    }
  }

  /** Refuses removing a pool that serves lanes on these hooks, unless each lane is in `confirmClosing`. */
  protected encode(
    _chain: EVMChain,
    { addedCallers, removedCallers, confirmClosing }: Parsed,
    ctx: MultiTokenPoolOwnedWriteContext,
  ): string {
    const confirmed = new Set(
      confirmClosing.map((l) => laneKey(l.tokenAddress, l.remoteChainSelector)),
    )
    removedCallers.forEach((pool, i) => {
      const open = (ctx.facts[lanesPath(pool)] as string[]).filter((l) => !confirmed.has(l))
      if (open.length)
        throw this.refuse(
          `removedCallers[${i}]`,
          `${pool} serves lanes whose hook is ${ctx.address} (${open.join(', ')}): removing it makes their preflight and postflight checks revert, which stops them and fails their in-flight inbound messages. List them in confirmClosing to proceed`,
        )
    })
    return ownedTargetInterface(ctx).encodeFunctionData(multiTokenPoolFunctionOf(this.name), [
      { addedCallers, removedCallers },
    ])
  }

  /** The hooks, both lists, and the closing the proposal confirmed (the PCMs are re-derived). */
  override paramsFromCalldata(
    args: Result,
    target: string,
    sender: string,
    sealed: Record<string, unknown>,
  ): UpdateMultiTokenPoolHooksAuthorizedCallersParams {
    const update = args[0] as { addedCallers: string[]; removedCallers: string[] }
    const closing = sealed['confirm.closing']
    const pcms = sealed['confirm.poolConfigManagers']
    return {
      hooks: target,
      addedCallers: [...update.addedCallers].map((c) => getAddress(c)),
      removedCallers: [...update.removedCallers].map((c) => getAddress(c)),
      ...(Array.isArray(closing) && {
        confirmClosing: (closing as string[]).map((k) => {
          const [tokenAddress, chain] = k.split(':')
          return { tokenAddress: tokenAddress!, remoteChainSelector: BigInt(chain!) }
        }),
      }),
      ...(Array.isArray(pcms) && { poolConfigManagers: pcms as string[] }),
      sender,
    }
  }
}
