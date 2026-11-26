/**
 * The lane projection: one test per resolution rule of the stores (chainlink-ccip c950d9bc), then a
 * seeded property test against a reference resolver written separately, straight from the Solidity
 * (`ConnectionPolicyStore._resolveConnectionLevel`/`getLaneConnectionBatch`,
 * `FeePolicyStore._resolveFeeConfig`, `SecurityPolicyStore._resolveSecurityConfig`,
 * `PolicyConfig._resolvePolicyRecordLevel`, and the PCM's zeroing of lanes without a connection).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { getAddress } from 'ethers'

import type { LaneRecordType, TokenTransferFeeConfig } from '../../../chain.ts'
import { LANE_RECORD_TYPES } from '../../../evm/multi-token-pool.ts'
import { CCTParamsInvalidError } from '../../errors.ts'
import {
  type MultiTokenPoolRecordChange,
  type MultiTokenPoolRecordState,
  type MultiTokenPoolTokenRecords,
  type ProjectedMultiTokenPoolLane,
  applyMultiTokenPoolRecordChanges,
  multiTokenPoolSupportedChains,
  requiredMultiTokenPoolProviderAnswers,
  resolveMultiTokenPoolLanes,
} from './projection.ts'
import type { MultiTokenPoolRateLimits } from './records.ts'

const addr = (n: number) => getAddress('0x' + n.toString(16).padStart(40, '0'))
const T1 = addr(0xa1)
const T2 = addr(0xa2)
const T3 = addr(0xa3)
const PROVIDER = addr(0xbb)
const HOOK = addr(0xcc)
const CCV = addr(0xdd)
const REMOTE_TOKEN = addr(0xe1)
const POOL_A = addr(0xf1)
const POOL_B = addr(0xf2)
const C1 = 16015286601757825753n
const C2 = 14767482510784806043n
const C3 = 3478487238524512106n

const bucket = (capacity: bigint) => ({ enabled: capacity > 0n, capacity, rate: capacity / 10n })
const limits = (capacity: bigint): MultiTokenPoolRateLimits => ({
  outbound: bucket(capacity),
  inbound: bucket(capacity),
  fastFinalityOutbound: bucket(0n),
  fastFinalityInbound: bucket(0n),
})
const feeConfig = (cents: number) => ({
  finalityFeeUSDCents: cents,
  fastFinalityFeeUSDCents: cents * 2,
  finalityTransferFeeBps: 5,
  fastFinalityTransferFeeBps: 10,
})
const overhead = (gas: number) => ({ destGasOverhead: gas, destBytesOverhead: 192 })
const security = (hook: string | null) => ({ outboundCCVs: [CCV], inboundCCVs: [CCV], hook })

function token(
  tokenAddress: string,
  policies: Partial<Record<LaneRecordType, string>> = {},
): MultiTokenPoolTokenRecords {
  return {
    tokenAddress,
    isOutboundPaused: false,
    isInboundPaused: false,
    policies: Object.fromEntries(LANE_RECORD_TYPES.map((t) => [t, policies[t] ?? null])) as Record<
      LaneRecordType,
      string | null
    >,
    inline: {
      connection: [],
      remotePool: [],
      rateLimit: [],
      fee: [],
      destOverhead: [],
      security: [],
    },
  }
}

function emptyState(): MultiTokenPoolRecordState {
  return {
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
  }
}

/** A token fully configured inline on C1. */
function inlineLaneState(): MultiTokenPoolRecordState {
  const state = emptyState()
  const t = token(T1)
  t.inline.connection.push({ tokenAddress: T1, remoteChainSelector: C1, remoteToken: REMOTE_TOKEN })
  t.inline.remotePool.push({
    tokenAddress: T1,
    remoteChainSelector: C1,
    trustPolicyRemotePools: false,
    poolDataFormat: 'legacy',
    remotePools: [{ address: POOL_A, allowLegacyPoolData: true }],
  })
  t.inline.rateLimit.push({ tokenAddress: T1, remoteChainSelector: C1, rateLimits: limits(100n) })
  t.inline.fee.push({ tokenAddress: T1, remoteChainSelector: C1, feeConfig: feeConfig(10) })
  t.inline.destOverhead.push({
    tokenAddress: T1,
    remoteChainSelector: C1,
    destOverheadConfig: overhead(90_000),
  })
  t.inline.security.push({
    tokenAddress: T1,
    remoteChainSelector: C1,
    securityConfig: security(HOOK),
  })
  state.tokens.push(t)
  return state
}

