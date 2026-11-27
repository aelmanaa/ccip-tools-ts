/**
 * The base of every pool-group write: plan the items from current chain state, judge the exact
 * instructions (simulated post-state, {@link judgePoolGroupWrite}), pack them, seal the snapshot.
 * The signed form runs the same build through the rebuild-not-resend runner, so a rebuild after a
 * transaction that expired unlanded re-reads chain state.
 *
 * @packageDocumentation
 */

import type { PublicKey, TransactionInstruction } from '@solana/web3.js'

import { CCIPWalletInvalidError } from '../../../errors/index.ts'
import type { SolanaChain } from '../../../solana/index.ts'
import { isWallet } from '../../../solana/types.ts'
import { canonicalHash } from '../../canonical.ts'
import { CCTParamsInvalidError } from '../../errors.ts'
import type { MultiTokenPoolSnapshot, MultiTokenPoolSnapshotCheck } from '../../multi-token-pool.ts'
import { Operation } from '../../operation.ts'
import {
  type SolanaExecuteParams,
  type SolanaGenerateParams,
  refreshAccountState,
} from '../operation.ts'
import type { SolanaDurableNonce } from '../serialize.ts'
import { parsePublicKey } from '../validate.ts'
import type { ParsedPoolGroupRef } from './operations/common.ts'
import {
  type PoolGroupPackItem,
  executePoolGroupTransactions,
  hasComputeBudget,
  packPoolGroupTransactions,
} from './packer.ts'
import { poolGroupTransactionsHash } from './snapshot.ts'
import type { PoolGroupLaneKey } from './types.ts'
import {
  type JudgePoolGroupWriteInput,
  type PoolGroupJudgement,
  POOL_GROUP_GUARD_OPTIONS_PATH,
  judgePoolGroupWrite,
  poolGroupGuardOptionsOf,
  sealPoolGroupSnapshot,
} from './write-guard.ts'
import type {
  PoolGroupExecuteResult,
  PoolGroupFollowUp,
  PoolGroupGuardOptions,
  PoolGroupLiveCheckOptions,
  PoolGroupUnsignedResult,
  SolanaTxBudget,
} from './write-types.ts'

/** The parsed fields every pool-group write carries. @internal */
export type ParsedPoolGroupWrite = {
  /** The fee payer. */
  payer: PublicKey
  /** The signer the instruction checks. */
  authority: PublicKey
  /** The pool program. */
  program: PublicKey
  /** The limits to pack under. */
  budget?: SolanaTxBudget
  /** One nonce per transaction (unsigned path). */
  durableNonces?: SolanaDurableNonce[]
  /** The guard options, in their sealed shape. */
  guardOptions: PoolGroupGuardOptions
  /** The make-live check's options (never sealed: `getChain` is a function). */
  liveCheck?: PoolGroupLiveCheckOptions
  /** The snapshot a previous build returned. */
  expectedSnapshot?: MultiTokenPoolSnapshot
}

/** What an op's plan returns: its items, the values its snapshot keeps, and how to judge it. @internal */
export type PoolGroupWritePlan<X extends object> = {
  /** The pool group the write targets (the snapshot check's ref). */
  group: PublicKey
  /** The items, in order; none: nothing to write. */
  items: PoolGroupPackItem[]
  /** Values the write keeps, merges or replaces, by dotted path. */
  expected: Record<string, unknown>
  /** Judge options; `null` skips the lane guard (a new group has no lanes). */
  judge: Pick<
    JudgePoolGroupWriteInput,
    'failsClosedSeverity' | 'goingLiveSeverity' | 'scope'
  > | null
  /**
   * Judge each item as its own simulated transaction (batched lane ops whose items touch disjoint
   * lanes and do not fit one transaction together); otherwise all items are simulated as one.
   */
  judgeEach?: boolean
  /** Only these instructions are judged (the others provably change no lane, e.g. a new record). */
  judgeFilter?: (ix: TransactionInstruction) => boolean
  /** Op-specific result fields. */
  extra: X
  /** Follow-ups, from the judgement (`null` when the plan skips the lane guard). */
  followUps?: (judgement: PoolGroupJudgement | null) => PoolGroupFollowUp[]
  /** A measured upper bound of items per transaction. */
  maxItemsPerTransaction?: number
}

/** A plan's kept values, with the pool group it writes (so a snapshot binds to one group). */
const expectedOf = (plan: PoolGroupWritePlan<object>): Record<string, unknown> => ({
  ...plan.expected,
  'group.address': plan.group.toBase58(),
})

