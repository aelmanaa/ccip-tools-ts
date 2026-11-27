/**
 * The ready-step engine of the shared planners, family-neutral (it imports no family code): step
 * construction with `inputsHash`, the ready-step rule (`MultiTokenPoolPlanOptions`), pending and
 * stale proposals, actor resolution, the plan hash and the landed-pause unpause rule (A16).
 *
 * It lives under `cct/solana` until X1 moves it next to the shared planner types (the EVM planners
 * E10-E12 take it unchanged; see `mttp/tools/x1-shared-planner-types.diff`).
 *
 * @packageDocumentation
 */

import { canonicalHash } from '../../../canonical.ts'
import type {
  MultiTokenPoolActors,
  MultiTokenPoolPlanBlock,
  MultiTokenPoolPlanStep,
  MultiTokenPoolStalePendingStep,
  MultiTokenPoolStepSigner,
} from '../../../multi-token-pool.ts'

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
 * The unpause rule (A16, OC2): a pause is lifted only when this run's own pause step for it landed
 * (`landed`: in memory on the signed path, `landedStepIds` on the unsigned one) or is still to land
 * in this plan (the unpause then depends on it). Chain state cannot tell this run's pause from
 * another's, so anything else fails closed with a block that names the pause step.
 * @returns `'lift'` (with the pause step to depend on when it is still planned), or the block.
 * @internal
 */
export function unpauseDecision(input: {
  /** The pause step id of this run for the pause in question. */
  pauseStepId: string
  /** Whether that pause step is still in the plan. */
  pausePlanned: boolean
  /** This run's landed step ids. */
  landed: ReadonlySet<string>
  /** What the pause is, for the block reason. */
  what: string
}): { lift: true; dependsOn: string[] } | { lift: false; block: MultiTokenPoolPlanBlock } {
  if (input.pausePlanned) return { lift: true, dependsOn: [input.pauseStepId] }
  if (input.landed.has(input.pauseStepId)) return { lift: true, dependsOn: [] }
  return {
    lift: false,
    block: {
      reason: `${input.what} is paused, but this run did not land its pause step ${input.pauseStepId}: a pause this run did not set is never lifted. If this run landed it, pass its id in landedStepIds; otherwise lift it yourself after checking the lanes`,
      steps: [input.pauseStepId],
    },
  }
}
