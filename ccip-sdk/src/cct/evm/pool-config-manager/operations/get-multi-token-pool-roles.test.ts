import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CCTParamsInvalidError } from '../../../errors.ts'
import { OTHER, OWNER, POOL, stackChain } from '../../multi-token-pool/stack.test.helpers.ts'
import { GetMultiTokenPoolRoles } from './get-multi-token-pool-roles.ts'

describe('GetMultiTokenPoolRoles (cct/evm pool-config-manager)', () => {
  it('lists each account’s roles in enum order, in input order', async () => {
    assert.deepEqual(
      await new GetMultiTokenPoolRoles().query(stackChain().chain, {
        poolAddress: POOL,
        accounts: [OTHER.toLowerCase(), OWNER],
      }),
      [
        { account: OTHER, roles: [] },
        { account: OWNER, roles: ['DEFAULT_ADMIN_ROLE', 'CONFIG_ROLE'] },
      ],
    )
  })

  it('rejects empty or invalid accounts before any RPC', async () => {
    const { chain, calls } = stackChain()
    for (const accounts of [[], ['0x12'], new Array(2)])
      await assert.rejects(
        new GetMultiTokenPoolRoles().query(chain, { poolAddress: POOL, accounts }),
        CCTParamsInvalidError,
      )
    assert.deepEqual(calls, [])
  })
})
