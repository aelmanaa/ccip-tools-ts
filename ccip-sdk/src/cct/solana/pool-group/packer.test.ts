import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  type Connection,
  type PublicKey,
  type VersionedTransaction,
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js'

import '../../../index.ts'
import {
  SET_COMPUTE_UNIT_LIMIT_TAG,
  SET_COMPUTE_UNIT_PRICE_TAG,
  isComputeBudgetInstruction,
  readComputeUnitLimit,
} from '../../../solana/compute-budget.ts'
import { simulateTransaction } from '../../../solana/utils.ts'
import { CCTParamsInvalidError } from '../../errors.ts'
import {
  type PoolGroupPackItem,
  SOLANA_PACKET_BYTES,
  SQUADS_MESSAGE_MARGIN_BYTES,
  executePoolGroupTransactions,
  measureTransaction,
  packPoolGroupTransactions,
} from './packer.ts'
import { poolGroupInstructionsHash } from './snapshot.ts'
import { toPoolGroupSquadsBatch, toPoolGroupSquadsTransaction } from './squads.ts'
import type { PoolGroupUnsignedTx } from './write-types.ts'

const PROGRAM = Keypair.generate().publicKey
const PAYER = Keypair.generate().publicKey
const silent = { debug() {}, info() {}, warn() {}, error() {} }

/** An item of `bytes` instruction data touching `accounts` fresh writable accounts. */
function item(
  bytes = 100,
  accounts = 2,
  extra: Partial<PoolGroupPackItem> = {},
): PoolGroupPackItem {
  return {
    tokenAddresses: [Keypair.generate().publicKey.toBase58()],
    instructions: [
      new TransactionInstruction({
        programId: PROGRAM,
        keys: [
          { pubkey: PAYER, isSigner: true, isWritable: true },
          ...Array.from({ length: accounts }, () => ({
            pubkey: Keypair.generate().publicKey,
            isSigner: false,
            isWritable: true,
          })),
        ],
        data: Buffer.alloc(bytes, 7),
      }),
    ],
    ...extra,
  }
}

type SimOpts = {
  /** CU per item instruction. */
  units?: number
  /** Simulations with more item instructions than this fail for compute. */
  maxItems?: number
  fees?: number[]
  slot?: number
  tables?: AddressLookupTableAccount[]
  accounts?: Map<string, { lamports: number }>
}
/** A connection that simulates: CU per item instruction, compute failure above `maxItems`. */
function connection(opts: SimOpts = {}) {
  const sims: number[] = []
  const conn = {
    simulateTransaction: async (tx: VersionedTransaction) => {
      const own = tx.message.compiledInstructions.filter((ix) =>
        tx.message.staticAccountKeys[ix.programIdIndex]!.equals(PROGRAM),
      ).length
      sims.push(own)
      const failed = opts.maxItems !== undefined && own > opts.maxItems
      return {
        context: { slot: 1 },
        value: {
          err: failed ? { InstructionError: [1, 'ComputationalBudgetExceeded'] } : null,
          logs: [],
          unitsConsumed: own * (opts.units ?? 10_000),
          returnData: null,
        },
      }
    },
    getRecentPrioritizationFees: async () =>
      (opts.fees ?? []).map((prioritizationFee, slot) => ({ slot, prioritizationFee })),
    getSlot: async () => opts.slot ?? 100,
    getAddressLookupTable: async (key: PublicKey) => ({
      context: { slot: 1 },
      value: opts.tables?.find((t) => t.key.equals(key)) ?? null,
    }),
    getMultipleAccountsInfo: async (keys: PublicKey[]) =>
      keys.map((k) =>
        opts.accounts?.get(k.toBase58())
          ? {
              ...opts.accounts.get(k.toBase58()),
              data: Buffer.alloc(0),
              owner: SystemProgram.programId,
              executable: false,
            }
          : null,
      ),
  }
  return { chain: { connection: conn as unknown as Connection, logger: silent }, sims }
}

