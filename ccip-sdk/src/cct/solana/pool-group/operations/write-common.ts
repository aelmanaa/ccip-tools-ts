/**
 * Helpers every pool-group write op shares: instruction accounts, proposal decoding for the
 * snapshot re-checks, the owner gate and the parsed write base.
 *
 * @packageDocumentation
 */

import { BN } from '@coral-xyz/anchor'
import { type AccountMeta, type TransactionInstruction, PublicKey } from '@solana/web3.js'

import type { SolanaChain } from '../../../../solana/index.ts'
import { getMultipleAccountsInfoPaged } from '../../../../solana/utils.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import type { SolanaGenerateParams } from '../../operation.ts'
import { deriveEventAuthorityPda, deriveTokenPoolConfigPda } from '../../programs/token-pool.ts'
import { parsePublicKey } from '../../validate.ts'
import { poolGroupPdas, poolGroupsCoder } from '../accounts.ts'
import { decodeRoles, toBigInt } from '../decode.ts'
import { isUnread } from '../lane.ts'
import { type PoolGroupPackItem, oneTransactionChecks } from '../packer.ts'
import { type PoolState, poolState } from '../remote-lane.ts'
import type { PoolGroupLaneKey, PoolGroupPolicyClass } from '../types.ts'
import { type ParsedPoolGroupWrite, parseWriteBase } from '../write-operation.ts'
import type {
  PoolGroupFollowUp,
  PoolGroupGuardOptions,
  PoolGroupUnsignedResult,
  PoolGroupWriteParams,
} from '../write-types.ts'
import { type ParsedPoolGroupRef, isViewRefusal, parsePoolGroupRef } from './common.ts'

/** The accounts every `#[event_cpi]` instruction ends with. @internal */
export const eventAccounts = (program: PublicKey) => ({
  eventAuthority: deriveEventAuthorityPda(program),
  program,
})

