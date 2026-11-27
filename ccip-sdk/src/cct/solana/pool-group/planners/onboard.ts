/**
 * `onboardMultiTokenPoolTokens` on Solana: N tokens into a pool group (design addendum §3.1). Per
 * token: `onboardToken`'s steps while the mint has no registered 2.0 pool; then `join_group` with
 * the token's `remoteTokens` (driven lanes, the default) or `init_group_lanes` (linked lanes),
 * `materialize_group_lanes`, the policy assignment, the lane check and the unpause of a pause this run
 * landed. `remoteTokens` is the exact lane set: a chain must already serve driven lanes (enable it
 * first), and a live chain needs `solana.acknowledgeLiveAdmission`. A live chain is never paused.
 *
 * @packageDocumentation
 */

import { PublicKey } from '@solana/web3.js'

import { CCTParamsInvalidError } from '../../../errors.ts'
import type {
  MultiTokenPoolLaneFinding,
  MultiTokenPoolPlanBlock,
} from '../../../multi-token-pool.ts'
import {
  laneFamilyOf,
  parseRemoteAddress,
  parseUniqueRemoteAddresses,
} from '../../../remote-address.ts'
import {
  type TokenOnboardingStepName,
  OnboardToken,
  parseOnboardTokenParams,
  planTokenOnboarding,
  readTokenOnboardingState,
} from '../../onboarding/onboard-token.ts'
import { deriveTokenPoolConfigPda } from '../../programs/token-pool.ts'
import { U64_MAX, validateBigInt, validateInteger } from '../../validate.ts'
import { poolGroupPdas } from '../accounts.ts'
import { POOL_GROUP_CHAIN_OPERATIONS } from '../operations/chains.ts'
import { parsePoolGroupProgram, parsePoolGroupRef } from '../operations/common.ts'
import { GetPoolGroupPolicy } from '../operations/get-pool-group-policy.ts'
import { POOL_GROUP_LANE_OPERATIONS } from '../operations/lanes.ts'
import { POOL_GROUP_LIFECYCLE_OPERATIONS } from '../operations/lifecycle.ts'
import { parseMemberChains } from '../operations/members-common.ts'
import { POOL_GROUP_MEMBERSHIP_OPERATIONS } from '../operations/membership.ts'
import type {
  GetPoolGroupChainResult,
  PoolGroupMemberRemoteToken,
  PoolGroupPolicyClass,
} from '../types.ts'
import type { PoolGroupMemberEntry, PoolGroupSectionUpdate } from '../write-types.ts'
import {
  type Expansion,
  type PlannerContext,
  type StepSpec,
  keys,
  runScopedId,
  specOf,
  stepId,
  toPlannerTx,
} from './context.ts'
import { mergeBlocks, stableChunks, unpauseDecision } from './engine.ts'
import {
  type LaneCheckInputs,
  type PlanState,
  assignSteps,
  assignmentHolds,
  chainLanesStep,
  checkStep,
  groupSigner,
  laneCheckOptions,
  laneOf,
  lanePausedAsCreated,
  laneUnpauseStep,
  materializeSteps,
  opBase,
  opStep,
  poolOwnerSigner,
  readPlanState,
  recordAdmits,
  recordRuns,
  sectionHolds,
  securityCopiedFindings,
} from './flow-common.ts'
import type {
  GenerateOnboardMultiTokenPoolTokensParams,
  PoolGroupOnboardingCreate,
  PoolGroupOnboardingStepName,
} from './types.ts'

const NAME = 'onboardMultiTokenPoolTokens'
type Name = PoolGroupOnboardingStepName

/** Tokens per `joinPoolGroup` step (the op packs them, about 3 per transaction). @internal */
export const MEMBERS_PER_STEP = 12

/**
 * `onboardToken`'s step names under the onboarding tuple. `applyChainUpdates`, `initChainConfigV2`
 * and `initFastFinalityRateLimit` never occur (the planner passes `remoteChains: []`: the pool group
 * drives the lanes); the map is total only because the name union is.
 */
const TOKEN_STEP_NAMES: Record<TokenOnboardingStepName, Name> = {
  deployTokenPool: 'tokenDeployPool',
  registerAdmin: 'tokenRegisterAdmin',
  upgradeTokenAdminRegistry: 'tokenRegisterAdmin',
  acceptAdmin: 'tokenAcceptAdmin',
  applyChainUpdates: 'tokenRegisterAdmin',
  initChainConfigV2: 'tokenRegisterAdmin',
  initFastFinalityRateLimit: 'tokenRegisterAdmin',
  createTokenMultisig: 'tokenCreateMintMultisig',
  setTokenAuthority: 'tokenSetMintAuthority',
  createLookupTable: 'tokenCreateLookupTable',
  setPool: 'tokenSetPool',
  setPoolInterfaceImplementation: 'tokenSetPoolInterface',
}

/** A parsed token to onboard. @internal */
export type ParsedOnboardingToken = {
  mint: string
  /** Remote token and decimals by chain, in the caller's order. */
  remotes: { selector: bigint; token: string; decimals: number }[]
  policy?: number
  poolType: 'burn-mint'
  allowlist?: string[]
  poolLookupTableAddress?: string
  remotePoolAddresses: string[]
}

/** Parsed onboarding params (the shared parts and Solana's). @internal */
export type ParsedOnboarding = {
  tokens: ParsedOnboardingToken[]
  laneKind: 'driven' | 'linked'
  acknowledgeLiveAdmission: boolean
  unpause: boolean
  create?: PoolGroupOnboardingCreate
  /** The group id when created (given, or generated on this call). */
  poolGroupId?: string
  check: LaneCheckInputs
}

/**
 * Parses the onboarding params before any RPC: the group ref (`poolGroupId` is required with
 * `solana.create` on the plan and unsigned forms, S6 review m2), the tokens and their exact lane
 * sets, the Solana options.
 * @throws {@link CCTParamsInvalidError} with the dotted path of the bad field
 * @internal
 */
