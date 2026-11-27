/**
 * The state read and the steps both the onboarding and the chain enablement planners plan: the
 * driven-lanes pause and admission (`set_group_chain_lanes`), materialization, policy assignment,
 * the lane check and the unpause.
 *
 * @packageDocumentation
 */

import { PublicKey } from '@solana/web3.js'

import { canonicalJson } from '../../../canonical.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import type {
  MultiTokenPoolLaneFinding,
  MultiTokenPoolPlanBlock,
  MultiTokenPoolRemoteAttestation,
  MultiTokenPoolStepSigner,
} from '../../../multi-token-pool.ts'
import type { ChainGetter } from '../../../../chain.ts'
import { deriveTokenPoolConfigPda } from '../../programs/token-pool.ts'
import { CheckMultiTokenPoolLane } from '../operations/multi-token-pool.ts'
import { POOL_GROUP_DRIVEN_LANE_OPERATIONS } from '../operations/driven-lanes.ts'
import { GetPoolGroup } from '../operations/get-pool-group.ts'
import { GetPoolGroupChain } from '../operations/get-pool-group-chain.ts'
import { GetPoolGroupMembers } from '../operations/get-pool-group-members.ts'
import { readPoolGroupLanes } from '../operations/lane.ts'
import { POOL_GROUP_POLICY_OPERATIONS } from '../operations/policies.ts'
import { readPoolStates } from '../operations/write-common.ts'
import type {
  GetPoolGroupChainResult,
  GetPoolGroupLaneResult,
  GetPoolGroupResult,
  PoolGroupClassSource,
  PoolGroupLaneKey,
  PoolGroupMember,
  PoolGroupPolicyClass,
  PoolGroupSections,
} from '../types.ts'
import { POOL_GROUP_POLICY_CLASSES } from '../types.ts'
import type { PoolGroupClassSourceInput, PoolGroupSectionUpdate } from '../write-types.ts'
import {
  type PlannerContext,
  type PoolGroupOpLike,
  type StepSpec,
  bindPoolGroupOp,
  chunked,
  keys,
  laneKeyOf,
  specOf,
  stepId,
} from './context.ts'
import type { PlannedStepFields } from './engine.ts'
import type { PoolGroupExecuteResult, PoolGroupUnsignedResult } from '../write-types.ts'

/** Lanes per materialize, assign or sync step (the op packs them into as many transactions as fit). @internal */
export const LANES_PER_STEP = 24

/** What a planner reads of a pool group in one go. @internal */
export type PlanState = {
  /** Slot of the read. */
  slot: bigint
  /** The group; `null` when absent. */
  group: GetPoolGroupResult | null
  /** Chain records by selector (those that exist). */
  records: Map<bigint, GetPoolGroupChainResult>
  /** Members of the group by mint (of the mints read). */
  members: Map<string, PoolGroupMember>
  /** Existing lanes by `<mint>:<selector>` (of the pairs read). */
  lanes: Map<string, GetPoolGroupLaneResult>
  /** Pool owners by mint (of the mints whose pool exists). */
  poolOwners: Map<string, string>
}

/**
 * Reads the group, the chain records of `selectors` (subset joined with `mints`), the members and
 * pools among `mints`, and every lane of `mints` × `selectors` that exists. A missing group reads as
 * `null` (onboarding with `create`).
 * @internal
 */
