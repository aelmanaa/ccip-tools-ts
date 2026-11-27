/**
 * Pool-group chain records and the group default (S3b): `add_group_chain`, `remove_group_chain`,
 * `set_group_chain_policy`, `inherit_group_default`, `set_group_default`. Program of record:
 * chainlink-ccip-solana 7558722, `burnmint-token-pool/src/instructions/groups/chains.rs`.
 *
 * Each op pre-flights `authority` with the program's gate (`can_manage_policies` for the record
 * lifecycle, `can_write_class` for a section), merges a section update over the record's current
 * section, runs the shared write guard on the exact instructions and seals a snapshot.
 *
 * @packageDocumentation
 */

import { BN } from '@coral-xyz/anchor'
import { type TransactionInstruction, PublicKey, SystemProgram } from '@solana/web3.js'

import type { SolanaChain } from '../../../../solana/index.ts'
import { getMultipleAccountsInfoPaged } from '../../../../solana/utils.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import type { SolanaGenerateParams } from '../../operation.ts'
import { MAX_POOL_GROUP_CHAINS, poolGroupPdas } from '../accounts.ts'
import { decodeClassBits, toBigInt } from '../decode.ts'
import { createPoolGroupProgram } from '../program.ts'
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
  AddPoolGroupChainParams,
  InheritPoolGroupDefaultParams,
  PoolGroupFollowUp,
  PoolGroupGuardOptions,
  RemovePoolGroupChainParams,
  SetPoolGroupChainPolicyParams,
  SetPoolGroupDefaultParams,
} from '../write-types.ts'
import { type ParsedPoolGroupRef, decodeOwned, readPoolGroup, validateSelector } from './common.ts'
import {
  type ParsedGroupWrite,
  bigField,
  chainRecordMetas,
  decodeOne,
  eventAccounts,
  field,
  idlPolicyClass,
  parseGroupWrite,
  proposalBase,
  requireClassWriter,
  requirePolicyManager,
  signerRole,
} from './write-common.ts'

/** A proposal's chain selector (`params.remoteChainSelector`). */
const selectorOf = (data: unknown) => bigField(field(data, 'params', 'remoteChainSelector')) ?? 0n

/** Reads the group and one chain record; refuses a chain the group does not have. */
async function readGroupChain(
  operation: string,
  chain: SolanaChain,
  ref: ParsedPoolGroupRef,
  selector: bigint,
) {
  const address = poolGroupPdas.groupChain(ref.program, ref.group, selector)
  const { group, now, extras } = await readPoolGroup(operation, chain, ref, [address])
  const info = extras[0]
  if (!info)
    throw new CCTParamsInvalidError(
      operation,
      'remoteChainSelector',
      `the pool group has no chain record for ${selector}: add it with addPoolGroupChain`,
    )
  return {
    group,
    now,
    address,
    record: decodeOwned('groupChainPolicy', info, address, ref.program),
  }
}

// ─── add / remove ────────────────────────────────────────────────────────────────────────────

type ParsedChain = ParsedGroupWrite & { selector: bigint }

/** Parses the shared fields and the chain selector. */
function parseChainWrite(
  operation: string,
  params: SolanaGenerateParams<AddPoolGroupChainParams>,
): ParsedChain {
  return {
    ...parseGroupWrite(operation, params),
    selector: validateSelector(operation, 'remoteChainSelector', params.remoteChainSelector),
  }
}

/** Adds a chain record (a copy of the default, lanes off). */
export class AddPoolGroupChain extends PoolGroupWriteOperation<
  AddPoolGroupChainParams,
  ParsedChain
