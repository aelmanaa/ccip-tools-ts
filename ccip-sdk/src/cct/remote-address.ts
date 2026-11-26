/**
 * Cross-family parser for a lane's *remote* token or pool address, written in the remote chain's
 * own address format; the family is taken from the lane's selector.
 *
 * @packageDocumentation
 */

import { type BytesLike, hexlify } from 'ethers'

import { type ChainFamily, networkInfo } from '../networks.ts'
import { notRegisteredRecovery, supportedChains } from '../supported-chains.ts'
import { decodeAddress, getAddressBytes } from '../utils.ts'
import { CCTDataDecodeError, CCTParamsInvalidError } from './errors.ts'

/**
 * The chain family of a lane's remote chain selector, or `undefined` for an unknown selector.
 * `networkInfo` also resolves chain IDs, which would key the lane wrong: only an exact selector
 * match counts.
 */
function laneFamilyOf(remoteChainSelector: bigint): ChainFamily | undefined {
  try {
    const info = networkInfo(remoteChainSelector)
    return info.chainSelector === remoteChainSelector ? info.family : undefined
  } catch {
    return undefined
  }
}

/**
 * Parses a remote chain's address into its canonical spelling, validated against the family of
 * `remoteChainSelector`.
 *
 * @remarks Accepts whatever {@link decodeAddress} accepts for that family: plain or 32-byte padded
 * hex for EVM, base58 or 32-byte hex for Solana, hex for Aptos/Sui, and so on. The contract's
 * encoded form therefore still parses.
 *
 * The result is the spelling `getTokenPoolRemotes` returns, so the two compare as plain strings and
 * read output can be passed straight back in. Each op encodes it once, when the tx is built: EVM
 * pools store every remote address left-padded to 32 bytes; Solana pools pad the remote token and
 * keep remote pools at native length.
 *
 * The remote family's chain class must be registered in `supportedChains`; otherwise this throws
 * with the SDK's registration hint rather than falling back to raw bytes.
 * @param operation - Operation name, for the error context.
 * @param param - Param path to blame, e.g. `chainsToAdd[0].remoteTokenAddress`.
 * @param value - The caller-supplied value, unvalidated.
 * @param remoteChainSelector - Selector of the lane's remote chain, already validated as a `uint64`.
 * @returns The canonical address, e.g. checksummed `0x…` for EVM, base58 for Solana.
 * @throws {@link CCTParamsInvalidError} if the selector is not a known CCIP chain selector, its
 * family is not registered, or `value` is not a valid, non-zero address of that family
 */
export function parseRemoteAddress(
  operation: string,
  param: string,
  value: unknown,
  remoteChainSelector: bigint,
): string {
  const family = laneFamilyOf(remoteChainSelector)
  if (family === undefined) {
    throw new CCTParamsInvalidError(
      operation,
      param,
      `cannot be parsed: remote chain selector ${remoteChainSelector} is not a known chain selector, so its address format is unknown; pass a CCIP chain selector (not a chain ID), or upgrade the SDK`,
    )
  }
  if (!supportedChains[family]) {
    throw new CCTParamsInvalidError(
      operation,
      param,
      `cannot be parsed: the ${family} chain family is not registered. ${notRegisteredRecovery(family)}`,
    )
  }
  if (typeof value !== 'string' || !value) {
    throw new CCTParamsInvalidError(
      operation,
      param,
      `must be a non-empty ${family} address string`,
    )
  }
  let address, bytes
  try {
    address = decodeAddress(value, family)
    bytes = getAddressBytes(address)
  } catch (cause) {
    throw new CCTParamsInvalidError(
      operation,
      param,
      `must be a valid ${family} address, got ${value}`,
      { cause: cause instanceof Error ? cause : undefined },
    )
  }
  // `decodeAddress` left-pads short hex, so `0x` or `0x00` would otherwise pass as the zero address
  if (bytes.every((b) => b === 0)) {
    throw new CCTParamsInvalidError(operation, param, 'must not be the zero address')
  }
  return address
}

/**
 * Parses each entry with {@link parseRemoteAddress}, rejecting duplicates.
 * @remarks Duplicates are compared by canonical spelling, so two spellings of one address
 * (checksummed and lower-case, or plain and padded) collide. A hole in a sparse array is parsed
 * as `undefined`, and so rejected.
 * @param operation - Operation name, for the error context.
 * @param param - Array param path; each entry is blamed as `${param}[i]`.
 * @param values - Entries to parse; the caller has already checked it is an array.
 * @param remoteChainSelector - Selector of the lane's remote chain, already validated as a `uint64`.
 * @returns The canonical addresses, in input order.
 * @throws {@link CCTParamsInvalidError} if an entry is invalid or duplicates an earlier one
 */
export function parseUniqueRemoteAddresses(
  operation: string,
  param: string,
  values: readonly unknown[],
  remoteChainSelector: bigint,
): string[] {
  const seen = new Set<string>()
  // `Array.from`, unlike `map`, visits holes
  return Array.from(values, (value, i) => {
    const address = parseRemoteAddress(operation, `${param}[${i}]`, value, remoteChainSelector)
    if (seen.has(address)) {
      throw new CCTParamsInvalidError(
        operation,
        `${param}[${i}]`,
        'must not duplicate an earlier entry in the same array',
      )
    }
    seen.add(address)
    return address
  })
}

/**
 * Decodes a remote address as a lane stores it (raw bytes) into the canonical spelling
 * {@link parseRemoteAddress} accepts and returns, so read output can be passed back into a write.
 *
 * @remarks Falls back to `0x` hex of the stored bytes only when the SDK cannot decode the family
 * here: an unknown selector, or a family not registered in this bundle (e.g. a Solana remote in an
 * EVM-only bundle; import `@chainlink/ccip-sdk/all` to decode every family). Bytes a registered
 * family rejects (e.g. an EVM word with dirty high bytes) are a broken record, not a format choice,
 * so they throw.
 * @param value - The stored bytes (EVM pools left-pad EVM addresses to 32 bytes).
 * @param remoteChainSelector - Selector of the lane's remote chain.
 * @returns The canonical address, or `0x` hex when the family cannot be decoded here.
 * @throws {@link CCTDataDecodeError} if the family is registered and rejects the bytes
 * @internal
 */
export function decodeRemoteAddress(value: BytesLike, remoteChainSelector: bigint): string {
  const family = laneFamilyOf(remoteChainSelector)
  if (family === undefined || !supportedChains[family]) return hexlify(value)
  try {
    return decodeAddress(value, family)
  } catch (cause) {
    throw new CCTDataDecodeError(hexlify(value), {
      cause: cause instanceof Error ? cause : undefined,
      context: {
        remoteChainSelector,
        reason: `the stored remote address is not a valid ${family} address`,
      },
    })
  }
}