export async function readPlanState(
  ctx: PlannerContext,
  { selectors, mints }: { selectors: readonly bigint[]; mints: readonly string[] },
): Promise<PlanState> {
  const { chain, ref } = ctx
  const slot = BigInt(await chain.connection.getSlot('confirmed'))
  const refParams = {
    poolProgramAddress: ref.program.toBase58(),
    poolGroupAddress: ref.group.toBase58(),
    ...(ref.expectedOwner && { expectedOwner: ref.expectedOwner.toBase58() }),
  }
  const groupInfo = await chain.connection.getAccountInfo(ref.group)
  const poolInfos = mints.length
    ? await chain.connection.getMultipleAccountsInfo(
        mints.map((m) => deriveTokenPoolConfigPda(ref.program, new PublicKey(m))),
      )
    : []
  const withPool = mints.filter((_, i) => poolInfos[i]?.owner.equals(ref.program))
  const pools = await readPoolStates(
    ctx.operation,
    chain,
    ref.program,
    withPool.map((m) => new PublicKey(m)),
  )
  const poolOwners = new Map(withPool.map((m, i) => [m, pools[i]!.state.owner.toBase58()]))
  if (!groupInfo)
    return { slot, group: null, records: new Map(), members: new Map(), lanes: new Map(), poolOwners }
  const group = await new GetPoolGroup().query(chain, refParams)
  const present = selectors.filter((s) => group.remoteChainSelectors.includes(s))
  const records = new Map<bigint, GetPoolGroupChainResult>()
  for (const s of present)
    records.set(
      s,
      await new GetPoolGroupChain().query(chain, {
        ...refParams,
        remoteChainSelector: s,
        ...(mints.length && { tokenAddresses: [...mints] }),
      }),
    )
  const members = new Map<string, PoolGroupMember>()
  if (mints.length) {
    const { poolGroupMembers } = await new GetPoolGroupMembers().query(chain, {
      ...refParams,
      tokenAddresses: [...mints],
    })
    for (const m of poolGroupMembers) members.set(m.tokenAddress, m)
  }
  const requests = withPool.flatMap((m) =>
    selectors.map((selector) => ({ mint: new PublicKey(m), selector })),
  )
  const lanes = new Map<string, GetPoolGroupLaneResult>()
  if (requests.length)
    for (const l of await readPoolGroupLanes(ctx.operation, chain, ref.program, requests, {
      skipMissing: true,
    }))
      lanes.set(laneKeyOf(l), l)
  return { slot, group, records, members, lanes, poolOwners }
}

/** Whether `record` admits the member `mint` (all members, or the subset holds it). @internal */
export function recordAdmits(record: GetPoolGroupChainResult, mint: string): boolean {
  if (record.laneMode === 'all-members') return true
  return record.laneMode === 'subset' && record.subsetTokens.includes(mint)
}

/** Whether a chain record is live: a lane mode and the driven lanes not paused. @internal */
export const recordLive = (record: GetPoolGroupChainResult) =>
  record.laneMode !== 'off' && !record.drivenLanesPaused

/** Whether a lane of this pool group exists for the pair. @internal */
export function laneOf(
  state: PlanState,
  mint: string,
  selector: bigint,
): GetPoolGroupLaneResult | undefined {
  return state.lanes.get(`${mint}:${selector}`)
}

/** Lower-cased hex, so EVM spellings compare equal. */
const norm = (v: unknown): unknown =>
  typeof v === 'string' && /^0x/i.test(v) ? v.toLowerCase() : v

/** Rate limit as compared: absent amounts are zero. */
const rl = (b: { enabled: boolean; capacity?: bigint; rate?: bigint }) => ({
  enabled: b.enabled,
  capacity: b.capacity ?? 0n,
  rate: b.rate ?? 0n,
})

/**
 * Whether `update` already holds on `sections` (every given field equal), so the write is done.
 * @internal
 */
export function sectionHolds(sections: PoolGroupSections, update: PoolGroupSectionUpdate): boolean {
  const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b)
  switch (update.policyClass) {
    case 'connection': {
      const want = update.connection
      const have = sections.connection
      if (
        want.remotePools &&
        !same(
          want.remotePools.map((p) => [norm(p.address), p.allowLegacyPoolData]),
          have.remotePools.map((p) => [norm(p.address), p.allowLegacyPoolData]),
        )
      )
        return false
      if (want.poolDataFormat && want.poolDataFormat !== have.poolDataFormat) return false
      if (
        want.allowedFinality &&
        !same(
          { depth: want.allowedFinality.finalityDepth, safe: !!want.allowedFinality.finalitySafe },
          { depth: have.allowedFinality.finalityDepth, safe: !!have.allowedFinality.finalitySafe },
        )
      )
        return false
      return true
    }
    case 'fee':
      return Object.entries(update.tokenTransferFeeConfig).every(([k, v]) =>
        same(v, Reflect.get(sections.fee.tokenTransferFeeConfig, k)),
      )
    case 'rateLimit':
      return Object.entries(update.rateLimit).every(
        ([k, v]) =>
          v === undefined ||
          same(
            rl(v),
            rl(sections.rateLimit[k as keyof typeof sections.rateLimit] ?? { enabled: false }),
          ),
      )
    default:
      return false
  }
}

/** The signer of a pool-group record write gated on the owner or one of `roles`. @internal */
export function groupSigner(ctx: PlannerContext, roles: string[]): MultiTokenPoolStepSigner {
  return { kind: 'pool-group-role', on: ctx.ref.group.toBase58(), anyOf: ['owner', ...roles] }
}

