/**
 * The base of every PoolConfigManager write: role pre-flight, the post-state guard on the exact
 * calldata, the reviewer-facing unsigned result, and the re-check right before a signed send.
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

import type { EVMChain } from '../../../evm/index.ts'
import type { UnsignedEVMTx } from '../../../evm/types.ts'
import { ChainFamily } from '../../../networks.ts'
import { CCTParamsInvalidError } from '../../errors.ts'
import {
  type MultiTokenPoolExpectedSnapshot,
  type MultiTokenPoolLaneFinding,
  type MultiTokenPoolRemoteCheckOptions,
  type MultiTokenPoolSnapshot,
  sortFindings,
} from '../../multi-token-pool.ts'
import type { TransactionResult } from '../../operation.ts'
import {
  type MultiTokenPoolVersion,
  type PoolConfigManagerRole,
  poolConfigManagerContract,
  poolConfigManagerRoleId,
} from '../multi-token-pool/contracts.ts'
import { type EVMExecuteParams, EVMOperation } from '../operation.ts'
import { submit } from '../submit.ts'
import { validateAddress } from '../validate.ts'
import {
  type MultiTokenPoolLaneKey,
  type PoolConfigManagerTarget,
  resolvePoolConfigManagerTarget,
  validatePoolConfigManagerTarget,
} from './contracts.ts'
import { runMultiTokenPoolGuards } from './guard-run.ts'
import { type MultiTokenPoolLaneDirections, validateMultiTokenPoolGuardOptions } from './guards.ts'

/** Common fields of every PoolConfigManager write. */
export type PoolConfigManagerWriteParams = PoolConfigManagerTarget & {
  /**
   * The PCM role holder that will execute. Sets `tx.from` and, when given, is checked with one
   * `hasRole` call per role the op's gate accepts. Optional for `generateUnsigned*`; the signed op
   * defaults it to the wallet.
   */
  sender?: string
}

/**
 * The guard options of every lane-affecting write. The op computes every lane the write can change,
 * projects each after the write, and refuses on any error finding; these are confirmations and
 * thresholds, never switches that skip a rule.
 */
export type MultiTokenPoolWriteGuards = MultiTokenPoolRemoteCheckOptions &
  MultiTokenPoolExpectedSnapshot & {
    /** Accept non-empty CCV lists without the default-CCV placeholder `address(0)`. Defaults to `false`. */
    allowDroppingDefaultCCVs?: boolean
    /** Highest resolved transfer fee in bps on any affected lane, both tiers. Defaults to 1,000. */
    maxTransferFeeBps?: number
    /** Lowest resolved `destGasOverhead`. Defaults to 200,000, plus 100,000 when a hook resolves. */
    minDestGasOverhead?: number
    /** Lanes the caller agrees this write closes (connection gone after the write). */
    confirmClosing?: MultiTokenPoolLaneKey[]
    /**
     * Lanes, per direction, the caller agrees this write opens: refused when a lane it opens goes
     * live in a direction not listed. A planner passes its planned lanes.
     */
    confirmOpening?: MultiTokenPoolLaneDirections[]
    /**
     * Remote chains where a lane may accept legacy pool data from a remote multi-token pool: only for
     * a migration window.
     */
    migrationWindowChains?: bigint[]
  }

/**
 * Unsigned output of a multi-token pool write: one transaction, plus what a reviewer of a multisig
 * proposal needs, since the signed path is not the only path.
 */
export type MultiTokenPoolUnsignedTx = UnsignedEVMTx & {
  /**
   * `true` when the projection was cross-checked with `eth_simulateV1` (the write plus the lane views,
   * one block, from `sender`); `false` when the RPC lacks it, or no `sender` was given.
   */
  projectionVerified: boolean
  /** Lanes the write changes. */
  affectedLanes: MultiTokenPoolLaneKey[]
  /** Lanes live in a direction after the write that were not before, with those directions. */
  goingLive: MultiTokenPoolLaneDirections[]
  /** Warning findings on the state after the write (error findings refuse the write). */
  warnings: MultiTokenPoolLaneFinding[]
  /** The state the write was judged on: pass it back as `expectedSnapshot`, or to `checkMultiTokenPoolSnapshot`. */
  snapshot: MultiTokenPoolSnapshot
}

/** Result of a signed multi-token pool write. */
export type MultiTokenPoolTransactionResult = TransactionResult &
  Pick<
    MultiTokenPoolUnsignedTx,
    'projectionVerified' | 'affectedLanes' | 'goingLive' | 'warnings' | 'snapshot'
  >

/** A resolved PCM and the block a write is built at. @internal */
export type PoolConfigManagerWriteContext = {
  /** The PCM. */
  address: string
  /** Its version. */
  version: MultiTokenPoolVersion
  /** The block every read is pinned to. */
  blockTag: number
}

/** What an op encodes: the PCM calldata, and the values it keeps, merges or replaces. @internal */
export type PoolConfigManagerWrite = {
  /** The calldata sent to the PCM. */
  data: string
  /** Values the write keeps, merges or replaces, by dotted path. */
  expected?: Record<string, unknown>
  /** Warnings the op's own checks found (beyond the lane guard's), returned with the guard's. */
  warnings?: MultiTokenPoolLaneFinding[]
}

/**
 * Base of every PoolConfigManager write. Subclasses supply `prepare`, the roles that may send the
 * write, and its calldata.
 * @internal
 */
