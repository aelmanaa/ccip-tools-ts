/**
 * Pool-group hooks (S4): `create_allowlist`, `create_blocklist`, `apply_list_updates`,
 * `transfer_list_admin`, `accept_list_admin`, `set_hook_config`, `set_policy_engine`. Program of
 * record: chainlink-ccip-solana 7558722, `burnmint-token-pool/src/instructions/groups/hooks.rs`.
 *
 * Lists are program accounts, not lane accounts: list writes are simulated and change no lane, so
 * they list none. `set_hook_config` and `set_policy_engine` write a SECURITY section, so the write
 * guard judges every lane that reads it. The list ops not bound to one pool group (a blocklist, the
 * entries, the admin hand-over) build snapshots that bind the list instead of a group; the snapshot
 * check re-checks only the group-bound ops.
 *
 * @packageDocumentation
 */

import { Buffer } from 'buffer'

import {
  type AccountMeta,
  type TransactionInstruction,
  Keypair,
  PublicKey,
  SystemProgram,
} from '@solana/web3.js'
import { getBytes, isHexString } from 'ethers'

import type { SolanaChain } from '../../../../solana/index.ts'
import { getMultipleAccountsInfoPaged } from '../../../../solana/utils.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import type { SolanaGenerateParams } from '../../operation.ts'
import { parseOptionalPublicKey, parsePublicKey } from '../../validate.ts'
import { poolGroupPdas } from '../accounts.ts'
import { decodeHookConfig, decodeRoles } from '../decode.ts'
import { createPoolGroupProgram } from '../program.ts'
import type { PoolGroupPolicyEngine } from '../types.ts'
import {
  type ParsedPoolGroupWrite,
  type PoolGroupWritePlan,
  PoolGroupWriteOperation,
  parseWriteBase,
} from '../write-operation.ts'
import type {
  AcceptPoolGroupListAdminParams,
  ApplyPoolGroupListUpdatesParams,
  CreatePoolGroupAllowlistParams,
  CreatePoolGroupBlocklistParams,
  CreatePoolGroupListResult,
  PoolGroupGuardOptions,
  SetPoolGroupHookConfigParams,
  SetPoolGroupPolicyEngineParams,
  TransferPoolGroupListAdminParams,
} from '../write-types.ts'
import {
  type ParsedPoolGroupRef,
  decodeOwned,
  parsePoolGroupProgram,
  readPoolGroup,
} from './common.ts'
import { blocklistKey, readHookList } from './hooks.ts'
import {
  type ReadTarget,
  type Target,
  parseTarget,
  readTarget,
  securityExpected,
  targetArgs,
  targetName,
  targetOf,
} from './security.ts'
import {
  type ParsedGroupWrite,
  decodeOne,
  eventAccounts,
  field,
  fittedItems,
  keyField,
  parseGroupWrite,
  proposalBase,
  requireOwner,
  signerRole,
} from './write-common.ts'

/** `MAX_POLICY_ENGINE_STATIC_ACCOUNTS` (base-token-pool `groups.rs:46`). */
const MAX_ENGINE_STATIC_ACCOUNTS = 4

/** `NOT_ENGINES` (hooks.rs): programs never accepted as a policy engine (the pool program too). */
const NOT_ENGINES = [
  SystemProgram.programId.toBase58(),
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'BPFLoader2111111111111111111111111111111111',
  'BPFLoader1111111111111111111111111111111111',
  'BPFLoaderUpgradeab1e11111111111111111111111',
  'LoaderV411111111111111111111111111111111111',
  'AddressLookupTab1e1111111111111111111111111',
  'ComputeBudget111111111111111111111111111111',
  'Ed25519SigVerify111111111111111111111111111',
  'KeccakSecp256k11111111111111111111111111111',
  'Vote111111111111111111111111111111111111111',
  'Stake11111111111111111111111111111111111111',
  'Config1111111111111111111111111111111111111',
]

/** The single-signer item of a write. */
const single = (
  ix: TransactionInstruction,
  role: 'pool-group-owner' | 'pool-group-role' | 'list-admin' | 'payer',
  authority: PublicKey,
  created?: PublicKey,
) => ({
  tokenAddresses: [],
  instructions: [ix],
  ...(created && { createdPdas: [created] }),
  signerRoles: { [authority.toBase58()]: role },
})

/** A list op is not bound to one pool group, so its proposal is not re-checked. */
function notRecheckable(operation: string): never {
  throw new CCTParamsInvalidError(
    operation,
    'snapshot',
    'a list write binds no pool group: its snapshot is checked by rebuilding with expectedSnapshot',
  )
}

