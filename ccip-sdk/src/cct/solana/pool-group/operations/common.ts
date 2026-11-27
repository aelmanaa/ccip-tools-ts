/**
 * Shared parsing and account reads of the pool-group queries.
 *
 * @packageDocumentation
 */

import type { Buffer } from 'buffer'

import { type AccountInfo, PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'

import type { SolanaChain } from '../../../../solana/index.ts'
import { CCTDataDecodeError, CCTParamsInvalidError } from '../../../errors.ts'
import { TOKEN_POOL_PROGRAMS } from '../../programs/token-pool.ts'
import { U64_MAX, parseOptionalPublicKey, parsePublicKey, validateBigInt } from '../../validate.ts'
import {
  POOL_GROUP_MEMBER_DISCRIMINATOR,
  decodePoolGroupIdlAccount,
  decodePoolGroupMember,
  poolGroupPdas,
} from '../accounts.ts'
import { type Unread, isUnread } from '../lane.ts'
import type { PoolGroupProgramRef, PoolGroupRef } from '../types.ts'

/** The pool program of a read: `poolProgramAddress`, else the canonical burn-mint program. @internal */
export function parsePoolGroupProgram(operation: string, ref: PoolGroupProgramRef): PublicKey {
  return (
    parseOptionalPublicKey(operation, 'poolProgramAddress', ref.poolProgramAddress) ??
    new PublicKey(TOKEN_POOL_PROGRAMS['burn-mint'])
  )
}

/** A parsed {@link PoolGroupRef}. @internal */
export type ParsedPoolGroupRef = {
  program: PublicKey
  group: PublicKey
  expectedOwner?: PublicKey
}

/**
 * Parses a {@link PoolGroupRef}: exactly one of `poolGroupAddress` and `poolGroupId`.
 * @throws {@link CCTParamsInvalidError} if neither or both are given, or a key is invalid
 * @internal
 */
export function parsePoolGroupRef(operation: string, ref: PoolGroupRef): ParsedPoolGroupRef {
  const program = parsePoolGroupProgram(operation, ref)
  const byAddress = ref.poolGroupAddress !== undefined
  if (byAddress === (ref.poolGroupId !== undefined))
    throw new CCTParamsInvalidError(
      operation,
      'poolGroupAddress',
      'pass exactly one of poolGroupAddress and poolGroupId',
    )
  const group = byAddress
    ? parsePublicKey(operation, 'poolGroupAddress', ref.poolGroupAddress)
    : poolGroupPdas.group(program, parsePublicKey(operation, 'poolGroupId', ref.poolGroupId))
  const expectedOwner = parseOptionalPublicKey(operation, 'expectedOwner', ref.expectedOwner)
  return { program, group, ...(expectedOwner && { expectedOwner }) }
}

/** Validates a `u64` chain selector. @internal */
export function validateSelector(operation: string, param: string, value: unknown): bigint {
  validateBigInt(operation, param, value, 1n, U64_MAX)
  return value
}

/**
 * Reads and decodes the pool group; refuses one owned by someone other than `expectedOwner`.
 * @throws {@link CCTParamsInvalidError} if no group exists there, or its owner is not `expectedOwner`
 * @throws {@link CCTDataDecodeError} if the account is not a `Group` of the program
 * @internal
 */
export async function readPoolGroup(
  operation: string,
  chain: SolanaChain,
  { program, group, expectedOwner }: ParsedPoolGroupRef,
) {
  const account = await chain.connection.getAccountInfo(group)
  if (!account)
    throw new CCTParamsInvalidError(
      operation,
      'poolGroupAddress',
      `no pool group at ${group.toBase58()}`,
    )
  const decoded = decodeOwned('group', account, group, program)
  if (expectedOwner && !decoded.owner.equals(expectedOwner))
    throw new CCTParamsInvalidError(
      operation,
      'expectedOwner',
      `the pool group is owned by ${decoded.owner.toBase58()}, not ${expectedOwner.toBase58()}`,
    )
  return decoded
}

/**
 * Decodes an IDL account of the program, checking its owner.
 * @throws {@link CCTDataDecodeError} if another program owns it or it does not decode
 * @internal
 */
export function decodeOwned<N extends Parameters<typeof decodePoolGroupIdlAccount>[0]>(
  name: N,
  account: AccountInfo<Buffer>,
  address: PublicKey,
  program: PublicKey,
) {
  if (!account.owner.equals(program))
    throw new CCTDataDecodeError(address.toBase58(), {
      context: { reason: `owned by ${account.owner.toBase58()}, not the pool program` },
    })
  return decodePoolGroupIdlAccount(name, account.data, address.toBase58())
}

/** Throws an `Unread` as `CCTDataDecodeError`; passes anything else through. @internal */
export function orThrow<T>(value: T | Unread, account: string): T {
  if (isUnread(value)) throw new CCTDataDecodeError(account, { context: { reason: value.reason } })
  return value
}

/**
 * `getProgramAccounts`, turning an RPC refusal into a `CCTParamsInvalidError` that says to pass
 * explicit accounts instead.
 * @internal
 */
export async function listProgramAccounts(
  operation: string,
  chain: SolanaChain,
  program: PublicKey,
  filters: { memcmp: { offset: number; bytes: string } }[],
  instead: string,
) {
  try {
    return await chain.connection.getProgramAccounts(program, { filters })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/getProgramAccounts|excluded|not allowed|disabled|-32010|-32601|403|410/i.test(message))
      throw new CCTParamsInvalidError(
        operation,
        'poolProgramAddress',
        `the RPC refuses getProgramAccounts (${message}); ${instead}`,
      )
    throw err
  }
}

/** `bs58` of a memcmp filter's bytes. @internal */
export const memcmp = (offset: number, bytes: Uint8Array) => ({
  memcmp: { offset, bytes: bs58.encode(bytes) },
})

/**
 * The current members of a pool group (`getProgramAccounts` on `GroupMember`, memcmp on the group
 * at offset 10), decoded and owner-checked.
 * @internal
 */
export async function listPoolGroupMembers(
  operation: string,
  chain: SolanaChain,
  program: PublicKey,
  group: PublicKey,
) {
  const accounts = await listProgramAccounts(
    operation,
    chain,
    program,
    [memcmp(0, POOL_GROUP_MEMBER_DISCRIMINATOR), memcmp(10, group.toBytes())],
    'pass tokenAddresses explicitly',
  )
  return accounts.map(({ pubkey, account }) => ({
    address: pubkey,
    member: decodePoolGroupMember(account.data, pubkey.toBase58()),
  }))
}
