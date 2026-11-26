import { Buffer } from 'buffer'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  AddressLookupTableAccount,
  Message,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  VersionedMessage,
} from '@solana/web3.js'
import bs58 from 'bs58'

import { CCTParamsInvalidError } from '../errors.ts'
import { serializeUnsignedSolanaTx } from './serialize.ts'

const KEY = PublicKey.default
const NONCE_ACCOUNT = new PublicKey('Nonce11111111111111111111111111111111111111')
const onNonce = {
  instructions: [
    SystemProgram.nonceAdvance({ noncePubkey: NONCE_ACCOUNT, authorizedPubkey: KEY }),
    new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: [],
      data: Buffer.alloc(0),
    }),
  ],
  durableNonce: { nonceAccount: NONCE_ACCOUNT.toBase58(), nonceAuthority: KEY.toBase58() },
}
const TABLE_ENTRY = new PublicKey('Tab1eEntry111111111111111111111111111111111')
const connection = {
  getLatestBlockhash: async () => ({ blockhash: KEY.toBase58(), lastValidBlockHeight: 0 }),
}
/** A connection that fails the test if a blockhash is fetched: refusals and nonce txs need none. */
const noFetch = {
  getLatestBlockhash: async (): Promise<{ blockhash: string }> => {
    throw new Error('no blockhash may be fetched here')
  },
}
const unsigned = {
  instructions: [
    new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: [],
      data: Buffer.alloc(0),
    }),
  ],
}

describe('Serialize (cct/solana)', () => {
  it('serializes unsigned Solana txs as legacy messages in supported encodings', async () => {
    const base58 = await serializeUnsignedSolanaTx(connection, unsigned, KEY)
    const base64 = await serializeUnsignedSolanaTx(connection, unsigned, KEY, 'base64')
    const hex = await serializeUnsignedSolanaTx(connection, unsigned, KEY, 'hex')

    assert.ok(Message.from(bs58.decode(base58)))
    assert.ok(Message.from(Buffer.from(base64, 'base64')))
    assert.ok(Message.from(Buffer.from(hex, 'hex')))
  })

  it('serializes a v0 message when the transaction carries lookup tables', async () => {
    const table = new AddressLookupTableAccount({
      key: new PublicKey('AddressLookupTab1e1111111111111111111111111'),
      state: {
        deactivationSlot: 2n ** 64n - 1n,
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        addresses: [TABLE_ENTRY],
      },
    })
    const withTable = {
      instructions: [
        new TransactionInstruction({
          programId: SystemProgram.programId,
          keys: [{ pubkey: TABLE_ENTRY, isSigner: false, isWritable: true }],
          data: Buffer.alloc(0),
        }),
      ],
      lookupTables: [table],
    }
    const base64 = await serializeUnsignedSolanaTx(connection, withTable, KEY, {
      encoding: 'base64',
    })
    const message = VersionedMessage.deserialize(Buffer.from(base64, 'base64'))
    assert.equal(message.version, 0)
    assert.equal(message.addressTableLookups.length, 1)
    assert.ok(message.addressTableLookups[0]!.accountKey.equals(table.key))
  })

  it('keeps legacy bytes identical for the positional and options forms', async () => {
    assert.equal(
      await serializeUnsignedSolanaTx(connection, unsigned, KEY, 'hex'),
      await serializeUnsignedSolanaTx(connection, unsigned, KEY, { encoding: 'hex' }),
    )
    assert.equal(
      await serializeUnsignedSolanaTx(connection, unsigned, KEY),
      await serializeUnsignedSolanaTx(connection, unsigned, KEY, {}),
    )
  })

  it('uses the durable nonce value as the blockhash, without fetching one', async () => {
    const nonce = new PublicKey('Nonce11111111111111111111111111111111111111').toBase58()
    const hex = await serializeUnsignedSolanaTx(noFetch, onNonce, KEY, {
      encoding: 'hex',
      nonce,
    })
    assert.equal(Message.from(Buffer.from(hex, 'hex')).recentBlockhash, nonce)
  })

  it('refuses durable-nonce mistakes before any RPC, naming the param', async () => {
    const nonce = KEY.toBase58()
    const { durableNonce: _, ...advanceOnly } = onNonce
    const otherNonce = {
      ...onNonce,
      durableNonce: { ...onNonce.durableNonce, nonceAccount: KEY.toBase58() },
    }
    const cases = [
      [onNonce, { encoding: 'base58' }, 'nonce'], // missing value
      [onNonce, { nonce: 'not-base58!' }, 'nonce'], // malformed value
      [otherNonce, { nonce }, 'durableNonce'], // first ix advances another account
      [advanceOnly, {}, 'durableNonce'], // advances a nonce but the field was dropped
      [unsigned, { nonce }, 'nonce'], // stray nonce
    ] as const
    for (const [tx, opts, param] of cases)
      await assert.rejects(
        () => serializeUnsignedSolanaTx(noFetch, tx, KEY, opts),
        (err: unknown) =>
          err instanceof CCTParamsInvalidError &&
          err.context.operation === 'serializeUnsignedTx' &&
          err.context.param === param,
      )
  })

  it('rejects unsupported transaction encodings', async () => {
    await assert.rejects(
      () => serializeUnsignedSolanaTx(connection, unsigned, KEY, 'base32'),
      (err: unknown) =>
        err instanceof CCTParamsInvalidError &&
        err.context.operation === 'serializeUnsignedTx' &&
        err.context.param === 'encoding',
    )
  })
})
