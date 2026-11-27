/**
 * Pool-group SECURITY (S4): `schedule_group_ccvs`, `activate_group_ccvs_now`,
 * `set_allow_dropping_default_ccvs`, `reset_policy_security`, `sync_group_ccvs`, `sync_policy_ccvs`.
 * Program of record: chainlink-ccip-solana 7558722, `burnmint-token-pool/src/instructions/groups/
 * security.rs`.
 *
 * A SECURITY target is the group default, a chain record, a named policy's default or one of its
 * chain records (`PoolGroupSecurityTarget`); each op passes the remaining accounts `apply_security`
 * expects for it. A schedule or an emergency activation leaves lanes that have not copied the new
 * set failing closed from its activation: the guard reports them as warnings and `followUps` lists
 * the syncs. A sync can make a lane live again, so it runs the make-live check (A23).
 *
 * @packageDocumentation
 */

import { BN } from '@coral-xyz/anchor'
import {
  type AccountMeta,
  type TransactionInstruction,
  PublicKey,
  SystemProgram,
} from '@solana/web3.js'

import type { SolanaChain } from '../../../../solana/index.ts'
import { deriveTokenPoolChainConfigV2Pda } from '../../../../solana/token-pool.ts'
import { getMultipleAccountsInfoPaged } from '../../../../solana/utils.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import type { MultiTokenPoolLaneFinding } from '../../../multi-token-pool.ts'
import type { SolanaGenerateParams } from '../../operation.ts'
import { deriveTokenPoolConfigPda } from '../../programs/token-pool.ts'
import { parsePublicKey, validateInteger } from '../../validate.ts'
import { poolGroupPdas } from '../accounts.ts'
import { decodeRoles, toBigInt } from '../decode.ts'
import { type IdlPolicySections, classBit, isUnread, laneCcvSync } from '../lane.ts'
import { createPoolGroupProgram } from '../program.ts'
import { poolState } from '../remote-lane.ts'
import { sectionValue } from '../sections.ts'
import type { PoolGroupJudgement } from '../write-guard.ts'
import { type PoolGroupWritePlan, PoolGroupWriteOperation } from '../write-operation.ts'
import type {
  ActivatePoolGroupCCVsNowParams,
  PoolGroupFollowUp,
  PoolGroupGuardOptions,
  ResetPoolGroupPolicySecurityParams,
  SchedulePoolGroupCCVsParams,
  SchedulePoolGroupCCVsResult,
  SetPoolGroupAllowDroppingDefaultCCVsParams,
  SyncPoolGroupCCVsParams,
  SyncPoolGroupPolicyCCVsParams,
} from '../write-types.ts'
import {
  type ParsedPoolGroupRef,
  decodeOwned,
  parseTokenAddresses,
  readPoolGroup,
  validateSelector,
} from './common.ts'
import { listPoolGroupLaneRequests } from './get-pool-group-lane.ts'
import { readPoolGroupLaneStates } from './lane.ts'
import { readPolicy, requireCarried } from './policies.ts'
import {
  type ParsedGroupWrite,
  bigField,
  ccvSyncFollowUps,
  chainRecordMetas,
  decodeOne,
  eventAccounts,
  field,
  fittedItems,
  minCCVActivationDelayOf,
  parseGroupWrite,
  proposalBase,
  requireOwner,
  signerRole,
} from './write-common.ts'

/** `MAX_POLICY_CCVS` (base-token-pool `groups.rs:44`): CCVs per list. */
const MAX_POLICY_CCVS = 8
/** Seconds between building a wallet schedule and landing it, by default. */
const DEFAULT_APPROVAL_WINDOW = 60
/** `INCLUDE_DEFAULT_CCVS` (ccip-common `lib.rs:102`): the all-zero key. */
const INCLUDE_DEFAULT_CCVS = PublicKey.default
/** `SECURITY`'s class bit. */
const SECURITY = classBit('security')

/** A parsed SECURITY target. @internal */
export type Target = { selector?: bigint; policyId?: number }

/** Parses the SECURITY target rule's two optional fields. @internal */
export function parseTarget(
  operation: string,
  params: { remoteChainSelector?: unknown; policyId?: unknown },
): Target {
  const out: Target = {}
  if (params.remoteChainSelector !== undefined)
    out.selector = validateSelector(operation, 'remoteChainSelector', params.remoteChainSelector)
  if (params.policyId !== undefined) {
    validateInteger(operation, 'policyId', params.policyId, 0, 0xffff_ffff)
    out.policyId = Number(params.policyId)
  }
  return out
}

/** A target as the instruction's `(remote_chain_selector, policy_id)` options. @internal */
export const targetArgs = (t: Target) => ({
  remoteChainSelector: t.selector === undefined ? null : new BN(t.selector.toString()),
  policyId: t.policyId ?? null,
})

