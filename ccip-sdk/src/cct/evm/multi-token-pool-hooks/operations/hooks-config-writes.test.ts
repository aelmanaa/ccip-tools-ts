import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ZeroAddress, getAddress } from 'ethers'

import { CCTContractTypeInvalidError, CCTParamsInvalidError } from '../../../errors.ts'
import {
  OTHER,
  OWNER,
  WRITE_IFACE,
  defaultStack,
  stackChain,
} from '../../multi-token-pool/stack.test.helpers.ts'
import {
  ApplyMultiTokenPoolHooksAllowlistUpdates,
  SetMultiTokenPoolHooksBlocklist,
  SetMultiTokenPoolHooksPolicyEngine,
} from './hooks-config-writes.ts'

const HOOKS = getAddress('0x' + 'cc'.repeat(20))
const BLOCKLIST_HOOKS = getAddress('0x' + 'ce'.repeat(20))
const ENGINE = getAddress('0x' + 'e1'.repeat(20))
const EOA = getAddress('0x' + 'e0'.repeat(20))
const A = getAddress('0x' + 'a1'.repeat(20))
const B = getAddress('0x' + 'b1'.repeat(20))

/** Both hook contracts, owned by OWNER; `allowlist` is what both answer. */
function hooksStack(allowlist: string[] = [A], enabled = true) {
  const state = defaultStack()
  state.others[HOOKS] = 'MultiTokenPoolHooks 2.1.0-dev'
  state.others[BLOCKLIST_HOOKS] = 'MultiTokenPoolHooksExternalBlocklist 2.1.0-dev'
  for (const h of [HOOKS, BLOCKLIST_HOOKS])
    state.auxOwners[h] = { owner: OWNER, pendingOwner: ZeroAddress }
  state.views.owner = () => [OWNER]
  state.views.getAllowListEnabled = () => [enabled]
  state.views.getAllowList = () => [allowlist]
  state.eoas = [EOA]
  return stackChain(state)
}

const decode = (tx: { transactions: { data?: string | null }[] }) =>
  WRITE_IFACE.parseTransaction({ data: String(tx.transactions[0]!.data) })!

const refusedAt = (param: string, reason?: RegExp) => (e: unknown) => {
  assert.ok(e instanceof CCTParamsInvalidError, String(e))
  assert.equal(e.context.param, param)
  if (reason) assert.match(String(e.context.reason), reason)
  return true
}

describe('MTTP hook settings', () => {
  describe('applyMultiTokenPoolHooksAllowlistUpdates', () => {
    const op = new ApplyMultiTokenPoolHooksAllowlistUpdates()

    it('encodes applyAllowListUpdates(removes, adds), removes first, checksummed', async () => {
      const { chain } = hooksStack()
      const tx = await op.generate(chain, {
        hooks: HOOKS,
        removes: [A.toLowerCase()],
        adds: [B],
        sender: OWNER,
      })
      const { name, args } = decode(tx)
      assert.equal(name, 'applyAllowListUpdates')
      assert.deepEqual([...args[0]], [A])
      assert.deepEqual([...args[1]], [B])
      assert.equal(tx.transactions[0]!.to, HOOKS)
    })

    it("refuses before any RPC as main's applyAllowlistUpdates: empty, duplicate, overlap, zero", async () => {
      const { chain, calls } = hooksStack()
      await assert.rejects(op.generate(chain, { hooks: HOOKS }), refusedAt('adds', /at least one/))
      await assert.rejects(
        op.generate(chain, { hooks: HOOKS, adds: [B, B.toLowerCase()] }),
        refusedAt('adds', /duplicate/),
      )
      await assert.rejects(
        op.generate(chain, { hooks: HOOKS, removes: [B], adds: [B] }),
        refusedAt('adds', /also in removes/),
      )
      await assert.rejects(
        op.generate(chain, { hooks: HOOKS, adds: [ZeroAddress] }),
        refusedAt('adds[0]'),
      )
      assert.deepEqual(calls, [])
    })

    it('refuses a no-op against the current allowlist, and hooks with no allowlist', async () => {
      const { chain } = hooksStack()
      await assert.rejects(
        op.generate(chain, { hooks: HOOKS, removes: [B] }),
        refusedAt('removes', /is not allowlisted/),
      )
      await assert.rejects(
        op.generate(chain, { hooks: HOOKS, adds: [A] }),
        refusedAt('adds', /already allowlisted/),
      )
      const off = hooksStack([], false)
      await assert.rejects(
        op.generate(off.chain, { hooks: HOOKS, adds: [B] }),
        refusedAt('hooks', /AllowListNotEnabled/),
      )
    })

    it('refuses a sender that is not the hooks owner', async () => {
      const { chain } = hooksStack()
      await assert.rejects(
        op.generate(chain, { hooks: HOOKS, adds: [B], sender: OTHER }),
        refusedAt('sender', /hook contract owner/),
      )
    })
  })

  describe('setMultiTokenPoolHooksPolicyEngine', () => {
    const op = new SetMultiTokenPoolHooksPolicyEngine()

    it('encodes setPolicyEngine, or setPolicyEngineAllowFailedDetach on request', async () => {
      const { chain } = hooksStack()
      assert.equal(
        decode(await op.generate(chain, { hooks: HOOKS, policyEngine: ENGINE })).name,
        'setPolicyEngine',
      )
      const detach = decode(
        await op.generate(chain, { hooks: HOOKS, policyEngine: ENGINE, allowFailedDetach: true }),
      )
      assert.equal(detach.name, 'setPolicyEngineAllowFailedDetach')
      assert.equal(detach.args[0], ENGINE)
    })

    it("detaches with ZeroAddress; refuses an EOA engine with main's message", async () => {
      const { chain } = hooksStack()
      assert.equal(
        decode(await op.generate(chain, { hooks: HOOKS, policyEngine: ZeroAddress })).args[0],
        ZeroAddress,
      )
      await assert.rejects(
        op.generate(chain, { hooks: HOOKS, policyEngine: EOA }),
        refusedAt('policyEngine', /^must be a deployed policy engine contract, not an EOA$/),
      )
      await assert.rejects(
        op.generate(chain, { hooks: HOOKS, policyEngine: '0x12' }),
        refusedAt('policyEngine'),
      )
    })
  })

  describe('setMultiTokenPoolHooksBlocklist', () => {
    const op = new SetMultiTokenPoolHooksBlocklist()

    it('encodes setBlocklist on the external-blocklist hooks; ZeroAddress turns it off', async () => {
      const { chain } = hooksStack()
      assert.equal(
        decode(await op.generate(chain, { hooks: BLOCKLIST_HOOKS, blocklist: ENGINE })).name,
        'setBlocklist',
      )
      assert.equal(
        decode(await op.generate(chain, { hooks: BLOCKLIST_HOOKS, blocklist: ZeroAddress }))
          .args[0],
        ZeroAddress,
      )
    })

    it('refuses the base hooks (no blocklist), and an EOA blocklist', async () => {
      const { chain } = hooksStack()
      await assert.rejects(
        op.generate(chain, { hooks: HOOKS, blocklist: ENGINE }),
        CCTContractTypeInvalidError,
      )
      await assert.rejects(
        op.generate(chain, { hooks: BLOCKLIST_HOOKS, blocklist: EOA }),
        refusedAt('blocklist', /deployed blocklist contract, not an EOA/),
      )
    })
  })
})