export function parseOnboarding(params: GenerateOnboardMultiTokenPoolTokensParams): {
  ref: ReturnType<typeof parsePoolGroupRef>
  parsed: ParsedOnboarding
} {
  const solana = params.solana ?? {}
  const program = parsePoolGroupProgram(NAME, params)
  const poolGroupId = params.poolGroupId
  if (poolGroupId === undefined && params.poolGroupAddress === undefined)
    throw new CCTParamsInvalidError(
      NAME,
      'poolGroupAddress',
      solana.create
        ? 'pass poolGroupId (any fresh base58 key) with solana.create: a plan or unsigned build that drew its own would target a new pool group on every call (the signed form draws one)'
        : 'pass poolGroupId or poolGroupAddress, or solana.create to create the pool group',
    )
  if (params.poolGroupAddress !== undefined && params.poolGroupId !== undefined)
    throw new CCTParamsInvalidError(
      NAME,
      'poolGroupAddress',
      'pass exactly one of poolGroupAddress and poolGroupId',
    )
  const ref = parsePoolGroupRef(
    NAME,
    params.poolGroupAddress !== undefined
      ? {
          poolProgramAddress: program.toBase58(),
          poolGroupAddress: params.poolGroupAddress,
          ...(params.expectedOwner !== undefined && { expectedOwner: params.expectedOwner }),
        }
      : {
          poolProgramAddress: program.toBase58(),
          poolGroupId: poolGroupId ?? '',
          ...(params.expectedOwner !== undefined && { expectedOwner: params.expectedOwner }),
        },
  )
  if (!Array.isArray(params.tokens) || !params.tokens.length)
    throw new CCTParamsInvalidError(NAME, 'tokens', 'must be a non-empty array')
  const kind: unknown = solana.laneKind ?? 'driven'
  if (kind !== 'driven' && kind !== 'linked')
    throw new CCTParamsInvalidError(NAME, 'solana.laneKind', "must be 'driven' or 'linked'")
  const laneKind = kind
  const seen = new Set<string>()
  const tokens = params.tokens.map((t, i): ParsedOnboardingToken => {
    const at = `tokens[${i}]`
    const raw: unknown = t
    if (typeof raw !== 'object' || raw === null)
      throw new CCTParamsInvalidError(NAME, at, 'must be an object')
    if (Reflect.get(raw, 'evm') !== undefined)
      throw new CCTParamsInvalidError(
        NAME,
        `${at}.evm`,
        'an EVM block on a Solana token: use `solana`',
      )
    const mint = new PublicKey(parseRemoteAddressOrThrow(at, t.tokenAddress)).toBase58()
    if (seen.has(mint))
      throw new CCTParamsInvalidError(NAME, `${at}.tokenAddress`, 'must name each token once')
    seen.add(mint)
    if (!Array.isArray(t.remoteTokens))
      throw new CCTParamsInvalidError(NAME, `${at}.remoteTokens`, 'must be an array')
    const chains = new Set<bigint>()
    const remotes = t.remoteTokens.map((r, j) => {
      const rp = `${at}.remoteTokens[${j}]`
      validateBigInt(NAME, `${rp}.remoteChainSelector`, r.remoteChainSelector, 1n, U64_MAX)
      if (chains.has(r.remoteChainSelector))
        throw new CCTParamsInvalidError(
          NAME,
          `${rp}.remoteChainSelector`,
          'must list each chain once',
        )
      chains.add(r.remoteChainSelector)
      validateInteger(NAME, `${rp}.remoteTokenDecimals`, r.remoteTokenDecimals, 0, 255)
      return {
        selector: r.remoteChainSelector,
        token: parseRemoteAddress(
          NAME,
          `${rp}.remoteTokenAddress`,
          r.remoteTokenAddress,
          r.remoteChainSelector,
        ),
        decimals: r.remoteTokenDecimals,
      }
    })
    if (t.policy !== undefined) validateInteger(NAME, `${at}.policy`, t.policy, 0, 255)
    const s = t.solana ?? {}
    const poolType: unknown = s.poolType
    if (poolType !== undefined && poolType !== 'burn-mint')
      throw new CCTParamsInvalidError(
        NAME,
        `${at}.solana.poolType`,
        "only 'burn-mint' pools join a pool group",
      )
    // the pools are in one chain's address format: one chain per token here (S6 review m5)
    if (laneKind === 'linked' && s.remotePoolAddresses && remotes.length > 1)
      throw new CCTParamsInvalidError(
        NAME,
        `${at}.solana.remotePoolAddresses`,
        "are one chain's pools, in its address format: onboard a linked token with remotePoolAddresses one remote chain at a time",
      )
    const remotePoolAddresses =
      laneKind === 'linked' && s.remotePoolAddresses
        ? remotes.length
          ? parseUniqueRemoteAddresses(
              NAME,
              `${at}.solana.remotePoolAddresses`,
              s.remotePoolAddresses,
              remotes[0]!.selector,
            )
          : []
        : []
    return {
      mint,
      remotes,
      ...(t.policy !== undefined && { policy: t.policy }),
      poolType: 'burn-mint',
      ...(s.allowlist && { allowlist: s.allowlist }),
      ...(s.poolLookupTableAddress && { poolLookupTableAddress: s.poolLookupTableAddress }),
      remotePoolAddresses,
    }
  })
  const create = solana.create
  const rawCreate: unknown = create
  if (create !== undefined) {
    if (typeof rawCreate !== 'object' || rawCreate === null)
      throw new CCTParamsInvalidError(NAME, 'solana.create', 'must be an object')
    for (const [i, c] of (create.chains ?? []).entries()) {
      validateBigInt(
        NAME,
        `solana.create.chains[${i}].remoteChainSelector`,
        c.remoteChainSelector,
        1n,
        U64_MAX,
      )
      const laneMode: unknown = c.laneMode
      if (laneMode !== undefined && laneMode !== 'all-members')
        throw new CCTParamsInvalidError(
          NAME,
          `solana.create.chains[${i}].laneMode`,
          "only 'all-members' at creation: a subset needs member indices, which exist only after the joins (add them with enableMultiTokenPoolChain)",
        )
      const pools = c.sections?.find((x) => x.policyClass === 'connection')
      if (
        c.laneMode &&
        !(pools?.policyClass === 'connection' && pools.connection.remotePools?.length)
      )
        throw new CCTParamsInvalidError(
          NAME,
          `solana.create.chains[${i}].sections`,
          'a chain that starts in a lane mode needs CONNECTION remote pools (GroupChainHasNoRemotePools)',
        )
    }
  }
  return {
    ref,
    parsed: {
      tokens,
      laneKind,
      acknowledgeLiveAdmission: solana.acknowledgeLiveAdmission === true,
      unpause: params.unpause === true,
      ...(create && { create }),
      ...(poolGroupId !== undefined && params.poolGroupAddress === undefined && { poolGroupId }),
      check: laneCheckOptions(params),
    },
  }
}

