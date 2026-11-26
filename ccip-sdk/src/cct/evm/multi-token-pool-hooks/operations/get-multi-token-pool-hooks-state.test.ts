import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ZeroAddress, getAddress } from 'ethers'

import { CCTContractTypeInvalidError } from '../../../errors.ts'
import {
  OTHER,
  OWNER,
  POOL,
  defaultStack,
  stackChain,
} from '../../multi-token-pool/stack.test.helpers.ts'
import { GetMultiTokenPoolHooksState } from './get-multi-token-pool-hooks-state.ts'

const HOOKS = getAddress('0x' + 'd0'.repeat(20))

function hooksStack(type: string) {
  const state = defaultStack()
  state.others[HOOKS] = `${type} 2.1.0-dev`
  state.auxOwners[HOOKS] = { owner: OWNER, pendingOwner: OTHER }
  Object.assign(state.views, {
    owner: () => [OWNER],
    getAllowListEnabled: () => [true],
    getAllowList: () => [[OTHER]],
    getPolicyEngine: () => [ZeroAddress],
    getAllAuthorizedCallers: () => [[POOL]],
    getBlocklist: () => [OTHER],
  })
  return state
}

describe('GetMultiTokenPoolHooksState (cct/evm multi-token-pool-hooks)', () => {
  it('reads the base hooks, without a blocklist field', async () => {
    const r = await new GetMultiTokenPoolHooksState().query(
      stackChain(hooksStack('MultiTokenPoolHooks')).chain,
      { hooks: HOOKS },
    )
    assert.deepEqual(r, {
      type: 'MultiTokenPoolHooks',
      owner: OWNER,
      pendingOwner: OTHER,
      allowlistEnabled: true,
      allowlist: [OTHER],
      policyEngine: null,
      authorizedCallers: [POOL],
    })
  })

  it('reads the blocklist of the external-blocklist variant', async () => {
    const r = await new GetMultiTokenPoolHooksState().query(
      stackChain(hooksStack('MultiTokenPoolHooksExternalBlocklist')).chain,
      { hooks: HOOKS },
    )
    assert.equal(r.blocklist, OTHER)
  })

  it('refuses another contract type', async () => {
    await assert.rejects(
      new GetMultiTokenPoolHooksState().query(stackChain(hooksStack('AdvancedPoolHooks')).chain, {
        hooks: HOOKS,
      }),
      CCTContractTypeInvalidError,
    )
  })
})
