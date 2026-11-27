/**
 * setMultiTokenPoolRouter — `pool.setRouter(newRouter)`: points a multi-token pool at a new Router.
 *
 * @remarks The pool accepts `lockOrBurn` from the Router's OnRamps (`_onlyOnRamp`) and
 * `releaseOrMint` from its OffRamps, for every chain at once and from the next block (F8). So:
 * - every OffRamp the current Router lists for a chain the pool serves must stay listed, or the
 *   messages in flight from that chain can no longer execute;
 * - a chain the new Router adds an OnRamp for (or OffRamps for) has its lanes made live in that
 *   direction: each runs the lane check (`checkMultiTokenPoolLane`, no attestations), and any error
 *   finding refuses the write.
 * The Router's ramps are read from the chain (`getOnRamp`, `getOffRamps`), never from an address
 * table. What the write is judged on is sealed: the snapshot check re-reads it.
 *
 * @packageDocumentation
 */

import { type Result, ZeroAddress, getAddress } from 'ethers'

import type { ChainGetter } from '../../../../chain.ts'
import type { EVMChain } from '../../../../evm/index.ts'
import { resultToObject } from '../../../../evm/types.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import type { MultiTokenPoolLaneFinding } from '../../../multi-token-pool.ts'
import type { MultiTokenPoolLaneDirections } from '../../pool-config-manager/contracts.ts'
import { CheckMultiTokenPoolLane } from '../../pool-config-manager/operations/check-multi-token-pool-lane.ts'
import { multiTokenPoolSupportedChains } from '../../pool-config-manager/projection.ts'
import { readMultiTokenPoolRecordState } from '../../pool-config-manager/record-state.ts'
import { validateNonZeroAddress } from '../../validate.ts'
import {
  POOL_CONFIG_MANAGER_TYPE,
  multiTokenPoolContract,
  multiTokenPoolFunctionOf,
  resolveMultiTokenPoolContract,
} from '../contracts.ts'
import {
  type MultiTokenPoolOwnedWriteContext,
  type MultiTokenPoolOwnedWriteImpact,
  MultiTokenPoolOwnedWriteOperation,
  ownedTargetInterface,
} from '../owned-write-operation.ts'
import type { MultiTokenPoolUnsignedTx } from '../write-operation.ts'

/** `setMultiTokenPoolRouter`. Pool owner. */
export type SetMultiTokenPoolRouterParams = {
  /** The multi-token pool. */
  poolAddress: string
  /** The new Router; it must list every OffRamp the current one lists for the pool's chains. */
  router: string
  /** Resolves the remote chains the lane check reads, for chains the new Router opens. */
  getChain?: ChainGetter
  /** The pool owner; optional when generating an unsigned transaction. */
  sender?: string
}

/** One chain's ramps on the current and the new Router, as sealed. */
type ChainRamps = { onRamp: [string, string]; offRamps: [string[], string[]] }

const ROUTER_PATH = 'pool.router'
const rampsPath = (chain: bigint) => `ramps.${chain}`

/** Points a multi-token pool at a new Router. Pool owner. */
export class SetMultiTokenPoolRouter extends MultiTokenPoolOwnedWriteOperation<
  'pool',
  SetMultiTokenPoolRouterParams,
  SetMultiTokenPoolRouterParams,
  MultiTokenPoolUnsignedTx
