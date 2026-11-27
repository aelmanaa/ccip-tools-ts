/**
 * The post-state rules, one case per rule (passing and failing), on states built through the
 * projection; and the affected-lane enumeration.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ZeroAddress, getAddress } from 'ethers'

import type { CCTParamsInvalidError } from '../../errors.ts'
import {
  type MultiTokenPoolRateLimits,
  effectiveRateLimit,
  isLaneStopped,
  isStop,
} from '../../multi-token-pool.ts'
import type { RateLimitConfig } from '../../rate-limit.ts'
import { policyStoresOf } from '../multi-token-pool/contracts.ts'
import { attestedRemoteFacts } from './guard-facts.ts'
import { judgedLanesOf, laneJudgingOf } from './guard-run.ts'
import {
  type MultiTokenPoolGuardFacts,
  type MultiTokenPoolGuardOptions,
  type MultiTokenPoolRemoteLaneFacts,
  evaluateMultiTokenPoolGuards,
  guardLaneKey,
  guardPoolKey,
  loosensRateLimits,
  multiTokenPoolAffectedLanes,
  multiTokenPoolChainLanes,
  multiTokenPoolDroppedPools,
  multiTokenPoolLaneTransitions,
  multiTokenPoolMakesLive,
  multiTokenPoolPcmCheckedLanes,
  multiTokenPoolPcmLaneCheck,
  validateMultiTokenPoolGuardOptions,
} from './guards.ts'
import { C1, REMOTE_A, RPOOL, empty, inlineLane, on } from './projection.test.helpers.ts'
import {
  type MultiTokenPoolRecordChange,
  type MultiTokenPoolRecordState,
  applyMultiTokenPoolRecordChanges,
  resolveMultiTokenPoolLanes,
} from './projection.ts'

const addr = (n: number) => getAddress('0x' + n.toString(16).padStart(40, '0'))
const T1 = addr(0xa1)
const T2 = addr(0xa2)
const POOL = addr(0x11)
const OTHER_POOL = addr(0x12)
const HOOK = addr(0xcc)
const CCV = addr(0xdd)
const REMOTE_B = addr(0xe2)

const knownRemote = (
  o: Partial<{ readsLongData: boolean; registryPool: string | null; mapsBack: boolean }> = {},
): MultiTokenPoolRemoteLaneFacts => ({
  status: 'known',
  readsLongData: o.readsLongData ?? true,
  registryPool: o.registryPool === undefined ? RPOOL : o.registryPool,
  mapsBack: o.mapsBack ?? true,
})

/** Facts that pass every rule, for lanes T1/T2 on C1. */
function goodFacts(over: Partial<MultiTokenPoolGuardFacts> = {}): MultiTokenPoolGuardFacts {
  return {
    remoteLanes: new Map([
      [guardLaneKey({ tokenAddress: T1, remoteChainSelector: C1 }), knownRemote()],
      [guardLaneKey({ tokenAddress: T2, remoteChainSelector: C1 }), knownRemote()],
    ]),
    remotePools: new Map(),
    hookCallers: new Map([[HOOK, [POOL, OTHER_POOL]]]),
    servingPools: [POOL],
    additionalPoolDataBytes: new Map(),
    ...over,
  }
}

/** Applies `changes` to `base`, enumerates the affected lanes and evaluates. */
function judge(
  changes: MultiTokenPoolRecordChange[],
  o: {
    base?: MultiTokenPoolRecordState
    facts?: MultiTokenPoolGuardFacts
    options?: MultiTokenPoolGuardOptions
  } = {},
) {
  const before = o.base ?? empty()
  const after = applyMultiTokenPoolRecordChanges(before, changes)
  const lanes = multiTokenPoolAffectedLanes(before, after)
  const result = evaluateMultiTokenPoolGuards({
    after,
    lanes,
    chainLanes: multiTokenPoolChainLanes(after, [C1]),
    facts: o.facts ?? goodFacts(),
    options: o.options,
  })
  return {
    ...result,
    lanes,
    after,
    errors: result.findings.filter((f) => f.severity === 'error').map((f) => f.check),
  }
}