const pack = (items: PoolGroupPackItem[], extra: object = {}, opts: SimOpts = {}) => {
  const { chain, sims } = connection(opts)
  return packPoolGroupTransactions({
    operation: 'test',
    chain,
    payer: PAYER,
    items,
    ...extra,
  }).then((r) => ({ ...r, sims }))
}
const ownIxs = (tx: PoolGroupUnsignedTx) =>
  tx.instructions.filter((ix) => ix.programId.equals(PROGRAM))

describe('packPoolGroupTransactions', () => {
  it('packs greedily under the compiled bytes; each transaction carries limit and price', async () => {
    const { transactions } = await pack(Array.from({ length: 12 }, () => item(300)))
    assert.ok(transactions.length > 1)
    assert.equal(
      transactions.reduce((n, t) => n + ownIxs(t).length, 0),
      12,
    )
    for (const tx of transactions) {
      const { bytes } = measureTransaction(PAYER, tx.instructions, [])
      assert.ok(bytes <= SOLANA_PACKET_BYTES, `${bytes}`)
      assert.equal(tx.mainIndex, tx.instructions.length - 1)
      assert.equal(readComputeUnitLimit(tx.instructions), tx.computeUnitLimit)
      assert.equal(tx.computeUnitLimit, Math.ceil(ownIxs(tx).length * 10_000 * 1.1))
      assert.ok(
        tx.instructions.some((ix) => isComputeBudgetInstruction(ix, SET_COMPUTE_UNIT_PRICE_TAG)),
      )
      assert.equal(tx.computeUnitPrice, 10_000)
      assert.deepEqual(tx.requiredSigners, [{ address: PAYER.toBase58(), role: 'payer' }])
    }
  })

  it('prices: the recent median or the estimator above the floor, and 0 disables', async () => {
    const recent = await pack([item()], {}, { fees: [1, 50_000, 60_000] })
    assert.equal(recent.transactions[0]!.computeUnitPrice, 50_000)
    const estimated = await pack([item()], { budget: { priorityFeeEstimator: async () => 77_000 } })
    assert.equal(estimated.transactions[0]!.computeUnitPrice, 77_000)
    const none = await pack([item()], { budget: { computeUnitPrice: 0 } })
    assert.equal(none.transactions[0]!.computeUnitPrice, 0)
    assert.ok(
      !none.transactions[0]!.instructions.some((ix) =>
        isComputeBudgetInstruction(ix, SET_COMPUTE_UNIT_PRICE_TAG),
      ),
    )
  })

  it('halves a batch the simulation refuses for compute, and refuses an item too heavy alone', async () => {
    const { transactions, sims } = await pack(
      Array.from({ length: 4 }, () => item(10)),
      {},
      { maxItems: 2 },
    )
    assert.deepEqual(
      transactions.map((t) => ownIxs(t).length),
      [2, 2],
    )
    assert.deepEqual(sims, [4, 2, 2])
    await assert.rejects(pack([item(10)], {}, { maxItems: 0 }), CCTParamsInvalidError)
  })

  it('refuses an item that does not fit alone, and counts pre-funded PDAs as 3 trace entries', async () => {
    await assert.rejects(pack([item(1_200)]), /does not fit a transaction alone/)
    const pdas = Array.from({ length: 21 }, () => Keypair.generate().publicKey)
    const prefunded = new Map(pdas.map((p) => [p.toBase58(), { lamports: 1 }]))
    // 21 pre-funded PDAs: 63 entries + the item and compute budget: above the 64-entry trace
    await assert.rejects(
      pack([item(10, 1, { createdPdas: pdas })], {}, { accounts: prefunded }),
      /instruction trace entries/,
    )
    const fresh = await pack([item(10, 1, { createdPdas: pdas })])
    assert.equal(fresh.transactions.length, 1)
  })

  it('squads: only the items inside, the compute budget outside with the execute overhead', async () => {
    const { transactions } = await pack(
      Array.from({ length: 8 }, () => item(250)),
      {
        budget: { executor: 'squads-v4' },
      },
    )
    for (const tx of transactions) {
      assert.equal(tx.instructions.length, ownIxs(tx).length)
      const { bytes } = measureTransaction(PAYER, tx.instructions, [])
      assert.ok(bytes <= SOLANA_PACKET_BYTES - SQUADS_MESSAGE_MARGIN_BYTES, `${bytes}`)
      const units = Math.ceil(ownIxs(tx).length * 10_000 * 1.1)
      assert.equal(tx.computeUnitLimit, units + 25_000 + 5_000 * ownIxs(tx).length)
      assert.equal(readComputeUnitLimit(tx.outerInstructions!), tx.computeUnitLimit)
    }
  })

  it('durable nonces: AdvanceNonceAccount first, one per transaction; too few or with Squads refused', async () => {
    const nonce = (i: number) => ({
      nonceAccount: Keypair.generate().publicKey.toBase58(),
      nonceAuthority: i ? Keypair.generate().publicKey.toBase58() : PAYER.toBase58(),
    })
    const { transactions, noncesUsed } = await pack([item()], { durableNonces: [nonce(1)] })
    assert.equal(noncesUsed, 1)
    const first = transactions[0]!.instructions[0]!
    assert.ok(first.programId.equals(SystemProgram.programId))
    assert.equal(transactions[0]!.durableNonce?.nonceAccount, first.keys[0]!.pubkey.toBase58())
    assert.ok(transactions[0]!.requiredSigners.some((s) => s.role === 'nonce-authority'))
    await assert.rejects(
      pack(
        Array.from({ length: 12 }, () => item(300)),
        { durableNonces: [nonce(0)] },
      ),
      /nonces were given/,
    )
    await assert.rejects(
      pack([item()], { budget: { executor: 'squads-v4' }, durableNonces: [nonce(0)] }),
      CCTParamsInvalidError,
    )
  })

  it('drops lookup-table entries extended in the current slot', async () => {
    const key = Keypair.generate().publicKey
    const addresses = Array.from({ length: 4 }, () => Keypair.generate().publicKey)
    const table = new AddressLookupTableAccount({
      key,
      state: {
        deactivationSlot: BigInt('18446744073709551615'),
        lastExtendedSlot: 100,
        lastExtendedSlotStartIndex: 2,
        authority: PAYER,
        addresses,
      },
    })
    const { transactions } = await pack(
      [item()],
      { budget: { lookupTableAddresses: [key.toBase58()] } },
      { tables: [table], slot: 100 },
    )
    assert.deepEqual(transactions[0]!.lookupTables![0]!.state.addresses, addresses.slice(0, 2))
  })
})