/** A proposal's target, from the instruction's options. @internal */
export function targetOf(data: unknown): Target {
  const selector = bigField(field(data, 'params', 'remoteChainSelector'))
  const policyId = bigField(field(data, 'params', 'policyId'))
  return {
    ...(selector !== undefined && { selector }),
    ...(policyId !== undefined && { policyId: Number(policyId) }),
  }
}

/** A target, for messages and snapshot paths. @internal */
export const targetName = (t: Target) =>
  `${t.policyId === undefined ? 'group' : `policy.${t.policyId}`}.${t.selector === undefined ? 'default' : String(t.selector)}`

/**
 * Parses a CCV list: base58 keys, `'default'` for `INCLUDE_DEFAULT_CCVS`, each once, at most 8.
 * @throws {@link CCTParamsInvalidError} otherwise
 */
function parseCcvList(operation: string, param: string, value: unknown): PublicKey[] {
  if (!Array.isArray(value)) throw new CCTParamsInvalidError(operation, param, 'must be an array')
  if (value.length > MAX_POLICY_CCVS)
    throw new CCTParamsInvalidError(operation, param, `holds at most ${MAX_POLICY_CCVS} CCVs`)
  const keys = value.map((v, i) =>
    v === 'default' ? INCLUDE_DEFAULT_CCVS : parsePublicKey(operation, `${param}[${i}]`, v),
  )
  if (new Set(keys.map((k) => k.toBase58())).size !== keys.length)
    throw new CCTParamsInvalidError(operation, param, 'must list each CCV once')
  return keys
}

/** A proposal's CCV list (`params.<name>`). */
function ccvListOf(data: unknown, name: string): PublicKey[] {
  const v = field(data, 'params', name)
  return Array.isArray(v) ? v.filter((k): k is PublicKey => k instanceof PublicKey) : []
}

/** What a SECURITY target reads: its section, inheritance and the accounts `apply_security` takes. @internal */
export type ReadTarget = {
  group: Awaited<ReturnType<typeof readPoolGroup>>['group']
  now: bigint
  /** The sections holding the target's SECURITY. */
  sections: IdlPolicySections
  /** Whether the target is a chain record that still follows its default for SECURITY. */
  inherits: boolean
  /** The remaining accounts, in order. */
  metas: AccountMeta[]
}

/**
 * Reads a SECURITY target and builds its remaining accounts: the group default with every chain
 * record; a chain record alone; a named policy's default as the `Policy` then all its records; a
 * policy chain record alone.
 * @throws {@link CCTParamsInvalidError} if the chain record, policy or policy record is missing, or
 *   the policy does not carry SECURITY
 * @internal
 */
export async function readTarget(
  operation: string,
  chain: SolanaChain,
  ref: ParsedPoolGroupRef,
  target: Target,
): Promise<ReadTarget> {
  const w = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true })
  if (target.policyId === undefined) {
    if (target.selector === undefined) {
      const { group, now } = await readPoolGroup(operation, chain, ref)
      return {
        group,
        now,
        sections: group.defaultPolicy,
        inherits: false,
        metas: chainRecordMetas(ref.program, ref.group, group.chainSelectors),
      }
    }
    const address = poolGroupPdas.groupChain(ref.program, ref.group, target.selector)
    const { group, now, extras } = await readPoolGroup(operation, chain, ref, [address])
    if (!extras[0])
      throw new CCTParamsInvalidError(
        operation,
        'remoteChainSelector',
        `the pool group has no chain record for ${target.selector}`,
      )
    const record = decodeOwned('groupChainPolicy', extras[0], address, ref.program)
    return {
      group,
      now,
      sections: record.policy,
      inherits: (record.inheritsDefault & SECURITY) !== 0,
      metas: [w(address)],
    }
  }
  const { group, now, address, policy } = await readPolicy(operation, chain, ref, target.policyId)
  requireCarried(operation, policy.classes, 'security', target.policyId)
  if (target.selector === undefined)
    return {
      group,
      now,
      sections: policy.defaultPolicy,
      inherits: false,
      metas: [
        w(address),
        ...policy.chainSelectors.map((c) =>
          w(poolGroupPdas.policyChain(ref.program, address, toBigInt(c))),
        ),
      ],
    }
  const recordAddress = poolGroupPdas.policyChain(ref.program, address, target.selector)
  const [info] = await getMultipleAccountsInfoPaged(chain.connection, [recordAddress])
  if (!info)
    throw new CCTParamsInvalidError(
      operation,
      'remoteChainSelector',
      `policy ${target.policyId} has no record for chain ${target.selector} (PolicyRecordMissing)`,
    )
  const record = decodeOwned('policyChainRecord', info, recordAddress, ref.program)
  return {
    group,
    now,
    sections: record.sections,
    inherits: (record.inheritsDefault & SECURITY) !== 0,
    metas: [w(recordAddress)],
  }
}

