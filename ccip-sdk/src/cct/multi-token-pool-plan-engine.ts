/**
 * The ready-step engine of the shared planners, family-neutral (it imports no family code): step
 * construction with `inputsHash`, the ready-step rule (`MultiTokenPoolPlanOptions`), pending and
 * stale proposals, stable chunking, actor resolution, the plan hash, the run-scoped landed-pause
 * unpause rule (A16), and the runner's neutral half: virtual-step evaluation, actor holds, merged
 * blocks, and the signed loop with its "still there" re-read (chain refresh and landing injected).
 *
 * Shared by both families' planners (Solana S6 now, EVM E10-E12): a family supplies its expansion
 * (state read → steps with `run` or `evaluate`) and its landing.
 *
 * @packageDocumentation
 */

import { CCIPError } from '../errors/index.ts'
import { sleep } from '../utils.ts'
import { canonicalHash } from './canonical.ts'
import type {
  MultiTokenPoolActors,
  MultiTokenPoolExecutedStep,
  MultiTokenPoolLaneFinding,
  MultiTokenPoolPlan,
  MultiTokenPoolPlanBlock,
  MultiTokenPoolPlanStep,
  MultiTokenPoolStalePendingStep,
  MultiTokenPoolStepSigner,
} from './multi-token-pool.ts'

/** The fields a planner gives for one step; `inputsHash` is computed. @internal */
export type PlannedStepFields<Name extends string> = Omit<
  MultiTokenPoolPlanStep<Name>,
  'inputsHash' | 'progress' | 'dependsOn'
> & {
  /** Ids of steps that must land first; ids no longer in the plan have landed. */
  dependsOn?: string[]
  /** Tokens or lanes left for this step name; defaults to 1. */
  progress?: number
}

/**
 * Builds a plan step: `inputsHash` is keccak256 of the canonical JSON of `inputs` (the snapshot
 * encoding, A3), so the same inputs give the same hash on every call.
 * @internal
 */
export function planStep<Name extends string>(
  fields: PlannedStepFields<Name>,
): MultiTokenPoolPlanStep<Name> {
  return {
    ...fields,
    dependsOn: [...new Set(fields.dependsOn ?? [])],
    inputsHash: canonicalHash(fields.inputs),
    progress: fields.progress ?? 1,
  }
}

/** Whether two steps conflict: a write of one meets a write or a guard read of the other. @internal */
export function stepsConflict(
  a: Pick<MultiTokenPoolPlanStep<string>, 'writeSet' | 'guardReads'>,
  b: Pick<MultiTokenPoolPlanStep<string>, 'writeSet' | 'guardReads'>,
): boolean {
  const meets = (x: readonly string[], y: readonly string[]) => {
    const set = new Set(y)
    return x.some((k) => set.has(k))
  }
  return (
    meets(a.writeSet, b.writeSet) ||
    meets(a.writeSet, b.guardReads) ||
    meets(a.guardReads, b.writeSet)
  )
}

/** What the ready selection needs besides the steps. @internal */
export type ReadySelection = {
  /** `step.id` → `step.inputsHash` of proposed steps (the caller's `pendingStepHashes`). */
  pendingStepHashes?: Record<string, string>
  /** Most ready steps returned; `Infinity` on the signed path. */
  maxReadySteps: number
  /** Step ids that cannot be built now (a block, a virtual step); never ready. */
  held?: ReadonlySet<string>
}

/** The ready steps, the ones `maxReadySteps` held back, and the pending and stale proposals. @internal */
export type ReadyResult<Name extends string> = {
  /** Ready steps, in plan order, pairwise free of conflicts. */
  ready: MultiTokenPoolPlanStep<Name>[]
  /** Steps that were ready but held back by `maxReadySteps`. */
  moreReady: number
  /** Proposed steps that still hold (same id, same inputs). */
  pendingSteps: string[]
  /** Proposed steps whose inputs moved since they were built. */
  stalePendingSteps: MultiTokenPoolStalePendingStep[]
}

/**
 * Applies the ready-step rule to the remaining steps of a plan (in plan order): a step is ready when
 * no step it depends on is still in the plan, it is not pending, and it conflicts with no step
 * already chosen. A pending step whose current `inputsHash` differs from the proposed one is stale:
 * the state it was built on moved, so the proposal must be rejected.
 * @internal
 */