/** The instruction groups a plan's judge simulates: per item, or all as one; filtered. */
function judgedGroups(
  plan: PoolGroupWritePlan<object>,
  items: readonly (readonly TransactionInstruction[])[],
): TransactionInstruction[][] {
  const keep = plan.judgeFilter ?? (() => true)
  const groups = plan.judgeEach ? items.map((ixs) => ixs.filter(keep)) : [items.flat().filter(keep)]
  return groups.filter((g) => g.length)
}

/**
 * Judges each group of instructions as its own simulated transaction, in order, and merges the
 * judgements (lanes de-duplicated; the inputs hash covers every group).
 */
async function judgeGroups(
  input: Omit<JudgePoolGroupWriteInput, 'instructions'>,
  groups: readonly (readonly TransactionInstruction[])[],
): Promise<PoolGroupJudgement> {
  const parts: PoolGroupJudgement[] = []
  for (const instructions of groups)
    parts.push(await judgePoolGroupWrite({ ...input, instructions }))
  if (parts.length === 1) return parts[0]!
  if (!parts.length)
    return {
      affectedLanes: [],
      goingLive: [],
      findings: [],
      failingClosed: [],
      unreadable: [],
      guardInputsHash: canonicalHash([]),
      slot: BigInt(await input.chain.connection.getSlot('confirmed')),
    }
  const unique = <T extends PoolGroupLaneKey>(lanes: T[]) =>
    lanes.filter(
      (l, i) =>
        lanes.findIndex(
          (o) =>
            o.tokenAddress === l.tokenAddress && o.remoteChainSelector === l.remoteChainSelector,
        ) === i,
    )
  return {
    affectedLanes: unique(parts.flatMap((p) => p.affectedLanes)),
    goingLive: unique(parts.flatMap((p) => p.goingLive)),
    findings: parts.flatMap((p) => p.findings),
    failingClosed: parts.flatMap((p) => p.failingClosed),
    unreadable: unique(parts.flatMap((p) => p.unreadable)),
    guardInputsHash: canonicalHash(parts.map((p) => p.guardInputsHash)),
    slot: parts.reduce((m, p) => (p.slot < m ? p.slot : m), parts[0]!.slot),
  }
}

/** The fields shared by every write's raw params. */
type RawWriteParams = {
  payer: string
  authority?: string
  budget?: SolanaTxBudget
  durableNonces?: { accounts: SolanaDurableNonce[] }
  confirmDropped?: PoolGroupGuardOptions['confirmDropped']
  expectedSnapshot?: MultiTokenPoolSnapshot
} & PoolGroupLiveCheckOptions

/**
 * Parses the make-live check's options (`getChain` a function, `concurrency` a positive integer).
 * @throws {@link CCTParamsInvalidError} if one is invalid
 * @internal
 */
export function parseLiveCheck(
  operation: string,
  params: PoolGroupLiveCheckOptions,
): PoolGroupLiveCheckOptions | undefined {
  const { getChain, concurrency } = params
  if (getChain !== undefined && typeof getChain !== 'function')
    throw new CCTParamsInvalidError(operation, 'getChain', 'must be a function')
  if (
    concurrency !== undefined &&
    (typeof concurrency !== 'number' || !Number.isInteger(concurrency) || concurrency < 1)
  )
    throw new CCTParamsInvalidError(operation, 'concurrency', 'must be a positive integer')
  if (getChain === undefined && concurrency === undefined) return undefined
  return { ...(getChain && { getChain }), ...(concurrency !== undefined && { concurrency }) }
}

/**
 * Parses the fields every write takes: payer, authority (defaults to the payer), durable nonces and
 * the guard options.
 * @throws {@link CCTParamsInvalidError} if one is invalid
 * @internal
 */
export function parseWriteBase(
  operation: string,
  program: PublicKey,
  params: RawWriteParams,
): ParsedPoolGroupWrite {
  const payer = parsePublicKey(operation, 'payer', params.payer)
  const authority =
    params.authority === undefined
      ? payer
      : parsePublicKey(operation, 'authority', params.authority)
  const nonces = params.durableNonces?.accounts
  if (params.durableNonces !== undefined && !Array.isArray(nonces))
    throw new CCTParamsInvalidError(operation, 'durableNonces.accounts', 'must be an array')
  nonces?.forEach((n, i) => {
    parsePublicKey(
      operation,
      `durableNonces.accounts[${i}].nonceAccount`,
      Reflect.get(Object(n), 'nonceAccount'),
    )
    parsePublicKey(
      operation,
      `durableNonces.accounts[${i}].nonceAuthority`,
      Reflect.get(Object(n), 'nonceAuthority'),
    )
  })
  const liveCheck = parseLiveCheck(operation, params)
  return {
    payer,
    authority,
    program,
    ...(liveCheck && { liveCheck }),
    ...(params.budget && { budget: params.budget }),
    ...(nonces && { durableNonces: nonces }),
    guardOptions: poolGroupGuardOptionsOf(operation, params),
    ...(params.expectedSnapshot && { expectedSnapshot: params.expectedSnapshot }),
  }
}

