import { Buffer } from 'buffer'

import {
  type TransactionInstruction,
  PublicKey,
  SystemProgram,
  TransactionMessage,
} from '@solana/web3.js'
import bs58 from 'bs58'

import type { UnsignedSolanaTx } from '../../solana/types.ts'
import { CCTParamsInvalidError } from '../errors.ts'
import { parsePublicKey } from './validate.ts'

/** Supported serialized transaction encodings. */
export type SerializedSolanaTxEncoding = 'base58' | 'base64' | 'hex'

/**
 * A durable nonce a transaction is built on: the nonce account and the authority that advances it.
 * Set by the CCT builders that accept durable nonces, which place the `AdvanceNonceAccount`
 * instruction first; the serializer only takes the nonce's current value as the blockhash.
 */
export type SolanaDurableNonce = {
  /** The nonce account whose stored value replaces the blockhash. */
  nonceAccount: string
  /** The authority that signs `AdvanceNonceAccount` for it. */
  nonceAuthority: string
}

/** Options of `serializeUnsignedTx`. */
export type SerializeUnsignedTxOptions = {
  /** Output encoding; default `'base58'`. */
  encoding?: SerializedSolanaTxEncoding
  /**
   * The durable nonce's current value, used as the blockhash: read it with
   * `(await connection.getNonce(new PublicKey(durableNonce.nonceAccount)))?.nonce`. Required when
   * the transaction has a `durableNonce`, refused otherwise.
   */
  nonce?: string
}

const OPERATION = 'serializeUnsignedTx'

/** Every encoding, so a new {@link SerializedSolanaTxEncoding} member fails to compile until listed. */
const ENCODERS = {
  base58: (bytes: Buffer) => bs58.encode(bytes),
  base64: (bytes: Buffer) => bytes.toString('base64'),
  hex: (bytes: Buffer) => bytes.toString('hex'),
} satisfies Record<SerializedSolanaTxEncoding, (bytes: Buffer) => string>

function isEncoding(encoding: string): encoding is SerializedSolanaTxEncoding {
  return Object.hasOwn(ENCODERS, encoding)
}

// SystemProgram instruction index of `AdvanceNonceAccount` (u32 little-endian)
const ADVANCE_NONCE_ACCOUNT_INDEX = 4

/** Whether an instruction is a System program `AdvanceNonceAccount`. @internal */
export function isAdvanceNonceInstruction(ix: TransactionInstruction): boolean {
  return (
    ix.programId.equals(SystemProgram.programId) &&
    ix.data.length >= 4 &&
    ix.data.readUInt32LE(0) === ADVANCE_NONCE_ACCOUNT_INDEX
  )
}

/** The nonce account a leading `AdvanceNonceAccount` instruction advances, if the first one is one. */
function advancedNonceAccount(instructions: readonly TransactionInstruction[]): string | undefined {
  const first = instructions[0]
  if (!first || !isAdvanceNonceInstruction(first)) return
  return first.keys[0]?.pubkey.toBase58()
}

/** Whether `value` is a nonce value: 32 base58-encoded bytes, the same shape as a public key. */
function isNonceValue(value: string): boolean {
  try {
    parsePublicKey(OPERATION, 'nonce', value)
    return true
  } catch {
    return false
  }
}

/**
 * Serializes an unsigned Solana tx into one message for external signing: a legacy message, or a
 * v0 message when the transaction carries address lookup tables.
 *
 * @param connection - Fetches the latest blockhash when the transaction has no durable nonce.
 * @param unsigned - The instructions, optional lookup tables and optional durable nonce.
 * @param payer - The fee payer.
 * @param encodingOrOpts - An encoding (the original positional form) or
 * {@link SerializeUnsignedTxOptions}.
 * @returns The encoded message.
 * @throws {@link CCTParamsInvalidError} if the encoding is unsupported; the transaction has a
 * durable nonce and no valid `nonce` value, or does not start by advancing that nonce; the
 * transaction starts with `AdvanceNonceAccount` but carries no `durableNonce`; or a `nonce` is given
 * for a transaction without one
 */
export async function serializeUnsignedSolanaTx(
  connection: { getLatestBlockhash: () => Promise<{ blockhash: string }> },
  unsigned: Pick<UnsignedSolanaTx, 'instructions' | 'lookupTables'> & {
    durableNonce?: SolanaDurableNonce
  },
  payer: PublicKey | string,
  encodingOrOpts: string | SerializeUnsignedTxOptions = 'base58',
): Promise<string> {
  const { encoding = 'base58', nonce } =
    typeof encodingOrOpts === 'string' ? { encoding: encodingOrOpts } : encodingOrOpts

  // validated before any RPC
  if (!isEncoding(encoding))
    throw new CCTParamsInvalidError(
      OPERATION,
      'encoding',
      `unsupported Solana transaction encoding: ${String(encoding)}; use one of ${Object.keys(ENCODERS).join(', ')}`,
    )
  const advanced = advancedNonceAccount(unsigned.instructions)
  const { durableNonce } = unsigned
  if (durableNonce) {
    if (!nonce)
      throw new CCTParamsInvalidError(
        OPERATION,
        'nonce',
        `the transaction is built on durable nonce ${durableNonce.nonceAccount}; pass { nonce } as the third argument, read with (await connection.getNonce(new PublicKey('${durableNonce.nonceAccount}')))?.nonce`,
      )
    if (!isNonceValue(nonce))
      throw new CCTParamsInvalidError(
        OPERATION,
        'nonce',
        `must be the nonce value stored in ${durableNonce.nonceAccount} (a base58 string of 32 bytes)`,
      )
    if (advanced !== durableNonce.nonceAccount)
      throw new CCTParamsInvalidError(
        OPERATION,
        'durableNonce',
        `the first instruction must advance nonce account ${durableNonce.nonceAccount}; rebuild the transaction with that nonce`,
      )
  } else {
    if (advanced)
      throw new CCTParamsInvalidError(
        OPERATION,
        'durableNonce',
        `the transaction starts by advancing nonce account ${advanced} but carries no durableNonce; keep the durableNonce field the builder returned, or a fresh blockhash would expire the transaction`,
      )
    if (nonce)
      throw new CCTParamsInvalidError(
        OPERATION,
        'nonce',
        'the transaction has no durable nonce, and a nonce value would replace its blockhash so it never lands; drop nonce',
      )
  }

  const payerKey = typeof payer === 'string' ? new PublicKey(payer) : payer
  const recentBlockhash = nonce ?? (await connection.getLatestBlockhash()).blockhash
  const message = new TransactionMessage({
    payerKey,
    recentBlockhash,
    instructions: unsigned.instructions,
  })
  const serialized = Buffer.from(
    unsigned.lookupTables?.length
      ? message.compileToV0Message(unsigned.lookupTables).serialize()
      : message.compileToLegacyMessage().serialize(),
  )
  return ENCODERS[encoding](serialized)
}