/** Parses an optional list id (base58), defaulting to a fresh random key. */
const listIdOf = (operation: string, param: string, value: unknown) =>
  parseOptionalPublicKey(operation, param, value) ?? Keypair.generate().publicKey

// ─── list creation ───────────────────────────────────────────────────────────────────────────

type ParsedCreateAllowlist = ParsedGroupWrite & {
  listId: PublicKey
  enabled: boolean
  admin: PublicKey
}

/** Creates an allowlist of this pool group (`enabled` fixed for life). */
export class CreatePoolGroupAllowlist extends PoolGroupWriteOperation<
  CreatePoolGroupAllowlistParams,
  ParsedCreateAllowlist,
  CreatePoolGroupListResult
> {
  readonly name = 'createPoolGroupAllowlist'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(
    params: SolanaGenerateParams<CreatePoolGroupAllowlistParams>,
  ): ParsedCreateAllowlist {
    if (typeof params.enabled !== 'boolean')
      throw new CCTParamsInvalidError(this.name, 'enabled', 'must be a boolean')
    return {
      ...parseGroupWrite(this.name, params),
      listId: listIdOf(this.name, 'listId', params.listId),
      enabled: params.enabled,
      admin: parsePublicKey(this.name, 'admin', params.admin),
    }
  }

  /**
   * `create_allowlist` at `[ALLOWLIST_SEED, group, listId]`; the authority pays.
   * @throws {@link CCTParamsInvalidError} if `authority` is neither the owner nor the security
   *   admin, or the list exists
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedCreateAllowlist,
  ): Promise<PoolGroupWritePlan<CreatePoolGroupListResult>> {
    const { ref, authority, listId } = parsed
    const allowlist = poolGroupPdas.allowlist(ref.program, ref.group, listId)
    const { group, extras } = await readPoolGroup(this.name, chain, ref, [allowlist])
    const admin = decodeRoles(group.roles).securityAdmin
    if (!group.owner.equals(authority) && admin !== authority.toBase58())
      throw new CCTParamsInvalidError(
        this.name,
        'authority',
        `${authority.toBase58()} is neither the pool group owner nor its security admin, who sign create_allowlist`,
      )
    if (extras[0])
      throw new CCTParamsInvalidError(
        this.name,
        'listId',
        `an allowlist exists at ${allowlist.toBase58()}`,
      )
    const ix = await createPoolGroupProgram(chain, ref.program, parsed.payer)
      .methods.createAllowlist({ listId, enabled: parsed.enabled, admin: parsed.admin })
      .accountsStrict({
        group: ref.group,
        allowlist,
        authority,
        systemProgram: SystemProgram.programId,
        ...eventAccounts(ref.program),
      })
      .instruction()
    return {
      group: ref.group,
      items: [single(ix, signerRole(group.owner, authority), authority, allowlist)],
      judge: { scope: 'none' },
      expected: { [`allowlist.${allowlist.toBase58()}.exists`]: false },
      extra: { listAddress: allowlist.toBase58(), listId: listId.toBase58() },
    }
  }

  /** The list a proposal creates. */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedCreateAllowlist {
    const [one] = decodeOne(this.name, instructions, ['createAllowlist'])
    return {
      ...proposalBase(ref, one!.ix.keys[2]!.pubkey, guardOptions),
      listId: keyField(this.name, one!.data, 'params', 'listId'),
      enabled: field(one!.data, 'params', 'enabled') === true,
      admin: keyField(this.name, one!.data, 'params', 'admin'),
    }
  }
}

type ParsedCreateBlocklist = ParsedPoolGroupWrite & { blocklistId: PublicKey; admin: PublicKey }

/** Creates a blocklist shared by every pool group of the program (anyone pays). */
export class CreatePoolGroupBlocklist extends PoolGroupWriteOperation<
  CreatePoolGroupBlocklistParams,
  ParsedCreateBlocklist,
  CreatePoolGroupListResult