/**
 * F2 (`validate_group_ccvs`): a non-empty list keeps `'default'` unless the target allows dropping
 * the lane defaults.
 * @throws {@link CCTParamsInvalidError} otherwise
 */
function requireDefaultsKept(
  operation: string,
  sections: IdlPolicySections,
  lists: { outbound: PublicKey[]; inbound: PublicKey[] },
): void {
  if (sections.security.allowDroppingDefaultCcvs) return
  for (const dir of ['outbound', 'inbound'] as const) {
    const list = lists[dir]
    if (list.length && !list.some((k) => k.equals(INCLUDE_DEFAULT_CCVS)))
      throw new CCTParamsInvalidError(
        operation,
        dir,
        "a non-empty CCV list must keep 'default' (the lane defaults) unless dropping them is allowed (DefaultCcvsRequired): add 'default', or allow it first with setPoolGroupAllowDroppingDefaultCCVs",
      )
  }
}

/** The security-admin gate of a schedule: the owner, or the security admin. */
function requireSecurityAdmin(
  operation: string,
  group: ReadTarget['group'],
  authority: PublicKey,
): void {
  const admin = decodeRoles(group.roles).securityAdmin
  if (group.owner.equals(authority) || admin === authority.toBase58()) return
  throw new CCTParamsInvalidError(
    operation,
    'authority',
    `${authority.toBase58()} is neither the pool group owner (${group.owner.toBase58()}) nor its security admin (${admin ?? 'unset'}), who sign schedule_group_ccvs`,
  )
}

/** One single-signer item. */
const single = (ix: TransactionInstruction, owner: PublicKey, authority: PublicKey) => ({
  tokenAddresses: [],
  instructions: [ix],
  signerRoles: { [authority.toBase58()]: signerRole(owner, authority) },
})

/** The follow-ups of a CCV change: sync the lanes it leaves failing closed. */
const syncFollowUps = (target: Target) => (judgement: PoolGroupJudgement | null) =>
  ccvSyncFollowUps(
    judgement,
    'these lanes have not copied the new CCV set: they fail closed from its activation until synced',
    target.policyId,
  )

/**
 * The syncs an activation needs when its lanes could not be listed: every lane of each chain the
 * target reaches (the sync lists them itself, or takes `tokenAddresses`).
 */
function activateUnlistedFollowUps(
  target: Target,
  t: ReadTarget,
  unlisted: string,
): PoolGroupFollowUp[] {
  const selectors =
    target.selector !== undefined ? [target.selector] : t.group.chainSelectors.map(toBigInt)
  return selectors.map((remoteChainSelector) => ({
    operation: target.policyId === undefined ? 'syncPoolGroupCCVs' : 'syncPoolGroupPolicyCCVs',
    reason: `the lanes were not listed (${unlisted}): every lane on the target fails closed until synced`,
    inputs: {
      ...(target.policyId !== undefined && { policyId: target.policyId }),
      remoteChainSelector,
    },
  }))
}

/** The kept values of a SECURITY write. @internal */
export const securityExpected = (target: Target, t: ReadTarget) => ({
  [`security.${targetName(target)}`]: sectionValue(t.sections, 'security', target.selector),
})

// ─── schedule / activate now ─────────────────────────────────────────────────────────────────

type ParsedSchedule = ParsedGroupWrite & {
  target: Target
  outbound: PublicKey[]
  inbound: PublicKey[]
  activatesAt?: bigint
  approvalWindow: number
}

/** Schedules a CCV set on a SECURITY target, no sooner than the group's minimum notice. */
export class SchedulePoolGroupCCVs extends PoolGroupWriteOperation<
  SchedulePoolGroupCCVsParams,
  ParsedSchedule,
  SchedulePoolGroupCCVsResult
