import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ZeroAddress, getAddress } from 'ethers'

import { CCTParamsInvalidError } from '../../../errors.ts'
import { OWNER, PCM, defaultStack, stackChain } from '../../multi-token-pool/stack.test.helpers.ts'
import { CheckMultiTokenPoolSnapshot } from './check-multi-token-pool-snapshot.ts'
import { RenounceMultiTokenPoolDefaultAdmin } from './role-writes.ts'

const SCHEDULE = 1_700_000_000n

/** A PCM whose default admin OWNER scheduled a transfer to `newAdmin`, read at `timestamp`. */
function scheduled(timestamp: number, newAdmin = ZeroAddress, schedule = SCHEDULE) {
  const state = defaultStack()
  state.pcm.pendingDefaultAdmin = [newAdmin, schedule]
  state.timestamp = timestamp
  return stackChain(state)
}

const renounce = (chain: ReturnType<typeof stackChain>['chain']) =>
  new RenounceMultiTokenPoolDefaultAdmin().generate(chain, {
    poolConfigManager: PCM,
    sender: OWNER,
    confirmPermanentFreeze: true,
  })

const refusedWith = (reason: RegExp) => (e: unknown) => {
  assert.ok(e instanceof CCTParamsInvalidError, String(e))
  assert.equal(e.context.param, 'poolConfigManager')
  assert.match(String(e.context.reason), reason)
  return true
}