/** T1, T2 on policy 'p' for every type: connection C1 (subset-only, T1) and C2; defaults for the rest. */
function policyState(): MultiTokenPoolRecordState {
  const state = emptyState()
  const all = Object.fromEntries(LANE_RECORD_TYPES.map((t) => [t, 'p']))
  state.tokens.push(token(T1, all), token(T2, all))
  state.policies.connection.push(
    { policyName: 'p', remoteChainSelector: C1, onlySubsetTokens: true, subsetTokens: [T1] },
    { policyName: 'p', remoteChainSelector: C2, onlySubsetTokens: false, subsetTokens: [] },
  )
  state.policies.remoteTokenAddressProviders.push({ policyName: 'p', provider: PROVIDER })
  state.policies.remotePool.push(
    { policyName: 'p', remoteChainSelector: C1, remotePoolAddresses: [POOL_B] },
    { policyName: 'p', remoteChainSelector: C2, remotePoolAddresses: [POOL_B] },
  )
  state.policies.rateLimit.push({
    policyName: 'p',
    remoteChainSelector: 0n,
    localDecimals: 18,
    rateLimits: limits(500n),
  })
  state.policies.fee.push(
    { policyName: 'p', remoteChainSelector: 0n, feeConfig: feeConfig(1) },
    { policyName: 'p', remoteChainSelector: C2, feeConfig: feeConfig(2) },
  )
  state.policies.destOverhead.push({
    policyName: 'p',
    remoteChainSelector: 0n,
    destOverheadConfig: overhead(120_000),
  })
  state.policies.security.push({
    policyName: 'p',
    remoteChainSelector: 0n,
    securityConfig: security(null),
  })
  for (const t of [T1, T2])
    for (const c of [C1, C2, C3])
      state.providerAnswers.push({
        provider: PROVIDER,
        tokenAddress: t,
        remoteChainSelector: c,
        remoteToken: REMOTE_TOKEN,
      })
  return state
}

const one = (state: MultiTokenPoolRecordState, tokenAddress: string, remoteChainSelector: bigint) =>
  resolveMultiTokenPoolLanes(state, [{ tokenAddress, remoteChainSelector }])[0]!