/** A mint, or the param error. */
function parseRemoteAddressOrThrow(at: string, value: unknown): string {
  try {
    return new PublicKey(String(value)).toBase58()
  } catch {
    throw new CCTParamsInvalidError(NAME, `${at}.tokenAddress`, 'must be a Solana mint (base58)')
  }
}

/**
 * The member entries of a token's remote tokens: chains of one family with the same token and
 * decimals share one entry (the program stores one token per chain).
 * @internal
 */
export function memberRemoteTokensOf(
  remotes: ParsedOnboardingToken['remotes'],
): PoolGroupMemberRemoteToken[] {
  const groups = new Map<string, PoolGroupMemberRemoteToken>()
  for (const r of remotes) {
    const k = `${laneFamilyOf(r.selector) ?? r.selector}:${r.token.toLowerCase()}:${r.decimals}`
    const g = groups.get(k)
    if (g) g.remoteChainSelectors.push(r.selector)
    else groups.set(k, { remoteChainSelectors: [r.selector], token: r.token, decimals: r.decimals })
  }
  return [...groups.values()]
}

/**
 * Whether a member's stored remote tokens are `remotes`, except for `pending` chains the plan still
 * lists in the transaction that creates their lanes paused (a stored one must still match).
 */
function memberMatches(
  stored: PoolGroupMemberRemoteToken[],
  remotes: ParsedOnboardingToken['remotes'],
  pending: ReadonlySet<bigint>,
) {
  const have = parseMemberChains(NAME, 'member', stored)
  const want = parseMemberChains(NAME, 'tokens', memberRemoteTokensOf(remotes))
  for (const s of have.keys()) if (!want.has(s)) return false
  for (const [s, w] of want) {
    const h = have.get(s)
    if (!h) {
      if (pending.has(s)) continue
      return false
    }
    if (!h.token.equals(w.token) || h.decimals !== w.decimals) return false
  }
  return true
}

/**
 * The `onboardToken` steps a mint still needs, or none when its 2.0 pool is registered. A registry
 * that names another pool which serves lanes is refused (S6 review M5): `setPool` to the group pool,
 * which runs before the group lanes exist and are checked, would fail those transfers and inbound
 * messages in flight.
 */
async function tokenOnboardingSteps(
  ctx: PlannerContext,
  token: ParsedOnboardingToken,
  index: number,
): Promise<TokenOnboardingStepName[]> {
  const params = tokenParams(ctx, token)
  let parsedToken
  try {
    parsedToken = parseOnboardTokenParams({ ...params, payer: ctx.payer })
  } catch (err) {
    throw underToken(err, index)
  }
  const state = await readTokenOnboardingState(ctx.chain, parsedToken)
  const poolPda = deriveTokenPoolConfigPda(ctx.ref.program, new PublicKey(token.mint))
  // a mint whose 2.0 pool is registered is onboarded: its lanes come from the pool group
  if (
    state.pool &&
    state.registry?.tokenPool?.equals(poolPda) &&
    state.registry.interfaceVersion === 2 &&
    state.registry.accountResolution === 'WithoutExtendedLookupTable'
  )
    return []
  const other = state.registry?.tokenPool
  if (other && !other.equals(poolPda) && !other.equals(PublicKey.default))
    await refuseLivePool(ctx, token, index, other)
  try {
    return planTokenOnboarding(parsedToken, state).map((s) => s.name)
  } catch (err) {
    throw underToken(err, index)
  }
}

/** Refuses a mint whose registry names `pool` while that pool serves lanes (or cannot be read). @internal */
export async function refuseLivePool(
  ctx: PlannerContext,
  token: ParsedOnboardingToken,
  index: number,
  pool: PublicKey,
): Promise<void> {
  const param = `tokens[${index}].tokenAddress`
  let remotes
  try {
    remotes = await ctx.chain.getTokenPoolRemotes(pool.toBase58())
  } catch (err) {
    throw new CCTParamsInvalidError(
      NAME,
      param,
      `${token.mint}'s registry names another pool, ${pool.toBase58()}, whose lanes cannot be read (${err instanceof Error ? err.message : String(err)}): moving the token to the group pool unchecked could fail live transfers, so it is refused. Read that pool, then migrate the token off it first`,
      { cause: err instanceof Error ? err : undefined },
    )
  }
  const live = Object.entries(remotes).filter(([, r]) => r.remotePools.length)
  if (live.length)
    throw new CCTParamsInvalidError(
      NAME,
      param,
      `${token.mint}'s registry names another pool, ${pool.toBase58()}, which serves ${live.length} lane(s) (${live.map(([n]) => n).join(', ')}): setPool to the group pool runs before the group lanes exist and pass the lane check, so those transfers, and inbound messages in flight, would fail. Migrate it first: stop and drain those lanes and remove their remote chain configs, then onboard`,
    )
}

/** `onboardToken`'s params for a token (no remote chains: the pool group drives the lanes). */
function tokenParams(ctx: PlannerContext, token: ParsedOnboardingToken) {
  return {
    tokenAddress: token.mint,
    poolType: token.poolType,
    poolProgramAddress: ctx.ref.program.toBase58(),
    remoteChains: [],
    ...(token.allowlist && { allowlist: token.allowlist }),
    ...(token.poolLookupTableAddress && { poolLookupTableAddress: token.poolLookupTableAddress }),
  }
}

