import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { getAddress } from 'ethers'

import { CCTParamsInvalidError } from '../../../errors.ts'
import type { MultiTokenPoolRateLimits } from '../../../multi-token-pool.ts'
import { POOL, stackChain } from '../../multi-token-pool/stack.test.helpers.ts'
import {
  LiftMultiTokenPoolLaneStops,
  StopMultiTokenPoolLanes,
  isStoppedIn,
  stoppedRateLimits,
} from './stop-multi-token-pool-lanes.ts'

const T = getAddress('0x' + 'a1'.repeat(20))
const FUJI = 14767482510784806043n
const lane = { tokenAddress: T, remoteChainSelector: FUJI }
const on = { enabled: true, capacity: 100n, rate: 1n } as const
const off = { enabled: false } as const
const limits: MultiTokenPoolRateLimits = {
  outbound: on,
  inbound: on,
  fastFinalityOutbound: off,
  fastFinalityInbound: on,
}

describe('lane stops (cct/evm pool-config-manager)', () => {
  it('stops both buckets of a direction and keeps the others', () => {
    const out = stoppedRateLimits(limits, 'outbound')
    assert.deepEqual(out.outbound, { enabled: true, capacity: 0n, rate: 0n })
    assert.deepEqual(out.fastFinalityOutbound, { enabled: true, capacity: 0n, rate: 0n })
    assert.deepEqual([out.inbound, out.fastFinalityInbound], [on, on])
    assert.equal(isStoppedIn(out, 'outbound'), true)
    assert.equal(isStoppedIn(out, 'inbound'), false)
    assert.equal(isStoppedIn(out, 'both'), false)
    assert.equal(isStoppedIn(stoppedRateLimits(limits, 'both'), 'inbound'), true)
    // the input is not mutated
    assert.deepEqual(limits.outbound, on)
  })

  it('refuses bad params before any RPC', async () => {
    const { chain, calls } = stackChain()
    const base = { poolAddress: POOL, lanes: [lane], direction: 'outbound' as const }
    const refused = (param: string) => (e: unknown) =>
      e instanceof CCTParamsInvalidError && e.context.param === param
    for (const [op, params, param] of [
      [new StopMultiTokenPoolLanes(), { ...base, direction: 'sideways' }, 'direction'],
      [new StopMultiTokenPoolLanes(), { ...base, lanes: [] }, 'lanes'],
      [
        new StopMultiTokenPoolLanes(),
        { ...base, lanes: [lane, { ...lane, tokenAddress: T.toLowerCase() }] },
        'lanes[1]',
      ],
      [
        new LiftMultiTokenPoolLaneStops(),
        { ...base, restore: { operation: 'pauseMultiTokenPoolTokens', expected: {} } },
        'restore',
      ],
      [
        new LiftMultiTokenPoolLaneStops(),
        { ...base, restore: { operation: 'stopMultiTokenPoolLanes', expected: {} } },
        'lanes[0]',
      ],
      [
        new LiftMultiTokenPoolLaneStops(),
        {
          ...base,
          restore: { operation: 'stopMultiTokenPoolLanes', expected: {} },
          rateLimits: limits,
        },
        'rateLimits',
      ],
    ] as const)
      await assert.rejects(
        (op as StopMultiTokenPoolLanes).generate(chain, params as never),
        refused(param),
      )
    assert.deepEqual(calls, [])
  })
})
