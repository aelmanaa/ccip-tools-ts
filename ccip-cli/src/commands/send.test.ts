import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CCIPArgumentInvalidError,
  ChainFamily,
  SVMTokenReceiverUsage,
  SolanaChain,
  encodeSVMExecutorArgsV1,
} from '@chainlink/ccip-sdk/src/index.ts'
import { PublicKey } from '@solana/web3.js'

import { tokenReceiverUsageExecutorArgs } from './send.ts'

const ACCOUNT_A = new PublicKey(Buffer.alloc(32, 1)).toBase58()
const ACCOUNT_B = new PublicKey(Buffer.alloc(32, 2)).toBase58()

describe('tokenReceiverUsageExecutorArgs (--token-receiver-usage)', () => {
  it('leaves executorArgs to the SDK when no usage is chosen', () => {
    assert.equal(
      tokenReceiverUsageExecutorArgs({ usage: undefined, destFamily: ChainFamily.Solana }),
      undefined,
    )
  })

  it('encodes each usage as the useATA byte of SVMExecutorArgsV1', () => {
    const cases = [
      ['derive-and-create', '00'],
      ['derive', '01'],
      ['as-is', '02'],
    ] as const
    for (const [usage, useAta] of cases) {
      assert.equal(
        tokenReceiverUsageExecutorArgs({ usage, destFamily: ChainFamily.Solana }),
        // tag, useATA, writable bitmap (u64 BE), accounts count
        `0x1a2b3c4d${useAta}000000000000000000`,
        usage,
      )
    }
  })

  it('carries the --account list and its writable bitmap', () => {
    const encoded = tokenReceiverUsageExecutorArgs({
      usage: 'derive',
      destFamily: ChainFamily.Solana,
      accounts: [ACCOUNT_A, ACCOUNT_B],
      accountIsWritableBitmap: 2n,
    })
    assert.equal(
      encoded,
      encodeSVMExecutorArgsV1({
        useAta: SVMTokenReceiverUsage.DeriveAtaDontCreate,
        accounts: [ACCOUNT_A, ACCOUNT_B],
        accountIsWritableBitmap: 2n,
      }),
    )
    assert.equal(
      encoded,
      '0x1a2b3c4d' +
        '01' +
        '0000000000000002' +
        '02' +
        Buffer.alloc(32, 1).toString('hex') +
        Buffer.alloc(32, 2).toString('hex'),
    )
  })

  it('is kept as is by SolanaChain.buildMessageForDest, which selects GenericExtraArgsV3', () => {
    const executorArgs = tokenReceiverUsageExecutorArgs({
      usage: 'as-is',
      destFamily: ChainFamily.Solana,
      accounts: [ACCOUNT_A],
      accountIsWritableBitmap: 1n,
    })
    const message = SolanaChain.buildMessageForDest({
      receiver: ACCOUNT_A,
      tokenAmounts: [{ token: '0x' + '11'.repeat(20), amount: 1n }],
      extraArgs: {
        tokenReceiver: ACCOUNT_B,
        accounts: [ACCOUNT_A],
        accountIsWritableBitmap: 1n,
        ...(executorArgs != null && { executorArgs }),
      },
    })
    assert.ok('executorArgs' in message.extraArgs)
    assert.equal(message.extraArgs.executorArgs, executorArgs)
    assert.equal(message.extraArgs.tokenReceiver, ACCOUNT_B)
  })

  it('refuses a non-Solana destination', () => {
    assert.throws(
      () => tokenReceiverUsageExecutorArgs({ usage: 'as-is', destFamily: ChainFamily.EVM }),
      (err: unknown) =>
        err instanceof CCIPArgumentInvalidError && /only applies to Solana/.test(err.message),
    )
  })

  it('refuses an --extra executorArgs alongside it', () => {
    assert.throws(
      () =>
        tokenReceiverUsageExecutorArgs({
          usage: 'derive',
          destFamily: ChainFamily.Solana,
          extra: { executorArgs: '0x1a2b3c4d' },
        }),
      (err: unknown) =>
        err instanceof CCIPArgumentInvalidError && /conflicts with --extra/.test(err.message),
    )
  })
})
