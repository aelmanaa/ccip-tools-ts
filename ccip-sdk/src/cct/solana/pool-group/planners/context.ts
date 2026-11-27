/**
 * What the three Solana planners share: the parsed run context, the step spec (a plan step bound
 * to the op that builds it), the resource keys of design §8.1, and the binders that turn a typed op
 * call into a step's build.
 *
 * @packageDocumentation
 */

import { type PublicKey, ComputeBudgetProgram } from '@solana/web3.js'

import type { ChainGetter } from '../../../../chain.ts'
import type { SolanaChain } from '../../../../solana/index.ts'
import type { UnsignedSolanaTx, Wallet } from '../../../../solana/types.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import {
  type PlannedStepFields,
  newRunId,
  planStep,
  resolveActor,
} from '../../../multi-token-pool-plan-engine.ts'
import type {
  MultiTokenPoolActors,
  MultiTokenPoolLaneFinding,
  MultiTokenPoolPlanBlock,
  MultiTokenPoolPlanStep,
  MultiTokenPoolStepSigner,
} from '../../../multi-token-pool.ts'
import type { SolanaExecuteParams, SolanaGenerateParams } from '../../operation.ts'
import { parseOptionalPublicKey, parsePublicKey } from '../../validate.ts'
import type { ParsedPoolGroupRef } from '../operations/common.ts'
import type { PoolGroupLaneKey } from '../types.ts'
import type {
  PoolGroupExecuteResult,
  PoolGroupFollowUp,
  PoolGroupUnsignedResult,
  PoolGroupUnsignedTx,
  SolanaTxBudget,
} from '../write-types.ts'

/** The parsed context of one planner call. @internal */
export type PlannerContext = {
  /** The planner's public name (error `operation`). */
  operation: string
  chain: SolanaChain
  /** The pool program and group. */
  ref: ParsedPoolGroupRef
  /** The fee payer (unsigned path) or the wallet (signed path). */
  payer: string
  /** The default actor: `authority`, else the payer or wallet. */
  actor: string
  /** Pays and signs the permissionless cranks; defaults to the step's actor. */
  crankPayer?: string
  /** Pays the `token*` lookup table creation. */
  lookupTablePayer?: string
  budget?: SolanaTxBudget
  actors?: MultiTokenPoolActors
  getChain?: ChainGetter
  concurrency?: number
  /** This run's landed step ids (`landedStepIds`, plus what the signed run landed). */
  landed: Set<string>
  /** This run's id: every pause step id carries it, so a landed list never crosses runs (M2). */
  runId: string
  /** Whether the transactions are built for a Squads vault (deferred execution). */
  squads: boolean
}

/** A built step, unsigned. @internal */
export type BuiltStep = {
  transactions: PoolGroupUnsignedTx[]
  snapshot?: PoolGroupUnsignedResult['snapshot']
  findings: MultiTokenPoolLaneFinding[]
  followUps?: PoolGroupFollowUp[]
  created?: Record<string, string>
}

/** A landed step, signed. @internal */
export type LandedStep = {
  hashes: string[]
  findings: MultiTokenPoolLaneFinding[]
  followUps?: PoolGroupFollowUp[]
  created?: Record<string, string>
}

/** How a step is built (unsigned) and landed (signed). @internal */
export type StepRun = {
  generate(payer: string): Promise<BuiltStep>
  execute(wallet: Wallet, computeUnits?: number): Promise<LandedStep>
}

/**
 * A plan step and how it runs. `run` is absent on a virtual step (`checkLanes`, the awaits): those
 * never build a transaction and are evaluated by the planner itself.
 * @internal
 */
export type StepSpec<Name extends string> = {
  step: MultiTokenPoolPlanStep<Name>
  run?: StepRun
  /** A crank: paid and signed by `crankPayer` when given. */
  crank?: boolean
  /** Virtual steps: the block they give while their condition does not hold (evaluated when ready). */
  evaluate?: () => Promise<MultiTokenPoolPlanBlock | null>
}

/** What a flow's expansion returns from one state read. @internal */
export type Expansion<Name extends string> = {
  specs: StepSpec<Name>[]
  /** A block found while expanding (an unacknowledged live admission, a foreign pause). */
  blockedBy?: MultiTokenPoolPlanBlock
  /** Warnings of the plan. */
  findings: MultiTokenPoolLaneFinding[]
  /** The slot the state was read at. */
  observedAt: bigint
  /** The pool group, when known. */
  poolGroupId?: string
  poolGroupAddress?: string
}

