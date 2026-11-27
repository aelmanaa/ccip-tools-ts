import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ZeroAddress } from 'ethers'

import { CCTParamsInvalidError } from '../../../errors.ts'
import { OWNER, PCM, defaultStack, stackChain } from '../../multi-token-pool/stack.test.helpers.ts'
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

  it('builds one second after the schedule', async () => {
    const tx = await renounce(scheduled(Number(SCHEDULE) + 1).chain)
    assert.equal(tx.transactions[0]!.to, PCM)
    assert.equal(tx.simulatedFrom, 'sender')
  })
})
