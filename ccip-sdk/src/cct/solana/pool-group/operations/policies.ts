/**
 * Named pool-group policies and lane assignments (S3b): `create_policy`, `close_policy`,
 * `init_policy_chain_record`, `close_policy_chain_record`, `edit_policy_chain_record`,
 * `set_policy_default`, `assign_lane_policies`, `reset_lane_buckets`. Program of record:
 * chainlink-ccip-solana 7558722, `burnmint-token-pool/src/instructions/groups/policies.rs`,
 * `assign.rs` and `lanes.rs:634-743`.
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
import {
  deriveTokenPoolChainConfigOverridePda,
  deriveTokenPoolChainConfigV2Pda,
} from '../../../../solana/token-pool.ts'
import { getMultipleAccountsInfoPaged } from '../../../../solana/utils.ts'
import { CCTParamsInvalidError, CCTStateChangedError } from '../../../errors.ts'
import { decodeRemoteAddress } from '../../../remote-address.ts'
import type { SolanaGenerateParams } from '../../operation.ts'
import {
  deriveTokenPoolChainConfigPda,
  deriveTokenPoolConfigPda,
} from '../../programs/token-pool.ts'
import { parsePublicKey, validateInteger } from '../../validate.ts'
import { MAX_POOL_GROUP_CHAINS, poolGroupPdas } from '../accounts.ts'
import { decodeClassBits, decodeRoles, decodeSections, keyOrNull, toBigInt } from '../decode.ts'
import { isUnread } from '../lane.ts'
import { createPoolGroupProgram } from '../program.ts'
import { poolState } from '../remote-lane.ts'
import {
  type SectionWrite,
  assertDefaultPoolsFit,
  classBit,
  exactSection,
  parseSectionUpdate,
  sectionArg,
  sectionClass,
  sectionJudge,
  sectionValue,
} from '../sections.ts'
import { type PoolGroupPolicyClass, POOL_GROUP_POLICY_CLASSES } from '../types.ts'
import { type PoolGroupWritePlan, PoolGroupWriteOperation } from '../write-operation.ts'
import type {
  AssignPoolGroupLanePoliciesParams,
  ClosePoolGroupPolicyParams,
  CreatePoolGroupPolicyParams,
  CreatePoolGroupPolicyResult,
  EditPoolGroupPolicyChainRecordParams,
  PoolGroupClassSourceInput,
  PoolGroupClassSourceInputEntry,
  PoolGroupGuardOptions,
  PoolGroupPolicyChainParams,
  ResetPoolGroupLaneBucketsParams,
  SetPoolGroupPolicyDefaultParams,
} from '../write-types.ts'
import {
  type ParsedPoolGroupRef,
  decodeOwned,
  parseTokenAddresses,
  readPoolGroup,
  validateSelector,
} from './common.ts'
import { readPoolGroupLaneStates } from './lane.ts'
import {
  type ParsedGroupWrite,
  bigField,
  decodeOne,
  eventAccounts,
  field,
  fittedItems,
  keyField,
  laneItems,
  parseGroupWrite,
  proposalBase,
  requireClassWriter,
  requirePolicyManager,
  signerRole,
} from './write-common.ts'

/** `MAX_NAMED_POLICY_SLOTS` (groups.rs:50). */
const MAX_NAMED_POLICY_SLOTS = 4
/** `CLASS_SOURCE_*` (groups.rs:107-111). */
const SOURCE_INLINE = 0
const SOURCE_DEFAULT = 1
const SOURCE_FIRST_NAMED = 2

const u32 = (data: unknown, name: string) => Number(bigField(field(data, 'params', name)) ?? -1)

type ParsedPolicy = ParsedGroupWrite & { policyId: number }

/** Parses the shared fields and a policy id. */
function parsePolicyWrite(
  operation: string,
  params: SolanaGenerateParams<ClosePoolGroupPolicyParams>,
): ParsedPolicy {
  validateInteger(operation, 'policyId', params.policyId, 0, 0xffff_ffff)
  return { ...parseGroupWrite(operation, params), policyId: params.policyId }
}

/** Reads the group and one policy; refuses a policy that does not exist. */
async function readPolicy(
  operation: string,
  chain: SolanaChain,
  ref: ParsedPoolGroupRef,
  policyId: number,
  extra: PublicKey[] = [],
) {
  const address = poolGroupPdas.policy(ref.program, ref.group, policyId)
  const { group, now, extras } = await readPoolGroup(operation, chain, ref, [address, ...extra])
  const info = extras[0]
  if (!info)
    throw new CCTParamsInvalidError(
      operation,
      'policyId',
      `the pool group has no policy ${policyId}`,
    )
  return {
    group,
    now,
    address,
    policy: decodeOwned('policy', info, address, ref.program),
    extras: extras.slice(1),
  }
}

/** The single owner-or-policy-admin item of a write. */
const item = (
  ix: TransactionInstruction,
  owner: PublicKey,
  authority: PublicKey,
  created?: PublicKey,
) => ({
  tokenAddresses: [],
  instructions: [ix],
  ...(created && { createdPdas: [created] }),
  signerRoles: { [authority.toBase58()]: signerRole(owner, authority) },
})

// ─── policies ────────────────────────────────────────────────────────────────────────────────

type ParsedCreatePolicy = ParsedGroupWrite & { classes: number; policyId?: number }

/** Creates a named policy at `nextPolicyId`. */
export class CreatePoolGroupPolicy extends PoolGroupWriteOperation<
  CreatePoolGroupPolicyParams,
  ParsedCreatePolicy,
  CreatePoolGroupPolicyResult
