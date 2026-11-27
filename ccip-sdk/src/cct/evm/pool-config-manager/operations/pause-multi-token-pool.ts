/**
 * The PoolConfigManager pauses: global, per token and per chain, each with its unpause. A pause is
 * the emergency action, so it never reads remote facts and never refuses on what is wrong with the
 * lanes it stops; an unpause makes lanes live, so it runs every lane rule without attestations.
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

import type { EVMChain } from '../../../../evm/index.ts'
import {
  type MultiTokenPoolSingleFunctionOperation,
  type PoolConfigManagerRole,
  POOL_CONFIG_MANAGER_TYPE,
  getMultiTokenPoolInterface,
  multiTokenPoolFunctionOf,
  poolConfigManagerContract,
} from '../../multi-token-pool/contracts.ts'
import {
  assertUnique,
  validateAddressArray,
  validateArray,
  validateOneOf,
  validateUint64,
} from '../../validate.ts'
import { readChainPauseFlags } from '../contracts.ts'
import { tokenRecordsOf } from '../projection.ts'
import { type PauseDirection, PAUSE_DIRECTIONS } from '../records.ts'
import {
  type MultiTokenPoolWriteGuards,
  type PoolConfigManagerWrite,
  type PoolConfigManagerWriteContext,
  type PoolConfigManagerWriteParams,
  PoolConfigManagerWriteOperation,
} from '../write-operation.ts'

/** Parameters of `pauseMultiTokenPoolGlobally`. */
export type PauseMultiTokenPoolGloballyParams = PoolConfigManagerWriteParams
/** Parameters of `unpauseMultiTokenPoolGlobally`; it re-judges every lane. */
export type UnpauseMultiTokenPoolGloballyParams = PoolConfigManagerWriteParams &
  MultiTokenPoolWriteGuards

/** Parameters of `pauseMultiTokenPoolTokens`. A token may be paused before it is registered. */
export type PauseMultiTokenPoolTokensParams = PoolConfigManagerWriteParams & {
  /** The tokens, at least one, each once. */
  tokenAddresses: string[]
  /** The directions to pause. */
  direction: PauseDirection
}
/** Parameters of `unpauseMultiTokenPoolTokens`; it re-judges the tokens' lanes. */
export type UnpauseMultiTokenPoolTokensParams = PauseMultiTokenPoolTokensParams &
  MultiTokenPoolWriteGuards

/** Parameters of `pauseMultiTokenPoolChains`. */
export type PauseMultiTokenPoolChainsParams = PoolConfigManagerWriteParams & {
  /** The remote chains, at least one, each once. */
  remoteChainSelectors: bigint[]
  /** The directions to pause. */
  direction: PauseDirection
}
/** Parameters of `unpauseMultiTokenPoolChains`; it re-judges every lane to those chains. */
export type UnpauseMultiTokenPoolChainsParams = PauseMultiTokenPoolChainsParams &
  MultiTokenPoolWriteGuards

type PauseParams = PoolConfigManagerWriteParams &
  MultiTokenPoolWriteGuards & {
    tokenAddresses?: string[]
    remoteChainSelectors?: bigint[]
    direction?: PauseDirection
  }

/**
 * Base of the six pause writes: the scope (global, tokens, chains) and whether it pauses.
 * @internal
 */
abstract class PauseWriteOperation<
  P extends PauseParams,