describe('renounceMultiTokenPoolDefaultAdmin', () => {
  it('refuses at the schedule second itself (OZ needs schedule < block.timestamp)', async () => {
    await assert.rejects(renounce(scheduled(Number(SCHEDULE)).chain), refusedWith(/matures at/))
    await assert.rejects(renounce(scheduled(Number(SCHEDULE) - 1).chain), refusedWith(/matures at/))
  })

  it('refuses with no renounce scheduled', async () => {
    await assert.rejects(
      renounce(scheduled(Number(SCHEDULE) + 1, ZeroAddress, 0n).chain),
      refusedWith(/has no scheduled renounce: schedule one/),
    )
  })

  it('refuses while a transfer to a non-zero admin is pending, naming it', async () => {
    const BOB = getAddress('0x' + 'b0'.repeat(20))
    await assert.rejects(
      renounce(scheduled(Number(SCHEDULE) + 1, BOB).chain),
      refusedWith(new RegExp(`a transfer to ${BOB} is pending`)),
    )
  })

  it('refuses a missing or non-literal confirmPermanentFreeze before any RPC', async () => {
    for (const confirm of [undefined, 'true', 1, false]) {
      const { chain, calls } = scheduled(Number(SCHEDULE) + 1)
      await assert.rejects(
        new RenounceMultiTokenPoolDefaultAdmin().generate(chain, {
          poolConfigManager: PCM,
          sender: OWNER,
          confirmPermanentFreeze: confirm as unknown as true,
        }),
        (e: unknown) =>
          e instanceof CCTParamsInvalidError && e.context.param === 'confirmPermanentFreeze',
      )
      assert.deepEqual(calls, [], String(confirm))
    }
  })

  it('builds one second after the schedule', async () => {
    const tx = await renounce(scheduled(Number(SCHEDULE) + 1).chain)
    assert.equal(tx.transactions[0]!.to, PCM)
    assert.equal(tx.simulatedFrom, 'sender')
  })

  describe('a pauser with no unpauser (the next pause would be permanent)', () => {
    const ALICE = getAddress('0x' + 'a1'.repeat(20))
    const BOB = getAddress('0x' + 'b0'.repeat(20))
    /** A matured renounce, with ALICE holding PAUSER_ROLE, and BOB UNPAUSER_ROLE when asked. */
    function withPauser(unpauser: boolean) {
      const { state } = scheduled(Number(SCHEDULE) + 1)
      state.pcm.roles.PAUSER_ROLE = [ALICE]
      state.roleLogs.push({
        event: 'RoleGranted',
        role: 'PAUSER_ROLE',
        account: ALICE,
        blockNumber: 200,
      })
      if (unpauser) {
        state.pcm.roles.UNPAUSER_ROLE = [BOB]
        state.roleLogs.push({
          event: 'RoleGranted',
          role: 'UNPAUSER_ROLE',
          account: BOB,
          blockNumber: 201,
        })
      }
      return stackChain(state)
    }

    it('refuses without confirmPermanentPauses, naming the pausers', async () => {
      await assert.rejects(renounce(withPauser(false).chain), (e: unknown) => {
        assert.ok(e instanceof CCTParamsInvalidError)
        assert.equal(e.context.param, 'confirmPermanentPauses')
        assert.match(String(e.context.reason), new RegExp(`PAUSER_ROLE has holders \\(${ALICE}\\)`))
        return true
      })
    })

    it('builds with it, sealing the holders and the confirmation; the re-check keeps it', async () => {
      const { chain } = withPauser(false)
      const tx = await new RenounceMultiTokenPoolDefaultAdmin().generate(chain, {
        poolConfigManager: PCM,
        sender: OWNER,
        confirmPermanentFreeze: true,
        confirmPermanentPauses: true,
      })
      assert.deepEqual(tx.snapshot.expected['roles.holders.PAUSER_ROLE'], [ALICE])
      assert.deepEqual(tx.snapshot.expected['roles.holders.UNPAUSER_ROLE'], [])
      assert.equal(tx.snapshot.expected['confirm.permanentPauses'], true)
      const check = await new CheckMultiTokenPoolSnapshot().query(chain, {
        snapshot: tx.snapshot,
        transaction: tx,
        sender: OWNER,
      })
      assert.deepEqual([check.ok, check.changed], [true, []])
    })

    it('builds when an unpauser holds the role', async () => {
      const tx = await renounce(withPauser(true).chain)
      assert.deepEqual(tx.snapshot.expected['roles.holders.UNPAUSER_ROLE'], [BOB])
    })

    it('fails closed when the holders cannot be read in full (no archive RPC)', async () => {
      const { state } = scheduled(Number(SCHEDULE) + 1)
      state.pruned = true
      await assert.rejects(renounce(stackChain(state).chain), (e: unknown) => {
        assert.ok(e instanceof CCTParamsInvalidError)
        assert.equal(e.context.param, 'confirmPermanentPauses')
        assert.match(String(e.context.reason), /cannot be read in full/)
        return true
      })
    })

    it('refuses a confirmation that is not the literal true, before any RPC', async () => {
      const { chain, calls } = withPauser(false)
      await assert.rejects(
        new RenounceMultiTokenPoolDefaultAdmin().generate(chain, {
          poolConfigManager: PCM,
          sender: OWNER,
          confirmPermanentFreeze: true,
          confirmPermanentPauses: 'true' as unknown as true,
        }),
        (e: unknown) =>
          e instanceof CCTParamsInvalidError && e.context.param === 'confirmPermanentPauses',
      )
      assert.deepEqual(calls, [])
    })
  })

  describe('a pause set now with no unpauser (it would stay forever, E7 N1)', () => {
    const BOB = getAddress('0x' + 'b0'.repeat(20))
    const paused = (unpauser: boolean) => {
      const { state } = scheduled(Number(SCHEDULE) + 1)
      state.globallyPaused = true
      if (unpauser) {
        state.pcm.roles.UNPAUSER_ROLE = [BOB]
        state.roleLogs.push({
          event: 'RoleGranted',
          role: 'UNPAUSER_ROLE',
          account: BOB,
          blockNumber: 201,
        })
      }
      return stackChain(state)
    }

    it('refuses without confirmPermanentPauses, naming the pause', async () => {
      await assert.rejects(renounce(paused(false).chain), (e: unknown) => {
        assert.ok(e instanceof CCTParamsInvalidError)
        assert.equal(e.context.param, 'confirmPermanentPauses')
        assert.match(String(e.context.reason), /pauses are set now \(global\)/)
        return true
      })
    })

    it('builds when an unpauser remains, or with the confirmation; seals the pauses', async () => {
      const tx = await renounce(paused(true).chain)
      assert.deepEqual(tx.snapshot.expected['pauses.active'], ['global'])
      const confirmed = await new RenounceMultiTokenPoolDefaultAdmin().generate(
        paused(false).chain,
        {
          poolConfigManager: PCM,
          sender: OWNER,
          confirmPermanentFreeze: true,
          confirmPermanentPauses: true,
        },
      )
      assert.deepEqual(confirmed.snapshot.expected['pauses.active'], ['global'])
    })

    it('a pause set after the build makes the proposal stale', async () => {
      const { state } = scheduled(Number(SCHEDULE) + 1)
      const { chain } = stackChain(state)
      const tx = await renounce(chain)
      assert.deepEqual(tx.snapshot.expected['pauses.active'], [])
      state.globallyPaused = true
      const check = await new CheckMultiTokenPoolSnapshot().query(chain, {
        snapshot: tx.snapshot,
        transaction: tx,
        sender: OWNER,
      })
      assert.equal(check.ok, false)
      assert.deepEqual(
        check.changed.map((c) => c.path),
        ['pauses.active'],
      )
    })
  })
})
