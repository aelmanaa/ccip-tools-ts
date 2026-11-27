/**
 * The instruction hash a pool-group snapshot binds (`MultiTokenPoolSnapshot.calldataHash` on
 * Solana): keccak256 over the transaction's instructions without compute budget or nonce
 * instructions, which the executor (wallet, Squads) adds or moves.
 *
 * @packageDocumentation
 */

import { Buffer } from 'buffer'

import { type TransactionInstruction, SystemProgram } from '@solana/web3.js'
import { keccak256 } from 'ethers'

import { isComputeBudgetInstruction } from '../../../solana/compute-budget.ts'

/** `SystemProgram` instruction index of `AdvanceNonceAccount` (u32 little-endian). */
const ADVANCE_NONCE = 4

/** Whether an instruction is the executor's: a compute-budget limit/price/heap, or a nonce advance. */
function isExecutorInstruction(ix: TransactionInstruction): boolean {
  if ([1, 2, 3].some((tag) => isComputeBudgetInstruction(ix, tag))) return true
  return (
    ix.programId.equals(SystemProgram.programId) &&
    ix.data.length >= 4 &&
    ix.data.readUInt32LE(0) === ADVANCE_NONCE
  )
}

/**
 * keccak256 of the pool-group instructions of a transaction, in order: per instruction the program
 * (32 bytes), the account count (u16 LE) and each account (32 bytes, then a flags byte: 1 = signer,
 * 2 = writable), the data length (u32 LE) and the data. Compute-budget and nonce instructions are
 * left out, so the same write hashes the same on the wallet and Squads paths.
 * @param instructions - The transaction's instructions.
 * @returns The `0x` hash.
 * @internal
 */
export function poolGroupInstructionsHash(instructions: readonly TransactionInstruction[]): string {
  const parts: Buffer[] = []
  for (const ix of instructions) {
    if (isExecutorInstruction(ix)) continue
    const count = Buffer.alloc(2)
    count.writeUInt16LE(ix.keys.length)
    const length = Buffer.alloc(4)
    length.writeUInt32LE(ix.data.length)
    parts.push(
      ix.programId.toBuffer(),
      count,
      ...ix.keys.flatMap((k) => [
        k.pubkey.toBuffer(),
        Buffer.from([(k.isSigner ? 1 : 0) | (k.isWritable ? 2 : 0)]),
      ]),
      length,
      Buffer.from(ix.data),
    )
  }
  return keccak256(Buffer.concat(parts))
}