> {
  readonly name = 'createPoolGroupPolicy'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(
    params: SolanaGenerateParams<CreatePoolGroupPolicyParams>,
  ): ParsedCreatePolicy {
    const classes: unknown = params.classes
    if (!Array.isArray(classes) || !classes.length)
      throw new CCTParamsInvalidError(this.name, 'classes', 'must name at least one class')
    let bits = 0
    classes.forEach((c: unknown, i) => {
      const cls = POOL_GROUP_POLICY_CLASSES.find((k) => k === c)
      if (!cls)
        throw new CCTParamsInvalidError(
          this.name,
          `classes[${i}]`,
          `must be one of ${POOL_GROUP_POLICY_CLASSES.join(', ')}`,
        )
      bits |= classBit(cls)
    })
    return { ...parseGroupWrite(this.name, params), classes: bits }
  }

  /**
   * `create_policy` at the group's `nextPolicyId` (sealed: a concurrent creator moves it).
   * @throws {@link CCTParamsInvalidError} if `authority` is not the owner or policy admin
   * @throws {@link CCTStateChangedError} if a proposal's id is no longer `nextPolicyId`
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedCreatePolicy,
  ): Promise<PoolGroupWritePlan<CreatePoolGroupPolicyResult>> {
    const { ref, authority } = parsed
    const { group } = await readPoolGroup(this.name, chain, ref)
    requirePolicyManager(this.name, group, authority, 'create_policy')
    const policyId = parsed.policyId ?? group.nextPolicyId
    if (policyId !== group.nextPolicyId)
      throw new CCTStateChangedError(
        this.name,
        `group.nextPolicyId moved to ${group.nextPolicyId} (the proposal creates ${policyId}): re-plan`,
        {
          context: {
            changed: [
              { path: 'group.nextPolicyId', expected: policyId, actual: group.nextPolicyId },
            ],
          },
        },
      )
    const policy = poolGroupPdas.policy(ref.program, ref.group, policyId)
    const ix = await createPoolGroupProgram(chain, ref.program, parsed.payer)
      .methods.createPolicy({ policyId, classes: parsed.classes })
      .accountsStrict({
        group: ref.group,
        authority,
        policy,
        systemProgram: SystemProgram.programId,
        ...eventAccounts(ref.program),
      })
      .instruction()
    return {
      group: ref.group,
      items: [item(ix, group.owner, authority, policy)],
      // a policy is no lane account; its records come later
      judge: { scope: 'none' },
      expected: { 'group.nextPolicyId': group.nextPolicyId },
      extra: { policyId, policyAddress: policy.toBase58() },
    }
  }

  /** The policy a proposal creates. */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedCreatePolicy {
    const [one] = decodeOne(this.name, instructions, ['createPolicy'])
    return {
      ...proposalBase(ref, one!.ix.keys[1]!.pubkey, guardOptions),
      classes: u32(one!.data, 'classes'),
      policyId: u32(one!.data, 'policyId'),
    }
  }
}

/** Closes a named policy with no chain records. */
export class ClosePoolGroupPolicy extends PoolGroupWriteOperation<
  ClosePoolGroupPolicyParams,
  ParsedPolicy
> {
  readonly name = 'closePoolGroupPolicy'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(
    params: SolanaGenerateParams<ClosePoolGroupPolicyParams>,
  ): ParsedPolicy {
    return parsePolicyWrite(this.name, params)
  }

  /**
   * `close_policy` (rent to the owner).
   * @throws {@link CCTParamsInvalidError} if `authority` is not the owner or policy admin, or the
   *   policy still has chain records
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedPolicy,
  ): Promise<PoolGroupWritePlan<object>> {
    const { ref, authority, policyId } = parsed
    const { group, address, policy } = await readPolicy(this.name, chain, ref, policyId)
    requirePolicyManager(this.name, group, authority, 'close_policy')
    const chains = policy.chainSelectors.map(toBigInt)
    if (chains.length)
      throw new CCTParamsInvalidError(
        this.name,
        'policyId',
        `policy ${policyId} still has records for chains ${chains.join(', ')} (PolicyHasRecords): close them with closePoolGroupPolicyChainRecord first`,
      )
    const ix = await createPoolGroupProgram(chain, ref.program, parsed.payer)
      .methods.closePolicy({ policyId })
      .accountsStrict({
        group: ref.group,
        policy: address,
        authority,
        rentReceiver: group.owner,
        ...eventAccounts(ref.program),
      })
      .instruction()
    return {
      group: ref.group,
      items: [item(ix, group.owner, authority)],
      judge: { scope: 'none' },
      expected: {
        [`policy.${policyId}.chainSelectors`]: chains,
        'group.owner': group.owner.toBase58(),
      },
      extra: {},
    }
  }

  /** The policy a proposal closes. */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedPolicy {
    const [one] = decodeOne(this.name, instructions, ['closePolicy'])
    return {
      ...proposalBase(ref, one!.ix.keys[2]!.pubkey, guardOptions),
      policyId: u32(one!.data, 'policyId'),
    }
  }
}

// ─── policy chain records ────────────────────────────────────────────────────────────────────

type ParsedPolicyChain = ParsedPolicy & { selector: bigint }

/** Parses the shared fields, a policy id and a chain. */
function parsePolicyChainWrite(
  operation: string,
  params: SolanaGenerateParams<PoolGroupPolicyChainParams>,
): ParsedPolicyChain {
  return {
    ...parsePolicyWrite(operation, params),
    selector: validateSelector(operation, 'remoteChainSelector', params.remoteChainSelector),
  }
}

/** A proposal's policy and chain. */
const policyChainOf = (data: unknown) => ({
  policyId: u32(data, 'policyId'),
  selector: bigField(field(data, 'params', 'remoteChainSelector')) ?? 0n,
})

/** Creates a policy's record for one of the group's chains. */
export class InitPoolGroupPolicyChainRecord extends PoolGroupWriteOperation<
  PoolGroupPolicyChainParams,
  ParsedPolicyChain
