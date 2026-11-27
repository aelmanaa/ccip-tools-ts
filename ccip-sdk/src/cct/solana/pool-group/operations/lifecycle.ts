/**
 * Pool-group lifecycle and roles (S3a): `create_group` (with `set_group_roles` and `add_group_chain`),
 * `set_group_roles`, `set_group_settings`, `transfer_group_ownership`, `accept_group_ownership`.
 * Program of record: chainlink-ccip-solana 7558722,
 * `burnmint-token-pool/src/instructions/groups/lifecycle.rs` and `chains.rs`.
 *
 * Every op pre-flights `authority` against the decoded group with the program's rules (owner for
 * roles, settings and transfer; the proposed owner for accept; anyone for create), then runs the
 * shared write guard on the exact instructions and seals a snapshot.
 *
 * @packageDocumentation
 */

import { BN, BorshAccountsCoder } from '@coral-xyz/anchor'
import {
  type AccountMeta,
  type TransactionInstruction,
  AddressLookupTableProgram,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
} from '@solana/web3.js'

import type { SolanaChain } from '../../../../solana/index.ts'
import { getMultipleAccountsInfoPaged } from '../../../../solana/utils.ts'
import { CCTOperationUnsupportedError, CCTParamsInvalidError } from '../../../errors.ts'
import type { SolanaExecuteParams, SolanaGenerateParams } from '../../operation.ts'
import { deriveEventAuthorityPda } from '../../programs/token-pool.ts'
import {
  parsePublicKey,
  validateBigInt,
  validateInteger,
  validateUniqueChainSelectors,
} from '../../validate.ts'
import { poolGroupPdas, poolGroupsCoder } from '../accounts.ts'
import { decodeRoles, keyOrNull, toBigInt } from '../decode.ts'
import { clockUnixTimestamp } from '../lane.ts'
import { type PoolGroupPackItem, firstTransactionItemCount } from '../packer.ts'
import { createPoolGroupProgram, getPoolGroupProgramFeatures } from '../program.ts'
import type { PoolGroupRoles } from '../types.ts'
import type { PoolGroupJudgement } from '../write-guard.ts'
import {
  type ParsedPoolGroupWrite,
  type PoolGroupWritePlan,
  PoolGroupWriteOperation,
  parseWriteBase,
} from '../write-operation.ts'
import type {
  AcceptPoolGroupOwnershipParams,
  CreatePoolGroupParams,
  CreatePoolGroupResult,
  PoolGroupExecuteResult,
  PoolGroupFollowUp,
  PoolGroupGuardOptions,
  SetPoolGroupRolesParams,
  SetPoolGroupSettingsParams,
  TransferPoolGroupOwnershipParams,
} from '../write-types.ts'
import {
  type ParsedPoolGroupRef,
  decodeOwned,
  orThrow,
  parsePoolGroupProgram,
  parsePoolGroupRef,
  readPoolGroup,
  validateSelector,
} from './common.ts'

/** `MAX_GROUP_CHAINS` (base-token-pool `groups.rs:40`). */
const MAX_POOL_GROUP_CHAINS = 24
/** `MAX_TOKEN_TRANSFER_FEE_BPS`. */
const MAX_FEE_BPS = 10_000
/** `DEFAULT_GROUP_MAX_BPS_FEE` (`groups.rs:37`). */
const DEFAULT_MAX_BPS_FEE = 1_000
/** `MAX_MIN_CCV_ACTIVATION_DELAY` (burnmint `state.rs:536`): 30 days. */
const MAX_MIN_CCV_ACTIVATION_DELAY = 30n * 24n * 60n * 60n
/** The default notice of a CCV change: 1 day. */
const DEFAULT_MIN_CCV_ACTIVATION_DELAY = 86_400n
/** `Allowlist` account discriminator. */
const ALLOWLIST_DISCRIMINATOR = BorshAccountsCoder.accountDiscriminator('Allowlist')
/** The SECURITY class bit (`PolicyClass::bit`). */
const SECURITY_BIT = 8

const ROLE_NAMES = [
  'policyAdmin',
  'connectionAdmin',
  'feeAdmin',
  'rateLimitAdmin',
  'securityAdmin',
  'pauser',
  'unpauser',
] as const satisfies readonly (keyof PoolGroupRoles)[]

/** Parses a role update: known names only, each a key or `null`. */
function parseRoles(operation: string, param: string, value: unknown): Partial<PoolGroupRoles> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new CCTParamsInvalidError(operation, param, 'must be an object of roles')
  const out: Partial<PoolGroupRoles> = {}
  for (const [name, holder] of Object.entries(value)) {
    const role = ROLE_NAMES.find((r) => r === name)
    if (!role)
      throw new CCTParamsInvalidError(
        operation,
        `${param}.${name}`,
        `is not a pool group role (${ROLE_NAMES.join(', ')})`,
      )
    if (holder === undefined) continue
    out[role] =
      holder === null ? null : parsePublicKey(operation, `${param}.${name}`, holder).toBase58()
  }
  return out
}

/** All seven roles, each from `of`. */
function rolesFrom<T>(of: (role: (typeof ROLE_NAMES)[number]) => T) {
  return {
    policyAdmin: of('policyAdmin'),
    connectionAdmin: of('connectionAdmin'),
    feeAdmin: of('feeAdmin'),
    rateLimitAdmin: of('rateLimitAdmin'),
    securityAdmin: of('securityAdmin'),
    pauser: of('pauser'),
    unpauser: of('unpauser'),
  }
}