> {
  readonly name = 'addPoolGroupChain'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(params: SolanaGenerateParams<AddPoolGroupChainParams>): ParsedChain {
    return parseChainWrite(this.name, params)
  }

  /**
   * `add_group_chain`. A lookup table in `budget.lookupTableAddresses` that holds the group's
   * other chain records gets an extend follow-up.
   * @throws {@link CCTParamsInvalidError} if `authority` is not the owner or policy admin, the
   *   chain exists, or the group has 24 chains
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedChain,
  ): Promise<PoolGroupWritePlan<object>> {
    const { ref, authority, selector } = parsed
    const { group } = await readPoolGroup(this.name, chain, ref)
    requirePolicyManager(this.name, group, authority, 'add_group_chain')
    const selectors = group.chainSelectors.map(toBigInt)
    if (selectors.includes(selector))
      throw new CCTParamsInvalidError(
        this.name,
        'remoteChainSelector',
        `the pool group already has a chain record for ${selector} (GroupChainAlreadyExists)`,
      )
    if (selectors.length >= MAX_POOL_GROUP_CHAINS)
      throw new CCTParamsInvalidError(
        this.name,
        'remoteChainSelector',
        `the pool group has ${selectors.length} chains, the most it can (TooManyGroupChains): remove one first`,
      )
    const record = poolGroupPdas.groupChain(ref.program, ref.group, selector)
    const ix = await createPoolGroupProgram(chain, ref.program, parsed.payer)
      .methods.addGroupChain({ remoteChainSelector: new BN(selector.toString()) })
      .accountsStrict({
        group: ref.group,
        authority,
        groupChainPolicy: record,
        systemProgram: SystemProgram.programId,
        ...eventAccounts(ref.program),
      })
      .instruction()
    // a table that holds the other chain records (for set_group_default) needs the new one too
    const others = new Set(
      chainRecordMetas(ref.program, ref.group, group.chainSelectors).map((m) =>
        m.pubkey.toBase58(),
      ),
    )
    const tables: string[] = []
    for (const table of parsed.budget?.lookupTableAddresses ?? []) {
      const { value } = await chain.connection.getAddressLookupTable(new PublicKey(table))
      if (value?.state.addresses.some((a) => others.has(a.toBase58()))) tables.push(table)
    }
    const followUps: PoolGroupFollowUp[] = tables.map((lookupTable) => ({
      operation: 'extendLookupTable',
      reason: `the lookup table ${lookupTable} holds the pool group's chain records: add the new one, or setPoolGroupDefault will not find it there`,
      inputs: { lookupTable, addresses: [record.toBase58()] },
    }))
    return {
      group: ref.group,
      items: [
        {
          tokenAddresses: [],
          instructions: [ix],
          createdPdas: [record],
          signerRoles: { [authority.toBase58()]: signerRole(group.owner, authority) },
        },
      ],
      // a new record starts with lanes off: no lane reads it
      judge: { scope: 'none' },
      expected: { 'group.chainSelectors': selectors },
      extra: {},
      ...(followUps.length && { followUps: () => followUps }),
    }
  }

  /** The chain a proposal adds. */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedChain {
    const [one] = decodeOne(this.name, instructions, ['addGroupChain'])
    return {
      ...proposalBase(ref, one!.ix.keys[1]!.pubkey, guardOptions),
      selector: selectorOf(one!.data),
    }
  }
}

/** Removes a chain record no lane uses. */
export class RemovePoolGroupChain extends PoolGroupWriteOperation<
  RemovePoolGroupChainParams,
  ParsedChain
