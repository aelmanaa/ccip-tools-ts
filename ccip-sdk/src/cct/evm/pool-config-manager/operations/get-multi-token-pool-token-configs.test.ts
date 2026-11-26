import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ZeroAddress, ZeroHash, encodeBytes32String, getAddress, toBeHex } from 'ethers'

import { encodeFinality } from '../../../../extra-args.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { OTHER, POOL, defaultStack, stackChain } from '../../multi-token-pool/stack.test.helpers.ts'
import { GetMultiTokenPoolTokenConfigs } from './get-multi-token-pool-token-configs.ts'

const TOKEN = getAddress('0x' + 'a1'.repeat(20))

describe('GetMultiTokenPoolTokenConfigs (cct/evm pool-config-manager)', () => {
  it('decodes flavor, finality, optional addresses and policy names', async () => {
    const state = defaultStack()
    state.views.getTokenConfigBatch = ([tokens]) => [
      (tokens as string[]).map((t) =>
        t === TOKEN
          ? [
              true,
              18,
              3,
              toBeHex(encodeFinality({ finalityDepth: 5 }), 4),
              OTHER,
              ZeroAddress,
              [5009297550715157269n],
              encodeBytes32String('v5'),
              ZeroHash,
              ZeroHash,
              encodeBytes32String('fees'),
              ZeroHash,
              ZeroHash,
            ]
          : [
              false,
              0,
              0,
              '0x00000000',
              ZeroAddress,
              ZeroAddress,
              [],
              ZeroHash,
              ZeroHash,
              ZeroHash,
              ZeroHash,
              ZeroHash,
              ZeroHash,
            ],
      ),
    ]
    const [a, b] = await new GetMultiTokenPoolTokenConfigs().query(stackChain(state).chain, {
      poolAddress: POOL,
      tokenAddresses: [TOKEN.toLowerCase(), OTHER],
    })
    assert.deepEqual(a, {
      tokenAddress: TOKEN,
      isRegistered: true,
      localDecimals: 18,
      lockOrBurnFlavor: 'burn-to-address',
      allowedFinality: { finalityDepth: 5 },
      lockOrBurnAddress: OTHER,
      additionalPoolDataProvider: null,
      supportedChains: [5009297550715157269n],
      policies: {
        connection: 'v5',
        remotePool: null,
        rateLimit: null,
        fee: 'fees',
        destOverhead: null,
        security: null,
      },
    })
    assert.equal(b!.isRegistered, false)
  })

  it('rejects an empty or invalid token list before any RPC', async () => {
    const { chain, calls } = stackChain()
    for (const tokenAddresses of [[], ['nope']])
      await assert.rejects(
        new GetMultiTokenPoolTokenConfigs().query(chain, { poolAddress: POOL, tokenAddresses }),
        CCTParamsInvalidError,
      )
    assert.deepEqual(calls, [])
  })
})
