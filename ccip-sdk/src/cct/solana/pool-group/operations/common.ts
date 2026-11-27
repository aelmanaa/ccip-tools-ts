/**
 * Shared parsing and account reads of the pool-group queries.
 *
 * @packageDocumentation
 */

import type { Buffer } from 'buffer'

import { AnchorError, ProgramError } from '@coral-xyz/anchor'
import {
  type AccountInfo,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SendTransactionError,
  SolanaJSONRPCError,
} from '@solana/web3.js'
import bs58 from 'bs58'

import type { SolanaChain } from '../../../../solana/index.ts'
import {
  getInstructionError,
  getMultipleAccountsInfoPaged,
  isSimulationFailure,
} from '../../../../solana/utils.ts'
import {
  CCTDataDecodeError,
  CCTOperationUnsupportedError,
  CCTParamsInvalidError,
} from '../../../errors.ts'
import { TOKEN_POOL_PROGRAMS } from '../../programs/token-pool.ts'
import {
  U64_MAX,
  parseOptionalPublicKey,
  parsePublicKey,
  validateBigInt,
  validateUniquePublicKeys,
} from '../../validate.ts'
import {
  POOL_GROUP_MEMBER_DISCRIMINATOR,
  decodePoolGroupIdlAccount,
  decodePoolGroupMember,
  poolGroupPdas,
} from '../accounts.ts'
import { type Unread, clockUnixTimestamp, isUnread } from '../lane.ts'
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

/**
 * Parses an optional list of mints (`tokenAddresses`): unique public keys.
 * @throws {@link CCTParamsInvalidError} if it is not an array, or an entry is invalid or repeated
 * @internal
 */
export function parseTokenAddresses(operation: string, value: unknown): PublicKey[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value))
    throw new CCTParamsInvalidError(operation, 'tokenAddresses', 'must be an array')
  const mints = value.map((t: unknown, i) => parsePublicKey(operation, `tokenAddresses[${i}]`, t))
  validateUniquePublicKeys(operation, 'tokenAddresses', mints)
  return mints
}

/** Validates a `u64` chain selector. @internal */
export function validateSelector(operation: string, param: string, value: unknown): bigint {
  validateBigInt(operation, param, value, 1n, U64_MAX)
  return value
}

/**
 * Reads and decodes the pool group, with the cluster clock and `extra` accounts in the same paged
 * `getMultipleAccountsInfo` (one slot for all); refuses a group owned by someone other than
 * `expectedOwner`.
 * @returns The group, the cluster's unix time, and each extra account (null where absent).
 * @throws {@link CCTParamsInvalidError} if no group exists there, or its owner is not `expectedOwner`
 * @throws {@link CCTDataDecodeError} if the account is not a `Group` of the program, or the clock
 *   cannot be read
 * @internal
 */
export async function readPoolGroup(
  operation: string,
  chain: SolanaChain,
  { program, group, expectedOwner }: ParsedPoolGroupRef,
  extra: readonly PublicKey[] = [],
) {
  const [account, clock, ...extras] = await getMultipleAccountsInfoPaged(chain.connection, [
    group,
    SYSVAR_CLOCK_PUBKEY,
    ...extra,
  ])
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
  const now = orThrow(clockUnixTimestamp(clock), SYSVAR_CLOCK_PUBKEY.toBase58())
  return { group: decoded, now, extras }
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
  return decodePoolGroupIdlAccount(
    name,
    decodeOwnedData(account, address, program),
    address.toBase58(),
  )
}

/**
 * An account's data, after checking the pool program owns it.
 * @throws {@link CCTDataDecodeError} if another program owns it
 * @internal
 */
export function decodeOwnedData(
  account: AccountInfo<Buffer>,
  address: PublicKey,
  program: PublicKey,
): Buffer {
  if (!account.owner.equals(program))
    throw new CCTDataDecodeError(address.toBase58(), {
      context: { reason: `owned by ${account.owner.toBase58()}, not the pool program` },
    })
  return account.data
}

