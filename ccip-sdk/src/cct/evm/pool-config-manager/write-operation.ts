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
  MultiTokenPoolSnapshot,
  MultiTokenPoolSnapshotCheck,
} from '../../multi-token-pool.ts'
import {
  type MultiTokenPoolSingleFunctionOperation,
  type MultiTokenPoolVersion,
  type PoolConfigManagerRole,
  POOL_CONFIG_MANAGER_TYPE,
  assertPoolConfigManagerRole,
  getMultiTokenPoolInterface,
  multiTokenPoolFunctionOf,
} from '../multi-token-pool/contracts.ts'
import {
  type MultiTokenPoolUnsignedTx,
  MultiTokenPoolWriteOperation,
  recheckSealedFacts,
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
import type { Result } from 'ethers'

import { LANE_RECORD_TYPES } from '../../../evm/multi-token-pool.ts'
import { CCTDataDecodeError, CCTParamsInvalidError } from '../../errors.ts'
import { latestBlock } from '../mined-block.ts'
import {
  type DecodedMultiTokenPoolWrite,
  NO_RECORD_CHANGE_FUNCTIONS,
  decodeMultiTokenPoolWrite,
} from './calldata.ts'
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
  /** A record-free write's facts ({@link PoolConfigManagerWriteOperation.readFacts}); `{}` otherwise. */
  facts: PoolConfigManagerFacts
  /** The PCM. */
  address: string
  /** Its version. */
  version: MultiTokenPoolVersion
  /** The block every read is pinned to. */
  blockTag: number
}

/**
 * What a record-free write is judged on: the chain facts it reads and seals (role membership, the
 * admin state, the balances it moves), by dotted path. @internal
 */
export type PoolConfigManagerFacts = Record<string, unknown>

/**
 * What an op encodes: the PCM calldata, and values it seals that are not chain state (a
 * confirmation it was built with). The state it replaces comes from
 * {@link PoolConfigManagerWriteOperation.sealedFrom}. @internal
 */
