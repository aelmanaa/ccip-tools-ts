import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { getAddress } from 'ethers'

import { CCTParamsInvalidError } from '../../../errors.ts'
import {
  CPS,
  OTHER,
  OWNER,
  PCM,
  POOL,
  WRITE_IFACE,
  defaultStack,
  stackChain,
} from '../../multi-token-pool/stack.test.helpers.ts'
import { CheckMultiTokenPoolSnapshot } from '../../pool-config-manager/operations/check-multi-token-pool-snapshot.ts'
import { UpdatePolicyStoreAuthorizedCallers } from './update-policy-store-authorized-callers.ts'

const T = getAddress('0x' + '7a'.repeat(20))

/** The default stack, with token T routed by the registry to POOL, which calls PCM. */
function serving() {
  const state = defaultStack()
  state.pcm.tokens = [T]
  state.tarPools[T] = POOL
  return stackChain(state)
}

const refusedAt = (param: string, reason: RegExp) => (e: unknown) => {
  assert.ok(e instanceof CCTParamsInvalidError, String(e))
  assert.equal(e.context.param, param)
  assert.match(String(e.context.reason), reason)
  return true
}

describe('updatePolicyStoreAuthorizedCallers', () => {
  const op = new UpdatePolicyStoreAuthorizedCallers()

  it("refuses before any RPC as main's authorized-callers op: nothing, duplicates, zero", async () => {
    const { chain, calls } = stackChain()
    await assert.rejects(
      op.generate(chain, { policyStore: CPS }),
      refusedAt('addedCallers', /at least one/),
    )
    await assert.rejects(
      op.generate(chain, { policyStore: CPS, addedCallers: [PCM, PCM.toLowerCase()] }),
      refusedAt('addedCallers', /duplicate/),
    )
    assert.deepEqual(calls, [])
  })

  it('adds only a PoolConfigManager whose static config names this store (F5)', async () => {
    const { chain } = stackChain()
    await assert.rejects(
      op.generate(chain, { policyStore: CPS, addedCallers: [OTHER] }),
      refusedAt(
        'addedCallers[0]',
        /not a PoolConfigManager whose static config names this ConnectionPolicyStore/,
      ),
    )
    const tx = await op.generate(chain, { policyStore: CPS, addedCallers: [PCM], sender: OWNER })
    const decoded = WRITE_IFACE.parseTransaction({ data: String(tx.transactions[0]!.data) })!
    assert.equal(decoded.name, 'applyAuthorizedCallerUpdates')
    assert.deepEqual([...decoded.args[0].addedCallers], [PCM])
    assert.deepEqual(tx.snapshot.expected['store.authorizedCallers'], [PCM])
  })

  it('refuses removing a PCM a pool still names, unless confirmed; the check re-reads the pools', async () => {
    const { chain, state } = serving()
    await assert.rejects(
      op.generate(chain, { policyStore: CPS, removedCallers: [PCM] }),
      refusedAt('removedCallers[0]', new RegExp(`still named by the registry \\(${POOL}\\)`)),
    )
    const tx = await op.generate(chain, {
      policyStore: CPS,
      removedCallers: [PCM],
      confirmRemovingServingCallers: [PCM],
      sender: OWNER,
    })
    assert.deepEqual(tx.snapshot.expected[`removed.${PCM}.servingPools`], [POOL])
    assert.deepEqual(tx.snapshot.expected['confirm.removingServingCallers'], [PCM])
    const check = () =>
      new CheckMultiTokenPoolSnapshot().query(chain, {
        snapshot: tx.snapshot,
        transaction: tx,
        sender: OWNER,
      })
    assert.deepEqual(await check(), { ok: true, changed: [], findings: [] })
    // the token leaves the pool: the proposal was judged on pools that no longer serve
    delete state.tarPools[T]
    const moved = await check()
    assert.equal(moved.ok, false)
    assert.deepEqual(
      moved.changed.map((c) => c.path),
      [`removed.${PCM}.servingPools`],
    )
  })

  it('removes a caller no pool serves without a confirmation', async () => {
    const { chain } = stackChain()
    const tx = await op.generate(chain, { policyStore: CPS, removedCallers: [PCM] })
    assert.deepEqual(tx.snapshot.expected[`removed.${PCM}.servingPools`], [])
  })
})
