/**
 * checkMultiTokenPoolSnapshot: everything it refuses before any RPC. The re-check itself runs live
 * in `guard-run.integration.test.ts`.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { keccak256 } from 'ethers'

import { sealMultiTokenPoolSnapshot } from '../../../canonical.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { PCM, stackChain } from '../../multi-token-pool/stack.test.helpers.ts'
import { CheckMultiTokenPoolSnapshot } from './check-multi-token-pool-snapshot.ts'

const DATA = '0x1234abcd'
const SENDER = '0x' + 'aa'.repeat(20)
const snapshot = sealMultiTokenPoolSnapshot({
  observedAt: 1n,
  operation: 'pauseMultiTokenPoolTokens',
  expected: {},
  guardInputsHash: '0x' + '11'.repeat(32),
  calldataHash: keccak256(DATA),
})
const transaction = { family: 'EVM' as const, transactions: [{ to: PCM, data: DATA }] }

describe('CheckMultiTokenPoolSnapshot (cct/evm pool-config-manager)', () => {
  const refuses = async (params: unknown, param: string) => {
    const { chain, calls } = stackChain()
    await assert.rejects(
      new CheckMultiTokenPoolSnapshot().query(chain, params as never),
      (e: unknown) => e instanceof CCTParamsInvalidError && e.context.param === param,
    )
    assert.deepEqual(calls, [], 'no RPC before validation')
  }

  it('refuses an edited or malformed snapshot', async () => {
    await refuses(
      { snapshot: { ...snapshot, operation: 'other' }, transaction, sender: SENDER },
      'snapshot',
    )
    await refuses({ snapshot: { foo: 1 }, transaction, sender: SENDER }, 'snapshot')
  })

  it('refuses a transaction that is not one PCM call, or other calldata than the snapshot covers', async () => {
    await refuses(
      { snapshot, transaction: { family: 'EVM', transactions: [] }, sender: SENDER },
      'transaction',
    )
    await refuses(
      {
        snapshot,
        transaction: {
          family: 'EVM',
          transactions: [transaction.transactions[0], transaction.transactions[0]],
        },
        sender: SENDER,
      },
      'transaction',
    )
    await refuses(
      {
        snapshot,
        transaction: { family: 'EVM', transactions: [{ to: PCM, data: '0xdeadbeef' }] },
        sender: SENDER,
      },
      'snapshot',
    )
  })

  it('refuses a malformed sender', async () => {
    await refuses({ snapshot, transaction, sender: '0x1234' }, 'sender')
  })
})