> {
  readonly name = 'setMultiTokenPoolRouter'
  protected readonly kind = 'pool'
  protected override readonly seals = true
  readonly #laneCheck = new CheckMultiTokenPoolLane()

  /** Validates the Router as main's `setDynamicConfig` (non-zero), before any RPC. */
  protected override prepare(params: SetMultiTokenPoolRouterParams): SetMultiTokenPoolRouterParams {
    super.prepare(params)
    validateNonZeroAddress(this.name, 'router', params.router)
    return { ...params, router: getAddress(params.router) }
  }

  /**
   * The current Router, and for each chain the pool's PCM has a lane to, the OnRamp and OffRamps on
   * the current and the new Router.
   */
  protected override async readFacts(
    chain: EVMChain,
    { router }: SetMultiTokenPoolRouterParams,
    { address, version, blockTag }: Omit<MultiTokenPoolOwnedWriteContext, 'facts'>,
  ): Promise<Record<string, unknown>> {
    const pool = multiTokenPoolContract(chain, address, version)
    const [current, pcmAddress] = await Promise.all([
      pool.getRouter({ blockTag }).then((r) => getAddress(resultToObject(r))),
      pool.getPoolConfigManager({ blockTag }).then((r) => getAddress(resultToObject(r))),
    ])
    const pcm = await resolveMultiTokenPoolContract(chain, pcmAddress, [POOL_CONFIG_MANAGER_TYPE])
    const { state } = await readMultiTokenPoolRecordState(chain, pcmAddress, pcm.version, {
      blockTag,
    })
    const chains = [
      ...new Set(state.tokens.flatMap((t) => multiTokenPoolSupportedChains(state, t.tokenAddress))),
    ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const ramps = await Promise.all(
      chains.map(async (c): Promise<[string, ChainRamps]> => {
        const [onOld, onNew, offOld, offNew] = await Promise.all([
          this.#onRamp(chain, current, c),
          this.#onRamp(chain, router, c),
          this.#offRamps(chain, current, c),
          this.#offRamps(chain, router, c),
        ])
        return [rampsPath(c), { onRamp: [onOld, onNew], offRamps: [offOld, offNew] }]
      }),
    )
    return { [ROUTER_PATH]: current, ...Object.fromEntries(ramps) }
  }

  /** A Router's OnRamp for `chain` (`ZeroAddress` when none); a contract that is no Router is refused. */
  async #onRamp(chain: EVMChain, router: string, remote: bigint): Promise<string> {
    try {
      return getAddress(await chain.getOnRampForRouter(router, remote))
    } catch (cause) {
      throw new CCTParamsInvalidError(
        this.name,
        'router',
        `${router} answers no getOnRamp: it is not a Router`,
        {
          cause: cause instanceof Error ? cause : undefined,
        },
      )
    }
  }

  /** A Router's OffRamps for `chain`, sorted. */
  async #offRamps(chain: EVMChain, router: string, remote: bigint): Promise<string[]> {
    try {
      return (await chain.getOffRampsForRouter(router, remote)).map((o) => getAddress(o)).sort()
    } catch (cause) {
      throw new CCTParamsInvalidError(
        this.name,
        'router',
        `${router} answers no getOffRamps: it is not a Router`,
        {
          cause: cause instanceof Error ? cause : undefined,
        },
      )
    }
  }

  /** Refuses a chain whose current OffRamps the new Router drops (messages in flight would strand). */
  protected encode(
    _chain: EVMChain,
    { router }: SetMultiTokenPoolRouterParams,
    ctx: MultiTokenPoolOwnedWriteContext,
  ): string {
    for (const [path, value] of Object.entries(ctx.facts)) {
      if (!path.startsWith('ramps.')) continue
      const { offRamps } = value as ChainRamps
      const dropped = offRamps[0].filter((o) => !offRamps[1].includes(o))
      if (dropped.length)
        throw this.refuse(
          'router',
          `${router} does not list the OffRamps ${dropped.join(', ')} the current Router lists for chain ${path.slice('ramps.'.length)}: messages in flight from it could no longer execute on this pool`,
        )
    }
    return ownedTargetInterface(ctx).encodeFunctionData(multiTokenPoolFunctionOf(this.name), [
      router,
    ])
  }

  /**
   * The lanes the new Router makes live (an OnRamp, or OffRamps, where the current Router has none)
   * each run the lane check; an error finding refuses the write, the rest are warnings.
   */
  protected override async judge(
    chain: EVMChain,
    { getChain }: SetMultiTokenPoolRouterParams,
    ctx: MultiTokenPoolOwnedWriteContext,
  ): Promise<MultiTokenPoolOwnedWriteImpact> {
    const opened = new Map<bigint, ('outbound' | 'inbound')[]>()
    for (const [path, value] of Object.entries(ctx.facts)) {
      if (!path.startsWith('ramps.')) continue
      const { onRamp, offRamps } = value as ChainRamps
      const directions: ('outbound' | 'inbound')[] = []
      if (onRamp[0] === ZeroAddress && onRamp[1] !== ZeroAddress) directions.push('outbound')
      if (!offRamps[0].length && offRamps[1].length) directions.push('inbound')
      if (directions.length) opened.set(BigInt(path.slice('ramps.'.length)), directions)
    }
    if (!opened.size) return { affectedLanes: [], goingLive: [], warnings: [] }
    const pcmAddress = getAddress(
      resultToObject(
        await multiTokenPoolContract(chain, ctx.address, ctx.version).getPoolConfigManager({
          blockTag: ctx.blockTag,
        }),
      ),
    )
    const pcm = await resolveMultiTokenPoolContract(chain, pcmAddress, [POOL_CONFIG_MANAGER_TYPE])
    const { state } = await readMultiTokenPoolRecordState(chain, pcmAddress, pcm.version, {
      blockTag: ctx.blockTag,
    })
    const goingLive: MultiTokenPoolLaneDirections[] = state.tokens.flatMap((t) =>
      multiTokenPoolSupportedChains(state, t.tokenAddress)
        .filter((c) => opened.has(c))
        .map((c) => ({
          tokenAddress: t.tokenAddress,
          remoteChainSelector: c,
          directions: opened.get(c)!,
        })),
    )
    const findings: MultiTokenPoolLaneFinding[] = []
    for (const lane of goingLive) {
      const { findings: f } = await this.#laneCheck.query(chain, {
        poolAddress: ctx.address,
        tokenAddress: lane.tokenAddress,
        remoteChainSelector: lane.remoteChainSelector,
        expectOpen: lane.directions,
        ...(getChain && { getChain }),
      })
      findings.push(...f)
    }
    const errors = findings.filter((f) => f.severity === 'error')
    if (errors.length)
      throw new CCTParamsInvalidError(
        this.name,
        'guards',
        `the new Router makes ${goingLive.length} lane(s) live with ${errors.length} problem(s): ${errors
          .map((f) => `${f.check} on ${f.tokenAddress} → ${f.remoteChainSelector}: ${f.reason}`)
          .join('; ')}`,
        { context: { findings: errors } },
      )
    return {
      affectedLanes: goingLive.map(({ tokenAddress, remoteChainSelector }) => ({
        tokenAddress,
        remoteChainSelector,
      })),
      goingLive,
      warnings: findings.filter((f) => f.severity !== 'error'),
    }
  }

  /** The pool and the Router are the calldata. */
  override paramsFromCalldata(
    args: Result,
    target: string,
    sender: string,
  ): SetMultiTokenPoolRouterParams {
    return { poolAddress: target, router: getAddress(String(args[0])), sender }
  }
}
