/** `fittedItems`: greedy chunks, then the halving split of a chunk the simulation finds too heavy. */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Keypair, TransactionInstruction } from '@solana/web3.js'

import '../../../index.ts'
import { CCTParamsInvalidError } from '../../errors.ts'
import { PROGRAM, chainWith } from './fixtures.test.helpers.ts'
import { fittedItems } from './operations/write-common.ts'
import type { PoolGroupPackItem } from './packer.ts'

const payer = Keypair.generate().publicKey
const parsed = { payer, authority: payer, program: PROGRAM, guardOptions: {} }
/** An instruction carrying one account per entry. */
const build = async (chunk: number[]) =>
  new TransactionInstruction({
    programId: PROGRAM,
    keys: chunk.map(() => ({
      pubkey: Keypair.generate().publicKey,
      isSigner: false,
      isWritable: true,
    })),
    data: Buffer.alloc(0),
  })
const size = (item: PoolGroupPackItem) => item.instructions[0]!.keys.length

describe('fittedItems', () => {
  it('splits a chunk in halves until each simulates, keeping the order', async () => {
    const heavy: number[] = []
    const items = await fittedItems('op', chainWith(new Map()), parsed, [1, 2, 3, 4, 5], build, {
      describe: (e) => `entry ${e}`,
      // bytes and locks fit everything; more than 2 entries run out of compute
      checks: {
        fits: async () => true,
        tooHeavy: async ([item]) => {
          heavy.push(size(item!))
          return size(item!) > 2
        },
      },
    })
    assert.deepEqual(items.map(size), [2, 1, 2])
    assert.deepEqual(heavy, [5, 3, 2, 1, 2])
  })

  it('refuses an entry too heavy alone, and one that does not fit alone', async () => {
    const opts = { describe: (e: number) => `entry ${e}` }
    await assert.rejects(
      fittedItems('op', chainWith(new Map()), parsed, [1, 2], build, {
        ...opts,
        checks: { fits: async () => true, tooHeavy: async () => true },
      }),
      (e: unknown) =>
        e instanceof CCTParamsInvalidError && /entry 1 exceeds the compute/.test(e.message),
    )
    await assert.rejects(
      fittedItems('op', chainWith(new Map()), parsed, [1], build, {
        ...opts,
        checks: { fits: async () => false, tooHeavy: async () => false },
      }),
      (e: unknown) =>
        e instanceof CCTParamsInvalidError && /does not fit a transaction alone/.test(e.message),
    )
  })
})
