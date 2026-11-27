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
import type { PoolGroupLaneKey, PoolGroupPolicyClass } from '../types.ts'
import type { PoolGroupSectionUpdate } from '../write-types.ts'
import {
  type Expansion,
  type PlannerContext,
  type StepSpec,
  chunked,
  keys,
  specOf,
  stepId,
  toPlannerTx,
} from './context.ts'
import { unpauseDecision } from './engine.ts'
import {
  type LaneCheckInputs,
  LANES_PER_STEP,
  assignSteps,
  assignmentHolds,
  chainLanesStep,
  checkStep,
  groupSigner,
  laneOf,
  materializeSteps,
  opBase,
  opStep,
  poolOwnerSigner,
  readPlanState,
  recordAdmits,
  recordLive,
  sectionHolds,
  securityCopiedFindings,
} from './flow-common.ts'
import { MEMBERS_PER_STEP, sectionStep } from './onboard.ts'
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
      check: {
        ...(params.getChain && { getChain: params.getChain }),
        ...(params.remoteAttestations && { remoteAttestations: params.remoteAttestations }),
        ...(params.minDestGasOverhead !== undefined && {
          minDestGasOverhead: params.minDestGasOverhead,
        }),
        ...(params.maxTransferFeeBps !== undefined && {
          maxTransferFeeBps: params.maxTransferFeeBps,
        }),
      },
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

/**
 * Expands the enablement from one state read into its steps.
 * @internal
 */