/** The signer of a lane owner's write. @internal */
export function poolOwnerSigner(
  ctx: PlannerContext,
  owner: string | undefined,
  tokenAddress?: string,
): MultiTokenPoolStepSigner {
  return {
    kind: 'pool-owner',
    on: ctx.ref.group.toBase58(),
    ...(tokenAddress && { tokenAddress }),
    ...(owner && { address: owner }),
  }
}

/** The ref and op options every pool-group op step takes. @internal */
export function opBase(ctx: PlannerContext) {
  return {
    poolProgramAddress: ctx.ref.program.toBase58(),
    poolGroupAddress: ctx.ref.group.toBase58(),
    ...(ctx.budget && { budget: ctx.budget }),
    ...(ctx.getChain && { getChain: ctx.getChain }),
    ...(ctx.concurrency !== undefined && { concurrency: ctx.concurrency }),
  }
}

/** The fields of an op's params that go into `step.inputs` (no functions, no budget). @internal */
export function inputsOf(params: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params).filter(
      ([k, v]) => !['budget', 'getChain', 'concurrency'].includes(k) && v !== undefined,
    ),
  )
}

/** The lane-check options a planner passes to `checkMultiTokenPoolLane`. @internal */
export type LaneCheckInputs = {
  getChain?: ChainGetter
  remoteAttestations?: MultiTokenPoolRemoteAttestation[]
  minDestGasOverhead?: number
  maxTransferFeeBps?: number
}

/** The given lane-check options, without the undefined ones. @internal */
export function laneCheckOptions(o: LaneCheckInputs): LaneCheckInputs {
  return {
    ...(o.getChain && { getChain: o.getChain }),
    ...(o.remoteAttestations && { remoteAttestations: o.remoteAttestations }),
    ...(o.minDestGasOverhead !== undefined && { minDestGasOverhead: o.minDestGasOverhead }),
    ...(o.maxTransferFeeBps !== undefined && { maxTransferFeeBps: o.maxTransferFeeBps }),
  }
}

/** A signer resolved through `actors`, else the run's actor (`crankPayer` for a crank). @internal */
export function resolvedAddress(
  ctx: PlannerContext,
  signer: MultiTokenPoolStepSigner,
  crank = false,
): string {
  return specOf(
    ctx,
    { id: '', name: '', operation: '', summary: '', inputs: {}, writeSet: [], guardReads: [], signer },
    { crank },
  ).step.signer.address!
}

/**
 * A step that runs one pool-group write: `authority` is the step's resolved signer, `inputs` the op
 * params as the op takes them (no budget, no functions), and both paths build on current state.
 * @internal
 */
export function opStep<Name extends string, P extends { authority?: string }>(
  ctx: PlannerContext,
  fields: Omit<PlannedStepFields<Name>, 'inputs' | 'signer'> & { signer: MultiTokenPoolStepSigner },
  op: PoolGroupOpLike<P>,
  params: P,
  options: {
    crank?: boolean
    created?: (r: PoolGroupUnsignedResult | PoolGroupExecuteResult) => Record<string, string>
  } = {},
): StepSpec<Name> {
  const authority = resolvedAddress(ctx, fields.signer, options.crank)
  const full = { ...params, authority }
  return specOf(
    ctx,
    { ...fields, inputs: inputsOf(full) },
    {
      ...(options.crank && { crank: true }),
      run: bindPoolGroupOp(ctx.chain, op, full, options.created),
    },
  )
}

/**
 * `set_group_chain_lanes` as a step: the driven-lanes pause (leaving `'off'`, with the mode), an
 * admission on a live chain (with the acknowledged lanes), or the unpause.
 * @internal
 */
