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
import type {
  MultiTokenPoolExpectedSnapshot,
  MultiTokenPoolLaneFinding,
  MultiTokenPoolRemoteCheckOptions,
  MultiTokenPoolSnapshot,
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
  type MultiTokenPoolLaneDirections,
  type MultiTokenPoolLaneKey,
  type PoolConfigManagerTarget,
  resolvePoolConfigManagerTarget,
  validatePoolConfigManagerTarget,
} from './contracts.ts'
import { type MultiTokenPoolSimulatedFrom, runMultiTokenPoolGuards } from './guard-run.ts'
import {
  type MultiTokenPoolRecordStateRead,
  readMultiTokenPoolRecordState,
} from './record-state.ts'

export type { MultiTokenPoolSimulatedFrom } from './guard-run.ts'
export type { MultiTokenPoolGuardOptions } from './guards.ts'
import { type MultiTokenPoolGuardOptions, validateMultiTokenPoolGuardOptions } from './guards.ts'

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
  MultiTokenPoolExpectedSnapshot &
  MultiTokenPoolGuardOptions

/**
 * Unsigned output of a multi-token pool write: one transaction, plus its impact on the lanes for a
 * reviewer of a multisig proposal. The new values are in the calldata; `snapshot.expected` holds the
 * values the write replaces, as they were when it was built.
 */
export type MultiTokenPoolUnsignedTx = UnsignedEVMTx & {
  /**
   * `true` when the projection was cross-checked with `eth_simulateV1` (the write plus the lane views,
   * one block); `false` when the RPC lacks it, or the write was not simulated.
   */
  projectionVerified: boolean
  /**
   * Who the write was simulated from: `'sender'` (the PCM role gate included), or, with no `sender`,
   * `'pcm'`: each store call the PCM forwards, from the PCM, so every store-level revert is caught
   * but the PCM role gate is not checked. `'none'`: a write that reaches no store, not simulated.
   */
  simulatedFrom: MultiTokenPoolSimulatedFrom
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
    'projectionVerified' | 'simulatedFrom' | 'affectedLanes' | 'goingLive' | 'warnings' | 'snapshot'
  >

/**
 * A resolved PCM, the block a write is built at, and the PCM's stored records read once at that
 * block (the op and the guard share the read).
 * @internal
 */
export type PoolConfigManagerWriteContext = Pick<
  MultiTokenPoolRecordStateRead,
  'state' | 'staticConfig' | 'policyNames'
> & {
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

  /**
   * Whether the write can make lanes live (an unpause): its guard then never uses attestations.
   * Defaults to `false`.
   */
  protected makesLive(_params: Parsed): boolean {
    return false
  }

  /**
   * Whether the lane rules judge this write. `false` only for a pause, the emergency action: it is
   * still gated, simulated and sealed. Defaults to `true`.
   */
  protected judgesLanes(_params: Parsed): boolean {
    return true
  }

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
      await this.#preflightGate(chain, address, version, params, params.sender, blockTag)
    // the stored records, read once: the op checks and encodes from them, the guard judges on them
    const read = await readMultiTokenPoolRecordState(chain, address, version, { blockTag })
    const { data, expected } = await this.encode(chain, params, {
      address,
      version,
      blockTag,
      state: read.state,
      staticConfig: read.staticConfig,
      policyNames: read.policyNames,
    })
    const context = this.errorContext(params)
    const result = await runMultiTokenPoolGuards({
      chain,
      operation: this.name,
      poolConfigManager: address,
      version,
      data,
      blockTag,
      stateRead: read,
      ...(params.poolAddress !== undefined && { poolAddress: params.poolAddress }),
      ...(params.sender !== undefined && { sender: params.sender }),
      ...(expected && { expected }),
      ...(context && { errorContext: context }),
      ...(this.makesLive(params) && { makesLive: true }),
      ...(!this.judgesLanes(params) && { judgeLanes: false }),
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
      ...(params.confirmDropped && { confirmDropped: params.confirmDropped }),
      ...(params.migrationWindowChains && { migrationWindowChains: params.migrationWindowChains }),
    })
    return {
      family: ChainFamily.EVM,
      transactions: [
        { to: address, data, ...(params.sender !== undefined && { from: params.sender }) },
      ],
      projectionVerified: result.projectionVerified,
      simulatedFrom: result.simulatedFrom,
      affectedLanes: result.affectedLanes,
      goingLive: result.goingLive,
      warnings: result.warnings,
      snapshot: result.snapshot,
    }
  }

  /** One `hasRole` per accepted role, at the build block; refused when the sender holds none. */
  async #preflightGate(
    chain: EVMChain,
    address: string,
    version: MultiTokenPoolVersion,
    params: Parsed,
    sender: string,
    blockTag: number,
  ): Promise<void> {
    const roles = this.gate(params)
    const pcm = poolConfigManagerContract(chain, address, version)
    const held = await Promise.all(
      roles.map((role) =>
        pcm.hasRole(poolConfigManagerRoleId(role), getAddress(sender), { blockTag }),
      ),
    )
    if (!held.some(Boolean))
      throw new CCTParamsInvalidError(
        this.name,
        'sender',
        `${sender} holds none of ${roles.join(', ')} on PoolConfigManager ${address}, which this write needs: send it from a holder, or grant one of the roles first`,
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
      simulatedFrom: unsigned.simulatedFrom,
      affectedLanes: unsigned.affectedLanes,
      goingLive: unsigned.goingLive,
      warnings: unsigned.warnings,
      snapshot: unsigned.snapshot,
    }
  }
}