> {
  readonly name = 'initPoolGroupPolicyChainRecord'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(
    params: SolanaGenerateParams<PoolGroupPolicyChainParams>,
  ): ParsedPolicyChain {
    return parsePolicyChainWrite(this.name, params)
  }

  /**
   * `init_policy_chain_record` (a copy of the policy default, following it).
   * @throws {@link CCTParamsInvalidError} if `authority` is not the owner or policy admin, the group
   *   lacks the chain, the record exists, or the default fee is above the cap
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedPolicyChain,
  ): Promise<PoolGroupWritePlan<object>> {
    const { ref, authority, policyId, selector } = parsed
    const { group, address, policy } = await readPolicy(this.name, chain, ref, policyId)
    requirePolicyManager(this.name, group, authority, 'init_policy_chain_record')
    if (!group.chainSelectors.some((c) => toBigInt(c) === selector))
      throw new CCTParamsInvalidError(
        this.name,
        'remoteChainSelector',
        `the pool group has no chain record for ${selector} (UnknownGroupChain): add it with addPoolGroupChain`,
      )
    const chains = policy.chainSelectors.map(toBigInt)
    if (chains.includes(selector))
      throw new CCTParamsInvalidError(
        this.name,
        'remoteChainSelector',
        `policy ${policyId} already has a record for chain ${selector}`,
      )
    if (chains.length >= MAX_POOL_GROUP_CHAINS)
      throw new CCTParamsInvalidError(
        this.name,
        'remoteChainSelector',
        `policy ${policyId} has ${chains.length} chain records, the most it can (TooManyPolicyChains)`,
      )
    if ((policy.classes & classBit('fee')) !== 0) {
      const fee = policy.defaultPolicy.fee.tokenTransferFeeConfig
      const bps = Math.max(fee.finalityBpsFee, fee.fastFinalityBpsFee)
      if (bps > group.maxBpsFee)
        throw new CCTParamsInvalidError(
          this.name,
          'policyId',
          `policy ${policyId}'s default FEE charges ${bps} bps, above the cap of ${group.maxBpsFee} (BpsFeeAboveGroupMax): lower it with setPoolGroupPolicyDefault first`,
        )
    }
    const record = poolGroupPdas.policyChain(ref.program, address, selector)
    const ix = await createPoolGroupProgram(chain, ref.program, parsed.payer)
      .methods.initPolicyChainRecord({ policyId, remoteChainSelector: new BN(selector.toString()) })
      .accountsStrict({
        group: ref.group,
        policy: address,
        authority,
        policyChainRecord: record,
        systemProgram: SystemProgram.programId,
        ...eventAccounts(ref.program),
      })
      .instruction()
    return {
      group: ref.group,
      items: [item(ix, group.owner, authority, record)],
      // a new record: no lane references it yet (assignments need it to exist)
      judge: { scope: 'none' },
      expected: {
        [`policy.${policyId}.chainSelectors`]: chains,
        'group.chainSelectors': group.chainSelectors.map(toBigInt),
      },
      extra: {},
    }
  }

  /** The record a proposal creates. */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedPolicyChain {
    const [one] = decodeOne(this.name, instructions, ['initPolicyChainRecord'])
    return {
      ...proposalBase(ref, one!.ix.keys[2]!.pubkey, guardOptions),
      ...policyChainOf(one!.data),
    }
  }
}

/** Closes a policy chain record no lane references. */
export class ClosePoolGroupPolicyChainRecord extends PoolGroupWriteOperation<
  PoolGroupPolicyChainParams,
  ParsedPolicyChain
> {
  readonly name = 'closePoolGroupPolicyChainRecord'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(
    params: SolanaGenerateParams<PoolGroupPolicyChainParams>,
  ): ParsedPolicyChain {
    return parsePolicyChainWrite(this.name, params)
  }

  /**
   * `close_policy_chain_record` (rent to the owner).
   * @throws {@link CCTParamsInvalidError} if `authority` is not the owner or policy admin, the
   *   record does not exist, or lanes reference it
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedPolicyChain,
  ): Promise<PoolGroupWritePlan<object>> {
    const { ref, authority, policyId, selector } = parsed
    const recordAddress = poolGroupPdas.policyChain(
      ref.program,
      poolGroupPdas.policy(ref.program, ref.group, policyId),
      selector,
    )
    const { group, address, extras } = await readPolicy(this.name, chain, ref, policyId, [
      recordAddress,
    ])
    requirePolicyManager(this.name, group, authority, 'close_policy_chain_record')
    if (!extras[0])
      throw new CCTParamsInvalidError(
        this.name,
        'remoteChainSelector',
        `policy ${policyId} has no record for chain ${selector}`,
      )
    const record = decodeOwned('policyChainRecord', extras[0], recordAddress, ref.program)
    if (record.laneRefCount !== 0)
      throw new CCTParamsInvalidError(
        this.name,
        'remoteChainSelector',
        `${record.laneRefCount} lane(s) still take classes from the record (PolicyInUse): reassign them with assignPoolGroupLanePolicies first`,
      )
    const ix = await createPoolGroupProgram(chain, ref.program, parsed.payer)
      .methods.closePolicyChainRecord({
        policyId,
        remoteChainSelector: new BN(selector.toString()),
      })
      .accountsStrict({
        group: ref.group,
        policy: address,
        policyChainRecord: recordAddress,
        authority,
        rentReceiver: group.owner,
        ...eventAccounts(ref.program),
      })
      .instruction()
    return {
      group: ref.group,
      items: [item(ix, group.owner, authority)],
      // the program closes it only with no lane references: no lane reads it
      judge: { scope: 'none' },
      expected: {
        [`policyChainRecord.${policyId}.${selector}.laneRefCount`]: record.laneRefCount,
        'group.owner': group.owner.toBase58(),
      },
      extra: {},
    }
  }

  /** The record a proposal closes. */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedPolicyChain {
    const [one] = decodeOne(this.name, instructions, ['closePolicyChainRecord'])
    return {
      ...proposalBase(ref, one!.ix.keys[3]!.pubkey, guardOptions),
      ...policyChainOf(one!.data),
    }
  }
}

type ParsedPolicySection = ParsedPolicyChain & { section: SectionWrite; detach: boolean }

/** Requires the policy to carry the class of a section. */
function requireCarried(operation: string, classes: number, cls: PoolGroupPolicyClass, id: number) {
  if ((classes & classBit(cls)) === 0)
    throw new CCTParamsInvalidError(
      operation,
      'section.policyClass',
      `policy ${id} does not carry ${cls} (PolicyClassNotCarried); it carries ${decodeClassBits(classes).join(', ')}`,
    )
}

/** Writes one class of a policy chain record, merged; detaching from the policy default is explicit. */
export class EditPoolGroupPolicyChainRecord extends PoolGroupWriteOperation<
  EditPoolGroupPolicyChainRecordParams,
  ParsedPolicySection