describe('MTTP post-state rules (cct/evm pool-config-manager)', () => {
  it('passes a fully configured long-data lane', () => {
    const r = judge(inlineLane(T1))
    assert.equal(r.lanes.length, 1)
    assert.deepEqual(r.findings, [])
    assert.deepEqual(r.factFailures, [])
  })

  it('enumerates only lanes whose projection changes (a masked policy record changes none)', () => {
    const base = applyMultiTokenPoolRecordChanges(empty(), [
      ...inlineLane(T1),
      { kind: 'assignPolicy', type: 'fee', tokenAddress: T1, policyName: 'p' },
    ])
    const r = judge(
      [
        {
          kind: 'setPolicyRecord',
          type: 'fee',
          record: {
            policyName: 'p',
            remoteChainSelector: 0n,
            feeConfig: {
              finalityFeeUSDCents: 9,
              fastFinalityFeeUSDCents: 9,
              finalityTransferFeeBps: 9,
              fastFinalityTransferFeeBps: 9,
            },
          },
        },
      ],
      { base },
    )
    assert.deepEqual(r.lanes, [])
  })

  it('refuses an open lane with a missing record (F11)', () => {
    assert.deepEqual(judge(inlineLane(T1, { skip: ['security'] })).errors, ['RECORD_MISSING'])
  })

  it('refuses closing a lane unless confirmed (F11)', () => {
    const base = applyMultiTokenPoolRecordChanges(empty(), inlineLane(T1))
    const close: MultiTokenPoolRecordChange[] = [
      { kind: 'removeInline', type: 'connection', tokenAddress: T1, remoteChainSelector: C1 },
    ]
    assert.deepEqual(judge(close, { base }).errors, ['LANE_CLOSED'])
    const ok = judge(close, {
      base,
      options: { confirmClosing: [{ tokenAddress: T1, remoteChainSelector: C1 }] },
    })
    assert.deepEqual(ok.errors, [])
    assert.deepEqual(
      ok.findings.map((f) => [f.check, f.severity]),
      [['LANE_CLOSED', 'warning']],
    )
  })

  it('refuses a destBytesOverhead below the pool data the lane sends (F12)', () => {
    assert.deepEqual(judge(inlineLane(T1, { bytes: 191 })).errors, ['DEST_BYTES_OVERHEAD_TOO_LOW'])
    assert.deepEqual(judge(inlineLane(T1, { bytes: 192 })).errors, [])
    // a provider's additional data lengthens long pool data, padded to 32 bytes
    const facts = goodFacts({
      additionalPoolDataBytes: new Map([
        [guardLaneKey({ tokenAddress: T1, remoteChainSelector: C1 }), 32],
      ]),
    })
    assert.deepEqual(judge(inlineLane(T1, { bytes: 192 }), { facts }).errors, [
      'DEST_BYTES_OVERHEAD_TOO_LOW',
    ])
    assert.deepEqual(judge(inlineLane(T1, { bytes: 224 }), { facts }).errors, [])
    // legacy data is one word
    const legacy = { format: 'legacy' as const, bytes: 32 }
    assert.deepEqual(judge(inlineLane(T1, legacy)).errors, [])
  })

  it('refuses gas below the minimum, raised when a hook resolves (G1)', () => {
    assert.deepEqual(judge(inlineLane(T1, { gas: 199_999 })).errors, ['DEST_GAS_OVERHEAD_TOO_LOW'])
    assert.deepEqual(judge(inlineLane(T1, { gas: 250_000, hook: HOOK })).errors, [
      'DEST_GAS_OVERHEAD_TOO_LOW',
    ])
    assert.deepEqual(judge(inlineLane(T1, { gas: 300_000, hook: HOOK })).errors, [])
    assert.deepEqual(
      judge(inlineLane(T1, { gas: 150_000 }), { options: { minDestGasOverhead: 100_000 } }).errors,
      [],
    )
  })

  it('refuses a resolved transfer fee above the cap, both tiers (F6)', () => {
    assert.deepEqual(judge(inlineLane(T1, { bps: 1_001 })).errors, ['TRANSFER_FEE_ABOVE_CAP'])
    assert.deepEqual(
      judge(inlineLane(T1, { bps: 1_001 }), { options: { maxTransferFeeBps: 2_000 } }).errors,
      [],
    )
  })

  it('refuses CCV lists that drop the default CCVs unless allowed; an empty list passes (F2)', () => {
    assert.deepEqual(judge(inlineLane(T1, { ccvs: [CCV] })).errors, [
      'DEFAULT_CCVS_DROPPED',
      'DEFAULT_CCVS_DROPPED',
    ])
    assert.deepEqual(judge(inlineLane(T1, { ccvs: [CCV, ZeroAddress] })).errors, [])
    assert.deepEqual(judge(inlineLane(T1, { ccvs: [] })).errors, [])
    assert.deepEqual(
      judge(inlineLane(T1, { ccvs: [CCV] }), { options: { allowDroppingDefaultCCVs: true } })
        .errors,
      [],
    )
  })

  it('refuses a hook that does not authorize every serving pool', () => {
    const lane = inlineLane(T1, { hook: HOOK })
    assert.deepEqual(judge(lane).errors, [])
    const facts = goodFacts({ servingPools: [POOL, addr(0x99)] })
    assert.deepEqual(judge(lane, { facts }).errors, ['HOOK_CALLER_MISSING'])
    const unread = judge(lane, { facts: goodFacts({ hookCallers: new Map() }) })
    assert.equal(unread.factFailures.length, 1)
  })

  it('refuses two local tokens resolving one remote token on a chain (F3)', () => {
    const base = applyMultiTokenPoolRecordChanges(empty(), inlineLane(T1))
    assert.deepEqual(judge(inlineLane(T2, { remoteToken: REMOTE_A }), { base }).errors, [
      'REMOTE_TOKEN_SHARED',
    ])
    assert.deepEqual(judge(inlineLane(T2, { remoteToken: REMOTE_B }), { base }).errors, [])
  })

  it('refuses legacy receive from a remote multi-token pool outside a migration window (F3)', () => {
    const lane = inlineLane(T1, { pools: [{ address: RPOOL, allowLegacyPoolData: true }] })
    const facts = (isMultiTokenPool: boolean) =>
      goodFacts({
        remotePools: new Map([[guardPoolKey(C1, RPOOL), { status: 'known', isMultiTokenPool }]]),
      })
    assert.deepEqual(judge(lane, { facts: facts(true) }).errors, [
      'LEGACY_RECEIVE_FROM_MULTI_TOKEN_POOL',
    ])
    assert.deepEqual(judge(lane, { facts: facts(false) }).errors, [])
    assert.deepEqual(
      judge(lane, { facts: facts(true), options: { migrationWindowChains: [C1] } }).errors,
      [],
    )
  })

  it('refuses long data toward a remote that reads only legacy data, except a paused token not yet registered (F14)', () => {
    const facts = (o: Parameters<typeof knownRemote>[0]) =>
      goodFacts({
        remoteLanes: new Map([
          [guardLaneKey({ tokenAddress: T1, remoteChainSelector: C1 }), knownRemote(o)],
        ]),
      })
    assert.deepEqual(judge(inlineLane(T1), { facts: facts({ readsLongData: false }) }).errors, [
      'POOL_DATA_FORMAT_MISMATCH',
    ])
    const paused: MultiTokenPoolRecordChange = {
      kind: 'setTokenPause',
      tokenAddress: T1,
      outbound: true,
    }
    assert.deepEqual(
      judge([...inlineLane(T1), paused], {
        facts: facts({ readsLongData: false, registryPool: null }),
      }).errors,
      [],
    )
    // the exception is the token's own pause, not a chain or global one
    const chainPaused: MultiTokenPoolRecordChange = {
      kind: 'setChainPause',
      remoteChainSelector: C1,
      outbound: true,
    }
    assert.deepEqual(
      judge([...inlineLane(T1), chainPaused], {
        facts: facts({ readsLongData: false, registryPool: null }),
      }).errors,
      ['NO_REMOTE_POOL'],
    )
  })

  it('compares the limit each transfer consumes: a disabled fast-finality bucket falls back to the default (B1)', () => {
    const stop = { enabled: true, capacity: 0n, rate: 0n } as const
    const big = { enabled: true, capacity: 10n ** 24n, rate: 10n ** 20n } as const
    const limits = (o: Partial<MultiTokenPoolRateLimits> = {}): MultiTokenPoolRateLimits => ({
      outbound: on(true),
      inbound: on(true),
      fastFinalityOutbound: on(false),
      fastFinalityInbound: on(false),
      ...o,
    })
    for (const [direction, fast] of [
      ['outbound', 'fastFinalityOutbound'],
      ['inbound', 'fastFinalityInbound'],
    ] as const) {
      // a lane stopped through its default bucket, fast-finality disabled: FTF traffic is held too
      const stopped = limits({ [direction]: stop })
      assert.equal(isLaneStopped(stopped, direction), true)
      // enabling the fast-finality bucket opens FTF transfers: a loosening, judged
      assert.equal(loosensRateLimits(stopped, limits({ [direction]: stop, [fast]: big })), true)
      assert.equal(isLaneStopped(limits({ [direction]: stop, [fast]: big }), direction), false)
      // enabling it above the default raises the FTF limit: judged
      assert.equal(loosensRateLimits(limits(), limits({ [fast]: big })), true)
      // enabling it below the default tightens FTF traffic: not judged
      assert.equal(
        loosensRateLimits(limits(), limits({ [fast]: { enabled: true, capacity: 1n, rate: 1n } })),
        false,
      )
      // the effective FTF limit is the default bucket while the FTF bucket is disabled
      assert.deepEqual(effectiveRateLimit(limits(), direction, true), on(true))
      assert.deepEqual(effectiveRateLimit(limits({ [fast]: big }), direction, true), big)
    }
  })

  it('R3 B1 repro: enabling the fast-finality bucket of a lane stopped through its default bucket is judged', () => {
    const stop = { enabled: true, capacity: 0n, rate: 0n } as const
    const off = { enabled: false } as const
    const before = {
      outbound: stop,
      inbound: on(true),
      fastFinalityOutbound: off,
      fastFinalityInbound: off,
    }
    const after = {
      ...before,
      fastFinalityOutbound: { enabled: true, capacity: 10n ** 24n, rate: 10n ** 22n } as const,
    }
    assert.equal(isLaneStopped(before, 'outbound'), true) // the NO_REMOTE_POOL waiver applies before
    assert.equal(isLaneStopped(after, 'outbound'), false) // FTF sends flow after
    assert.equal(loosensRateLimits(before, after), true) // so the write is judged
  })

  it('derives "makes lanes live" from the projection: a lifted stop or an unpause, not an opening (R1 m4, R3 m3)', () => {
    const stop = { enabled: true, capacity: 0n, rate: 0n } as const
    const rateLimits = (outbound: RateLimitConfig): MultiTokenPoolRecordChange => ({
      kind: 'setInline',
      type: 'rateLimit',
      record: {
        tokenAddress: T1,
        remoteChainSelector: C1,
        rateLimits: {
          outbound,
          inbound: on(true),
          fastFinalityOutbound: on(false),
          fastFinalityInbound: on(false),
        },
      },
    })
    const key = { tokenAddress: T1, remoteChainSelector: C1 }
    const lanesOf = (before: MultiTokenPoolRecordState, after: MultiTokenPoolRecordState) => {
      const [b] = resolveMultiTokenPoolLanes(before, [key])
      const [a] = resolveMultiTokenPoolLanes(after, [key])
      return [{ before: b!, after: a! }]
    }
    const stopped = applyMultiTokenPoolRecordChanges(empty(), [...inlineLane(T1), rateLimits(stop)])
    // a bucket or record write that lifts the stop makes the lane live: no attestations
    const lifted = applyMultiTokenPoolRecordChanges(stopped, [rateLimits(on(true))])
    assert.equal(multiTokenPoolMakesLive(lanesOf(stopped, lifted)), true)
    // stopping, or a write that keeps it stopped, does not
    assert.equal(multiTokenPoolMakesLive(lanesOf(lifted, stopped)), false)
    // opening a new lane does not (its remote side may be attested)
    const opened = applyMultiTokenPoolRecordChanges(empty(), inlineLane(T1))
    assert.equal(multiTokenPoolMakesLive(lanesOf(empty(), opened)), false)
  })

  it('applies each judging scope to the projected lanes (R3 M3: M9, M10, M11, M14, M15)', () => {
    const stop = { enabled: true, capacity: 0n, rate: 0n } as const
    const rl = (token: string, outbound: RateLimitConfig): MultiTokenPoolRecordChange => ({
      kind: 'setInline',
      type: 'rateLimit',
      record: {
        tokenAddress: token,
        remoteChainSelector: C1,
        rateLimits: {
          outbound,
          inbound: on(true),
          fastFinalityOutbound: on(false),
          fastFinalityInbound: on(false),
        },
      },
    })
    const before = applyMultiTokenPoolRecordChanges(empty(), [
      ...inlineLane(T1),
      ...inlineLane(T2, { remoteToken: REMOTE_B }),
      rl(T2, stop),
    ])
    // T1 loosens (more capacity); T2 is clamped further (still stopped)
    const after = applyMultiTokenPoolRecordChanges(before, [
      rl(T1, { enabled: true, capacity: 200n, rate: 1n }),
    ])
    const keys = [T1, T2].map((t) => ({ tokenAddress: t, remoteChainSelector: C1 }))
    const b = resolveMultiTokenPoolLanes(before, keys)
    const a = resolveMultiTokenPoolLanes(after, keys)
    const lanes = keys.map((_, i) => ({ before: b[i]!, after: a[i]! }))
    const tokensOf = (l: typeof lanes) => l.map((x) => x.after.tokenAddress)
    assert.deepEqual(judgedLanesOf('none', lanes), [])
    assert.deepEqual(tokensOf(judgedLanesOf('loosened', lanes)), [T1])
    assert.deepEqual(tokensOf(judgedLanesOf('all', lanes)), [T1, T2])
    // an unpause judges only the lanes going live: lifting T2's stop makes it live, T1 was live
    const lifted = applyMultiTokenPoolRecordChanges(before, [rl(T2, on(true))])
    const l2 = resolveMultiTokenPoolLanes(lifted, keys)
    assert.deepEqual(
      tokensOf(
        judgedLanesOf(
          'goingLive',
          keys.map((_, i) => ({ before: b[i]!, after: l2[i]! })),
        ),
      ),
      [T2],
    )
    // every pause is unjudged; every unpause judges what goes live
    for (const fn of ['pauseGlobally', 'pauseTokens', 'pauseChains'])
      assert.equal(laneJudgingOf(fn), 'none')
  })

  it('a stop is enabled with no capacity and no rate (M16, M17), and more rate alone loosens (M5)', () => {
    assert.equal(isStop({ isEnabled: true, capacity: 0n, rate: 0n }), true)
    assert.equal(isStop({ isEnabled: true, capacity: 0n, rate: 1n }), false)
    assert.equal(isStop({ isEnabled: false, capacity: 0n, rate: 0n }), false)
    const limits = (outbound: RateLimitConfig): MultiTokenPoolRateLimits => ({
      outbound,
      inbound: on(true),
      fastFinalityOutbound: on(false),
      fastFinalityInbound: on(false),
    })
    assert.equal(
      loosensRateLimits(
        limits({ enabled: true, capacity: 100n, rate: 1n }),
        limits({ enabled: true, capacity: 100n, rate: 2n }),
      ),
      true,
    )
  })

  it('reports a lifted stop as going live (stops are part of liveness)', () => {
    const stop = { enabled: true, capacity: 0n, rate: 0n } as const
    const rateLimits = (outbound: RateLimitConfig): MultiTokenPoolRecordChange => ({
      kind: 'setInline',
      type: 'rateLimit',
      record: {
        tokenAddress: T1,
        remoteChainSelector: C1,
        rateLimits: {
          outbound,
          inbound: on(true),
          fastFinalityOutbound: on(false),
          fastFinalityInbound: on(false),
        },
      },
    })
    const stoppedState = applyMultiTokenPoolRecordChanges(empty(), [
      ...inlineLane(T1),
      rateLimits(stop),
    ])
    const lifted = applyMultiTokenPoolRecordChanges(stoppedState, [rateLimits(on(true))])
    const key = { tokenAddress: T1, remoteChainSelector: C1 }
    const [before] = resolveMultiTokenPoolLanes(stoppedState, [key])
    const [after] = resolveMultiTokenPoolLanes(lifted, [key])
    const { goingLive } = multiTokenPoolLaneTransitions([{ before: before!, after: after! }])
    assert.deepEqual(goingLive, [{ ...key, directions: ['outbound'] }])
  })

  it('tells a loosening rate limit write from one that only tightens or stops (bucket writes judge only loosened lanes)', () => {
    const limits = (o: Partial<MultiTokenPoolRateLimits> = {}): MultiTokenPoolRateLimits => ({
      outbound: on(true),
      inbound: on(true),
      fastFinalityOutbound: on(false),
      fastFinalityInbound: on(false),
      ...o,
    })
    const stop = { enabled: true, capacity: 0n, rate: 0n } as const
    const more = { enabled: true, capacity: 200n, rate: 1n } as const
    // tightening, stopping, enabling a disabled bucket, no change
    for (const after of [
      limits({ outbound: stop }),
      limits({ fastFinalityOutbound: on(true) }),
      limits(),
    ])
      assert.equal(loosensRateLimits(limits(), after), false)
    // lifting a stop, more capacity, disabling, a new record
    assert.equal(loosensRateLimits(limits({ outbound: stop }), limits()), true)
    assert.equal(loosensRateLimits(limits(), limits({ inbound: more })), true)
    assert.equal(loosensRateLimits(limits(), limits({ outbound: on(false) })), true)
    assert.equal(loosensRateLimits(null, limits()), true)
    // a lane left with no limit is judged (RECORD_MISSING), and two nulls change nothing
    assert.equal(loosensRateLimits(limits(), null), true)
    assert.equal(loosensRateLimits(null, null), false)
    // the scope is read from the calldata's function
    assert.equal(laneJudgingOf('pauseTokens'), 'none')
    for (const fn of ['unpauseTokens', 'unpauseChains', 'unpauseGlobally'])
      assert.equal(laneJudgingOf(fn), 'goingLive')
    assert.equal(laneJudgingOf('applyRateLimitPolicyBucketUpdates'), 'loosened')
    assert.equal(laneJudgingOf('applyInlineRateLimitBucketUpdates'), 'loosened')
    assert.equal(laneJudgingOf('applyInlineRateLimitConfigUpdates'), 'loosened')
    assert.equal(laneJudgingOf('applyRateLimitPolicyConfigUpdates'), 'loosened')
    assert.equal(laneJudgingOf('applyInlineFeeConfigUpdates'), 'all')
  })

  it('waives a missing remote pool while the lane is stopped outbound, as a token pause does', () => {
    const facts = goodFacts({
      remoteLanes: new Map([
        [
          guardLaneKey({ tokenAddress: T1, remoteChainSelector: C1 }),
          knownRemote({ registryPool: null }),
        ],
      ]),
    })
    const stop = { enabled: true, capacity: 0n, rate: 0n } as const
    const limits = (outbound: RateLimitConfig, fastFinalityOutbound: RateLimitConfig) =>
      ({
        kind: 'setInline',
        type: 'rateLimit',
        record: {
          tokenAddress: T1,
          remoteChainSelector: C1,
          rateLimits: {
            outbound,
            inbound: on(true),
            fastFinalityOutbound,
            fastFinalityInbound: on(false),
          },
        },
      }) as MultiTokenPoolRecordChange
    // outbound stopped, no fast-finality bucket: nothing is sent, the lane may wait
    assert.deepEqual(judge([...inlineLane(T1), limits(stop, on(false))], { facts }).errors, [])
    // a fast-finality outbound bucket still open sends: refused
    assert.deepEqual(judge([...inlineLane(T1), limits(stop, on(true))], { facts }).errors, [
      'NO_REMOTE_POOL',
    ])
    assert.deepEqual(judge([...inlineLane(T1), limits(stop, stop)], { facts }).errors, [])
    // an inbound stop does not hold sends
    assert.deepEqual(
      judge(
        [
          ...inlineLane(T1),
          {
            kind: 'setInline',
            type: 'rateLimit',
            record: {
              tokenAddress: T1,
              remoteChainSelector: C1,
              rateLimits: {
                outbound: on(true),
                inbound: stop,
                fastFinalityOutbound: on(false),
                fastFinalityInbound: on(false),
              },
            },
          },
        ],
        { facts },
      ).errors,
      ['NO_REMOTE_POOL'],
    )
    assert.equal(isLaneStopped(null, 'outbound'), false)
  })

  it('refuses a lane whose remote registry names no pool, long or legacy (EVM-2 fund loss)', () => {
    const facts = goodFacts({
      remoteLanes: new Map([
        [
          guardLaneKey({ tokenAddress: T1, remoteChainSelector: C1 }),
          {
            status: 'known',
            readsLongData: false,
            registryPool: null,
            mapsBack: false,
            remoteTokenHasCode: false,
          },
        ],
      ]),
    })
    const long = judge(inlineLane(T1), { facts })
    assert.deepEqual(long.errors, ['NO_REMOTE_POOL'])
    assert.match(long.findings[0]!.reason, /has no code on the remote chain/)
    assert.deepEqual(judge(inlineLane(T1, { format: 'legacy', bytes: 32 }), { facts }).errors, [
      'NO_REMOTE_POOL',
    ])
  })

  it('refuses a lane that does not trust the remote registry pool, or a legacy lane that does not map back', () => {
    const facts = (o: Parameters<typeof knownRemote>[0]) =>
      goodFacts({
        remoteLanes: new Map([
          [guardLaneKey({ tokenAddress: T1, remoteChainSelector: C1 }), knownRemote(o)],
        ]),
      })
    assert.deepEqual(judge(inlineLane(T1), { facts: facts({ registryPool: addr(0xf9) }) }).errors, [
      'REMOTE_LANE_MISMATCH',
    ])
    const legacy = inlineLane(T1, { format: 'legacy', bytes: 32 })
    assert.deepEqual(judge(legacy, { facts: facts({ mapsBack: false }) }).errors, [
      'REMOTE_LANE_MISMATCH',
    ])
    assert.deepEqual(judge(legacy, { facts: facts({ mapsBack: true }) }).errors, [])
  })

  it('never passes on a remote fact it could not read', () => {
    const unknown = judge(inlineLane(T1), { facts: goodFacts({ remoteLanes: new Map() }) })
    assert.deepEqual(
      unknown.factFailures.map((f) => f.status),
      ['unknown'],
    )
    const missing = goodFacts({
      remoteLanes: new Map([
        [
          guardLaneKey({ tokenAddress: T1, remoteChainSelector: C1 }),
          { status: 'missing', reason: 'no pool on the remote registry' },
        ],
      ]),
    })
    assert.deepEqual(
      judge(inlineLane(T1), { facts: missing }).factFailures.map((f) => f.status),
      ['missing'],
    )
    // the error that left the side unread travels with the failure, for the refusal's context
    const cause = new Error('request timeout')
    const unread = goodFacts({
      remoteLanes: new Map([
        [
          guardLaneKey({ tokenAddress: T1, remoteChainSelector: C1 }),
          { status: 'unknown', reason: 'getChain could not serve it', cause },
        ],
      ]),
    })
    assert.equal(judge(inlineLane(T1), { facts: unread }).factFailures[0]?.cause, cause)
  })

  it('reports an attested remote fact as a warning, in the shape the reader builds', () => {
    const attestation = {
      remoteChainSelector: C1,
      remoteToken: REMOTE_A,
      remotePoolAddress: RPOOL,
      acceptsLongPoolData: true,
      attestedAt: 0n,
      validUntil: 1n,
      reason: 'ops read',
    }
    const judged = (format: 'long' | 'legacy') => {
      const changes = inlineLane(T1, { format })
      const lane = multiTokenPoolAffectedLanes(
        empty(),
        applyMultiTokenPoolRecordChanges(empty(), changes),
      )[0]!.after
      return judge(changes, {
        facts: goodFacts({
          remoteLanes: new Map([
            [
              guardLaneKey({ tokenAddress: T1, remoteChainSelector: C1 }),
              attestedRemoteFacts(lane, attestation),
            ],
          ]),
        }),
      }).findings.map((f) => [f.check, f.severity])
    }
    // a long lane names its source token in the data: the attestation suffices
    assert.deepEqual(judged('long'), [['REMOTE_ATTESTED', 'warning']])
    // a legacy lane relies on the reverse mapping, which an attestation does not read: fails closed
    assert.deepEqual(judged('legacy'), [
      ['REMOTE_LANE_MISMATCH', 'error'],
      ['REMOTE_ATTESTED', 'warning'],
    ])
  })

  it('refuses a policy lane whose provider answers no remote token', () => {
    const changes: MultiTokenPoolRecordChange[] = [
      ...inlineLane(T1, { skip: ['connection'] }),
      { kind: 'assignPolicy', type: 'connection', tokenAddress: T1, policyName: 'p' },
      {
        kind: 'setPolicyRecord',
        type: 'connection',
        record: { policyName: 'p', remoteChainSelector: C1, onlySubsetTokens: false },
      },
      { kind: 'setRemoteTokenAddressProvider', policyName: 'p', provider: addr(0xbb) },
    ]
    const before = empty()
    const after = applyMultiTokenPoolRecordChanges(before, changes)
    after.providerAnswers = [
      { provider: addr(0xbb), tokenAddress: T1, remoteChainSelector: C1, remoteToken: null },
    ]
    const lanes = multiTokenPoolAffectedLanes(before, after)
    const { findings } = evaluateMultiTokenPoolGuards({
      after,
      lanes,
      chainLanes: multiTokenPoolChainLanes(after, [C1]),
      facts: goodFacts(),
    })
    assert.deepEqual(
      findings.map((f) => f.check),
      ['NO_CONNECTION'],
    )
  })

  it('reports what a write opens and makes live, per direction', () => {
    const transitions = (changes: MultiTokenPoolRecordChange[], base = empty()) =>
      multiTokenPoolLaneTransitions(
        multiTokenPoolAffectedLanes(base, applyMultiTokenPoolRecordChanges(base, changes)),
      )
    const lane = { tokenAddress: T1, remoteChainSelector: C1 }
    // a lane opened unpaused goes live both ways
    assert.deepEqual(transitions(inlineLane(T1)), {
      opened: [{ ...lane, directions: ['outbound', 'inbound'] }],
      goingLive: [{ ...lane, directions: ['outbound', 'inbound'] }],
    })
    // opened with outbound paused: only inbound goes live
    const pausedOut: MultiTokenPoolRecordChange = {
      kind: 'setTokenPause',
      tokenAddress: T1,
      outbound: true,
    }
    assert.deepEqual(transitions([pausedOut, ...inlineLane(T1)]).goingLive, [
      { ...lane, directions: ['inbound'] },
    ])
    // an unpause makes a lane live without opening it
    const paused = applyMultiTokenPoolRecordChanges(empty(), [
      ...inlineLane(T1),
      { kind: 'setChainPause', remoteChainSelector: C1, outbound: true },
    ])
    assert.deepEqual(
      transitions([{ kind: 'setChainPause', remoteChainSelector: C1, outbound: false }], paused),
      {
        opened: [],
        goingLive: [{ ...lane, directions: ['outbound'] }],
      },
    )
    // opened fully paused: opened, but nothing goes live
    const bothPaused: MultiTokenPoolRecordChange = {
      kind: 'setTokenPause',
      tokenAddress: T1,
      outbound: true,
      inbound: true,
    }
    assert.deepEqual(transitions([bothPaused, ...inlineLane(T1)]), {
      opened: [{ ...lane, directions: [] }],
      goingLive: [],
    })
  })

  it('reads the remote facts a byte-exact reader reports (Solana): mapping, fail-closed, UID, admission', () => {
    const lane = guardLaneKey({ tokenAddress: T1, remoteChainSelector: C1 })
    const withRemote = (
      extra: Partial<MultiTokenPoolRemoteLaneFacts>,
      over: Partial<MultiTokenPoolGuardFacts> = {},
    ) =>
      goodFacts({
        remoteLanes: new Map([
          [lane, { ...knownRemote(), ...extra } as MultiTokenPoolRemoteLaneFacts],
        ]),
        ...over,
      })
    // a long lane whose remote stores the 20-byte form: refused, with the reader's reason
    const short = judge(inlineLane(T1), {
      facts: withRemote({ mapsBack: false, mapsBackReason: 'stores 20 bytes' }),
    })
    assert.deepEqual(short.errors, ['REMOTE_LANE_MISMATCH'])
    assert.equal(short.findings[0]?.reason, 'stores 20 bytes')
    // a remote lane that reverts every transfer: refused while live outbound, reported once paused
    const closed = withRemote({ failsClosed: 'stale SECURITY record' })
    assert.deepEqual(judge(inlineLane(T1), { facts: closed }).errors, ['REMOTE_LANE_MISMATCH'])
    const paused: MultiTokenPoolRecordChange = {
      kind: 'setTokenPause',
      tokenAddress: T1,
      outbound: true,
    }
    const pausedRun = judge([...inlineLane(T1), paused], { facts: closed })
    assert.deepEqual(pausedRun.errors, [])
    assert.ok(
      pausedRun.findings.some(
        (f) => f.check === 'REMOTE_LANE_MISMATCH' && f.severity === 'warning',
      ),
    )
    // a UID lane needs that UID as the provider data
    const UID = '0x' + 'ab'.repeat(32)
    assert.deepEqual(judge(inlineLane(T1), { facts: withRemote({ uid: UID }) }).errors, [
      'UID_MISMATCH',
    ])
    assert.deepEqual(
      judge(inlineLane(T1), {
        facts: withRemote(
          { uid: UID },
          { additionalPoolData: new Map([[lane, UID.toUpperCase().replace('0X', '0x')]]) },
        ),
      }).errors,
      [],
    )
    // a driven lane not admitted: a warning, transfers wait
    const waiting = judge(inlineLane(T1), { facts: withRemote({ admitted: false }) })
    assert.deepEqual(waiting.errors, [])
    assert.ok(
      waiting.findings.some((f) => f.check === 'LANE_NOT_ADMITTED' && f.severity === 'warning'),
    )
  })

  it('judges additional pool data by the providers that judge it on chain, both ways', () => {
    const lane = guardLaneKey({ tokenAddress: T1, remoteChainSelector: C1 })
    const UID = '0x' + 'ab'.repeat(32)
    const run = (
      remote: Partial<MultiTokenPoolRemoteLaneFacts>,
      over: Partial<MultiTokenPoolGuardFacts> = {},
      changes = inlineLane(T1),
    ) =>
      judge(changes, {
        facts: goodFacts({
          remoteLanes: new Map([
            [lane, { ...knownRemote(), ...remote } as MultiTokenPoolRemoteLaneFacts],
          ]),
          additionalPoolData: new Map([[lane, UID]]),
          additionalPoolDataBytes: new Map([[lane, 32]]),
          ...over,
        }),
      })
    // paired: the remote accepts what this lane sends, this token accepts what comes back
    assert.deepEqual(
      run(
        { remoteAcceptsOutbound: true, remoteSendsData: UID },
        { localAcceptsInbound: new Map([[lane, true]]) },
      ).findings,
      [],
    )
    // the remote token's provider refuses this lane's data: burned here, stuck there
    assert.deepEqual(run({ remoteAcceptsOutbound: false, remoteSendsData: UID }).errors, [
      'UID_MISMATCH',
    ])
    // this token's provider refuses what the remote sends
    assert.deepEqual(
      run({ remoteSendsData: '0x' }, { localAcceptsInbound: new Map([[lane, false]]) }).errors,
      ['UID_MISMATCH'],
    )
    // a trusted pool may send legacy data, and the provider refuses empty data
    assert.deepEqual(
      run(
        { remoteSendsData: UID },
        {
          localAcceptsLegacy: new Map([[lane, false]]),
          localAcceptsInbound: new Map([[lane, true]]),
        },
      ).errors,
      ['UID_MISMATCH'],
    )
    // the provider refuses to produce data for its own token: every send reverts
    assert.deepEqual(
      run(
        { remoteSendsData: UID },
        {
          additionalPoolData: new Map(),
          providerDataRefused: new Map([[lane, 'TokenNotFromFactory']]),
        },
      ).errors,
      ['UID_MISMATCH'],
    )
    // what the remote sends cannot be read: a fact failure, never a pass
    assert.deepEqual(
      run({}, {}).factFailures.map((f) => f.status),
      ['unknown'],
    )
    assert.deepEqual(
      run({ remoteSideUnread: 'unknown variant' }, {}).factFailures.map((f) => f.reason),
      ['unknown variant'],
    )
  })

  it('refuses legacy data from a remote pool this lane does not accept it from', () => {
    const lane = guardLaneKey({ tokenAddress: T1, remoteChainSelector: C1 })
    const withRemote = (pools: { address: string; allowLegacyPoolData: boolean }[]) =>
      judge(inlineLane(T1, { pools }), {
        facts: goodFacts({
          remoteLanes: new Map([
            [lane, { ...knownRemote(), remoteSendsLegacy: true } as MultiTokenPoolRemoteLaneFacts],
          ]),
        }),
      }).errors
    assert.deepEqual(withRemote([{ address: RPOOL, allowLegacyPoolData: false }]), [
      'POOL_DATA_FORMAT_MISMATCH',
    ])
    assert.deepEqual(withRemote([{ address: RPOOL, allowLegacyPoolData: true }]), [])
  })

  it('refuses a lane that trusts no remote pool as a finding that names the fix, not an unread fact', () => {
    const r = judge(inlineLane(T1, { pools: [] }))
    assert.deepEqual(r.errors, ['NO_REMOTE_POOL'])
    assert.match(r.findings[0]!.reason, /trusts no remote pool[\s\S]*add the remote pool/)
    assert.deepEqual(r.factFailures, [])
  })

  it("lists what a write drops from a lane's trusted pools, and only that", () => {
    const P1 = addr(0xf1)
    const P2 = addr(0xf2)
    const pools = (legacy: boolean) => [
      { address: P1, allowLegacyPoolData: legacy },
      { address: P2, allowLegacyPoolData: false },
    ]
    const base = applyMultiTokenPoolRecordChanges(empty(), inlineLane(T1, { pools: pools(true) }))
    const reset = (remotePools: { address: string; allowLegacyPoolData: boolean }[]) =>
      multiTokenPoolDroppedPools(
        multiTokenPoolAffectedLanes(
          base,
          applyMultiTokenPoolRecordChanges(base, [
            {
              kind: 'setInline',
              type: 'remotePool',
              record: {
                tokenAddress: T1,
                remoteChainSelector: C1,
                trustPolicyRemotePools: false,
                poolDataFormat: 'long',
                remotePools,
              },
            },
          ]),
        ),
      )
    const lane = { tokenAddress: T1, remoteChainSelector: C1 }
    // dropping P2, and turning legacy receive off on the P1 it keeps
    assert.deepEqual(reset([{ address: P1, allowLegacyPoolData: false }]), [
      { lane, remotePools: [P2], flags: ['allowLegacyPoolData'] },
    ])
    // keeping both, unchanged: nothing dropped
    assert.deepEqual(reset(pools(true)), [])
    // a closed lane is not a drop (confirmClosing covers it)
    const closed = applyMultiTokenPoolRecordChanges(base, [
      { kind: 'removeInline', type: 'connection', tokenAddress: T1, remoteChainSelector: C1 },
    ])
    assert.deepEqual(multiTokenPoolDroppedPools(multiTokenPoolAffectedLanes(base, closed)), [])
  })

  it("derives the PCM's checked lanes and its stores once (D47)", () => {
    const lanes = multiTokenPoolPcmCheckedLanes([
      {
        kind: 'setInline',
        type: 'connection',
        record: { tokenAddress: T1.toLowerCase(), remoteChainSelector: C1, remoteToken: REMOTE_A },
      },
      {
        kind: 'updateSubsetTokens',
        policyName: 'p',
        remoteChainSelector: C1,
        add: [T1, T2],
      } as MultiTokenPoolRecordChange,
      { kind: 'removeInline', type: 'connection', tokenAddress: T2, remoteChainSelector: 1n },
    ])
    // each lane once, checksummed; a removal runs no lane check
    assert.deepEqual(lanes, [
      { tokenAddress: T1, remoteChainSelector: C1 },
      { tokenAddress: T2, remoteChainSelector: C1 },
    ])
    assert.deepEqual(
      policyStoresOf({ connectionPolicyStore: 'c', feePolicyStore: 'f', securityPolicyStore: 's' }),
      [
        ['ConnectionPolicyStore', 'c'],
        ['FeePolicyStore', 'f'],
        ['SecurityPolicyStore', 's'],
      ],
    )
  })

  it("judges the PoolConfigManager's post-write lane check from the projection", () => {
    const lane = { tokenAddress: T1, remoteChainSelector: C1 }
    // an inline connection set on a lane with every record: nothing missing
    const full = applyMultiTokenPoolRecordChanges(empty(), inlineLane(T1))
    const set = inlineLane(T1).filter((c) => c.kind === 'setInline' && c.type === 'connection')
    assert.deepEqual(multiTokenPoolPcmLaneCheck(full, set), [])
    // with the fee and security records missing, _checkLane would revert: named per record type
    const partial = applyMultiTokenPoolRecordChanges(
      empty(),
      inlineLane(T1, { skip: ['fee', 'security'] }),
    )
    assert.deepEqual(
      multiTokenPoolPcmLaneCheck(partial, set).map((f) => [
        f.check,
        f.recordType,
        f.tokenAddress,
        f.remoteChainSelector,
      ]),
      [
        ['RECORD_MISSING', 'fee', lane.tokenAddress, lane.remoteChainSelector],
        ['RECORD_MISSING', 'security', lane.tokenAddress, lane.remoteChainSelector],
      ],
    )
  })

  it('validates confirmDropped with the exact path, and refuses a lane given twice', () => {
    const lane = { tokenAddress: T1, remoteChainSelector: C1 }
    const at = (o: unknown) => {
      try {
        validateMultiTokenPoolGuardOptions('op', '', { confirmDropped: o })
      } catch (e) {
        return (e as CCTParamsInvalidError).context.param
      }
      return 'ok'
    }
    assert.equal(at([{ remotePools: [] }]), 'confirmDropped[0].lane')
    assert.equal(
      at([{ lane: { ...lane, tokenAddress: '0x12' } }]),
      'confirmDropped[0].lane.tokenAddress',
    )
    assert.equal(at([{ lane }, { lane }]), 'confirmDropped[1]')
    assert.equal(at([{ lane, remotePools: 'not-a-list' }]), 'confirmDropped[0].remotePools')
    assert.equal(at([{ lane, flags: ['everything'] }]), 'confirmDropped[0].flags[0]')
    assert.equal(at([{ lane, remotePools: [addr(0xf1)], flags: ['allowLegacyPoolData'] }]), 'ok')
  })
})
