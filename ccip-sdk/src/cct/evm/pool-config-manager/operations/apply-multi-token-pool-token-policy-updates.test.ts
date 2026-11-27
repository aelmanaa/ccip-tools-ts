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
        'assignments[1]',
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

  it('refuses bad guard options and a bad sender before any RPC, with the shared validators', async () => {
    const { chain, calls } = stackChain()
    const lane = { tokenAddress: T, remoteChainSelector: 1n }
    for (const [bad, param] of [
      [{ ...base, maxTransferFeeBps: -1 }, 'maxTransferFeeBps'],
      [{ ...base, minDestGasOverhead: 1.5 }, 'minDestGasOverhead'],
      [{ ...base, allowDroppingDefaultCCVs: 'yes' }, 'allowDroppingDefaultCCVs'],
      [
        { ...base, confirmClosing: [{ ...lane, tokenAddress: '0x12' }] },
        'confirmClosing[0].tokenAddress',
      ],
      [
        { ...base, confirmOpening: [{ ...lane, directions: ['sideways'] }] },
        'confirmOpening[0].directions[0]',
      ],
      [{ ...base, migrationWindowChains: [-1n] }, 'migrationWindowChains[0]'],
      [{ ...base, sender: '0xnope' }, 'sender'],
    ] as const)
      await assert.rejects(
        new ApplyMultiTokenPoolTokenPolicyUpdates().generate(chain, bad as never),
        (e: unknown) => e instanceof CCTParamsInvalidError && e.context.param === param,
        param,
      )
    assert.deepEqual(calls, [])
  })
})