/** The step id scheme `<network>/<target>/<op>[/<remote>][/<chunk>]`. @internal */
export function stepId(
  ctx: PlannerContext,
  operation: string,
  ...rest: (string | bigint | number | undefined)[]
): string {
  return [
    ctx.chain.network.name,
    ctx.ref.group.toBase58(),
    operation,
    ...rest.filter((r) => r !== undefined).map(String),
  ].join('/')
}

/**
 * A step id bound to this run (`…/run-<runId>`): every step that pauses, and the unpause of that
 * pause, so `landedStepIds` kept from another run never lifts this run's pauses or theirs.
 * @internal
 */
export function runScopedId(
  ctx: PlannerContext,
  operation: string,
  ...rest: (string | bigint | number | undefined)[]
): string {
  return stepId(ctx, operation, ...rest, `run-${ctx.runId}`)
}

/** Resource keys of the Solana key scheme (design §8.1). @internal */
export const keys = {
  group: (g: PublicKey) => `pool-group:${g.toBase58()}`,
  chain: (g: PublicKey, c: bigint) => `pool-group-chain:${g.toBase58()}:${c}`,
  policy: (g: PublicKey, id: number) => `pool-group-policy:${g.toBase58()}:${id}`,
  policyChain: (g: PublicKey, id: number, c: bigint) =>
    `pool-group-policy-chain:${g.toBase58()}:${id}:${c}`,
  registry: (g: PublicKey) => `pool-group-registry:${g.toBase58()}`,
  member: (mint: string) => `pool-group-member:${mint}`,
  lane: (mint: string, c: bigint) => `lane:${mint}:${c}`,
  mintAuthority: (mint: string) => `mint:${mint}:authority`,
  poolState: (mint: string) => `pool-state:${mint}`,
  lookupTable: (address: string) => `lookup-table:${address}`,
} as const

/** Lanes, each once, by key. @internal */
export function laneKeyOf(l: PoolGroupLaneKey): string {
  return `${l.tokenAddress}:${l.remoteChainSelector}`
}

/**
 * Builds a step with its signer resolved: an `actors` entry, else the run's actor (a crank's actor is
 * `crankPayer` when given).
 * @internal
 */
export function specOf<Name extends string>(
  ctx: PlannerContext,
  fields: Omit<PlannedStepFields<Name>, 'signer'> & { signer: MultiTokenPoolStepSigner },
  extra: Omit<StepSpec<Name>, 'step'> = {},
): StepSpec<Name> {
  const fallback = extra.crank && ctx.crankPayer ? ctx.crankPayer : ctx.actor
  const address = resolveActor(ctx.actors, fields.signer, fallback)
  return { step: planStep({ ...fields, signer: { ...fields.signer, address } }), ...extra }
}

/** The generate and execute surface of a pool-group write. @internal */
export type PoolGroupOpLike<P extends object> = {
  generate(chain: SolanaChain, params: SolanaGenerateParams<P>): Promise<PoolGroupUnsignedResult>
  execute(chain: SolanaChain, params: SolanaExecuteParams<P>): Promise<PoolGroupExecuteResult>
}

/**
 * Binds a pool-group write to its params (with `authority` the step's actor): the unsigned build
 * passes the payer, the signed one the wallet. Every guard of the op runs on current state.
 * @internal
 */
export function bindPoolGroupOp<P extends object>(
  chain: SolanaChain,
  op: PoolGroupOpLike<P>,
  params: P,
  created?: (r: PoolGroupUnsignedResult | PoolGroupExecuteResult) => Record<string, string>,
): StepRun {
  return {
    generate: async (payer) => {
      const r = await op.generate(chain, { ...params, payer })
      const made = created?.(r)
      return {
        transactions: r.transactions,
        ...(r.snapshot && { snapshot: r.snapshot }),
        findings: r.findings,
        ...(r.followUps && { followUps: r.followUps }),
        ...(made && { created: made }),
      }
    },
    execute: async (wallet) => {
      const r = await op.execute(chain, { ...params, wallet })
      const made = created?.(r)
      return {
        hashes: r.transactions.map((t) => t.hash),
        findings: r.findings,
        ...(r.followUps && { followUps: r.followUps }),
        ...(made && { created: made }),
      }
    },
  }
}

/** The units of a `SetComputeUnitLimit` / micro-lamports of a `SetComputeUnitPrice` in `tx`, or 0. */
function computeBudgetOf(tx: UnsignedSolanaTx, discriminator: 2 | 3): number {
  const ix = tx.instructions.find(
    (i) => i.programId.equals(ComputeBudgetProgram.programId) && i.data[0] === discriminator,
  )
  if (!ix) return 0
  return discriminator === 2 ? ix.data.readUInt32LE(1) : Number(ix.data.readBigUInt64LE(1))
}