> {
  readonly name = 'editPoolGroupPolicyChainRecord'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(
    params: SolanaGenerateParams<EditPoolGroupPolicyChainRecordParams>,
  ): ParsedPolicySection {
    const base = parsePolicyChainWrite(this.name, params)
    if (
      params.detachFromPolicyDefault !== undefined &&
      typeof params.detachFromPolicyDefault !== 'boolean'
    )
      throw new CCTParamsInvalidError(this.name, 'detachFromPolicyDefault', 'must be a boolean')
    return {
      ...base,
      section: {
        kind: 'update',
        update: parseSectionUpdate(this.name, params.section, base.selector),
      },
      detach: params.detachFromPolicyDefault === true,
    }
  }

  /**
   * `edit_policy_chain_record` with the section merged over the record's.
   * @throws {@link CCTParamsInvalidError} if `authority` may not write the class, the policy does
   *   not carry it, the class follows the policy default without `detachFromPolicyDefault`, the fee
   *   is above the cap, or a lane guard refuses
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedPolicySection,
  ): Promise<PoolGroupWritePlan<object>> {
    const { ref, authority, policyId, selector, section } = parsed
    const cls = sectionClass(section)
    const recordAddress = poolGroupPdas.policyChain(
      ref.program,
      poolGroupPdas.policy(ref.program, ref.group, policyId),
      selector,
    )
    const { group, address, policy, extras } = await readPolicy(this.name, chain, ref, policyId, [
      recordAddress,
    ])
    requireClassWriter(this.name, group, authority, cls, 'edit_policy_chain_record')
    requireCarried(this.name, policy.classes, cls, policyId)
    if (!extras[0])
      throw new CCTParamsInvalidError(
        this.name,
        'remoteChainSelector',
        `policy ${policyId} has no record for chain ${selector}: create it with initPoolGroupPolicyChainRecord`,
      )
    const record = decodeOwned('policyChainRecord', extras[0], recordAddress, ref.program)
    if ((record.inheritsDefault & classBit(cls)) !== 0 && !parsed.detach)
      throw new CCTParamsInvalidError(
        this.name,
        'detachFromPolicyDefault',
        `the record follows policy ${policyId}'s default for ${cls}: writing it detaches it, so later setPoolGroupPolicyDefault writes no longer reach chain ${selector}. Pass detachFromPolicyDefault: true, or write the policy default`,
      )
    const ix = await createPoolGroupProgram(chain, ref.program, parsed.payer)
      .methods.editPolicyChainRecord({
        policyId,
        remoteChainSelector: new BN(selector.toString()),
        section: sectionArg(this.name, section, record.sections, group.maxBpsFee),
      })
      .accountsStrict({
        group: ref.group,
        policy: address,
        policyChainRecord: recordAddress,
        authority,
        ...eventAccounts(ref.program),
      })
      .instruction()
    return {
      group: ref.group,
      items: [item(ix, group.owner, authority)],
      judge: sectionJudge(section),
      expected: {
        [`policyChainRecord.${policyId}.${selector}.${cls}`]: sectionValue(
          record.sections,
          cls,
          selector,
        ),
        [`policyChainRecord.${policyId}.${selector}.inheritsDefault`]: decodeClassBits(
          record.inheritsDefault,
        ),
        'group.maxBpsFee': group.maxBpsFee,
      },
      extra: {},
    }
  }

  /** The exact section a proposal writes. */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedPolicySection {
    const [one] = decodeOne(this.name, instructions, ['editPolicyChainRecord'])
    return {
      ...proposalBase(ref, one!.ix.keys[3]!.pubkey, guardOptions),
      ...policyChainOf(one!.data),
      section: exactSection(this.name, field(one!.data, 'params', 'section')),
      detach: true,
    }
  }
}

type ParsedPolicyDefault = ParsedPolicy & { section: SectionWrite }

/** Writes one class of a policy default, into every chain record of the policy that follows it. */
export class SetPoolGroupPolicyDefault extends PoolGroupWriteOperation<
  SetPoolGroupPolicyDefaultParams,
  ParsedPolicyDefault
> {
  readonly name = 'setPoolGroupPolicyDefault'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(
    params: SolanaGenerateParams<SetPoolGroupPolicyDefaultParams>,
  ): ParsedPolicyDefault {
    return {
      ...parsePolicyWrite(this.name, params),
      section: { kind: 'update', update: parseSectionUpdate(this.name, params.section, undefined) },
    }
  }

  /**
   * `set_policy_default` with every chain record of the policy (writable).
   * @throws {@link CCTParamsInvalidError} if `authority` may not write the class, the policy does
   *   not carry it, the fee is above the cap, or a lane guard refuses
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedPolicyDefault,
  ): Promise<PoolGroupWritePlan<object>> {
    const { ref, authority, policyId, section } = parsed
    const cls = sectionClass(section)
    const { group, address, policy } = await readPolicy(this.name, chain, ref, policyId)
    requireClassWriter(this.name, group, authority, cls, 'set_policy_default')
    requireCarried(this.name, policy.classes, cls, policyId)
    const records: AccountMeta[] = policy.chainSelectors.map((c) => ({
      pubkey: poolGroupPdas.policyChain(ref.program, address, toBigInt(c)),
      isSigner: false,
      isWritable: true,
    }))
    const infos = await getMultipleAccountsInfoPaged(
      chain.connection,
      records.map((r) => r.pubkey),
    )
    assertDefaultPoolsFit(
      this.name,
      section,
      policy.chainSelectors.map(toBigInt).filter((_, i) => {
        const info = infos[i]
        return (
          !!info &&
          (decodeOwned('policyChainRecord', info, records[i]!.pubkey, ref.program).inheritsDefault &
            classBit(cls)) !==
            0
        )
      }),
    )
    const ix = await createPoolGroupProgram(chain, ref.program, parsed.payer)
      .methods.setPolicyDefault({
        policyId,
        section: sectionArg(this.name, section, policy.defaultPolicy, group.maxBpsFee),
      })
      .accountsStrict({
        group: ref.group,
        policy: address,
        authority,
        ...eventAccounts(ref.program),
      })
      .remainingAccounts(records)
      .instruction()
    return {
      group: ref.group,
      items: [item(ix, group.owner, authority)],
      judge: sectionJudge(section),
      expected: {
        [`policy.${policyId}.defaultPolicy.${cls}`]: sectionValue(
          policy.defaultPolicy,
          cls,
          undefined,
        ),
        [`policy.${policyId}.chainSelectors`]: policy.chainSelectors.map(toBigInt),
        'group.maxBpsFee': group.maxBpsFee,
      },
      extra: {},
    }
  }

  /** The exact section a proposal writes. */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedPolicyDefault {
    const [one] = decodeOne(this.name, instructions, ['setPolicyDefault'])
    return {
      ...proposalBase(ref, one!.ix.keys[2]!.pubkey, guardOptions),
      policyId: u32(one!.data, 'policyId'),
      section: exactSection(this.name, field(one!.data, 'params', 'section')),
    }
  }
}