> {
  readonly name = 'createPoolGroupBlocklist'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(
    params: SolanaGenerateParams<CreatePoolGroupBlocklistParams>,
  ): ParsedCreateBlocklist {
    const program = parsePoolGroupProgram(this.name, params)
    return {
      ...parseWriteBase(this.name, program, { ...params, authority: params.creator }),
      blocklistId: listIdOf(this.name, 'blocklistId', params.blocklistId),
      admin: parsePublicKey(this.name, 'admin', params.admin),
    }
  }

  /**
   * `create_blocklist` at `[BLOCKLIST_SEED, creator, blocklistId]`.
   * @throws {@link CCTParamsInvalidError} if the list exists
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedCreateBlocklist,
  ): Promise<PoolGroupWritePlan<CreatePoolGroupListResult>> {
    const creator = parsed.authority
    const blocklist = poolGroupPdas.blocklist(parsed.program, creator, parsed.blocklistId)
    const [existing] = await getMultipleAccountsInfoPaged(chain.connection, [blocklist])
    if (existing)
      throw new CCTParamsInvalidError(
        this.name,
        'blocklistId',
        `a blocklist exists at ${blocklist.toBase58()}`,
      )
    const ix = await createPoolGroupProgram(chain, parsed.program, parsed.payer)
      .methods.createBlocklist({ blocklistId: parsed.blocklistId, admin: parsed.admin })
      .accountsStrict({
        blocklist,
        creator,
        systemProgram: SystemProgram.programId,
        ...eventAccounts(parsed.program),
      })
      .instruction()
    return {
      group: blocklist,
      items: [single(ix, 'payer', creator, blocklist)],
      judge: { scope: 'none' },
      expected: { [`blocklist.${blocklist.toBase58()}.exists`]: false },
      extra: { listAddress: blocklist.toBase58(), listId: parsed.blocklistId.toBase58() },
    }
  }

  /** Not re-checked (no pool group). */
  protected fromInstructions(): ParsedCreateBlocklist {
    return notRecheckable(this.name)
  }
}

// ─── list entries and admins ─────────────────────────────────────────────────────────────────

type ListEntry = { kind: 'add' | 'remove'; bytes: Buffer; pda: PublicKey }
type ParsedListUpdates = ParsedPoolGroupWrite & { list: PublicKey; add: string[]; remove: string[] }

/** An address as list bytes: a base58 key (32 bytes) or `0x` hex of any family (blocklists). */
function listBytes(operation: string, param: string, value: unknown, allowlist: boolean): Buffer {
  if (typeof value === 'string' && isHexString(value) && value.length > 2) {
    if (allowlist)
      throw new CCTParamsInvalidError(
        operation,
        param,
        'an allowlist holds Solana senders (base58 keys)',
      )
    return Buffer.from(getBytes(value))
  }
  return parsePublicKey(operation, param, value).toBuffer()
}

/** Adds and removes list entries; existing adds and absent removes are dropped. */
export class ApplyPoolGroupListUpdates extends PoolGroupWriteOperation<
  ApplyPoolGroupListUpdatesParams,
  ParsedListUpdates