/** Roles in the IDL's `GroupRoles` shape (`Pubkey::default()` = unassigned). */
const toIdlRoles = (roles: PoolGroupRoles) =>
  rolesFrom((r) => {
    const holder = roles[r]
    return holder === null ? PublicKey.default : new PublicKey(holder)
  })

/** Validates a CCV notice in seconds (`number` or `bigint`). */
function parseDelay(operation: string, value: unknown): bigint {
  const v = typeof value === 'number' && Number.isInteger(value) ? BigInt(value) : value
  validateBigInt(operation, 'minCCVActivationDelay', v, 0n, MAX_MIN_CCV_ACTIVATION_DELAY)
  return v
}

/** The accounts every `#[event_cpi]` instruction ends with. */
const eventAccounts = (program: PublicKey) => ({
  eventAuthority: deriveEventAuthorityPda(program),
  program,
})

/** A field of a decoded instruction's data, as `unknown`. */
const field = (o: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>(
    (v, k) => (typeof v === 'object' && v !== null ? Reflect.get(v, k) : undefined),
    o,
  )

/** A decoded integer field (`BN` or number), or `undefined`. */
function bigField(v: unknown): bigint | undefined {
  if (BN.isBN(v)) return BigInt(v.toString())
  if (typeof v === 'number') return BigInt(v)
  return undefined
}

/** A decoded `PublicKey` field. */
function keyField(operation: string, o: unknown, ...path: string[]): PublicKey {
  const v = field(o, ...path)
  if (!(v instanceof PublicKey))
    throw new CCTParamsInvalidError(
      operation,
      'transactions',
      `the instruction has no ${path.join('.')}`,
    )
  return v
}

/**
 * A proposal's pool-program instructions, decoded; each must be one of `names`.
 * @throws {@link CCTParamsInvalidError} if the proposal holds anything else
 */
function decodeOne(
  operation: string,
  instructions: readonly TransactionInstruction[],
  names: readonly string[],
  single = true,
): { name: string; data: unknown; ix: TransactionInstruction }[] {
  if (!instructions.length || (single && instructions.length !== 1))
    throw new CCTParamsInvalidError(
      operation,
      'transactions',
      `must hold ${single ? 'exactly one' : 'at least one'} pool-program instruction of this op`,
    )
  return instructions.map((ix, i) => {
    const decoded = poolGroupsCoder.instruction.decode(Buffer.from(ix.data))
    if (!decoded || !names.includes(decoded.name))
      throw new CCTParamsInvalidError(
        operation,
        `transactions.instructions[${i}]`,
        `is not one of ${names.join(', ')}: pass this op's proposal`,
      )
    return { name: decoded.name, data: decoded.data, ix }
  })
}

/** The pool group owner check of roles, settings and transfer (`GroupOwnerOnly`). */
function requireOwner(operation: string, owner: PublicKey, authority: PublicKey, ix: string): void {
  if (!owner.equals(authority))
    throw new CCTParamsInvalidError(
      operation,
      'authority',
      `${authority.toBase58()} is not the pool group owner (${owner.toBase58()}), who alone signs ${ix}`,
    )
}

/** The group chain records of every chain, in `chain_selectors` order, writable. */
function chainRecordMetas(
  program: PublicKey,
  group: PublicKey,
  selectors: readonly BN[],
): AccountMeta[] {
  return selectors.map((s) => ({
    pubkey: poolGroupPdas.groupChain(program, group, toBigInt(s)),
    isSigner: false,
    isWritable: true,
  }))
}

/** The CCV notice in force at `now`: a pending decrease applies once its time has come. */
function minCCVActivationDelayOf(
  group: {
    minCcvActivationDelay: { toString(): string }
    pendingMinCcvActivationDelay: { toString(): string }
    pendingMinCcvActivationDelayAt: { toString(): string }
  },
  now: bigint,
): bigint {
  const pendingAt = toBigInt(group.pendingMinCcvActivationDelayAt)
  return pendingAt !== 0n && now >= pendingAt
    ? toBigInt(group.pendingMinCcvActivationDelay)
    : toBigInt(group.minCcvActivationDelay)
}

// ─── create ──────────────────────────────────────────────────────────────────────────────────

type ParsedCreate = ParsedPoolGroupWrite & {
  /** A proposal's group (its first account), when it only adds chains. */
  group?: PublicKey
  groupId: PublicKey
  callerChoseId: boolean
  maxBpsFee: number
  openMembership: boolean
  minCCVActivationDelay: bigint
  roles: PoolGroupRoles
  chains: bigint[]
  /** What the caller passed explicitly: on a resume only these are compared and written. */
  requested: {
    maxBpsFee?: number
    openMembership?: boolean
    minCCVActivationDelay?: bigint
    roles: Partial<PoolGroupRoles>
  }
}

/** Creates a pool group, with roles and chains. */
export class CreatePoolGroup extends PoolGroupWriteOperation<
  CreatePoolGroupParams,
  ParsedCreate,
  CreatePoolGroupResult
> {
  readonly name = 'createPoolGroup'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(params: SolanaGenerateParams<CreatePoolGroupParams>): ParsedCreate {
    const program = parsePoolGroupProgram(this.name, params)
    const base = parseWriteBase(this.name, program, params)
    const maxBpsFee = params.maxBpsFee ?? DEFAULT_MAX_BPS_FEE
    validateInteger(this.name, 'maxBpsFee', maxBpsFee, 0, MAX_FEE_BPS)
    if (params.openMembership !== undefined && typeof params.openMembership !== 'boolean')
      throw new CCTParamsInvalidError(this.name, 'openMembership', 'must be a boolean')
    const updates =
      params.initialRoles === undefined
        ? {}
        : parseRoles(this.name, 'initialRoles', params.initialRoles)
    const authority = base.authority.toBase58()
    const roles: PoolGroupRoles = rolesFrom((r) =>
      r in updates ? (updates[r] ?? null) : authority,
    )
    const chains = params.initialChains ?? []
    if (!Array.isArray(chains))
      throw new CCTParamsInvalidError(this.name, 'initialChains', 'must be an array')
    chains.forEach((c, i) => validateSelector(this.name, `initialChains[${i}]`, c))
    validateUniqueChainSelectors(this.name, 'initialChains', chains)
    if (chains.length > MAX_POOL_GROUP_CHAINS)
      throw new CCTParamsInvalidError(
        this.name,
        'initialChains',
        `a pool group has at most ${MAX_POOL_GROUP_CHAINS} chains`,
      )
    return {
      ...base,
      groupId:
        params.poolGroupId === undefined
          ? Keypair.generate().publicKey
          : parsePublicKey(this.name, 'poolGroupId', params.poolGroupId),
      callerChoseId: params.poolGroupId !== undefined,
      maxBpsFee,
      openMembership: params.openMembership ?? false,
      minCCVActivationDelay:
        params.minCCVActivationDelay === undefined
          ? DEFAULT_MIN_CCV_ACTIVATION_DELAY
          : parseDelay(this.name, params.minCCVActivationDelay),
      roles,
      chains,
      requested: {
        ...(params.maxBpsFee !== undefined && { maxBpsFee }),
        ...(params.openMembership !== undefined && { openMembership: params.openMembership }),
        ...(params.minCCVActivationDelay !== undefined && {
          minCCVActivationDelay: parseDelay(this.name, params.minCCVActivationDelay),
        }),
        roles: updates,
      },
    }
  }

  /**
   * A new group: `create_group` + `set_group_roles` as the first item (atomic, so the squatting
   * guard holds), then one `add_group_chain` per chain. An existing group the authority owns (an
   * earlier run's first transaction landed): a resume, with `set_group_settings` and
   * `set_group_roles` for what differs from the request first, then the missing chains. Anyone
   * else's: refused.
   * @throws {@link CCTParamsInvalidError} if someone else owns a group at the id, or a resume asks
   *   for a higher fee cap
   * @throws {@link CCTOperationUnsupportedError} if the program has no pool groups
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedCreate,
  ): Promise<PoolGroupWritePlan<CreatePoolGroupResult>> {
    const { program, authority, groupId } = parsed
    const group = parsed.group ?? poolGroupPdas.group(program, groupId)
    const client = createPoolGroupProgram(chain, program, parsed.payer)
    const [existing, clock] = await getMultipleAccountsInfoPaged(chain.connection, [
      group,
      SYSVAR_CLOCK_PUBKEY,
    ])
    const decoded = existing ? decodeOwned('group', existing, group, program) : null
    const extra = {
      poolGroupAddress: group.toBase58(),
      poolGroupId: (decoded?.groupId ?? groupId).toBase58(),
      resumed: !!decoded,
    }
    if (decoded && !decoded.owner.equals(authority))
      throw new CCTParamsInvalidError(
        this.name,
        'poolGroupId',
        `a pool group at ${group.toBase58()} already exists and is owned by ${decoded.owner.toBase58()}: a known id can be front-run, so leave poolGroupId unset (a fresh random id)`,
      )
    if (!decoded) {
      const features = await getPoolGroupProgramFeatures(chain, program)
      if (!features.includes('groups'))
        throw new CCTOperationUnsupportedError(this.name, 'missing', {
          context: { poolProgram: program.toBase58(), feature: 'groups' },
        })
      if (parsed.callerChoseId)
        chain.logger.warn(
          `${this.name}: poolGroupId ${groupId.toBase58()} was chosen by the caller; anyone who sees it can create the group first (the op then refuses). Leave it unset for a fresh random id`,
        )
    }
    const have = new Set((decoded?.chainSelectors ?? []).map((s) => toBigInt(s)))
    const missing = parsed.chains.filter((c) => !have.has(c))
    if (decoded && have.size + missing.length > MAX_POOL_GROUP_CHAINS)
      throw new CCTParamsInvalidError(
        this.name,
        'initialChains',
        `the pool group already has ${have.size} chains; ${missing.length} more exceed ${MAX_POOL_GROUP_CHAINS}`,
      )
    const signerRoles = { [authority.toBase58()]: 'pool-group-owner' } as const
    const items: PoolGroupPackItem[] = []
    let expected: Record<string, unknown> = { 'group.exists': false }
    let judged = false
    if (!decoded) {
      const create = await client.methods
        .createGroup({
          groupId,
          maxBpsFee: parsed.maxBpsFee,
          openMembership: parsed.openMembership,
          minCcvActivationDelay: new BN(parsed.minCCVActivationDelay.toString()),
        })
        .accountsStrict({
          group,
          authority,
          systemProgram: SystemProgram.programId,
          ...eventAccounts(program),
        })
        .instruction()
      const roles = await client.methods
        .setGroupRoles({ roles: toIdlRoles(parsed.roles) })
        .accountsStrict({ group, authority, ...eventAccounts(program) })
        .instruction()
      items.push({
        tokenAddresses: [],
        instructions: [create, roles],
        createdPdas: [group],
        signerRoles,
      })
    } else {
      // a resume: the settings and roles the caller asked for, where the group differs
      const now = orThrow(clockUnixTimestamp(clock), SYSVAR_CLOCK_PUBKEY.toBase58())
      const { requested } = parsed
      const current = {
        maxBpsFee: decoded.maxBpsFee,
        openMembership: decoded.openMembership,
        minCCVActivationDelay: minCCVActivationDelayOf(decoded, now),
        roles: decodeRoles(decoded.roles),
      }
      if (requested.maxBpsFee !== undefined && requested.maxBpsFee > current.maxBpsFee)
        throw new CCTParamsInvalidError(
          this.name,
          'maxBpsFee',
          `the existing pool group's fee cap is ${current.maxBpsFee} bps and can only be lowered: pass at most that, or leave maxBpsFee unset`,
        )
      const settings = {
        maxBpsFee: requested.maxBpsFee ?? current.maxBpsFee,
        openMembership: requested.openMembership ?? current.openMembership,
        minCCVActivationDelay: requested.minCCVActivationDelay,
      }
      const lowering = settings.maxBpsFee < current.maxBpsFee
      if (
        lowering ||
        settings.openMembership !== current.openMembership ||
        (settings.minCCVActivationDelay !== undefined &&
          settings.minCCVActivationDelay !== current.minCCVActivationDelay)
      ) {
        items.push({
          tokenAddresses: [],
          instructions: [
            await client.methods
              .setGroupSettings({
                maxBpsFee: settings.maxBpsFee,
                openMembership: settings.openMembership,
                minCcvActivationDelay:
                  settings.minCCVActivationDelay === undefined
                    ? null
                    : new BN(settings.minCCVActivationDelay.toString()),
                hookLookupTable: null,
              })
              .accountsStrict({ group, authority, ...eventAccounts(program) })
              .remainingAccounts(
                lowering ? chainRecordMetas(program, group, decoded.chainSelectors) : [],
              )
              .instruction(),
          ],
          signerRoles,
        })
        judged = lowering
      }
      // roles a bare create_group left unset take the defaults; otherwise only the ones passed
      const unset = ROLE_NAMES.every((r) => current.roles[r] === null)
      const roles: PoolGroupRoles = unset ? parsed.roles : { ...current.roles, ...requested.roles }
      if (ROLE_NAMES.some((r) => roles[r] !== current.roles[r]))
        items.push({
          tokenAddresses: [],
          instructions: [
            await client.methods
              .setGroupRoles({ roles: toIdlRoles(roles) })
              .accountsStrict({ group, authority, ...eventAccounts(program) })
              .instruction(),
          ],
          signerRoles,
        })
      expected = {
        'group.owner': decoded.owner.toBase58(),
        'group.chainSelectors': [...have].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        'group.maxBpsFee': current.maxBpsFee,
        'group.openMembership': current.openMembership,
        'group.minCCVActivationDelay': current.minCCVActivationDelay,
        'group.roles': current.roles,
      }
    }
    // after the settings: a chain added now copies the cap they set
    for (const selector of missing) {
      const record = poolGroupPdas.groupChain(program, group, selector)
      items.push({
        tokenAddresses: [],
        instructions: [
          await client.methods
            .addGroupChain({ remoteChainSelector: new BN(selector.toString()) })
            .accountsStrict({
              group,
              authority,
              groupChainPolicy: record,
              systemProgram: SystemProgram.programId,
              ...eventAccounts(program),
            })
            .instruction(),
        ],
        createdPdas: [record],
        signerRoles,
      })
    }
    // a new group: the chains after the first transaction cannot be simulated (nor land) before
    // it, so they are a resume (same id) once it has landed; the signed form runs it at once
    let deferred: bigint[] = []
    if (!decoded) {
      const fit = await firstTransactionItemCount({
        operation: this.name,
        chain,
        payer: parsed.payer,
        items,
        ...(parsed.budget && { budget: parsed.budget }),
        ...(parsed.durableNonces && { durableNonces: parsed.durableNonces }),
      })
      deferred = missing.slice(fit - 1)
      items.splice(fit)
    }
    return {
      group,
      items,
      // a new group has no lanes, and chain records start with lanes off; a resume that lowers the
      // cap changes the chain records its lanes read
      judge: judged ? { failsClosedSeverity: 'error' } : null,
      expected,
      extra,
      ...(deferred.length && {
        followUps: () => [
          {
            operation: 'createPoolGroup',
            reason: `${deferred.length} chain(s) did not fit the first transaction and need the group it creates: once it has landed, run createPoolGroup again with the same poolGroupId (a resume builds only the missing chains)`,
            inputs: { poolGroupId: groupId.toBase58(), initialChains: deferred },
          },
        ],
      }),
    }
  }

  /**
   * Signs and sends; chains that did not fit the first transaction are added by resuming (same
   * id) once it has landed, until every chain is there.
   */
  override async execute(
    chain: SolanaChain,
    params: SolanaExecuteParams<CreatePoolGroupParams>,
  ): Promise<PoolGroupExecuteResult & CreatePoolGroupResult> {
    const first = await super.execute(chain, params)
    const transactions = [...first.transactions]
    let last = first
    // at most MAX_POOL_GROUP_CHAINS / 1 resumes; each adds at least one chain
    for (let i = 0; i < MAX_POOL_GROUP_CHAINS; i++) {
      if (!last.followUps?.some((f) => f.operation === this.name)) break
      last = await super.execute(chain, { ...params, poolGroupId: first.poolGroupId })
      transactions.push(...last.transactions)
    }
    const { followUps: lastFollowUps, ...rest } = last
    const followUps = lastFollowUps?.filter((f) => f.operation !== this.name) ?? []
    return {
      ...rest,
      poolGroupAddress: first.poolGroupAddress,
      poolGroupId: first.poolGroupId,
      resumed: first.resumed,
      transactions,
      ...(followUps.length && { followUps }),
    }
  }

  /** The create (and chain) instructions of a proposal. */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedCreate {
    const ixs = decodeOne(
      this.name,
      instructions,
      ['createGroup', 'setGroupRoles', 'setGroupSettings', 'addGroupChain'],
      false,
    )
    const authority = ixs[0]!.ix.keys[1]!.pubkey
    const create = ixs.find((i) => i.name === 'createGroup')
    const roles = ixs.find((i) => i.name === 'setGroupRoles')
    const settings = ixs.find((i) => i.name === 'setGroupSettings')
    const groupId = create ? keyField(this.name, create.data, 'params', 'groupId') : null
    const source = create ?? settings
    const decodedRoles = rolesFrom((r) =>
      roles ? keyOrNull(keyField(this.name, roles.data, 'params', 'roles', r)) : null,
    )
    const delay = bigField(field(source?.data, 'params', 'minCcvActivationDelay'))
    const maxBpsFee = field(source?.data, 'params', 'maxBpsFee')
    const openMembership = field(source?.data, 'params', 'openMembership')
    return {
      payer: authority,
      authority,
      program: ref.program,
      guardOptions,
      group: ixs[0]!.ix.keys[0]!.pubkey,
      groupId: groupId ?? PublicKey.default,
      // a proposal's id is in it already: no front-running warning on the re-check
      callerChoseId: false,
      maxBpsFee: Number(maxBpsFee ?? DEFAULT_MAX_BPS_FEE),
      openMembership: openMembership === true,
      minCCVActivationDelay: delay ?? 0n,
      roles: decodedRoles,
      chains: ixs
        .filter((i) => i.name === 'addGroupChain')
        .map((i) => bigField(field(i.data, 'params', 'remoteChainSelector')) ?? 0n),
      // a resume proposal: what its settings and roles instructions write
      requested: {
        ...(settings && {
          maxBpsFee: Number(maxBpsFee),
          openMembership: openMembership === true,
          ...(delay !== undefined && { minCCVActivationDelay: delay }),
        }),
        roles: roles ? decodedRoles : {},
      },
    }
  }
}

// ─── roles ───────────────────────────────────────────────────────────────────────────────────

type ParsedGroupWrite = ParsedPoolGroupWrite & { ref: ParsedPoolGroupRef }

/** Parses the ref and the shared write fields. */
function parseGroupWrite(
  operation: string,
  params: SolanaGenerateParams<SetPoolGroupRolesParams | AcceptPoolGroupOwnershipParams>,
): ParsedGroupWrite {
  const ref = parsePoolGroupRef(operation, params)
  return { ...parseWriteBase(operation, ref.program, params), ref }
}

/** A ref for a proposal's group, from the check's ref. */
const proposalBase = (
  ref: ParsedPoolGroupRef,
  authority: PublicKey,
  guardOptions: PoolGroupGuardOptions,
): ParsedGroupWrite => ({ payer: authority, authority, program: ref.program, guardOptions, ref })

type ParsedRoles = ParsedGroupWrite & { roles: Partial<PoolGroupRoles> }

/** Sets pool group roles, merged with the current ones. */
export class SetPoolGroupRoles extends PoolGroupWriteOperation<
  SetPoolGroupRolesParams,
  ParsedRoles
> {
  readonly name = 'setPoolGroupRoles'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(params: SolanaGenerateParams<SetPoolGroupRolesParams>): ParsedRoles {
    const roles = parseRoles(this.name, 'roles', params.roles)
    if (!Object.keys(roles).length)
      throw new CCTParamsInvalidError(this.name, 'roles', 'must set at least one role')
    return { ...parseGroupWrite(this.name, params), roles }
  }

  /** `set_group_roles` with every role: the current ones, overwritten by `roles`. */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedRoles,
  ): Promise<PoolGroupWritePlan<object>> {
    const { ref, authority } = parsed
    const { group } = await readPoolGroup(this.name, chain, ref)
    requireOwner(this.name, group.owner, authority, 'set_group_roles')
    const current = decodeRoles(group.roles)
    const merged = { ...current, ...parsed.roles }
    const ix = await createPoolGroupProgram(chain, ref.program, parsed.payer)
      .methods.setGroupRoles({ roles: toIdlRoles(merged) })
      .accountsStrict({ group: ref.group, authority, ...eventAccounts(ref.program) })
      .instruction()
    return {
      group: ref.group,
      items: [
        {
          tokenAddresses: [],
          instructions: [ix],
          signerRoles: { [authority.toBase58()]: 'pool-group-owner' },
        },
      ],
      judge: {},
      expected: { 'group.owner': group.owner.toBase58(), 'group.roles': current },
      extra: {},
    }
  }

  /** The roles a proposal sets (all seven). */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedRoles {
    const [one] = decodeOne(this.name, instructions, ['setGroupRoles'])
    const roles = rolesFrom((r) => keyOrNull(keyField(this.name, one!.data, 'params', 'roles', r)))
    return { ...proposalBase(ref, one!.ix.keys[1]!.pubkey, guardOptions), roles }
  }
}