// ─── lanes: assignments and bucket resets ────────────────────────────────────────────────────

/** The class sources an assignment writes: bytes per class and the slots they use. */
type RawSources = { classSource: number[]; policySlots: PublicKey[] }

type ParsedAssign = ParsedGroupWrite & {
  selector: bigint
  /** The lanes, by mint (or, from a proposal, by pool `State`). */
  lanes: { mints: PublicKey[] } | { states: PublicKey[] }
  sources: { input: PoolGroupClassSourceInput } | { raw: RawSources }
  poolGroupOwner?: PublicKey
}

/** Parses a class-source assignment: every class, each inline, default or a policy id. */
function parseClassSource(operation: string, value: unknown): PoolGroupClassSourceInput {
  if (typeof value !== 'object' || value === null)
    throw new CCTParamsInvalidError(operation, 'classSource', 'must give a source for every class')
  const at = (cls: PoolGroupPolicyClass): PoolGroupClassSourceInputEntry => {
    const v: unknown = Reflect.get(value, cls)
    const kind: unknown = typeof v === 'object' && v !== null ? Reflect.get(v, 'kind') : undefined
    if (kind === 'inline') return { kind: 'inline' }
    if (kind === 'default') return { kind: 'default' }
    if (kind === 'policy') {
      const id: unknown = Reflect.get(Object(v), 'policyId')
      if (typeof id !== 'number' || !Number.isInteger(id) || id < 0 || id > 0xffff_ffff)
        throw new CCTParamsInvalidError(
          operation,
          `classSource.${cls}.policyId`,
          'must be a policy id (u32)',
        )
      return { kind: 'policy', policyId: id }
    }
    throw new CCTParamsInvalidError(
      operation,
      `classSource.${cls}`,
      "must be { kind: 'inline' }, { kind: 'default' } or { kind: 'policy', policyId }",
    )
  }
  return {
    connection: at('connection'),
    fee: at('fee'),
    rateLimit: at('rateLimit'),
    security: at('security'),
  }
}

/** The program's class-source bytes and policy slots of an assignment (distinct policies, in class order). */
function rawSources(
  program: PublicKey,
  group: PublicKey,
  input: PoolGroupClassSourceInput,
): RawSources {
  const ids: number[] = []
  const classSource = POOL_GROUP_POLICY_CLASSES.map((cls) => {
    const s = input[cls]
    if (s.kind === 'inline') return SOURCE_INLINE
    if (s.kind === 'default') return SOURCE_DEFAULT
    if (!ids.includes(s.policyId)) ids.push(s.policyId)
    return SOURCE_FIRST_NAMED + ids.indexOf(s.policyId)
  })
  const policySlots = Array.from({ length: MAX_NAMED_POLICY_SLOTS }, (_, i) =>
    ids[i] === undefined ? PublicKey.default : poolGroupPdas.policy(program, group, ids[i]!),
  )
  return { classSource, policySlots }
}

/** Assigns lanes' classes to inline, the group default or named policies. */
export class AssignPoolGroupLanePolicies extends PoolGroupWriteOperation<
  AssignPoolGroupLanePoliciesParams,
  ParsedAssign