export function selectReady<Name extends string>(
  steps: readonly MultiTokenPoolPlanStep<Name>[],
  { pendingStepHashes = {}, maxReadySteps, held = new Set() }: ReadySelection,
): ReadyResult<Name> {
  const remaining = new Set(steps.map((s) => s.id))
  const pendingSteps: string[] = []
  const stalePendingSteps: MultiTokenPoolStalePendingStep[] = []
  const pending = new Set<string>()
  for (const s of steps) {
    const proposed = pendingStepHashes[s.id]
    if (proposed === undefined) continue
    pending.add(s.id)
    if (proposed === s.inputsHash) pendingSteps.push(s.id)
    else
      stalePendingSteps.push({
        id: s.id,
        changed: [{ path: 'inputsHash', expected: proposed, actual: s.inputsHash }],
        findings: [],
      })
  }
  const chosen: MultiTokenPoolPlanStep<Name>[] = []
  let moreReady = 0
  for (const s of steps) {
    if (pending.has(s.id) || held.has(s.id)) continue
    if (s.dependsOn.some((d) => remaining.has(d))) continue
    // a pending step still occupies its resources until it lands
    const busy = [...chosen, ...steps.filter((p) => pending.has(p.id))]
    if (busy.some((c) => stepsConflict(c, s))) continue
    if (chosen.length >= maxReadySteps) {
      moreReady++
      continue
    }
    chosen.push(s)
  }
  return { ready: chosen, moreReady, pendingSteps, stalePendingSteps }
}

/** The plan hash: the observation point and every remaining step's id and inputs. @internal */
export function planHashOf(
  observedAt: bigint,
  steps: readonly Pick<MultiTokenPoolPlanStep<string>, 'id' | 'inputsHash'>[],
): string {
  return canonicalHash({ observedAt, steps: steps.map((s) => [s.id, s.inputsHash]) })
}

/**
 * The actor of a step: the first matching `actors` entry (record, matcher list or resolver), else
 * `fallback` (the wallet on the signed path, `authority` on the unsigned one).
 * @internal
 */
export function resolveActor(
  actors: MultiTokenPoolActors | undefined,
  signer: MultiTokenPoolStepSigner,
  fallback: string,
): string {
  if (signer.address !== undefined) return signer.address
  if (typeof actors === 'function') return actors(signer) ?? fallback
  if (Array.isArray(actors)) {
    const hit = actors.find(
      (a) =>
        a.kind === signer.kind &&
        (a.on === undefined || a.on === signer.on) &&
        (a.role === undefined || (signer.anyOf ?? []).includes(a.role)) &&
        (a.tokenAddress === undefined || a.tokenAddress === signer.tokenAddress),
    )
    return hit?.address ?? fallback
  }
  return actors?.[signer.kind] ?? fallback
}

/**
 * Chunks of `items` whose composition never depends on what remains (S6 review M1): `items` (the
 * full input, in its caller-given order) is cut into chunks of `size`, each chunk keeps only the
 * items still to do, and empty chunks are dropped. Each chunk is keyed by the first item of its
 * full chunk, so a chunk's step id is the same in every plan: a partial landing never re-proposes a
 * pending chunk under a new id, and a chunk whose items all landed leaves the plan.
 * @returns the chunks to do, and the key of every item's chunk (done or not)
 * @internal
 */
export function stableChunks<T>(
  items: readonly T[],
  size: number,
  keep: (item: T) => boolean,
  keyOf: (item: T) => string,
): { chunks: { key: string; items: T[] }[]; chunkKeyOf: Map<T, string> } {
  const chunks: { key: string; items: T[] }[] = []
  const chunkKeyOf = new Map<T, string>()
  for (let i = 0; i < items.length; i += size) {
    const full = items.slice(i, i + size)
    const key = keyOf(full[0]!)
    for (const item of full) chunkKeyOf.set(item, key)
    const left = full.filter(keep)
    if (left.length) chunks.push({ key, items: left })
  }
  return { chunks, chunkKeyOf }
}

/** A new run id: 16 random hex characters (a pause step id carries it, S6 review M2). @internal */
export function newRunId(): string {
  // Web Crypto (Node 20+ and browsers): the engine imports no family library
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(8)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}

/**
 * The unpause rule (A16, OC2), run-scoped (S6 review M2). Every pause step id carries the run id, so
 * `landed` (in memory on the signed path, `landedStepIds` on the unsigned one) can only name this
 * run's pauses: a list kept from an earlier run never lifts a later pause, such as an incident pause.
 * A pause is lifted only when:
 * - this run has not lifted it already (its `unpauseStepId` is not in `landed`: a pause after that
 *   is someone else's);
 * - one of its pause steps is still planned (the unpause then depends on it), or landed in this run
 *   and the state on chain is still the one that step set (`onChain`).
 * Anything else fails closed with a block that names the pause step.
 * @returns `'lift'` (with the pause steps to depend on when still planned), or the block.
 * @internal
 */
