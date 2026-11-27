/**
 * The three entry points every Solana planner shares (design §8.1): the plan from chain state, the
 * unsigned build of every ready step, and the signed run that lands step after step and re-plans
 * after each one. Each flow supplies only its expansion (state read → steps); the family-neutral
 * half (virtual steps, actor holds, ready selection, the signed loop) is the engine's.
 *
 * @packageDocumentation
 */

import type { Wallet } from '../../../../solana/types.ts'
import { evaluateExpansion, runSignedPlan } from '../../../multi-token-pool-plan-engine.ts'
import type {
  MultiTokenPoolExecutedStep,
  MultiTokenPoolLaneFinding,
  MultiTokenPoolPlanStep,
} from '../../../multi-token-pool.ts'
import { refreshAccountState } from '../../operation.ts'
import type { PoolGroupFollowUp } from '../write-types.ts'
import type { Expansion, LandedStep, PlannerContext, StepSpec } from './context.ts'
import type {
  ExecutePoolGroupPlanResult,
  GeneratePoolGroupPlanResult,
  PoolGroupPlan,
  PoolGroupReadyStep,
} from './types.ts'

/** The plan options the runner reads. @internal */
export type RunOptions = {
  pendingStepHashes?: Record<string, string>
  maxReadySteps?: number
  onStep?: (step: MultiTokenPoolExecutedStep) => void | Promise<void>
  signal?: AbortSignal
}

/** One evaluated plan: the remaining specs, the ready ones and the block. @internal */
export type EvaluatedPlan<Name extends string> = {
  plan: PoolGroupPlan<Name>
  specs: StepSpec<Name>[]
  ready: StepSpec<Name>[]
}

/**
 * Expands, then runs the engine's evaluation (virtual steps, actor holds, ready selection, merged
 * blocks) and adds the Solana fields (findings, pool group ids).
 * @param walletActor - On the signed path: steps of any other actor are held, with an actor block.
 * @internal
 */
export async function evaluatePlan<Name extends string>(
  ctx: PlannerContext,
  expand: () => Promise<Expansion<Name>>,
  options: RunOptions,
  walletActor?: string,
): Promise<EvaluatedPlan<Name>> {
  const expansion = await expand()
  const { plan, specs, ready } = await evaluateExpansion<Name, StepSpec<Name>>(
    expansion,
    options,
    ctx.runId,
    walletActor,
  )
  return {
    plan: {
      ...plan,
      findings: expansion.findings,
      ...(expansion.poolGroupId && { poolGroupId: expansion.poolGroupId }),
      ...(expansion.poolGroupAddress && { poolGroupAddress: expansion.poolGroupAddress }),
    },
    specs,
    ready,
  }
}

/** The plan getter: remaining steps, ready selection and block; builds nothing. @internal */
export async function planFlow<Name extends string>(
  ctx: PlannerContext,
  expand: () => Promise<Expansion<Name>>,
  options: RunOptions,
): Promise<PoolGroupPlan<Name>> {
  refreshAccountState(ctx.chain)
  return (await evaluatePlan(ctx, expand, options)).plan
}

/** The payer of a ready step's transactions on the unsigned path. */
const payerOf = (ctx: PlannerContext, spec: StepSpec<string>) =>
  spec.crank && ctx.crankPayer ? ctx.crankPayer : ctx.payer

/**
 * The unsigned path: plans, then builds every ready step with its own op on current state. Ready
 * steps commute, so they may land in any order or together (one Squads batch).
 * @internal
 */
export async function generateFlow<Name extends string>(
  ctx: PlannerContext,
  expand: () => Promise<Expansion<Name>>,
  options: RunOptions,
): Promise<GeneratePoolGroupPlanResult<Name>> {
  refreshAccountState(ctx.chain)
  const { plan, ready } = await evaluatePlan(ctx, expand, options)
  const built: PoolGroupReadyStep<Name>[] = []
  for (const spec of ready) {
    const b = await spec.run!.generate(payerOf(ctx, spec))
    built.push({
      step: spec.step,
      transactions: b.transactions,
      ...(b.snapshot && { snapshot: b.snapshot }),
      findings: b.findings,
      ...(b.followUps && { followUps: b.followUps }),
    })
  }
  return { ...plan, ready: built, payer: ctx.payer }
}

/**
 * The signed path: the engine's signed loop over this flow, with the wallet landing each step it is
 * the actor of; the findings, follow-ups and pool group ids are gathered here.
 * @throws {@link CCIPError} once steps have started, carrying `context.executedSteps`
 * @internal
 */
export async function executeFlow<Name extends string>(
  ctx: PlannerContext,
  expand: () => Promise<Expansion<Name>>,
  options: RunOptions,
  wallet: Wallet,
  computeUnits?: number,
): Promise<ExecutePoolGroupPlanResult<Name>> {
  const walletActor = wallet.publicKey.toBase58()
  const findings: MultiTokenPoolLaneFinding[] = []
  const followUps: PoolGroupFollowUp[] = []
  const ids: { poolGroupId?: string; poolGroupAddress?: string } = {}
  const { steps, blockedBy } = await runSignedPlan<
    Name,
    StepSpec<Name>,
    LandedStep & { followUps: PoolGroupFollowUp[] },
    PoolGroupPlan<Name>
  >({
    evaluate: () => evaluatePlan(ctx, expand, options, walletActor),
    refresh: () => refreshAccountState(ctx.chain),
    land: async (spec: StepSpec<Name>) => {
      const landed = await spec.run!.execute(wallet, computeUnits)
      return { ...landed, followUps: landed.followUps ?? [] }
    },
    landed: ctx.landed,
    onPlan: (plan: PoolGroupPlan<Name>) => {
      if (plan.poolGroupId) ids.poolGroupId = plan.poolGroupId
      if (plan.poolGroupAddress) ids.poolGroupAddress = plan.poolGroupAddress
      for (const f of plan.findings)
        if (!findings.some((g) => g.check === f.check && g.reason === f.reason)) findings.push(f)
    },
    onLanded: (_spec, landed) => {
      findings.push(...landed.findings)
      followUps.push(...landed.followUps)
      if (landed.created?.poolGroupId) ids.poolGroupId = landed.created.poolGroupId
      if (landed.created?.poolGroupAddress) ids.poolGroupAddress = landed.created.poolGroupAddress
    },
    ...(options.onStep && { onStep: options.onStep }),
    ...(options.signal && { signal: options.signal }),
  })
  return {
    ...ids,
    runId: ctx.runId,
    steps,
    ...(blockedBy && { blockedBy }),
    findings,
    ...(followUps.length && { followUps }),
  }
}

/** The remaining steps a plan returns, for tests and goldens. @internal */
export const stepNames = <Name extends string>(steps: readonly MultiTokenPoolPlanStep<Name>[]) =>
  steps.map((s) => s.name)
