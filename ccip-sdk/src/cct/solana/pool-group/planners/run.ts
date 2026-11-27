/**
 * The three entry points every Solana planner shares (design §8.1): the plan from chain state, the
 * unsigned build of every ready step, and the signed run that lands step after step and re-plans
 * after each one. Each flow supplies only its expansion (state read → steps).
 *
 * @packageDocumentation
 */

import { CCIPError } from '../../../../errors/index.ts'
import type { Wallet } from '../../../../solana/types.ts'
import { sleep } from '../../../../utils.ts'
import type {
  MultiTokenPoolExecutedStep,
  MultiTokenPoolLaneFinding,
  MultiTokenPoolPlanBlock,
  MultiTokenPoolPlanStep,
} from '../../../multi-token-pool.ts'
import { refreshAccountState } from '../../operation.ts'
import type { PoolGroupFollowUp } from '../write-types.ts'
import type { Expansion, PlannerContext, StepSpec } from './context.ts'
import { planHashOf, selectReady } from './engine.ts'
import type {
  ExecutePoolGroupPlanResult,
  GeneratePoolGroupPlanResult,
  PoolGroupExecutedPlanStep,
  PoolGroupPlan,
  PoolGroupReadyStep,
} from './types.ts'

/** How many times the signed run reads the state again when it does not show the last step yet. */
const STATE_READ_ATTEMPTS = 5
/** Delay between those reads, for an RPC node behind the one that confirmed the step. */
const STATE_READ_INTERVAL_MS = 1_000

/**
 * The default `maxReadySteps` of the unsigned path: 20. Ready steps commute (pairwise free of
 * conflicts), so every one of them can go in one proposal round; a cap of 1 makes each a round of
 * its own, which multiplies multisig approvals by the step count. 20 is the transaction count of one
 * Squads batch (`toPoolGroupSquadsBatch`), so a default wave fills about one batch; a wallet caller
 * lands them in any order. Pass 1 to review one step at a time.
 * @internal
 */
export const DEFAULT_MAX_READY_STEPS = 20

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

/** Attaches `context` to an error, as `onboardToken` does. */
function withContext(error: unknown, context: Record<string, unknown>): CCIPError {
  const failure = CCIPError.isCCIPError(error) ? error : CCIPError.from(error)
  Object.assign(failure.context, context)
  return failure
}

/**
 * Expands, evaluates the virtual steps whose dependencies landed (a passing one counts as landed, a
 * failing one gives the block), and selects the ready steps.
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
  let specs = expansion.specs
  const blocks: MultiTokenPoolPlanBlock[] = expansion.blockedBy ? [expansion.blockedBy] : []
  const held = new Set<string>(expansion.blockedBy?.steps ?? [])
  // virtual steps whose dependencies landed are judged now; a pass frees what depends on them
  for (let changed = true; changed;) {
    changed = false
    const remaining = new Set(specs.map((s) => s.step.id))
    for (const spec of specs) {
      if (!spec.evaluate || held.has(spec.step.id)) continue
      if (spec.step.dependsOn.some((d) => remaining.has(d))) continue
      const block = await spec.evaluate()
      if (block) {
        blocks.push({ ...block, steps: block.steps ?? [spec.step.id] })
        held.add(spec.step.id)
      } else {
        specs = specs.filter((s) => s !== spec)
        changed = true
      }
      break
    }
  }
  for (const spec of specs) if (spec.evaluate) held.add(spec.step.id)
  if (walletActor !== undefined) {
    const others = specs.filter(
      (s) => s.run && !held.has(s.step.id) && s.step.signer.address !== walletActor,
    )
    const remaining = new Set(specs.map((s) => s.step.id))
    const first = others.find((s) => !s.step.dependsOn.some((d) => remaining.has(d)))
    if (first)
      blocks.push({
        reason: `step ${first.step.id} needs ${first.step.signer.address ?? 'another signer'} (${first.step.signer.kind}), not the wallet: run it with that signer, or plan it with generateUnsigned and actors`,
        actor: first.step.signer,
        steps: others.map((s) => s.step.id),
      })
    for (const s of others) held.add(s.step.id)
  }
  const steps = specs.map((s) => s.step)
  const selected = selectReady(steps, {
    ...(options.pendingStepHashes && { pendingStepHashes: options.pendingStepHashes }),
    maxReadySteps:
      walletActor !== undefined ? Infinity : (options.maxReadySteps ?? DEFAULT_MAX_READY_STEPS),
    held,
  })
  const readyIds = new Set(selected.ready.map((s) => s.id))
  const block = mergeBlocks(blocks)
  const present = new Set(steps.map((s) => s.id))
  const plan: PoolGroupPlan<Name> = {
    steps,
    ...(block && { blockedBy: block }),
    pendingSteps: selected.pendingSteps,
    stalePendingSteps: selected.stalePendingSteps,
    vanishedPendingSteps: Object.keys(options.pendingStepHashes ?? {}).filter(
      (id) => !present.has(id),
    ),
    runId: ctx.runId,
    moreReady: selected.moreReady,
    planHash: planHashOf(expansion.observedAt, steps),
    observedAt: expansion.observedAt,
    findings: expansion.findings,
    ...(expansion.poolGroupId && { poolGroupId: expansion.poolGroupId }),
    ...(expansion.poolGroupAddress && { poolGroupAddress: expansion.poolGroupAddress }),
  }
  return { plan, specs, ready: specs.filter((s) => readyIds.has(s.step.id)) }
}

/**
 * Every block of a plan as one (S6 review m4): the reasons joined, the blocked steps merged, the
 * first actor and remote chain kept. A removal over K lanes reports every confirmation it needs at
 * once, not one per re-plan.
 * @internal
 */