> {
  readonly name = 'schedulePoolGroupCCVs'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(
    params: SolanaGenerateParams<SchedulePoolGroupCCVsParams>,
  ): ParsedSchedule {
    const squads = params.budget?.executor === 'squads-v4'
    const window: unknown = params.approvalWindowSeconds
    if (window !== undefined)
      validateInteger(this.name, 'approvalWindowSeconds', window, 0, 2 ** 31)
    if (params.activatesAt !== undefined && window !== undefined)
      throw new CCTParamsInvalidError(
        this.name,
        'approvalWindowSeconds',
        'give activatesAt or approvalWindowSeconds, not both',
      )
    if (params.activatesAt !== undefined && typeof params.activatesAt !== 'bigint')
      throw new CCTParamsInvalidError(this.name, 'activatesAt', 'must be unix seconds (bigint)')
    if (squads && params.activatesAt === undefined && window === undefined)
      throw new CCTParamsInvalidError(
        this.name,
        'activatesAt',
        "a Squads vault executes later, when the time is checked: give activatesAt, or approvalWindowSeconds for the approvals' duration",
      )
    return {
      ...parseGroupWrite(this.name, params),
      target: parseTarget(this.name, params),
      outbound: parseCcvList(this.name, 'outbound', params.outbound),
      inbound: parseCcvList(this.name, 'inbound', params.inbound),
      ...(params.activatesAt !== undefined && { activatesAt: params.activatesAt }),
      approvalWindow: window === undefined ? DEFAULT_APPROVAL_WINDOW : Number(window),
    }
  }

  /**
   * `schedule_group_ccvs` at `activatesAt` (default: now + the minimum notice in force + the
   * approval window). A pending set it replaces is reported in `followUps` with the lanes to
   * re-sync.
   * @throws {@link CCTParamsInvalidError} if `authority` is neither the owner nor the security
   *   admin, a list drops the defaults (F2), or `activatesAt` is sooner than the notice allows
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedSchedule,
  ): Promise<PoolGroupWritePlan<SchedulePoolGroupCCVsResult>> {
    const { ref, authority, target } = parsed
    const t = await readTarget(this.name, chain, ref, target)
    requireSecurityAdmin(this.name, t.group, authority)
    requireDefaultsKept(this.name, t.sections, parsed)
    const earliest = t.now + minCCVActivationDelayOf(t.group, t.now)
    const activatesAt = parsed.activatesAt ?? earliest + BigInt(parsed.approvalWindow)
    if (activatesAt < earliest)
      throw new CCTParamsInvalidError(
        this.name,
        'activatesAt',
        `${activatesAt} is sooner than the pool group's minimum notice allows (${earliest} at the earliest, CcvActivationTooSoon)`,
      )
    const ix = await createPoolGroupProgram(chain, ref.program, parsed.payer)
      .methods.scheduleGroupCcvs({
        ...targetArgs(target),
        outbound: parsed.outbound,
        inbound: parsed.inbound,
        activatesAt: new BN(activatesAt.toString()),
      })
      .accountsStrict({ group: ref.group, authority, ...eventAccounts(ref.program) })
      .remainingAccounts(t.metas)
      .instruction()
    const pending = t.sections.security.pending
    const replaced =
      pending && toBigInt(pending.activatesAt) > t.now
        ? [
            {
              operation:
                target.policyId === undefined ? 'syncPoolGroupCCVs' : 'syncPoolGroupPolicyCCVs',
              reason: `the schedule replaces the pending set of epoch ${toBigInt(pending.epoch)} (activating at ${toBigInt(pending.activatesAt)}): lanes that copied it must re-sync`,
              inputs: {
                ...(target.policyId !== undefined && { policyId: target.policyId }),
                ...(target.selector !== undefined && { remoteChainSelector: target.selector }),
              },
            },
          ]
        : []
    return {
      group: ref.group,
      items: [single(ix, t.group.owner, authority)],
      // lanes that have not copied the new set fail closed from its activation: reported, synced;
      // a lane that cannot be read is refused (M2)
      judge: { failsClosedSeverity: 'warning', unreadableSeverity: 'error' },
      expected: { ...securityExpected(target, t), 'group.minCcvActivationDelay': earliest - t.now },
      extra: { activatesAt },
      followUps: (judgement): PoolGroupFollowUp[] => [
        ...replaced,
        ...syncFollowUps(target)(judgement),
      ],
    }
  }

  /** The exact set and time a proposal schedules. */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedSchedule {
    const [one] = decodeOne(this.name, instructions, ['scheduleGroupCcvs'])
    return {
      ...proposalBase(ref, one!.ix.keys[1]!.pubkey, guardOptions),
      target: targetOf(one!.data),
      outbound: ccvListOf(one!.data, 'outbound'),
      inbound: ccvListOf(one!.data, 'inbound'),
      activatesAt: bigField(field(one!.data, 'params', 'activatesAt')) ?? 0n,
      approvalWindow: 0,
    }
  }
}

type ParsedActivate = ParsedGroupWrite & {
  target: Target
  outbound: PublicKey[]
  inbound: PublicKey[]
}

/** Activates a CCV set at once (emergency, owner only). */
export class ActivatePoolGroupCCVsNow extends PoolGroupWriteOperation<
  ActivatePoolGroupCCVsNowParams,
  ParsedActivate