> {
  readonly name = 'assignPoolGroupLanePolicies'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(
    params: SolanaGenerateParams<AssignPoolGroupLanePoliciesParams>,
  ): ParsedAssign {
    const base = parseGroupWrite(this.name, params)
    const mints = parseTokenAddresses(this.name, params.tokenAddresses)
    if (!mints?.length)
      throw new CCTParamsInvalidError(this.name, 'tokenAddresses', 'must name at least one lane')
    return {
      ...base,
      selector: validateSelector(this.name, 'remoteChainSelector', params.remoteChainSelector),
      lanes: { mints },
      sources: { input: parseClassSource(this.name, params.classSource) },
      ...(params.poolGroupOwner !== undefined && {
        poolGroupOwner: parsePublicKey(this.name, 'poolGroupOwner', params.poolGroupOwner),
      }),
    }
  }

  /**
   * `assign_lane_policies`, as many lanes per instruction as one transaction fits. Passes every
   * named record the lanes reference before or after (writable), then per lane its `State`,
   * `ChainConfig`, `ChainConfigV2` and FTF override.
   * @throws {@link CCTParamsInvalidError} if the group's owner is not `expectedOwner` (default
   *   `authority`), `authority` does not own every lane's pool, a lane is not linked to the group,
   *   a policy does not exist, carry its class or have a record for the chain, two multisigs would
   *   have to co-sign, or a lane guard refuses
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedAssign,
  ): Promise<PoolGroupWritePlan<object>> {
    const { ref, authority, selector } = parsed
    const {
      group,
      extras: [gcpInfo],
    } = await readPoolGroup(this.name, chain, { program: ref.program, group: ref.group }, [
      poolGroupPdas.groupChain(ref.program, ref.group, selector),
    ])
    // joining a group hands its owner and admins the lane's CONNECTION trust: refuse a group the
    // caller did not name the owner of
    const expectedOwner = ref.expectedOwner ?? authority
    if (!group.owner.equals(expectedOwner))
      throw new CCTParamsInvalidError(
        this.name,
        'expectedOwner',
        `the pool group is owned by ${group.owner.toBase58()}, not ${expectedOwner.toBase58()}: its owner, policy admin and connection admin can change what these lanes trust. To proceed, pass expectedOwner: ${group.owner.toBase58()}`,
      )
    if (!gcpInfo)
      throw new CCTParamsInvalidError(
        this.name,
        'remoteChainSelector',
        `the pool group has no chain record for ${selector}`,
      )
    const gcpAddress = poolGroupPdas.groupChain(ref.program, ref.group, selector)
    const gcp = decodeOwned('groupChainPolicy', gcpInfo, gcpAddress, ref.program)
    const sources =
      'raw' in parsed.sources
        ? parsed.sources.raw
        : rawSources(ref.program, ref.group, parsed.sources.input)
    // the named policies and their records on this chain: each must carry the classes assigned to it
    const slotRecords = sources.policySlots.map((p) =>
      p.equals(PublicKey.default) ? null : poolGroupPdas.policyChain(ref.program, p, selector),
    )
    const named = sources.policySlots.flatMap((p, slot) =>
      p.equals(PublicKey.default) ? [] : [{ slot, p }],
    )
    const namedInfos = await getMultipleAccountsInfoPaged(chain.connection, [
      ...named.map((n) => n.p),
      ...named.map((n) => slotRecords[n.slot]!),
    ])
    named.forEach(({ slot, p }, i) => {
      const policyInfo = namedInfos[i]
      const recordInfo = namedInfos[named.length + i]
      if (!policyInfo)
        throw new CCTParamsInvalidError(
          this.name,
          'classSource',
          `no policy at ${p.toBase58()} (slot ${slot})`,
        )
      const policy = decodeOwned('policy', policyInfo, p, ref.program)
      if (!recordInfo)
        throw new CCTParamsInvalidError(
          this.name,
          'classSource',
          `policy ${policy.policyId} has no record for chain ${selector} (PolicyRecordMissing): create it with initPoolGroupPolicyChainRecord`,
        )
      POOL_GROUP_POLICY_CLASSES.forEach((cls, ci) => {
        if (sources.classSource[ci] === SOURCE_FIRST_NAMED + slot)
          requireCarried(this.name, policy.classes, cls, policy.policyId)
      })
    })

    // the lanes: linked to this group; their pool's owner is the authority
    const mints =
      'mints' in parsed.lanes
        ? parsed.lanes.mints
        : await mintsOfStates(chain, ref, parsed.lanes.states)
    const states = await readPoolGroupLaneStates(
      chain,
      ref.program,
      mints.map((mint) => ({ mint, selector })),
    )
    const stateInfos = await getMultipleAccountsInfoPaged(
      chain.connection,
      mints.map((m) => deriveTokenPoolConfigPda(ref.program, m)),
    )
    const before = new Set<string>()
    const lanes = mints.map((mint, i) => {
      const where = `the lane of ${mint.toBase58()} toward ${selector}`
      const s = states[i]
      if (!s || isUnread(s))
        throw new CCTParamsInvalidError(
          this.name,
          'tokenAddresses',
          `${where} cannot be read${s ? ` (${s.reason})` : ': it does not exist'}`,
        )
      if (s.ext?.poolGroupAddress !== ref.group.toBase58())
        throw new CCTParamsInvalidError(
          this.name,
          'tokenAddresses',
          `${where} is not linked to this pool group (LaneNotLinkedToGroup): link it first`,
        )
      const info = stateInfos[i]
      const stateAddress = deriveTokenPoolConfigPda(ref.program, mint)
      const pool = info
        ? poolState(stateAddress, info, `the pool State of ${mint.toBase58()}`)
        : null
      if (!pool || isUnread(pool))
        throw new CCTParamsInvalidError(
          this.name,
          'tokenAddresses',
          `${mint.toBase58()} has no pool State`,
        )
      if (!pool.state.owner.equals(authority))
        throw new CCTParamsInvalidError(
          this.name,
          'authority',
          `${authority.toBase58()} does not own the pool of ${mint.toBase58()} (owner ${pool.state.owner.toBase58()}), who signs its assignment`,
        )
      // records the lane references now: their counts move, so they are passed too
      const refs = s.ext.policySlots.flatMap((p) =>
        p ? [poolGroupPdas.policyChain(ref.program, new PublicKey(p), selector).toBase58()] : [],
      )
      for (const r of refs) before.add(r)
      return {
        mint,
        refs,
        ownPools: s.chainConfig.base.remote.poolAddresses.map((p) =>
          decodeRemoteAddress(Buffer.from(p.address), selector),
        ),
        sources: POOL_GROUP_POLICY_CLASSES.map((cls) => s.ext!.classSource[cls]),
        metas: [
          { pubkey: stateAddress, isSigner: false, isWritable: false },
          {
            pubkey: deriveTokenPoolChainConfigPda(ref.program, selector, mint),
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: deriveTokenPoolChainConfigV2Pda(ref.program, selector, mint),
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: deriveTokenPoolChainConfigOverridePda(ref.program, selector, mint),
            isSigner: false,
            isWritable: true,
          },
        ],
      }
    })
    const records = [
      ...new Set([...slotRecords.flatMap((r) => (r ? [r.toBase58()] : [])), ...before]),
    ].map((r) => ({ pubkey: new PublicKey(r), isSigner: false, isWritable: true }))
    const recordInfos = await getMultipleAccountsInfoPaged(
      chain.connection,
      records.map((r) => r.pubkey),
    )

    // the co-signer: the group owner, unless membership is open
    const owner = group.openMembership ? null : (parsed.poolGroupOwner ?? group.owner)
    if (owner && !owner.equals(group.owner))
      throw new CCTParamsInvalidError(
        this.name,
        'poolGroupOwner',
        `the pool group owner is ${group.owner.toBase58()}, who co-signs while membership is closed`,
      )
    if (owner && !owner.equals(authority) && parsed.budget?.executor === 'squads-v4')
      throw new CCTParamsInvalidError(
        this.name,
        'poolGroupOwner',
        'the pool owner and the pool group owner must both sign, and one Squads vault signs for one key: open the membership (setPoolGroupSettings openMembership), or hold both roles in one vault',
      )
    const client = createPoolGroupProgram(chain, ref.program, parsed.payer)
    // each instruction passes the slot records and the records its own lanes reference (S3b m6)
    const slotRecordKeys = slotRecords.flatMap((r) => (r ? [r.toBase58()] : []))
    const build = (chunk: typeof lanes) => {
      const own = [...new Set([...slotRecordKeys, ...chunk.flatMap((l) => l.refs)])].map((r) => ({
        pubkey: new PublicKey(r),
        isSigner: false,
        isWritable: true,
      }))
      return client.methods
        .assignLanePolicies({
          remoteChainSelector: new BN(selector.toString()),
          classSource: sources.classSource,
          policySlots: sources.policySlots,
          recordCount: own.length,
        })
        .accountsStrict({
          group: ref.group,
          groupChainPolicy: gcpAddress,
          groupOwner: owner,
          authority,
          systemProgram: SystemProgram.programId,
          ...eventAccounts(ref.program),
        })
        .remainingAccounts([...own, ...chunk.flatMap((l) => l.metas)])
        .instruction()
    }
    const items = await fittedItems(this.name, chain, parsed, lanes, build, {
      signerRoles: {
        [authority.toBase58()]: 'pool-owner',
        ...(owner && !owner.equals(authority) && { [owner.toBase58()]: 'pool-group-owner' }),
      },
      tokenAddressesOf: (chunk) => chunk.map((l) => l.mint.toBase58()),
      describe: (l) => `the lane of ${l.mint.toBase58()}`,
    })
    const roles = decodeRoles(group.roles)
    // the CONNECTION pools these lanes trust after the assignment: the source it picks (M4)
    const connectionSource = sources.classSource[0]!
    const namedAt = named.findIndex((n) => n.slot === connectionSource - SOURCE_FIRST_NAMED)
    const trusted =
      connectionSource === SOURCE_DEFAULT
        ? decodeSections(gcp.policy, 0n, selector).connection.remotePools.map((p) => p.address)
        : connectionSource >= SOURCE_FIRST_NAMED && namedAt >= 0
          ? decodeSections(
              decodeOwned(
                'policyChainRecord',
                namedInfos[named.length + namedAt]!,
                slotRecords[named[namedAt]!.slot]!,
                ref.program,
              ).sections,
              0n,
              selector,
            ).connection.remotePools.map((p) => p.address)
          : [...new Set(lanes.flatMap((l) => l.ownPools))]
    return {
      group: ref.group,
      items,
      judge: { failsClosedSeverity: 'error' },
      judgeEach: true,
      expected: {
        'group.owner': group.owner.toBase58(),
        'group.openMembership': group.openMembership,
        [`lanes.${selector}.classSources`]: lanes.map((l) => [l.mint.toBase58(), l.sources]),
        [`lanes.${selector}.records`]: records.map((r, i) => [
          r.pubkey.toBase58(),
          !!recordInfos[i],
        ]),
      },
      extra: {
        poolGroupTrust: {
          owner: group.owner.toBase58(),
          policyAdmin: roles.policyAdmin,
          connectionAdmin: roles.connectionAdmin,
          remotePools: [
            {
              remoteChainSelector: selector,
              addresses: trusted,
            },
          ],
        },
      },
    }
  }

  /** The assignment a proposal writes, and its lanes by pool `State`. */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedAssign {
    const ixs = decodeOne(this.name, instructions, ['assignLanePolicies'], false)
    const first = ixs[0]!
    const owner = first.ix.keys[2]!.pubkey
    const raw = field(first.data, 'params', 'classSource')
    const slots = field(first.data, 'params', 'policySlots')
    return {
      ...proposalBase(ref, first.ix.keys[3]!.pubkey, guardOptions),
      selector: bigField(field(first.data, 'params', 'remoteChainSelector')) ?? 0n,
      // per lane, after the 7 fixed accounts and the records: State, ChainConfig, V2, override
      lanes: {
        states: ixs.flatMap(({ ix, data }) =>
          ix.keys
            .slice(7 + u32(data, 'recordCount'))
            .filter((_, i) => i % 4 === 0)
            .map((k) => k.pubkey),
        ),
      },
      sources: {
        raw: {
          classSource: Array.isArray(raw) ? raw.map(Number) : [],
          policySlots: Array.isArray(slots)
            ? slots.map((_, i) =>
                keyField(this.name, first.data, 'params', 'policySlots', String(i)),
              )
            : [],
        },
      },
      ...(!owner.equals(ref.program) && { poolGroupOwner: owner }),
    }
  }
}

