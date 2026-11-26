/**
 * applyMultiTokenPoolTokenPolicyUpdates: what it refuses before any RPC. The write itself is built
 * live in `write-ops.integration.test.ts`.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { getAddress } from 'ethers'

import { CCTParamsInvalidError } from '../../../errors.ts'
import { POOL, stackChain } from '../../multi-token-pool/stack.test.helpers.ts'
import { ApplyMultiTokenPoolTokenPolicyUpdates } from './apply-multi-token-pool-token-policy-updates.ts'

const T = getAddress('0x' + 'a1'.repeat(20))
const base = {
  poolAddress: POOL,
  recordType: 'fee',
  assignments: [{ tokenAddress: T, policyName: 'p' }],
} as const

describe('ApplyMultiTokenPoolTokenPolicyUpdates (cct/evm pool-config-manager)', () => {
  it('refuses an unknown record type, an empty or repeated assignment, or a bad name before any RPC', async () => {
    const { chain, calls } = stackChain()
    for (const [bad, param] of [
      [{ ...base, recordType: 'fees' }, 'recordType'],
      [{ ...base, assignments: [] }, 'assignments'],
      [
        {
          ...base,
          assignments: [base.assignments[0], { tokenAddress: T.toLowerCase(), policyName: null }],
        },
        'assignments[1].tokenAddress',
      ],
      [
        { ...base, assignments: [{ tokenAddress: T, policyName: 'x'.repeat(32) }] },
        'assignments[0].policyName',
      ],
      [
        { ...base, assignments: [{ tokenAddress: '0x12', policyName: 'p' }] },
        'assignments[0].tokenAddress',
      ],
    ] as const)
      await assert.rejects(
        new ApplyMultiTokenPoolTokenPolicyUpdates().generate(chain, bad as never),
        (e: unknown) => e instanceof CCTParamsInvalidError && e.context.param === param,
      )
    assert.deepEqual(calls, [])
  })
})