> {
  readonly name = 'applyPoolGroupListUpdates'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(
    params: SolanaGenerateParams<ApplyPoolGroupListUpdatesParams>,
  ): ParsedListUpdates {
    const program = parsePoolGroupProgram(this.name, params)
    const asList = (name: 'add' | 'remove'): string[] => {
      const v: unknown = params[name]
      if (v === undefined) return []
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))
        throw new CCTParamsInvalidError(this.name, name, 'must be an array of addresses')
      return v
    }
    const add = asList('add')
    const remove = asList('remove')
    if (!add.length && !remove.length)
      throw new CCTParamsInvalidError(this.name, 'add', 'give add, remove or both')
    return {
      ...parseWriteBase(this.name, program, params),
      list: parsePublicKey(this.name, 'list', params.list),
      add,
      remove,
    }
  }

  /**
   * `apply_list_updates`, as many entries per instruction as fit (adds, then removes). The admin
   * pays the entries' rent and receives it back on removal.
   * @throws {@link CCTParamsInvalidError} if the list is not a hook list of the program, `authority`
   *   is not its admin, or an address is malformed for the list
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedListUpdates,
  ): Promise<PoolGroupWritePlan<object>> {
    const { program, authority, list } = parsed
    const info = await readHookList(this.name, chain, program, list, 'list')
    if (info.admin !== authority.toBase58())
      throw new CCTParamsInvalidError(
        this.name,
        'authority',
        `${authority.toBase58()} is not the list admin (${info.admin}), who signs apply_list_updates`,
      )
    const allowlist = info.kind === 'allowlist'
    const entryOf = (kind: ListEntry['kind'], v: string, i: number): ListEntry => {
      const bytes = listBytes(this.name, `${kind}[${i}]`, v, allowlist)
      const pda = allowlist
        ? poolGroupPdas.allowlistEntry(program, list, new PublicKey(bytes))
        : poolGroupPdas.blocklistEntry(program, list, blocklistKey(bytes))
      return { kind, bytes, pda }
    }
    const unique = (entries: ListEntry[]) => [
      ...new Map(entries.map((e) => [e.pda.toBase58(), e])).values(),
    ]
    const adds = unique(parsed.add.map((v, i) => entryOf('add', v, i)))
    const removes = unique(parsed.remove.map((v, i) => entryOf('remove', v, i)))
    const clash = adds.find((a) => removes.some((r) => r.pda.equals(a.pda)))
    if (clash)
      throw new CCTParamsInvalidError(
        this.name,
        'remove',
        `${clash.pda.toBase58()} is both added and removed`,
      )
    const infos = await getMultipleAccountsInfoPaged(chain.connection, [
      ...adds.map((e) => e.pda),
      ...removes.map((e) => e.pda),
    ])
    const listed = (i: number) => !!infos[i]?.owner.equals(program)
    const entries = [
      ...adds.filter((_, i) => !listed(i)),
      ...removes.filter((_, i) => listed(adds.length + i)),
    ]
    const expected = {
      [`list.${list.toBase58()}.admin`]: info.admin,
      [`list.${list.toBase58()}.entries`]: entries.map((e) => [e.kind, e.pda.toBase58()]),
    }
    if (!entries.length) return { group: list, items: [], judge: null, expected, extra: {} }
    const client = createPoolGroupProgram(chain, program, parsed.payer)
    const build = (chunk: ListEntry[]) => {
      const a = chunk.filter((e) => e.kind === 'add')
      const r = chunk.filter((e) => e.kind === 'remove')
      return client.methods
        .applyListUpdates({ adds: a.map((e) => e.bytes), removes: r.map((e) => e.bytes) })
        .accountsStrict({
          list,
          admin: authority,
          systemProgram: SystemProgram.programId,
          ...eventAccounts(program),
        })
        .remainingAccounts(
          [...a, ...r].map((e): AccountMeta => ({
            pubkey: e.pda,
            isSigner: false,
            isWritable: true,
          })),
        )
        .instruction()
    }
    const items = await fittedItems(this.name, chain, parsed, entries, build, {
      signerRoles: { [authority.toBase58()]: 'list-admin' },
      describe: (e) => `the entry ${e.pda.toBase58()}`,
    })
    return { group: list, items, judge: { scope: 'none' }, judgeEach: true, expected, extra: {} }
  }

  /** Not re-checked (no pool group). */
  protected fromInstructions(): ParsedListUpdates {
    return notRecheckable(this.name)
  }
}

type ParsedListAdmin = ParsedPoolGroupWrite & {
  list: PublicKey
  proposedAdmin?: PublicKey
  poolGroup?: PublicKey
}

/** Proposes a new list admin (the admin, or the pool group owner for an allowlist). */
export class TransferPoolGroupListAdmin extends PoolGroupWriteOperation<
  TransferPoolGroupListAdminParams,
  ParsedListAdmin
> {
  readonly name = 'transferPoolGroupListAdmin'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(
    params: SolanaGenerateParams<TransferPoolGroupListAdminParams>,
  ): ParsedListAdmin {
    const program = parsePoolGroupProgram(this.name, params)
    const poolGroup = parseOptionalPublicKey(this.name, 'poolGroupAddress', params.poolGroupAddress)
    return {
      ...parseWriteBase(this.name, program, params),
      list: parsePublicKey(this.name, 'list', params.list),
      proposedAdmin: parsePublicKey(this.name, 'proposedAdmin', params.proposedAdmin),
      ...(poolGroup && { poolGroup }),
    }
  }

  /**
   * `transfer_list_admin`; the pool group is passed only when its owner signs for an allowlist.
   * @throws {@link CCTParamsInvalidError} if `authority` is neither the admin nor (for an allowlist)
   *   its pool group's owner
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedListAdmin,
  ): Promise<PoolGroupWritePlan<object>> {
    const { program, authority, list } = parsed
    const info = await readHookList(this.name, chain, program, list, 'list')
    let group: PublicKey | null = null
    let role: 'list-admin' | 'pool-group-owner' = 'list-admin'
    if (info.admin !== authority.toBase58()) {
      const [account] = await getMultipleAccountsInfoPaged(chain.connection, [list])
      const owningGroup =
        info.kind === 'allowlist' && account
          ? decodeOwned('allowlist', account, list, program).group
          : undefined
      if (parsed.poolGroup && owningGroup && !parsed.poolGroup.equals(owningGroup))
        throw new CCTParamsInvalidError(
          this.name,
          'poolGroupAddress',
          `the allowlist belongs to ${owningGroup.toBase58()}, not ${parsed.poolGroup.toBase58()}`,
        )
      const owner = owningGroup
        ? (await readPoolGroup(this.name, chain, { program, group: owningGroup })).group.owner
        : undefined
      if (!owningGroup || !owner?.equals(authority))
        throw new CCTParamsInvalidError(
          this.name,
          'authority',
          `${authority.toBase58()} is not the list admin (${info.admin})${owningGroup ? ` nor the owner of its pool group ${owningGroup.toBase58()}` : ''}, who sign transfer_list_admin`,
        )
      group = owningGroup
      role = 'pool-group-owner'
    }
    const ix = await createPoolGroupProgram(chain, program, parsed.payer)
      .methods.transferListAdmin({ proposedAdmin: parsed.proposedAdmin! })
      .accountsStrict({ list, authority, group, ...eventAccounts(program) })
      .instruction()
    return {
      group: list,
      items: [single(ix, role, authority)],
      judge: { scope: 'none' },
      expected: {
        [`list.${list.toBase58()}.admin`]: info.admin,
        [`list.${list.toBase58()}.proposedAdmin`]: info.proposedAdmin,
      },
      extra: {},
    }
  }

  /** Not re-checked (no pool group). */
  protected fromInstructions(): ParsedListAdmin {
    return notRecheckable(this.name)
  }
}