/** The mints of pool `State` accounts (a proposal names lanes by them). */
async function mintsOfStates(chain: SolanaChain, ref: ParsedPoolGroupRef, states: PublicKey[]) {
  const infos = await getMultipleAccountsInfoPaged(chain.connection, states)
  return states.map((address, i) => {
    const info = infos[i]
    const pool = info ? poolState(address, info, `the pool State ${address.toBase58()}`) : null
    if (!pool || isUnread(pool) || !pool.program.equals(ref.program))
      throw new CCTParamsInvalidError(
        'assignPoolGroupLanePolicies',
        'transactions',
        `${address.toBase58()} is not a pool State of the program`,
      )
    return pool.state.mint
  })
}

type ParsedReset = ParsedGroupWrite & {
  selector: bigint
  /** The lanes, by mint (or, from a proposal, by `ChainConfigV2`). */
  lanes: { mints: PublicKey[] } | { v2s: PublicKey[] }
  policyId?: number
}

/** Refills lanes' buckets to the capacities of the record they take RATE_LIMIT from. */
export class ResetPoolGroupLaneBuckets extends PoolGroupWriteOperation<
  ResetPoolGroupLaneBucketsParams,
  ParsedReset
> {
  readonly name = 'resetPoolGroupLaneBuckets'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(
    params: SolanaGenerateParams<ResetPoolGroupLaneBucketsParams>,
  ): ParsedReset {
    const base = parseGroupWrite(this.name, params)
    const mints = parseTokenAddresses(this.name, params.tokenAddresses)
    if (!mints?.length)
      throw new CCTParamsInvalidError(this.name, 'tokenAddresses', 'must name at least one lane')
    if (params.policyId !== undefined)
      validateInteger(this.name, 'policyId', params.policyId, 0, 0xffff_ffff)
    return {
      ...base,
      selector: validateSelector(this.name, 'remoteChainSelector', params.remoteChainSelector),
      lanes: { mints },
      ...(params.policyId !== undefined && { policyId: params.policyId }),
    }
  }

  /**
   * `reset_lane_buckets`, as many lanes per instruction as one transaction fits: the named record
   * first when `policyId` is given, then per lane its `ChainConfig`, `ChainConfigV2` and override.
   * @throws {@link CCTParamsInvalidError} if `authority` may not write RATE_LIMIT, a lane is not
   *   linked to the group or does not take RATE_LIMIT from the target record, or the record is
   *   missing or does not carry RATE_LIMIT
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedReset,
  ): Promise<PoolGroupWritePlan<object>> {
    const { ref, authority, selector, policyId } = parsed
    const gcpAddress = poolGroupPdas.groupChain(ref.program, ref.group, selector)
    const policy =
      policyId === undefined ? null : poolGroupPdas.policy(ref.program, ref.group, policyId)
    const record = policy ? poolGroupPdas.policyChain(ref.program, policy, selector) : null
    const {
      group,
      extras: [gcpInfo, recordInfo],
    } = await readPoolGroup(this.name, chain, ref, [gcpAddress, ...(record ? [record] : [])])
    requireClassWriter(this.name, group, authority, 'rateLimit', 'reset_lane_buckets')
    if (!gcpInfo)
      throw new CCTParamsInvalidError(
        this.name,
        'remoteChainSelector',
        `the pool group has no chain record for ${selector}`,
      )
    if (record) {
      if (!recordInfo)
        throw new CCTParamsInvalidError(
          this.name,
          'policyId',
          `policy ${policyId} has no record for chain ${selector} (PolicyRecordMissing)`,
        )
      const decoded = decodeOwned('policyChainRecord', recordInfo, record, ref.program)
      requireCarried(this.name, decoded.classes, 'rateLimit', policyId!)
    }
    const mints =
      'mints' in parsed.lanes
        ? parsed.lanes.mints
        : await mintsOfV2s(chain, ref.program, parsed.lanes.v2s)
    const states = await readPoolGroupLaneStates(
      chain,
      ref.program,
      mints.map((mint) => ({ mint, selector })),
    )
    const lanes = mints.map((mint, i) => {
      const where = `the lane of ${mint.toBase58()} toward ${selector}`
      const s = states[i]
      if (!s || isUnread(s))
        throw new CCTParamsInvalidError(this.name, 'tokenAddresses', `${where} cannot be read`)
      if (s.ext?.poolGroupAddress !== ref.group.toBase58())
        throw new CCTParamsInvalidError(
          this.name,
          'tokenAddresses',
          `${where} is not linked to this pool group`,
        )
      const source = s.ext.classSource.rateLimit
      const fromTarget = policy
        ? source.kind === 'policy' && s.ext.policySlots[source.slot] === policy.toBase58()
        : source.kind === 'default'
      if (!fromTarget)
        throw new CCTParamsInvalidError(
          this.name,
          'tokenAddresses',
          `${where} does not take RATE_LIMIT from ${policy ? `policy ${policyId}` : 'the group default'} (RateLimitNotFromGroup): ${source.kind === 'policy' ? 'pass its policyId' : 'its buckets are its own'}`,
        )
      return {
        mint,
        metas: [
          {
            pubkey: deriveTokenPoolChainConfigPda(ref.program, selector, mint),
            isSigner: false,
            isWritable: true,
          },
          {
            pubkey: deriveTokenPoolChainConfigV2Pda(ref.program, selector, mint),
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: deriveTokenPoolChainConfigOverridePda(ref.program, selector, mint),
            isSigner: false,
            isWritable: true,
          },
        ],
      }
    })
    const client = createPoolGroupProgram(chain, ref.program, parsed.payer)
    const build = (metas: AccountMeta[]) =>
      client.methods
        .resetLaneBuckets({
          remoteChainSelector: new BN(selector.toString()),
          policyId: policyId ?? null,
        })
        .accountsStrict({
          group: ref.group,
          groupChainPolicy: gcpAddress,
          authority,
          ...eventAccounts(ref.program),
        })
        .remainingAccounts([
          ...(record ? [{ pubkey: record, isSigner: false, isWritable: false }] : []),
          ...metas,
        ])
        .instruction()
    const items = await laneItems(this.name, chain, parsed, lanes, build, {
      [authority.toBase58()]: signerRole(group.owner, authority),
    })
    return {
      group: ref.group,
      items,
      // a refill loosens every lane it resets: all are judged
      judge: { failsClosedSeverity: 'error' },
      judgeEach: true,
      expected: {
        [`lanes.${selector}.rateLimitFrom`]: policyId ?? 'default',
        'group.roles.rateLimitAdmin': keyOrNull(group.roles.rateLimitAdmin),
      },
      extra: {},
    }
  }

  /** The lanes a proposal resets, by `ChainConfigV2`. */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedReset {
    const ixs = decodeOne(this.name, instructions, ['resetLaneBuckets'], false)
    const first = ixs[0]!
    const policyRaw = bigField(field(first.data, 'params', 'policyId'))
    const skip = 5 + (policyRaw === undefined ? 0 : 1)
    return {
      ...proposalBase(ref, first.ix.keys[2]!.pubkey, guardOptions),
      selector: bigField(field(first.data, 'params', 'remoteChainSelector')) ?? 0n,
      lanes: {
        v2s: ixs.flatMap(({ ix }) =>
          ix.keys
            .slice(skip)
            .filter((_, i) => i % 3 === 1)
            .map((k) => k.pubkey),
        ),
      },
      ...(policyRaw !== undefined && { policyId: Number(policyRaw) }),
    }
  }
}

