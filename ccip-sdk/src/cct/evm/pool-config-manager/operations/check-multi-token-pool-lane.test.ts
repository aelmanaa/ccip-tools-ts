/**
 * checkMultiTokenPoolLane: what it refuses before any RPC. The check itself runs live in
 * `lane-check.integration.test.ts`.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { getAddress } from 'ethers'

import { CCTParamsInvalidError } from '../../../errors.ts'
import { POOL, stackChain } from '../../multi-token-pool/stack.test.helpers.ts'
import { CheckMultiTokenPoolLane } from './check-multi-token-pool-lane.ts'

const lane = {
  poolAddress: POOL,
  tokenAddress: getAddress('0x' + 'a1'.repeat(20)),
  remoteChainSelector: 1n,
}

describe('CheckMultiTokenPoolLane (cct/evm pool-config-manager)', () => {
  it('refuses a malformed direction, threshold or key before any RPC', async () => {
    const { chain, calls } = stackChain()
    for (const [bad, param] of [
      [{ ...lane, expectOpen: ['sideways'] }, 'expectOpen[0]'],
      [{ ...lane, maxTransferFeeBps: -1 }, 'maxTransferFeeBps'],
      [{ ...lane, minDestGasOverhead: 1.5 }, 'minDestGasOverhead'],
      [{ tokenAddress: lane.tokenAddress, remoteChainSelector: 1n }, 'poolAddress'],
    ] as const)
      await assert.rejects(
        new CheckMultiTokenPoolLane().query(chain, bad as never),
        (e: unknown) => e instanceof CCTParamsInvalidError && e.context.param === param,
      )
    assert.deepEqual(calls, [])
  })
})
