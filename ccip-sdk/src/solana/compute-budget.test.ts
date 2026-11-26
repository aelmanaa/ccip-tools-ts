/**
 * Compute-budget instructions are found by tag (2 = limit, 3 = price), never by program ID, so a
 * heap-frame request (tag 1) stays where core callers put it. Simulation raises an embedded limit
 * in place and zeroes an embedded price; send keeps the embedded limit; the v1 fallback moves both
 * into its transactionConfig. Callers that embed neither behave exactly as before.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  type Connection,
  type MessageV1,
  type VersionedTransaction,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from '@solana/web3.js'

import { CCIPArgumentInvalidError } from '../errors/index.ts'
import {
  REQUEST_HEAP_FRAME_TAG,
  SET_COMPUTE_UNIT_LIMIT_TAG,
  SET_COMPUTE_UNIT_PRICE_TAG,
  findComputeBudgetInstruction,
  readComputeUnitLimit,
  readComputeUnitPrice,
  replaceComputeUnitLimit,
  replaceComputeUnitPrice,
  totalPriorityFeeLamports,
} from './compute-budget.ts'
import { keypairWallet, mockSendConnection } from './send.test.helpers.ts'
import { getInstructionError, simulateAndSendTxs, simulateTransaction } from './utils.ts'
import { compileV1Message } from './v1.ts'

const PAYER = Keypair.fromSeed(Buffer.alloc(32, 1))
const PROGRAM = new PublicKey('Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C')
const BLOCKHASH = '11111111111111111111111111111112'

function ix(accounts = 2, dataLength = 8): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM,
    keys: Array.from({ length: accounts }, (_, i) => ({
      pubkey: i === 0 ? PAYER.publicKey : Keypair.fromSeed(Buffer.alloc(32, i + 10)).publicKey,
      isSigner: i === 0,
      isWritable: true,
    })),
    data: Buffer.alloc(dataLength, 7),
  })
}

const heap = () => ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 })
const limit = (units: number) => ComputeBudgetProgram.setComputeUnitLimit({ units })
const price = (microLamports: number) => ComputeBudgetProgram.setComputeUnitPrice({ microLamports })

/** Decodes the compute-budget instructions of a compiled v0 message, in order, as `tag:value`. */
function budgetOf(tx: VersionedTransaction): string[] {
  const keys = tx.message.staticAccountKeys
  return tx.message.compiledInstructions
    .filter((c) => keys[c.programIdIndex]!.equals(ComputeBudgetProgram.programId))
    .map((c) => {
      const data = Buffer.from(c.data)
      if (data[0] === SET_COMPUTE_UNIT_PRICE_TAG) return `3:${data.readBigUInt64LE(1)}`
      return `${data[0]}:${data.readUInt32LE(1)}`
    })
}

const mockConnection = mockSendConnection
const wallet = keypairWallet(PAYER)

describe('compute-budget helpers', () => {
  it('finds instructions by tag, never mistaking a heap frame for a limit', () => {
    const ixs = [heap(), ix(), limit(300_000), price(10_000)]
    assert.equal(findComputeBudgetInstruction(ixs, REQUEST_HEAP_FRAME_TAG), 0)
    assert.equal(findComputeBudgetInstruction(ixs, SET_COMPUTE_UNIT_LIMIT_TAG), 2)
    assert.equal(findComputeBudgetInstruction(ixs, SET_COMPUTE_UNIT_PRICE_TAG), 3)
    assert.equal(readComputeUnitLimit(ixs), 300_000)
    assert.equal(readComputeUnitPrice(ixs), 10_000n)
    assert.equal(readComputeUnitLimit([heap(), ix()]), undefined)
    assert.equal(readComputeUnitPrice([heap(), ix()]), undefined)
  })

  it('replaces in place without mutating the input', () => {
    const ixs = [ix(), limit(300_000), price(10_000)]
    const raised = replaceComputeUnitLimit(ixs, 1_400_000)!
    assert.equal(readComputeUnitLimit(raised), 1_400_000)
    assert.equal(findComputeBudgetInstruction(raised, SET_COMPUTE_UNIT_LIMIT_TAG), 1)
    assert.equal(readComputeUnitLimit(ixs), 300_000)
    assert.equal(replaceComputeUnitLimit([ix()], 1), undefined)
    const free = replaceComputeUnitPrice(ixs, 0)
    assert.equal(readComputeUnitPrice(free), 0n)
    assert.equal(readComputeUnitPrice(ixs), 10_000n)
    const none = [ix()]
    assert.equal(replaceComputeUnitPrice(none, 0), none)
  })

  it('rounds the total priority fee up to whole lamports', () => {
    assert.equal(totalPriorityFeeLamports(10_000n, 200_000), 2_000n)
    assert.equal(totalPriorityFeeLamports(1n, 1), 1n)
    assert.equal(totalPriorityFeeLamports(0n, 1_400_000), 0n)
  })
})

