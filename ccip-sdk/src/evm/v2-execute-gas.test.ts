import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import { type JsonRpcApiProvider, ZeroHash } from 'ethers'

import { encodeMessageV1 } from './messageCodec.ts'
import { EVMChain } from './index.ts'

const OFFRAMP = '0xa4dbea3d88311edc1d76faa6342a39fe4d5102be'
const PAYER = '0x0af390e54c44bf0e2bad36a0bb1e5e0db34a3696'
const CCV = '0xaefff668a116c21842d15eabe217c93b2b4c2946'

// The campaign's Sepolia -> Fuji message held by a receiver-required CCV: executionGasLimit 492860,
// ccipReceiveGasLimit 200000 (`manual-exec -L 1500000` sent 591432 = 492860 * 1.2 and failed).
const encodedMessage = encodeMessageV1({
  sourceChainSelector: 16015286601757825753n,
  destChainSelector: 14767482510784806043n,
  messageNumber: 1n,
  executionGasLimit: 492_860,
  ccipReceiveGasLimit: 200_000,
  finality: '0x00000000',
  ccvAndExecutorHash: ZeroHash,
  onRampAddress: ZeroHash,
  offRampAddress: OFFRAMP,
  sender: ZeroHash,
  receiver: '0x111f47b296b28b0690d75ac42017ac745e33905f',
  data: '0x1234',
})

function makeChain(estimate: bigint) {
  const estimateGas = mock.fn(async () => estimate)
  const provider = { estimateGas } as unknown as JsonRpcApiProvider
  const chain = Object.create(EVMChain.prototype) as EVMChain
  Object.assign(chain, {
    provider,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  })
  return chain
}

async function txGasLimit(estimate: bigint, gasLimit?: number) {
  const result = await makeChain(estimate).generateUnsignedExecute({
    offRamp: OFFRAMP,
    input: { encodedMessage, verifications: [{ destAddress: CCV, ccvData: '0x01' }] },
    payer: PAYER,
    ...(gasLimit != null && { gasLimit }),
  })
  return result.transactions[0]!.gasLimit
}

describe('EVMChain.generateUnsignedExecute 2.0 OffRamp tx gas floor', () => {
  it('floors at 1.2x executionGasLimit without an override', async () => {
    // estimateGas converges on the swallowed-failure path of a first execution
    assert.equal(await txGasLimit(150_000n), 591_432n)
  })

  it('counts a larger gasLimitOverride instead of ccipReceiveGasLimit', async () => {
    // (492860 - 200000 + 1500000) * 1.2
    assert.equal(await txGasLimit(150_000n, 1_500_000), 2_151_432n)
  })

  it('keeps the message budget for an override at or below ccipReceiveGasLimit', async () => {
    assert.equal(await txGasLimit(150_000n, 200_000), 591_432n)
    assert.equal(await txGasLimit(150_000n, 100_000), 591_432n)
  })

  it('keeps an estimate above the floor', async () => {
    assert.equal(await txGasLimit(3_000_000n, 1_500_000), 3_000_000n)
  })
})
