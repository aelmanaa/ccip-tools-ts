import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  type Connection,
  type SignatureStatus,
  type VersionedTransaction,
  Keypair,
  PublicKey,
  TransactionExpiredBlockheightExceededError,
  TransactionExpiredTimeoutError,
  TransactionInstruction,
} from '@solana/web3.js'

import { CCIPConfirmationUnavailableError } from '../errors/index.ts'
import type { Wallet } from './types.ts'
import { confirmTransaction, simulateAndSendTxs } from './utils.ts'

const SIGNATURE = 'sig-1'
const BLOCKHASH = { blockhash: '11111111111111111111111111111112', lastValidBlockHeight: 999 }
const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const status = (confirmationStatus: SignatureStatus['confirmationStatus'], err = null) =>
  ({ slot: 1, confirmations: null, err, confirmationStatus }) as SignatureStatus

/**
 * A connection whose `confirmTransaction` behaves like web3.js with a websocket that never
 * connects: it settles only on `subscription` (if given) or when the caller aborts it.
 */
function mockConnection({
  subscription,
  statuses = () => [null],
  history = () => [null],
}: {
  subscription?: () => Promise<{ err: unknown }>
  statuses?: () => (SignatureStatus | null)[]
  history?: () => (SignatureStatus | null)[]
}) {
  const calls = { confirm: 0, poll: 0, lookup: 0, sent: 0, aborted: false }
  const connection = {
    confirmTransaction: (strategy: { abortSignal?: AbortSignal }) => {
      calls.confirm++
      return new Promise((resolve, reject) => {
        strategy.abortSignal?.addEventListener('abort', () => {
          calls.aborted = true
          reject(new Error('aborted'))
        })
        subscription?.().then((value) => resolve({ context: { slot: 1 }, value }), reject)
      })
    },
    getSignatureStatuses: async (
      _sigs: string[],
      config?: { searchTransactionHistory?: boolean },
    ) => {
      if (config?.searchTransactionHistory) {
        calls.lookup++
        return { context: { slot: 1 }, value: history() }
      }
      calls.poll++
      return { context: { slot: 1 }, value: statuses() }
    },
    getLatestBlockhash: async () => BLOCKHASH,
    simulateTransaction: async () => ({ value: { err: null, logs: [], unitsConsumed: 5 } }),
    sendTransaction: async () => {
      calls.sent++
      return SIGNATURE
    },
  } as unknown as Connection
  return { connection, calls }
}

const expired = () =>
  new Promise<never>((_, reject) =>
    setTimeout(() => reject(new TransactionExpiredBlockheightExceededError(SIGNATURE)), 30),
  )

