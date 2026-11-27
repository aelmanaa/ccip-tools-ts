/**
 * Helpers every pool-group write op shares: instruction accounts, proposal decoding for the
 * snapshot re-checks, the owner gate and the parsed write base.
 *
 * @packageDocumentation
 */

import { BN } from '@coral-xyz/anchor'
import { type AccountMeta, type TransactionInstruction, PublicKey } from '@solana/web3.js'

import { CCTParamsInvalidError } from '../../../errors.ts'
import type { SolanaGenerateParams } from '../../operation.ts'
import { deriveEventAuthorityPda } from '../../programs/token-pool.ts'
import { poolGroupPdas, poolGroupsCoder } from '../accounts.ts'
import { decodeRoles, toBigInt } from '../decode.ts'
import type { PoolGroupPolicyClass } from '../types.ts'
import { type ParsedPoolGroupWrite, parseWriteBase } from '../write-operation.ts'
import type { PoolGroupGuardOptions, PoolGroupWriteParams } from '../write-types.ts'
import { type ParsedPoolGroupRef, parsePoolGroupRef } from './common.ts'

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