/** Accepts list administration (the proposed admin). */
export class AcceptPoolGroupListAdmin extends PoolGroupWriteOperation<
  AcceptPoolGroupListAdminParams,
  ParsedListAdmin
> {
  readonly name = 'acceptPoolGroupListAdmin'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(
    params: SolanaGenerateParams<AcceptPoolGroupListAdminParams>,
  ): ParsedListAdmin {
    const program = parsePoolGroupProgram(this.name, params)
    return {
      ...parseWriteBase(this.name, program, params),
      list: parsePublicKey(this.name, 'list', params.list),
    }
  }

  /**
   * `accept_list_admin`.
   * @throws {@link CCTParamsInvalidError} if `authority` is not the proposed admin
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedListAdmin,
  ): Promise<PoolGroupWritePlan<object>> {
    const { program, authority, list } = parsed
    const info = await readHookList(this.name, chain, program, list, 'list')
    if (info.proposedAdmin !== authority.toBase58())
      throw new CCTParamsInvalidError(
        this.name,
        'authority',
        `${authority.toBase58()} is not the proposed admin (${info.proposedAdmin ?? 'none'}): propose it with transferPoolGroupListAdmin first`,
      )
    const ix = await createPoolGroupProgram(chain, program, parsed.payer)
      .methods.acceptListAdmin()
      .accountsStrict({ list, authority, group: null, ...eventAccounts(program) })
      .instruction()
    return {
      group: list,
      items: [single(ix, 'list-admin', authority)],
      judge: { scope: 'none' },
      expected: { [`list.${list.toBase58()}.proposedAdmin`]: info.proposedAdmin },
      extra: {},
    }
  }

  /** Not re-checked (no pool group). */
  protected fromInstructions(): ParsedListAdmin {
    return notRecheckable(this.name)
  }
}

// ─── SECURITY hooks: lists and the policy engine ─────────────────────────────────────────────

type ParsedHookConfig = ParsedGroupWrite & {
  target: Target
  allowlist?: PublicKey | null
  blocklist?: PublicKey | null
}

/** The target's hook (decoded), or none. */
const hookOf = (t: ReadTarget) => {
  const hook = t.sections.security.hook
  return hook ? decodeHookConfig(hook) : { allowlist: null, blocklist: null, policyEngine: null }
}

/** Parses an optional list: `undefined` keeps it, `null` removes it. */
function optionalList(
  operation: string,
  param: string,
  value: unknown,
): PublicKey | null | undefined {
  if (value === undefined || value === null) return value
  return parsePublicKey(operation, param, value)
}

/** Sets a SECURITY target's allowlist and blocklist; applies at once. */
export class SetPoolGroupHookConfig extends PoolGroupWriteOperation<
  SetPoolGroupHookConfigParams,
  ParsedHookConfig
