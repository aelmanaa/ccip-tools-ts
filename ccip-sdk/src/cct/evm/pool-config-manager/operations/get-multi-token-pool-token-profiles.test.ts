import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ZeroAddress, getAddress } from 'ethers'

import { CPS, POOL, defaultStack, stackChain } from '../../multi-token-pool/stack.test.helpers.ts'
import { GetMultiTokenPoolTokenProfiles } from './get-multi-token-pool-token-profiles.ts'

const TOKEN = getAddress('0x' + 'a1'.repeat(20))

describe('GetMultiTokenPoolTokenProfiles (cct/evm pool-config-manager)', () => {
  it('reads profiles from the connection store, with pause flags and deregistered profiles', async () => {
    const state = defaultStack()
    const to: string[] = []
    state.views.getTokenProfiles = ([tokens], addr) => (
      to.push(addr),
      [
        (tokens as string[]).map(() => [
          false,
          6,
          1,
          ZeroAddress,
          '0x00000000',
          true,
          false,
          ZeroAddress,
        ]),
      ]
    )
    const [p] = await new GetMultiTokenPoolTokenProfiles().query(stackChain(state).chain, {
      poolAddress: POOL,
      tokenAddresses: [TOKEN],
    })
    assert.deepEqual(to, [CPS])
    assert.deepEqual(p, {
      tokenAddress: TOKEN,
      isRegistered: false,
      localDecimals: 6,
      lockOrBurnFlavor: 'burn-from',
      allowedFinality: { finalityDepth: 0 },
      lockOrBurnAddress: null,
      additionalPoolDataProvider: null,
      isOutboundPaused: true,
      isInboundPaused: false,
    })
  })
})
