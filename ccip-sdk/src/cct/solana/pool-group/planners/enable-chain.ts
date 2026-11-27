/**
 * `enableMultiTokenPoolChain` on Solana (design addendum §3.1): the group chain record always gets
 * the chain's values (CONNECTION, FEE, RATE_LIMIT; driven lanes start on it); with `policy`, the
 * policy's chain record too, for the classes it carries, and every admitted lane is assigned to it.
 * A record in `'off'` leaves it with its driven lanes paused (the program requires it); a live record
 * is never paused, and lanes it newly admits need `solana.acknowledgeLiveAdmission`.
 *
 * @packageDocumentation
 */

import { AddressLookupTableProgram, PublicKey } from '@solana/web3.js'

import { ChainFamily } from '../../../../networks.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import {
  type MultiTokenPoolLaneFinding,
  type MultiTokenPoolPlanBlock,
  type MultiTokenPoolRateLimits,
  POOL_DATA_FORMATS,
} from '../../../multi-token-pool.ts'
import { parseRemoteAddress, parseUniqueRemoteAddresses } from '../../../remote-address.ts'
import { submit } from '../../submit.ts'
import { parseRateLimitConfig } from '../../token-pool/operations/set-chain-rate-limit.ts'
import { U64_MAX, parsePublicKey, validateBigInt, validateInteger } from '../../validate.ts'
import { poolGroupPdas } from '../accounts.ts'
import { POOL_GROUP_CHAIN_OPERATIONS } from '../operations/chains.ts'
import { parsePoolGroupRef } from '../operations/common.ts'
import { GetPoolGroupMembers } from '../operations/get-pool-group-members.ts'
import {
  GetPoolGroupPolicy,
  GetPoolGroupPolicyChainRecord,
} from '../operations/get-pool-group-policy.ts'
import { parseMemberChains } from '../operations/members-common.ts'
import { POOL_GROUP_MEMBERSHIP_OPERATIONS } from '../operations/membership.ts'
import { POOL_GROUP_POLICY_OPERATIONS } from '../operations/policies.ts'
import { POOL_GROUP_SECURITY_OPERATIONS } from '../operations/security.ts'
import type { PoolGroupLaneKey, PoolGroupPolicyClass, PoolGroupSections } from '../types.ts'
import type { PoolGroupSectionUpdate } from '../write-types.ts'
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
import { stableChunks, unpauseDecision } from './engine.ts'
import {
  type LaneCheckInputs,
  type PlanState,
  LANES_PER_STEP,
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
import { MEMBERS_PER_STEP, chainPausedAsSet, sectionStep } from './onboard.ts'
import { mergeBlocks } from './run.ts'
import type {
  GenerateEnableMultiTokenPoolChainParams,
  PoolGroupChainEnablementStepName,
} from './types.ts'

const NAME = 'enableMultiTokenPoolChain'
type Name = PoolGroupChainEnablementStepName

/** Parsed chain enablement params. @internal */
export type ParsedEnablement = {
  selector: bigint
  policy?: number
  sections: PoolGroupSectionUpdate[]
  tokens: string[] | 'all-members'
  remoteTokens: { mint: string; token: string; decimals: number }[]
  unpause: boolean
  detach: boolean
  acknowledgeLiveAdmission: boolean
  lookupTables: string[]
  check: LaneCheckInputs
}

/** The four bucket names of `MultiTokenPoolRateLimits`. */
const BUCKETS = ['outbound', 'inbound', 'fastFinalityOutbound', 'fastFinalityInbound'] as const

/**
 * Parses the enablement params before any RPC.
 * @throws {@link CCTParamsInvalidError} with the dotted path of the bad field
 * @internal
 */
export function parseEnablement(params: GenerateEnableMultiTokenPoolChainParams): {
  ref: ReturnType<typeof parsePoolGroupRef>
  parsed: ParsedEnablement
} {
  const ref = parsePoolGroupRef(NAME, params)
  const solana = params.solana ?? {}
  const rc = params.remoteChain as unknown
  if (typeof rc !== 'object' || rc === null)
    throw new CCTParamsInvalidError(NAME, 'remoteChain', 'must be an object')
  const remote = params.remoteChain
  validateBigInt(NAME, 'remoteChain.remoteChainSelector', remote.remoteChainSelector, 1n, U64_MAX)
  const selector = remote.remoteChainSelector
  if (!Array.isArray(remote.remotePools) || !remote.remotePools.length)
    throw new CCTParamsInvalidError(NAME, 'remoteChain.remotePools', 'must be a non-empty array')
  const addresses = parseUniqueRemoteAddresses(
    NAME,
    'remoteChain.remotePools',
    remote.remotePools.map((p) => p.address),
    selector,
  )
  const remotePools = remote.remotePools.map((p, i) => {
    if (typeof p.allowLegacyPoolData !== 'boolean')
      throw new CCTParamsInvalidError(
        NAME,
        `remoteChain.remotePools[${i}].allowLegacyPoolData`,
        'must be a boolean',
      )
    return { address: addresses[i]!, allowLegacyPoolData: p.allowLegacyPoolData }
  })
  if (remote.poolDataFormat !== undefined && !POOL_DATA_FORMATS.includes(remote.poolDataFormat))
    throw new CCTParamsInvalidError(
      NAME,
      'remoteChain.poolDataFormat',
      "must be 'legacy' or 'long'",
    )
  const limits: unknown = remote.rateLimits
  if (typeof limits !== 'object' || limits === null)
    throw new CCTParamsInvalidError(NAME, 'remoteChain.rateLimits', 'must be an object')
  for (const b of BUCKETS)
    parseRateLimitConfig(NAME, `remoteChain.rateLimits.${b}`, remote.rateLimits[b])
  const fee: unknown = remote.tokenTransferFeeConfig
  if (typeof fee !== 'object' || fee === null)
    throw new CCTParamsInvalidError(NAME, 'remoteChain.tokenTransferFeeConfig', 'must be an object')
  if (params.policy !== undefined) {
    if (typeof params.policy !== 'number')
      throw new CCTParamsInvalidError(NAME, 'policy', 'on Solana a policy is its numeric id')
    validateInteger(NAME, 'policy', params.policy, 0, 255)
  }
  let tokens: string[] | 'all-members'
  if (params.tokenAddresses === 'all-members') tokens = 'all-members'
  else if (Array.isArray(params.tokenAddresses))
    tokens = params.tokenAddresses.map((t, i) =>
      parsePublicKey(NAME, `tokenAddresses[${i}]`, t).toBase58(),
    )
  else
    throw new CCTParamsInvalidError(
      NAME,
      'tokenAddresses',
      `must be a list of mints or 'all-members' (${String(params.tokenAddresses) === 'all-policy-tokens' ? "'all-policy-tokens' is the EVM literal" : 'got something else'})`,
    )
  if (Array.isArray(tokens) && new Set(tokens).size !== tokens.length)
    throw new CCTParamsInvalidError(NAME, 'tokenAddresses', 'must name each token once')
  const remoteTokens = (params.remoteTokens ?? []).map((r, i) => {
    const mint = parsePublicKey(NAME, `remoteTokens[${i}].tokenAddress`, r.tokenAddress).toBase58()
    if (Array.isArray(tokens) && !tokens.includes(mint))
      throw new CCTParamsInvalidError(
        NAME,
        `remoteTokens[${i}].tokenAddress`,
        'not admitted by tokenAddresses',
      )
    validateInteger(NAME, `remoteTokens[${i}].remoteTokenDecimals`, r.remoteTokenDecimals, 0, 255)
    return {
      mint,
      token: parseRemoteAddress(
        NAME,
        `remoteTokens[${i}].remoteTokenAddress`,
        r.remoteTokenAddress,
        selector,
      ),
      decimals: r.remoteTokenDecimals,
    }
  })
  const rateLimit: Partial<MultiTokenPoolRateLimits> = { ...remote.rateLimits }
  const sections: PoolGroupSectionUpdate[] = [
    { policyClass: 'fee', tokenTransferFeeConfig: remote.tokenTransferFeeConfig },
    { policyClass: 'rateLimit', rateLimit },
    {
      policyClass: 'connection',
      connection: {
        remotePools,
        ...(remote.poolDataFormat && { poolDataFormat: remote.poolDataFormat }),
        ...(solana.allowedFinality && { allowedFinality: solana.allowedFinality }),
      },
    },
  ]
  const lookupTables = (solana.budget?.lookupTableAddresses ?? []).map((t, i) =>
    parsePublicKey(NAME, `solana.budget.lookupTableAddresses[${i}]`, t).toBase58(),
  )
  return {
    ref,
    parsed: {
      selector,
      ...(params.policy !== undefined && { policy: params.policy }),
      sections,
      tokens,
      remoteTokens,
      unpause: params.unpause === true,
      detach: solana.detachFromPoolGroupDefault === true,
      acknowledgeLiveAdmission: solana.acknowledgeLiveAdmission === true,
      lookupTables,
      check: laneCheckOptions(params),
    },
  }
}

/** The member's stored remote token on `selector` equals the given one. */
function memberHas(
  remoteTokens: Parameters<typeof parseMemberChains>[2],
  selector: bigint,
  want: { token: string; decimals: number },
): boolean {
  const have = parseMemberChains(NAME, 'member', remoteTokens).get(selector)
  if (!have) return false
  const w = parseMemberChains(NAME, 'remoteTokens', [
    { remoteChainSelectors: [selector], token: want.token, decimals: want.decimals },
  ]).get(selector)!
  return have.token.equals(w.token) && have.decimals === w.decimals
}

/** Lanes per admission on a live chain: it and every lane it opens, created paused, are one transaction. @internal */
export const LIVE_ADMISSIONS_PER_STEP = 4

/** What the enablement expansion reads from chain state (a plain value: the goldens fake it). @internal */
export type EnablementInputs = {
  /** The pool group, the chain record, members, lanes and pool owners. */
  state: PlanState
  /** The mints the plan reaches: listed, or every member (sorted) with `'all-members'`. */
  mints: string[]
  /** With `policy`: the classes it carries, and its chain record of the chain when it has one. */
  policy?: {
    classes: PoolGroupPolicyClass[]
    record?: { sections: PoolGroupSections; inheritsDefault: PoolGroupPolicyClass[] }
  }
  /** The given lookup tables, as read (absent: no table at that address). */
  lookupTables: { table: string; addresses: string[]; authority?: string }[]
}

/**
 * Reads what {@link expandEnablementFrom} needs: the members (`getProgramAccounts` with
 * `'all-members'`), one state read, the policy and the lookup tables.
 * @internal
 */
export async function readEnablementInputs(
  ctx: PlannerContext,
  parsed: ParsedEnablement,
): Promise<EnablementInputs> {
  const refParams = {
    poolProgramAddress: ctx.ref.program.toBase58(),
    poolGroupAddress: ctx.ref.group.toBase58(),
  }
  const C = parsed.selector
  // 'all-members' reaches every member: list them (getProgramAccounts), in a stable order
  const listed =
    parsed.tokens === 'all-members'
      ? (await new GetPoolGroupMembers().query(ctx.chain, refParams)).poolGroupMembers
          .map((m) => m.tokenAddress)
          .sort()
      : parsed.tokens
  const mints = [...new Set([...listed, ...parsed.remoteTokens.map((r) => r.mint)])]
  const state = await readPlanState(ctx, { selectors: [C], mints })
  let policy: EnablementInputs['policy']
  if (parsed.policy !== undefined && state.group) {
    const p = await new GetPoolGroupPolicy().query(ctx.chain, {
      ...refParams,
      policyId: parsed.policy,
    })
    const record = p.remoteChainSelectors.includes(C)
      ? await new GetPoolGroupPolicyChainRecord().query(ctx.chain, {
          ...refParams,
          policyId: parsed.policy,
          remoteChainSelector: C,
        })
      : undefined
    policy = {
      classes: p.classes,
      ...(record && {
        record: { sections: record.sections, inheritsDefault: record.inheritsDefault },
      }),
    }
  }
  const lookupTables: EnablementInputs['lookupTables'] = []
  for (const table of parsed.lookupTables) {
    const { value } = await ctx.chain.connection.getAddressLookupTable(new PublicKey(table))
    if (!value) continue
    const authority = value.state.authority?.toBase58()
    lookupTables.push({
      table,
      addresses: value.state.addresses.map((a) => a.toBase58()),
      ...(authority && { authority }),
    })
  }
  return { state, mints, ...(policy && { policy }), lookupTables }
}

/**
 * Expands the enablement from one state read into its steps.
 * @internal
 */
export async function expandEnablement(
  ctx: PlannerContext,
  parsed: ParsedEnablement,
): Promise<Expansion<Name>> {
  return expandEnablementFrom(ctx, parsed, await readEnablementInputs(ctx, parsed))
}

/**
 * The enablement steps from what {@link readEnablementInputs} read: pure and deterministic (stable
 * chunk ids, M1). On a chain whose record already runs its driven lanes, nothing it opens is ever
 * materializable unpaused (S6 review M6): each member's new listing (`addMemberRemoteTokens`) and
 * each admission (`admitPoolGroupMembers`, at most {@link LIVE_ADMISSIONS_PER_STEP} lanes; a widening
 * to `'all-members'` admits the listing members by subset first) creates the lanes it opens paused
 * in its own transaction, the lane check runs on the real accounts, then `unpausePoolGroupLanes`
 * lifts those lane pauses.
 * @internal
 */
export function expandEnablementFrom(
  ctx: PlannerContext,
  parsed: ParsedEnablement,
  inputs: EnablementInputs,
): Expansion<Name> {
  const g = ctx.ref.group
  const C = parsed.selector
  const { state, mints } = inputs
  if (!state.group)
    throw new CCTParamsInvalidError(NAME, 'poolGroupAddress', `no pool group at ${g.toBase58()}`)
  const specs: StepSpec<Name>[] = []
  const findings: MultiTokenPoolLaneFinding[] = []
  const blocks: MultiTokenPoolPlanBlock[] = []
  const record = state.records.get(C)

  // ── the group chain record ──
  let addId: string | undefined
  if (!record) {
    addId = stepId(ctx, 'addPoolGroupChain', C)
    specs.push(
      opStep(
        ctx,
        {
          id: addId,
          name: 'addPoolGroupChain',
          operation: 'addPoolGroupChain',
          summary: `add the chain record of ${C}`,
          writeSet: [keys.group(g), keys.chain(g, C)],
          guardReads: [],
          signer: groupSigner(ctx, ['policyAdmin']),
        },
        POOL_GROUP_CHAIN_OPERATIONS.addPoolGroupChain,
        { ...opBase(ctx), remoteChainSelector: C },
      ),
    )
  }
  const afterAdd = addId ? [addId] : []
  const sectionIds: string[] = []
  for (const section of parsed.sections) {
    // a new record copies the default: CONNECTION's finality starts at full finality
    const update: PoolGroupSectionUpdate =
      !record && section.policyClass === 'connection' && !section.connection.allowedFinality
        ? {
            ...section,
            connection: { ...section.connection, allowedFinality: { finalityDepth: 0 } },
          }
        : section
    if (record && sectionHolds(record.policy, update)) continue
    const inherits = record?.inheritsDefault.includes(update.policyClass) ?? true
    if (record && inherits && !parsed.detach)
      throw new CCTParamsInvalidError(
        NAME,
        'solana.detachFromPoolGroupDefault',
        `the chain record of ${C} takes ${update.policyClass} from the pool group default: writing it detaches it, so later default writes no longer reach this chain; pass true to agree`,
      )
    const id = stepId(ctx, 'setPoolGroupChainPolicy', C, update.policyClass)
    sectionIds.push(id)
    specs.push(sectionStep(ctx, 'setPoolGroupChainPolicy', id, C, update, afterAdd, inherits))
  }

  // ── the policy's chain record (carried classes only; SECURITY goes through rollOutPoolGroupCCVs) ──
  const policyIds: string[] = []
  const carried: PoolGroupPolicyClass[] = inputs.policy?.classes ?? []
  if (parsed.policy !== undefined && inputs.policy) {
    const existing = inputs.policy.record
    let initId: string | undefined
    if (!existing) {
      initId = stepId(ctx, 'initPoolGroupPolicyChainRecord', C, parsed.policy)
      policyIds.push(initId)
      specs.push(
        opStep(
          ctx,
          {
            id: initId,
            name: 'initPoolGroupPolicyChainRecord',
            operation: 'initPoolGroupPolicyChainRecord',
            dependsOn: afterAdd,
            summary: `add the chain record of ${C} to policy ${parsed.policy}`,
            writeSet: [keys.policyChain(g, parsed.policy, C), keys.policy(g, parsed.policy)],
            guardReads: [keys.chain(g, C)],
            signer: groupSigner(ctx, ['policyAdmin']),
          },
          POOL_GROUP_POLICY_OPERATIONS.initPoolGroupPolicyChainRecord,
          { ...opBase(ctx), policyId: parsed.policy, remoteChainSelector: C },
        ),
      )
    }
    for (const section of parsed.sections) {
      if (!carried.includes(section.policyClass)) continue
      if (existing && sectionHolds(existing.sections, section)) continue
      const inherits = existing?.inheritsDefault.includes(section.policyClass) ?? true
      if (existing && inherits && !parsed.detach)
        throw new CCTParamsInvalidError(
          NAME,
          'solana.detachFromPoolGroupDefault',
          `policy ${parsed.policy}'s chain record of ${C} takes ${section.policyClass} from the policy default: writing it detaches it; pass true to agree`,
        )
      const id = stepId(
        ctx,
        'editPoolGroupPolicyChainRecord',
        C,
        `${parsed.policy}-${section.policyClass}`,
      )
      policyIds.push(id)
      specs.push(
        opStep(
          ctx,
          {
            id,
            name: 'editPoolGroupPolicyChainRecord',
            operation: 'editPoolGroupPolicyChainRecord',
            dependsOn: initId ? [initId] : [],
            summary: `write ${section.policyClass} of policy ${parsed.policy}'s chain record of ${C}`,
            writeSet: [keys.policyChain(g, parsed.policy, C)],
            guardReads: [],
            signer: groupSigner(ctx, ['policyAdmin']),
          },
          POOL_GROUP_POLICY_OPERATIONS.editPoolGroupPolicyChainRecord,
          {
            ...opBase(ctx),
            policyId: parsed.policy,
            remoteChainSelector: C,
            section,
            ...(inherits && { detachFromPolicyDefault: true }),
          },
        ),
      )
    }
  }

  // ── a lookup table that holds the other chain records gets this one ──
  const recordAddress = poolGroupPdas.groupChain(ctx.ref.program, g, C)
  const others = new Set(
    state.group.remoteChainSelectors
      .filter((s) => s !== C)
      .map((s) => poolGroupPdas.groupChain(ctx.ref.program, g, s).toBase58()),
  )
  for (const { table, addresses: held, authority } of inputs.lookupTables) {
    if (held.includes(recordAddress.toBase58()) || !held.some((a) => others.has(a))) continue
    if (!authority) continue
    const id = stepId(ctx, 'appendToChainRecordLookupTable', C, table)
    const tx = (payer: string) => ({
      family: ChainFamily.Solana,
      instructions: [
        AddressLookupTableProgram.extendLookupTable({
          payer: new PublicKey(payer),
          authority: new PublicKey(authority),
          lookupTable: new PublicKey(table),
          addresses: [recordAddress],
        }),
      ],
    })
    specs.push(
      specOf(
        ctx,
        {
          id,
          name: 'appendToChainRecordLookupTable',
          operation: 'extendLookupTable',
          dependsOn: afterAdd,
          summary: `add the chain record of ${C} to the lookup table ${table}`,
          inputs: { lookupTable: table, addresses: [recordAddress.toBase58()], authority },
          writeSet: [keys.lookupTable(table)],
          guardReads: [],
          signer: { kind: 'contract-owner', on: table, address: authority },
        },
        {
          run: {
            generate: (payer) =>
              Promise.resolve({
                transactions: [toPlannerTx(tx(payer), payer, [], 'lookup-table-authority')],
                findings: [],
              }),
            execute: async (wallet) => ({
              hashes: [
                (await submit(ctx.chain, wallet, tx(wallet.publicKey.toBase58()), NAME)).hash,
              ],
              findings: [],
            }),
          },
        },
      ),
    )
  }

  // ── who is admitted after the plan, and who lists the chain ──
  const members = state.members
  const admittedAfter = (mint: string) =>
    parsed.tokens === 'all-members'
      ? members.has(mint)
      : parsed.tokens.includes(mint) || (!!record && recordAdmits(record, mint))
  const listsNow = (mint: string) =>
    !!members.get(mint)?.remoteTokens.some((t) => t.remoteChainSelectors.includes(C))
  const listsAfter = (mint: string) =>
    parsed.remoteTokens.some((r) => r.mint === mint) || listsNow(mint)
  // a record that runs its driven lanes: every lane it opens is created paused (M6)
  const running = !!record && recordRuns(record)
  const ownerOf = (m: string) => state.poolOwners.get(m) ?? ctx.actor
  // per mint: the run-scoped steps that may create its lane paused (for the lift's decision)
  const creatorsOf = new Map<string, string[]>()
  const creator = (m: string, id: string) =>
    creatorsOf.set(m, [...new Set([...(creatorsOf.get(m) ?? []), id])])
  const createdPaused: PoolGroupLaneKey[] = []
  const pausedCreators: string[] = []

  // ── member remote tokens (admitted members only); on a running record also the members it
  // admits and that list the chain with no lane yet (a crank could create those unpaused) ──
  const upsertIdOf = new Map<string, string>()
  parsed.remoteTokens.forEach((r, i) => {
    const member = members.get(r.mint)
    if (!member || member.poolGroupAddress !== g.toBase58())
      throw new CCTParamsInvalidError(
        NAME,
        `remoteTokens[${i}].tokenAddress`,
        `${r.mint} is not a member of the pool group: onboard it first (onboardMultiTokenPoolTokens)`,
      )
  })
  const stored = (m: string) => {
    const t = members.get(m)?.remoteTokens.find((x) => x.remoteChainSelectors.includes(C))
    return t && { mint: m, token: t.token, decimals: t.decimals }
  }
  const crankable = running
    ? mints.filter(
        (m) =>
          recordAdmits(record, m) &&
          listsNow(m) &&
          !laneOf(state, m, C) &&
          !parsed.remoteTokens.some((r) => r.mint === m),
      )
    : []
  const upsertCandidates = [
    ...parsed.remoteTokens,
    ...crankable.flatMap((m) => {
      const s = stored(m)
      return s ? [s] : []
    }),
  ]
  const pausedHere = (m: string) => running && recordAdmits(record, m) && !laneOf(state, m, C)
  const byOwner = new Map<string, typeof upsertCandidates>()
  for (const r of upsertCandidates)
    byOwner.set(ownerOf(r.mint), [...(byOwner.get(ownerOf(r.mint)) ?? []), r])
  for (const [owner, list] of byOwner) {
    const { chunks, chunkKeyOf } = stableChunks(
      list,
      MEMBERS_PER_STEP,
      (r) => !memberHas(members.get(r.mint)!.remoteTokens, C, r) || pausedHere(r.mint),
      (r) => r.mint,
    )
    for (const [r, key] of chunkKeyOf)
      creator(r.mint, runScopedId(ctx, 'setPoolGroupMemberRemoteTokens', C, key))
    for (const { key, items: chunk } of chunks) {
      const id = runScopedId(ctx, 'setPoolGroupMemberRemoteTokens', C, key)
      const paused = chunk
        .filter((r) => pausedHere(r.mint))
        .map((r) => ({ tokenAddress: r.mint, remoteChainSelector: C }))
      createdPaused.push(...paused)
      if (paused.length) pausedCreators.push(id)
      for (const r of chunk) upsertIdOf.set(r.mint, id)
      specs.push(
        opStep(
          ctx,
          {
            id,
            name: 'addMemberRemoteTokens',
            operation: 'setPoolGroupMemberRemoteTokens',
            dependsOn: afterAdd,
            summary: `list ${C} on ${chunk.length} member(s)${paused.length ? `, creating ${paused.length} lane(s) paused in the same transaction` : ''}`,
            writeSet: [
              ...chunk.map((r) => keys.member(r.mint)),
              ...paused.map((l) => keys.lane(l.tokenAddress, C)),
            ],
            guardReads: [keys.chain(g, C)],
            signer: poolOwnerSigner(ctx, owner),
            progress: chunk.length,
          },
          POOL_GROUP_MEMBERSHIP_OPERATIONS.setPoolGroupMemberRemoteTokens,
          {
            ...opBase(ctx),
            upsert: chunk.map((r) => ({
              tokenAddress: r.mint,
              remoteTokens: [{ remoteChainSelectors: [C], token: r.token, decimals: r.decimals }],
            })),
            ...(running && { createLanesPaused: true }),
          },
        ),
      )
    }
  }

  // ── admission: from 'off' behind the driven-lanes pause; on a running record each admission
  // creates the lanes it opens paused, in its own transaction ──
  const listTokens = parsed.tokens === 'all-members' ? [] : parsed.tokens
  listTokens.forEach((m, i) => {
    if (!members.has(m))
      throw new CCTParamsInvalidError(
        NAME,
        `tokenAddresses[${i}]`,
        `${m} is not a member of the pool group yet: onboard it first, or admit 'all-members'`,
      )
  })
  const laneMode = parsed.tokens === 'all-members' ? 'all-members' : 'subset'
  const pauseId = runScopedId(ctx, 'pausePoolGroupChainLanes', C)
  const admitIds: string[] = []
  const pausing = !record || record.laneMode === 'off'
  if (pausing) {
    specs.push(
      chainLanesStep(ctx, 'pausePoolGroupChainLanes', {
        selector: C,
        laneMode,
        drivenLanesPaused: true,
        ...(listTokens.length && { addTokens: listTokens }),
        dependsOn: [...afterAdd, ...sectionIds],
        summary: `move the chain record of ${C} out of 'off' (${laneMode}) with its driven lanes paused`,
        id: pauseId,
      }),
    )
  } else {
    const widen = laneMode === 'all-members' && record.laneMode !== 'all-members'
    // the members it adds: named ones missing from the subset; widening adds every member by subset first
    const candidates = widen ? mints : listTokens
    const opensLane = (m: string) => listsAfter(m) && !laneOf(state, m, C)
    const { chunks, chunkKeyOf } = stableChunks(
      candidates,
      running ? LIVE_ADMISSIONS_PER_STEP : MEMBERS_PER_STEP,
      // widening a running record: only the members whose lanes it would open go by subset first
      (m) => !recordAdmits(record, m) && (!widen || (running && opensLane(m))),
      (m) => m,
    )
    if (running)
      for (const [m, key] of chunkKeyOf)
        creator(m, runScopedId(ctx, 'admitPoolGroupMembers', C, key))
    const upserts = [...new Set(upsertIdOf.values())]
    for (const { key, items: chunk } of chunks) {
      const id = runScopedId(ctx, 'admitPoolGroupMembers', C, key)
      const opened = running
        ? chunk.filter(opensLane).map((m) => ({ tokenAddress: m, remoteChainSelector: C }))
        : []
      createdPaused.push(...opened)
      if (opened.length) pausedCreators.push(id)
      admitIds.push(id)
      specs.push(
        chainLanesStep(ctx, 'admitPoolGroupMembers', {
          selector: C,
          addTokens: chunk,
          ...(opened.length && { createPaused: opened }),
          // listings land first, so the admission creates their lanes paused with itself
          dependsOn: [...sectionIds, ...upserts],
          summary: `admit ${chunk.length} member(s) on ${C}${opened.length ? `, creating ${opened.length} lane(s) paused in the same transaction` : ''}`,
          id,
        }),
      )
    }
    if (widen) {
      const id = runScopedId(ctx, 'admitPoolGroupMembers', C, 'all-members')
      const subsetFirst = [...admitIds]
      admitIds.push(id)
      specs.push(
        chainLanesStep(ctx, 'admitPoolGroupMembers', {
          selector: C,
          laneMode: 'all-members',
          // after the subset admissions it opens no lane of a listing member (else its op refuses)
          dependsOn: [...sectionIds, ...upserts, ...subsetFirst],
          summary: `admit every member on ${C}`,
          id,
        }),
      )
    }
  }
  if (createdPaused.length && !parsed.acknowledgeLiveAdmission)
    blocks.push({
      reason: `${createdPaused.length} lane(s) would be admitted on ${C}, which is already live: a live chain is never paused, so each lane is created paused with its admission and lifted after the lane check; pass solana.acknowledgeLiveAdmission: true to admit them`,
      steps: pausedCreators,
    })

  // ── materialize what is admitted and listed behind the chain pause, then assign and sync ──
  const target = mints.filter((m) => admittedAfter(m) && listsAfter(m))
  const laneStepOf = new Map<string, string>()
  for (const l of createdPaused) {
    const id =
      [...admitIds, ...upsertIdOf.values()].find((x) =>
        creatorsOf.get(l.tokenAddress)?.includes(x),
      ) ?? upsertIdOf.get(l.tokenAddress)
    if (id) laneStepOf.set(l.tokenAddress, id)
  }
  if (!running)
    for (const spec of materializeSteps(
      ctx,
      'materializePoolGroupLanes',
      C,
      target,
      (m) => !laneOf(state, m, C),
      (chunk) => [
        ...(pausing ? [pauseId] : []),
        ...admitIds,
        ...chunk.flatMap((m) => (upsertIdOf.has(m) ? [upsertIdOf.get(m)!] : [])),
      ],
    )) {
      specs.push(spec)
      for (const m of target)
        if (spec.step.writeSet.includes(keys.lane(m, C))) laneStepOf.set(m, spec.step.id)
    }
  const assignIds: string[] = []
  if (parsed.policy !== undefined) {
    const lanes = target.map((m) => {
      const current = laneOf(state, m, C)?.classSource ?? null
      return {
        mint: m,
        owner: ownerOf(m),
        current,
        done: assignmentHolds(current, parsed.policy!, carried),
      }
    })
    const todo = lanes.filter((l) => !l.done)
    if (todo.length && carried.includes('security'))
      findings.push(
        ...securityCopiedFindings(
          todo.map((l) => ({ tokenAddress: l.mint, remoteChainSelector: C })),
          parsed.policy,
        ),
      )
    for (const spec of assignSteps(ctx, 'assignPoolGroupLanePolicies', {
      selector: C,
      policyId: parsed.policy,
      carried,
      lanes,
      dependsOn: (chunk) => [
        ...policyIds,
        ...chunk.flatMap((m) => (laneStepOf.has(m) ? [laneStepOf.get(m)!] : [])),
      ],
    })) {
      specs.push(spec)
      assignIds.push(spec.step.id)
    }
  }
  for (const { key, items: chunk } of stableChunks(
    target,
    LANES_PER_STEP,
    (m) => {
      const lane = laneOf(state, m, C)
      return !!lane?.ccvCopy && !lane.ccvCopy.synced
    },
    (m) => m,
  ).chunks)
    specs.push(
      opStep(
        ctx,
        {
          id: stepId(ctx, 'syncPoolGroupCCVs', C, key),
          name: 'syncPoolGroupCCVs',
          operation: 'syncPoolGroupCCVs',
          dependsOn: assignIds,
          summary: `sync the CCV copy of ${chunk.length} lane(s) toward ${C}`,
          writeSet: chunk.map((m) => keys.lane(m, C)),
          guardReads: [keys.chain(g, C)],
          signer: { kind: 'anyone', on: g.toBase58() },
          progress: chunk.length,
        },
        POOL_GROUP_SECURITY_OPERATIONS.syncPoolGroupCCVs,
        { ...opBase(ctx), remoteChainSelector: C, tokenAddresses: chunk },
        { crank: true },
      ),
    )

  // ── check, then lift this run's pauses ──
  const lanes = target.map((m) => ({ tokenAddress: m, remoteChainSelector: C }))
  const writes = specs.filter((s) => s.run).map((s) => s.step.id)
  const check = checkStep<Name>(ctx, 'checkLanes', lanes, writes, parsed.check)
  specs.push(check)
  const planned = new Set(specs.map((s) => s.step.id))
  if (parsed.unpause && (pausing || record.drivenLanesPaused)) {
    const unpauseStepId = runScopedId(ctx, 'unpausePoolGroupChainLanes', C)
    const decision = unpauseDecision({
      pauseStepIds: [pauseId],
      pausePlanned: pausing ? [pauseId] : [],
      unpauseStepId,
      landed: ctx.landed,
      what: `the driven lanes of ${C}`,
      ...(record && !pausing && { onChain: chainPausedAsSet(record) }),
    })
    if (!decision.lift) blocks.push(decision.block)
    else
      specs.push(
        chainLanesStep(ctx, 'unpausePoolGroupChainLanes', {
          selector: C,
          drivenLanesPaused: false,
          acknowledgeLiveAdmission: lanes,
          dependsOn: [check.step.id, ...decision.dependsOn],
          summary: `lift the driven-lanes pause of ${C} this run set`,
          id: unpauseStepId,
        }),
      )
  }
  // lane pauses this run's paused creations set (M6)
  if (parsed.unpause && running)
    for (const m of target) {
      const lane = laneOf(state, m, C)
      const creates = createdPaused.some((l) => l.tokenAddress === m)
      if (
        !creates &&
        !(lane && lane.kind === 'driven' && lane.pausedOutbound && lane.pausedInbound)
      )
        continue
      const candidates = creatorsOf.get(m) ?? []
      const unpauseStepId = runScopedId(ctx, 'unpausePoolGroupLanes', m)
      const decision = unpauseDecision({
        pauseStepIds: candidates,
        pausePlanned: candidates.filter((id) => planned.has(id)),
        unpauseStepId,
        landed: ctx.landed,
        what: `the lane of ${m} toward ${C}`,
        onChain: lane ? lanePausedAsCreated(lane, g) : { ok: true },
      })
      if (!decision.lift) {
        blocks.push(decision.block)
        continue
      }
      specs.push(
        laneUnpauseStep(ctx, 'unpausePoolGroupLanes', {
          mint: m,
          owner: state.poolOwners.get(m),
          selectors: [C],
          dependsOn: [check.step.id, ...decision.dependsOn],
          id: unpauseStepId,
        }),
      )
    }
  const blockedBy = mergeBlocks(blocks)
  return {
    specs,
    ...(blockedBy && { blockedBy }),
    findings,
    observedAt: state.slot,
    poolGroupId: state.group.poolGroupId,
    poolGroupAddress: g.toBase58(),
  }
}
