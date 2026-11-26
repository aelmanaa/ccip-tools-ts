/**
 * Compute-budget instructions found by **instruction tag**, never by program ID alone.
 *
 * @remarks The ComputeBudget program carries several instructions that are not interchangeable: a
 * heap-frame request (tag 1) that some core callers place next to their main instruction, a
 * compute-unit limit (tag 2) and a compute-unit price (tag 3). Simulation and send must only touch
 * the limit and the price, and leave a heap frame where its caller put it. A transaction may carry
 * at most one instruction per tag; a second one fails with `DuplicateInstruction`.
 *
 * @packageDocumentation
 */

import { Buffer } from 'buffer'

import { type TransactionInstruction, ComputeBudgetProgram } from '@solana/web3.js'

/** ComputeBudget instruction tag of `RequestHeapFrame { bytes: u32 }`. */
export const REQUEST_HEAP_FRAME_TAG = 1
/** ComputeBudget instruction tag of `SetComputeUnitLimit { units: u32 }`. */
export const SET_COMPUTE_UNIT_LIMIT_TAG = 2
/** ComputeBudget instruction tag of `SetComputeUnitPrice { microLamports: u64 }`. */
export const SET_COMPUTE_UNIT_PRICE_TAG = 3

/** Whether `ix` is the ComputeBudget instruction with the given tag. */
export function isComputeBudgetInstruction(ix: TransactionInstruction, tag: number): boolean {
  return ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === tag
}

/** Index of the first ComputeBudget instruction with `tag` in `instructions`, or -1. */
export function findComputeBudgetInstruction(
  instructions: readonly TransactionInstruction[],
  tag: number,
): number {
  return instructions.findIndex((ix) => isComputeBudgetInstruction(ix, tag))
}

/**
 * The compute-unit limit an embedded `SetComputeUnitLimit` sets, or undefined when there is none.
 * @param instructions - The transaction's instructions.
 */
export function readComputeUnitLimit(
  instructions: readonly TransactionInstruction[],
): number | undefined {
  const ix = instructions[findComputeBudgetInstruction(instructions, SET_COMPUTE_UNIT_LIMIT_TAG)]
  // a malformed (short) instruction carries no readable limit; the runtime rejects it anyway
  return ix && ix.data.length >= 5 ? Buffer.from(ix.data).readUInt32LE(1) : undefined
}

/**
 * The price (micro-lamports per compute unit) an embedded `SetComputeUnitPrice` sets, or undefined
 * when there is none.
 * @param instructions - The transaction's instructions.
 */
export function readComputeUnitPrice(
  instructions: readonly TransactionInstruction[],
): bigint | undefined {
  const ix = instructions[findComputeBudgetInstruction(instructions, SET_COMPUTE_UNIT_PRICE_TAG)]
  return ix && ix.data.length >= 9 ? Buffer.from(ix.data).readBigUInt64LE(1) : undefined
}

/**
 * Returns a copy of `instructions` with the embedded compute-unit limit replaced in place (same
 * index), or `undefined` when there is no limit to replace, so the caller decides whether to
 * prepend one. Never mutates the input.
 * @param instructions - The transaction's instructions.
 * @param units - The new limit.
 */
export function replaceComputeUnitLimit(
  instructions: readonly TransactionInstruction[],
  units: number,
): TransactionInstruction[] | undefined {
  const index = findComputeBudgetInstruction(instructions, SET_COMPUTE_UNIT_LIMIT_TAG)
  if (index < 0) return
  const out = [...instructions]
  out[index] = ComputeBudgetProgram.setComputeUnitLimit({ units })
  return out
}

/**
 * Returns `instructions` with a compute-unit limit of `units`: the embedded one replaced in place,
 * or else a new one prepended. Never mutates the input.
 * @param instructions - The transaction's instructions.
 * @param units - The limit.
 * @returns The instructions, and whether a limit was prepended (shifting every index by one).
 */
export function withComputeUnitLimit(
  instructions: readonly TransactionInstruction[],
  units: number,
): { instructions: TransactionInstruction[]; prepended: boolean } {
  const inPlace = replaceComputeUnitLimit(instructions, units)
  if (inPlace) return { instructions: inPlace, prepended: false }
  return {
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units }), ...instructions],
    prepended: true,
  }
}

/**
 * The heap-frame size in bytes an embedded `RequestHeapFrame` requests, or undefined when there is
 * none.
 * @param instructions - The transaction's instructions.
 */
export function readHeapFrameBytes(
  instructions: readonly TransactionInstruction[],
): number | undefined {
  const ix = instructions[findComputeBudgetInstruction(instructions, REQUEST_HEAP_FRAME_TAG)]
  return ix && ix.data.length >= 5 ? Buffer.from(ix.data).readUInt32LE(1) : undefined
}

/**
 * Returns a copy of `instructions` with the embedded compute-unit price set to `microLamports` in
 * place, or the input unchanged when there is no price. Simulation uses it with `0`, so a raised
 * simulation limit is never priced against a payer with little SOL.
 * @param instructions - The transaction's instructions.
 * @param microLamports - The new price per compute unit.
 */
export function replaceComputeUnitPrice(
  instructions: readonly TransactionInstruction[],
  microLamports: number | bigint,
): readonly TransactionInstruction[] {
  const index = findComputeBudgetInstruction(instructions, SET_COMPUTE_UNIT_PRICE_TAG)
  if (index < 0) return instructions
  const out = [...instructions]
  out[index] = ComputeBudgetProgram.setComputeUnitPrice({ microLamports })
  return out
}

/**
 * The total priority fee in lamports of `limit` compute units at `microLamports` per unit, rounded
 * up, as the runtime charges it. A v1 transaction carries this total in its `transactionConfig`
 * instead of a per-unit price.
 * @param microLamports - Price per compute unit, from `SetComputeUnitPrice`.
 * @param limit - The transaction's compute-unit limit.
 */
export function totalPriorityFeeLamports(microLamports: bigint, limit: number): bigint {
  const microTotal = microLamports * BigInt(limit)
  return (microTotal + 999_999n) / 1_000_000n
}
