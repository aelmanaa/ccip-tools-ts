/**
 * checkMultiTokenPoolLane: what it refuses before any RPC. The check itself runs live in
 * `lane-check.integration.test.ts`.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { getAddress } from 'ethers'

import { CCTParamsInvalidError } from '../../../errors.ts'
import { POOL, stackChain } from '../../multi-token-pool/stack.test.helpers.ts'
import { CheckMultiTokenPoolLane, laneCheckRemote } from './check-multi-token-pool-lane.ts'

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

  it("reports a remote registry with no pool as 'missing', even when the waiver leaves ok true", () => {
    const known = {
      status: 'known',
      readsLongData: true,
      mapsBack: true,
      remoteTokenHasCode: true,
    } as const
    assert.equal(laneCheckRemote([], { ...known, registryPool: null }), 'missing')
    assert.equal(laneCheckRemote([], { ...known, registryPool: getAddress(POOL) }), 'known')
    assert.equal(laneCheckRemote([], undefined), 'unknown')
    // a remote failure wins over the read
    assert.equal(
      laneCheckRemote(
        [
          { scope: 'local', status: 'unknown' },
          { scope: 'remote', status: 'missing' },
        ],
        {
          ...known,
          registryPool: getAddress(POOL),
        },
      ),
      'missing',
    )
    assert.equal(laneCheckRemote([{ scope: 'local', status: 'unknown' }], undefined), 'unknown')
  })
})
