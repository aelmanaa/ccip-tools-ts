import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { getAddress } from 'ethers'

import { canonicalHash } from '../../../canonical.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import {
  type MultiTokenPoolRateLimits,
  type MultiTokenPoolSnapshot,
  isLaneStopped,
} from '../../../multi-token-pool.ts'
import { POOL, stackChain } from '../../multi-token-pool/stack.test.helpers.ts'
import {
  LiftMultiTokenPoolLaneStops,
  StopMultiTokenPoolLanes,
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

/** A snapshot with its real hash, as an op builds it. */
const snapshot = (operation: string, expected: Record<string, unknown>): MultiTokenPoolSnapshot => {
  const fields = { observedAt: 1n, operation, expected, guardInputsHash: '0x', calldataHash: '0x' }
  return { ...fields, hash: canonicalHash(fields) }
}
/** The paths a stop seals for the lane: no prior inline record, and the buckets it copied. */
const covering = {
  [`inline.rateLimit.${T}:${FUJI}`]: null,
  [`lanes.rateLimit.${T}:${FUJI}`]: limits,
}

describe('lane stops (cct/evm pool-config-manager)', () => {
  it('stops both buckets of a direction and keeps the others', () => {
    const out = stoppedRateLimits(limits, 'outbound')
    assert.deepEqual(out.outbound, { enabled: true, capacity: 0n, rate: 0n })
    assert.deepEqual(out.fastFinalityOutbound, { enabled: true, capacity: 0n, rate: 0n })
    assert.deepEqual([out.inbound, out.fastFinalityInbound], [on, on])
    assert.equal(isLaneStopped(out, 'outbound'), true)
    assert.equal(isLaneStopped(out, 'inbound'), false)
    assert.equal(isLaneStopped(out, 'both'), false)
    assert.equal(isLaneStopped(stoppedRateLimits(limits, 'both'), 'inbound'), true)
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
      // not a snapshot at all, an edited one, another op's, one that does not cover the lane
      [new LiftMultiTokenPoolLaneStops(), { ...base, restore: { operation: 'x' } }, 'restore'],
      [
        new LiftMultiTokenPoolLaneStops(),
        { ...base, restore: { ...snapshot('stopMultiTokenPoolLanes', covering), hash: '0x00' } },
        'restore.hash',
      ],
      [
        new LiftMultiTokenPoolLaneStops(),
        { ...base, restore: snapshot('pauseMultiTokenPoolTokens', covering) },
        'restore',
      ],
      [
        new LiftMultiTokenPoolLaneStops(),
        { ...base, restore: snapshot('stopMultiTokenPoolLanes', {}) },
        'lanes[0]',
      ],
      // a prior record of the wrong shape is a CCT refusal, not a TypeError (R3 m1)
      [
        new LiftMultiTokenPoolLaneStops(),
        {
          ...base,
          restore: snapshot('stopMultiTokenPoolLanes', {
            ...covering,
            [`inline.rateLimit.${T}:${FUJI}`]: 42,
          }),
        },
        `restore.inline.rateLimit.${T}:${FUJI}`,
      ],
      // the buckets read back out of a snapshot are parsed
      [
        new LiftMultiTokenPoolLaneStops(),
        {
          ...base,
          restore: snapshot('stopMultiTokenPoolLanes', {
            ...covering,
            [`lanes.rateLimit.${T}:${FUJI}`]: { outbound: 'lots' },
          }),
        },
        `restore.lanes.rateLimit.${T}:${FUJI}.outbound`,
      ],
      [
        new LiftMultiTokenPoolLaneStops(),
        { ...base, restore: snapshot('stopMultiTokenPoolLanes', covering), rateLimits: limits },
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
