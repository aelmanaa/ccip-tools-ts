import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { getAddress } from 'ethers'

import {
  MultiTokenPoolVersion,
  getMultiTokenPoolInterface,
} from '../../multi-token-pool/contracts.ts'
import { POOL } from '../../multi-token-pool/stack.test.helpers.ts'
import { feeTokensWithdrawn } from './withdraw-multi-token-pool-fee-tokens.ts'

const iface = getMultiTokenPoolInterface('BurnMintMultiTokenPool', MultiTokenPoolVersion.V2_1_0_DEV)
const TOKEN = getAddress('0x' + 'fe'.repeat(20))
const RECIPIENT = getAddress('0x' + 'ec'.repeat(20))
const OTHER_POOL = getAddress('0x' + '12'.repeat(20))

/** A `FeeTokenWithdrawn` log emitted by `address`. */
function withdrawnLog(address: string, amount: bigint) {
  const event = iface.getEvent('FeeTokenWithdrawn')!
  const { data, topics } = iface.encodeEventLog(
    event,
    event.inputs.map((i) =>
      i.name === 'feeToken' ? TOKEN : i.name === 'amount' ? amount : RECIPIENT,
    ),
  )
  return { address, data, topics }
}

describe('feeTokensWithdrawn', () => {
  it("reads the pool's own logs only: another contract's log with the same topic is not counted", () => {
    const logs = [withdrawnLog(OTHER_POOL, 99n), withdrawnLog(POOL, 7n)]
    assert.deepEqual(feeTokensWithdrawn(logs, POOL.toLowerCase(), iface), [
      { token: TOKEN, amount: 7n },
    ])
  })

  it('reports nothing for a token with no balance (the pool emits no log for it)', () => {
    assert.deepEqual(feeTokensWithdrawn([], POOL, iface), [])
  })
})