/** The mints of `ChainConfigV2` accounts. */
async function mintsOfV2s(chain: SolanaChain, program: PublicKey, v2s: PublicKey[]) {
  const infos = await getMultipleAccountsInfoPaged(chain.connection, v2s)
  return v2s.map((address, i) => {
    const info = infos[i]
    if (!info)
      throw new CCTParamsInvalidError(
        'resetPoolGroupLaneBuckets',
        'transactions',
        `no ChainConfigV2 at ${address.toBase58()}`,
      )
    return decodeOwned('chainConfigV2', info, address, program).mint
  })
}

/** The named-policy and lane ops, by name: the snapshot check runs their re-checks. @internal */
export const POOL_GROUP_POLICY_OPERATIONS = {
  createPoolGroupPolicy: new CreatePoolGroupPolicy(),
  closePoolGroupPolicy: new ClosePoolGroupPolicy(),
  initPoolGroupPolicyChainRecord: new InitPoolGroupPolicyChainRecord(),
  closePoolGroupPolicyChainRecord: new ClosePoolGroupPolicyChainRecord(),
  editPoolGroupPolicyChainRecord: new EditPoolGroupPolicyChainRecord(),
  setPoolGroupPolicyDefault: new SetPoolGroupPolicyDefault(),
  assignPoolGroupLanePolicies: new AssignPoolGroupLanePolicies(),
  resetPoolGroupLaneBuckets: new ResetPoolGroupLaneBuckets(),
}
