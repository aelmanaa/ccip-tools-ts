/**
 * The base of every multi-token pool write, whatever contract it targets (the PoolConfigManager, the
 * pool, a policy store or a hook contract): the reviewer-facing unsigned result, and the signed send
 * that rebuilds right before sending.
 *
 * @packageDocumentation
 */

import type { TransactionReceipt } from 'ethers'

import type { EVMChain } from '../../../evm/index.ts'
import type { UnsignedEVMTx } from '../../../evm/types.ts'
import { type CCTStateChange, CCTParamsInvalidError, CCTStateChangedError } from '../../errors.ts'
import type { MultiTokenPoolLaneFinding, MultiTokenPoolSnapshot } from '../../multi-token-pool.ts'
import type { TransactionResult } from '../../operation.ts'
import { noteMinedBlock } from '../mined-block.ts'
import { type EVMExecuteParams, EVMOperation } from '../operation.ts'
import type {
  MultiTokenPoolLaneDirections,
  MultiTokenPoolLaneKey,
} from '../pool-config-manager/contracts.ts'
import {
  type MultiTokenPoolSimulatedFrom,
  snapshotChanges,
} from '../pool-config-manager/guard-run.ts'
import { submit } from '../submit.ts'

/** A write that must follow another one (e.g. a stale PCM authorization after a PCM swap). */
export type MultiTokenPoolFollowUp = {
  /** The SDK op to run. */
  operation: string
  /** The contract it targets. */
  target: string
  /** Why it is needed. */
  reason: string
  /** Inputs of the op, when the follow-up fixes them. */
  inputs?: Record<string, unknown>
}

/**
 * What every multi-token pool write reports next to its transaction, for a reviewer of a multisig
 * proposal.
 */
export type MultiTokenPoolWriteImpact = {
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
  /** Writes this one makes necessary (e.g. the stores still authorizing a replaced PCM). */
  followUps?: MultiTokenPoolFollowUp[]
}

/**
 * Unsigned output of a multi-token pool write that affects lanes or reads before it writes: one
 * transaction, its impact on the lanes, and the state it was judged on. The new values are in the
 * calldata; `snapshot.expected` holds the values the write replaces, as they were when it was built.
 */
export type MultiTokenPoolUnsignedTx = UnsignedEVMTx &
  MultiTokenPoolWriteImpact & {
    /** The state the write was judged on: pass it back as `expectedSnapshot`, or to `checkMultiTokenPoolSnapshot`. */
    snapshot: MultiTokenPoolSnapshot
  }

/**
 * Unsigned output of a multi-token pool write that affects no lane and writes what it is given
 * (an ownership step, a hook's allowlist, policy engine or blocklist): no snapshot, no lanes.
 */
export type MultiTokenPoolUnsealedUnsignedTx = UnsignedEVMTx & MultiTokenPoolWriteImpact

/** Result of a signed multi-token pool write. */
export type MultiTokenPoolTransactionResult = TransactionResult &
  Omit<MultiTokenPoolUnsignedTx, keyof UnsignedEVMTx> & {
    /** The block the write mined in; every later MTTP read or build on the provider is at or after it. */
    blockNumber: number
  }

/** Result of a signed multi-token pool write that seals no snapshot. */
export type MultiTokenPoolUnsealedTransactionResult = TransactionResult &
  Omit<MultiTokenPoolUnsealedUnsignedTx, keyof UnsignedEVMTx> & {
    /** The block the write mined in; every later MTTP read or build on the provider is at or after it. */
    blockNumber: number
  }

/** The result fields a signed send adds to its unsigned build. @internal */
type SignedResultOf<Tx extends UnsignedEVMTx> = TransactionResult &
  Omit<Tx, keyof UnsignedEVMTx> & {
    /** The block the write mined in; every later MTTP read or build on the provider is at or after it. */
    blockNumber: number
  }

/**
 * Base of every multi-token pool write. A build that seals a snapshot is rebuilt right before a
 * signed send and compared (any movement throws `CCTStateChangedError`); a build without one is sent
 * as built. Subclasses supply `prepare` and `buildUnsigned`.
 * @internal
 */