> {
  readonly name = 'setPoolGroupHookConfig'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid or sets nothing */
  protected override prepare(
    params: SolanaGenerateParams<SetPoolGroupHookConfigParams>,
  ): ParsedHookConfig {
    if (params.allowlist === undefined && params.blocklist === undefined)
      throw new CCTParamsInvalidError(this.name, 'allowlist', 'give allowlist, blocklist or both')
    const allowlist = optionalList(this.name, 'allowlist', params.allowlist)
    const blocklist = optionalList(this.name, 'blocklist', params.blocklist)
    return {
      ...parseGroupWrite(this.name, params),
      target: parseTarget(this.name, params),
      ...(allowlist !== undefined && { allowlist }),
      ...(blocklist !== undefined && { blocklist }),
    }
  }

  /**
   * `set_hook_config`, merged over the target's current lists. Nothing is built when they already
   * hold.
   * @throws {@link CCTParamsInvalidError} if `authority` may not make the change (adding: owner or
   *   security admin; removing or replacing: owner), the target still inherits SECURITY, the
   *   allowlist is not an enabled allowlist of this pool group, or the blocklist is not one
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedHookConfig,
  ): Promise<PoolGroupWritePlan<object>> {
    const { ref, authority, target } = parsed
    const t = await readTarget(this.name, chain, ref, target)
    if (t.inherits)
      throw new CCTParamsInvalidError(
        this.name,
        'remoteChainSelector',
        `the record ${targetName(target)} still inherits SECURITY from its default (SecurityInheritsDefault): set the hook on the default, or detach the record with a targeted schedule first`,
      )
    const current = hookOf(t)
    const next = {
      allowlist:
        parsed.allowlist === undefined ? current.allowlist : (parsed.allowlist?.toBase58() ?? null),
      blocklist:
        parsed.blocklist === undefined ? current.blocklist : (parsed.blocklist?.toBase58() ?? null),
    }
    const weakens = (['allowlist', 'blocklist'] as const).some(
      (k) => current[k] !== null && current[k] !== next[k],
    )
    const securityAdmin = decodeRoles(t.group.roles).securityAdmin
    if (weakens)
      requireOwner(
        this.name,
        t.group.owner,
        authority,
        'set_hook_config (remove or replace a list)',
      )
    else if (!t.group.owner.equals(authority) && securityAdmin !== authority.toBase58())
      throw new CCTParamsInvalidError(
        this.name,
        'authority',
        `${authority.toBase58()} is neither the pool group owner nor its security admin, who add a hook list`,
      )
    if (next.allowlist) {
      const list = await readHookList(
        this.name,
        chain,
        ref.program,
        new PublicKey(next.allowlist),
        'allowlist',
      )
      const [account] = await getMultipleAccountsInfoPaged(chain.connection, [
        new PublicKey(next.allowlist),
      ])
      if (list.kind !== 'allowlist' || !list.enabled)
        throw new CCTParamsInvalidError(
          this.name,
          'allowlist',
          `${next.allowlist} is not an enabled allowlist (AllowlistDisabled)`,
        )
      if (
        !account ||
        !decodeOwned('allowlist', account, new PublicKey(next.allowlist), ref.program).group.equals(
          ref.group,
        )
      )
        throw new CCTParamsInvalidError(
          this.name,
          'allowlist',
          `${next.allowlist} is an allowlist of another pool group`,
        )
    }
    if (next.blocklist) {
      const list = await readHookList(
        this.name,
        chain,
        ref.program,
        new PublicKey(next.blocklist),
        'blocklist',
      )
      if (list.kind !== 'blocklist')
        throw new CCTParamsInvalidError(
          this.name,
          'blocklist',
          `${next.blocklist} is not a blocklist`,
        )
    }
    const expected = securityExpected(target, t)
    if (next.allowlist === current.allowlist && next.blocklist === current.blocklist)
      return { group: ref.group, items: [], judge: null, expected, extra: {} }
    const key = (v: string | null) => (v ? new PublicKey(v) : null)
    const ix = await createPoolGroupProgram(chain, ref.program, parsed.payer)
      .methods.setHookConfig({
        ...targetArgs(target),
        allowlist: key(next.allowlist),
        blocklist: key(next.blocklist),
      })
      .accountsStrict({
        group: ref.group,
        authority,
        allowlist: key(next.allowlist),
        blocklist: key(next.blocklist),
        ...eventAccounts(ref.program),
      })
      .remainingAccounts(t.metas)
      .instruction()
    return {
      group: ref.group,
      items: [single(ix, signerRole(t.group.owner, authority), authority)],
      judge: { failsClosedSeverity: 'error' },
      expected,
      extra: {},
    }
  }

  /** The exact lists a proposal sets. */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedHookConfig {
    const [one] = decodeOne(this.name, instructions, ['setHookConfig'])
    const list = (name: string) => {
      const v = field(one!.data, 'params', name)
      return v instanceof PublicKey ? v : null
    }
    return {
      ...proposalBase(ref, one!.ix.keys[1]!.pubkey, guardOptions),
      target: targetOf(one!.data),
      allowlist: list('allowlist'),
      blocklist: list('blocklist'),
    }
  }
}