describe('confirmTransaction', () => {
  it('confirms over HTTP when the websocket subscription never settles', async () => {
    const { connection, calls } = mockConnection({ statuses: () => [status('confirmed')] })
    const result = await confirmTransaction(
      { connection, logger: silent },
      { signature: SIGNATURE, ...BLOCKHASH },
      5,
    )
    assert.deepEqual(result, { err: null })
    assert.ok(calls.poll >= 1)
    assert.ok(calls.aborted, 'the pending subscription is aborted')
  })

  it('returns the error of a landed but failed transaction found by polling', async () => {
    const err = { InstructionError: [0, { Custom: 1 }] }
    const { connection } = mockConnection({
      statuses: () => [{ ...status('finalized'), err } as SignatureStatus],
    })
    const result = await confirmTransaction(
      { connection, logger: silent },
      { signature: SIGNATURE, ...BLOCKHASH },
      5,
    )
    assert.deepEqual(result, { err })
  })

  it('rethrows the error of a failed transaction reported by the subscription', async () => {
    const err = { InstructionError: [0, { Custom: 1 }] }
    const { connection, calls } = mockConnection({ subscription: () => Promise.reject(err) })
    await assert.rejects(
      confirmTransaction(
        { connection, logger: silent },
        { signature: SIGNATURE, ...BLOCKHASH },
        10_000,
      ),
      (thrown: unknown) => thrown === err,
    )
    assert.equal(calls.lookup, 0)
  })

  it('keeps polling through RPC errors and accepts the subscription result', async () => {
    const { connection, calls } = mockConnection({
      subscription: () => new Promise((r) => setTimeout(() => r({ err: null }), 40)),
      statuses: () => {
        throw new Error('429 Too Many Requests')
      },
    })
    const result = await confirmTransaction(
      { connection, logger: silent },
      { signature: SIGNATURE, ...BLOCKHASH },
      5,
    )
    assert.deepEqual(result, { err: null })
    assert.ok(calls.poll >= 1)
  })

  it('reports a landed transaction after the blockhash expired', async () => {
    const { connection, calls } = mockConnection({
      subscription: expired,
      history: () => [status('finalized')],
    })
    // polling slower than the expiry, so only the re-check can find it
    const result = await confirmTransaction(
      { connection, logger: silent },
      { signature: SIGNATURE, ...BLOCKHASH },
      10_000,
    )
    assert.deepEqual(result, { err: null })
    assert.equal(calls.lookup, 1)
  })

  it('rethrows block-height expiry when the signature is unknown', async () => {
    const { connection } = mockConnection({ subscription: expired })
    await assert.rejects(
      confirmTransaction(
        { connection, logger: silent },
        { signature: SIGNATURE, ...BLOCKHASH },
        10_000,
      ),
      TransactionExpiredBlockheightExceededError,
    )
  })

  it('throws CCIPConfirmationUnavailableError when the outcome is unknown', async () => {
    const { connection } = mockConnection({
      subscription: () => Promise.reject(new TransactionExpiredTimeoutError(SIGNATURE, 30)),
      history: () => [status('processed')],
    })
    await assert.rejects(
      confirmTransaction(
        { connection, logger: silent },
        { signature: SIGNATURE, ...BLOCKHASH },
        10_000,
      ),
      (err: unknown) => {
        assert.ok(err instanceof CCIPConfirmationUnavailableError)
        assert.equal(err.code, 'TX_CONFIRMATION_UNAVAILABLE')
        assert.equal(err.isTransient, false)
        assert.equal(err.context.signature, SIGNATURE)
        assert.equal(err.context.confirmationStatus, 'processed')
        assert.ok(err.cause instanceof TransactionExpiredTimeoutError)
        return true
      },
    )
  })

  it('throws CCIPConfirmationUnavailableError when the status lookup fails', async () => {
    const { connection } = mockConnection({
      subscription: expired,
      history: () => {
        throw new Error('fetch failed')
      },
    })
    await assert.rejects(
      confirmTransaction(
        { connection, logger: silent },
        { signature: SIGNATURE, ...BLOCKHASH },
        10_000,
      ),
      (err: unknown) => {
        assert.ok(err instanceof CCIPConfirmationUnavailableError)
        assert.equal(err.context.signature, SIGNATURE)
        assert.ok(err.cause instanceof TransactionExpiredBlockheightExceededError)
        return true
      },
    )
  })
})

describe('simulateAndSendTxs with an unavailable websocket', () => {
  const payer = Keypair.generate()
  const wallet = {
    publicKey: payer.publicKey,
    signTransaction: async (tx: VersionedTransaction) => {
      tx.sign([payer])
      return tx
    },
  } as unknown as Wallet
  const ix = new TransactionInstruction({
    keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }],
    programId: new PublicKey('Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C'),
    data: Buffer.alloc(8, 1),
  })

  it('returns the landed signature once, without resending', async () => {
    // web3.js with a websocket answering 429: the subscription only fails on block-height expiry,
    // long after the transaction landed
    const { connection, calls } = mockConnection({
      subscription: () =>
        new Promise((_, reject) => {
          setTimeout(
            () => reject(new TransactionExpiredBlockheightExceededError(SIGNATURE)),
            5_000,
          ).unref()
        }),
      statuses: () => [status('confirmed')],
      history: () => [status('finalized')],
    })
    const started = Date.now()
    const result = await simulateAndSendTxs({ connection, logger: silent }, wallet, {
      instructions: [ix],
      mainIndex: 0,
    })
    assert.equal(result.hash, SIGNATURE)
    assert.deepEqual(result.slices, [{ signature: SIGNATURE, start: 0, end: 1 }])
    assert.equal(calls.sent, 1, 'sent exactly once')
    assert.ok(Date.now() - started < 4_500, 'confirmed by polling, before the expiry')
  })
})