export function chainLanesStep<Name extends string>(
  ctx: PlannerContext,
  name: Name,
  input: {
    selector: bigint
    laneMode?: 'all-members' | 'subset'
    drivenLanesPaused?: boolean
    addTokens?: string[]
    acknowledgeLiveAdmission?: PoolGroupLaneKey[]
    dependsOn: string[]
    summary: string
    idPart: string
  },
): StepSpec<Name> {
  const roles =
    input.drivenLanesPaused === false ? ['unpauser'] : ['policyAdmin', 'connectionAdmin', 'pauser']
  return opStep(
    ctx,
    {
      id: stepId(ctx, input.idPart, input.selector),
      name,
      operation: 'setPoolGroupChainLanes',
      dependsOn: input.dependsOn,
      summary: input.summary,
      writeSet: [keys.chain(ctx.ref.group, input.selector)],
      guardReads: [
        ...(input.addTokens ?? []).map(keys.member),
        ...(input.acknowledgeLiveAdmission ?? []).map((l) =>
          keys.lane(l.tokenAddress, l.remoteChainSelector),
        ),
      ],
      signer: groupSigner(ctx, roles),
    },
    POOL_GROUP_DRIVEN_LANE_OPERATIONS.setPoolGroupChainLanes,
    {
      ...opBase(ctx),
      remoteChainSelector: input.selector,
      ...(input.laneMode && { laneMode: input.laneMode }),
      ...(input.drivenLanesPaused !== undefined && { drivenLanesPaused: input.drivenLanesPaused }),
      ...(input.addTokens?.length && { addTokens: input.addTokens }),
      ...(input.acknowledgeLiveAdmission?.length && {
        acknowledgeLiveAdmission: input.acknowledgeLiveAdmission,
      }),
    },
  )
}

/** `materialize_group_lanes` steps for `mints` on `selector` (cranks, chunked). @internal */
export function materializeSteps<Name extends string>(
  ctx: PlannerContext,
  name: Name,
  selector: bigint,
  mints: readonly string[],
  dependsOn: (chunk: string[]) => string[],
): StepSpec<Name>[] {
  return chunked(mints, LANES_PER_STEP).map((chunk, i, all) =>
    opStep(
      ctx,
      {
        id: stepId(ctx, 'materializePoolGroupLanes', selector, all.length > 1 ? i : undefined),
        name,
        operation: 'materializePoolGroupLanes',
        dependsOn: dependsOn(chunk),
        summary: `create the driven lanes of ${chunk.length} member(s) toward ${selector}`,
        writeSet: chunk.flatMap((m) => [keys.lane(m, selector), keys.member(m)]),
        guardReads: [keys.chain(ctx.ref.group, selector)],
        signer: { kind: 'anyone', on: ctx.ref.group.toBase58() },
        progress: chunk.length,
      },
      POOL_GROUP_DRIVEN_LANE_OPERATIONS.materializePoolGroupLanes,
      { ...opBase(ctx), remoteChainSelector: selector, tokenAddresses: chunk },
      { crank: true },
    ),
  )
}

/** The assignment input of a lane: `policyId` for `carried`, the current source for the rest. @internal */
export function assignedSources(
  current: Record<PoolGroupPolicyClass, PoolGroupClassSource> | null,
  policyId: number,
  carried: readonly PoolGroupPolicyClass[],
): PoolGroupClassSourceInput {
  const out = {} as PoolGroupClassSourceInput
  for (const cls of POOL_GROUP_POLICY_CLASSES) {
    if (carried.includes(cls)) out[cls] = { kind: 'policy', policyId }
    else {
      const c = current?.[cls]
      out[cls] =
        c?.kind === 'policy' ? { kind: 'policy', policyId: c.policyId } : { kind: c?.kind ?? 'default' }
    }
  }
  return out
}

/** Whether a lane already takes every carried class from the policy. @internal */
export function assignmentHolds(
  current: Record<PoolGroupPolicyClass, PoolGroupClassSource> | null,
  policyId: number,
  carried: readonly PoolGroupPolicyClass[],
): boolean {
  return carried.every((cls) => {
    const c = current?.[cls]
    return c?.kind === 'policy' && c.policyId === policyId
  })
}

/**
 * `assign_lane_policies` steps: lanes of one chain grouped by their resulting class sources and pool
 * owner (one assignment per instruction), chunked. The write set holds the lane, the group chain
 * record and every policy chain record it references (design addendum §3.5).
 * @internal
 */