/** Rethrows an `onboardToken` param error under `tokens[i]`. */
function underToken(err: unknown, index: number): unknown {
  if (!(err instanceof CCTParamsInvalidError)) return err
  const { param, reason } = err.context as { param: string; reason: string }
  return new CCTParamsInvalidError(NAME, `tokens[${index}].${param}`, reason, { cause: err })
}

/** The token steps of one mint, chained (each depends on the one before). */
function tokenSpecs(
  ctx: PlannerContext,
  token: ParsedOnboardingToken,
  names: TokenOnboardingStepName[],
  dependsOn: string[],
): StepSpec<Name>[] {
  const onboard = new OnboardToken()
  const params = tokenParams(ctx, token)
  let previous = dependsOn
  return names.map((op, i) => {
    const id = stepId(ctx, op, token.mint)
    const spec = specOf<Name>(
      ctx,
      {
        id,
        name: TOKEN_STEP_NAMES[op],
        operation: op,
        dependsOn: previous,
        summary: `onboardToken ${op} for ${token.mint}`,
        inputs: { ...params, authority: ctx.actor },
        writeSet: [keys.poolState(token.mint), keys.mintAuthority(token.mint)],
        guardReads: [],
        signer: { kind: 'token-admin', tokenAddress: token.mint },
      },
      i === 0
        ? {
            run: {
              generate: async (payer) => {
                const r = await onboard.generate(ctx.chain, {
                  ...params,
                  payer,
                  authority: ctx.actor,
                  ...(ctx.lookupTablePayer && { lookupTablePayer: ctx.lookupTablePayer }),
                })
                return {
                  transactions: r.transactions.map((tx) =>
                    toPlannerTx(tx, r.payer, [token.mint], 'token-admin'),
                  ),
                  findings: [],
                  ...(r.lookupTableAddress && {
                    created: { lookupTableAddress: r.lookupTableAddress },
                  }),
                }
              },
              // the signed form runs every remaining onboardToken step of the mint at once
              execute: async (wallet, computeUnits) => {
                const r = await onboard.execute(ctx.chain, {
                  ...params,
                  wallet,
                  ...(computeUnits !== undefined && { computeUnits }),
                })
                return { hashes: r.steps.flatMap((s) => s.hashes), findings: [] }
              },
            },
          }
        : {
            // later steps of the mint are built after the earlier ones land
            evaluate: () =>
              Promise.resolve({
                reason: `waits for the earlier onboardToken steps of ${token.mint}`,
              }),
          },
    )
    previous = [id]
    return spec
  })
}

/** The chains a create adds and the sections per chain. */
const createChains = (create?: PoolGroupOnboardingCreate) =>
  new Map((create?.chains ?? []).map((c) => [c.remoteChainSelector, c]))

/** What the onboarding expansion reads from chain state (a plain value: the goldens fake it). @internal */
export type OnboardingInputs = {
  /** The pool group, records, members, lanes and pool owners. */
  state: PlanState
  /** Per mint, the `onboardToken` steps it still needs (absent: none). */
  tokenSteps: Map<string, TokenOnboardingStepName[]>
  /** The named policies: the classes each carries and the chains it has records for. */
  policies: Map<number, { classes: PoolGroupPolicyClass[]; remoteChainSelectors: bigint[] }>
}

/** The selectors an onboarding reads: every token's chains and the chains `create` adds. */
function onboardingSelectors(parsed: ParsedOnboarding): bigint[] {
  return [
    ...new Set([
      ...parsed.tokens.flatMap((t) => t.remotes.map((r) => r.selector)),
      ...createChains(parsed.create).keys(),
    ]),
  ]
}

/**
 * Reads what {@link expandOnboardingFrom} needs: one state read, the token steps (with the M5
 * registry check), the named policies.
 * @internal
 */
export async function readOnboardingInputs(
  ctx: PlannerContext,
  parsed: ParsedOnboarding,
): Promise<OnboardingInputs> {
  const selectors = onboardingSelectors(parsed)
  const state = await readPlanState(ctx, { selectors, mints: parsed.tokens.map((t) => t.mint) })
  const tokenSteps = new Map<string, TokenOnboardingStepName[]>()
  for (const [i, token] of parsed.tokens.entries()) {
    const names = await tokenOnboardingSteps(ctx, token, i)
    if (names.length) tokenSteps.set(token.mint, names)
  }
  const policies: OnboardingInputs['policies'] = new Map()
  if (state.group)
    for (const policyId of new Set(
      parsed.tokens.flatMap((t) => (t.policy !== undefined ? [t.policy] : [])),
    )) {
      const policy = await new GetPoolGroupPolicy().query(ctx.chain, {
        poolProgramAddress: ctx.ref.program.toBase58(),
        poolGroupAddress: ctx.ref.group.toBase58(),
        policyId,
      })
      policies.set(policyId, {
        classes: policy.classes,
        remoteChainSelectors: policy.remoteChainSelectors,
      })
    }
  return { state, tokenSteps, policies }
}

/**
 * Expands the onboarding from one state read into its steps.
 * @internal
 */
export async function expandOnboarding(
  ctx: PlannerContext,
  parsed: ParsedOnboarding,
): Promise<Expansion<Name>> {
  return expandOnboardingFrom(ctx, parsed, await readOnboardingInputs(ctx, parsed))
}

/**
 * The onboarding steps from what {@link readOnboardingInputs} read: pure and deterministic (the
 * caller's token order is kept and every chunk id is stable, so `pendingStepHashes` survive a
 * re-plan after a partial landing).
 *
 * On a chain that is already live (its record runs its driven lanes and admits the token), a lane
 * must never be materializable before it is paused (S6 review M6): the token joins without listing
 * that chain, then one pool-owner-signed transaction per member lists it, creates the lane and
 * pauses it (`admitPausedLanes`, `createLanesPaused`), the lane check runs on the real accounts, and
 * `unpausePoolGroupLanes` lifts the lane pause (an op that runs the make-live check).
 * @internal
 */
