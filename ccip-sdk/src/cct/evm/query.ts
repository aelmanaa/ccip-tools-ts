/**
 * EVM CCT reads: {@link Query} bound to an {@link EVMChain}, plus {@link getTypedContract}, the
 * call-typed handle read ops decode through, and {@link isMissingFunction}, the shared test for
 * "this address does not answer that call". Mirrors `cct/solana/query.ts`.
 *
 * @packageDocumentation
 */

import type { Abi } from 'abitype'
import { type InterfaceAbi, Contract, isError } from 'ethers'
import type { TypedContract } from 'ethers-abitype'

import { CCIPTypeVersionInvalidError } from '../../errors/index.ts'
import type { EVMChain } from '../../evm/index.ts'
import { CCTContractTypeInvalidError } from '../errors.ts'
import { Query } from '../query.ts'

/** Shared base for read-only EVM CCT queries; see {@link Query}. */
export abstract class EVMQuery<P extends object, R, Parsed = P> extends Query<
  EVMChain,
  P,
  R,
  Parsed
> {}

/**
 * Binds `address` to `abi` as a call-typed contract for read ops: one value both types the calls
 * and builds the runtime `Interface`.
 * @remarks The CCT layer's single ethers → `ethers-abitype` cast; the library's own
 * `typedContract` would avoid it, but its ESM entry is unusable (`main` resolves to CJS).
 */
export function getTypedContract<const ABI extends Abi>(
  chain: EVMChain,
  address: string,
  abi: ABI & InterfaceAbi,
): TypedContract<ABI> {
  return new Contract(address, abi, chain.provider) as unknown as TypedContract<ABI>
}

/**
 * True for the two failure shapes a call to a function a contract does not declare produces:
 * `CALL_EXCEPTION` (revert) and `BAD_DATA` (node answers `0x`, which is also what an EOA and an
 * undeployed address answer). Deliberately narrow — a transport error or rate limit must not be
 * read as "this contract lacks the function", so callers rethrow anything else untouched.
 */
export function isMissingFunction(err: unknown): boolean {
  return isError(err, 'CALL_EXCEPTION') || isError(err, 'BAD_DATA')
}

/**
 * True when an error means "the address is not a CCIP contract": it does not answer the call
 * ({@link isMissingFunction}) or answers an unparseable `typeAndVersion`. Transport errors are not.
 * @internal
 */
export function isNotCcipContract(err: unknown): boolean {
  return isMissingFunction(err) || err instanceof CCIPTypeVersionInvalidError
}

/**
 * Reads `typeAndVersion` for a contract-type check: an address that is not a CCIP contract becomes
 * {@link CCTContractTypeInvalidError}, and any other failure (a transport error, a rate limit)
 * propagates as it is.
 * @param chain - Chain to read on.
 * @param address - The address.
 * @param expected - The accepted type(s), for the error.
 * @returns The parsed `typeAndVersion` tuple.
 * @throws {@link CCTContractTypeInvalidError} if the address reports no `typeAndVersion`
 * @internal
 */
export async function readContractType(
  chain: EVMChain,
  address: string,
  expected: string,
): Promise<Awaited<ReturnType<EVMChain['typeAndVersion']>>> {
  try {
    return await chain.typeAndVersion(address)
  } catch (cause) {
    if (!isNotCcipContract(cause)) throw cause
    throw new CCTContractTypeInvalidError(
      address,
      expected,
      'unknown',
      'the address reports no typeAndVersion — it has no code, or is not a CCIP contract',
      { cause: cause instanceof Error ? cause : undefined },
    )
  }
}
