/**
 * Post-broadcast safety for `EVMChain.sendMessage`. See {@link CCIPSendTxStatusUnknownError}.
 */
import assert from 'node:assert/strict'
import { after, beforeEach, describe, it, mock } from 'node:test'

import { getAddress, hexlify, randomBytes } from 'ethers'

import { EVMChain } from './index.ts'
import { CCIPErrorCode } from '../errors/codes.ts'
import { CCIPSendTxStatusUnknownError, isTransientError } from '../errors/index.ts'
import { ChainFamily, NetworkType } from '../networks.ts'

const SENDER = getAddress(hexlify(randomBytes(20)))
const TX_HASH = hexlify(randomBytes(32))

/** An EVMChain whose broadcast succeeds and whose post-broadcast read fails as configured. */
function makeChain(wait: () => Promise<unknown>) {
  const chain = Object.create(EVMChain.prototype) as EVMChain
  Object.assign(chain, {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    network: {
      name: 'ethereum-testnet-sepolia',
      chainId: 11155111,
      chainSelector: 16015286601757825753n,
      family: ChainFamily.EVM,
      networkType: NetworkType.Testnet,
    },
    provider: {},
    nonces: { [SENDER]: 1 },
    nextNonce: mock.fn(() => Promise.resolve(1)),
    generateUnsignedSendMessage: mock.fn(() =>
      Promise.resolve({ transactions: [{ to: getAddress(hexlify(randomBytes(20))), data: '0x' }] }),
    ),
    // reached only if the post-broadcast read succeeds
    getTransaction: mock.fn(() => Promise.resolve({ hash: TX_HASH, logs: [] })),
    getMessagesInTx: mock.fn(() => Promise.resolve([{ message: { messageId: '0x01' } }])),
  })
  const wallet = {
    getAddress: () => Promise.resolve(SENDER),
    signTransaction: () => Promise.resolve('0x'),
    populateTransaction: (tx: unknown) => Promise.resolve(tx),
    sendTransaction: mock.fn(() => Promise.resolve({ hash: TX_HASH, wait })),
  }
  return { chain, wallet }
}

const send = (chain: EVMChain, wallet: unknown) =>
  chain.sendMessage({
    router: getAddress(hexlify(randomBytes(20))),
    message: { receiver: getAddress(hexlify(randomBytes(20))), data: '0x' },
    wallet,
  } as Parameters<EVMChain['sendMessage']>[0])

void describe('EVMChain.sendMessage — post-broadcast safety', () => {
  void beforeEach(() => mock.restoreAll())
  void after(() => mock.restoreAll())

  void it('a failed read after broadcast surfaces the tx hash, not a bare RPC error', async () => {
    const { chain, wallet } = makeChain(() => Promise.reject(new Error('timeout exceeded')))
    await assert.rejects(
      () => send(chain, wallet),
      (err: unknown) => {
        assert.ok(err instanceof CCIPSendTxStatusUnknownError)
        assert.equal(err.context['txHash'], TX_HASH)
        assert.equal(err.code, CCIPErrorCode.SEND_TX_STATUS_UNKNOWN)
        return true
      },
    )
  })

  void it('a null receipt is treated the same as a failed read', async () => {
    const { chain, wallet } = makeChain(() => Promise.resolve(null))
    await assert.rejects(
      () => send(chain, wallet),
      (err: unknown) => {
        assert.ok(err instanceof CCIPSendTxStatusUnknownError)
        assert.equal(err.context['txHash'], TX_HASH)
        return true
      },
    )
  })

  void it('is never retry-safe: the tokens already moved', async () => {
    // `CCIPExecTxNotConfirmedError` IS transient — re-running manual-exec is rejected on-chain.
    // Re-running send is not: it broadcasts a second message.
    const err = new CCIPSendTxStatusUnknownError(TX_HASH)
    assert.equal(err.isTransient, false)
    assert.equal(isTransientError(err.code), false)
    assert.equal(err.context['txHash'], TX_HASH)
    assert.match(err.recovery!, /do NOT re-run send/)
  })

  void it('a successful read still returns the parsed request', async () => {
    const { chain, wallet } = makeChain(() => Promise.resolve({ hash: TX_HASH }))
    const request = await send(chain, wallet)
    assert.equal(request.message.messageId, '0x01')
  })
})