/** A field of a decoded instruction's data, as `unknown`. @internal */
export const field = (o: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>(
    (v, k) => (typeof v === 'object' && v !== null ? Reflect.get(v, k) : undefined),
    o,
  )

/** A decoded integer field (`BN` or number), or `undefined`. @internal */
export function bigField(v: unknown): bigint | undefined {
  if (BN.isBN(v)) return BigInt(v.toString())
  if (typeof v === 'number') return BigInt(v)
  return undefined
}

/** A decoded `PublicKey` field. @internal */
export function keyField(operation: string, o: unknown, ...path: string[]): PublicKey {
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
 * @internal
 */
export function decodeOne(
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

/** The pool group owner check of roles, settings and transfer (`GroupOwnerOnly`). @internal */
export function requireOwner(
  operation: string,
  owner: PublicKey,
  authority: PublicKey,
  ix: string,
): void {
  if (!owner.equals(authority))
    throw new CCTParamsInvalidError(
      operation,
      'authority',
      `${authority.toBase58()} is not the pool group owner (${owner.toBase58()}), who alone signs ${ix}`,
    )
}

/** The group chain records of every chain, in `chain_selectors` order, writable. @internal */
export function chainRecordMetas(
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

/** The CCV notice in force at `now`: a pending decrease applies once its time has come. @internal */
export function minCCVActivationDelayOf(
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

/** A write on an existing pool group, parsed. @internal */
export type ParsedGroupWrite = ParsedPoolGroupWrite & { ref: ParsedPoolGroupRef }

/** Parses the ref and the shared write fields. @internal */
export function parseGroupWrite(
  operation: string,
  params: SolanaGenerateParams<PoolGroupWriteParams>,
): ParsedGroupWrite {
  const ref = parsePoolGroupRef(operation, params)
  return { ...parseWriteBase(operation, ref.program, params), ref }
}

/** A ref for a proposal's group, from the check's ref. @internal */
export const proposalBase = (
  ref: ParsedPoolGroupRef,
  authority: PublicKey,
  guardOptions: PoolGroupGuardOptions,
): ParsedGroupWrite => ({ payer: authority, authority, program: ref.program, guardOptions, ref })

/** The role a pool-group signer acts in, for `requiredSigners`. @internal */
export const signerRole = (
  owner: PublicKey,
  authority: PublicKey,
): 'pool-group-owner' | 'pool-group-role' =>
  owner.equals(authority) ? 'pool-group-owner' : 'pool-group-role'

const holds = (holder: string | null, authority: PublicKey) =>
  holder !== null && holder === authority.toBase58()

/**
 * `Group::can_manage_policies`: the owner or the policy admin (chain records, named policies and
 * their records).
 * @throws {@link CCTParamsInvalidError} (param `authority`) otherwise
 * @internal
 */
export function requirePolicyManager(
  operation: string,
  group: { owner: PublicKey; roles: Parameters<typeof decodeRoles>[0] },
  authority: PublicKey,
  ix: string,
): void {
  if (group.owner.equals(authority) || holds(decodeRoles(group.roles).policyAdmin, authority))
    return
  throw new CCTParamsInvalidError(
    operation,
    'authority',
    `${authority.toBase58()} is neither the pool group owner (${group.owner.toBase58()}) nor its policy admin, who sign ${ix}`,
  )
}

/**
 * `Group::can_write_class`: FEE is the fee admin's alone; any other class the owner, the policy
 * admin or the class admin.
 * @throws {@link CCTParamsInvalidError} (param `authority`) otherwise
 * @internal
 */
export function requireClassWriter(
  operation: string,
  group: { owner: PublicKey; roles: Parameters<typeof decodeRoles>[0] },
  authority: PublicKey,
  cls: PoolGroupPolicyClass,
  ix: string,
): void {
  const roles = decodeRoles(group.roles)
  const admin = {
    connection: roles.connectionAdmin,
    fee: roles.feeAdmin,
    rateLimit: roles.rateLimitAdmin,
    security: roles.securityAdmin,
  }[cls]
  if (cls === 'fee') {
    if (holds(admin, authority)) return
    throw new CCTParamsInvalidError(
      operation,
      'authority',
      `FEE is written by the fee admin alone (${admin ?? 'unset: the owner assigns it with setPoolGroupRoles'}), not ${authority.toBase58()} (${ix})`,
    )
  }
  if (
    group.owner.equals(authority) ||
    holds(roles.policyAdmin, authority) ||
    holds(admin, authority)
  )
    return
  throw new CCTParamsInvalidError(
    operation,
    'authority',
    `${authority.toBase58()} may not write ${cls}: the owner, the policy admin or the ${cls} admin signs ${ix}`,
  )
}

/** `PolicyClass` as the IDL enum value. @internal */
export function idlPolicyClass(cls: PoolGroupPolicyClass) {
  switch (cls) {
    case 'connection':
      return { connection: {} }
    case 'fee':
      return { fee: {} }
    case 'rateLimit':
      return { rateLimit: {} }
    case 'security':
      return { security: {} }
  }
}

/**
 * Splits entries into instructions of as many entries as one transaction fits, each built by
 * `build`; every instruction is one item (judged alone: the entries are disjoint). Greedy by bytes,
 * locks, trace and heap; then each instruction is simulated, and one that runs out of compute, heap
 * or trace is split in halves and rebuilt (S3b M6), since a built instruction cannot be split.
 * @param simulate - `false` for an instruction whose simulation needs an earlier transaction landed.
 * @throws {@link CCTParamsInvalidError} (param `budget`) if one entry does not fit a transaction
 * @internal
 */
export async function fittedItems<E>(
  operation: string,
  chain: SolanaChain,
  parsed: ParsedPoolGroupWrite,
  entries: readonly E[],
  build: (chunk: E[]) => Promise<TransactionInstruction>,
  {
    signerRoles,
    tokenAddressesOf = () => [],
    describe,
    simulate = true,
    checks: injected,
    preludeOf,
  }: {
    /** The signers' roles of every item. */
    signerRoles?: PoolGroupPackItem['signerRoles']
    /** The mints an item's entries touch. */
    tokenAddressesOf?: (chunk: E[]) => string[]
    /** An entry, for the error when one does not fit alone. */
    describe: (entry: E) => string
    /** Whether to size by simulation too; defaults to `true`. */
    simulate?: boolean
    /** The one-transaction checks (tests inject them); defaults to {@link oneTransactionChecks}. */
    checks?: Awaited<ReturnType<typeof oneTransactionChecks>>
    /**
     * Instructions a chunk's transaction carries before its own (fee vault creations): counted when
     * the chunk is fitted, so the item with them still fits one transaction.
     */
    preludeOf?: (chunk: E[]) => TransactionInstruction[]
  },
): Promise<PoolGroupPackItem[]> {
  if (!entries.length) return []
  const itemOf = async (chunk: E[]): Promise<PoolGroupPackItem> => ({
    tokenAddresses: tokenAddressesOf(chunk),
    instructions: [...(preludeOf?.(chunk) ?? []), await build(chunk)],
    ...(signerRoles && { signerRoles }),
  })
  const checks =
    injected ??
    (await oneTransactionChecks({
      operation,
      chain,
      payer: parsed.payer,
      items: [],
      ...(parsed.budget && { budget: parsed.budget }),
      ...(parsed.durableNonces && { durableNonces: parsed.durableNonces }),
    }))
  const chunks: E[][] = []
  let current: E[] = []
  for (const entry of entries) {
    if (await checks.fits([await itemOf([...current, entry])])) {
      current.push(entry)
      continue
    }
    if (!current.length)
      throw new CCTParamsInvalidError(
        operation,
        'budget',
        `${describe(entry)} does not fit a transaction alone`,
      )
    chunks.push(current)
    current = [entry]
  }
  if (current.length) chunks.push(current)
  const items: PoolGroupPackItem[] = []
  const heavy = async (item: PoolGroupPackItem): Promise<boolean> => {
    try {
      return await checks.tooHeavy([item])
    } catch (err) {
      // a program refusal is the write's, with its error name (not a raw "Simulation failed")
      if (!isViewRefusal(err)) throw err
      const logs: unknown = Reflect.get(Object(err), 'logs')
      const lines = Array.isArray(logs)
        ? logs.filter((l): l is string => typeof l === 'string')
        : []
      const named = lines.join('\n').match(/Error Code: (\w+)/)?.[1]
      throw new CCTParamsInvalidError(
        operation,
        'simulation',
        `the write fails when simulated: ${named ?? (err instanceof Error ? err.message : String(err))}`,
        { cause: err instanceof Error ? err : undefined, context: { logs: lines } },
      )
    }
  }
  const sized = async (chunk: E[]): Promise<void> => {
    const item = await itemOf(chunk)
    if (!simulate || !(await heavy(item))) {
      items.push(item)
      return
    }
    if (chunk.length === 1)
      throw new CCTParamsInvalidError(
        operation,
        'budget',
        `${describe(chunk[0]!)} exceeds the compute, heap or instruction-trace limit alone`,
      )
    // splitting after a simulation failure is safe: nothing landed
    const half = Math.ceil(chunk.length / 2)
    await sized(chunk.slice(0, half))
    await sized(chunk.slice(half))
  }
  for (const chunk of chunks) await sized(chunk)
  return items
}

/**
 * Splits lane metas into instructions of as many lanes as one transaction fits ({@link fittedItems}).
 * @internal
 */
export const laneItems = (
  operation: string,
  chain: SolanaChain,
  parsed: ParsedPoolGroupWrite,
  lanes: { mint: PublicKey; metas: AccountMeta[] }[],
  build: (metas: AccountMeta[]) => Promise<TransactionInstruction>,
  signerRoles: PoolGroupPackItem['signerRoles'],
): Promise<PoolGroupPackItem[]> =>
  fittedItems(operation, chain, parsed, lanes, (chunk) => build(chunk.flatMap((l) => l.metas)), {
    ...(signerRoles && { signerRoles }),
    tokenAddressesOf: (chunk) => chunk.map((l) => l.mint.toBase58()),
    describe: (l) => `the lane of ${l.mint.toBase58()}`,
  })

/**
 * The CCV-sync follow-ups of the lanes a judgement leaves failing closed for want of the new CCV
 * copy (`GroupCcvsNotSynced`), by chain; with `policyId`, the named policy's sync
 * (`syncPoolGroupPolicyCCVs`), which alone syncs its lanes (security.rs:336-341).
 * @internal
 */
export function ccvSyncFollowUps(
  judgement: {
    failingClosed: (PoolGroupLaneKey & { code?: string })[]
  } | null,
  reason: string,
  policyId?: number,
): PoolGroupFollowUp[] {
  const bySelector = new Map<bigint, string[]>()
  for (const l of judgement?.failingClosed ?? [])
    if (l.code === undefined || l.code === 'GroupCcvsNotSynced')
      bySelector.set(l.remoteChainSelector, [
        ...(bySelector.get(l.remoteChainSelector) ?? []),
        l.tokenAddress,
      ])
  return [...bySelector].map(([remoteChainSelector, tokenAddresses]) => ({
    operation: policyId === undefined ? 'syncPoolGroupCCVs' : 'syncPoolGroupPolicyCCVs',
    reason,
    inputs: {
      ...(policyId !== undefined && { policyId }),
      remoteChainSelector,
      tokenAddresses,
    },
  }))
}

/**
 * Membership writes hand the pool group's owner and admins the lanes' CONNECTION trust: refuse a
 * group whose owner is not `expectedOwner` (defaults to `authority`).
 * @throws {@link CCTParamsInvalidError} (param `expectedOwner`) otherwise
 * @internal
 */
export function requireExpectedGroupOwner(
  operation: string,
  owner: PublicKey,
  expectedOwner: PublicKey,
): void {
  if (!owner.equals(expectedOwner))
    throw new CCTParamsInvalidError(
      operation,
      'expectedOwner',
      `the pool group is owned by ${owner.toBase58()}, not ${expectedOwner.toBase58()}: its owner, policy admin and connection admin can change what these lanes trust. To proceed, pass expectedOwner: ${owner.toBase58()}`,
    )
}

/**
 * The pool group owner who co-signs a membership write (`require_membership_approved`), or `null`
 * with open membership. One Squads vault signs for one key, so a second signer is refused there.
 * @throws {@link CCTParamsInvalidError} (param `poolGroupOwner`) if it is not the group's owner, or
 *   two signers would be needed under Squads
 * @internal
 */
export function membershipCoSigner(
  operation: string,
  group: { owner: PublicKey; openMembership: boolean },
  poolGroupOwner: PublicKey | undefined,
  authority: PublicKey,
  budget: ParsedPoolGroupWrite['budget'],
): PublicKey | null {
  const owner = group.openMembership ? null : (poolGroupOwner ?? group.owner)
  if (owner && !owner.equals(group.owner))
    throw new CCTParamsInvalidError(
      operation,
      'poolGroupOwner',
      `the pool group owner is ${group.owner.toBase58()}, who co-signs while membership is closed`,
    )
  if (owner && !owner.equals(authority) && budget?.executor === 'squads-v4')
    throw new CCTParamsInvalidError(
      operation,
      'poolGroupOwner',
      'the pool owner and the pool group owner must both sign, and one Squads vault signs for one key: open the membership (setPoolGroupSettings openMembership), or hold both roles in one vault',
    )
  return owner
}

/**
 * The pool `State`s of `mints` under `program`, in one paged read; with `owner`, each must be
 * owned by it (the lane owner gate of the membership and lane writes).
 * @throws {@link CCTParamsInvalidError} if a mint has no pool there, or `owner` does not own it
 * @internal
 */
export async function readPoolStates(
  operation: string,
  chain: SolanaChain,
  program: PublicKey,
  mints: readonly PublicKey[],
  owner?: PublicKey,
): Promise<PoolState[]> {
  const addresses = mints.map((m) => deriveTokenPoolConfigPda(program, m))
  const infos = await getMultipleAccountsInfoPaged(chain.connection, addresses)
  return mints.map((mint, i) => {
    const info = infos[i]
    const pool =
      info?.owner.equals(program) &&
      poolState(addresses[i]!, info, `the pool State of ${mint.toBase58()}`)
    if (!pool || isUnread(pool))
      throw new CCTParamsInvalidError(
        operation,
        'tokenAddresses',
        `${mint.toBase58()} has no pool State under ${program.toBase58()}${pool ? ` (${pool.reason})` : ''}`,
      )
    if (owner && !pool.state.owner.equals(owner))
      throw new CCTParamsInvalidError(
        operation,
        'authority',
        `${owner.toBase58()} does not own the pool of ${mint.toBase58()} (owner ${pool.state.owner.toBase58()}), who signs for its lanes`,
      )
    return pool
  })
}

/**
 * The trust echo of a membership write: the owner, the admins who can rewrite CONNECTION, and the
 * CONNECTION pools the lanes trust by chain.
 * @internal
 */
export function poolGroupTrustOf(
  group: { owner: PublicKey; roles: Parameters<typeof decodeRoles>[0] },
  remotePools: { remoteChainSelector: bigint; addresses: string[] }[],
): NonNullable<PoolGroupUnsignedResult['poolGroupTrust']> {
  const roles = decodeRoles(group.roles)
  return {
    owner: group.owner.toBase58(),
    policyAdmin: roles.policyAdmin,
    connectionAdmin: roles.connectionAdmin,
    remotePools,
  }
}

/** The key of a lane, for sets. @internal */
export const laneId = (l: PoolGroupLaneKey) => `${l.tokenAddress}:${l.remoteChainSelector}`

/**
 * Parses an optional list of lanes (`acknowledgeLiveAdmission`, `confirmInFlightDrained`, ...):
 * canonical mints, each lane once.
 * @throws {@link CCTParamsInvalidError} if it is not an array of lane keys
 * @internal
 */
export function parseLaneKeys(
  operation: string,
  param: string,
  value: unknown,
): PoolGroupLaneKey[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new CCTParamsInvalidError(operation, param, 'must be an array')
  const lanes = value.map((l: unknown, i) => {
    const selector: unknown = Reflect.get(Object(l), 'remoteChainSelector')
    if (typeof selector !== 'bigint' || selector < 1n)
      throw new CCTParamsInvalidError(
        operation,
        `${param}[${i}].remoteChainSelector`,
        'must be a bigint selector',
      )
    return {
      tokenAddress: parsePublicKey(
        operation,
        `${param}[${i}].tokenAddress`,
        Reflect.get(Object(l), 'tokenAddress'),
      ).toBase58(),
      remoteChainSelector: selector,
    }
  })
  return [...new Map(lanes.map((l) => [laneId(l), l])).values()]
}

/** The snapshot path a sealed lane confirmation of `name` is kept at. @internal */
export const sealedPath = (name: string) => `confirm.${name}`

/**
 * A lane confirmation (`acknowledgeLiveAdmission`, `confirmInFlightDrained`, `confirmDroppedLanes`)
 * as an `expected` entry, so the snapshot seals it and the re-check reads it back (M1, as A21 does
 * for `confirmDropped`). @internal
 */
export const sealLanes = (name: string, lanes: readonly PoolGroupLaneKey[]) => ({
  [sealedPath(name)]: [...new Set(lanes.map(laneId))].sort(),
})

/** The lanes a snapshot sealed under `name` (none when absent). @internal */
export function unsealLanes(
  sealed: Readonly<Record<string, unknown>>,
  name: string,
): PoolGroupLaneKey[] {
  const v = sealed[sealedPath(name)]
  if (!Array.isArray(v)) return []
  return v.flatMap((id: unknown) => {
    if (typeof id !== 'string') return []
    const at = id.lastIndexOf(':')
    const selector = id.slice(at + 1)
    return at > 0 && /^\d+$/.test(selector)
      ? [{ tokenAddress: id.slice(0, at), remoteChainSelector: BigInt(selector) }]
      : []
  })
}

/**
 * The mints of pool `State` accounts a proposal names (each a pool State of the program).
 * @throws {@link CCTParamsInvalidError} if one is not
 * @internal
 */
export async function mintsOfPoolStates(
  operation: string,
  chain: SolanaChain,
  program: PublicKey,
  states: readonly PublicKey[],
): Promise<PublicKey[]> {
  const infos = await getMultipleAccountsInfoPaged(chain.connection, [...states])
  return states.map((address, i) => {
    const info = infos[i]
    const pool = info ? poolState(address, info, `the pool State ${address.toBase58()}`) : null
    if (!pool || isUnread(pool) || !pool.program.equals(program))
      throw new CCTParamsInvalidError(
        operation,
        'transactions',
        `${address.toBase58()} is not a pool State of the program`,
      )
    return pool.state.mint
  })
}

/**
 * Every `stride`-th remaining account of a proposal's instructions, from `fixed` (the lanes' first
 * account each, e.g. their pool `State`).
 * @internal
 */
export const everyLane = (
  instructions: readonly { ix: TransactionInstruction }[],
  fixed: number,
  stride: number,
  offset = 0,
): PublicKey[] =>
  instructions.flatMap(({ ix }) =>
    ix.keys
      .slice(fixed)
      .filter((_, i) => i % stride === offset)
      .map((k) => k.pubkey),
  )

/** A decoded `[u8; N]` / `Vec<u8>` field, as numbers. @internal */
export const byteArrayField = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((b): b is number => typeof b === 'number') : []

/** An optional signer a proposal passes (the program ID stands for "none"). @internal */
export const optionalSigner = (key: PublicKey | undefined, program: PublicKey) =>
  key && !key.equals(program) ? key : undefined