export abstract class MultiTokenPoolWriteOperation<
  P extends { sender?: string; expectedSnapshot?: MultiTokenPoolSnapshot },
  Parsed = P,
  Tx extends UnsignedEVMTx & MultiTokenPoolWriteImpact & { snapshot?: MultiTokenPoolSnapshot } =
    MultiTokenPoolUnsignedTx,
> extends EVMOperation<P, Parsed, Tx> {
  /** Context every refusal of this op carries (e.g. a merged op's kind). */
  protected errorContext(_params: Parsed): Record<string, unknown> | undefined {
    return undefined
  }

  /**
   * Whether a move of a sealed value leaves the proposal valid (a balance that only grew, for a
   * withdrawal of the whole balance): such a move is never reported, on the snapshot check, the
   * rebuild before a send, or a caller's `expectedSnapshot`. Defaults to none.
   */
  protected tolerated(_change: CCTStateChange): boolean {
    return false
  }

  /**
   * A refusal of this op at `param`, carrying its {@link errorContext} (pass `params` when the op's
   * context depends on them).
   */
  protected refuse(param: string, reason: string, params?: Parsed): CCTParamsInvalidError {
    const context = this.errorContext(params as Parsed)
    return new CCTParamsInvalidError(this.name, param, reason, context && { context })
  }

  /**
   * Builds, then (for a build that seals a snapshot) rebuilds with the first build's snapshot right
   * before sending: any movement in between throws `CCTStateChangedError`. Then signs and submits.
   */
  override execute(chain: EVMChain, params: EVMExecuteParams<P>): Promise<SignedResultOf<Tx>> {
    return this.executeWith(chain, params, () => ({}))
  }

  /**
   * {@link execute}, with result fields of the op's own derived from the mined receipt `submit`
   * returns: no RPC runs after the send, so nothing that could fail without the hash.
   */
  protected async executeWith<X extends object>(
    chain: EVMChain,
    params: EVMExecuteParams<P>,
    fromReceipt: (receipt: TransactionReceipt) => X,
  ): Promise<SignedResultOf<Tx> & X> {
    const sender = await this.resolveWalletSender(params.wallet, params.sender)
    const first = await this.generate(chain, { ...params, sender })
    const unsigned = first.snapshot ? await this.rebuild(chain, params, sender, first) : first
    const { response, receipt } = await submit(chain, params.wallet, unsigned, this.name)
    // the next read or build on this provider never pins before this write (ethers' block cache)
    noteMinedBlock(chain, receipt.blockNumber)
    const { family: _, transactions: __, ...impact } = unsigned
    return {
      hash: response.hash,
      blockNumber: receipt.blockNumber,
      ...impact,
      ...fromReceipt(receipt),
    } as SignedResultOf<Tx> & X
  }

  /**
   * The rebuild right before sending: with the caller's snapshot it must hold; without one, any move
   * since the first build (the state-derived calldata included) is a state change.
   */
  private async rebuild(
    chain: EVMChain,
    params: EVMExecuteParams<P>,
    sender: string,
    first: Tx,
  ): Promise<Tx> {
    const unsigned = await this.generate(
      chain,
      params.expectedSnapshot
        ? { ...params, sender }
        : { ...params, sender, expectedSnapshot: undefined },
    )
    if (params.expectedSnapshot) return unsigned
    const changed = snapshotChanges(first.snapshot!, unsigned.snapshot!, (c) => this.tolerated(c))
    if (first.snapshot!.calldataHash !== unsigned.snapshot!.calldataHash)
      changed.unshift({
        path: 'calldataHash',
        expected: first.snapshot!.calldataHash,
        actual: unsigned.snapshot!.calldataHash,
      })
    if (changed.length)
      throw new CCTStateChangedError(
        this.name,
        `${changed.map((c) => c.path).join(', ')} moved between the build and the send`,
        { context: { ...this.errorContext(params as unknown as Parsed), changed } },
      )
    return unsigned
  }
}
