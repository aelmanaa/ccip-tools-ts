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
import {
  MultiTokenPoolVersion,
  POOL_CONFIG_MANAGER_TYPE,
  getMultiTokenPoolInterface,
} from '../../multi-token-pool/contracts.ts'
import { POOL, stackChain } from '../../multi-token-pool/stack.test.helpers.ts'
import { decodeMultiTokenPoolWrite } from '../calldata.ts'
import { C1, empty, inlineLane } from '../projection.test.helpers.ts'
import {
  type MultiTokenPoolRecordChange,
  type MultiTokenPoolRecordState,
  applyMultiTokenPoolRecordChanges,
} from '../projection.ts'
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

  describe('encode, on a projected state (R3 M4: M23-M30, M35)', () => {
    const PCM_ADDRESS = getAddress('0x' + '22'.repeat(20))
    const iface = getMultiTokenPoolInterface(
      POOL_CONFIG_MANAGER_TYPE,
      MultiTokenPoolVersion.V2_1_0_DEV,
    )
    const stopRL = { enabled: true, capacity: 0n, rate: 0n } as const
    const key = { tokenAddress: T, remoteChainSelector: C1 }
    /** A registered token with a healthy inline lane toward C1 (optionally on a rate limit policy). */
    const stateWith = (changes: MultiTokenPoolRecordChange[] = [], policy?: string) => {
      const s = applyMultiTokenPoolRecordChanges(empty(), [...inlineLane(T), ...changes])
      s.tokens[0]!.profile = { isRegistered: true } as never
      if (policy) s.tokens[0]!.policies.rateLimit = policy
      return s
    }
    const ctx = (state: MultiTokenPoolRecordState) =>
      ({
        address: PCM_ADDRESS,
        version: MultiTokenPoolVersion.V2_1_0_DEV,
        blockTag: 1,
        state,
        staticConfig: {},
        policyNames: {},
      }) as never
    const rl = (rateLimits: MultiTokenPoolRateLimits): MultiTokenPoolRecordChange => ({
      kind: 'setInline',
      type: 'rateLimit',
      record: { ...key, rateLimits },
    })
    const decoded = (data: string) => {
      const [removes, sets] = iface.decodeFunctionData('applyInlineRateLimitConfigUpdates', data)
      return {
        removes: (removes as { localToken: string }[]).map((r) => getAddress(r.localToken)),
        sets: (
          sets as { rateLimitConfig: Record<string, { isEnabled: boolean; capacity: bigint }> }[]
        ).map((r) => r.rateLimitConfig),
      }
    }
    class Stop extends StopMultiTokenPoolLanes {
      /** The encoded write, with what the build seals from its calldata. */
      async run(
        state: MultiTokenPoolRecordState,
        direction: 'outbound' | 'inbound' | 'both' = 'outbound',
      ) {
        const { data } = await this.encode(
          {} as never,
          { poolAddress: POOL, lanes: [key], direction },
          ctx(state),
        )
        const decodedWrite = decodeMultiTokenPoolWrite(data, MultiTokenPoolVersion.V2_1_0_DEV)
        return { data, expected: this.sealedFrom({} as never, decodedWrite, ctx(state)) }
      }
      runLane(state: MultiTokenPoolRecordState, lane: typeof key) {
        return this.encode(
          {} as never,
          { poolAddress: POOL, lanes: [lane], direction: 'outbound' },
          ctx(state),
        )
      }
    }
    class Lift extends LiftMultiTokenPoolLaneStops {
      run(state: MultiTokenPoolRecordState, extra: Record<string, unknown> = {}) {
        return this.encode(
          {} as never,
          { poolAddress: POOL, lanes: [key], direction: 'outbound', ...extra } as never,
          ctx(state),
        )
      }
    }
    const refusedAt = (param: string, pattern: RegExp) => (e: unknown) =>
      e instanceof CCTParamsInvalidError && e.context.param === param && pattern.test(e.message)

    it('stops: refuses an unregistered token, a lane with no rate limit, a lane already stopped', async () => {
      const unregistered = stateWith()
      unregistered.tokens[0]!.profile = { isRegistered: false } as never
      await assert.rejects(
        new Stop().run(unregistered),
        refusedAt('lanes[0].tokenAddress', /not registered/),
      )
      // a chain the token has no lane to
      await assert.rejects(
        new Stop().runLane(stateWith(), { tokenAddress: T, remoteChainSelector: 1n }),
        refusedAt('lanes[0]', /no rate limit resolves/),
      )
      const stopped = stateWith([rl({ ...limits, outbound: stopRL, fastFinalityOutbound: stopRL })])
      await assert.rejects(
        new Stop().run(stopped),
        refusedAt('lanes[0]', /already stopped outbound/),
      )
    })

    it('stops one direction, and seals the PCM, the record it replaced and the buckets it copied', async () => {
      const state = stateWith([rl(limits)])
      const { data, expected } = await new Stop().run(state)
      const { removes, sets } = decoded(data)
      assert.deepEqual(removes, [])
      assert.equal(sets[0]!.outbound!.capacity, 0n)
      assert.equal(sets[0]!.fastFinalityOutbound!.isEnabled, true)
      assert.equal(sets[0]!.inbound!.capacity, 100n)
      assert.equal(expected!['stop.poolConfigManager'], PCM_ADDRESS)
      assert.deepEqual(expected![`inline.rateLimit.${T}:${C1}`], {
        ...key,
        rateLimits: limits,
      })
      assert.deepEqual(expected![`lanes.rateLimit.${T}:${C1}`], limits)
    })

    it('lifts: refuses a lane not stopped, and a restore whose stopped record changed since', async () => {
      await assert.rejects(
        new Lift().run(stateWith([rl(limits)])),
        refusedAt('lanes[0]', /is not stopped/),
      )
      const stopped = stateWith([rl({ ...limits, outbound: stopRL, fastFinalityOutbound: stopRL })])
      const restore = (copied: MultiTokenPoolRateLimits, prior: unknown = null) => ({
        operation: 'stopMultiTokenPoolLanes',
        expected: {
          'stop.poolConfigManager': PCM_ADDRESS,
          [`inline.rateLimit.${T}:${C1}`]: prior,
          [`lanes.rateLimit.${T}:${C1}`]: copied,
        },
      })
      // the stop copied inbound 100; it is 999 now: someone else wrote since
      await assert.rejects(
        new Lift().run(stopped, {
          restore: restore({ ...limits, inbound: { enabled: true, capacity: 999n, rate: 1n } }),
        }),
        refusedAt('lanes[0]', /changed since the stop/),
      )
      // another pool's stop of the same token is refused (M39)
      await assert.rejects(
        new Lift().run(stopped, {
          restore: {
            ...restore(limits),
            expected: { ...restore(limits).expected, 'stop.poolConfigManager': T },
          },
        }),
        refusedAt('restore', /is a stop on PoolConfigManager/),
      )
      // exact restore: the stop created the record, so the lift removes it
      const created = decoded((await new Lift().run(stopped, { restore: restore(limits) })).data)
      assert.deepEqual(created, { removes: [T], sets: [] })
      // exact restore: the stop replaced a record, so the lift sets that record back
      const priorRL = { ...limits, inbound: { enabled: true, capacity: 77n, rate: 1n } } as const
      const replaced = decoded(
        (
          await new Lift().run(stopped, {
            restore: restore(limits, { ...key, rateLimits: priorRL }),
          })
        ).data,
      )
      assert.deepEqual(replaced.removes, [])
      assert.equal(replaced.sets[0]!.inbound!.capacity, 77n)
      assert.equal(replaced.sets[0]!.outbound!.capacity, 100n)
    })

    it('lifts from chain state: the policy fallback removes, no policy needs rateLimits, which writes only the lifted direction', async () => {
      const stopped = (policy?: string) =>
        stateWith(
          [
            rl({
              ...limits,
              outbound: stopRL,
              fastFinalityOutbound: stopRL,
              inbound: stopRL,
              fastFinalityInbound: stopRL,
            }),
          ],
          policy,
        )
      // inbound is stopped too: the policy fallback would lift it, so it is refused
      await assert.rejects(
        new Lift().run(stopped('pol')),
        refusedAt('lanes[0]', /also stopped inbound/),
      )
      const outOnly = (policy?: string) =>
        stateWith([rl({ ...limits, outbound: stopRL, fastFinalityOutbound: stopRL })], policy)
      assert.deepEqual(decoded((await new Lift().run(outOnly('pol'))).data), {
        removes: [T],
        sets: [],
      })
      await assert.rejects(
        new Lift().run(outOnly()),
        refusedAt('rateLimits', /no rate limit policy/),
      )
      // rateLimits: only the outbound buckets are taken; inbound keeps its stop
      const open = { enabled: true, capacity: 500n, rate: 5n } as const
      const { sets } = decoded(
        (
          await new Lift().run(stopped(), {
            rateLimits: {
              outbound: open,
              inbound: open,
              fastFinalityOutbound: open,
              fastFinalityInbound: open,
            },
          })
        ).data,
      )
      assert.equal(sets[0]!.outbound!.capacity, 500n)
      assert.equal(sets[0]!.inbound!.capacity, 0n)
    })
  })
})
