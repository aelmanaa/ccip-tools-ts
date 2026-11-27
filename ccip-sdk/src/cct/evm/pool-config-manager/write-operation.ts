/**
 * The base of every PoolConfigManager write: role pre-flight, the post-state guard on the exact
 * calldata, the reviewer-facing unsigned result, and the re-check right before a signed send.
 *
 * @packageDocumentation
 */

import type { EVMChain } from '../../../evm/index.ts'
import { ChainFamily } from '../../../networks.ts'
import type {
  MultiTokenPoolExpectedSnapshot,
  MultiTokenPoolRemoteCheckOptions,
} from '../../multi-token-pool.ts'
import {
  type MultiTokenPoolVersion,
  type PoolConfigManagerRole,
  assertPoolConfigManagerRole,
} from '../multi-token-pool/contracts.ts'
import {
  type MultiTokenPoolUnsignedTx,
  MultiTokenPoolWriteOperation,
} from '../multi-token-pool/write-operation.ts'
import {
  type PoolConfigManagerTarget,
  readPoolConfigManagerStaticConfig,
  resolvePoolConfigManagerTarget,
  validatePoolConfigManagerTarget,
} from './contracts.ts'
import { runMultiTokenPoolGuards } from './guard-run.ts'
import {
  type MultiTokenPoolRecordStateRead,
  readMultiTokenPoolRecordState,
} from './record-state.ts'

export type { MultiTokenPoolSimulatedFrom } from './guard-run.ts'
export type {
  MultiTokenPoolFollowUp,
  MultiTokenPoolTransactionResult,
  MultiTokenPoolUnsignedTx,
  MultiTokenPoolWriteImpact,
} from '../multi-token-pool/write-operation.ts'
export type { MultiTokenPoolGuardOptions } from './guards.ts'
import { LANE_RECORD_TYPES } from '../../../evm/multi-token-pool.ts'
import { latestBlock } from '../mined-block.ts'
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
> extends MultiTokenPoolWriteOperation<P, Parsed> {
  /** The roles the PCM accepts for this write (any one suffices). */
  protected abstract gate(params: Parsed): readonly PoolConfigManagerRole[]

  /** Encodes the write; may read the PCM at `ctx.blockTag` to merge. */
  protected abstract encode(
    chain: EVMChain,
    params: Parsed,
    ctx: PoolConfigManagerWriteContext,
  ): Promise<PoolConfigManagerWrite> | PoolConfigManagerWrite

  /**
   * Whether the write changes stored records. A role, admin or withdrawal write changes none: its
   * build skips the record state read (the guard projects no change, still gates and simulates).
   * Defaults to `true`.
   */
  protected changesRecords(): boolean {
    return true
  }

  /**
   * The `sender` pre-flight, before any other read: by default one of {@link gate}'s roles. An op
   * whose gate is not a role (the pending admin of a transfer) overrides it.
   */
  protected async preflight(
    chain: EVMChain,
    params: Parsed,
    ctx: Pick<PoolConfigManagerWriteContext, 'address' | 'version' | 'blockTag'>,
    sender: string,
  ): Promise<void> {
    await assertPoolConfigManagerRole(
      this.name,
      chain,
      ctx.address,
      ctx.version,
      sender,
      this.gate(params),
      ctx.blockTag,
      this.errorContext(params),
    )
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
      await this.preflight(chain, params, { address, version, blockTag }, params.sender)
    // the stored records, read once: the op checks and encodes from them, the guard judges on them
    const read = this.changesRecords()
      ? await readMultiTokenPoolRecordState(chain, address, version, { blockTag })
      : emptyRecordStateRead(
          blockTag,
          await readPoolConfigManagerStaticConfig(chain, address, version, { blockTag }),
        )
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

/** The state read of a write that changes no record: no token, no policy, the static config. */
function emptyRecordStateRead(
  blockNumber: number,
  staticConfig: MultiTokenPoolRecordStateRead['staticConfig'],
): MultiTokenPoolRecordStateRead {
  const policyNames = {} as MultiTokenPoolRecordStateRead['policyNames']
  for (const type of LANE_RECORD_TYPES) policyNames[type] = new Set()
  return {
    state: {
      tokens: [],
      policies: {
        connection: [],
        remoteTokenAddressProviders: [],
        remotePool: [],
        rateLimit: [],
        fee: [],
        destOverhead: [],
        security: [],
      },
      providerAnswers: [],
      chainPauses: [],
      isGloballyPaused: false,
    },
    blockNumber,
    lanes: [],
    staticConfig,
    policyNames,
    rateLimitPolicyDecimals: new Map(),
  }
}