export function unpauseDecision(input: {
  /** This run's pause step ids that may have set the pause (any one of them landing suffices). */
  pauseStepIds: readonly string[]
  /** The ones still in the plan. */
  pausePlanned: readonly string[]
  /** This run's unpause step id for the same pause. */
  unpauseStepId: string
  /** This run's landed step ids. */
  landed: ReadonlySet<string>
  /** What the pause is, for the block reason. */
  what: string
  /** Whether the pause on chain is still the one the landed step set; omitted: not checked. */
  onChain?: { ok: true } | { ok: false; reason: string }
}): { lift: true; dependsOn: string[] } | { lift: false; block: MultiTokenPoolPlanBlock } {
  const steps = [input.pauseStepIds[0] ?? input.unpauseStepId]
  if (input.landed.has(input.unpauseStepId))
    return {
      lift: false,
      block: {
        reason: `${input.what} is paused, but this run already lifted its own pause (${input.unpauseStepId} landed): the pause now is someone else's and is never lifted here`,
        steps,
      },
    }
  if (input.pausePlanned.length) return { lift: true, dependsOn: [...input.pausePlanned] }
  if (input.pauseStepIds.some((id) => input.landed.has(id))) {
    if (input.onChain && !input.onChain.ok)
      return {
        lift: false,
        block: {
          reason: `${input.what} is paused, but not as this run's pause step left it (${input.onChain.reason}): someone else changed it, so it is never lifted here`,
          steps,
        },
      }
    return { lift: true, dependsOn: [] }
  }
  return {
    lift: false,
    block: {
      reason: `${input.what} is paused, but this run did not land its pause step ${steps[0]}: a pause this run did not set is never lifted. If this run landed it, pass the same runId and its id in landedStepIds (both are per run: discard them once the run completes); otherwise lift it yourself after checking the lanes`,
      steps,
    },
  }
}

// ─── The runner's family-neutral half ────────────────────────────────────────────────────────

/**
 * The default `maxReadySteps` of the unsigned path: 20. Ready steps commute (pairwise free of
 * conflicts), so every one of them can go in one proposal round; a cap of 1 makes each a round of
 * its own, which multiplies multisig approvals by the step count. 20 is the transaction count of one
 * Squads batch (`toPoolGroupSquadsBatch`), and well under a Safe `multiSend` of small calls, so a
 * default wave fills about one approval; a wallet caller lands them in any order. Pass 1 to review
 * one step at a time.
 * @internal
 */
export const DEFAULT_MAX_READY_STEPS = 20

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

/**
 * A plan step as the engine runs it: `run` (any value) when the step builds transactions, or
 * `evaluate` on a virtual step (a check, an await), which the engine judges itself.
 * @internal
 */
export type EngineSpec<Name extends string> = {
  /** The step. */
  step: MultiTokenPoolPlanStep<Name>
  /** Present when the step builds transactions (the family's build, opaque here). */
  run?: unknown
  /** A virtual step: the block it gives while its condition does not hold. */
  evaluate?: () => Promise<MultiTokenPoolPlanBlock | null>
}

/** What a family's expansion gives the engine: its specs, a block found while expanding, the read point. @internal */
export type EngineExpansion<S> = {
  /** The remaining steps, in plan order. */
  specs: S[]
  /** A block found while expanding. */
  blockedBy?: MultiTokenPoolPlanBlock
  /** Block (EVM) or slot (Solana) the state was read at. */
  observedAt: bigint
}

/** The engine's part of a plan: the shared plan, the run id and the pending ids that vanished. @internal */
export type EnginePlan<Name extends string> = MultiTokenPoolPlan<Name> & {
  /** This run's id. */
  runId: string
  /** Ids in `pendingStepHashes` that are no longer in the plan (they landed, or are not needed). */
  vanishedPendingSteps: string[]
}

/** The plan options the engine reads. @internal */
export type EnginePlanOptions = {
  /** `step.id` → `step.inputsHash` of proposed steps. */
  pendingStepHashes?: Record<string, string>
  /** Most ready steps returned on the unsigned path; defaults to {@link DEFAULT_MAX_READY_STEPS}. */
  maxReadySteps?: number
}

/**
 * Evaluates an expansion: judges the virtual steps whose dependencies landed (a passing one counts
 * as landed, a failing one gives a block), holds the steps of another actor on the signed path (with
 * an actor block), selects the ready steps, and merges every block.
 * @param walletActor - On the signed path: steps of any other actor are held.
 * @internal
 */