// ─── settings ────────────────────────────────────────────────────────────────────────────────

type ParsedSettings = ParsedGroupWrite & {
  maxBpsFee?: number
  openMembership?: boolean
  minCCVActivationDelay?: bigint
  /** `null` clears; `undefined` keeps. */
  hookLookupTable?: PublicKey | null
}

/** Changes the fee cap, membership, CCV notice or hook lookup table. */
export class SetPoolGroupSettings extends PoolGroupWriteOperation<
  SetPoolGroupSettingsParams,
  ParsedSettings
> {
  readonly name = 'setPoolGroupSettings'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid, or none is given */
  protected override prepare(
    params: SolanaGenerateParams<SetPoolGroupSettingsParams>,
  ): ParsedSettings {
    const base = parseGroupWrite(this.name, params)
    if (params.maxBpsFee !== undefined)
      validateInteger(this.name, 'maxBpsFee', params.maxBpsFee, 0, MAX_FEE_BPS)
    if (params.openMembership !== undefined && typeof params.openMembership !== 'boolean')
      throw new CCTParamsInvalidError(this.name, 'openMembership', 'must be a boolean')
    const parsed: ParsedSettings = {
      ...base,
      ...(params.maxBpsFee !== undefined && { maxBpsFee: params.maxBpsFee }),
      ...(params.openMembership !== undefined && { openMembership: params.openMembership }),
      ...(params.minCCVActivationDelay !== undefined && {
        minCCVActivationDelay: parseDelay(this.name, params.minCCVActivationDelay),
      }),
      ...(params.hookLookupTable !== undefined && {
        hookLookupTable:
          params.hookLookupTable === null
            ? null
            : parsePublicKey(this.name, 'hookLookupTable', params.hookLookupTable),
      }),
    }
    if (
      parsed.maxBpsFee === undefined &&
      parsed.openMembership === undefined &&
      parsed.minCCVActivationDelay === undefined &&
      parsed.hookLookupTable === undefined
    )
      throw new CCTParamsInvalidError(
        this.name,
        'maxBpsFee',
        'pass at least one of maxBpsFee, openMembership, minCCVActivationDelay and hookLookupTable',
      )
    return parsed
  }

  /**
   * `set_group_settings` with the cap and membership merged; a lower cap passes every chain record
   * (writable); a new hook table goes last, after it is checked active and frozen.
   * @throws {@link CCTParamsInvalidError} if the cap would rise, the table is not an active frozen
   *   lookup table, or a lane is left failing closed (a named FEE policy above the new cap)
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedSettings,
  ): Promise<PoolGroupWritePlan<object>> {
    const { ref, authority } = parsed
    const { group, now } = await readPoolGroup(this.name, chain, ref)
    requireOwner(this.name, group.owner, authority, 'set_group_settings')
    const maxBpsFee = parsed.maxBpsFee ?? group.maxBpsFee
    if (maxBpsFee > group.maxBpsFee)
      throw new CCTParamsInvalidError(
        this.name,
        'maxBpsFee',
        `the fee cap can only be lowered: it is ${group.maxBpsFee} bps (MaxBpsFeeCanOnlyDecrease)`,
      )
    const lowering = maxBpsFee < group.maxBpsFee
    const remaining: AccountMeta[] = lowering
      ? chainRecordMetas(ref.program, ref.group, group.chainSelectors)
      : []
    if (parsed.hookLookupTable) {
      const table = parsed.hookLookupTable
      const { value } = await chain.connection.getAddressLookupTable(table)
      const [info] = await getMultipleAccountsInfoPaged(chain.connection, [table])
      if (!value || !info?.owner.equals(AddressLookupTableProgram.programId))
        throw new CCTParamsInvalidError(
          this.name,
          'hookLookupTable',
          `${table.toBase58()} is not an address lookup table`,
        )
      if (!value.isActive())
        throw new CCTParamsInvalidError(this.name, 'hookLookupTable', 'the table is deactivated')
      if (value.state.authority)
        throw new CCTParamsInvalidError(
          this.name,
          'hookLookupTable',
          `the table still has an authority (${value.state.authority.toBase58()}), who could change or close it under the pool group: freeze it first (freezeLookupTable)`,
        )
      remaining.push({ pubkey: table, isSigner: false, isWritable: false })
    }
    const ix = await createPoolGroupProgram(chain, ref.program, parsed.payer)
      .methods.setGroupSettings({
        maxBpsFee,
        openMembership: parsed.openMembership ?? group.openMembership,
        minCcvActivationDelay:
          parsed.minCCVActivationDelay === undefined
            ? null
            : new BN(parsed.minCCVActivationDelay.toString()),
        hookLookupTable:
          parsed.hookLookupTable === undefined
            ? null
            : (parsed.hookLookupTable ?? PublicKey.default),
      })
      .accountsStrict({ group: ref.group, authority, ...eventAccounts(ref.program) })
      .remainingAccounts(remaining)
      .instruction()
    return {
      group: ref.group,
      items: [
        {
          tokenAddresses: [],
          instructions: [ix],
          signerRoles: { [authority.toBase58()]: 'pool-group-owner' },
        },
      ],
      // a lower cap makes a lane whose FEE policy charges more fail closed: refused, not a warning
      judge: { failsClosedSeverity: 'error' },
      expected: {
        'group.owner': group.owner.toBase58(),
        'group.maxBpsFee': group.maxBpsFee,
        'group.openMembership': group.openMembership,
        'group.minCCVActivationDelay': minCCVActivationDelayOf(group, now),
        'group.hookLookupTable': keyOrNull(group.hookLookupTable),
        ...(lowering && { 'group.chainSelectors': group.chainSelectors.map(toBigInt) }),
      },
      extra: {},
    }
  }

  /** The settings a proposal writes. */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedSettings {
    const [one] = decodeOne(this.name, instructions, ['setGroupSettings'])
    const data = one!.data
    const delay = field(data, 'params', 'minCcvActivationDelay')
    const table = field(data, 'params', 'hookLookupTable')
    return {
      ...proposalBase(ref, one!.ix.keys[1]!.pubkey, guardOptions),
      maxBpsFee: Number(field(data, 'params', 'maxBpsFee')),
      openMembership: field(data, 'params', 'openMembership') === true,
      ...(bigField(delay) !== undefined && { minCCVActivationDelay: bigField(delay) }),
      ...(table instanceof PublicKey && {
        hookLookupTable: table.equals(PublicKey.default) ? null : table,
      }),
    }
  }
}