> {
  readonly name = 'removePoolGroupChain'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(
    params: SolanaGenerateParams<RemovePoolGroupChainParams>,
  ): ParsedChain {
    return parseChainWrite(this.name, params)
  }

  /**
   * `remove_group_chain` (rent to the owner). Named policies that still have a record for the
   * chain get a close follow-up.
   * @throws {@link CCTParamsInvalidError} if `authority` is not the owner or policy admin, the
   *   chain record does not exist, or lanes still use it
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedChain,
  ): Promise<PoolGroupWritePlan<object>> {
    const { ref, authority, selector } = parsed
    const { group, address, record } = await readGroupChain(this.name, chain, ref, selector)
    requirePolicyManager(this.name, group, authority, 'remove_group_chain')
    if (record.memberLaneCount !== 0)
      throw new CCTParamsInvalidError(
        this.name,
        'remoteChainSelector',
        `${record.memberLaneCount} lane(s) still use the chain record (GroupChainHasMembers): pause the chain, drain, turn its lanes off and close them first`,
      )
    const ix = await createPoolGroupProgram(chain, ref.program, parsed.payer)
      .methods.removeGroupChain({ remoteChainSelector: new BN(selector.toString()) })
      .accountsStrict({
        group: ref.group,
        groupChainPolicy: address,
        authority,
        rentReceiver: group.owner,
        ...eventAccounts(ref.program),
      })
      .instruction()
    // named policies keep their records for the chain: the program does not close them
    const policies = Array.from({ length: group.nextPolicyId }, (_, id) => ({
      id,
      address: poolGroupPdas.policy(ref.program, ref.group, id),
    }))
    const infos = await getMultipleAccountsInfoPaged(
      chain.connection,
      policies.map((p) => p.address),
    )
    const followUps: PoolGroupFollowUp[] = policies.flatMap((p, i) => {
      const info = infos[i]
      if (!info) return []
      const policy = decodeOwned('policy', info, p.address, ref.program)
      return policy.chainSelectors.some((c) => toBigInt(c) === selector)
        ? [
            {
              operation: 'closePoolGroupPolicyChainRecord',
              reason: `named policy ${p.id} still has a record for chain ${selector}: close it (rent to the owner)`,
              inputs: { policyId: p.id, remoteChainSelector: selector },
            },
          ]
        : []
    })
    return {
      group: ref.group,
      items: [
        {
          tokenAddresses: [],
          instructions: [ix],
          signerRoles: { [authority.toBase58()]: signerRole(group.owner, authority) },
        },
      ],
      // the program closes it only with no member lanes: no lane reads it
      judge: { scope: 'none' },
      expected: {
        'group.chainSelectors': group.chainSelectors.map(toBigInt),
        'group.owner': group.owner.toBase58(),
        [`chainRecord.${selector}.memberLaneCount`]: record.memberLaneCount,
      },
      extra: {},
      ...(followUps.length && { followUps: () => followUps }),
    }
  }

  /** The chain a proposal removes. */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedChain {
    const [one] = decodeOne(this.name, instructions, ['removeGroupChain'])
    return {
      ...proposalBase(ref, one!.ix.keys[2]!.pubkey, guardOptions),
      selector: selectorOf(one!.data),
    }
  }
}

// ─── sections ────────────────────────────────────────────────────────────────────────────────

type ParsedChainSection = ParsedChain & { section: SectionWrite; detach: boolean }

/** Writes one class of a chain record, merged; detaching from the default is explicit. */
export class SetPoolGroupChainPolicy extends PoolGroupWriteOperation<
  SetPoolGroupChainPolicyParams,
  ParsedChainSection