describe('multi-token pool lane projection (cct/evm pool-config-manager)', () => {
  it('resolves an inline lane from its own records', () => {
    const lane = one(inlineLaneState(), T1, C1)
    assert.equal(lane.connection.hasConnection, true)
    assert.equal(lane.connection.remoteToken, REMOTE_TOKEN)
    assert.equal(lane.connection.poolDataFormat, 'legacy')
    assert.deepEqual(lane.connection.remotePools, [{ address: POOL_A, allowLegacyPoolData: true }])
    assert.deepEqual(Object.values(lane.levels), Array(6).fill('inline'))
    assert.deepEqual(lane.tokenTransferFeeConfig, {
      ...overhead(90_000),
      ...feeConfig(10),
      isEnabled: true,
    } satisfies TokenTransferFeeConfig)
    assert.deepEqual(lane.rateLimits, limits(100n))
    assert.deepEqual(lane.verification, { hook: HOOK, outboundCCVs: [CCV], inboundCCVs: [CCV] })
  })

  it('takes the policy chain record over the default, and the default otherwise', () => {
    const state = policyState()
    assert.equal(one(state, T2, C2).levels.fee, 'policy-chain')
    assert.equal(one(state, T2, C2).tokenTransferFeeConfig.finalityFeeUSDCents, 2)
    assert.equal(one(state, T1, C1).levels.fee, 'policy-default')
    assert.equal(one(state, T1, C1).tokenTransferFeeConfig.finalityFeeUSDCents, 1)
  })

  it('gives connection and remote pool policies no default record', () => {
    const lane = one(policyState(), T2, C3)
    assert.equal(lane.levels.connection, 'none')
    assert.equal(lane.levels.remotePool, 'none')
    // the other types still resolve their default, as getLaneRecordLevelBatch reports before a lane exists
    assert.equal(lane.levels.fee, 'policy-default')
  })

  it('admits only the subset while onlySubsetTokens is set', () => {
    const state = policyState()
    assert.equal(one(state, T1, C1).connection.hasConnection, true)
    assert.equal(one(state, T2, C1).connection.hasConnection, false)
    const open = applyMultiTokenPoolRecordChanges(state, [
      {
        kind: 'setPolicyRecord',
        type: 'connection',
        record: { policyName: 'p', remoteChainSelector: C1, onlySubsetTokens: false },
      },
    ])
    assert.equal(one(open, T2, C1).connection.hasConnection, true)
  })

  it('zeroes the fee, rate limit and verification views of a lane without a connection', () => {
    const lane = one(policyState(), T2, C1)
    assert.equal(lane.levels.fee, 'policy-default')
    assert.equal(lane.tokenTransferFeeConfig.isEnabled, false)
    assert.equal(lane.tokenTransferFeeConfig.finalityFeeUSDCents, 0)
    assert.equal(lane.rateLimits, null)
    assert.deepEqual(lane.verification, { hook: null, outboundCCVs: [], inboundCCVs: [] })
    assert.deepEqual(lane.connection.remotePools, [])
  })

  it('unions inline and policy pools only with trustPolicyRemotePools, policy pools never legacy', () => {
    const state = policyState()
    const inline = (trust: boolean): MultiTokenPoolRecordChange => ({
      kind: 'setInline',
      type: 'remotePool',
      record: {
        tokenAddress: T2,
        remoteChainSelector: C2,
        trustPolicyRemotePools: trust,
        poolDataFormat: 'legacy',
        remotePools: [
          { address: POOL_A, allowLegacyPoolData: true },
          { address: POOL_B, allowLegacyPoolData: true },
        ],
      },
    })
    assert.deepEqual(one(state, T2, C2).connection.remotePools, [
      { address: POOL_B, allowLegacyPoolData: false },
    ])
    assert.equal(one(state, T2, C2).connection.poolDataFormat, 'long')
    const alone = one(applyMultiTokenPoolRecordChanges(state, [inline(false)]), T2, C2)
    assert.equal(alone.levels.remotePool, 'inline')
    assert.equal(alone.connection.poolDataFormat, 'legacy')
    assert.equal(alone.connection.remotePools.length, 2)
    // POOL_B is in both: the inline entry (legacy allowed) wins, and it is listed once
    const trusting = one(applyMultiTokenPoolRecordChanges(state, [inline(true)]), T2, C2)
    assert.deepEqual(trusting.connection.remotePools, [
      { address: POOL_A, allowLegacyPoolData: true },
      { address: POOL_B, allowLegacyPoolData: true },
    ])
  })

  it("reads a policy lane's remote token from its provider, null when the provider has none", () => {
    const state = policyState()
    assert.equal(one(state, T2, C2).connection.remoteToken, REMOTE_TOKEN)
    state.providerAnswers = state.providerAnswers.map((a) => ({ ...a, remoteToken: null }))
    const lane = one(state, T2, C2)
    assert.equal(lane.connection.hasConnection, true)
    assert.equal(lane.connection.remoteToken, null)
    const noProvider = applyMultiTokenPoolRecordChanges(state, [
      { kind: 'setRemoteTokenAddressProvider', policyName: 'p', provider: null },
    ])
    assert.equal(one(noProvider, T2, C2).connection.remoteToken, null)
  })

  it('refuses to guess a missing provider answer, and lists the answers it needs', () => {
    const state = policyState()
    state.providerAnswers = []
    assert.throws(() => one(state, T2, C2), CCTParamsInvalidError)
    const lanes = [
      { tokenAddress: T1, remoteChainSelector: C1 },
      { tokenAddress: T2, remoteChainSelector: C1 }, // excluded by the subset: no connection, no call
      { tokenAddress: T2, remoteChainSelector: C2 },
      { tokenAddress: T2, remoteChainSelector: C2 },
    ]
    assert.deepEqual(requiredMultiTokenPoolProviderAnswers(state, lanes), [
      { provider: PROVIDER, tokenAddress: T1, remoteChainSelector: C1 },
      { provider: PROVIDER, tokenAddress: T2, remoteChainSelector: C2 },
    ])
  })

  it('resolves chain selector 0 to none for every type', () => {
    assert.deepEqual(Object.values(one(policyState(), T1, 0n).levels), Array(6).fill('none'))
  })

  it('combines the global, chain and token pauses per direction', () => {
    const paused = applyMultiTokenPoolRecordChanges(inlineLaneState(), [
      { kind: 'setChainPause', remoteChainSelector: C1, inbound: true },
      { kind: 'setTokenPause', tokenAddress: T1, outbound: true },
    ])
    const lane = one(paused, T1, C1).connection
    assert.deepEqual([lane.isOutboundPaused, lane.isInboundPaused], [true, true])
    assert.deepEqual([lane.isTokenOutboundPaused, lane.isChainInboundPaused], [true, true])
    assert.deepEqual([lane.isTokenInboundPaused, lane.isChainOutboundPaused], [false, false])
    const global = one(
      applyMultiTokenPoolRecordChanges(inlineLaneState(), [
        { kind: 'setGlobalPause', paused: true },
      ]),
      T1,
      C1,
    )
    assert.deepEqual(
      [global.connection.isOutboundPaused, global.connection.isInboundPaused],
      [true, true],
    )
  })

  it('lists supported chains inline first, then the policy chains the token passes', () => {
    const state = applyMultiTokenPoolRecordChanges(policyState(), [
      {
        kind: 'setInline',
        type: 'connection',
        record: { tokenAddress: T1, remoteChainSelector: C3, remoteToken: REMOTE_TOKEN },
      },
    ])
    assert.deepEqual(multiTokenPoolSupportedChains(state, T1), [C3, C1, C2])
    assert.deepEqual(multiTokenPoolSupportedChains(state, T2), [C2])
    assert.deepEqual(multiTokenPoolSupportedChains(state, T3), [])
  })

  it('keeps a subset list on a record update, drops it with the record, and drops a provider with its policy', () => {
    const updated = applyMultiTokenPoolRecordChanges(policyState(), [
      {
        kind: 'setPolicyRecord',
        type: 'connection',
        record: { policyName: 'p', remoteChainSelector: C1, onlySubsetTokens: true },
      },
    ])
    assert.equal(one(updated, T1, C1).connection.hasConnection, true)
    const recreated = applyMultiTokenPoolRecordChanges(updated, [
      { kind: 'removePolicyRecord', type: 'connection', policyName: 'p', remoteChainSelector: C1 },
      {
        kind: 'setPolicyRecord',
        type: 'connection',
        record: { policyName: 'p', remoteChainSelector: C1, onlySubsetTokens: true },
      },
    ])
    assert.equal(one(recreated, T1, C1).connection.hasConnection, false)
    const removed = applyMultiTokenPoolRecordChanges(policyState(), [
      { kind: 'removePolicy', type: 'connection', policyName: 'p' },
    ])
    assert.deepEqual(removed.policies.remoteTokenAddressProviders, [])
    assert.deepEqual(removed.policies.connection, [])
  })

  it('addresses a policy by text or raw bytes32 alike, and leaves its input untouched', () => {
    const state = policyState()
    const before = structuredClone(state)
    const raw = '0x' + Buffer.from('p').toString('hex').padEnd(64, '0')
    const next = applyMultiTokenPoolRecordChanges(state, [
      {
        kind: 'setPolicyRecord',
        type: 'fee',
        record: { policyName: raw, remoteChainSelector: C1, feeConfig: feeConfig(7) },
      },
    ])
    assert.equal(one(next, T1, C1).levels.fee, 'policy-chain')
    assert.equal(one(next, T1, C1).tokenTransferFeeConfig.finalityFeeUSDCents, 7)
    assert.deepEqual(state, before)
  })

  it('agrees with the reference resolver on random states and writes (seeded)', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rand = mulberry32(seed)
      let state = randomState(rand)
      const lanes = TOKENS.flatMap((tokenAddress) =>
        [0n, ...CHAINS].map((remoteChainSelector) => ({ tokenAddress, remoteChainSelector })),
      )
      for (let step = 0; step < 6; step++) {
        const changes = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => randomChange(rand))
        state = applyMultiTokenPoolRecordChanges(state, changes)
        state.providerAnswers = answersFor(state, rand)
        const got = resolveMultiTokenPoolLanes(state, lanes)
        got.forEach((lane, i) =>
          assert.deepEqual(
            lane,
            referenceResolve(state, lanes[i]!),
            `seed ${seed} step ${step} lane ${lanes[i]!.tokenAddress}:${lanes[i]!.remoteChainSelector}`,
          ),
        )
        for (const t of TOKENS)
          assert.deepEqual(
            new Set(multiTokenPoolSupportedChains(state, t)),
            new Set(
              CHAINS.filter(
                (c) =>
                  referenceResolve(state, { tokenAddress: t, remoteChainSelector: c }).connection
                    .hasConnection,
              ),
            ),
            `seed ${seed} step ${step} supportedChains ${t}`,
          )
      }
    }
  })
})