/** The pool-program instructions of a proposal's transactions (compute budget and nonce left out). */
function proposalInstructions(
  program: PublicKey,
  transactions: readonly { instructions: readonly TransactionInstruction[] }[],
): TransactionInstruction[] {
  return transactions
    .flatMap((tx) => tx.instructions)
    .filter((ix) => !hasComputeBudget([ix]) && ix.programId.equals(program))
}

/**
 * A pool-group write. Subclasses supply `prepare` (to a {@link ParsedPoolGroupWrite}), `plan` (the
 * items and kept values from current chain state) and `fromInstructions` (the parsed params a
 * proposal's instructions encode, for `checkPoolGroupSnapshot`).
 * @internal
 */
export abstract class PoolGroupWriteOperation<
  P extends object,
  Parsed extends ParsedPoolGroupWrite,
  X extends object = Record<never, never>,
> extends Operation<
  SolanaChain,
  SolanaGenerateParams<P>,
  PoolGroupUnsignedResult & X,
  PoolGroupExecuteResult & X,
  Parsed
> {
  /** Plans the write from current chain state. */
  protected abstract plan(chain: SolanaChain, parsed: Parsed): Promise<PoolGroupWritePlan<X>>

  /**
   * The parsed params a proposal's pool-program instructions encode (payer = authority), so the
   * snapshot check re-plans against current state and judges those exact instructions.
   * @throws {@link CCTParamsInvalidError} if the instructions are not this op's
   */
  protected abstract fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): Parsed

  /** The pool group an instruction of this op names: its first account (overridden where not). */
  protected proposalGroup(ix: TransactionInstruction): PublicKey | undefined {
    return ix.keys[0]?.pubkey
  }

  /** Builds the unsigned transactions; no signing. */
  async generate(
    chain: SolanaChain,
    params: SolanaGenerateParams<P>,
  ): Promise<PoolGroupUnsignedResult & X> {
    refreshAccountState(chain)
    return this.build(chain, this.prepare(params))
  }

  /** Plans, judges, packs and seals. */
  protected async build(chain: SolanaChain, parsed: Parsed): Promise<PoolGroupUnsignedResult & X> {
    const { result, extra } = await this.buildParts(chain, parsed)
    return { ...result, ...extra }
  }

  /** {@link build}, with the op's own result fields apart. */
  private async buildParts(
    chain: SolanaChain,
    parsed: Parsed,
  ): Promise<{ result: PoolGroupUnsignedResult; extra: X }> {
    const plan = await this.plan(chain, parsed)
    const extra = plan.extra
    const empty = { affectedLanes: [], goingLive: [], findings: [] }
    if (!plan.items.length) return { result: { transactions: [], ...empty }, extra }
    const judgement = plan.judge
      ? await judgeGroups(
          {
            operation: this.name,
            chain,
            program: parsed.program,
            group: plan.group,
            payer: parsed.payer,
            ...plan.judge,
            ...parsed.guardOptions,
            ...(parsed.liveCheck && { liveCheck: parsed.liveCheck }),
          },
          judgedGroups(
            plan,
            plan.items.map((i) => i.instructions),
          ),
        )
      : null
    const packed = await packPoolGroupTransactions({
      operation: this.name,
      chain,
      payer: parsed.payer,
      items: plan.items,
      ...(parsed.budget && { budget: parsed.budget }),
      ...(parsed.durableNonces && { durableNonces: parsed.durableNonces }),
      ...(plan.maxItemsPerTransaction && { maxItemsPerTransaction: plan.maxItemsPerTransaction }),
    })
    const snapshot = await sealPoolGroupSnapshot({
      operation: this.name,
      slot: judgement?.slot ?? BigInt(await chain.connection.getSlot()),
      expected: expectedOf(plan),
      guardOptions: parsed.guardOptions,
      guardInputsHash: judgement?.guardInputsHash ?? 'none',
      calldataHash: poolGroupTransactionsHash(packed.transactions),
      ...(parsed.expectedSnapshot && { expectedSnapshot: parsed.expectedSnapshot }),
    })
    const followUps = plan.followUps ? plan.followUps(judgement) : []
    return {
      result: {
        ...packed,
        snapshot,
        affectedLanes: judgement?.affectedLanes ?? [],
        goingLive: judgement?.goingLive ?? [],
        findings: (judgement?.findings ?? []).filter((f) => f.severity === 'warning'),
        ...(followUps.length && { followUps }),
      },
      extra,
    }
  }

  /**
   * Signs and sends with `wallet` as payer and default authority. The build runs again right
   * before the first send (and after a transaction that expired unlanded), so merged and
   * snapshotted state is re-read; with `expectedSnapshot` a move throws `CCTStateChangedError`.
   * @throws {@link CCIPWalletInvalidError} if `wallet` cannot sign Solana transactions
   * @throws {@link CCTParamsInvalidError} if durable nonces or the Squads executor are given (the
   *   signed form signs at once, with the wallet), or a transaction needs another signer
   */
  async execute(
    chain: SolanaChain,
    params: SolanaExecuteParams<P>,
  ): Promise<PoolGroupExecuteResult & X> {
    const { wallet } = params
    const rest = params
    if (!isWallet(wallet)) throw new CCIPWalletInvalidError(wallet)
    if (Reflect.get(rest, 'durableNonces') !== undefined)
      throw new CCTParamsInvalidError(
        this.name,
        'durableNonces',
        'a signed write signs at once: durable nonces exist only on generateUnsigned*',
      )
    const budget: unknown = Reflect.get(rest, 'budget')
    if (
      typeof budget === 'object' &&
      budget !== null &&
      Reflect.get(budget, 'executor') === 'squads-v4'
    )
      throw new CCTParamsInvalidError(
        this.name,
        'budget.executor',
        "a Squads vault executes proposals: use the generateUnsigned form with executor 'squads-v4' and toPoolGroupSquadsTransaction",
      )
    refreshAccountState(chain)
    const parsed = this.prepare({ ...rest, payer: wallet.publicKey.toBase58() })
    let extra: X | undefined
    const result = await executePoolGroupTransactions({
      operation: this.name,
      chain,
      wallet,
      build: async () => {
        refreshAccountState(chain)
        const parts = await this.buildParts(chain, parsed)
        extra = parts.extra
        return parts.result
      },
    })
    return { ...result, ...extra! }
  }

  /**
   * The snapshot check of this op: re-plans against current state from the params the proposal's
   * instructions encode, judges those exact instructions (with the sealed guard options), and
   * reports what moved and every finding. Lanes the proposal makes live run the make-live check
   * with `liveCheck` (without `getChain` their remote side fails closed).
   * @throws {@link CCTParamsInvalidError} if the instructions are not this op's, or the program
   *   now refuses them
   * @internal
   */
  async recheck(
    chain: SolanaChain,
    ref: ParsedPoolGroupRef,
    snapshot: MultiTokenPoolSnapshot,
    transactions: readonly { instructions: readonly TransactionInstruction[] }[],
    liveCheck?: PoolGroupLiveCheckOptions,
  ): Promise<MultiTokenPoolSnapshotCheck> {
    const instructions = proposalInstructions(ref.program, transactions)
    // every instruction of these ops names its pool group: it must be the one checked
    const foreign = instructions.findIndex((ix) => !this.proposalGroup(ix)?.equals(ref.group))
    if (foreign >= 0)
      throw new CCTParamsInvalidError(
        this.name,
        'transactions',
        `instruction ${foreign} of the proposal writes the pool group ${this.proposalGroup(instructions[foreign]!)?.toBase58() ?? '(none)'}, not ${ref.group.toBase58()}: pass the pool group the proposal targets`,
      )
    const sealed: unknown = snapshot.expected[POOL_GROUP_GUARD_OPTIONS_PATH]
    const guardOptions = poolGroupGuardOptionsOf(this.name, {
      confirmDropped:
        typeof sealed === 'object' && sealed !== null
          ? Reflect.get(sealed, 'confirmDropped')
          : undefined,
    })
    const parsed = this.fromInstructions(ref, instructions, guardOptions)
    const plan = await this.plan(chain, parsed)
    const judgement = plan.judge
      ? await judgeGroups(
          {
            operation: this.name,
            chain,
            program: ref.program,
            group: plan.group,
            payer: parsed.payer,
            ...plan.judge,
            ...guardOptions,
            ...(liveCheck && { liveCheck }),
            reportFindings: true,
          },
          judgedGroups(
            plan,
            instructions.map((ix) => [ix]),
          ),
        )
      : null
    const { snapshotChanges } = await import('../../evm/pool-config-manager/guard-run.ts')
    const changed = snapshotChanges(snapshot, {
      guardInputsHash: judgement?.guardInputsHash ?? 'none',
      expected: { ...expectedOf(plan), [POOL_GROUP_GUARD_OPTIONS_PATH]: guardOptions },
    })
    const findings = judgement?.findings ?? []
    return {
      ok: !changed.length && !findings.some((f) => f.severity === 'error'),
      changed,
      findings,
    }
  }
}