export function expandOnboardingFrom(
  ctx: PlannerContext,
  parsed: ParsedOnboarding,
  { state, tokenSteps, policies }: OnboardingInputs,
): Expansion<Name> {
  const created = createChains(parsed.create)
  const selectors = onboardingSelectors(parsed)
  const g = ctx.ref.group
  const specs: StepSpec<Name>[] = []
  const findings: MultiTokenPoolLaneFinding[] = []
  const blocks: MultiTokenPoolPlanBlock[] = []

  // ── the pool group ──
  if (!state.group && !parsed.create)
    throw new CCTParamsInvalidError(
      NAME,
      'poolGroupAddress',
      `no pool group at ${g.toBase58()}: pass solana.create to create it`,
    )
  if (state.group && parsed.create && state.group.owner !== ctx.actor)
    throw new CCTParamsInvalidError(
      NAME,
      'solana.create',
      `the pool group at ${g.toBase58()} exists and is owned by ${state.group.owner}, not ${ctx.actor}: it may be a squatter's; pick another id`,
    )
  const missingChains = [...created.keys()].filter(
    (c) => !state.group?.remoteChainSelectors.includes(c),
  )
  let createId: string | undefined
  if (parsed.create && (!state.group || missingChains.length)) {
    createId = stepId(ctx, 'createPoolGroup')
    const c = parsed.create
    const poolGroupId = parsed.poolGroupId ?? state.group?.poolGroupId
    specs.push(
      opStep(
        ctx,
        {
          id: createId,
          name: 'createPoolGroup',
          operation: 'createPoolGroup',
          summary: state.group
            ? `add ${missingChains.length} chain(s) to the pool group`
            : `create the pool group ${g.toBase58()}`,
          writeSet: [keys.group(g), ...[...created.keys()].map((s) => keys.chain(g, s))],
          guardReads: [],
          signer: { kind: 'pool-group-owner', on: g.toBase58() },
        },
        POOL_GROUP_LIFECYCLE_OPERATIONS.createPoolGroup,
        {
          poolProgramAddress: ctx.ref.program.toBase58(),
          ...(poolGroupId && { poolGroupId }),
          ...(c.maxBpsFee !== undefined && { maxBpsFee: c.maxBpsFee }),
          ...(c.openMembership !== undefined && { openMembership: c.openMembership }),
          ...(c.minCCVActivationDelay !== undefined && {
            minCCVActivationDelay: c.minCCVActivationDelay,
          }),
          ...(c.initialRoles && { initialRoles: c.initialRoles }),
          ...(created.size && { initialChains: [...created.keys()] }),
          ...(ctx.budget && { budget: ctx.budget }),
        },
        {
          created: (r) => {
            const out: Record<string, string> = {}
            const id: unknown = Reflect.get(r, 'poolGroupId')
            const address: unknown = Reflect.get(r, 'poolGroupAddress')
            if (typeof id === 'string') out.poolGroupId = id
            if (typeof address === 'string') out.poolGroupAddress = address
            return out
          },
        },
      ),
    )
  }
  const afterCreate = createId ? [createId] : []

  // ── chain record sections of the chains create adds ──
  const sectionIds = new Map<bigint, string[]>()
  for (const [selector, chainInput] of created)
    for (const section of chainInput.sections ?? []) {
      const record = state.records.get(selector)
      if (record && sectionHolds(record.policy, section)) continue
      const id = stepId(ctx, 'setPoolGroupChainPolicy', selector, section.policyClass)
      sectionIds.set(selector, [...(sectionIds.get(selector) ?? []), id])
      specs.push(sectionStep(ctx, 'setPoolGroupDefaults', id, selector, section, afterCreate))
    }

  // ── per token: onboardToken's steps ──
  const lastTokenStep = new Map<string, string>()
  for (const token of parsed.tokens) {
    const names = tokenSteps.get(token.mint)
    if (!names?.length) continue
    const ts = tokenSpecs(ctx, token, names, [])
    specs.push(...ts)
    lastTokenStep.set(token.mint, ts.at(-1)!.step.id)
  }
  const afterToken = (mint: string) => [
    ...afterCreate,
    ...(lastTokenStep.has(mint) ? [lastTokenStep.get(mint)!] : []),
  ]

  // ── the driven-lanes pause of chains create moves out of 'off' (run-scoped id, M2) ──
  const pauseIdOf = (selector: bigint) => runScopedId(ctx, 'pausePoolGroupChainLanes', selector)
  const pauseIds = new Map<bigint, string>()
  for (const [selector, chainInput] of created) {
    if (!chainInput.laneMode) continue
    const record = state.records.get(selector)
    if (record && record.laneMode !== 'off') continue
    const id = pauseIdOf(selector)
    pauseIds.set(selector, id)
    specs.push(
      chainLanesStep(ctx, 'pausePoolGroupChainLanes', {
        selector,
        laneMode: chainInput.laneMode,
        drivenLanesPaused: true,
        dependsOn: [...afterCreate, ...(sectionIds.get(selector) ?? [])],
        summary: `move the chain record of ${selector} out of 'off' (${chainInput.laneMode}) with its driven lanes paused`,
        id,
      }),
    )
  }

  // ── exact lane set: every listed chain serves the lanes ──
  const modeOf = (selector: bigint) =>
    pauseIds.has(selector)
      ? created.get(selector)!.laneMode!
      : (state.records.get(selector)?.laneMode ?? 'off')
  for (const [i, token] of parsed.tokens.entries())
    for (const [j, r] of token.remotes.entries()) {
      const param = `tokens[${i}].remoteTokens[${j}]`
      if (!state.records.has(r.selector) && !created.has(r.selector))
        throw new CCTParamsInvalidError(
          NAME,
          param,
          `the pool group has no chain record for ${r.selector}: enable the chain first (enableMultiTokenPoolChain)`,
        )
      if (parsed.laneKind === 'linked') continue
      const mode = modeOf(r.selector)
      if (mode === 'off')
        throw new CCTParamsInvalidError(
          NAME,
          param,
          `the chain record of ${r.selector} is 'off': enable the chain first (enableMultiTokenPoolChain), so the token's driven lane can exist`,
        )
      const record = state.records.get(r.selector)
      if (mode === 'subset' && record && !recordAdmits(record, token.mint))
        throw new CCTParamsInvalidError(
          NAME,
          param,
          `the chain record of ${r.selector} admits a subset that lacks ${token.mint}, so its lane would not exist: add it with enableMultiTokenPoolChain`,
        )
    }

  // ── membership (driven) or linked lanes ──
  const laneStepOf = new Map<string, string>()
  // a running record that admits the token and has no lane for it: created paused (M6)
  const liveLane = (t: ParsedOnboardingToken, selector: bigint) => {
    const record = state.records.get(selector)
    return (
      parsed.laneKind === 'driven' &&
      !!record &&
      !pauseIds.has(selector) &&
      recordRuns(record) &&
      recordAdmits(record, t.mint) &&
      !laneOf(state, t.mint, selector)
    )
  }
  const liveOf = (t: ParsedOnboardingToken) => t.remotes.filter((r) => liveLane(t, r.selector))
  const ownerOf = (t: ParsedOnboardingToken) => state.poolOwners.get(t.mint) ?? ctx.actor
  const byOwner = new Map<string, ParsedOnboardingToken[]>()
  for (const t of parsed.tokens) byOwner.set(ownerOf(t), [...(byOwner.get(ownerOf(t)) ?? []), t])
  // the paused-creation step of each token (planned or not): its id is stable and run-scoped
  const admitIdOf = new Map<string, string>()
  for (const tokens of byOwner.values())
    for (const [t, key] of stableChunks(
      tokens,
      MEMBERS_PER_STEP,
      () => true,
      (x) => x.mint,
    ).chunkKeyOf)
      admitIdOf.set(t.mint, runScopedId(ctx, 'admitPausedLanes', key))
  if (parsed.laneKind === 'driven') {
    const joinIdOf = new Map<string, string>()
    for (const [i, token] of parsed.tokens.entries()) {
      const member = state.members.get(token.mint)
      if (!member) continue
      if (member.poolGroupAddress !== g.toBase58())
        throw new CCTParamsInvalidError(
          NAME,
          `tokens[${i}].tokenAddress`,
          `${token.mint} is a member of another pool group (${member.poolGroupAddress}): remove it there first`,
        )
      // a member may lack the live chains still to be listed by its paused creation
      const live = new Set(liveOf(token).map((r) => r.selector))
      if (!memberMatches(member.remoteTokens, token.remotes, live))
        throw new CCTParamsInvalidError(
          NAME,
          `tokens[${i}].remoteTokens`,
          `${token.mint} is a member already, listing other remote tokens: change them with enableMultiTokenPoolChain's remoteTokens, or remove the token first`,
        )
    }
    for (const [owner, tokens] of byOwner)
      for (const { key, items: chunk } of stableChunks(
        tokens,
        MEMBERS_PER_STEP,
        (t) => !state.members.has(t.mint),
        (t) => t.mint,
      ).chunks) {
        const id = stepId(ctx, 'joinPoolGroup', key)
        for (const t of chunk) joinIdOf.set(t.mint, id)
        // a live chain is listed later, in the transaction that creates its lane paused (M6)
        const members: PoolGroupMemberEntry[] = chunk.map((t) => {
          const live = new Set(liveOf(t).map((r) => r.selector))
          return {
            tokenAddress: t.mint,
            remoteTokens: memberRemoteTokensOf(t.remotes.filter((r) => !live.has(r.selector))),
          }
        })
        specs.push(
          opStep(
            ctx,
            {
              id,
              name: 'joinPoolGroup',
              operation: 'joinPoolGroup',
              dependsOn: chunk.flatMap((t) => afterToken(t.mint)),
              summary: `${chunk.length} token(s) join the pool group`,
              writeSet: chunk.map((t) => keys.member(t.mint)),
              guardReads: [
                ...new Set(chunk.flatMap((t) => t.remotes.map((r) => keys.chain(g, r.selector)))),
              ],
              signer: poolOwnerSigner(ctx, owner),
              progress: chunk.length,
            },
            POOL_GROUP_MEMBERSHIP_OPERATIONS.joinPoolGroup,
            { ...opBase(ctx), poolGroupMembers: members },
          ),
        )
      }
    // live chains: list, create and pause each lane in one transaction per member
    const unacknowledged: string[] = []
    for (const [owner, tokens] of byOwner)
      for (const { items: chunk } of stableChunks(
        tokens,
        MEMBERS_PER_STEP,
        (t) => liveOf(t).length > 0,
        (t) => t.mint,
      ).chunks) {
        const id = admitIdOf.get(chunk[0]!.mint)!
        const lanes = chunk.flatMap((t) =>
          liveOf(t).map((r) => ({ tokenAddress: t.mint, remoteChainSelector: r.selector })),
        )
        for (const l of lanes) laneStepOf.set(keys.lane(l.tokenAddress, l.remoteChainSelector), id)
        if (!parsed.acknowledgeLiveAdmission) unacknowledged.push(id)
        specs.push(
          opStep(
            ctx,
            {
              id,
              name: 'admitPausedLanes',
              operation: 'setPoolGroupMemberRemoteTokens',
              dependsOn: chunk.flatMap((t) => [
                ...(joinIdOf.has(t.mint) ? [joinIdOf.get(t.mint)!] : []),
                ...afterToken(t.mint),
              ]),
              summary: `list ${lanes.length} live lane(s) on ${chunk.length} member(s), creating each lane paused in the same transaction`,
              writeSet: [
                ...chunk.map((t) => keys.member(t.mint)),
                ...lanes.map((l) => keys.lane(l.tokenAddress, l.remoteChainSelector)),
              ],
              guardReads: [...new Set(lanes.map((l) => keys.chain(g, l.remoteChainSelector)))],
              signer: poolOwnerSigner(ctx, owner),
              progress: lanes.length,
            },
            POOL_GROUP_MEMBERSHIP_OPERATIONS.setPoolGroupMemberRemoteTokens,
            {
              ...opBase(ctx),
              upsert: chunk.map((t) => ({
                tokenAddress: t.mint,
                remoteTokens: memberRemoteTokensOf(liveOf(t)),
              })),
              createLanesPaused: true,
            },
          ),
        )
      }
    if (unacknowledged.length)
      blocks.push({
        reason: `${unacknowledged.length} step(s) admit lanes on a chain that is already live: a live chain is never paused, so each lane is created paused with its admission and lifted after the lane check; pass solana.acknowledgeLiveAdmission: true to admit them`,
        steps: unacknowledged,
      })
    // materialize behind a chain pause: listed, admitted (now or by this plan), no lane yet
    for (const selector of selectors) {
      if (
        state.records.get(selector) &&
        !pauseIds.has(selector) &&
        recordRuns(state.records.get(selector)!)
      )
        continue
      const candidates = parsed.tokens.filter((t) => t.remotes.some((r) => r.selector === selector))
      for (const spec of materializeSteps(
        ctx,
        'materializePoolGroupLanes',
        selector,
        candidates.map((t) => t.mint),
        (m) =>
          !laneOf(state, m, selector) &&
          (pauseIds.has(selector) || recordAdmitsMint(state, selector, m)),
        (chunk) => [
          ...(pauseIds.has(selector) ? [pauseIds.get(selector)!] : []),
          ...chunk.flatMap((m) => [
            ...(joinIdOf.has(m) ? [joinIdOf.get(m)!] : []),
            ...afterToken(m),
          ]),
        ],
      )) {
        specs.push(spec)
        for (const key of spec.step.writeSet)
          if (key.startsWith('lane:')) laneStepOf.set(key, spec.step.id)
      }
    }
  } else {
    for (const selector of selectors) {
      const needs = parsed.tokens.filter((t) => t.remotes.some((r) => r.selector === selector))
      for (const t of needs) {
        const lane = laneOf(state, t.mint, selector)
        if (lane && lane.poolGroupAddress !== g.toBase58())
          throw new CCTParamsInvalidError(
            NAME,
            'tokens',
            `${t.mint} has a lane toward ${selector} that is not linked to this pool group: link it with linkPoolGroupLanes, or remove it`,
          )
      }
      const linkedByOwner = new Map<string, ParsedOnboardingToken[]>()
      for (const t of needs)
        linkedByOwner.set(ownerOf(t), [...(linkedByOwner.get(ownerOf(t)) ?? []), t])
      for (const [owner, tokens] of linkedByOwner)
        for (const { key, items: chunk } of stableChunks(
          tokens,
          MEMBERS_PER_STEP,
          (t) => !laneOf(state, t.mint, selector),
          (t) => t.mint,
        ).chunks) {
          const id = stepId(ctx, 'initPoolGroupLanes', selector, key)
          for (const t of chunk) laneStepOf.set(keys.lane(t.mint, selector), id)
          specs.push(
            opStep(
              ctx,
              {
                id,
                name: 'initPoolGroupLanes',
                operation: 'initPoolGroupLanes',
                dependsOn: chunk.flatMap((t) => afterToken(t.mint)),
                summary: `create ${chunk.length} linked lane(s) toward ${selector}`,
                writeSet: chunk.map((t) => keys.lane(t.mint, selector)),
                guardReads: [keys.chain(g, selector)],
                signer: poolOwnerSigner(ctx, owner),
                progress: chunk.length,
              },
              POOL_GROUP_LANE_OPERATIONS.initPoolGroupLanes,
              {
                ...opBase(ctx),
                remoteChainSelector: selector,
                lanes: chunk.map((t) => {
                  const r = t.remotes.find((x) => x.selector === selector)!
                  return {
                    tokenAddress: t.mint,
                    remoteTokenAddress: r.token,
                    remoteTokenDecimals: r.decimals,
                    remotePoolAddresses: t.remotePoolAddresses,
                  }
                }),
                classSource: {
                  connection: 'default',
                  fee: 'default',
                  rateLimit: 'default',
                  security: 'default',
                },
              },
            ),
          )
        }
    }
  }

  // ── policies ──
  for (const [policyId, policy] of policies) {
    const carried: PoolGroupPolicyClass[] = policy.classes
    for (const selector of selectors) {
      const tokens = parsed.tokens.filter(
        (t) => t.policy === policyId && t.remotes.some((r) => r.selector === selector),
      )
      if (!tokens.length) continue
      if (!policy.remoteChainSelectors.includes(selector))
        throw new CCTParamsInvalidError(
          NAME,
          `tokens[${parsed.tokens.indexOf(tokens[0]!)}].policy`,
          `policy ${policyId} has no chain record for ${selector}: run enableMultiTokenPoolChain with policy ${policyId} first`,
        )
      const lanes = tokens.map((t) => {
        const current = laneOf(state, t.mint, selector)?.classSource ?? null
        return {
          mint: t.mint,
          owner: ownerOf(t),
          current,
          done: assignmentHolds(current, policyId, carried),
        }
      })
      const todo = lanes.filter((l) => !l.done)
      if (!todo.length) continue
      if (carried.includes('security'))
        findings.push(
          ...securityCopiedFindings(
            todo.map((l) => ({ tokenAddress: l.mint, remoteChainSelector: selector })),
            policyId,
          ),
        )
      specs.push(
        ...assignSteps(ctx, 'assignPoolGroupLanePolicies', {
          selector,
          policyId,
          carried,
          lanes,
          dependsOn: (chunk) =>
            chunk.flatMap((m) => {
              const s = laneStepOf.get(keys.lane(m, selector))
              return s ? [s] : []
            }),
        }),
      )
    }
  }

  // ── check, then lift this run's pauses ──
  const writes = specs.filter((s) => s.run).map((s) => s.step.id)
  const allLanes = parsed.tokens.flatMap((t) =>
    t.remotes.map((r) => ({ tokenAddress: t.mint, remoteChainSelector: r.selector })),
  )
  const check = checkStep<Name>(ctx, 'checkLanes', allLanes, writes, parsed.check)
  specs.push(check)
  if (parsed.unpause) {
    // chain pauses: from create in this plan, or from an earlier step of this run (enable)
    for (const selector of selectors) {
      const record = state.records.get(selector)
      const pausedNow =
        pauseIds.has(selector) || (record?.laneMode !== 'off' && record?.drivenLanesPaused)
      if (!pausedNow) continue
      const unpauseStepId = runScopedId(ctx, 'unpausePoolGroupChainLanes', selector)
      const decision = unpauseDecision({
        pauseStepIds: [pauseIdOf(selector)],
        pausePlanned: pauseIds.has(selector) ? [pauseIdOf(selector)] : [],
        unpauseStepId,
        landed: ctx.landed,
        what: `the driven lanes of ${selector}`,
        ...(record && { onChain: chainPausedAsSet(record) }),
      })
      if (!decision.lift) {
        blocks.push(decision.block)
        continue
      }
      specs.push(
        chainLanesStep(ctx, 'unpausePoolGroupChainLanes', {
          selector,
          drivenLanesPaused: false,
          acknowledgeLiveAdmission: allLanes.filter((l) => l.remoteChainSelector === selector),
          dependsOn: [check.step.id, ...decision.dependsOn],
          summary: `lift the driven-lanes pause of ${selector} this run set`,
          id: unpauseStepId,
        }),
      )
    }
    // lane pauses this run's paused creation set (M6)
    if (parsed.laneKind === 'driven')
      for (const t of parsed.tokens) {
        const admitId = admitIdOf.get(t.mint)!
        const planned = specs.some((s) => s.step.id === admitId)
        const selectorsToLift = t.remotes
          .map((r) => r.selector)
          .filter((c) => {
            const record = state.records.get(c)
            if (!record || pauseIds.has(c) || !recordRuns(record)) return false
            if (liveLane(t, c)) return true
            const lane = laneOf(state, t.mint, c)
            return !!lane && lane.kind === 'driven' && lane.pausedOutbound && lane.pausedInbound
          })
        if (!selectorsToLift.length) continue
        const unpauseStepId = runScopedId(ctx, 'unpausePoolGroupLanes', t.mint)
        const existing = selectorsToLift.flatMap((c) => {
          const lane = laneOf(state, t.mint, c)
          return lane ? [lane] : []
        })
        const unsettled = existing
          .map((l) => lanePausedAsCreated(l, g))
          .find((x): x is { ok: false; reason: string } => !x.ok)
        const decision = unpauseDecision({
          pauseStepIds: [admitId],
          pausePlanned: planned ? [admitId] : [],
          unpauseStepId,
          landed: ctx.landed,
          what: `the lanes of ${t.mint} toward ${selectorsToLift.join(', ')}`,
          onChain: unsettled ?? { ok: true },
        })
        if (!decision.lift) {
          blocks.push(decision.block)
          continue
        }
        specs.push(
          laneUnpauseStep(ctx, 'unpausePoolGroupLanes', {
            mint: t.mint,
            owner: state.poolOwners.get(t.mint),
            selectors: selectorsToLift,
            dependsOn: [check.step.id, ...decision.dependsOn],
            id: unpauseStepId,
          }),
        )
      }
  }

  const blockedBy = mergeBlocks(blocks)
  return {
    specs,
    ...(blockedBy && { blockedBy }),
    findings,
    observedAt: state.slot,
    ...(state.group
      ? { poolGroupId: state.group.poolGroupId }
      : parsed.poolGroupId
        ? { poolGroupId: parsed.poolGroupId }
        : {}),
    poolGroupAddress: g.toBase58(),
  }
}