type ParsedEngine = ParsedGroupWrite & {
  target: Target
  engine: {
    program: PublicKey
    staticAccounts: PublicKey[]
    writableStatics: number
    onSend: boolean
    onReceive: boolean
  } | null
  skipDetach: boolean
}

/**
 * Parses a policy engine: its program (not a deny-listed one), at most 4 static accounts, writable
 * ones by index (a bitmask), and the two hook points.
 * @throws {@link CCTParamsInvalidError} otherwise
 */
function parseEngine(
  operation: string,
  program: PublicKey,
  value: unknown,
): ParsedEngine['engine'] {
  if (value === null) return null
  if (typeof value !== 'object')
    throw new CCTParamsInvalidError(operation, 'engine', 'must be an engine, or null to remove it')
  const e = (k: keyof PoolGroupPolicyEngine): unknown => Reflect.get(value, k)
  const engineProgram = parsePublicKey(operation, 'engine.program', e('program'))
  if (engineProgram.equals(program) || NOT_ENGINES.includes(engineProgram.toBase58()))
    throw new CCTParamsInvalidError(
      operation,
      'engine.program',
      `${engineProgram.toBase58()} may not be a policy engine (EngineProgramNotAllowed)`,
    )
  const statics = e('staticAccounts')
  if (!Array.isArray(statics) || statics.length > MAX_ENGINE_STATIC_ACCOUNTS)
    throw new CCTParamsInvalidError(
      operation,
      'engine.staticAccounts',
      `must be an array of at most ${MAX_ENGINE_STATIC_ACCOUNTS} accounts (TooManyEngineAccounts)`,
    )
  const staticAccounts = statics.map((a: unknown, i) =>
    parsePublicKey(operation, `engine.staticAccounts[${i}]`, a),
  )
  const indices: unknown = e('writableStatics') ?? []
  if (
    !Array.isArray(indices) ||
    indices.some(
      (i: unknown) =>
        typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= staticAccounts.length,
    )
  )
    throw new CCTParamsInvalidError(
      operation,
      'engine.writableStatics',
      'must list indices of staticAccounts',
    )
  const onSend = e('onSend')
  const onReceive = e('onReceive')
  if (typeof onSend !== 'boolean')
    throw new CCTParamsInvalidError(operation, 'engine.onSend', 'must be a boolean')
  if (typeof onReceive !== 'boolean')
    throw new CCTParamsInvalidError(operation, 'engine.onReceive', 'must be a boolean')
  return {
    program: engineProgram,
    staticAccounts,
    writableStatics: indices.reduce((m: number, i: number) => m | (1 << i), 0),
    onSend,
    onReceive,
  }
}

/** The accounts an engine CPI (`attach`, `detach`) needs: its program, the hook authority, its statics. */
function engineMetas(
  program: PublicKey,
  group: PublicKey,
  engine: NonNullable<ParsedEngine['engine']>,
): AccountMeta[] {
  return [
    { pubkey: engine.program, isSigner: false, isWritable: false },
    { pubkey: poolGroupPdas.hookAuthority(program, group), isSigner: false, isWritable: false },
    ...engine.staticAccounts.map((pubkey, i) => ({
      pubkey,
      isSigner: false,
      isWritable: ((engine.writableStatics >> i) & 1) === 1,
    })),
  ]
}

/** Attaches, replaces or removes a SECURITY target's policy engine (owner only). */
export class SetPoolGroupPolicyEngine extends PoolGroupWriteOperation<
  SetPoolGroupPolicyEngineParams,
  ParsedEngine