describe('simulateTransaction with compute-budget instructions', () => {
  it('prepends a limit when none is embedded, keeping a heap frame where it was', async () => {
    const { connection, simulated } = mockConnection()
    await simulateTransaction(
      { connection },
      { payerKey: PAYER.publicKey, instructions: [heap(), ix()] },
    )
    assert.deepEqual(budgetOf(simulated[0]!), ['2:1400000', '1:262144'])
  })

  it('raises an embedded limit in place and zeroes an embedded price', async () => {
    const { connection, simulated } = mockConnection()
    await simulateTransaction(
      { connection },
      { payerKey: PAYER.publicKey, instructions: [limit(300_000), price(10_000), ix()] },
    )
    assert.deepEqual(budgetOf(simulated[0]!), ['2:1400000', '3:0'])
  })

  it('maps instruction errors to the caller index with and without insertion', async () => {
    const failing = () => ({ logs: [], err: { InstructionError: [2, { Custom: 6 }] } })
    const prepended = mockConnection(failing)
    const e1 = await simulateTransaction(
      { connection: prepended.connection },
      { payerKey: PAYER.publicKey, instructions: [heap(), ix(), ix()] },
    ).catch((e: unknown) => e)
    assert.deepEqual(getInstructionError(e1), { index: 1, error: { Custom: 6 } })

    const embedded = mockConnection(failing)
    const e2 = await simulateTransaction(
      { connection: embedded.connection },
      { payerKey: PAYER.publicKey, instructions: [limit(300_000), ix(), ix()] },
    ).catch((e: unknown) => e)
    assert.deepEqual(getInstructionError(e2), { index: 2, error: { Custom: 6 } })
  })
})

describe('simulateAndSendTxs with compute-budget instructions', () => {
  it('sends with exactly the caller-placed heap frame plus one limit (exec-v2/send-v2 shape)', async () => {
    const { connection, sent } = mockConnection()
    await simulateAndSendTxs({ connection }, wallet, { instructions: [heap(), ix()] })
    // simulated 250k > 200k, so a limit of 275k is prepended next to the heap frame
    assert.deepEqual(budgetOf(sent[0]!), ['2:275000', '1:262144'])
  })

  it('keeps an embedded limit and price, adding no second limit', async () => {
    const { connection, sent } = mockConnection()
    await simulateAndSendTxs({ connection }, wallet, {
      instructions: [limit(300_000), price(10_000), ix()],
    })
    assert.deepEqual(budgetOf(sent[0]!), ['2:300000', '3:10000'])
  })

  it('lets the caller computeUnits replace an embedded limit in place', async () => {
    const { connection, sent } = mockConnection()
    await simulateAndSendTxs(
      { connection },
      wallet,
      { instructions: [limit(300_000), price(10_000), ix()], mainIndex: 2 },
      { computeUnits: 500_000 },
    )
    assert.deepEqual(budgetOf(sent[0]!), ['2:500000', '3:10000'])
  })
})

describe('compileV1Message with compute-budget instructions', () => {
  it('moves an embedded limit, price and heap frame into the transactionConfig', () => {
    const message: MessageV1 = compileV1Message({
      payerKey: PAYER.publicKey,
      recentBlockhash: BLOCKHASH,
      instructions: [limit(300_000), price(10_000), heap(), ix()],
      computeUnitLimit: 300_000,
      loadedAccountsDataSizeLimit: 1_000_000,
    })
    assert.equal(message.compiledInstructions.length, 1)
    assert.deepEqual(message.transactionConfig, {
      computeUnitLimit: 300_000,
      heapSize: 256 * 1024,
      loadedAccountsDataSizeLimit: 1_000_000,
      priorityFee: 3_000,
    })
  })

  it('leaves the priority fee unset without an embedded price', () => {
    const message = compileV1Message({
      payerKey: PAYER.publicKey,
      recentBlockhash: BLOCKHASH,
      instructions: [ix()],
      computeUnitLimit: 200_000,
      loadedAccountsDataSizeLimit: 1_000_000,
    })
    assert.equal(message.transactionConfig.priorityFee, null)
  })
})

describe('compute-budget review regressions', () => {
  it('maps a v1-fallback instruction error back past the compute-budget ixs it moved', async () => {
    // a v0 wire too large for the packet forces the raw v1 simulation
    const big = ix(40, 400)
    const connection = {
      simulateTransaction: async () => {
        throw new Error('v0 must not be simulated for an oversized tx')
      },
      _rpcRequest: async () => ({
        result: { value: { logs: [], err: { InstructionError: [0, { Custom: 9 }] } } },
      }),
    } as unknown as Connection
    const error = await simulateTransaction(
      { connection },
      { payerKey: PAYER.publicKey, instructions: [limit(300_000), price(10_000), big] },
    ).catch((e: unknown) => e)
    assert.deepEqual(getInstructionError(error), { index: 2, error: { Custom: 9 } })
  })

  it('treats computeUnits 0 as unset instead of writing a 0 limit over an embedded one', async () => {
    const { connection, sent } = mockConnection()
    await simulateAndSendTxs(
      { connection },
      wallet,
      { instructions: [limit(300_000), ix()], mainIndex: 1 },
      { computeUnits: 0 },
    )
    assert.deepEqual(budgetOf(sent[0]!), ['2:300000'])
  })

  it('refuses a v1 priority fee that a JS number cannot represent', () => {
    assert.throws(
      () =>
        compileV1Message({
          payerKey: PAYER.publicKey,
          recentBlockhash: BLOCKHASH,
          instructions: [
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2n ** 63n }),
            ix(),
          ],
          computeUnitLimit: 1_400_000,
          loadedAccountsDataSizeLimit: 1_000_000,
        }),
      CCIPArgumentInvalidError,
    )
  })

  it('reads no limit or price from a malformed short instruction', () => {
    const short = (tag: number) =>
      new TransactionInstruction({
        programId: ComputeBudgetProgram.programId,
        keys: [],
        data: Buffer.from([tag, 1]),
      })
    assert.equal(readComputeUnitLimit([short(2)]), undefined)
    assert.equal(readComputeUnitPrice([short(3)]), undefined)
  })
})
