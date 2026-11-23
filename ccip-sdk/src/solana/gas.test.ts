import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import { type Connection, type VersionedTransaction, Keypair, PublicKey } from '@solana/web3.js'
import { hexlify, randomBytes, sha256, toUtf8Bytes } from 'ethers'

import { sizedCoder } from './coder.ts'
import { estimateExecComputeUnits, getReceiverInterfaceVersion } from './gas.ts'
import { IDL as RECEIVER_V2_IDL } from './idl/2.0.0/CCIP_RECEIVER.ts'

const randomPublicKey = () => Keypair.generate().publicKey.toBase58()

const discriminator = (name: string) => Buffer.from(sha256(toUtf8Bytes(name)).slice(2, 18), 'hex')
const CCIP_RECEIVE = discriminator('global:ccip_receive')
const CCIP_RECEIVE_V2 = discriminator('global:ccip_receive_v2')

/** A Router-owned `ReceiverRegistry` account for `receiver`, as the Router writes it. */
async function registryAccount(
  router: PublicKey,
  receiver: PublicKey,
  receiverVersion: number,
  version = 1,
) {
  const data = await sizedCoder(RECEIVER_V2_IDL).accounts.encode('ReceiverRegistry', {
    bump: 255,
    version,
    receiverProgram: receiver,
    receiverVersion,
  })
  return { owner: router, data, executable: false, lamports: 1_000_000 }
}

/** Mock connection: records the simulated receiver instruction; `registry` answers getAccountInfo. */
function mockConnection(registry: Awaited<ReturnType<typeof registryAccount>> | null) {
  const simulated: Buffer[] = []
  const getAccountInfo = mock.fn(async () => registry)
  const simulateTransaction = mock.fn(async (tx: VersionedTransaction) => {
    const ixs = tx.message.compiledInstructions
    simulated.push(Buffer.from(ixs[ixs.length - 1]!.data))
    return { value: { err: null, logs: [], unitsConsumed: 1_000 } }
  })
  return {
    connection: { getAccountInfo, simulateTransaction } as unknown as Connection,
    getAccountInfo,
    simulated,
  }
}

