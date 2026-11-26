import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Interface, ZeroHash, getAddress, zeroPadValue } from 'ethers'

import '../../../../evm/index.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import {
  OTHER,
  defaultStack,
  revert,
  stackChain,
} from '../../multi-token-pool/stack.test.helpers.ts'
import { GetMultiTokenPoolProvider } from './get-multi-token-pool-provider.ts'

const PROVIDER = getAddress('0x' + 'e0'.repeat(20))
const TOKEN = getAddress('0x' + 'a1'.repeat(20))
const CHAIN = 16015286601757825753n

function providerStack(type: string) {
  const state = defaultStack()
  state.others[PROVIDER] = `${type} 2.1.0-dev`
  return state
}

const UID_ERRORS = new Interface(['error TokenNotFromFactory(address localToken, bytes32 uid)'])

describe('GetMultiTokenPoolProvider (cct/evm multi-token-pool-providers)', () => {
  it('reads a UID provider’s factory and a token’s pool data, null when not from the factory', async () => {
    const state = providerStack('FactoryTokenWithUIDPoolDataProvider')
    state.views.getTokenFactory = () => [OTHER]
    state.views.getAdditionalPoolData = ([token]) => {
      if (getAddress(token as string) !== TOKEN)
        throw revert(UID_ERRORS, 'TokenNotFromFactory', [token, ZeroHash])
      return ['0x' + '12'.repeat(32)]
    }
    const { chain } = stackChain(state)
    assert.deepEqual(
      await new GetMultiTokenPoolProvider().query(chain, {
        provider: PROVIDER,
        tokenAddress: TOKEN,
      }),
      {
        type: 'FactoryTokenWithUIDPoolDataProvider',
        tokenFactory: OTHER,
        additionalPoolData: '0x' + '12'.repeat(32),
      },
    )
    const other = await new GetMultiTokenPoolProvider().query(chain, {
      provider: PROVIDER,
      tokenAddress: OTHER,
    })
    assert.equal(other.additionalPoolData, null)
  })

  it('reads a SameAddress provider’s answer per chain, and requires the chain', async () => {
    const state = providerStack('SameAddressRemoteTokenAddressProvider')
    state.views.getRemoteTokenAddress = ([token]) => [zeroPadValue(token as string, 32)]
    const { chain } = stackChain(state)
    const r = await new GetMultiTokenPoolProvider().query(chain, {
      provider: PROVIDER,
      tokenAddress: TOKEN,
      remoteChainSelector: CHAIN,
    })
    assert.deepEqual(r, { type: 'SameAddressRemoteTokenAddressProvider', remoteToken: TOKEN })
    await assert.rejects(
      new GetMultiTokenPoolProvider().query(chain, { provider: PROVIDER, tokenAddress: TOKEN }),
      (e: unknown) =>
        e instanceof CCTParamsInvalidError && e.context.param === 'remoteChainSelector',
    )
  })

  it('propagates a UID read failure that is not TokenNotFromFactory', async () => {
    const state = providerStack('FactoryTokenWithUIDPoolDataProvider')
    state.views.getTokenFactory = () => [OTHER]
    state.views.getAdditionalPoolData = () => {
      throw new Error('a bare revert, with no data')
    }
    await assert.rejects(
      new GetMultiTokenPoolProvider().query(stackChain(state).chain, {
        provider: PROVIDER,
        tokenAddress: TOKEN,
      }),
      (e: unknown) => (e as { code?: string }).code === 'CALL_EXCEPTION',
    )
  })
})