/**
 * Whether a view's error is the program refusing its simulation. Anchor's `.view()` replaces the
 * SDK's simulation failure with its own `AnchorError` / `ProgramError` when the logs or the custom
 * code name a program error, so all three count; anything else is a transport failure.
 * @internal
 */
export function isViewRefusal(err: unknown): boolean {
  return isSimulationFailure(err) || err instanceof AnchorError || err instanceof ProgramError
}

/**
 * Rethrows a refused simulation of a view as `CCTOperationUnsupportedError` (with the instruction
 * error and logs); any other error (transport) propagates unchanged.
 * @throws {@link CCTOperationUnsupportedError} if `err` is a failed simulation
 * @throws `err` otherwise
 * @internal
 */
export function simulationRefused(operation: string, err: unknown, view: string): never {
  if (!isViewRefusal(err)) throw err
  throw new CCTOperationUnsupportedError(operation, 'unknown', {
    cause: err instanceof Error ? err : undefined,
    context: {
      reason: `the pool program refused the ${view} simulation`,
      instructionError:
        getInstructionError(err)?.error ?? (err instanceof Error ? err.message : undefined),
      logs:
        err instanceof SendTransactionError ||
        err instanceof ProgramError ||
        err instanceof AnchorError
          ? err.logs
          : undefined,
    },
  })
}

/** Throws an `Unread` as `CCTDataDecodeError`; passes anything else through. @internal */
export function orThrow<T>(value: T | Unread, account: string): T {
  if (isUnread(value)) throw new CCTDataDecodeError(account, { context: { reason: value.reason } })
  return value
}

/** JSON-RPC codes RPCs answer a refused `getProgramAccounts` with. */
const GPA_REFUSAL_CODES: readonly unknown[] = [-32010, -32601]

/**
 * Whether `err` is an RPC refusing `getProgramAccounts`: a JSON-RPC error with a refusal code, or
 * the HTTP 403/410 status web3.js reports as the message's leading status. Anything else (a
 * timeout, a 429, a slot error) is not a refusal.
 * @internal
 */
export function isGetProgramAccountsRefusal(err: unknown): boolean {
  if (err instanceof SolanaJSONRPCError) return GPA_REFUSAL_CODES.includes(err.code)
  return err instanceof Error && /^(403|410) /.test(err.message)
}

/** What a caller can do instead of a refused `getProgramAccounts`. @internal */
export type GetProgramAccountsAlternative = {
  /** The param that avoids the scan, or `'connection'` when only another RPC helps. */
  param: string
  /** How. */
  fix: string
}

/**
 * `getProgramAccounts`, turning an RPC refusal into a `CCTParamsInvalidError` that names the
 * caller's alternative; other errors propagate unchanged.
 * @internal
 */
export async function listProgramAccounts(
  operation: string,
  chain: SolanaChain,
  program: PublicKey,
  filters: { memcmp: { offset: number; bytes: string } }[],
  instead: GetProgramAccountsAlternative,
) {
  try {
    return await chain.connection.getProgramAccounts(program, { filters })
  } catch (err) {
    if (!isGetProgramAccountsRefusal(err)) throw err
    throw new CCTParamsInvalidError(
      operation,
      instead.param,
      `the RPC refuses getProgramAccounts (${err instanceof Error ? err.message : String(err)}); ${instead.fix}`,
      { cause: err instanceof Error ? err : undefined },
    )
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
  instead: GetProgramAccountsAlternative = {
    param: 'tokenAddresses',
    fix: 'pass tokenAddresses explicitly',
  },
) {
  const accounts = await listProgramAccounts(
    operation,
    chain,
    program,
    [memcmp(0, POOL_GROUP_MEMBER_DISCRIMINATOR), memcmp(10, group.toBytes())],
    instead,
  )
  return accounts.map(({ pubkey, account }) => ({
    address: pubkey,
    member: decodePoolGroupMember(account.data, pubkey.toBase58()),
  }))
}