/**
 * A transaction of a non-pool-group op (`onboardToken`'s, `editChainConfigV2`, a table extend) in the
 * planner's transaction shape: its signers from the instructions, each labelled `role` (what the
 * step's actor signs as: `'token-admin'` for `onboardToken`'s steps, `'lookup-table-authority'` for a
 * table extend, `'pool-owner'` for a lane edit), its compute budget as placed (0 when not set). It has
 * no `outerInstructions`, so `toPoolGroupSquadsBatch` refuses it: a Squads vault proposes it as a
 * single vault transaction.
 * @internal
 */
export function toPlannerTx(
  tx: UnsignedSolanaTx,
  payer: string,
  tokenAddresses: string[],
  role: Exclude<PoolGroupUnsignedTx['requiredSigners'][number]['role'], 'payer'>,
): PoolGroupUnsignedTx {
  const signers = new Set<string>()
  for (const ix of tx.instructions)
    for (const k of ix.keys) if (k.isSigner) signers.add(k.pubkey.toBase58())
  signers.delete(payer)
  return {
    ...tx,
    requiredSigners: [
      { address: payer, role: 'payer' },
      ...[...signers].map((address) => ({ address, role })),
    ],
    tokenAddresses,
    computeUnitLimit: computeBudgetOf(tx, 2),
    computeUnitPrice: computeBudgetOf(tx, 3),
  }
}

/** The parsed signer fields of a planner call. @internal */
export type ParsedPlannerSigner = {
  payer: string
  actor: string
  crankPayer?: string
  lookupTablePayer?: string
}

/**
 * Parses the payer, actor and the Solana execution options; refuses the other family's blocks and
 * signer fields (`undefined` counts as absent).
 * @throws {@link CCTParamsInvalidError} if a field is invalid
 * @internal
 */
export function parsePlannerSigner(
  operation: string,
  params: { authority?: string; solana?: { crankPayer?: string; lookupTablePayer?: string } },
  payer: PublicKey,
): ParsedPlannerSigner {
  for (const foreign of ['evm', 'sender'] as const)
    if (Reflect.get(params, foreign) !== undefined)
      throw new CCTParamsInvalidError(
        operation,
        foreign,
        foreign === 'evm'
          ? 'an EVM block on a Solana planner: put Solana-only fields under `solana`'
          : '`sender` is the EVM signer field: on Solana pass `payer` (and `authority`)',
      )
  const solana: unknown = Reflect.get(params, 'solana')
  if (solana !== undefined && (typeof solana !== 'object' || solana === null))
    throw new CCTParamsInvalidError(operation, 'solana', 'must be an object')
  const actor = parseOptionalPublicKey(operation, 'authority', params.authority) ?? payer
  const crankPayer = parseOptionalPublicKey(
    operation,
    'solana.crankPayer',
    params.solana?.crankPayer,
  )
  const lookupTablePayer = parseOptionalPublicKey(
    operation,
    'solana.lookupTablePayer',
    params.solana?.lookupTablePayer,
  )
  return {
    payer: payer.toBase58(),
    actor: actor.toBase58(),
    ...(crankPayer && { crankPayer: crankPayer.toBase58() }),
    ...(lookupTablePayer && { lookupTablePayer: lookupTablePayer.toBase58() }),
  }
}

/**
 * Parses `runId` (letters, digits, `_` and `-`, at most 64), else a new one: the unsigned caller
 * passes back the `runId` the first plan returned, with `landedStepIds`.
 * @internal
 */
export function parseRunId(operation: string, value: unknown): string {
  if (value === undefined) return newRunId()
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value))
    throw new CCTParamsInvalidError(
      operation,
      'runId',
      'must be the runId a plan of this run returned (letters, digits, _ and -, at most 64)',
    )
  return value
}

/** Parses `landedStepIds`: an array of strings. @internal */
export function parseLandedStepIds(operation: string, value: unknown): Set<string> {
  if (value === undefined) return new Set()
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))
    throw new CCTParamsInvalidError(operation, 'landedStepIds', 'must be an array of step ids')
  return new Set(value.filter((v): v is string => typeof v === 'string'))
}

/** Parses a mint at `param`. @internal */
export const parseMint = (operation: string, param: string, value: unknown) =>
  parsePublicKey(operation, param, value).toBase58()
