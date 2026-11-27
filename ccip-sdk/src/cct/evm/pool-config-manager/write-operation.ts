/**
 * The base of every PoolConfigManager write: role pre-flight, the post-state guard on the exact
 * calldata, the reviewer-facing unsigned result, and the re-check right before a signed send.
 *
 * @packageDocumentation
 */

import type { EVMChain } from '../../../evm/index.ts'
import type { UnsignedEVMTx } from '../../../evm/types.ts'
import { ChainFamily } from '../../../networks.ts'
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
  assertPoolConfigManagerRole,
} from '../multi-token-pool/contracts.ts'
import { type EVMExecuteParams, EVMOperation } from '../operation.ts'
import { submit } from '../submit.ts'
import {
  type MultiTokenPoolLaneDirections,
  type MultiTokenPoolLaneKey,
  type PoolConfigManagerTarget,
  resolvePoolConfigManagerTarget,
  validatePoolConfigManagerTarget,
} from './contracts.ts'
import {
  type MultiTokenPoolSimulatedFrom,
  runMultiTokenPoolGuards,
  snapshotChanges,
} from './guard-run.ts'
import {
  type MultiTokenPoolRecordStateRead,
  readMultiTokenPoolRecordState,
} from './record-state.ts'

export type { MultiTokenPoolSimulatedFrom } from './guard-run.ts'
export type { MultiTokenPoolGuardOptions } from './guards.ts'
import { CCTParamsInvalidError, CCTStateChangedError } from '../../errors.ts'
import { latestBlock, noteMinedBlock } from '../mined-block.ts'
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
  > & {
    /** The block the write mined in; every later MTTP read or build on the provider is at or after it. */
    blockNumber: number
  }

/**
 * A resolved PCM, the block a write is built at, and the PCM's stored records read once at that
 * block (the op and the guard share the read).
 * @internal
 */
export type PoolConfigManagerWriteContext = Pick<
  MultiTokenPoolRecordStateRead,
  'state' | 'staticConfig' | 'policyNames' | 'rateLimitPolicyDecimals'
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

  /** Context every refusal of this op carries (e.g. a merged op's kind). */
  protected errorContext(_params: Parsed): Record<string, unknown> | undefined {
    return undefined
  }

  /**
   * A refusal of this op at `param`, carrying its {@link errorContext} (pass `params` when the op's
   * context depends on them).
   */
  protected refuse(param: string, reason: string, params?: Parsed): CCTParamsInvalidError {
    const context = this.errorContext(params as Parsed)
    return new CCTParamsInvalidError(this.name, param, reason, context && { context })
  }

  /** Validates the target, sender and guard options; subclasses validate their own fields after it. */
  protected override prepare(params: P): Parsed {
    validatePoolConfigManagerTarget(this.name, params)
    validateMultiTokenPoolGuardOptions(this.name, '', params)
    // `sender` is validated by `generate`, before any RPC
    return params as Parsed
  }

  protected async buildUnsigned(
    chain: EVMChain,
    params: Parsed,
  ): Promise<MultiTokenPoolUnsignedTx> {
    const { address, version } = await resolvePoolConfigManagerTarget(chain, params)
    const blockTag = await latestBlock(chain)
    if (params.sender !== undefined)
      await assertPoolConfigManagerRole(
        this.name,
        chain,
        address,
        version,
        params.sender,
        this.gate(params),
        blockTag,
        this.errorContext(params),
      )
    // the stored records, read once: the op checks and encodes from them, the guard judges on them
    const read = await readMultiTokenPoolRecordState(chain, address, version, { blockTag })
    const { data, expected } = await this.encode(chain, params, {
      address,
      version,
      blockTag,
      state: read.state,
      staticConfig: read.staticConfig,
      policyNames: read.policyNames,
      rateLimitPolicyDecimals: read.rateLimitPolicyDecimals,
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
      ...writeGuardsOf(params),
    })
    return {
      family: ChainFamily.EVM,
      // `generate` sets `from` to the sender
      transactions: [{ to: address, data }],
      projectionVerified: result.projectionVerified,
      simulatedFrom: result.simulatedFrom,
      affectedLanes: result.affectedLanes,
      goingLive: result.goingLive,
      warnings: result.warnings,
      snapshot: result.snapshot,
    }
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
    // the rebuild right before sending: with the caller's snapshot it must hold; without one, any
    // move since the first build (the state-derived calldata included) is a state change
    const unsigned = await this.generate(
      chain,
      params.expectedSnapshot
        ? { ...params, sender }
        : { ...params, sender, expectedSnapshot: undefined },
    )
    if (!params.expectedSnapshot) {
      const changed = snapshotChanges(first.snapshot, unsigned.snapshot)
      if (first.snapshot.calldataHash !== unsigned.snapshot.calldataHash)
        changed.unshift({
          path: 'calldataHash',
          expected: first.snapshot.calldataHash,
          actual: unsigned.snapshot.calldataHash,
        })
      if (changed.length)
        throw new CCTStateChangedError(
          this.name,
          `${changed.map((c) => c.path).join(', ')} moved between the build and the send`,
          { context: { ...this.errorContext(params as unknown as Parsed), changed } },
        )
    }
    const { response, receipt } = await submit(chain, params.wallet, unsigned, this.name)
    // the next read or build on this provider never pins before this write (ethers' block cache)
    noteMinedBlock(chain, receipt.blockNumber)
    const { family: _, transactions: __, ...impact } = unsigned
    return { hash: response.hash, blockNumber: receipt.blockNumber, ...impact }
  }
}

/**
 * Every write guard option, so the base forwards them as one object: a new option is a type error
 * here until it is listed, never a silently dropped field.
 */
const WRITE_GUARD_KEYS: Record<keyof MultiTokenPoolWriteGuards, true> = {
  getChain: true,
  remoteAttestations: true,
  expectedSnapshot: true,
  allowDroppingDefaultCCVs: true,
  maxTransferFeeBps: true,
  minDestGasOverhead: true,
  confirmClosing: true,
  confirmOpening: true,
  confirmDropped: true,
  migrationWindowChains: true,
}

/** The guard options a write's params carry (unset ones left out). */
function writeGuardsOf(params: MultiTokenPoolWriteGuards): MultiTokenPoolWriteGuards {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(WRITE_GUARD_KEYS) as (keyof MultiTokenPoolWriteGuards)[])
    if (params[key] !== undefined) out[key] = params[key]
  return out as MultiTokenPoolWriteGuards
}
