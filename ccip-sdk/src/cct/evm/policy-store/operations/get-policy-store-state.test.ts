import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CCTContractTypeInvalidError, CCTParamsInvalidError } from '../../../errors.ts'
import {
  CPS,
  OTHER,
  OWNER,
  PCM,
  POOL,
  defaultStack,
  stackChain,
} from '../../multi-token-pool/stack.test.helpers.ts'
import { GetPolicyStoreState } from './get-policy-store-state.ts'

describe('GetPolicyStoreState (cct/evm policy-store)', () => {
  it('reads type, version, owner, pending owner and authorized callers', async () => {
    const state = defaultStack()
    state.stores[CPS]!.pendingOwner = OTHER
    assert.deepEqual(
      await new GetPolicyStoreState().query(stackChain(state).chain, { policyStore: CPS }),
      {
        type: 'ConnectionPolicyStore',
        version: '2.1.0-dev',
        owner: OWNER,
        pendingOwner: OTHER,
        authorizedCallers: [PCM],
      },
    )
  })

  it('refuses a contract that is not a policy store', async () => {
    await assert.rejects(
      new GetPolicyStoreState().query(stackChain().chain, { policyStore: POOL }),
      CCTContractTypeInvalidError,
    )
  })

  it('rejects an invalid address before any RPC', async () => {
    const { chain, calls } = stackChain()
    await assert.rejects(
      new GetPolicyStoreState().query(chain, { policyStore: 'x' }),
      CCTParamsInvalidError,
    )
    assert.deepEqual(calls, [])
  })
})