export async function expandEnablement(
  ctx: PlannerContext,
  parsed: ParsedEnablement,
): Promise<Expansion<Name>> {
  const g = ctx.ref.group
  const C = parsed.selector
  const refParams = {
    poolProgramAddress: ctx.ref.program.toBase58(),
    poolGroupAddress: g.toBase58(),
  }
  // 'all-members' reaches every member: list them (getProgramAccounts)
  const listed =
    parsed.tokens === 'all-members'
      ? (await new GetPoolGroupMembers().query(ctx.chain, refParams)).poolGroupMembers.map(
          (m) => m.tokenAddress,
        )
      : parsed.tokens
  const mints = [...new Set([...listed, ...parsed.remoteTokens.map((r) => r.mint)])]
  const state = await readPlanState(ctx, { selectors: [C], mints })
  if (!state.group)
    throw new CCTParamsInvalidError(NAME, 'poolGroupAddress', `no pool group at ${g.toBase58()}`)
  const specs: StepSpec<Name>[] = []
  const findings: MultiTokenPoolLaneFinding[] = []
  let blockedBy: MultiTokenPoolPlanBlock | undefined
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
  let carried: PoolGroupPolicyClass[] = []
  if (parsed.policy !== undefined) {
    const policy = await new GetPoolGroupPolicy().query(ctx.chain, {
      ...refParams,
      policyId: parsed.policy,
    })
    carried = policy.classes
    const has = policy.remoteChainSelectors.includes(C)
    let initId: string | undefined
    if (!has) {
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
    const existing = has
      ? await new GetPoolGroupPolicyChainRecord().query(ctx.chain, {
          ...refParams,
          policyId: parsed.policy,
          remoteChainSelector: C,
        })
      : undefined
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
  for (const table of parsed.lookupTables) {
    const { value } = await ctx.chain.connection.getAddressLookupTable(new PublicKey(table))
    const held = value?.state.addresses.map((a) => a.toBase58()) ?? []
    if (!value || held.includes(recordAddress.toBase58()) || !held.some((a) => others.has(a)))
      continue
    const authority = value.state.authority?.toBase58()
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
              Promise.resolve({ transactions: [toPlannerTx(tx(payer), payer, [])], findings: [] }),
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
  const listsAfter = (mint: string) =>
    parsed.remoteTokens.some((r) => r.mint === mint) ||
    !!members.get(mint)?.remoteTokens.some((t) => t.remoteChainSelectors.includes(C))
  const isLive = !!record && recordLive(record)
  const needsAck: PoolGroupLaneKey[] = []

  // ── member remote tokens (admitted members only) ──
  const upsertIdOf = new Map<string, string>()
  const upserts = parsed.remoteTokens.filter((r, i) => {
    const member = members.get(r.mint)
    if (!member || member.poolGroupAddress !== g.toBase58())
      throw new CCTParamsInvalidError(
        NAME,
        `remoteTokens[${i}].tokenAddress`,
        `${r.mint} is not a member of the pool group: onboard it first (onboardMultiTokenPoolTokens)`,
      )
    return !memberHas(member.remoteTokens, C, r)
  })
  const byOwner = new Map<string, typeof upserts>()
  for (const r of upserts) {
    const owner = state.poolOwners.get(r.mint) ?? ctx.actor
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), r])
  }
  let n = 0
  for (const [owner, list] of byOwner)
    for (const chunk of chunked(list, MEMBERS_PER_STEP)) {
      const id = stepId(ctx, 'setPoolGroupMemberRemoteTokens', C, n++)
      const ack = isLive
        ? chunk
            .filter((r) => recordAdmits(record, r.mint) && !laneOf(state, r.mint, C))
            .map((r) => ({ tokenAddress: r.mint, remoteChainSelector: C }))
        : []
      needsAck.push(...ack)
      for (const r of chunk) upsertIdOf.set(r.mint, id)
      specs.push(
        opStep(
          ctx,
          {
            id,
            name: 'addMemberRemoteTokens',
            operation: 'setPoolGroupMemberRemoteTokens',
            dependsOn: afterAdd,
            summary: `list ${C} on ${chunk.length} member(s)`,
            writeSet: chunk.map((r) => keys.member(r.mint)),
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
            ...(ack.length && parsed.acknowledgeLiveAdmission && { acknowledgeLiveAdmission: ack }),
          },
        ),
      )
    }

  // ── admission: from 'off' behind the driven-lanes pause; on a live record with the acknowledgement ──
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
  const pauseId = stepId(ctx, 'pausePoolGroupChainLanes', C)
  let admitId: string | undefined
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
        idPart: 'pausePoolGroupChainLanes',
      }),
    )
  } else {
    const missing = listTokens.filter((m) => !recordAdmits(record, m))
    const widen = laneMode === 'all-members' && record.laneMode !== 'all-members'
    if (missing.length || widen) {
      const newly = mints.filter(
        (m) =>
          !recordAdmits(record, m) && admittedAfter(m) && listsAfter(m) && !laneOf(state, m, C),
      )
      const ack = isLive ? newly.map((m) => ({ tokenAddress: m, remoteChainSelector: C })) : []
      needsAck.push(...ack)
      admitId = stepId(ctx, 'admitPoolGroupMembers', C)
      specs.push(
        chainLanesStep(ctx, 'admitPoolGroupMembers', {
          selector: C,
          ...(widen && { laneMode: 'all-members' }),
          ...(missing.length && { addTokens: missing }),
          ...(ack.length && parsed.acknowledgeLiveAdmission && { acknowledgeLiveAdmission: ack }),
          dependsOn: [...sectionIds, ...[...upsertIdOf.values()]],
          summary: `admit ${widen ? 'every member' : `${missing.length} member(s)`} on ${C}`,
          idPart: 'admitPoolGroupMembers',
        }),
      )
    }
  }
  if (needsAck.length && !parsed.acknowledgeLiveAdmission)
    blockedBy = {
      reason: `${needsAck.length} lane(s) would be admitted on ${C}, which is already live: a live chain is never paused, so pass solana.acknowledgeLiveAdmission: true (each lane is lane-checked before it goes live)`,
      steps: specs
        .filter(
          (s) => s.step.name === 'admitPoolGroupMembers' || s.step.name === 'addMemberRemoteTokens',
        )
        .map((s) => s.step.id),
    }

  // ── materialize what is admitted and listed, then assign and sync ──
  const target = mints.filter((m) => admittedAfter(m) && listsAfter(m))
  const laneStepOf = new Map<string, string>()
  const toCreate = target.filter((m) => !laneOf(state, m, C))
  for (const spec of materializeSteps(ctx, 'materializePoolGroupLanes', C, toCreate, (chunk) => [
    ...(pausing ? [pauseId] : []),
    ...(admitId ? [admitId] : []),
    ...chunk.flatMap((m) => (upsertIdOf.has(m) ? [upsertIdOf.get(m)!] : [])),
  ])) {
    specs.push(spec)
    for (const m of toCreate)
      if (spec.step.writeSet.includes(keys.lane(m, C))) laneStepOf.set(m, spec.step.id)
  }
  const assignIds: string[] = []
  if (parsed.policy !== undefined) {
    const lanes = target
      .filter(
        (m) => !assignmentHolds(laneOf(state, m, C)?.classSource ?? null, parsed.policy!, carried),
      )
      .map((m) => ({
        mint: m,
        owner: state.poolOwners.get(m) ?? ctx.actor,
        current: laneOf(state, m, C)?.classSource ?? null,
      }))
    if (lanes.length && carried.includes('security'))
      findings.push(
        ...securityCopiedFindings(
          lanes.map((l) => ({ tokenAddress: l.mint, remoteChainSelector: C })),
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
  const unsynced = target.filter((m) => {
    const lane = laneOf(state, m, C)
    return lane?.ccvCopy && !lane.ccvCopy.synced
  })
  for (const [i, chunk] of chunked(unsynced, LANES_PER_STEP).entries())
    specs.push(
      opStep(
        ctx,
        {
          id: stepId(ctx, 'syncPoolGroupCCVs', C, i),
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

  // ── check, then lift this run's pause ──
  const lanes = target.map((m) => ({ tokenAddress: m, remoteChainSelector: C }))
  const writes = specs.filter((s) => s.run).map((s) => s.step.id)
  const check = checkStep<Name>(ctx, 'checkLanes', lanes, writes, parsed.check)
  specs.push(check)
  const pausedNow = pausing || record.drivenLanesPaused
  if (parsed.unpause && pausedNow) {
    const decision = unpauseDecision({
      pauseStepId: pauseId,
      pausePlanned: pausing,
      landed: ctx.landed,
      what: `the driven lanes of ${C}`,
    })
    if (!decision.lift) blockedBy ??= decision.block
    else
      specs.push(
        chainLanesStep(ctx, 'unpausePoolGroupChainLanes', {
          selector: C,
          drivenLanesPaused: false,
          acknowledgeLiveAdmission: lanes,
          dependsOn: [check.step.id, ...decision.dependsOn],
          summary: `lift the driven-lanes pause of ${C} this run set`,
          idPart: 'unpausePoolGroupChainLanes',
        }),
      )
  }
  return {
    specs,
    ...(blockedBy && { blockedBy }),
    findings,
    observedAt: state.slot,
    poolGroupId: state.group.poolGroupId,
    poolGroupAddress: g.toBase58(),
  }
}
