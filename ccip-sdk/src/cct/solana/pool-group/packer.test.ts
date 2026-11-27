import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  type Connection,
  type PublicKey,
  type VersionedTransaction,
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PACKET_DATA_SIZE,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction as VersionedTransactionClass,
} from '@solana/web3.js'
import bs58 from 'bs58'

import '../../../index.ts'
import {
  SET_COMPUTE_UNIT_LIMIT_TAG,
  SET_COMPUTE_UNIT_PRICE_TAG,
  isComputeBudgetInstruction,
  readComputeUnitLimit,
} from '../../../solana/compute-budget.ts'
import { CCTParamsInvalidError, CCTTxFailedError, CCTTxNotConfirmedError } from '../../errors.ts'
import {
  type PoolGroupPackItem,
  SOLANA_MAX_TRACE_ENTRIES,
  SQUADS_EXECUTE_TRACE_ENTRIES,
  executePoolGroupTransactions,
  measureTransaction,
  packPoolGroupTransactions,
  squadsExecuteOverhead,
} from './packer.ts'
import { poolGroupInstructionsHash, poolGroupTransactionsHash } from './snapshot.ts'
import { toPoolGroupSquadsBatch, toPoolGroupSquadsTransaction } from './squads.ts'
import type { PoolGroupUnsignedTx } from './write-types.ts'

