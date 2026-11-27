/**
 * The ready-step engine of the shared planners, family-neutral (it imports no family code): step
 * construction with `inputsHash`, the ready-step rule (`MultiTokenPoolPlanOptions`), pending and
 * stale proposals, stable chunking, actor resolution, the plan hash and the run-scoped landed-pause
 * unpause rule (A16).
 *
 * It lives under `cct/solana` until X1 moves it next to the shared planner types (the EVM planners
 * E10-E12 take it unchanged; see `mttp/tools/x1-shared-planner-types.diff`).
 *
 * @packageDocumentation
 */

import { hexlify, randomBytes } from 'ethers'

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
  return hexlify(randomBytes(8)).slice(2)
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