> {
  readonly name = 'activatePoolGroupCCVsNow'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(
    params: SolanaGenerateParams<ActivatePoolGroupCCVsNowParams>,
  ): ParsedActivate {
    return {
      ...parseGroupWrite(this.name, params),
      target: parseTarget(this.name, params),
      outbound: parseCcvList(this.name, 'outbound', params.outbound),
      inbound: parseCcvList(this.name, 'inbound', params.inbound),
    }
  }

  /**
   * `activate_group_ccvs_now`. Lanes not synced at once fail closed until they are: reported as
   * warnings, with the syncs in `followUps`.
   * @throws {@link CCTParamsInvalidError} if `authority` is not the owner, or a list drops the
   *   defaults (F2)
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedActivate,
  ): Promise<PoolGroupWritePlan<object>> {
    const { ref, authority, target } = parsed
    const t = await readTarget(this.name, chain, ref, target)
    requireOwner(this.name, t.group.owner, authority, 'activate_group_ccvs_now')
    requireDefaultsKept(this.name, t.sections, parsed)
    const ix = await createPoolGroupProgram(chain, ref.program, parsed.payer)
      .methods.activateGroupCcvsNow({
        ...targetArgs(target),
        outbound: parsed.outbound,
        inbound: parsed.inbound,
      })
      .accountsStrict({ group: ref.group, authority, ...eventAccounts(ref.program) })
      .remainingAccounts(t.metas)
      .instruction()
    return {
      group: ref.group,
      items: [single(ix, t.group.owner, authority)],
      // the emergency swap only closes lanes (every copy goes out of epoch): it never waits on lane
      // listings or reads, which are reported instead (S4 review M4)
      judge: {
        failsClosedSeverity: 'warning',
        unreadableSeverity: 'warning',
        goingLiveSeverity: 'warning',
        bestEffort: true,
      },
      expected: securityExpected(target, t),
      extra: {},
      followUps: (judgement): PoolGroupFollowUp[] => [
        ...syncFollowUps(target)(judgement),
        ...(judgement?.unlisted ? activateUnlistedFollowUps(target, t, judgement.unlisted) : []),
        {
          operation: 'checkMultiTokenPoolLane',
          reason:
            'the new set applies at once: messages in flight were verified under the old set and may fail to execute until the CCVs of the new set attest them',
          inputs: {
            ...(target.selector !== undefined && { remoteChainSelector: target.selector }),
          },
        },
      ],
    }
  }

  /** The exact set a proposal activates. */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedActivate {
    const [one] = decodeOne(this.name, instructions, ['activateGroupCcvsNow'])
    return {
      ...proposalBase(ref, one!.ix.keys[1]!.pubkey, guardOptions),
      target: targetOf(one!.data),
      outbound: ccvListOf(one!.data, 'outbound'),
      inbound: ccvListOf(one!.data, 'inbound'),
    }
  }
}

// ─── settings: allow dropping the defaults, reset a named policy ─────────────────────────────

type ParsedAllowDropping = ParsedGroupWrite & { target: Target; allow: boolean }

/** Allows or forbids dropping the lane defaults in later schedules (owner only). */
export class SetPoolGroupAllowDroppingDefaultCCVs extends PoolGroupWriteOperation<
  SetPoolGroupAllowDroppingDefaultCCVsParams,
  ParsedAllowDropping
> {
  readonly name = 'setPoolGroupAllowDroppingDefaultCCVs'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(
    params: SolanaGenerateParams<SetPoolGroupAllowDroppingDefaultCCVsParams>,
  ): ParsedAllowDropping {
    if (typeof params.allow !== 'boolean')
      throw new CCTParamsInvalidError(this.name, 'allow', 'must be a boolean')
    return {
      ...parseGroupWrite(this.name, params),
      target: parseTarget(this.name, params),
      allow: params.allow,
    }
  }

  /**
   * `set_allow_dropping_default_ccvs`. Nothing is built when the target already holds the flag.
   * @throws {@link CCTParamsInvalidError} if `authority` is not the owner, or the target is a chain
   *   record that still inherits SECURITY (SecurityInheritsDefault)
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedAllowDropping,
  ): Promise<PoolGroupWritePlan<object>> {
    const { ref, authority, target } = parsed
    const t = await readTarget(this.name, chain, ref, target)
    requireOwner(this.name, t.group.owner, authority, 'set_allow_dropping_default_ccvs')
    if (t.inherits)
      throw new CCTParamsInvalidError(
        this.name,
        'remoteChainSelector',
        `the record ${targetName(target)} still inherits SECURITY from its default (SecurityInheritsDefault): set it on the default, or detach the record with a targeted schedule first`,
      )
    const expected = securityExpected(target, t)
    if (t.sections.security.allowDroppingDefaultCcvs === parsed.allow)
      return { group: ref.group, items: [], judge: null, expected, extra: {} }
    const ix = await createPoolGroupProgram(chain, ref.program, parsed.payer)
      .methods.setAllowDroppingDefaultCcvs({ ...targetArgs(target), allow: parsed.allow })
      .accountsStrict({ group: ref.group, authority, ...eventAccounts(ref.program) })
      .remainingAccounts(t.metas)
      .instruction()
    return {
      group: ref.group,
      items: [single(ix, t.group.owner, authority)],
      judge: { failsClosedSeverity: 'error' },
      expected,
      extra: {},
    }
  }

  /** The exact flag a proposal sets. */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedAllowDropping {
    const [one] = decodeOne(this.name, instructions, ['setAllowDroppingDefaultCcvs'])
    return {
      ...proposalBase(ref, one!.ix.keys[1]!.pubkey, guardOptions),
      target: targetOf(one!.data),
      allow: field(one!.data, 'params', 'allow') === true,
    }
  }
}

