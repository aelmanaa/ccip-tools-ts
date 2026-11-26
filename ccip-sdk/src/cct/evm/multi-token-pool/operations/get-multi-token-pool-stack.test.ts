import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { getAddress } from 'ethers'

import { CPS, FPS, OTHER, PCM, POOL, defaultStack, stackChain } from '../stack.test.helpers.ts'
import { GetMultiTokenPoolStack } from './get-multi-token-pool-stack.ts'

const TOKEN_A = getAddress('0x' + 'a1'.repeat(20))
const TOKEN_B = getAddress('0x' + 'b1'.repeat(20))
const POOL_2 = getAddress('0x' + '99'.repeat(20))
const STALE_PCM = getAddress('0x' + 'cc'.repeat(20))

describe('GetMultiTokenPoolStack (cct/evm multi-token-pool)', () => {
  it('reports no finding on a consistent stack', async () => {
    const r = await new GetMultiTokenPoolStack().query(stackChain().chain, { poolAddress: POOL })
    assert.deepEqual(r.findings, [])
    assert.equal(r.policyStores.ConnectionPolicyStore.address, CPS)
    assert.deepEqual(r.poolsSharingPoolConfigManager, [])
  })

  it('reports wiring, owner, pending, delay and registration findings', async () => {
    const state = defaultStack()
    state.stores[FPS]!.callers = [STALE_PCM] // PCM missing, a stale PCM left
    state.others[STALE_PCM] = 'PoolConfigManager 2.1.0-dev'
    state.stores[CPS]!.callers = [PCM, OTHER] // an extra, non-PCM caller
    state.stores[CPS]!.owner = OTHER
    state.pool.pendingOwner = OTHER
    state.pcm.delay = 0n
    state.pcm.tokens = [TOKEN_A, TOKEN_B]
    state.tarPools = { [TOKEN_A]: POOL, [TOKEN_B]: POOL_2 } // B served by a single-token pool
    state.others[POOL_2] = 'BurnMintTokenPool 2.0.0'
    const r = await new GetMultiTokenPoolStack().query(stackChain(state).chain, {
      poolAddress: POOL,
    })
    // errors first, then by check: the same order on every run
    assert.deepEqual(
      r.findings.map((f) => f.check),
      [
        'PCM_NOT_ON_STORE',
        'EXTRA_STORE_CALLER',
        'OWNER_MISMATCH',
        'PENDING_OWNERSHIP',
        'REGISTRATION_DIVERGED',
        'STALE_PCM_AUTHORIZED',
        'ZERO_ADMIN_DELAY',
      ],
    )
    assert.equal(r.findings.find((f) => f.check === 'PCM_NOT_ON_STORE')!.severity, 'error')
  })

  it('flags a PCM whose TokenAdminRegistry is not the Router’s', async () => {
    const state = defaultStack()
    state.pcm.tar = OTHER
    const r = await new GetMultiTokenPoolStack().query(stackChain(state).chain, {
      poolAddress: POOL,
    })
    assert.deepEqual(
      r.findings.map((f) => f.check),
      ['TAR_MISMATCH'],
    )
  })
})