describe('executePoolGroupTransactions', () => {
  const wallet = {
    publicKey: PAYER,
    signTransaction: async <T>(t: T) => t,
    signAllTransactions: async <T>(t: T[]) => t,
  }
  const tx = (tokens: string[]): PoolGroupUnsignedTx => ({
    family: 'SVM',
    instructions: [item().instructions[0]!],
    requiredSigners: [{ address: PAYER.toBase58(), role: 'payer' }],
    tokenAddresses: tokens,
    computeUnitLimit: 1,
    computeUnitPrice: 0,
  })

  it('never resends a transaction that may have landed: it rebuilds from chain state', async () => {
    const done = new Set<string>()
    let builds = 0
    const sent: string[][] = []
    const r = await executePoolGroupTransactions({
      operation: 'test',
      chain: connection().chain,
      wallet,
      build: async () => {
        builds++
        return { transactions: ['a', 'b', 'c'].filter((t) => !done.has(t)).map((t) => tx([t])) }
      },
      send: async (_c, _w, unsigned) => {
        const t = (unsigned as PoolGroupUnsignedTx).tokenAddresses
        sent.push(t)
        done.add(t[0]!) // it landed
        if (t[0] === 'b' && sent.filter((s) => s[0] === 'b').length === 1)
          throw new Error('block height exceeded') // ... but did not confirm
        return { hash: `h-${t[0]}`, slices: [] }
      },
    })
    assert.equal(builds, 2)
    assert.deepEqual(sent, [['a'], ['b'], ['c']])
    assert.deepEqual(
      r.transactions.map((t) => t.hash),
      ['h-a', 'h-c'],
    )
  })

  it('a simulation refusal is thrown; a second signer is refused', async () => {
    const { chain } = connection({ maxItems: 0 })
    const refusal = await simulateTransaction(chain, {
      payerKey: PAYER,
      instructions: item().instructions,
    }).catch((e: unknown) => e)
    await assert.rejects(
      executePoolGroupTransactions({
        operation: 'test',
        chain,
        wallet,
        build: async () => ({ transactions: [tx(['a'])] }),
        send: async () => {
          throw refusal
        },
      }),
      (e: unknown) => e === refusal,
    )
    const other = tx(['a'])
    other.requiredSigners.push({
      address: Keypair.generate().publicKey.toBase58(),
      role: 'pool-owner',
    })
    await assert.rejects(
      executePoolGroupTransactions({
        operation: 'test',
        chain,
        wallet,
        build: async () => ({ transactions: [other] }),
      }),
      /also needs/,
    )
  })
})