type ParsedReset = ParsedGroupWrite & { policyId: number }

/** Resets a named SECURITY policy after an ownership acceptance (owner only). */
export class ResetPoolGroupPolicySecurity extends PoolGroupWriteOperation<
  ResetPoolGroupPolicySecurityParams,
  ParsedReset
> {
  readonly name = 'resetPoolGroupPolicySecurity'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(
    params: SolanaGenerateParams<ResetPoolGroupPolicySecurityParams>,
  ): ParsedReset {
    validateInteger(this.name, 'policyId', params.policyId, 0, 0xffff_ffff)
    return { ...parseGroupWrite(this.name, params), policyId: Number(params.policyId) }
  }

  /**
   * `reset_policy_security` with the `Policy` and all its records (writable). Lanes that synced a
   * cancelled pending set fail closed from its time: reported, with the re-syncs in `followUps`; a
   * lane the stale generation held closed may go live, so it runs the make-live check.
   * @throws {@link CCTParamsInvalidError} if `authority` is not the owner, or the policy does not
   *   exist or carry SECURITY
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedReset,
  ): Promise<PoolGroupWritePlan<object>> {
    const { ref, authority, policyId } = parsed
    const t = await readTarget(this.name, chain, ref, { policyId })
    requireOwner(this.name, t.group.owner, authority, 'reset_policy_security')
    const ix = await createPoolGroupProgram(chain, ref.program, parsed.payer)
      .methods.resetPolicySecurity({ policyId })
      .accountsStrict({ group: ref.group, authority, ...eventAccounts(ref.program) })
      .remainingAccounts(t.metas)
      .instruction()
    return {
      group: ref.group,
      items: [single(ix, t.group.owner, authority)],
      // reset re-opens lanes held closed: one that cannot be read is refused, never opened (M2)
      judge: { failsClosedSeverity: 'warning', unreadableSeverity: 'error' },
      expected: {
        ...securityExpected({ policyId }, t),
        'group.securityGeneration': t.group.securityGeneration,
        [`policy.${policyId}.records`]: t.metas.slice(1).map((m) => m.pubkey.toBase58()),
      },
      extra: {},
      followUps: syncFollowUps({ policyId }),
    }
  }

  /** The policy a proposal resets. */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedReset {
    const [one] = decodeOne(this.name, instructions, ['resetPolicySecurity'])
    return {
      ...proposalBase(ref, one!.ix.keys[1]!.pubkey, guardOptions),
      policyId: Number(bigField(field(one!.data, 'params', 'policyId')) ?? -1),
    }
  }
}

// ─── syncs ───────────────────────────────────────────────────────────────────────────────────

type ParsedSync = ParsedGroupWrite & {
  selector: bigint
  policyId?: number
  /** The lanes, by mint (or, from a proposal, by pool `State`); none: every unsynced lane. */
  lanes?: { mints: PublicKey[] } | { states: PublicKey[] }
}

/** The mints of pool `State`s a proposal names (owner-checked). */
async function mintsOfStates(
  operation: string,
  chain: SolanaChain,
  program: PublicKey,
  states: readonly PublicKey[],
): Promise<PublicKey[]> {
  const infos = await getMultipleAccountsInfoPaged(chain.connection, [...states])
  return states.map((address, i) => {
    const info = infos[i]
    const pool = info ? poolState(address, info, `the pool State ${address.toBase58()}`) : null
    if (!pool || isUnread(pool) || !info?.owner.equals(program))
      throw new CCTParamsInvalidError(
        operation,
        'transactions',
        `${address.toBase58()} is not a pool State of ${program.toBase58()}`,
      )
    return pool.state.mint
  })
}

/**
 * Shared base of the two syncs: the lanes whose SECURITY is the record's (the group default for
 * `sync_group_ccvs`, the named policy's slot for `sync_policy_ccvs`), each with its `State`,
 * `ChainConfigV2` and pool owner (rent receiver); unsynced lanes only, unless named.
 */
abstract class SyncCCVs<P extends SyncPoolGroupCCVsParams> extends PoolGroupWriteOperation<
  P,
  ParsedSync
