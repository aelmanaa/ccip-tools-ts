import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ZeroAddress, getAddress } from 'ethers'

import { CCTParamsInvalidError } from '../../../errors.ts'
import {
  OWNER,
  PCM,
  POOL,
  defaultStack,
  stackChain,
} from '../../multi-token-pool/stack.test.helpers.ts'
import { UpdateMultiTokenPoolHooksAuthorizedCallers } from './update-multi-token-pool-hooks-authorized-callers.ts'

const HOOKS = getAddress('0x' + 'cc'.repeat(20))
const T = getAddress('0x' + '7a'.repeat(20))

/** Hooks owned by OWNER, called by POOL; a PCM with no record (the removal finds no lane). */
function hooksStack() {
  const state = defaultStack()
  state.others[HOOKS] = 'MultiTokenPoolHooks 2.1.0-dev'
  state.auxOwners[HOOKS] = { owner: OWNER, pendingOwner: ZeroAddress }
  state.views.owner = () => [OWNER]
  state.views.getAllAuthorizedCallers = () => [[POOL]]
  state.views.getPolicyNames = () => [[], [], [], [], [], []]
  return stackChain(state)
}

describe('updateMultiTokenPoolHooksAuthorizedCallers', () => {
  const op = new UpdateMultiTokenPoolHooksAuthorizedCallers()

  it('refuses before any RPC: empty lists, a duplicate PCM, a bad confirmClosing lane', async () => {
    const { chain, calls } = hooksStack()
    const refused = (param: RegExp) => (e: unknown) =>
      e instanceof CCTParamsInvalidError && param.test(String(e.context.param))
    await assert.rejects(op.generate(chain, { hooks: HOOKS }), refused(/^addedCallers$/))
    await assert.rejects(
      op.generate(chain, { hooks: HOOKS, removedCallers: [POOL], poolConfigManagers: [PCM, PCM] }),
      refused(/^poolConfigManagers\[1\]$/),
    )
    await assert.rejects(
      op.generate(chain, {
        hooks: HOOKS,
        removedCallers: [POOL],
        confirmClosing: [{ tokenAddress: '0x12', remoteChainSelector: 1n }],
      }),
      refused(/^confirmClosing/),
    )
    assert.deepEqual(calls, [])
  })

  it("removes a pool that serves no lane on the hooks, sealing its PCM's lanes and the inputs", async () => {
    const { chain } = hooksStack()
    const tx = await op.generate(chain, {
      hooks: HOOKS,
      removedCallers: [POOL],
      poolConfigManagers: [PCM],
      confirmClosing: [{ tokenAddress: T, remoteChainSelector: 1n }],
      sender: OWNER,
    })
    assert.deepEqual(tx.snapshot.expected['hooks.authorizedCallers'], [POOL])
    assert.deepEqual(tx.snapshot.expected[`removed.${POOL}.lanes`], [])
    assert.deepEqual(tx.snapshot.expected['confirm.poolConfigManagers'], [PCM])
    assert.deepEqual(tx.snapshot.expected['confirm.closing'], [`${T}:1`])
  })
})
