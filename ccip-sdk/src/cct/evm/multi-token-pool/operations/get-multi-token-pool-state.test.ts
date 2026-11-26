import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  CCTContractTypeInvalidError,
  CCTDataDecodeError,
  CCTParamsInvalidError,
} from '../../../errors.ts'
import {
  OTHER,
  OWNER,
  PCM,
  POOL,
  RMN,
  ROUTER,
  defaultStack,
  stackChain,
} from '../stack.test.helpers.ts'
import { GetMultiTokenPoolState } from './get-multi-token-pool-state.ts'

describe('GetMultiTokenPoolState (cct/evm multi-token-pool)', () => {
  it('reads type, version, owner, Router, RMN proxy, PCM and no pending owner', async () => {
    assert.deepEqual(
      await new GetMultiTokenPoolState().query(stackChain().chain, { poolAddress: POOL }),
      {
        type: 'BurnMintMultiTokenPool',
        version: '2.1.0-dev',
        typeAndVersion: 'BurnMintMultiTokenPool 2.1.0-dev',
        owner: OWNER,
        pendingOwner: null,
        router: ROUTER,
        rmnProxy: RMN,
        poolConfigManager: PCM,
      },
    )
  })

  it('reads a pending owner from the Ownable2Step slot', async () => {
    const state = defaultStack()
    state.pool.pendingOwner = OTHER
    const result = await new GetMultiTokenPoolState().query(stackChain(state).chain, {
      poolAddress: POOL,
    })
    assert.equal(result.pendingOwner, OTHER)
  })

  it('refuses to guess when the owner slot does not hold owner()', async () => {
    const { chain } = stackChain()
    const getStorage = chain.provider.getStorage.bind(chain.provider)
    chain.provider.getStorage = (a: string, slot: bigint) =>
      slot === 1n ? Promise.resolve('0x' + '00'.repeat(32)) : getStorage(a, slot)
    await assert.rejects(
      new GetMultiTokenPoolState().query(chain, { poolAddress: POOL }),
      CCTDataDecodeError,
    )
  })

  it('refuses a single-token pool', async () => {
    const state = defaultStack()
    state.pool.typeAndVersion = 'BurnMintTokenPool 2.0.0'
    await assert.rejects(
      new GetMultiTokenPoolState().query(stackChain(state).chain, { poolAddress: POOL }),
      CCTContractTypeInvalidError,
    )
  })

  it('rejects an invalid address before any RPC', async () => {
    const { chain, calls } = stackChain()
    await assert.rejects(
      new GetMultiTokenPoolState().query(chain, { poolAddress: '0x12' }),
      CCTParamsInvalidError,
    )
    assert.deepEqual(calls, [])
  })
})