> {
  protected abstract readonly ixName: 'syncGroupCcvs' | 'syncPolicyCcvs'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(params: SolanaGenerateParams<P>): ParsedSync {
    const mints = parseTokenAddresses(this.name, params.tokenAddresses)
    const policyId: unknown = Reflect.get(params, 'policyId')
    if (this.ixName === 'syncPolicyCcvs')
      validateInteger(this.name, 'policyId', policyId, 0, 0xffff_ffff)
    return {
      ...parseGroupWrite(this.name, params),
      selector: validateSelector(this.name, 'remoteChainSelector', params.remoteChainSelector),
      ...(this.ixName === 'syncPolicyCcvs' && { policyId: Number(policyId) }),
      ...(mints && { lanes: { mints } }),
    }
  }

  /**
   * The sync instructions, as many lanes per instruction as fit. Nothing is built when every lane
   * is synced. A lane failing closed for want of the copy goes live: the make-live check runs on it.
   * @throws {@link CCTParamsInvalidError} if a named lane does not take SECURITY from the record,
   *   the record is missing, or a lane it makes live fails the lane check
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedSync,
  ): Promise<PoolGroupWritePlan<object>> {
    const { ref, authority, selector } = parsed
    const { group } = await readPoolGroup(this.name, chain, ref)
    const policy =
      parsed.policyId === undefined
        ? undefined
        : poolGroupPdas.policy(ref.program, ref.group, parsed.policyId)
    const record = policy
      ? poolGroupPdas.policyChain(ref.program, policy, selector)
      : poolGroupPdas.groupChain(ref.program, ref.group, selector)
    const [recordInfo] = await getMultipleAccountsInfoPaged(chain.connection, [record])
    if (!recordInfo)
      throw new CCTParamsInvalidError(
        this.name,
        'remoteChainSelector',
        policy
          ? `policy ${parsed.policyId} has no record for chain ${selector} (PolicyRecordMissing)`
          : `the pool group has no chain record for ${selector}`,
      )
    const named = parsed.lanes
    const mints = named
      ? 'mints' in named
        ? named.mints
        : await mintsOfStates(this.name, chain, ref.program, named.states)
      : undefined
    const requests = mints
      ? mints.map((mint) => ({ mint, selector }))
      : await listPoolGroupLaneRequests(
          this.name,
          chain,
          { program: ref.program, group: ref.group, selector },
          {
            fix: 'listing the lanes to sync needs it; pass tokenAddresses, or use an RPC that serves getProgramAccounts',
          },
        )
    const states = await readPoolGroupLaneStates(chain, ref.program, requests)
    const lanes: { mint: PublicKey; synced: boolean }[] = []
    const excluded = new Set((parsed.excludedLanes ?? []).map((l) => l.tokenAddress))
    // a listed lane that cannot be read is reported, never skipped silently (S4 review M5)
    const findings: MultiTokenPoolLaneFinding[] = []
    requests.forEach(({ mint }, i) => {
      const s = states[i]
      const where = `the lane of ${mint.toBase58()} toward ${selector}`
      if (excluded.has(mint.toBase58())) return
      if (!s || isUnread(s)) {
        if (mints)
          throw new CCTParamsInvalidError(
            this.name,
            'tokenAddresses',
            `${where} cannot be read${s ? ` (${s.reason})` : ': it does not exist'}`,
          )
        if (s)
          findings.push({
            check: 'LANE_UNREADABLE',
            severity: 'warning',
            tokenAddress: mint.toBase58(),
            remoteChainSelector: selector,
            reason: `${where} cannot be read (${s.reason}), so it is not synced: check it with getPoolGroupLane`,
          })
        return
      }
      const source =
        s.ext?.poolGroupAddress === ref.group.toBase58() ? s.ext.classSource.security : undefined
      const ours = policy
        ? source?.kind === 'policy' && s.named.get(source.slot)?.policy.equals(policy)
        : source?.kind === 'default'
      if (!ours) {
        if (mints)
          throw new CCTParamsInvalidError(
            this.name,
            'tokenAddresses',
            `${where} does not take SECURITY from ${policy ? `policy ${parsed.policyId}` : "the pool group's chain record"} (InvalidInputs)`,
          )
        return
      }
      const sync = laneCcvSync(s)
      const synced = !!sync && !isUnread(sync) && sync.synced && sync.failsClosedAt === undefined
      if (mints || !synced) lanes.push({ mint, synced })
    })
    const expected = {
      [`lanes.${selector}.ccvSync`]: lanes.map((l) => [l.mint.toBase58(), l.synced]),
    }
    if (!lanes.length)
      return { group: ref.group, items: [], judge: null, expected, extra: {}, findings }
    const stateAddresses = lanes.map((l) => deriveTokenPoolConfigPda(ref.program, l.mint))
    const stateInfos = await getMultipleAccountsInfoPaged(chain.connection, stateAddresses)
    const entries = lanes.map((l, i) => {
      const info = stateInfos[i]
      const pool = info
        ? poolState(stateAddresses[i]!, info, `the pool State of ${l.mint.toBase58()}`)
        : null
      if (!pool || isUnread(pool))
        throw new CCTParamsInvalidError(
          this.name,
          'tokenAddresses',
          `${l.mint.toBase58()} has no pool State`,
        )
      return {
        mint: l.mint,
        metas: [
          { pubkey: stateAddresses[i]!, isSigner: false, isWritable: false },
          {
            pubkey: deriveTokenPoolChainConfigV2Pda(ref.program, selector, l.mint),
            isSigner: false,
            isWritable: true,
          },
          // the pool owner receives the rent a shrinking copy frees
          { pubkey: pool.state.owner, isSigner: false, isWritable: true },
        ] satisfies AccountMeta[],
      }
    })
    const client = createPoolGroupProgram(chain, ref.program, parsed.payer)
    const build = (chunk: typeof entries) => {
      const metas = chunk.flatMap((e) => e.metas)
      const common = {
        group: ref.group,
        payer: authority,
        systemProgram: SystemProgram.programId,
        ...eventAccounts(ref.program),
      }
      return this.ixName === 'syncGroupCcvs'
        ? client.methods
            .syncGroupCcvs({ remoteChainSelector: new BN(selector.toString()) })
            .accountsStrict({ ...common, groupChainPolicy: record })
            .remainingAccounts(metas)
            .instruction()
        : client.methods
            .syncPolicyCcvs({
              policyId: parsed.policyId!,
              remoteChainSelector: new BN(selector.toString()),
            })
            .accountsStrict({ ...common, policyChainRecord: record })
            .remainingAccounts(metas)
            .instruction()
    }
    const items = await fittedItems(this.name, chain, parsed, entries, build, {
      signerRoles: {
        [authority.toBase58()]: authority.equals(parsed.payer)
          ? 'payer'
          : signerRole(group.owner, authority),
      },
      tokenAddressesOf: (chunk) => chunk.map((e) => e.mint.toBase58()),
      describe: (e) => `the lane of ${e.mint.toBase58()}`,
    })
    return {
      group: ref.group,
      items,
      judge: { failsClosedSeverity: 'error' },
      judgeEach: true,
      expected,
      extra: {},
      findings,
      // each lane syncs alone: one the lane check refuses is left out, the others are built (M5)
      partition: {
        operation: this.name,
        inputs: (left) => ({
          remoteChainSelector: selector,
          ...(parsed.policyId !== undefined && { policyId: parsed.policyId }),
          tokenAddresses: left.map((l) => l.tokenAddress),
        }),
      },
    }
  }

  /** The lanes a proposal syncs, by pool `State`. */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedSync {
    const ixs = decodeOne(this.name, instructions, [this.ixName], false)
    const first = ixs[0]!
    const policyId = bigField(field(first.data, 'params', 'policyId'))
    return {
      ...proposalBase(ref, first.ix.keys[2]!.pubkey, guardOptions),
      selector: bigField(field(first.data, 'params', 'remoteChainSelector')) ?? 0n,
      ...(policyId !== undefined && { policyId: Number(policyId) }),
      // after the 6 fixed accounts, per lane: State, ChainConfigV2, pool owner
      lanes: {
        states: ixs.flatMap(({ ix }) =>
          ix.keys
            .slice(6)
            .filter((_, i) => i % 3 === 0)
            .map((k) => k.pubkey),
        ),
      },
    }
  }
}