> {
  readonly name = 'setPoolGroupChainPolicy'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(
    params: SolanaGenerateParams<SetPoolGroupChainPolicyParams>,
  ): ParsedChainSection {
    const base = parseChainWrite(this.name, params)
    if (
      params.detachFromPoolGroupDefault !== undefined &&
      typeof params.detachFromPoolGroupDefault !== 'boolean'
    )
      throw new CCTParamsInvalidError(this.name, 'detachFromPoolGroupDefault', 'must be a boolean')
    return {
      ...base,
      section: {
        kind: 'update',
        update: parseSectionUpdate(this.name, params.section, base.selector),
      },
      detach: params.detachFromPoolGroupDefault === true,
    }
  }

  /**
   * `set_group_chain_policy` with the section merged over the record's.
   * @throws {@link CCTParamsInvalidError} if `authority` may not write the class, the class still
   *   follows the default without `detachFromPoolGroupDefault`, the fee is above the cap, or a lane
   *   guard refuses
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedChainSection,
  ): Promise<PoolGroupWritePlan<object>> {
    const { ref, authority, selector, section } = parsed
    const cls = sectionClass(section)
    const { group, address, record } = await readGroupChain(this.name, chain, ref, selector)
    requireClassWriter(this.name, group, authority, cls, 'set_group_chain_policy')
    if ((record.inheritsDefault & classBit(cls)) !== 0 && !parsed.detach)
      throw new CCTParamsInvalidError(
        this.name,
        'detachFromPoolGroupDefault',
        `the chain record follows the pool group default for ${cls}: writing it detaches it, so later setPoolGroupDefault writes no longer reach chain ${selector}. Pass detachFromPoolGroupDefault: true, or write the default`,
      )
    const ix = await createPoolGroupProgram(chain, ref.program, parsed.payer)
      .methods.setGroupChainPolicy({
        remoteChainSelector: new BN(selector.toString()),
        section: sectionArg(this.name, section, record.policy, group.maxBpsFee),
      })
      .accountsStrict({
        group: ref.group,
        groupChainPolicy: address,
        authority,
        ...eventAccounts(ref.program),
      })
      .instruction()
    return {
      group: ref.group,
      items: [
        {
          tokenAddresses: [],
          instructions: [ix],
          signerRoles: { [authority.toBase58()]: signerRole(group.owner, authority) },
        },
      ],
      judge: sectionJudge(section),
      expected: {
        [`chainRecord.${selector}.${cls}`]: sectionValue(record.policy, cls, selector),
        [`chainRecord.${selector}.inheritsDefault`]: decodeClassBits(record.inheritsDefault),
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
  ): ParsedChainSection {
    const [one] = decodeOne(this.name, instructions, ['setGroupChainPolicy'])
    return {
      ...proposalBase(ref, one!.ix.keys[2]!.pubkey, guardOptions),
      selector: selectorOf(one!.data),
      section: exactSection(this.name, field(one!.data, 'params', 'section')),
      detach: true,
    }
  }
}

type ParsedInherit = ParsedChain & { policyClass: Exclude<PoolGroupPolicyClass, 'security'> }

/** Makes a class of a chain record follow the group default again (copied now). */
export class InheritPoolGroupDefault extends PoolGroupWriteOperation<
  InheritPoolGroupDefaultParams,
  ParsedInherit
> {
  readonly name = 'inheritPoolGroupDefault'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid, or the class is SECURITY */
  protected override prepare(
    params: SolanaGenerateParams<InheritPoolGroupDefaultParams>,
  ): ParsedInherit {
    const cls = params.policyClass
    if (cls === 'security')
      throw new CCTParamsInvalidError(
        this.name,
        'policyClass',
        'SECURITY never follows the default again this way: the record would take its CCVs at once, without notice (SecurityPolicyNotSupported); schedule the set instead',
      )
    if (!(POOL_GROUP_POLICY_CLASSES as readonly unknown[]).includes(cls))
      throw new CCTParamsInvalidError(
        this.name,
        'policyClass',
        `must be one of ${POOL_GROUP_POLICY_CLASSES.join(', ')}`,
      )
    return { ...parseChainWrite(this.name, params), policyClass: cls }
  }

  /**
   * `inherit_group_default`.
   * @throws {@link CCTParamsInvalidError} if `authority` may not write the class, the class
   *   already follows the default, or a lane guard refuses
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedInherit,
  ): Promise<PoolGroupWritePlan<object>> {
    const { ref, authority, selector, policyClass: cls } = parsed
    const { group, address, record } = await readGroupChain(this.name, chain, ref, selector)
    requireClassWriter(this.name, group, authority, cls, 'inherit_group_default')
    if ((record.inheritsDefault & classBit(cls)) !== 0)
      throw new CCTParamsInvalidError(
        this.name,
        'policyClass',
        `the chain record already follows the pool group default for ${cls}`,
      )
    const ix = await createPoolGroupProgram(chain, ref.program, parsed.payer)
      .methods.inheritGroupDefault({
        remoteChainSelector: new BN(selector.toString()),
        class: idlPolicyClass(cls),
      })
      .accountsStrict({
        group: ref.group,
        groupChainPolicy: address,
        authority,
        ...eventAccounts(ref.program),
      })
      .instruction()
    return {
      group: ref.group,
      items: [
        {
          tokenAddresses: [],
          instructions: [ix],
          signerRoles: { [authority.toBase58()]: signerRole(group.owner, authority) },
        },
      ],
      judge:
        cls === 'rateLimit'
          ? { scope: 'loosened', failsClosedSeverity: 'error' }
          : { failsClosedSeverity: 'error' },
      expected: {
        [`chainRecord.${selector}.${cls}`]: sectionValue(record.policy, cls, selector),
        [`chainRecord.${selector}.inheritsDefault`]: decodeClassBits(record.inheritsDefault),
        [`group.defaultPolicy.${cls}`]: sectionValue(group.defaultPolicy, cls, undefined),
      },
      extra: {},
    }
  }

  /** The class a proposal re-attaches. */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedInherit {
    const [one] = decodeOne(this.name, instructions, ['inheritGroupDefault'])
    const raw = field(one!.data, 'params', 'class')
    const cls = POOL_GROUP_POLICY_CLASSES.find(
      (c) => typeof raw === 'object' && raw !== null && c in raw,
    )
    if (!cls || cls === 'security')
      throw new CCTParamsInvalidError(this.name, 'transactions', 'the instruction names no class')
    return {
      ...proposalBase(ref, one!.ix.keys[2]!.pubkey, guardOptions),
      selector: selectorOf(one!.data),
      policyClass: cls,
    }
  }
}

type ParsedDefault = ParsedGroupWrite & { section: SectionWrite }

/** Writes one class of the group default, into every chain record that follows it. */
export class SetPoolGroupDefault extends PoolGroupWriteOperation<
  SetPoolGroupDefaultParams,
  ParsedDefault
> {
  readonly name = 'setPoolGroupDefault'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(
    params: SolanaGenerateParams<SetPoolGroupDefaultParams>,
  ): ParsedDefault {
    return {
      ...parseGroupWrite(this.name, params),
      section: { kind: 'update', update: parseSectionUpdate(this.name, params.section, undefined) },
    }
  }

  /**
   * `set_group_default` with every chain record (writable), merged over the default.
   * @throws {@link CCTParamsInvalidError} if `authority` may not write the class, the fee is above
   *   the cap, or a lane guard refuses
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedDefault,
  ): Promise<PoolGroupWritePlan<object>> {
    const { ref, authority, section } = parsed
    const cls = sectionClass(section)
    const { group } = await readPoolGroup(this.name, chain, ref)
    requireClassWriter(this.name, group, authority, cls, 'set_group_default')
    const records = chainRecordMetas(ref.program, ref.group, group.chainSelectors)
    const infos = await getMultipleAccountsInfoPaged(
      chain.connection,
      records.map((r) => r.pubkey),
    )
    const following = group.chainSelectors.map(toBigInt).filter((s, i) => {
      const info = infos[i]
      return (
        !!info &&
        (decodeOwned('groupChainPolicy', info, records[i]!.pubkey, ref.program).inheritsDefault &
          classBit(cls)) !==
          0
      )
    })
    assertDefaultPoolsFit(this.name, section, following)
    const ix = await createPoolGroupProgram(chain, ref.program, parsed.payer)
      .methods.setGroupDefault({
        section: sectionArg(this.name, section, group.defaultPolicy, group.maxBpsFee),
      })
      .accountsStrict({ group: ref.group, authority, ...eventAccounts(ref.program) })
      .remainingAccounts(records)
      .instruction()
    return {
      group: ref.group,
      items: [
        {
          tokenAddresses: [],
          instructions: [ix],
          signerRoles: { [authority.toBase58()]: signerRole(group.owner, authority) },
        },
      ],
      judge: sectionJudge(section),
      expected: {
        [`group.defaultPolicy.${cls}`]: sectionValue(group.defaultPolicy, cls, undefined),
        'group.chainSelectors': group.chainSelectors.map(toBigInt),
        [`group.chainsFollowingDefault.${cls}`]: following,
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
  ): ParsedDefault {
    const [one] = decodeOne(this.name, instructions, ['setGroupDefault'])
    return {
      ...proposalBase(ref, one!.ix.keys[1]!.pubkey, guardOptions),
      section: exactSection(this.name, field(one!.data, 'params', 'section')),
    }
  }
}

/** The chain-record ops, by name: the snapshot check runs their re-checks. @internal */
export const POOL_GROUP_CHAIN_OPERATIONS = {
  addPoolGroupChain: new AddPoolGroupChain(),
  removePoolGroupChain: new RemovePoolGroupChain(),
  setPoolGroupChainPolicy: new SetPoolGroupChainPolicy(),
  inheritPoolGroupDefault: new InheritPoolGroupDefault(),
  setPoolGroupDefault: new SetPoolGroupDefault(),
}