export function assignSteps<Name extends string>(
  ctx: PlannerContext,
  name: Name,
  input: {
    selector: bigint
    policyId: number
    carried: readonly PoolGroupPolicyClass[]
    lanes: { mint: string; owner: string | undefined; current: GetPoolGroupLaneResult['classSource'] }[]
    dependsOn: (mints: string[]) => string[]
  },
): StepSpec<Name>[] {
  const groups = new Map<string, { source: PoolGroupClassSourceInput; owner?: string; mints: string[] }>()
  for (const l of input.lanes) {
    const source = assignedSources(l.current, input.policyId, input.carried)
    const k = `${l.owner ?? ''}:${canonicalJson(source)}`
    const g = groups.get(k) ?? { source, ...(l.owner && { owner: l.owner }), mints: [] }
    g.mints.push(l.mint)
    groups.set(k, g)
  }
  const specs: StepSpec<Name>[] = []
  let n = 0
  for (const g of groups.values())
    for (const chunk of chunked(g.mints, LANES_PER_STEP)) {
      const policies = new Set<number>(
        Object.values(g.source).flatMap((s) => (s.kind === 'policy' ? [s.policyId] : [])),
      )
      specs.push(
        opStep(
          ctx,
          {
            id: stepId(ctx, 'assignPoolGroupLanePolicies', input.selector, n++),
            name,
            operation: 'assignPoolGroupLanePolicies',
            dependsOn: input.dependsOn(chunk),
            summary: `assign ${chunk.length} lane(s) toward ${input.selector} to policy ${input.policyId} for ${input.carried.join(', ')}`,
            writeSet: [
              ...chunk.map((m) => keys.lane(m, input.selector)),
              keys.chain(ctx.ref.group, input.selector),
              ...[...policies].map((p) => keys.policyChain(ctx.ref.group, p, input.selector)),
            ],
            guardReads: [keys.group(ctx.ref.group)],
            signer: poolOwnerSigner(ctx, g.owner),
            progress: chunk.length,
          },
          POOL_GROUP_POLICY_OPERATIONS.assignPoolGroupLanePolicies,
          {
            ...opBase(ctx),
            remoteChainSelector: input.selector,
            tokenAddresses: chunk,
            classSource: g.source,
          },
        ),
      )
    }
  return specs
}

/** The SECURITY warning of an assignment to a policy carrying it (no notice, assign.rs:7). @internal */
export function securityCopiedFindings(
  lanes: readonly PoolGroupLaneKey[],
  policyId: number,
): MultiTokenPoolLaneFinding[] {
  return lanes.map((l) => ({
    check: 'CCVS_NOT_SYNCED' as const,
    severity: 'warning' as const,
    tokenAddress: l.tokenAddress,
    remoteChainSelector: l.remoteChainSelector,
    reason: `policy ${policyId} carries SECURITY: assigning the lane copies its CCVs at once, with no notice (use rollOutPoolGroupCCVs for a delayed change)`,
  }))
}

/**
 * The `checkLanes` step: virtual; once every step before it landed, `checkMultiTokenPoolLane` runs on
 * each lane (`expectOpen: []` while paused: pauses are the unpause's job); any error blocks.
 * @internal
 */
export function checkStep<Name extends string>(
  ctx: PlannerContext,
  name: Name,
  lanes: readonly PoolGroupLaneKey[],
  dependsOn: string[],
  options: LaneCheckInputs,
): StepSpec<Name> {
  return specOf(
    ctx,
    {
      id: stepId(ctx, 'checkLanes'),
      name,
      operation: 'checkMultiTokenPoolLane',
      dependsOn,
      summary: `check ${lanes.length} lane(s) before they go live`,
      inputs: { lanes: lanes.map((l) => [l.tokenAddress, l.remoteChainSelector]) },
      writeSet: [],
      guardReads: lanes.map((l) => keys.lane(l.tokenAddress, l.remoteChainSelector)),
      signer: { kind: 'anyone' },
      progress: lanes.length,
    },
    {
      evaluate: async (): Promise<MultiTokenPoolPlanBlock | null> => {
        const failed: MultiTokenPoolLaneFinding[] = []
        const check = new CheckMultiTokenPoolLane()
        for (const l of lanes) {
          const r = await check.query(ctx.chain, {
            poolAddress: ctx.ref.program.toBase58(),
            ...l,
            ...laneCheckOptions(options),
            // paused lanes are the unpause's to open: only configuration errors count here
            expectOpen: [],
          })
          failed.push(...r.findings.filter((f) => f.severity === 'error'))
        }
        if (!failed.length) return null
        return {
          reason: `the lane check refuses ${failed.length} finding(s): ${failed
            .map((f) => `${f.check} on ${f.tokenAddress} → ${f.remoteChainSelector}: ${f.reason}`)
            .join('; ')}`,
        }
      },
    },
  )
}

/** A chain record must exist and serve driven lanes for a token's listed chain. @internal */
export function refuseChain(operation: string, param: string, reason: string): never {
  throw new CCTParamsInvalidError(operation, param, reason)
}