// ─── ownership ───────────────────────────────────────────────────────────────────────────────

type ParsedTransfer = ParsedGroupWrite & { proposedOwner: PublicKey }

/** Proposes a new pool group owner. */
export class TransferPoolGroupOwnership extends PoolGroupWriteOperation<
  TransferPoolGroupOwnershipParams,
  ParsedTransfer
> {
  readonly name = 'transferPoolGroupOwnership'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(
    params: SolanaGenerateParams<TransferPoolGroupOwnershipParams>,
  ): ParsedTransfer {
    const proposedOwner = parsePublicKey(this.name, 'proposedOwner', params.proposedOwner)
    if (proposedOwner.equals(PublicKey.default))
      throw new CCTParamsInvalidError(this.name, 'proposedOwner', 'must not be the default key')
    return { ...parseGroupWrite(this.name, params), proposedOwner }
  }

  /** `transfer_group_ownership`; a pending proposal is replaced (it cannot be cancelled). */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedTransfer,
  ): Promise<PoolGroupWritePlan<object>> {
    const { ref, authority, proposedOwner } = parsed
    const { group } = await readPoolGroup(this.name, chain, ref)
    requireOwner(this.name, group.owner, authority, 'transfer_group_ownership')
    if (proposedOwner.equals(group.owner))
      throw new CCTParamsInvalidError(this.name, 'proposedOwner', 'is already the owner')
    const pending = keyOrNull(group.proposedOwner)
    if (pending && pending !== proposedOwner.toBase58())
      chain.logger.warn(
        `${this.name}: replaces the pending proposal to ${pending}, which can then no longer accept`,
      )
    const ix = await createPoolGroupProgram(chain, ref.program, parsed.payer)
      .methods.transferGroupOwnership({ proposedOwner })
      .accountsStrict({ group: ref.group, authority, ...eventAccounts(ref.program) })
      .instruction()
    return {
      group: ref.group,
      items: [
        {
          tokenAddresses: [],
          instructions: [ix],
          signerRoles: { [authority.toBase58()]: 'pool-group-owner' },
        },
      ],
      judge: {},
      expected: { 'group.owner': group.owner.toBase58(), 'group.proposedOwner': pending },
      extra: {},
    }
  }

  /** The owner a proposal proposes. */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedTransfer {
    const [one] = decodeOne(this.name, instructions, ['transferGroupOwnership'])
    return {
      ...proposalBase(ref, one!.ix.keys[1]!.pubkey, guardOptions),
      proposedOwner: keyField(this.name, one!.data, 'params', 'proposedOwner'),
    }
  }
}