export type PoolConfigManagerWrite = {
  /** The calldata sent to the PCM. */
  data: string
  /** Sealed values that are not chain state, by dotted path. */
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

  /**
   * The chain state this write replaces or keeps, read from `ctx` for the records its calldata
   * touches (`decoded`), by dotted path. The build seals it; the snapshot check calls this same
   * method on the proposal's calldata and a fresh read ({@link freshSealed}), so a sealed value is
   * re-read, never echoed back.
   */
  protected abstract sealedFrom(
    chain: EVMChain,
    decoded: DecodedMultiTokenPoolWrite,
    ctx: PoolConfigManagerWriteContext,
  ): Promise<Record<string, unknown>> | Record<string, unknown>

  /**
   * The values a proposal of this op sealed, re-read now: the records its calldata touches, from a
   * fresh read of the PCM at `blockTag`. The snapshot check compares them with the sealed ones.
   * @internal
   */
  async freshSealed(
    chain: EVMChain,
    {
      data,
      address,
      version,
      blockTag,
    }: { data: string; address: string; version: MultiTokenPoolVersion; blockTag: number },
  ): Promise<Record<string, unknown>> {
    const read = await readMultiTokenPoolRecordState(chain, address, version, { blockTag })
    return this.sealedFrom(chain, decodeMultiTokenPoolWrite(data, version), {
      address,
      version,
      blockTag,
      state: read.state,
      staticConfig: read.staticConfig,
      policyNames: read.policyNames,
      rateLimitPolicyDecimals: read.rateLimitPolicyDecimals,
      facts: {},
    })
  }

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
   * The chain facts a record-free write is judged on, read at `ctx.blockTag`. No lane covers them, so
   * they are sealed into the snapshot, and the snapshot check re-reads them through this same method
   * ({@link recheck}): a record-free op seals at least one, and its `encode` judges on
   * `ctx.facts`, never on a second read.
   */
  protected readFacts(
    _chain: EVMChain,
    _params: Parsed,
    _ctx: Pick<PoolConfigManagerWriteContext, 'address' | 'version' | 'blockTag'>,
  ): Promise<PoolConfigManagerFacts> | PoolConfigManagerFacts {
    return {}
  }

  /**
   * This op's params recovered from its own calldata, for the snapshot check; `undefined` when the
   * op is not re-checked by {@link recheck} (a record write: its guard re-reads the records).
   * @param args - The decoded calldata.
   * @param target - The PCM, or the pool the proposal was built for.
   * @param sender - The account that will execute.
   * @param sealed - The values the proposal sealed (a confirmation it was built with, e.g.
   *   `confirm.*`).
   */
  paramsFromCalldata(
    _args: Result,
    _target: PoolConfigManagerTarget,
    _sender: string,
    _sealed: Record<string, unknown>,
  ): P | undefined {
    return undefined
  }

  /**
   * Re-checks a proposal of this record-free op on current state: re-reads its facts with the params
   * recovered from the calldata and reports every sealed fact that moved; when none did, rebuilds the
   * op from `sender`, so every check it makes now (a renounce's maturity, the gate, the simulation)
   * runs again, and compares the rebuilt snapshot.
   * @returns `undefined` when the op is not re-checked this way (see {@link paramsFromCalldata})
   * @throws {@link CCTParamsInvalidError} if the calldata is not this op's, or the op refuses the
   *   current state
   * @internal
   */
  async recheck(
    chain: EVMChain,
    {
      data,
      target,
      sender,
      snapshot,
    }: {
      data: string
      target: PoolConfigManagerTarget
      sender: string
      snapshot: MultiTokenPoolSnapshot
    },
  ): Promise<MultiTokenPoolSnapshotCheck | undefined> {
    const { address, version } = await resolvePoolConfigManagerTarget(chain, target)
    let args: Result
    try {
      args = getMultiTokenPoolInterface(POOL_CONFIG_MANAGER_TYPE, version).decodeFunctionData(
        multiTokenPoolFunctionOf(this.name as MultiTokenPoolSingleFunctionOperation),
        data,
      )
    } catch (cause) {
      throw new CCTParamsInvalidError(
        this.name,
        'transaction',
        `is not a ${this.name} call, which the snapshot was built for`,
        { cause: cause instanceof Error ? cause : undefined },
      )
    }
    const raw = this.paramsFromCalldata(args, target, sender, snapshot.expected)
    if (raw === undefined) return
    const params = this.prepare({ ...raw, sender })
    const facts = await this.readFacts(chain, params, {
      address,
      version,
      blockTag: await latestBlock(chain),
    })
    return recheckSealedFacts({
      snapshot,
      facts,
      rebuild: () => this.generate(chain, { ...raw, sender }),
      tolerated: (c) => this.tolerated(c),
    })
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
    // a record-free write's facts: sealed, and judged on by `encode` (no second read)
    const facts = this.changesRecords()
      ? {}
      : await this.readFacts(chain, params, { address, version, blockTag })
    // the stored records, read once: the op checks and encodes from them, the guard judges on them
    const read = this.changesRecords()
      ? await readMultiTokenPoolRecordState(chain, address, version, { blockTag })
      : emptyRecordStateRead(
          blockTag,
          await readPoolConfigManagerStaticConfig(chain, address, version, { blockTag }),
        )
    const ctx: PoolConfigManagerWriteContext = {
      address,
      version,
      blockTag,
      state: read.state,
      staticConfig: read.staticConfig,
      policyNames: read.policyNames,
      rateLimitPolicyDecimals: read.rateLimitPolicyDecimals,
      facts,
    }
    const { data, expected: extra } = await this.encode(chain, params, ctx)
    if (!this.changesRecords()) assertRecordFree(this.name, address, version, data)
    // what the write is judged on and replaces: a record-free write's facts, and the records its
    // calldata touches, read the way the snapshot check reads them again
    const expected = {
      ...facts,
      ...(await this.sealedFrom(chain, decodeMultiTokenPoolWrite(data, version), ctx)),
      ...extra,
    }
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
      expected,
      ...(context && { errorContext: context }),
      tolerate: (c) => this.tolerated(c),
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

/**
 * The tripwire of the record-free path: a write that skips the record state read must call a
 * function that changes no record, or it would be judged on an empty state with no lane rules.
 * @throws {@link CCTDataDecodeError} if it does not (an SDK bug)
 */
function assertRecordFree(
  operation: string,
  address: string,
  version: MultiTokenPoolVersion,
  data: string,
): void {
  const fn = getMultiTokenPoolInterface(POOL_CONFIG_MANAGER_TYPE, version).parseTransaction({
    data,
  })?.name
  if (fn !== undefined && NO_RECORD_CHANGE_FUNCTIONS.has(fn)) return
  throw new CCTDataDecodeError(address, {
    recovery:
      'An SDK bug: this write skips the record state read, but its calldata changes records. Report it; do not send the transaction.',
    context: {
      operation,
      function: fn ?? null,
      reason: 'a record-free write encodes a record change',
    },
  })
}