// ─── Reference resolver and generators ─────────────────────────────────────────────────────────

const TOKENS = [T1, T2, T3]
const CHAINS = [C1, C2, C3]
const POLICIES = ['p', 'q']
const POOLS = [POOL_A, POOL_B, addr(0xf3)]

/** Written from the Solidity, deliberately naive: linear scans, no shared helper with the projection. */
function referenceResolve(
  s: MultiTokenPoolRecordState,
  {
    tokenAddress,
    remoteChainSelector: chain,
  }: { tokenAddress: string; remoteChainSelector: bigint },
): ProjectedMultiTokenPoolLane {
  const tok = s.tokens.find((t) => t.tokenAddress === tokenAddress) ?? token(tokenAddress)
  const findInline = <T extends LaneRecordType>(type: T) =>
    (tok.inline[type] as { remoteChainSelector: bigint }[]).find(
      (r) => r.remoteChainSelector === chain,
    )
  const findPolicy = (type: LaneRecordType, c: bigint) =>
    (s.policies[type] as { policyName: string; remoteChainSelector: bigint }[]).find(
      (r) => r.policyName === tok.policies[type] && r.remoteChainSelector === c,
    )
  const level = (type: LaneRecordType): [string, unknown] => {
    if (chain === 0n) return ['none', undefined]
    const own = findInline(type)
    if (own) return ['inline', own]
    if (tok.policies[type] === null) return ['none', undefined]
    const rec = findPolicy(type, chain)
    if (rec) {
      if (type === 'connection') {
        const c = rec as unknown as { onlySubsetTokens: boolean; subsetTokens: string[] }
        if (c.onlySubsetTokens && !c.subsetTokens.includes(tokenAddress)) return ['none', undefined]
      }
      return ['policy-chain', rec]
    }
    if (type === 'connection' || type === 'remotePool') return ['none', undefined]
    const def = findPolicy(type, 0n)
    return def ? ['policy-default', def] : ['none', undefined]
  }
  const r = Object.fromEntries(LANE_RECORD_TYPES.map((t) => [t, level(t)])) as Record<
    LaneRecordType,
    [string, any]
  >
  const has = r.connection[0] !== 'none'
  const pause = s.chainPauses.find((p) => p.remoteChainSelector === chain) ?? {
    outbound: false,
    inbound: false,
  }
  let remoteToken: string | null = null
  let format: 'legacy' | 'long' = 'long'
  let pools: { address: string; allowLegacyPoolData: boolean }[] = []
  if (has) {
    if (r.connection[0] === 'inline') remoteToken = r.connection[1].remoteToken
    else {
      const prov = s.policies.remoteTokenAddressProviders.find(
        (p) => p.policyName === tok.policies.connection,
      )
      if (prov)
        remoteToken = s.providerAnswers.find(
          (a) =>
            a.provider === prov.provider &&
            a.tokenAddress === tokenAddress &&
            a.remoteChainSelector === chain,
        )!.remoteToken
    }
    const own = tok.inline.remotePool.find((p) => p.remoteChainSelector === chain)
    if (own) {
      format = own.poolDataFormat
      pools = own.remotePools.map((p) => ({ ...p }))
    }
    if (!own || own.trustPolicyRemotePools) {
      const pol = s.policies.remotePool.find(
        (p) => p.policyName === tok.policies.remotePool && p.remoteChainSelector === chain,
      )
      for (const a of pol?.remotePoolAddresses ?? [])
        if (!pools.some((p) => p.address === a))
          pools.push({ address: a, allowLegacyPoolData: false })
    }
  }
  const fee = r.fee[1]
  const over = r.destOverhead[1]
  return {
    tokenAddress,
    remoteChainSelector: chain,
    connection: {
      hasConnection: has,
      isOutboundPaused: s.isGloballyPaused || tok.isOutboundPaused || pause.outbound,
      isInboundPaused: s.isGloballyPaused || tok.isInboundPaused || pause.inbound,
      isGloballyPaused: s.isGloballyPaused,
      isTokenOutboundPaused: tok.isOutboundPaused,
      isTokenInboundPaused: tok.isInboundPaused,
      isChainOutboundPaused: pause.outbound,
      isChainInboundPaused: pause.inbound,
      poolDataFormat: format,
      remoteToken,
      remotePools: pools,
    },
    levels: Object.fromEntries(
      LANE_RECORD_TYPES.map((t) => [t, r[t][0]]),
    ) as ProjectedMultiTokenPoolLane['levels'],
    tokenTransferFeeConfig:
      has && fee && over
        ? { ...over.destOverheadConfig, ...fee.feeConfig, isEnabled: true }
        : {
            destGasOverhead: 0,
            destBytesOverhead: 0,
            finalityFeeUSDCents: 0,
            fastFinalityFeeUSDCents: 0,
            finalityTransferFeeBps: 0,
            fastFinalityTransferFeeBps: 0,
            isEnabled: false,
          },
    rateLimits: has && r.rateLimit[1] ? r.rateLimit[1].rateLimits : null,
    verification:
      has && r.security[1]
        ? { ...r.security[1].securityConfig }
        : { hook: null, outboundCCVs: [], inboundCCVs: [] },
  }
}

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = <T>(rand: () => number, xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
const coin = (rand: () => number, p = 0.5) => rand() < p

function randomInline(
  rand: () => number,
  type: LaneRecordType,
  tokenAddress: string,
  remoteChainSelector: bigint,
): MultiTokenPoolRecordChange {
  const key = { tokenAddress, remoteChainSelector }
  switch (type) {
    case 'connection':
      return { kind: 'setInline', type, record: { ...key, remoteToken: pick(rand, POOLS) } }
    case 'remotePool':
      return {
        kind: 'setInline',
        type,
        record: {
          ...key,
          trustPolicyRemotePools: coin(rand),
          poolDataFormat: coin(rand) ? 'legacy' : 'long',
          remotePools: POOLS.filter(() => coin(rand)).map((address) => ({
            address,
            allowLegacyPoolData: coin(rand),
          })),
        },
      }
    case 'rateLimit':
      return {
        kind: 'setInline',
        type,
        record: { ...key, rateLimits: limits(BigInt(Math.floor(rand() * 1000))) },
      }
    case 'fee':
      return {
        kind: 'setInline',
        type,
        record: { ...key, feeConfig: feeConfig(Math.floor(rand() * 50)) },
      }
    case 'destOverhead':
      return {
        kind: 'setInline',
        type,
        record: { ...key, destOverheadConfig: overhead(Math.floor(rand() * 400_000)) },
      }
    case 'security':
      return {
        kind: 'setInline',
        type,
        record: { ...key, securityConfig: security(coin(rand) ? HOOK : null) },
      }
  }
}

function randomPolicyRecord(
  rand: () => number,
  type: LaneRecordType,
  policyName: string,
  remoteChainSelector: bigint,
): MultiTokenPoolRecordChange {
  const key = { policyName, remoteChainSelector }
  switch (type) {
    case 'connection':
      return {
        kind: 'setPolicyRecord',
        type,
        record: {
          ...key,
          remoteChainSelector: remoteChainSelector || C1,
          onlySubsetTokens: coin(rand),
        },
      }
    case 'remotePool':
      return {
        kind: 'setPolicyRecord',
        type,
        record: {
          ...key,
          remoteChainSelector: remoteChainSelector || C1,
          remotePoolAddresses: POOLS.filter(() => coin(rand)),
        },
      }
    case 'rateLimit':
      return {
        kind: 'setPolicyRecord',
        type,
        record: {
          ...key,
          localDecimals: 18,
          rateLimits: limits(BigInt(Math.floor(rand() * 1000))),
        },
      }
    case 'fee':
      return {
        kind: 'setPolicyRecord',
        type,
        record: { ...key, feeConfig: feeConfig(Math.floor(rand() * 50)) },
      }
    case 'destOverhead':
      return {
        kind: 'setPolicyRecord',
        type,
        record: { ...key, destOverheadConfig: overhead(Math.floor(rand() * 400_000)) },
      }
    case 'security':
      return {
        kind: 'setPolicyRecord',
        type,
        record: { ...key, securityConfig: security(coin(rand) ? HOOK : null) },
      }
  }
}

function randomChange(rand: () => number): MultiTokenPoolRecordChange {
  const type = pick(rand, LANE_RECORD_TYPES)
  const tokenAddress = pick(rand, TOKENS)
  const policyName = pick(rand, POLICIES)
  const chain = pick(rand, CHAINS)
  switch (Math.floor(rand() * 10)) {
    case 0:
      return randomInline(rand, type, tokenAddress, chain)
    case 1:
      return { kind: 'removeInline', type, tokenAddress, remoteChainSelector: chain }
    case 2:
      return randomPolicyRecord(rand, type, policyName, coin(rand, 0.3) ? 0n : chain)
    case 3:
      return {
        kind: 'removePolicyRecord',
        type,
        policyName,
        remoteChainSelector: coin(rand, 0.3) ? 0n : chain,
      }
    case 4:
      return {
        kind: 'assignPolicy',
        type,
        tokenAddress,
        policyName: coin(rand, 0.2) ? null : policyName,
      }
    case 5:
      return {
        kind: 'updateSubsetTokens',
        policyName,
        remoteChainSelector: chain,
        add: coin(rand) ? [tokenAddress] : [],
        remove: coin(rand) ? [pick(rand, TOKENS)] : [],
      }
    case 6:
      return {
        kind: 'setRemoteTokenAddressProvider',
        policyName,
        provider: coin(rand, 0.3) ? null : PROVIDER,
      }
    case 7:
      return {
        kind: 'setChainPause',
        remoteChainSelector: chain,
        outbound: coin(rand, 0.2),
        inbound: coin(rand, 0.2),
      }
    case 8:
      return {
        kind: 'setTokenPause',
        tokenAddress,
        outbound: coin(rand, 0.2),
        inbound: coin(rand, 0.2),
      }
    default:
      return coin(rand, 0.2)
        ? { kind: 'removePolicy', type, policyName }
        : { kind: 'setGlobalPause', paused: coin(rand, 0.1) }
  }
}

function randomState(rand: () => number): MultiTokenPoolRecordState {
  const changes: MultiTokenPoolRecordChange[] = []
  for (const t of TOKENS)
    for (const type of LANE_RECORD_TYPES)
      if (coin(rand, 0.7))
        changes.push({
          kind: 'assignPolicy',
          type,
          tokenAddress: t,
          policyName: pick(rand, POLICIES),
        })
  for (let i = 0; i < 20; i++) changes.push(randomChange(rand))
  return applyMultiTokenPoolRecordChanges(emptyState(), changes)
}

/** A provider answer (sometimes `null`, as a revert or invalid address reads) for every lane the state needs. */
function answersFor(state: MultiTokenPoolRecordState, rand: () => number) {
  const lanes = TOKENS.flatMap((tokenAddress) =>
    CHAINS.map((remoteChainSelector) => ({ tokenAddress, remoteChainSelector })),
  )
  return [
    ...state.providerAnswers,
    ...requiredMultiTokenPoolProviderAnswers(state, lanes).map((q) => ({
      ...q,
      remoteToken: coin(rand, 0.8) ? REMOTE_TOKEN : null,
    })),
  ]
}
