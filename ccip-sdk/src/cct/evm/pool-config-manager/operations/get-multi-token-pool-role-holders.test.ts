import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CCTParamsInvalidError } from '../../../errors.ts'
import {
  OTHER,
  OWNER,
  POOL,
  defaultStack,
  stackChain,
} from '../../multi-token-pool/stack.test.helpers.ts'
import { GetMultiTokenPoolRoleHolders } from './get-multi-token-pool-role-holders.ts'

describe('GetMultiTokenPoolRoleHolders (cct/evm pool-config-manager)', () => {
  it('scans from the deployment block and confirms holders with hasRole', async () => {
    const state = defaultStack()
    // granted then revoked: still in the logs, no longer a holder
    state.roleLogs.push({
      event: 'RoleGranted',
      role: 'PAUSER_ROLE',
      account: OTHER,
      blockNumber: 200,
    })
    state.roleLogs.push({
      event: 'RoleRevoked',
      role: 'PAUSER_ROLE',
      account: OTHER,
      blockNumber: 300,
    })
    const { chain, calls } = stackChain(state)
    const r = await new GetMultiTokenPoolRoleHolders().query(chain, { poolAddress: POOL })
    assert.deepEqual(r.holders.DEFAULT_ADMIN_ROLE, [OWNER])
    assert.deepEqual(r.holders.CONFIG_ROLE, [OWNER])
    assert.deepEqual(r.holders.PAUSER_ROLE, [])
    assert.deepEqual(r.scanned, { fromBlock: 100, toBlock: 1_000 })
    assert.equal(r.complete, true)
    assert.ok(calls.includes('getLogs:100-1000'))
  })

  it('is incomplete when the scan starts after the deployment', async () => {
    const r = await new GetMultiTokenPoolRoleHolders().query(stackChain().chain, {
      poolAddress: POOL,
      fromBlock: 101,
    })
    assert.equal(r.complete, false)
    assert.deepEqual(r.holders.DEFAULT_ADMIN_ROLE, [])
  })

  it('counts a scan from block 0 as complete, without searching for the deployment', async () => {
    const { chain, calls } = stackChain()
    const r = await new GetMultiTokenPoolRoleHolders().query(chain, {
      poolAddress: POOL,
      fromBlock: 0,
    })
    assert.equal(r.complete, true)
    assert.ok(!calls.some((c) => c.startsWith('getCode')))
  })

  it('propagates an RPC failure during the deployment search instead of asking for fromBlock', async () => {
    const { chain } = stackChain()
    const throttled = Object.assign(new Error('429 Too Many Requests'), { code: 'SERVER_ERROR' })
    chain.provider.getCode = () => Promise.reject(throttled)
    await assert.rejects(
      new GetMultiTokenPoolRoleHolders().query(chain, { poolAddress: POOL }),
      (e: unknown) => e === throttled,
    )
  })

  it('asks for fromBlock when the RPC cannot serve historical code', async () => {
    const { chain } = stackChain()
    chain.provider.getCode = () =>
      Promise.reject(Object.assign(new Error('missing trie node'), { code: 'SERVER_ERROR' }))
    await assert.rejects(
      new GetMultiTokenPoolRoleHolders().query(chain, { poolAddress: POOL }),
      (e: unknown) => e instanceof CCTParamsInvalidError && e.context.param === 'fromBlock',
    )
  })

  it('rejects bad ranges before any RPC', async () => {
    const { chain, calls } = stackChain()
    for (const p of [{ fromBlock: 5, toBlock: 4 }, { maxBlockRange: 0 }, { fromBlock: -1 }])
      await assert.rejects(
        new GetMultiTokenPoolRoleHolders().query(chain, { poolAddress: POOL, ...p }),
        CCTParamsInvalidError,
      )
    assert.deepEqual(calls, [])
  })
})
