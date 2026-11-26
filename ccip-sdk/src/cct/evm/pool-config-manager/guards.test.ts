/**
 * The post-state rules, one case per rule (passing and failing), on states built through the
 * projection; and the affected-lane enumeration.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ZeroAddress, getAddress } from 'ethers'

import type { LaneRecordType } from '../../../chain.ts'
import { LANE_RECORD_TYPES } from '../../../evm/multi-token-pool.ts'
import {
  type MultiTokenPoolGuardFacts,
  type MultiTokenPoolGuardOptions,
  type MultiTokenPoolRemoteLaneFacts,
  evaluateMultiTokenPoolGuards,
  guardLaneKey,
  guardPoolKey,
  multiTokenPoolAffectedLanes,
  multiTokenPoolChainLanes,
} from './guards.ts'
import {
  type MultiTokenPoolRecordChange,
  type MultiTokenPoolRecordState,
  applyMultiTokenPoolRecordChanges,
} from './projection.ts'

const addr = (n: number) => getAddress('0x' + n.toString(16).padStart(40, '0'))
const T1 = addr(0xa1)
const T2 = addr(0xa2)
const POOL = addr(0x11)
const OTHER_POOL = addr(0x12)
const HOOK = addr(0xcc)
const CCV = addr(0xdd)
const REMOTE_A = addr(0xe1)
const REMOTE_B = addr(0xe2)
const RPOOL = addr(0xf1)
const C1 = 16015286601757825753n

const empty = (): MultiTokenPoolRecordState => ({
  isGloballyPaused: false,
  chainPauses: [],
  tokens: [],
  policies: {
    connection: [],
    remoteTokenAddressProviders: [],
    remotePool: [],
    rateLimit: [],
    fee: [],
    destOverhead: [],
    security: [],
  },
  providerAnswers: [],
})
const on = (enabled: boolean) =>
  ({ enabled, capacity: enabled ? 100n : 0n, rate: enabled ? 1n : 0n }) as const

/** Inline records of every type for `token` on C1, overridable per type. */
function inlineLane(
  token: string,
  o: {
    remoteToken?: string
    format?: 'legacy' | 'long'
    pools?: { address: string; allowLegacyPoolData: boolean }[]
    bytes?: number
    gas?: number
    bps?: number
    ccvs?: string[]
    hook?: string | null
    skip?: LaneRecordType[]
  } = {},
): MultiTokenPoolRecordChange[] {
  const key = { tokenAddress: token, remoteChainSelector: C1 }
  const all: Record<LaneRecordType, MultiTokenPoolRecordChange> = {
    connection: {
      kind: 'setInline',
      type: 'connection',
      record: { ...key, remoteToken: o.remoteToken ?? REMOTE_A },
    },
    remotePool: {
      kind: 'setInline',
      type: 'remotePool',
      record: {
        ...key,
        trustPolicyRemotePools: false,
        poolDataFormat: o.format ?? 'long',
        remotePools: o.pools ?? [{ address: RPOOL, allowLegacyPoolData: false }],
      },
    },
    rateLimit: {
      kind: 'setInline',
      type: 'rateLimit',
      record: {
        ...key,
        rateLimits: {
          outbound: on(true),
          inbound: on(true),
          fastFinalityOutbound: on(false),
          fastFinalityInbound: on(false),
        },
      },
    },
    fee: {
      kind: 'setInline',
      type: 'fee',
      record: {
        ...key,
        feeConfig: {
          finalityFeeUSDCents: 1,
          fastFinalityFeeUSDCents: 2,
          finalityTransferFeeBps: o.bps ?? 5,
          fastFinalityTransferFeeBps: o.bps ?? 5,
        },
      },
    },
    destOverhead: {
      kind: 'setInline',
      type: 'destOverhead',
      record: {
        ...key,
        destOverheadConfig: {
          destGasOverhead: o.gas ?? 350_000,
          destBytesOverhead: o.bytes ?? 224,
        },
      },
    },
    security: {
      kind: 'setInline',
      type: 'security',
      record: {
        ...key,
        securityConfig: {
          outboundCCVs: o.ccvs ?? [ZeroAddress],
          inboundCCVs: o.ccvs ?? [ZeroAddress],
          hook: o.hook ?? null,
        },
      },
    },
  }
  return LANE_RECORD_TYPES.filter((t) => !o.skip?.includes(t)).map((t) => all[t])
}

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
  })

  it('reports an attested remote fact as a warning', () => {
    const attested: MultiTokenPoolRemoteLaneFacts = {
      status: 'known',
      readsLongData: true,
      registryPool: RPOOL,
      mapsBack: true,
      attestation: {
        remoteChainSelector: C1,
        remoteToken: REMOTE_A,
        remotePoolAddress: RPOOL,
        acceptsLongPoolData: true,
        attestedAt: 0n,
        validUntil: 1n,
        reason: 'ops read',
      },
    }
    const r = judge(inlineLane(T1), {
      facts: goodFacts({
        remoteLanes: new Map([
          [guardLaneKey({ tokenAddress: T1, remoteChainSelector: C1 }), attested],
        ]),
      }),
    })
    assert.deepEqual(
      r.findings.map((f) => [f.check, f.severity]),
      [['REMOTE_ATTESTED', 'warning']],
    )
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
})