> extends PoolConfigManagerWriteOperation<P> {
  /** The op; its PCM function comes from the op map. */
  abstract override readonly name: MultiTokenPoolSingleFunctionOperation
  /** What is paused. */
  protected abstract readonly scope: 'global' | 'tokens' | 'chains'
  /** `true` to pause, `false` to unpause. */
  protected abstract readonly pauses: boolean

  protected override prepare(params: P): P {
    super.prepare(params)
    if (this.scope === 'global') return params
    validateOneOf(this.name, 'direction', params.direction, PAUSE_DIRECTIONS)
    if (this.scope === 'tokens') {
      validateAddressArray(this.name, 'tokenAddresses', params.tokenAddresses, 1)
      const tokenAddresses = params.tokenAddresses!.map((t) => getAddress(t))
      assertUnique(this.name, 'tokenAddresses', tokenAddresses, (t) => t, 'token')
      return { ...params, tokenAddresses }
    }
    validateArray(this.name, 'remoteChainSelectors', params.remoteChainSelectors, 1)
    Array.from(params.remoteChainSelectors!, (c, i) =>
      validateUint64(this.name, `remoteChainSelectors[${i}]`, c),
    )
    assertUnique(this.name, 'remoteChainSelectors', params.remoteChainSelectors!, String, 'chain')
    return params
  }

  protected gate(): readonly PoolConfigManagerRole[] {
    return ['DEFAULT_ADMIN_ROLE', this.pauses ? 'PAUSER_ROLE' : 'UNPAUSER_ROLE']
  }

  // a pause is never judged (the guard reads that from the calldata); an unpause makes lanes live:
  // no attestations
  protected override makesLive(): boolean {
    return !this.pauses
  }

  protected async encode(
    chain: EVMChain,
    params: P,
    { address, version, blockTag, state }: PoolConfigManagerWriteContext,
  ): Promise<PoolConfigManagerWrite> {
    const iface = getMultiTokenPoolInterface(POOL_CONFIG_MANAGER_TYPE, version)
    const fn = multiTokenPoolFunctionOf(this.name)
    const direction = PAUSE_DIRECTIONS.indexOf(params.direction ?? 'both')
    const data =
      this.scope === 'global'
        ? iface.encodeFunctionData(fn, [])
        : iface.encodeFunctionData(fn, [
            this.scope === 'tokens' ? params.tokenAddresses : params.remoteChainSelectors,
            direction,
          ])
    // the values the write replaces: each pause flag as it is (a chain no record names is read)
    const named = params.remoteChainSelectors ?? []
    const known = new Set(state.chainPauses.map((p) => p.remoteChainSelector))
    const extra = named.length
      ? (
          await readChainPauseFlags(
            poolConfigManagerContract(chain, address, version),
            address,
            named.filter((c) => !known.has(c)),
            blockTag,
          )
        ).chains
      : []
    const expected =
      this.scope === 'global'
        ? { 'pauses.global': state.isGloballyPaused }
        : this.scope === 'tokens'
          ? Object.fromEntries(
              params.tokenAddresses!.map((t) => {
                const token = tokenRecordsOf(state, t)
                return [
                  `pauses.token.${t}`,
                  {
                    outbound: token?.isOutboundPaused ?? false,
                    inbound: token?.isInboundPaused ?? false,
                  },
                ]
              }),
            )
          : Object.fromEntries(
              params.remoteChainSelectors!.map((c) => {
                const p = [...state.chainPauses, ...extra].find((x) => x.remoteChainSelector === c)
                return [
                  `pauses.chain.${c}`,
                  { outbound: p?.outbound ?? false, inbound: p?.inbound ?? false },
                ]
              }),
            )
    return { data, expected }
  }
}

/**
 * Pauses every token on every chain (`pauseGlobally`). Token and chain flags survive it.
 * @throws {@link CCTParamsInvalidError} if a param is invalid, or `sender` lacks the gate
 */
export class PauseMultiTokenPoolGlobally extends PauseWriteOperation<PauseMultiTokenPoolGloballyParams> {
  readonly name = 'pauseMultiTokenPoolGlobally'
  protected readonly scope = 'global'
  protected readonly pauses = true
}

/**
 * Lifts the global pause (`unpauseGlobally`), re-judging every lane it makes live.
 * @throws {@link CCTParamsInvalidError} if a param is invalid, `sender` lacks the gate, or a lane
 *   guard refuses a lane the unpause makes live
 */
export class UnpauseMultiTokenPoolGlobally extends PauseWriteOperation<UnpauseMultiTokenPoolGloballyParams> {
  readonly name = 'unpauseMultiTokenPoolGlobally'
  protected readonly scope = 'global'
  protected readonly pauses = false
}

/**
 * Pauses tokens on every chain in a direction (`pauseTokens`).
 * @throws {@link CCTParamsInvalidError} if a param is invalid, or `sender` lacks the gate
 */
export class PauseMultiTokenPoolTokens extends PauseWriteOperation<PauseMultiTokenPoolTokensParams> {
  readonly name = 'pauseMultiTokenPoolTokens'
  protected readonly scope = 'tokens'
  protected readonly pauses = true
}

/**
 * Lifts token pauses in a direction (`unpauseTokens`), re-judging the lanes it makes live.
 * @throws {@link CCTParamsInvalidError} if a param is invalid, `sender` lacks the gate, or a lane
 *   guard refuses a lane the unpause makes live
 */
export class UnpauseMultiTokenPoolTokens extends PauseWriteOperation<UnpauseMultiTokenPoolTokensParams> {
  readonly name = 'unpauseMultiTokenPoolTokens'
  protected readonly scope = 'tokens'
  protected readonly pauses = false
}

/**
 * Pauses remote chains for every token in a direction (`pauseChains`).
 * @throws {@link CCTParamsInvalidError} if a param is invalid, or `sender` lacks the gate
 */
export class PauseMultiTokenPoolChains extends PauseWriteOperation<PauseMultiTokenPoolChainsParams> {
  readonly name = 'pauseMultiTokenPoolChains'
  protected readonly scope = 'chains'
  protected readonly pauses = true
}

/**
 * Lifts chain pauses in a direction (`unpauseChains`), re-judging the lanes it makes live.
 * @throws {@link CCTParamsInvalidError} if a param is invalid, `sender` lacks the gate, or a lane
 *   guard refuses a lane the unpause makes live
 */
export class UnpauseMultiTokenPoolChains extends PauseWriteOperation<UnpauseMultiTokenPoolChainsParams> {
  readonly name = 'unpauseMultiTokenPoolChains'
  protected readonly scope = 'chains'
  protected readonly pauses = false
}