/** Copies the group chain record's CCV set into its lanes (permissionless). */
export class SyncPoolGroupCCVs extends SyncCCVs<SyncPoolGroupCCVsParams> {
  readonly name = 'syncPoolGroupCCVs'
  protected readonly ixName = 'syncGroupCcvs'
}

/** Copies a named policy chain record's CCV set into its lanes (permissionless). */
export class SyncPoolGroupPolicyCCVs extends SyncCCVs<SyncPoolGroupPolicyCCVsParams> {
  readonly name = 'syncPoolGroupPolicyCCVs'
  protected readonly ixName = 'syncPolicyCcvs'
}

/** The SECURITY ops, by name: the snapshot check runs their re-checks. @internal */
export const POOL_GROUP_SECURITY_OPERATIONS = {
  schedulePoolGroupCCVs: new SchedulePoolGroupCCVs(),
  activatePoolGroupCCVsNow: new ActivatePoolGroupCCVsNow(),
  setPoolGroupAllowDroppingDefaultCCVs: new SetPoolGroupAllowDroppingDefaultCCVs(),
  resetPoolGroupPolicySecurity: new ResetPoolGroupPolicySecurity(),
  syncPoolGroupCCVs: new SyncPoolGroupCCVs(),
  syncPoolGroupPolicyCCVs: new SyncPoolGroupPolicyCCVs(),
} as const
