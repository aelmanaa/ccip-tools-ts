import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CCTContractTypeInvalidError, CCTParamsInvalidError } from '../../../errors.ts'
import {
  CPS,
  FPS,
  OTHER,
  OWNER,
  PCM,
  POOL,
  SPS,
  TAR,
  defaultStack,
  stackChain,
} from '../../multi-token-pool/stack.test.helpers.ts'
import { GetPoolConfigManagerState } from './get-pool-config-manager-state.ts'

describe('GetPoolConfigManagerState (cct/evm pool-config-manager)', () => {
  it('reads the PCM through the pool, with its stores and default-admin state', async () => {
    assert.deepEqual(
      await new GetPoolConfigManagerState().query(stackChain().chain, { poolAddress: POOL }),
      {
        poolConfigManager: PCM,
        version: '2.1.0-dev',
        typeAndVersion: 'PoolConfigManager 2.1.0-dev',
        tokenAdminRegistry: TAR,
        connectionPolicyStore: CPS,
        feePolicyStore: FPS,
        securityPolicyStore: SPS,
        defaultAdmin: OWNER,
        pendingDefaultAdmin: null,
        defaultAdminDelay: 86_400,
        pendingDefaultAdminDelay: null,
        defaultAdminDelayIncreaseWait: 432_000,
      },
    )
  })

  it('reports scheduled admin and delay changes', async () => {
    const state = defaultStack()
    state.pcm.pendingDefaultAdmin = [OTHER, 1_800_000_000n]
    state.pcm.pendingDelay = [0n, 1_800_000_100n]
    const r = await new GetPoolConfigManagerState().query(stackChain(state).chain, {
      poolConfigManager: PCM,
    })
    assert.deepEqual(r.pendingDefaultAdmin, { newAdmin: OTHER, schedule: 1_800_000_000n })
    assert.deepEqual(r.pendingDefaultAdminDelay, { newDelay: 0, schedule: 1_800_000_100n })
  })

  it('resolves the PCM by its own typeAndVersion and refuses another contract', async () => {
    const state = defaultStack()
    state.pcm.typeAndVersion = 'ConnectionPolicyStore 2.1.0-dev'
    await assert.rejects(
      new GetPoolConfigManagerState().query(stackChain(state).chain, { poolConfigManager: PCM }),
      CCTContractTypeInvalidError,
    )
  })

  it('requires exactly one of poolAddress or poolConfigManager, before any RPC', async () => {
    const { chain, calls } = stackChain()
    for (const target of [{}, { poolAddress: POOL, poolConfigManager: PCM }])
      await assert.rejects(
        new GetPoolConfigManagerState().query(chain, target as never),
        (e: unknown) => e instanceof CCTParamsInvalidError && e.context.param === 'poolAddress',
      )
    assert.deepEqual(calls, [])
  })
})