type ParsedAccept = ParsedGroupWrite

/** Accepts pool group ownership: every role cleared, SECURITY reset. */
export class AcceptPoolGroupOwnership extends PoolGroupWriteOperation<
  AcceptPoolGroupOwnershipParams,
  ParsedAccept
> {
  readonly name = 'acceptPoolGroupOwnership'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(
    params: SolanaGenerateParams<AcceptPoolGroupOwnershipParams>,
  ): ParsedAccept {
    return parseGroupWrite(this.name, params)
  }

  /**
   * `accept_group_ownership` with every chain record (writable). Lanes the SECURITY reset leaves
   * failing closed are warnings; `followUps` lists the new team's writes.
   * @throws {@link CCTParamsInvalidError} if `authority` is not the proposed owner
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedAccept,
  ): Promise<PoolGroupWritePlan<object>> {
    const { ref, authority } = parsed
    const { group } = await readPoolGroup(this.name, chain, ref)
    const proposed = keyOrNull(group.proposedOwner)
    if (proposed !== authority.toBase58())
      throw new CCTParamsInvalidError(
        this.name,
        'authority',
        proposed
          ? `${authority.toBase58()} is not the proposed owner (${proposed}), who alone signs accept_group_ownership`
          : 'no ownership transfer is pending: the owner proposes one with transferPoolGroupOwnership',
      )
    const records = chainRecordMetas(ref.program, ref.group, group.chainSelectors)
    const policyIds = Array.from({ length: group.nextPolicyId }, (_, i) => i)
    const policyKeys = policyIds.map((id) => poolGroupPdas.policy(ref.program, ref.group, id))
    const infos = await getMultipleAccountsInfoPaged(chain.connection, [
      ...records.map((r) => r.pubkey),
      ...policyKeys,
    ])
    // the hook lists the default and the chain records name: their admins keep them
    const lists = new Set<string>()
    const addLists = (
      hook: { allowlist: PublicKey | null; blocklist: PublicKey | null } | null,
    ) => {
      for (const l of [hook?.allowlist, hook?.blocklist]) if (l) lists.add(l.toBase58())
    }
    addLists(group.defaultPolicy.security.hook)
    records.forEach((r, i) => {
      const info = infos[i]
      if (info)
        addLists(decodeOwned('groupChainPolicy', info, r.pubkey, ref.program).policy.security.hook)
    })
    const policies = policyIds.flatMap((policyId, i) => {
      const info = infos[records.length + i]
      return info
        ? [{ policyId, policy: decodeOwned('policy', info, policyKeys[i]!, ref.program) }]
        : []
    })
    const securityPolicies = policies
      .filter(({ policy }) => (policy.classes & SECURITY_BIT) !== 0)
      .map(({ policyId }) => policyId)
    // named SECURITY policies name hook lists too: their defaults and their chain records
    const policyRecords = policies.flatMap(({ policyId, policy }) =>
      (policy.classes & SECURITY_BIT) === 0
        ? []
        : policy.chainSelectors.map((c) =>
            poolGroupPdas.policyChain(
              ref.program,
              poolGroupPdas.policy(ref.program, ref.group, policyId),
              toBigInt(c),
            ),
          ),
    )
    for (const { policy } of policies)
      if ((policy.classes & SECURITY_BIT) !== 0) addLists(policy.defaultPolicy.security.hook)
    const recordInfos = await getMultipleAccountsInfoPaged(chain.connection, policyRecords)
    recordInfos.forEach((info, i) => {
      if (info)
        addLists(
          decodeOwned('policyChainRecord', info, policyRecords[i]!, ref.program).sections.security
            .hook,
        )
    })
    const listInfos = await getMultipleAccountsInfoPaged(
      chain.connection,
      [...lists].map((l) => new PublicKey(l)),
    )
    const previousOwner = group.owner.toBase58()
    const ownerLists = [...lists].filter((l, i) => {
      const info = listInfos[i]
      if (!info?.owner.equals(ref.program)) return false
      const kind = info.data.subarray(0, 8).equals(ALLOWLIST_DISCRIMINATOR)
        ? 'allowlist'
        : 'blocklist'
      const admin = decodeOwned(kind, info, new PublicKey(l), ref.program).admin
      return admin.toBase58() === previousOwner
    })
    const roles = decodeRoles(group.roles)
    const hookTable = keyOrNull(group.hookLookupTable)
    const ix = await createPoolGroupProgram(chain, ref.program, parsed.payer)
      .methods.acceptGroupOwnership()
      .accountsStrict({ group: ref.group, authority, ...eventAccounts(ref.program) })
      .remainingAccounts(records)
      .instruction()
    const followUps = (judgement: PoolGroupJudgement | null): PoolGroupFollowUp[] => {
      const bySelector = new Map<bigint, string[]>()
      for (const l of judgement?.failingClosed ?? [])
        bySelector.set(l.remoteChainSelector, [
          ...(bySelector.get(l.remoteChainSelector) ?? []),
          l.tokenAddress,
        ])
      return [
        ...(ROLE_NAMES.some((r) => roles[r] !== null)
          ? [
              {
                operation: 'setPoolGroupRoles',
                reason:
                  'accepting clears every role, so keys the previous owner appointed keep no power: assign the new team its roles',
              },
            ]
          : []),
        ...securityPolicies.map((policyId) => ({
          operation: 'resetPoolGroupPolicySecurity',
          reason: `named SECURITY policy ${policyId} carries the previous security generation: lanes taking SECURITY from it fail closed until it is reset`,
          inputs: { policyId },
        })),
        ...[...bySelector].map(([remoteChainSelector, tokenAddresses]) => ({
          operation: 'syncPoolGroupCCVs',
          reason:
            'these lanes fail closed after the SECURITY reset (a cancelled pending CCV set, or a stale named SECURITY policy): reset any named policy, then re-sync',
          inputs: { remoteChainSelector, tokenAddresses },
        })),
        ...ownerLists.map((list) => ({
          operation: 'transferPoolGroupListAdmin',
          reason: `the hook list ${list} is administered by the previous owner ${previousOwner}, who must hand it over (acceptPoolGroupListAdmin by the new admin)`,
          inputs: { list },
        })),
        ...(hookTable
          ? [
              {
                operation: 'setPoolGroupSettings',
                reason: `the hook lookup table ${hookTable} was set by the previous team: check its contents, or replace it with hookLookupTable`,
              },
            ]
          : []),
      ]
    }
    return {
      group: ref.group,
      items: [
        {
          tokenAddresses: [],
          instructions: [ix],
          signerRoles: { [authority.toBase58()]: 'pool-group-owner' },
        },
      ],
      // the reset is what accepting does: lanes it leaves failing closed (now, or when a cancelled
      // pending CCV set a lane copied comes due) are reported, with fixes; a hand-over is never
      // blocked, so lanes it opens are reported too
      judge: { failsClosedSeverity: 'warning', goingLiveSeverity: 'warning' },
      expected: {
        'group.owner': previousOwner,
        'group.proposedOwner': proposed,
        'group.roles': roles,
        'group.chainSelectors': group.chainSelectors.map(toBigInt),
        'group.securityGeneration': group.securityGeneration,
      },
      followUps,
      extra: {},
    }
  }

  /** The proposed owner of a proposal (its signer). */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedAccept {
    const [one] = decodeOne(this.name, instructions, ['acceptGroupOwnership'])
    return proposalBase(ref, one!.ix.keys[1]!.pubkey, guardOptions)
  }
}

/** The lifecycle ops, by name: the snapshot check runs their re-checks. @internal */
export const POOL_GROUP_LIFECYCLE_OPERATIONS = {
  createPoolGroup: new CreatePoolGroup(),
  setPoolGroupRoles: new SetPoolGroupRoles(),
  setPoolGroupSettings: new SetPoolGroupSettings(),
  transferPoolGroupOwnership: new TransferPoolGroupOwnership(),
  acceptPoolGroupOwnership: new AcceptPoolGroupOwnership(),
}
