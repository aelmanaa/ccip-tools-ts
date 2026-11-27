/**
 * The instruction hash a pool-group snapshot binds (`MultiTokenPoolSnapshot.calldataHash` on
 * Solana): keccak256 over the transactions' instructions without compute-budget or nonce
 * instructions, which the executor (wallet, Squads) adds or moves.
 *
 * @packageDocumentation
 */

import { Buffer } from 'buffer'

import { type TransactionInstruction, ComputeBudgetProgram } from '@solana/web3.js'
import { concat, keccak256 } from 'ethers'

import { isAdvanceNonceInstruction } from '../serialize.ts'

/** Whether an instruction is the executor's: any compute-budget instruction, or a nonce advance. */
function isExecutorInstruction(ix: TransactionInstruction): boolean {
  return ix.programId.equals(ComputeBudgetProgram.programId) || isAdvanceNonceInstruction(ix)
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

/**
 * The hash a snapshot binds for the ordered transactions of one write: the instruction hash of a
 * single transaction, else keccak256 over each transaction's instruction hash, in order. A
 * multi-transaction step is therefore checked as its whole ordered set.
 * @param transactions - The write's transactions, in order.
 * @returns The `0x` hash.
 * @internal
 */
export function poolGroupTransactionsHash(
  transactions: readonly { instructions: readonly TransactionInstruction[] }[],
): string {
  const hashes = transactions.map((tx) => poolGroupInstructionsHash(tx.instructions))
  return hashes.length === 1 ? hashes[0]! : keccak256(concat(hashes))
}