/** Whether the record of `selector` admits `mint` now. */
function recordAdmitsMint(state: PlanState, selector: bigint, mint: string): boolean {
  const record = state.records.get(selector)
  return !!record && recordAdmits(record, mint)
}

/**
 * Whether a chain record still holds the driven-lanes pause as a pause step left it: out of `'off'`
 * with the driven lanes paused (the `onChain` input of `unpauseDecision`). The record keeps no
 * author, so a pause re-set by someone else after this run's lift is caught by the landed unpause
 * id instead. @internal
 */
export function chainPausedAsSet(
  record: GetPoolGroupChainResult,
): { ok: true } | { ok: false; reason: string } {
  if (record.laneMode === 'off') return { ok: false, reason: "the record is back in 'off'" }
  if (!record.drivenLanesPaused) return { ok: false, reason: 'its driven lanes are not paused' }
  return { ok: true }
}

/** A `set_group_chain_policy` step (detached from the group default: the caller set the values). @internal */
export function sectionStep<N extends string>(
  ctx: PlannerContext,
  name: N,
  id: string,
  selector: bigint,
  section: PoolGroupSectionUpdate,
  dependsOn: string[],
  detach = true,
): StepSpec<N> {
  const roles = {
    connection: ['connectionAdmin'],
    fee: ['feeAdmin'],
    rateLimit: ['rateLimitAdmin'],
  }[section.policyClass]
  return opStep(
    ctx,
    {
      id,
      name,
      operation: 'setPoolGroupChainPolicy',
      dependsOn,
      summary: `write ${section.policyClass} of the chain record of ${selector}`,
      writeSet: [keys.chain(ctx.ref.group, selector)],
      guardReads: [],
      signer: groupSigner(ctx, ['policyAdmin', ...roles]),
    },
    POOL_GROUP_CHAIN_OPERATIONS.setPoolGroupChainPolicy,
    {
      ...opBase(ctx),
      remoteChainSelector: selector,
      section,
      ...(detach && { detachFromPoolGroupDefault: true }),
    },
  )
}

/** The pool group PDA of an id under a program. @internal */
export const poolGroupOf = (program: PublicKey, id: string) =>
  poolGroupPdas.group(program, new PublicKey(id))
