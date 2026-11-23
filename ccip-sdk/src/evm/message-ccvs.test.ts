import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { type JsonRpcApiProvider, ZeroAddress, getAddress, hexlify, randomBytes } from 'ethers'

import type { AnyMessage } from '../types.ts'
import { interfaces } from './const.ts'
import { getOnRampMessageCCVs } from './message-ccvs.ts'
import { IPOOL_V2_INTERFACE_ID } from './simulate.ts'

const addr = () => getAddress(hexlify(randomBytes(20)))
const DEST = 14767482510784806043n
const ONRAMP = addr()
const RECEIVER = addr()
const TOKEN = addr()
const POOL = addr()

const onRampIface = interfaces.OnRamp_v2_0
const poolIface = interfaces.TokenPool_v2_0

/** A provider answering the OnRamp and pool reads the resolution makes. */
function mockProvider({
  defaults,
  mandated = [],
  poolV2 = true,
  poolCCVs = [],
}: {
  defaults: string[]
  mandated?: string[]
  poolV2?: boolean
  poolCCVs?: string[]
}) {
  const poolCalls: unknown[][] = []
  const provider = {
    call: async ({ to, data }: { to: string; data: string }) => {
      const sel = data.slice(0, 10)
      if (to === ONRAMP && sel === onRampIface.getFunction('getDestChainConfig')!.selector) {
        const config = {
          router: addr(),
          messageNumber: 1n,
          addressBytesLength: 20,
          tokenReceiverAllowed: false,
          messageNetworkFeeUSDCents: 0,
          tokenNetworkFeeUSDCents: 0,
          baseExecutionGasCost: 0,
          defaultExecutor: addr(),
          laneMandatedCCVs: mandated,
          defaultCCVs: defaults,
          offRamp: '0x',
        }
        return onRampIface.encodeFunctionResult('getDestChainConfig', [config])
      }
      if (to === ONRAMP && sel === onRampIface.getFunction('getPoolBySourceToken')!.selector)
        return onRampIface.encodeFunctionResult('getPoolBySourceToken', [POOL])
      if (to === POOL && sel === poolIface.getFunction('supportsInterface')!.selector) {
        const [id] = poolIface.decodeFunctionData('supportsInterface', data)
        return poolIface.encodeFunctionResult('supportsInterface', [
          poolV2 && id === IPOOL_V2_INTERFACE_ID,
        ])
      }
      if (to === POOL && sel === poolIface.getFunction('getRequiredCCVs')!.selector) {
        poolCalls.push([...poolIface.decodeFunctionData('getRequiredCCVs', data)])
        return poolIface.encodeFunctionResult('getRequiredCCVs', [poolCCVs])
      }
      throw new Error(`unexpected call to ${to} ${sel}`)
    },
  } as unknown as JsonRpcApiProvider
  return { provider, poolCalls }
}

const dataMessage = (extraArgs: AnyMessage['extraArgs']): AnyMessage => ({
  receiver: RECEIVER,
  data: '0x01',
  extraArgs,
})
const tokenMessage = (extraArgs: AnyMessage['extraArgs']): AnyMessage => ({
  receiver: RECEIVER,
  data: '0x',
  tokenAmounts: [{ token: TOKEN, amount: 5n }],
  extraArgs,
})
const v3 = (ccvs: string[], gasLimit = 200_000n) => ({
  gasLimit,
  finality: 'finalized' as const,
  ccvs,
  ccvArgs: ccvs.map(() => '0x'),
  executor: '',
  executorArgs: '0x',
  tokenReceiver: '',
  tokenArgs: '0x',
})

describe('getOnRampMessageCCVs', () => {
  const D = addr()
  const M = addr()
  const U = addr()
  const P = addr()

  it('uses the lane defaults and mandated CCVs for a data message with legacy args', async () => {
    const { provider } = mockProvider({ defaults: [D], mandated: [M, D] })
    const ccvs = await getOnRampMessageCCVs(provider, {
      onRamp: ONRAMP,
      destChainSelector: DEST,
      message: dataMessage({ gasLimit: 200_000n, allowOutOfOrderExecution: true }),
    })
    assert.deepEqual(ccvs, [D, M])
  })

  it('replaces the zero-address placeholder with the defaults, after the user CCVs', async () => {
    const { provider } = mockProvider({ defaults: [D] })
    const ccvs = await getOnRampMessageCCVs(provider, {
      onRamp: ONRAMP,
      destChainSelector: DEST,
      message: dataMessage(v3([ZeroAddress, U])),
    })
    assert.deepEqual(ccvs, [U, D])
  })

  it('accepts the placeholder parsed as a number (ccip-cli -x ccvs=[0x000…0])', async () => {
    const { provider } = mockProvider({ defaults: [D] })
    const ccvs = await getOnRampMessageCCVs(provider, {
      onRamp: ONRAMP,
      destChainSelector: DEST,
      message: dataMessage({ ...v3([U]), ccvs: [0n as unknown as string, U] }),
    })
    assert.deepEqual(ccvs, [U, D])
  })

  it('keeps only the user CCVs without a placeholder', async () => {
    const { provider } = mockProvider({ defaults: [D] })
    const ccvs = await getOnRampMessageCCVs(provider, {
      onRamp: ONRAMP,
      destChainSelector: DEST,
      message: dataMessage(v3([U])),
    })
    assert.deepEqual(ccvs, [U])
  })

  it('adds no defaults for a token-only transfer, then the pool CCVs (defaults for an empty list)', async () => {
    const { provider, poolCalls } = mockProvider({ defaults: [D], poolCCVs: [] })
    const ccvs = await getOnRampMessageCCVs(provider, {
      onRamp: ONRAMP,
      destChainSelector: DEST,
      message: tokenMessage({ gasLimit: 0n, allowOutOfOrderExecution: true }),
    })
    assert.deepEqual(ccvs, [D])
    // token, remote chain, amount, finality bytes4, tokenArgs, Outbound
    assert.deepEqual(poolCalls[0], [TOKEN, DEST, 5n, '0x00000000', '0x', 0n])
  })

  it("resolves the pool's zero-address entry to the defaults", async () => {
    const { provider } = mockProvider({ defaults: [D], poolCCVs: [P, ZeroAddress] })
    const ccvs = await getOnRampMessageCCVs(provider, {
      onRamp: ONRAMP,
      destChainSelector: DEST,
      message: tokenMessage({ gasLimit: 0n, allowOutOfOrderExecution: true }),
    })
    assert.deepEqual(ccvs, [P, D])
  })

  it('uses the defaults for a pool without IPoolV2', async () => {
    const { provider, poolCalls } = mockProvider({ defaults: [D], poolV2: false, poolCCVs: [P] })
    const ccvs = await getOnRampMessageCCVs(provider, {
      onRamp: ONRAMP,
      destChainSelector: DEST,
      message: tokenMessage(v3([U], 0n)),
    })
    assert.deepEqual(ccvs, [U, D])
    assert.equal(poolCalls.length, 0)
  })

  it('counts the defaults of a token message with data or a gas limit', async () => {
    const { provider } = mockProvider({ defaults: [D], poolCCVs: [P] })
    const ccvs = await getOnRampMessageCCVs(provider, {
      onRamp: ONRAMP,
      destChainSelector: DEST,
      message: tokenMessage({ gasLimit: 100_000n, allowOutOfOrderExecution: true }),
    })
    assert.deepEqual(ccvs, [D, P])
  })
})