export function mergeBlocks(
  blocks: readonly MultiTokenPoolPlanBlock[],
): MultiTokenPoolPlanBlock | undefined {
  if (blocks.length <= 1) return blocks[0]
  const actor = blocks.find((b) => b.actor)?.actor
  const remote = blocks.find((b) => b.remoteChainSelector !== undefined)?.remoteChainSelector
  return {
    reason: [...new Set(blocks.map((b) => b.reason))].join(' | '),
    steps: [...new Set(blocks.flatMap((b) => b.steps ?? []))],
    ...(actor && { actor }),
    ...(remote !== undefined && { remoteChainSelector: remote }),
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
 * The signed path: lands the first ready step the wallet is the actor of, re-plans from chain state,
 * and repeats until the plan is empty or blocked. A landed step that the next plan still needs (an RPC
 * node behind, or an op that left lanes out) is read again a few times, then ends the run in
 * `blockedBy` with the op's findings.
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
  const executed: PoolGroupExecutedPlanStep<Name>[] = []
  const findings: MultiTokenPoolLaneFinding[] = []
  const followUps: PoolGroupFollowUp[] = []
  const ids: { poolGroupId?: string; poolGroupAddress?: string } = {}
  const finish = (blockedBy?: MultiTokenPoolPlanBlock): ExecutePoolGroupPlanResult<Name> => ({
    ...ids,
    runId: ctx.runId,
    steps: executed,
    ...(blockedBy && { blockedBy }),
    findings,
    ...(followUps.length && { followUps }),
  })
  try {
    let last: { id: string; progress: number; findings: MultiTokenPoolLaneFinding[] } | undefined
    for (;;) {
      options.signal?.throwIfAborted()
      refreshAccountState(ctx.chain)
      let evaluated = await evaluatePlan(ctx, expand, options, walletActor)
      const stillThere = () =>
        last &&
        evaluated.specs.some((s) => s.step.id === last!.id && s.step.progress >= last!.progress)
      for (let attempt = 1; attempt < STATE_READ_ATTEMPTS && stillThere(); attempt++) {
        await sleep(STATE_READ_INTERVAL_MS)
        refreshAccountState(ctx.chain)
        evaluated = await evaluatePlan(ctx, expand, options, walletActor)
      }
      const { plan, ready } = evaluated
      if (plan.poolGroupId) ids.poolGroupId = plan.poolGroupId
      if (plan.poolGroupAddress) ids.poolGroupAddress = plan.poolGroupAddress
      for (const f of plan.findings)
        if (!findings.some((g) => g.check === f.check && g.reason === f.reason)) findings.push(f)
      if (stillThere())
        return finish({
          reason: `step ${last!.id} landed, but the state still needs it${
            last!.findings.length
              ? `: ${last!.findings.map((f) => `${f.check} on ${f.tokenAddress} → ${f.remoteChainSelector}: ${f.reason}`).join('; ')}`
              : ' (the RPC node may be behind)'
          }`,
          steps: [last!.id],
        })
      const spec = ready[0]
      // steps left and none ready is never "done" (S6 review m3)
      if (!spec)
        return finish(
          plan.blockedBy ??
            (plan.steps.length
              ? {
                  reason: `${plan.steps.length} step(s) remain and none is ready for this wallet: ${plan.steps.map((s) => s.id).join(', ')}`,
                  steps: plan.steps.map((s) => s.id),
                }
              : undefined),
        )
      const landed = await spec.run!.execute(wallet, computeUnits)
      ctx.landed.add(spec.step.id)
      findings.push(...landed.findings)
      followUps.push(...(landed.followUps ?? []))
      const step: PoolGroupExecutedPlanStep<Name> = {
        ...spec.step,
        hashes: landed.hashes,
        ...(landed.created && { created: landed.created }),
      }
      if (landed.created?.poolGroupId) ids.poolGroupId = landed.created.poolGroupId
      if (landed.created?.poolGroupAddress) ids.poolGroupAddress = landed.created.poolGroupAddress
      executed.push(step)
      last = { id: spec.step.id, progress: spec.step.progress, findings: landed.findings }
      await options.onStep?.(step)
    }
  } catch (error) {
    throw withContext(error, { executedSteps: executed })
  }
}

/** The remaining steps a plan returns, for tests and goldens. @internal */
export const stepNames = <Name extends string>(steps: readonly MultiTokenPoolPlanStep<Name>[]) =>
  steps.map((s) => s.name)
