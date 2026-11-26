import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ZeroAddress } from 'ethers'

import { CCTParamsInvalidError } from '../../../errors.ts'
import { OTHER, POOL, defaultStack, stackChain } from '../stack.test.helpers.ts'
import { IsMultiTokenPool } from './is-multi-token-pool.ts'

describe('IsMultiTokenPool (cct/evm multi-token-pool)', () => {
  it('answers from ERC-165 IMultiTokenPool without reading typeAndVersion', async () => {
    const { chain, calls } = stackChain()
    assert.equal(await new IsMultiTokenPool().query(chain, { poolAddress: POOL }), true)
    assert.ok(!calls.some((c) => c.startsWith('typeAndVersion')))
  })

  it('falls back to the typeAndVersion name when ERC-165 is missing', async () => {
    const state = defaultStack()
    state.pool.supports165 = false
    assert.equal(
      await new IsMultiTokenPool().query(stackChain(state).chain, { poolAddress: POOL }),
      true,
    )
    state.pool.typeAndVersion = 'BurnMintTokenPool 2.0.0'
    assert.equal(
      await new IsMultiTokenPool().query(stackChain(state).chain, { poolAddress: POOL }),
      false,
    )
  })

  it('answers false for the hook contracts, which share the name stem', async () => {
    for (const type of ['MultiTokenPoolHooks', 'MultiTokenPoolHooksExternalBlocklist']) {
      const state = defaultStack()
      state.others[OTHER] = `${type} 2.1.0-dev`
      assert.equal(
        await new IsMultiTokenPool().query(stackChain(state).chain, { poolAddress: OTHER }),
        false,
      )
    }
  })

  it('answers false for an address with neither ERC-165 nor typeAndVersion', async () => {
    assert.equal(
      await new IsMultiTokenPool().query(stackChain().chain, { poolAddress: OTHER }),
      false,
    )
  })

  it('propagates a transport error instead of answering false', async () => {
    const { chain } = stackChain()
    chain.provider.call = () =>
      Promise.reject(Object.assign(new Error('down'), { code: 'NETWORK_ERROR' }))
    await assert.rejects(new IsMultiTokenPool().query(chain, { poolAddress: POOL }), /down/)
  })

  it('rejects a zero address before any RPC', async () => {
    const { chain, calls } = stackChain()
    await assert.rejects(
      new IsMultiTokenPool().query(chain, { poolAddress: ZeroAddress }),
      CCTParamsInvalidError,
    )
    assert.deepEqual(calls, [])
  })
})