const PROGRAM = Keypair.generate().publicKey
const PublicKey_default = () => Keypair.generate().publicKey.toBase58()
const VersionedTransactionOf = (raw: Uint8Array) => VersionedTransactionClass.deserialize(raw)
const PAYER = Keypair.generate().publicKey
const silent = { debug() {}, info() {}, warn() {}, error() {} }
const NO_LANES = { affectedLanes: [], goingLive: [], findings: [] }

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
      assert.ok(bytes <= PACKET_DATA_SIZE, `${bytes}`)
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
      const { bytes } = measureTransaction(PAYER, tx.instructions, [], true)
      assert.ok(bytes <= PACKET_DATA_SIZE, `${bytes}`)
      const units = Math.ceil(ownIxs(tx).length * 10_000 * 1.1)
      assert.equal(tx.computeUnitLimit, units + squadsExecuteOverhead(tx.instructions))
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

  it('durable nonces with their own authorities: every transaction still fits once its nonce is placed', async () => {
    const own = (i: number) => ({
      nonceAccount: Keypair.generate().publicKey.toBase58(),
      nonceAuthority: i ? Keypair.generate().publicKey.toBase58() : PAYER.toBase58(),
    })
    // nonce 0 is the payer's, the others a separate signer each (64 B signature, 32 B key, 1 lock)
    const items = Array.from({ length: 12 }, () => item(300))
    const nonces = Array.from({ length: 12 }, (_, i) => own(i))
    const { transactions } = await pack(items, { durableNonces: nonces })
    assert.ok(transactions.length > 1)
    for (const [i, tx] of transactions.entries()) {
      assert.equal(tx.durableNonce, nonces[i])
      const { bytes } = measureTransaction(PAYER, tx.instructions, [])
      // the signature slots the measure leaves out: one per required signer beyond the payer
      const signers = tx.requiredSigners.length
      assert.ok(
        bytes + 64 * (signers - 1) <= PACKET_DATA_SIZE || bytes <= PACKET_DATA_SIZE,
        `${bytes}`,
      )
      assert.ok(bytes <= PACKET_DATA_SIZE, `transaction ${i}: ${bytes} B`)
    }
  })

  it('refuses walletMayAddComputeBudget with durable nonces', async () => {
    await assert.rejects(
      pack([item()], {
        budget: { walletMayAddComputeBudget: true },
        durableNonces: [
          {
            nonceAccount: Keypair.generate().publicKey.toBase58(),
            nonceAuthority: PAYER.toBase58(),
          },
        ],
      }),
      /AdvanceNonceAccount off instruction 0/,
    )
  })

  it('squads: the trace entries of the execute itself are reserved, so an approved transaction executes', async () => {
    // each item: 1 instruction + `cpis`; the wallet path counts its 2 compute-budget entries, the
    // Squads path the execute's 3 (limit, price, execute)
    const cpis = SOLANA_MAX_TRACE_ENTRIES - SQUADS_EXECUTE_TRACE_ENTRIES - 1
    await pack([item(10, 1, { cpis })], { budget: { executor: 'squads-v4' } })
    await assert.rejects(
      pack([item(10, 1, { cpis: cpis + 1 })], { budget: { executor: 'squads-v4' } }),
      /instruction trace entries/,
    )
    // the wallet path has one entry more room (2 compute-budget instructions)
    await pack([item(10, 1, { cpis: cpis + 1 })])
  })

  it('heap is per item (each runs in its own invocation), not summed', async () => {
    const { transactions } = await pack([
      item(10, 1, { heapBytes: 20_000 }),
      item(10, 1, { heapBytes: 20_000 }),
    ])
    assert.equal(transactions.length, 1)
    await assert.rejects(pack([item(10, 1, { heapBytes: 40_000 })]), /heap bytes/)
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
  const signer = Keypair.generate()
  const wallet = {
    publicKey: signer.publicKey,
    signTransaction: async <T>(t: T) => {
      ;(t as VersionedTransaction).sign([signer])
      return t
    },
    signAllTransactions: async <T>(t: T[]) => t,
  }
  const tx = (tokens: string[]): PoolGroupUnsignedTx => ({
    family: 'SVM',
    instructions: [
      new TransactionInstruction({
        programId: PROGRAM,
        keys: [{ pubkey: signer.publicKey, isSigner: true, isWritable: true }],
        data: Buffer.from(tokens[0]!),
      }),
    ],
    requiredSigners: [{ address: signer.publicKey.toBase58(), role: 'payer' }],
    tokenAddresses: tokens,
    computeUnitLimit: 1,
    computeUnitPrice: 0,
  })
  const tokenOf = (raw: Uint8Array) =>
    (() => {
      const t = VersionedTransactionOf(raw)
      return Buffer.from(t.message.compiledInstructions.at(-1)!.data).toString()
    })()

  type Net = {
    /** What a send of token `t` does: land, land but the transport fails, or never land. */
    send: (
      t: string,
      attempt: number,
    ) => 'ok' | 'lost-after-landing' | 'lost' | 'failed-on-chain' | 'confirm-lost' | 'late'
    /** Simulations refused, by token. */
    refuse?: string
    /** Every status poll throws. */
    pollFails?: boolean
    /** Polls a `'late'` send takes to land. */
    latePolls?: number
  }
  /** A cluster: signatures that landed, a block height that passes expiry once polled twice. */
  function cluster(net: Net) {
    const landed = new Map<string, { err: unknown }>()
    const sends: string[] = []
    const attempts = new Map<string, number>()
    let height = 100
    const late = new Map<string, number>()
    let polls = 0
    const conn = {
      simulateTransaction: async (t: VersionedTransaction) => ({
        context: { slot: 1 },
        value: {
          err:
            net.refuse &&
            Buffer.from(t.message.compiledInstructions.at(-1)!.data).toString() === net.refuse
              ? { InstructionError: [1, { Custom: 1 }] }
              : null,
          logs: [],
          unitsConsumed: 1,
          returnData: null,
        },
      }),
      getLatestBlockhash: async () => ({
        blockhash: PublicKey_default(),
        lastValidBlockHeight: 150,
      }),
      sendRawTransaction: async (raw: Buffer) => {
        const t = tokenOf(raw)
        const n = (attempts.get(t) ?? 0) + 1
        attempts.set(t, n)
        sends.push(t)
        const sig = bs58.encode(VersionedTransactionOf(raw).signatures[0]!)
        const what = net.send(t, n)
        if (what === 'late') late.set(sig, net.latePolls ?? 3)
        if (
          what === 'ok' ||
          what === 'lost-after-landing' ||
          what === 'failed-on-chain' ||
          what === 'confirm-lost'
        )
          landed.set(sig, {
            err: what === 'failed-on-chain' ? { InstructionError: [0, { Custom: 7 }] } : null,
          })
        if (what === 'lost' || what === 'lost-after-landing') throw new Error('socket hang up')
        return sig
      },
      confirmTransaction: async ({ signature }: { signature: string }) => {
        if (late.has(signature) || net.send(tokenOfSig.get(signature) ?? '', 1) === 'confirm-lost')
          throw new Error('confirmation socket closed')
        return { context: { slot: 1 }, value: { err: landed.get(signature)?.err ?? null } }
      },
      // a late signature keeps the height under expiry until it lands
      getBlockHeight: async () => (late.size ? height : (height += 30)),
      getSignatureStatuses: async (sigs: string[]) => {
        polls++
        if (net.pollFails) throw new Error('status RPC unavailable')
        for (const [sig, left] of late)
          if (left <= 1) {
            late.delete(sig)
            landed.set(sig, { err: null })
          } else late.set(sig, left - 1)
        return statuses(sigs)
      },
    }
    const tokenOfSig = new Map<string, string>()
    const send = conn.sendRawTransaction
    conn.sendRawTransaction = async (raw: Buffer) => {
      tokenOfSig.set(bs58.encode(VersionedTransactionOf(raw).signatures[0]!), tokenOf(raw))
      return send(raw)
    }
    const statuses = (sigs: string[]) => ({
      context: { slot: 1 },
      value: sigs.map((s) =>
        landed.has(s)
          ? {
              slot: 1,
              confirmations: 1,
              err: landed.get(s)!.err,
              confirmationStatus: 'confirmed',
            }
          : null,
      ),
    })
    return {
      chain: { connection: conn as unknown as Connection, logger: silent },
      sends,
      landed,
      polls: () => polls,
    }
  }
  const run = (
    net: Net,
    done = new Set<string>(),
    tokens = ['a', 'b', 'c'],
    pollTimeoutMs?: number,
  ) => {
    const c = cluster(net)
    let builds = 0
    const result = executePoolGroupTransactions({
      operation: 'test',
      chain: c.chain,
      wallet,
      pollMs: 0,
      ...(pollTimeoutMs !== undefined && { pollTimeoutMs }),
      build: async () => {
        builds++
        // chain state: what landed is done
        for (const t of tokens)
          if ([...c.sends].includes(t) && net.send(t, 1) !== 'lost') done.add(t)
        return { ...NO_LANES, transactions: tokens.filter((t) => !done.has(t)).map((t) => tx([t])) }
      },
    })
    return { result, c, builds: () => builds }
  }

  it('X-1: a send whose transport fails after it landed is counted, never rebuilt or resent', async () => {
    const { result, c, builds } = run({ send: (t) => (t === 'b' ? 'lost-after-landing' : 'ok') })
    const r = await result
    assert.equal(builds(), 1)
    assert.deepEqual(c.sends, ['a', 'b', 'c'])
    assert.equal(r.transactions.length, 3)
    assert.deepEqual(
      r.transactions.map((t) => t.tokenAddresses[0]),
      ['a', 'b', 'c'],
    )
  })

  it('a send that never landed is rebuilt only after its blockhash expired', async () => {
    const { result, c, builds } = run({ send: (t, n) => (t === 'b' && n === 1 ? 'lost' : 'ok') })
    const r = await result
    assert.equal(builds(), 2)
    assert.deepEqual(c.sends, ['a', 'b', 'b', 'c'])
    assert.deepEqual(
      r.transactions.map((t) => t.tokenAddresses[0]),
      ['a', 'b', 'c'],
    )
  })

  it('a transaction that failed on chain is reported with what landed, never resent', async () => {
    const { result, c } = run({ send: (t) => (t === 'b' ? 'failed-on-chain' : 'ok') })
    await assert.rejects(result, (e: unknown) => {
      assert.ok(e instanceof CCTTxFailedError)
      assert.match(e.message, /failed on chain/)
      assert.deepEqual(e.context.committedHashes, [[...c.landed.keys()][0]])
      return true
    })
    assert.deepEqual(c.sends, ['a', 'b'])
  })

  it('a simulation refusal is thrown with what landed; signers are checked before the first send', async () => {
    const refused = run({ send: () => 'ok', refuse: 'b' })
    await assert.rejects(refused.result, (e: unknown) => {
      assert.ok(e instanceof CCTTxFailedError)
      assert.equal((e.context.committedHashes as string[]).length, 1)
      return true
    })
    assert.deepEqual(refused.c.sends, ['a'])
    const c = cluster({ send: () => 'ok' })
    const other = tx(['z'])
    other.requiredSigners.push({
      address: Keypair.generate().publicKey.toBase58(),
      role: 'pool-owner',
    })
    await assert.rejects(
      executePoolGroupTransactions({
        operation: 'test',
        chain: c.chain,
        wallet,
        pollMs: 0,
        build: async () => ({ ...NO_LANES, transactions: [tx(['a']), other] }),
      }),
      /transaction 1 also needs/,
    )
    assert.deepEqual(c.sends, [])
  })

  it('a confirmation that fails in transport is resolved by the status, never resent', async () => {
    const { result, c, builds } = run({ send: (t) => (t === 'b' ? 'confirm-lost' : 'ok') })
    const r = await result
    assert.equal(builds(), 1)
    assert.deepEqual(c.sends, ['a', 'b', 'c'])
    assert.equal(r.transactions.length, 3)
  })

  it('a transaction that lands only after several polls is counted, never rebuilt', async () => {
    const { result, c, builds } = run({ send: (t) => (t === 'b' ? 'late' : 'ok'), latePolls: 4 })
    const r = await result
    assert.equal(builds(), 1)
    assert.ok(c.polls() >= 4)
    assert.deepEqual(c.sends, ['a', 'b', 'c'])
    assert.deepEqual(
      r.transactions.map((t) => t.tokenAddresses[0]),
      ['a', 'b', 'c'],
    )
  })

  it('a poll that keeps failing stops the write as not confirmed, with what landed and the pending signature', async () => {
    const { result, c, builds } = run(
      { send: (t) => (t === 'b' ? 'lost' : 'ok'), pollFails: true },
      new Set(),
      ['a', 'b', 'c'],
      20,
    )
    await assert.rejects(result, (e: unknown) => {
      assert.ok(e instanceof CCTTxNotConfirmedError)
      assert.equal((e.context.committedHashes as string[]).length, 1)
      assert.equal(typeof e.context.pendingSignature, 'string')
      assert.match(String((e.cause as Error).message), /status RPC unavailable/)
      return true
    })
    assert.equal(builds(), 1)
    assert.deepEqual(c.sends, ['a', 'b'])
  })

  it('a wallet that replaces the blockhash is confirmed against its own blockhash', async () => {
    const c = cluster({ send: () => 'ok' })
    const replaced = PublicKey_default()
    const reblock = {
      ...wallet,
      signTransaction: async <T>(t: T) => {
        ;(t as VersionedTransaction).message.recentBlockhash = replaced
        ;(t as VersionedTransaction).sign([signer])
        return t
      },
    }
    const conn = c.chain.connection as unknown as Record<string, (...a: unknown[]) => unknown>
    const confirm = conn.confirmTransaction!
    const seen: unknown[] = []
    conn.confirmTransaction = (arg: unknown, ...rest: unknown[]) => {
      seen.push((arg as { blockhash: string }).blockhash)
      return confirm(arg, ...rest)
    }
    await executePoolGroupTransactions({
      operation: 'test',
      chain: c.chain,
      wallet: reblock,
      pollMs: 0,
      build: async () => ({ ...NO_LANES, transactions: [tx(['a'])] }),
    })
    assert.deepEqual(seen, [replaced])
  })

  it('refuses a durable nonce before the first send', async () => {
    const c = cluster({ send: () => 'ok' })
    const withNonce = tx(['n'])
    withNonce.durableNonce = {
      nonceAccount: PublicKey_default(),
      nonceAuthority: signer.publicKey.toBase58(),
    }
    await assert.rejects(
      executePoolGroupTransactions({
        operation: 'test',
        chain: c.chain,
        wallet,
        pollMs: 0,
        build: async () => ({ ...NO_LANES, transactions: [tx(['a']), withNonce] }),
      }),
      (e: unknown) => e instanceof CCTParamsInvalidError && e.context.param === 'durableNonces',
    )
    assert.deepEqual(c.sends, [])
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

describe('Squads multi-transaction step snapshot (B-4)', () => {
  it('every transaction of a step carries its step id, and the set hashes in order', async () => {
    const vault = PAYER.toBase58()
    const [t1, t2] = [
      (await pack([item()], { budget: { executor: 'squads-v4' } })).transactions[0]!,
      (await pack([item()], { budget: { executor: 'squads-v4' } })).transactions[0]!,
    ]
    const { batches } = toPoolGroupSquadsBatch({
      ready: [{ id: 'step', transactions: [t1, t2] }],
      vault,
    })
    const inStep = batches[0]!.transactions.filter((t) => t.stepId === 'step')
    assert.equal(inStep.length, 2)
    assert.equal(poolGroupTransactionsHash(inStep), poolGroupTransactionsHash([t1, t2]))
    assert.notEqual(poolGroupTransactionsHash([t2, t1]), poolGroupTransactionsHash([t1, t2]))
    assert.equal(poolGroupTransactionsHash([t1]), poolGroupInstructionsHash(t1.instructions))
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
      // SetLoadedAccountsDataSizeLimit (tag 4): any compute-budget instruction is the executor's
      new TransactionInstruction({
        programId: ComputeBudgetProgram.programId,
        keys: [],
        data: Buffer.from([4, 0, 0, 1, 0]),
      }),
    ]
    assert.equal(poolGroupInstructionsHash([...extra, ...own]), poolGroupInstructionsHash(own))
    assert.notEqual(poolGroupInstructionsHash(own), poolGroupInstructionsHash(item().instructions))
    assert.ok(isComputeBudgetInstruction(extra[1]!, SET_COMPUTE_UNIT_LIMIT_TAG))
  })
})
