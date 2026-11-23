import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import { getAddress, hexlify, randomBytes } from 'ethers'

import { getCCVCoverage } from './ccv-coverage.ts'
import type { Chain } from './chain.ts'
import { CCIPVersionUnsupportedError } from './errors/index.ts'
import { interfaces } from './evm/const.ts'
import { EVMChain } from './evm/index.ts'
import { ChainFamily, NetworkType } from './networks.ts'

const addr = () => getAddress(hexlify(randomBytes(20)))
const SEPOLIA = 16015286601757825753n
const FUJI = 14767482510784806043n

/**
 * An EVM source whose router points at `onRamp` (of `version`), with the lane `defaults`, and a
 * destination whose OffRamp view requires `required` + `threshold`.
 */
function lane({
  version = '2.0.0',
  defaults,
  required,
  threshold = 0,
  evmSource = true,
}: {
  version?: string
  defaults: string[]
  required: string[]
  threshold?: number
  evmSource?: boolean
}) {
  const router = addr()
  const onRamp = addr()
  const offRamp = addr()
  const provider = {
    call: async () =>
      interfaces.OnRamp_v2_0.encodeFunctionResult('getDestChainConfig', [
        {
          router,
          messageNumber: 1n,
          addressBytesLength: 20,
          tokenReceiverAllowed: false,
          messageNetworkFeeUSDCents: 0,
          tokenNetworkFeeUSDCents: 0,
          baseExecutionGasCost: 0,
          defaultExecutor: addr(),
          laneMandatedCCVs: [],
          defaultCCVs: defaults,
          offRamp: '0x',
        },
      ]),
  }
  const network = {
    name: 'ethereum-testnet-sepolia',
    chainId: 11155111,
    chainSelector: SEPOLIA,
    family: evmSource ? ChainFamily.EVM : ChainFamily.Solana,
    networkType: NetworkType.Testnet,
  }
  const methods = {
    network,
    provider,
    typeAndVersion: mock.fn(async (address: string) =>
      address === onRamp ? ['OnRamp', version, `OnRamp ${version}`] : ['Router', '1.2.0', ''],
    ),
    getOnRampForRouter: mock.fn(async () => onRamp),
    getOnRampConfig: mock.fn(async () => ({
      typeAndVersion: `OnRamp ${version}`,
      laneVersion: version,
      offRamp,
    })),
  }
  const source = evmSource
    ? (Object.assign(Object.create(EVMChain.prototype), methods) as EVMChain)
    : (methods as unknown as Chain)
  const getRequiredCCVs = mock.fn(async (_opts: { offRamp: string }) => ({
    requiredCCVs: required,
    optionalCCVs: [],
    optionalThreshold: threshold,
  }))
  const dest = {
    network: {
      ...network,
      name: 'avalanche-testnet-fuji',
      chainSelector: FUJI,
      family: ChainFamily.EVM,
    },
    getRequiredCCVs,
  } as unknown as Chain
  return { source, dest, router, offRamp, getRequiredCCVs }
}

const message = { receiver: addr(), data: '0x01', sender: addr() }

describe('getCCVCoverage', () => {
  it('reports a message carrying fewer CCVs than the destination requires', async () => {
    const { source, dest, router, offRamp, getRequiredCCVs } = lane({
      defaults: [addr()],
      required: [addr(), addr()],
    })
    const coverage = await getCCVCoverage({ source, dest, routerOrRamp: router, message })
    assert.equal(coverage.needed, 2)
    assert.equal(coverage.messageCCVs?.length, 1)
    assert.equal(coverage.enoughCCVs, false)
    assert.equal(getRequiredCCVs.mock.calls[0]!.arguments[0].offRamp, offRamp)
  })

  it('counts the optional threshold, and accepts enough CCVs', async () => {
    const { source, dest, router } = lane({
      defaults: [addr(), addr()],
      required: [addr()],
      threshold: 1,
    })
    const coverage = await getCCVCoverage({ source, dest, routerOrRamp: router, message })
    assert.equal(coverage.needed, 2)
    assert.equal(coverage.enoughCCVs, true)
  })

  it('gives no verdict for a source family it cannot predict', async () => {
    const { source, dest, router } = lane({ defaults: [], required: [addr()], evmSource: false })
    const coverage = await getCCVCoverage({ source, dest, routerOrRamp: router, message })
    assert.equal(coverage.needed, 1)
    assert.equal(coverage.messageCCVs, undefined)
    assert.equal(coverage.enoughCCVs, undefined)
  })

  it('refuses a pre-2.0 lane before reading the destination', async () => {
    const { source, dest, router, getRequiredCCVs } = lane({
      version: '1.6.0',
      defaults: [],
      required: [],
    })
    await assert.rejects(
      getCCVCoverage({ source, dest, routerOrRamp: router, message }),
      CCIPVersionUnsupportedError,
    )
    assert.equal(getRequiredCCVs.mock.callCount(), 0)
  })
})