export abstract class PoolConfigManagerWriteOperation<
  P extends PoolConfigManagerWriteParams & MultiTokenPoolWriteGuards,
  Parsed extends P = P,
> extends EVMOperation<P, Parsed, MultiTokenPoolUnsignedTx> {
  /** The roles the PCM accepts for this write (any one suffices). */
  protected abstract gate(params: Parsed): readonly PoolConfigManagerRole[]

  /** Encodes the write; may read the PCM at `ctx.blockTag` to merge. */
  protected abstract encode(
    chain: EVMChain,
    params: Parsed,
    ctx: PoolConfigManagerWriteContext,
  ): Promise<PoolConfigManagerWrite> | PoolConfigManagerWrite

  /** Context every refusal of this op carries (e.g. a merged op's kind). */
  protected errorContext(_params: Parsed): Record<string, unknown> | undefined {
    return undefined
  }

  /** Validates the target, sender and guard options; subclasses validate their own fields after it. */
  protected override prepare(params: P): Parsed {
    validatePoolConfigManagerTarget(this.name, params)
    validateMultiTokenPoolGuardOptions(this.name, '', params)
    if (params.sender !== undefined) validateAddress(this.name, 'sender', params.sender)
    return params as Parsed
  }

  protected async buildUnsigned(
    chain: EVMChain,
    params: Parsed,
  ): Promise<MultiTokenPoolUnsignedTx> {
    const { address, version } = await resolvePoolConfigManagerTarget(chain, params)
    const blockTag = await chain.provider.getBlockNumber()
    if (params.sender !== undefined)
      await this.#preflightGate(chain, address, version, params, blockTag)
    const { data, expected, warnings } = await this.encode(chain, params, {
      address,
      version,
      blockTag,
    })
    const context = this.errorContext(params)
    const result = await runMultiTokenPoolGuards({
      chain,
      operation: this.name,
      poolConfigManager: address,
      version,
      data,
      blockTag,
      ...(params.poolAddress !== undefined && { poolAddress: params.poolAddress }),
      ...(params.sender !== undefined && { sender: params.sender }),
      ...(expected && { expected }),
      ...(context && { errorContext: context }),
      ...(params.expectedSnapshot && { expectedSnapshot: params.expectedSnapshot }),
      ...(params.getChain && { getChain: params.getChain }),
      ...(params.remoteAttestations && { remoteAttestations: params.remoteAttestations }),
      ...(params.allowDroppingDefaultCCVs !== undefined && {
        allowDroppingDefaultCCVs: params.allowDroppingDefaultCCVs,
      }),
      ...(params.maxTransferFeeBps !== undefined && {
        maxTransferFeeBps: params.maxTransferFeeBps,
      }),
      ...(params.minDestGasOverhead !== undefined && {
        minDestGasOverhead: params.minDestGasOverhead,
      }),
      ...(params.confirmClosing && { confirmClosing: params.confirmClosing }),
      ...(params.confirmOpening && { confirmOpening: params.confirmOpening }),
      ...(params.migrationWindowChains && { migrationWindowChains: params.migrationWindowChains }),
    })
    return {
      family: ChainFamily.EVM,
      transactions: [
        { to: address, data, ...(params.sender !== undefined && { from: params.sender }) },
      ],
      projectionVerified: result.projectionVerified,
      affectedLanes: result.affectedLanes,
      goingLive: result.goingLive,
      warnings: sortFindings([...(warnings ?? []), ...result.warnings]),
      snapshot: result.snapshot,
    }
  }

  /** One `hasRole` per accepted role, at the build block; refused when the sender holds none. */
  async #preflightGate(
    chain: EVMChain,
    address: string,
    version: MultiTokenPoolVersion,
    params: Parsed,
    blockTag: number,
  ): Promise<void> {
    const roles = this.gate(params)
    const pcm = poolConfigManagerContract(chain, address, version)
    const held = await Promise.all(
      roles.map((role) =>
        pcm.hasRole(poolConfigManagerRoleId(role), getAddress(params.sender!), { blockTag }),
      ),
    )
    if (!held.some(Boolean))
      throw new CCTParamsInvalidError(
        this.name,
        'sender',
        `${params.sender} holds none of ${roles.join(', ')} on PoolConfigManager ${address}, which this write needs: send it from a holder, or grant one of the roles first`,
        { context: { ...this.errorContext(params), roles } },
      )
  }

  /**
   * Builds, then rebuilds with the first build's snapshot right before sending (any movement in
   * between throws `CCTStateChangedError`), then signs and submits.
   */
  override async execute(
    chain: EVMChain,
    params: EVMExecuteParams<P>,
  ): Promise<MultiTokenPoolTransactionResult> {
    const sender = await this.resolveWalletSender(params.wallet, params.sender)
    const first = await this.generate(chain, { ...params, sender })
    const unsigned = await this.generate(chain, {
      ...params,
      sender,
      expectedSnapshot: params.expectedSnapshot ?? first.snapshot,
    })
    const { response } = await submit(chain, params.wallet, unsigned, this.name)
    return {
      hash: response.hash,
      projectionVerified: unsigned.projectionVerified,
      affectedLanes: unsigned.affectedLanes,
      goingLive: unsigned.goingLive,
      warnings: unsigned.warnings,
      snapshot: unsigned.snapshot,
    }
  }
}