describe('Squads export', () => {
  const vault = PAYER.toBase58()
  const squadsTx = async () =>
    (await pack([item()], { budget: { executor: 'squads-v4' } })).transactions[0]!

  it('converts a Squads-built transaction; refuses a wallet-built one and a non-vault signer', async () => {
    const tx = await squadsTx()
    const out = toPoolGroupSquadsTransaction(tx, vault)
    assert.deepEqual(out.requiredSigners, [{ address: vault, role: 'payer' }])
    assert.equal(out.instructions, tx.instructions)
    const wallet = (await pack([item()])).transactions[0]!
    assert.throws(() => toPoolGroupSquadsTransaction(wallet, vault), /not built for Squads/)
    assert.throws(
      () => toPoolGroupSquadsTransaction(tx, Keypair.generate().publicKey.toBase58()),
      /not the vault/,
    )
  })

  it('batches vault steps whole and in order; other signers apart', async () => {
    const steps = await Promise.all(
      Array.from({ length: 5 }, async (_, i) => ({
        id: `s${i}`,
        transactions: [await squadsTx(), await squadsTx()],
      })),
    )
    const crank = Keypair.generate().publicKey
    const foreign = await squadsTx()
    foreign.instructions[0]!.keys.push({ pubkey: crank, isSigner: true, isWritable: false })
    const { batches, otherActorSteps } = toPoolGroupSquadsBatch({
      ready: [...steps, { id: 'crank', transactions: [foreign] }],
      vault,
      maxTransactionsPerBatch: 4,
    })
    assert.deepEqual(
      batches.map((b) => b.stepIds),
      [['s0', 's1'], ['s2', 's3'], ['s4']],
    )
    assert.deepEqual(otherActorSteps, [{ address: crank.toBase58(), stepIds: ['crank'] }])
    assert.throws(
      () => toPoolGroupSquadsBatch({ ready: steps, vault, maxTransactionsPerBatch: 1 }),
      /more than a batch/,
    )
  })
})

describe('poolGroupInstructionsHash', () => {
  it('leaves out compute budget and nonce instructions', () => {
    const own = item().instructions
    const extra = [
      SystemProgram.nonceAdvance({
        noncePubkey: Keypair.generate().publicKey,
        authorizedPubkey: PAYER,
      }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    ]
    assert.equal(poolGroupInstructionsHash([...extra, ...own]), poolGroupInstructionsHash(own))
    assert.notEqual(poolGroupInstructionsHash(own), poolGroupInstructionsHash(item().instructions))
    assert.ok(isComputeBudgetInstruction(extra[1]!, SET_COMPUTE_UNIT_LIMIT_TAG))
  })
})