> {
  readonly name = 'setPoolGroupPolicyEngine'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(
    params: SolanaGenerateParams<SetPoolGroupPolicyEngineParams>,
  ): ParsedEngine {
    const base = parseGroupWrite(this.name, params)
    if (params.skipDetach !== undefined && typeof params.skipDetach !== 'boolean')
      throw new CCTParamsInvalidError(this.name, 'skipDetach', 'must be a boolean')
    return {
      ...base,
      target: parseTarget(this.name, params),
      engine: parseEngine(this.name, base.program, params.engine),
      skipDetach: params.skipDetach ?? false,
    }
  }

  /**
   * `set_policy_engine`: the target's records, then the accounts of the new engine's `attach` and,
   * unless `skipDetach` or unchanged, the old engine's `detach` (both CPIs signed by the hook
   * authority).
   * @throws {@link CCTParamsInvalidError} if `authority` is not the owner, the target still inherits
   *   SECURITY, or the engine program is not an executable program
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedEngine,
  ): Promise<PoolGroupWritePlan<object>> {
    const { ref, authority, target, engine } = parsed
    const t = await readTarget(this.name, chain, ref, target)
    requireOwner(this.name, t.group.owner, authority, 'set_policy_engine')
    if (t.inherits)
      throw new CCTParamsInvalidError(
        this.name,
        'remoteChainSelector',
        `the record ${targetName(target)} still inherits SECURITY from its default (SecurityInheritsDefault)`,
      )
    if (engine) {
      const [info] = await getMultipleAccountsInfoPaged(chain.connection, [engine.program])
      if (!info?.executable)
        throw new CCTParamsInvalidError(
          this.name,
          'engine.program',
          `${engine.program.toBase58()} is not an executable program (HookAccountMissing)`,
        )
    }
    const oldHook = t.sections.security.hook?.policyEngine ?? null
    const old = oldHook
      ? {
          program: oldHook.program,
          staticAccounts: oldHook.staticAccounts,
          writableStatics: oldHook.writableStatics,
          onSend: oldHook.onSend,
          onReceive: oldHook.onReceive,
        }
      : null
    const same = (a: typeof old, b: typeof old) =>
      JSON.stringify(
        a && { ...a, program: a.program.toBase58(), staticAccounts: a.staticAccounts.map(String) },
      ) ===
      JSON.stringify(
        b && { ...b, program: b.program.toBase58(), staticAccounts: b.staticAccounts.map(String) },
      )
    const expected = securityExpected(target, t)
    if (same(old, engine)) return { group: ref.group, items: [], judge: null, expected, extra: {} }
    const byKey = new Map<string, AccountMeta>()
    for (const m of [
      ...(engine ? engineMetas(ref.program, ref.group, engine) : []),
      ...(old && !parsed.skipDetach ? engineMetas(ref.program, ref.group, old) : []),
    ]) {
      const k = m.pubkey.toBase58()
      byKey.set(k, { ...m, isWritable: m.isWritable || !!byKey.get(k)?.isWritable })
    }
    const ix = await createPoolGroupProgram(chain, ref.program, parsed.payer)
      .methods.setPolicyEngine({
        ...targetArgs(target),
        engine,
        skipDetach: parsed.skipDetach,
        recordCount: t.metas.length,
      })
      .accountsStrict({ group: ref.group, authority, ...eventAccounts(ref.program) })
      .remainingAccounts([...t.metas, ...byKey.values()])
      .instruction()
    return {
      group: ref.group,
      items: [single(ix, 'pool-group-owner', authority)],
      judge: { failsClosedSeverity: 'error' },
      expected,
      extra: {},
    }
  }

  /** The exact engine a proposal sets. */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedEngine {
    const [one] = decodeOne(this.name, instructions, ['setPolicyEngine'])
    const e = field(one!.data, 'params', 'engine')
    const engine =
      e && typeof e === 'object'
        ? {
            program: keyField(this.name, e, 'program'),
            staticAccounts: [field(e, 'staticAccounts')]
              .flatMap((v) => (Array.isArray(v) ? v : []))
              .filter((k): k is PublicKey => k instanceof PublicKey),
            writableStatics: Number(field(e, 'writableStatics') ?? 0),
            onSend: field(e, 'onSend') === true,
            onReceive: field(e, 'onReceive') === true,
          }
        : null
    return {
      ...proposalBase(ref, one!.ix.keys[1]!.pubkey, guardOptions),
      target: targetOf(one!.data),
      engine,
      skipDetach: field(one!.data, 'params', 'skipDetach') === true,
    }
  }
}

/** The hook ops, by name: the snapshot check runs the group-bound ones' re-checks. @internal */
export const POOL_GROUP_HOOK_OPERATIONS = {
  createPoolGroupAllowlist: new CreatePoolGroupAllowlist(),
  createPoolGroupBlocklist: new CreatePoolGroupBlocklist(),
  applyPoolGroupListUpdates: new ApplyPoolGroupListUpdates(),
  transferPoolGroupListAdmin: new TransferPoolGroupListAdmin(),
  acceptPoolGroupListAdmin: new AcceptPoolGroupListAdmin(),
  setPoolGroupHookConfig: new SetPoolGroupHookConfig(),
  setPoolGroupPolicyEngine: new SetPoolGroupPolicyEngine(),
} as const