describe('estimateExecComputeUnits', () => {
  it('simulates a standard Solana ccip_receive callback', async () => {
    const simulateTransaction = mock.fn(async () => ({
      value: {
        err: null,
        logs: [],
        unitsConsumed: 123_456,
      },
    }))
    const connection = { simulateTransaction } as unknown as Connection

    const estimated = await estimateExecComputeUnits({
      connection,
      router: randomPublicKey(),
      offRamp: randomPublicKey(),
      message: {
        sourceChainSelector: 1n,
        messageId: hexlify(randomBytes(32)),
        receiver: randomPublicKey(),
        sender: '0x0000000000000000000000000000000000000001',
        data: '0x1234',
        accounts: [randomPublicKey(), randomPublicKey()],
        accountIsWritableBitmap: 2n,
        destTokenAmounts: [{ token: randomPublicKey(), amount: 100n }],
      },
    })

    assert.equal(estimated, 123_456)
    assert.equal(simulateTransaction.mock.calls.length, 1)
  })

  it('returns zero without simulation when there is no receiver callback', async () => {
    const simulateTransaction = mock.fn()
    const connection = { simulateTransaction } as unknown as Connection

    const estimated = await estimateExecComputeUnits({
      connection,
      router: randomPublicKey(),
      offRamp: randomPublicKey(),
      message: {
        sourceChainSelector: 1n,
        messageId: hexlify(randomBytes(32)),
        receiver: PublicKey.default.toBase58(),
      },
    })

    assert.equal(estimated, 0)
    assert.equal(simulateTransaction.mock.calls.length, 0)
  })

  describe('receiver interface (ReceiverRegistry)', () => {
    const router = Keypair.generate().publicKey
    const receiver = Keypair.generate().publicKey
    const evmSender = '0x00000000000000000000000000000000000000aa'
    const message = {
      sourceChainSelector: 16015286601757825753n,
      messageId: hexlify(randomBytes(32)),
      receiver: receiver.toBase58(),
      sender: evmSender,
      data: '0x1234',
      accounts: [randomPublicKey()],
      accountIsWritableBitmap: 1n,
    }

    it('simulates ccip_receive_v2 for a receiver registered v2 behind a 2.x OffRamp', async () => {
      const { connection, simulated } = mockConnection(await registryAccount(router, receiver, 2))
      const tokenReceiver = randomPublicKey()
      const mint = randomPublicKey()
      await estimateExecComputeUnits({
        connection,
        router: router.toBase58(),
        offRamp: randomPublicKey(),
        offRampVersion: '2.0.0',
        message: { ...message, tokenReceiver, destTokenAmounts: [{ token: mint, amount: 7n }] },
        logger: { ...console, debug: () => {} },
      })
      const data = simulated[0]!
      assert.deepEqual(data.subarray(0, 8), CCIP_RECEIVE_V2)
      const decoded = sizedCoder(RECEIVER_V2_IDL).types.decode('Any2SVMMessageV2', data.subarray(8))
      // the OffRamp delivers an EVM sender as abi.encode(address): 32 bytes
      assert.equal(Buffer.from(decoded.sender).toString('hex'), '00'.repeat(31) + 'aa')
      assert.equal(decoded.tokenTransfer.tokenAmount.token.toBase58(), mint)
      assert.equal(decoded.tokenTransfer.tokenAmount.amount.toString(), '7')
      assert.equal(decoded.tokenTransfer.tokenReceiver.toBase58(), tokenReceiver)
      assert.deepEqual(decoded.tokenTransfer.tokenReceiverUsage, { deriveAtaAndCreate: {} })
    })

    it('encodes a data-only v2 message with no token transfer', async () => {
      const { connection, simulated } = mockConnection(await registryAccount(router, receiver, 2))
      await estimateExecComputeUnits({
        connection,
        router: router.toBase58(),
        offRamp: randomPublicKey(),
        offRampVersion: '2.0.0',
        message,
      })
      assert.deepEqual(simulated[0]!.subarray(0, 8), CCIP_RECEIVE_V2)
      const decoded = sizedCoder(RECEIVER_V2_IDL).types.decode(
        'Any2SVMMessageV2',
        simulated[0]!.subarray(8),
      )
      assert.equal(decoded.tokenTransfer, null)
      assert.equal(Buffer.from(decoded.data).toString('hex'), '1234')
    })

    it('keeps v1 ccip_receive for an unregistered receiver behind a 2.x OffRamp', async () => {
      const { connection, simulated, getAccountInfo } = mockConnection(null)
      await estimateExecComputeUnits({
        connection,
        router: router.toBase58(),
        offRamp: randomPublicKey(),
        offRampVersion: '2.0.0',
        message,
      })
      assert.equal(getAccountInfo.mock.calls.length, 1)
      assert.deepEqual(simulated[0]!.subarray(0, 8), CCIP_RECEIVE)
    })

    it('keeps v1 ccip_receive for a receiver registered v1', async () => {
      const { connection, simulated } = mockConnection(await registryAccount(router, receiver, 1))
      await estimateExecComputeUnits({
        connection,
        router: router.toBase58(),
        offRamp: randomPublicKey(),
        offRampVersion: '2.0.0',
        message,
      })
      assert.deepEqual(simulated[0]!.subarray(0, 8), CCIP_RECEIVE)
    })

    it('keeps v1 ccip_receive (and the v1 payload) behind a 1.6 OffRamp, without reading the registry', async () => {
      const { connection, simulated, getAccountInfo } = mockConnection(
        await registryAccount(router, receiver, 2),
      )
      await estimateExecComputeUnits({
        connection,
        router: router.toBase58(),
        offRamp: randomPublicKey(),
        offRampVersion: '1.6.0',
        message,
      })
      assert.equal(getAccountInfo.mock.calls.length, 0)
      assert.deepEqual(simulated[0]!.subarray(0, 8), CCIP_RECEIVE)
    })

    it('reads the registry as the OffRamp does', async () => {
      const read = (registry: Awaited<ReturnType<typeof registryAccount>> | null) =>
        getReceiverInterfaceVersion({
          connection: mockConnection(registry).connection,
          router: router.toBase58(),
          receiver: receiver.toBase58(),
          logger: { ...console, debug: () => {} },
        })
      assert.equal(await read(null), 1)
      assert.equal(await read(await registryAccount(router, receiver, 2)), 2)
      assert.equal(await read(await registryAccount(router, receiver, 1)), 1)
      // not Router-owned (e.g. a lamport pre-fund leaves it System-owned): absent
      const foreign = await registryAccount(Keypair.generate().publicKey, receiver, 2)
      assert.equal(await read(foreign), 1)
      // an unknown schema version is not trusted
      assert.equal(await read(await registryAccount(router, receiver, 2, 9)), 1)
    })
  })
})