export async function evaluateExpansion<Name extends string, S extends EngineSpec<Name>>(
  expansion: EngineExpansion<S>,
  options: EnginePlanOptions,
  runId: string,
  walletActor?: string,
): Promise<{ plan: EnginePlan<Name>; specs: S[]; ready: S[] }> {
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
      (s) => s.run !== undefined && !held.has(s.step.id) && s.step.signer.address !== walletActor,
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
  return {
    plan: {
      steps,
      ...(block && { blockedBy: block }),
      pendingSteps: selected.pendingSteps,
      stalePendingSteps: selected.stalePendingSteps,
      vanishedPendingSteps: Object.keys(options.pendingStepHashes ?? {}).filter(
        (id) => !present.has(id),
      ),
      runId,
      moreReady: selected.moreReady,
      planHash: planHashOf(expansion.observedAt, steps),
      observedAt: expansion.observedAt,
    },
    specs,
    ready: specs.filter((s) => readyIds.has(s.step.id)),
  }
}

/** How many times the signed run reads the state again when it does not show the last step yet. */
const STATE_READ_ATTEMPTS = 5
/** Delay between those reads, for an RPC node behind the one that confirmed the step. */
const STATE_READ_INTERVAL_MS = 1_000

/** What landing one step returns to the signed loop. @internal */
export type EngineLanded = {
  /** The transaction hashes, in order. */
  hashes: string[]
  /** The op's findings (named in the block when the state still needs the step). */
  findings: MultiTokenPoolLaneFinding[]
  /** Accounts the step created, by name. */
  created?: Record<string, string>
}

/**
 * The signed loop: plans (`evaluate`, after `refresh` drops cached chain state), lands the first
 * ready step (`land`), records its id in `landed`, calls `onStep`, and repeats until the plan is
 * empty or blocked. A landed step that the next plan still needs (an RPC node behind, or an op that
 * left lanes out) is read again a few times, then ends the run with a block naming the op's
 * findings. Steps left and none ready is a block, never "done" (S6 review m3).
 * @throws {@link CCIPError} once steps have started, carrying `context.executedSteps`
 * @internal
 */
export async function runSignedPlan<
  Name extends string,
  S extends EngineSpec<Name>,
  L extends EngineLanded,
  P extends EnginePlan<Name> = EnginePlan<Name>,
>(input: {
  evaluate: () => Promise<{ plan: P; specs: S[]; ready: S[] }>
  refresh: () => void
  land: (spec: S) => Promise<L>
  landed: Set<string>
  onPlan?: (plan: P) => void
  onLanded?: (spec: S, landed: L) => void
  onStep?: (step: MultiTokenPoolExecutedStep) => void | Promise<void>
  signal?: AbortSignal
}): Promise<{
  steps: (MultiTokenPoolPlanStep<Name> & { hashes: string[]; created?: Record<string, string> })[]
  blockedBy?: MultiTokenPoolPlanBlock
}> {
  const executed: (MultiTokenPoolPlanStep<Name> & {
    hashes: string[]
    created?: Record<string, string>
  })[] = []
  const finish = (blockedBy?: MultiTokenPoolPlanBlock) => ({
    steps: executed,
    ...(blockedBy && { blockedBy }),
  })
  try {
    let last: { id: string; progress: number; findings: MultiTokenPoolLaneFinding[] } | undefined
    for (;;) {
      input.signal?.throwIfAborted()
      input.refresh()
      let evaluated = await input.evaluate()
      const stillThere = () =>
        last &&
        evaluated.specs.some((s) => s.step.id === last!.id && s.step.progress >= last!.progress)
      for (let attempt = 1; attempt < STATE_READ_ATTEMPTS && stillThere(); attempt++) {
        await sleep(STATE_READ_INTERVAL_MS)
        input.refresh()
        evaluated = await input.evaluate()
      }
      const { plan, ready } = evaluated
      input.onPlan?.(plan)
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
      const result = await input.land(spec)
      input.landed.add(spec.step.id)
      input.onLanded?.(spec, result)
      const step = {
        ...spec.step,
        hashes: result.hashes,
        ...(result.created && { created: result.created }),
      }
      executed.push(step)
      last = { id: spec.step.id, progress: spec.step.progress, findings: result.findings }
      await input.onStep?.(step)
    }
  } catch (error) {
    const failure = CCIPError.isCCIPError(error) ? error : CCIPError.from(error)
    Object.assign(failure.context, { executedSteps: executed })
    throw failure
  }
}
