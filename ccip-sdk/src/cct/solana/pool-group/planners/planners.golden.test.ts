/**
 * Expansion goldens of the Solana planners (S6 review M7) over a faked state read (the expansions
 * are pure over `OnboardingInputs` / `EnablementInputs` / `RemovalInputs`): the step names, ids and
 * dependencies per flow, the §4.1 cases (never pauses a live chain, blocks live admission without
 * the acknowledgement, leaves a foreign pause in place), stable chunk ids under partial landing
 * (M1), run-scoped pauses (M2), live-chain onboarding through paused creation (M6), batched removal
 * and the remote-stop attestation rules (M4).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Keypair, PublicKey } from '@solana/web3.js'

import '../../../../index.ts'
import { networkInfo } from '../../../../networks.ts'
import type { SolanaChain } from '../../../../solana/index.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { selectReady } from '../../../multi-token-pool-plan-engine.ts'
import type {
  GetPoolGroupChainResult,
  GetPoolGroupLaneResult,
  GetPoolGroupResult,
  PoolGroupMember,
} from '../types.ts'
import type { PlannerContext } from './context.ts'
import { type EnablementInputs, expandEnablementFrom, parseEnablement } from './enable-chain.ts'
import type { PlanState } from './flow-common.ts'
import {
  type OnboardingInputs,
  expandOnboardingFrom,
  parseOnboarding,
  refuseLivePool,
} from './onboard.ts'
import {
  type RemovalInputs,
  expandRemovalFrom,
  parseRemoval,
  remoteStopOf,
} from './remove-token.ts'
import { evaluatePlan } from './run.ts'

const SEPOLIA = networkInfo('ethereum-testnet-sepolia').chainSelector
const OWNER = Keypair.generate().publicKey.toBase58()
const GROUP = Keypair.generate().publicKey
const PROGRAM = Keypair.generate().publicKey
const POOL = '0x2222222222222222222222222222222222222222'
const NET = networkInfo('solana-devnet').name
const FEE = {
  destGasOverhead: 200_000,
  destBytesOverhead: 192,
  finalityFeeUSDCents: 0,
  fastFinalityFeeUSDCents: 0,
  finalityTransferFeeBps: 0,
  fastFinalityTransferFeeBps: 0,
  isEnabled: true,
}
const BUCKETS = {
  outbound: { enabled: false },
  inbound: { enabled: false },
  fastFinalityOutbound: { enabled: false },
  fastFinalityInbound: { enabled: false },
}

/** Sorted fresh mints, so chunk keys are predictable. */
const mints = (n: number) =>
  Array.from({ length: n }, () => Keypair.generate().publicKey.toBase58()).sort()
/** The EVM counterpart of mint `i` (distinct, so REMOTE_TOKEN_SHARED never applies). */
const remoteOf = (i: number) => `0x${(i + 1).toString(16).padStart(40, '0')}`

function ctxOf(landed: string[] = [], runId = 'r1', squads = false): PlannerContext {
  return {
    operation: 'test',
    chain: { network: networkInfo('solana-devnet') } as unknown as SolanaChain,
    ref: { program: PROGRAM, group: GROUP },
    payer: OWNER,
    actor: OWNER,
    landed: new Set(landed),
    runId,
    squads,
  }
}

const group = { owner: OWNER, poolGroupId: 'gid', remoteChainSelectors: [SEPOLIA] }
function record(over: Partial<GetPoolGroupChainResult> = {}): GetPoolGroupChainResult {
  return {
    laneMode: 'all-members',
    drivenLanesPaused: false,
    groupPaused: false,
    pausedOutbound: false,
    pausedInbound: false,
    subsetTokens: [],
    inheritsDefault: [],
    policy: {
      connection: { remotePools: [{ address: POOL, allowLegacyPoolData: false }] },
      fee: { tokenTransferFeeConfig: FEE },
      rateLimit: BUCKETS,
    },
    ...over,
  } as unknown as GetPoolGroupChainResult
}
function member(mint: string, i: number, listed = true): PoolGroupMember {
  return {
    tokenAddress: mint,
    poolGroupAddress: GROUP.toBase58(),
    remoteTokens: listed
      ? [{ remoteChainSelectors: [SEPOLIA], token: remoteOf(i), decimals: 18 }]
      : [],
  } as unknown as PoolGroupMember
}
function lane(mint: string, over: Partial<GetPoolGroupLaneResult> = {}): GetPoolGroupLaneResult {
  return {
    tokenAddress: mint,
    remoteChainSelector: SEPOLIA,
    kind: 'driven',
    poolGroupAddress: GROUP.toBase58(),
    pausedOutbound: false,
    pausedInbound: false,
    classSource: null,
    ccvCopy: null,
    ...over,
  } as unknown as GetPoolGroupLaneResult
}
function stateOf(
  r: GetPoolGroupChainResult | undefined,
  members: PoolGroupMember[] = [],
  lanes: GetPoolGroupLaneResult[] = [],
  owners: string[] = [],
): PlanState {
  return {
    slot: 1n,
    group: group as unknown as GetPoolGroupResult,
    records: new Map(r ? [[SEPOLIA, r]] : []),
    members: new Map(members.map((m) => [m.tokenAddress, m])),
    lanes: new Map(lanes.map((l) => [`${l.tokenAddress}:${SEPOLIA}`, l])),
    poolOwners: new Map(owners.map((m) => [m, OWNER])),
  }
}

const onboardParams = (ms: string[], extra: Record<string, unknown> = {}) =>
  parseOnboarding({
    poolProgramAddress: PROGRAM.toBase58(),
    poolGroupAddress: GROUP.toBase58(),
    tokens: ms.map((tokenAddress, i) => ({
      tokenAddress,
      remoteTokens: [
        { remoteChainSelector: SEPOLIA, remoteTokenAddress: remoteOf(i), remoteTokenDecimals: 18 },
      ],
    })),
    payer: OWNER,
    ...extra,
  }).parsed
const inputs = (state: PlanState): OnboardingInputs => ({
  state,
  tokenSteps: new Map(),
  policies: new Map(),
})
const ids = (specs: { step: { id: string } }[]) => specs.map((s) => s.step.id)
const names = (specs: { step: { name: string } }[]) => specs.map((s) => s.step.name)
const id = (...parts: (string | bigint)[]) => [NET, GROUP.toBase58(), ...parts].join('/')
const pauseId = (run = 'r1') => id('pausePoolGroupChainLanes', SEPOLIA, `run-${run}`)

describe('onboarding goldens', () => {
  it('behind this run’s chain pause: join, materialize, check, unpause (§5.1)', () => {
    const ms = mints(2)
    const x = expandOnboardingFrom(
      ctxOf([pauseId()]),
      onboardParams(ms, { unpause: true }),
      inputs(stateOf(record({ drivenLanesPaused: true }), [], [], ms)),
    )
    assert.equal(x.blockedBy, undefined)
    assert.deepEqual(names(x.specs), [
      'joinPoolGroup',
      'materializePoolGroupLanes',
      'checkLanes',
      'unpausePoolGroupChainLanes',
    ])
    assert.deepEqual(ids(x.specs).slice(0, 2), [
      id('joinPoolGroup', ms[0]!),
      id('materializePoolGroupLanes', SEPOLIA, ms[0]!),
    ])
    assert.equal(x.specs[3]!.step.id, id('unpausePoolGroupChainLanes', SEPOLIA, 'run-r1'))
    assert.deepEqual(x.specs[3]!.step.dependsOn, [id('checkLanes')])
  })

  it('leaves a foreign pause in place, and another run’s landed id lifts nothing (M2)', () => {
    const ms = mints(1)
    for (const landed of [[], [pauseId('r0')]]) {
      const x = expandOnboardingFrom(
        ctxOf(landed),
        onboardParams(ms, { unpause: true }),
        inputs(stateOf(record({ drivenLanesPaused: true }), [], [], ms)),
      )
      assert.ok(!names(x.specs).includes('unpausePoolGroupChainLanes'))
      assert.deepEqual(x.blockedBy?.steps, [pauseId()])
    }
  })

  it('30 tokens: a partial landing never re-proposes a pending chunk (M1)', () => {
    const ms = mints(30)
    const params = onboardParams(ms)
    const r = record({ drivenLanesPaused: true })
    const first = expandOnboardingFrom(ctxOf([pauseId()]), params, inputs(stateOf(r, [], [], ms)))
    const joins = first.specs.filter((s) => s.step.name === 'joinPoolGroup')
    assert.deepEqual(
      joins.map((s) => [s.step.id, s.step.progress]),
      [
        [id('joinPoolGroup', ms[0]!), 12],
        [id('joinPoolGroup', ms[12]!), 12],
        [id('joinPoolGroup', ms[24]!), 6],
      ],
    )
    const wave = selectReady(
      first.specs.map((s) => s.step),
      { maxReadySteps: 20 },
    )
    assert.deepEqual(
      wave.ready.map((s) => s.id),
      joins.map((s) => s.step.id),
    )
    // chunk 0 lands while chunks 1 and 2 are still proposals
    const pending = Object.fromEntries(joins.slice(1).map((s) => [s.step.id, s.step.inputsHash]))
    const landedMembers = ms.slice(0, 12).map((m) => member(m, ms.indexOf(m)))
    const again = expandOnboardingFrom(
      ctxOf([pauseId()]),
      params,
      inputs(stateOf(r, landedMembers, [], ms)),
    )
    const next = selectReady(
      again.specs.map((s) => s.step),
      { maxReadySteps: 20, pendingStepHashes: pending },
    )
    assert.deepEqual(next.pendingSteps, Object.keys(pending))
    assert.deepEqual(next.stalePendingSteps, [])
    assert.ok(!next.ready.some((s) => s.name === 'joinPoolGroup'), 'no duplicate join')
    // materialize chunks keep their ids when the first 24 lanes exist
    const lanes = ms.slice(0, 24).map((m) => lane(m, { pausedOutbound: true, pausedInbound: true }))
    const all = ms.map((m, i) => member(m, i))
    const third = expandOnboardingFrom(
      ctxOf([pauseId()]),
      params,
      inputs(stateOf(r, all, lanes, ms)),
    )
    assert.deepEqual(
      third.specs.filter((s) => s.step.name === 'materializePoolGroupLanes').map((s) => s.step.id),
      [id('materializePoolGroupLanes', SEPOLIA, ms[24]!)],
    )
  })

  it('a live chain is never paused: join without it, paused creation, lift per mint (M6)', () => {
    const ms = mints(2)
    const params = onboardParams(ms, { unpause: true })
    // without the acknowledgement: blocked at the paused creation, nothing goes live
    const blocked = expandOnboardingFrom(ctxOf(), params, inputs(stateOf(record(), [], [], ms)))
    const admit = id('admitPausedLanes', ms[0]!, 'run-r1')
    assert.deepEqual(blocked.blockedBy?.steps, [admit])
    assert.match(String(blocked.blockedBy.reason), /acknowledgeLiveAdmission/)
    const acked = expandOnboardingFrom(
      ctxOf(),
      onboardParams(ms, { unpause: true, solana: { acknowledgeLiveAdmission: true } }),
      inputs(stateOf(record(), [], [], ms)),
    )
    assert.equal(acked.blockedBy, undefined)
    assert.deepEqual(names(acked.specs), [
      'joinPoolGroup',
      'admitPausedLanes',
      'checkLanes',
      'unpausePoolGroupLanes',
      'unpausePoolGroupLanes',
    ])
    assert.ok(!names(acked.specs).includes('pausePoolGroupChainLanes'))
    assert.ok(!names(acked.specs).includes('materializePoolGroupLanes'))
    // the join lists no live chain; the paused creation lists it and creates the lanes paused
    const join = acked.specs[0]!.step.inputs as { poolGroupMembers: { remoteTokens: unknown[] }[] }
    assert.deepEqual(
      join.poolGroupMembers.map((m) => m.remoteTokens),
      [[], []],
    )
    const create = acked.specs[1]!.step
    assert.equal(create.id, admit)
    assert.equal((create.inputs as { createLanesPaused: boolean }).createLanesPaused, true)
    assert.deepEqual(create.dependsOn, [id('joinPoolGroup', ms[0]!)])
    assert.deepEqual(acked.specs[3]!.step.dependsOn, [id('checkLanes'), admit])
    // after the creation landed: the lanes exist paused, and only this run's landed id lifts them
    const members = ms.map((m, i) => member(m, i))
    const lanes = ms.map((m) => lane(m, { pausedOutbound: true, pausedInbound: true }))
    const resumed = expandOnboardingFrom(
      ctxOf([admit]),
      params,
      inputs(stateOf(record(), members, lanes, ms)),
    )
    assert.deepEqual(names(resumed.specs), [
      'checkLanes',
      'unpausePoolGroupLanes',
      'unpausePoolGroupLanes',
    ])
    const foreign = expandOnboardingFrom(
      ctxOf([id('admitPausedLanes', ms[0]!, 'run-r0')]),
      params,
      inputs(stateOf(record(), members, lanes, ms)),
    )
    assert.ok(!names(foreign.specs).includes('unpausePoolGroupLanes'))
    assert.ok(foreign.blockedBy)
    // someone cleared one flag: never lifted here
    const moved = expandOnboardingFrom(
      ctxOf([admit]),
      params,
      inputs(stateOf(record(), members, [lanes[0]!, lane(ms[1]!, { pausedOutbound: true })], ms)),
    )
    assert.equal(names(moved.specs).filter((n) => n === 'unpausePoolGroupLanes').length, 1)
  })

  it('M5: a registry naming another pool that serves lanes is refused', async () => {
    const pool = Keypair.generate().publicKey
    const ctx = {
      ...ctxOf(),
      chain: {
        network: networkInfo('solana-devnet'),
        getTokenPoolRemotes: () =>
          Promise.resolve({ 'ethereum-testnet-sepolia': { remotePools: ['0x01'] } }),
      } as unknown as SolanaChain,
    }
    const [t] = onboardParams(mints(1)).tokens
    await assert.rejects(
      refuseLivePool(ctx, t!, 0, pool),
      (e: unknown) => e instanceof CCTParamsInvalidError && /serves 1 lane/.test(e.message),
    )
    const idle = {
      ...ctx,
      chain: {
        network: networkInfo('solana-devnet'),
        getTokenPoolRemotes: () => Promise.resolve({}),
      } as unknown as SolanaChain,
    }
    await refuseLivePool(idle, t!, 0, pool)
    // R-major 1: this pool on interface 1 that serves lanes is refused before the switch
    await assert.rejects(
      refuseLivePool(ctx, t!, 0, pool, 'interface'),
      (e: unknown) => e instanceof CCTParamsInvalidError && /on interface 1/.test(e.message),
    )
    await refuseLivePool(idle, t!, 0, pool, 'interface')
  })
})

describe('enablement goldens', () => {
  const remoteChain = {
    remoteChainSelector: SEPOLIA,
    remotePools: [{ address: POOL, allowLegacyPoolData: false }],
    rateLimits: BUCKETS,
    tokenTransferFeeConfig: FEE,
  }
  const enable = (extra: Record<string, unknown>) =>
    parseEnablement({
      poolProgramAddress: PROGRAM.toBase58(),
      poolGroupAddress: GROUP.toBase58(),
      remoteChain,
      tokenAddresses: 'all-members',
      payer: OWNER,
      solana: { detachFromPoolGroupDefault: true },
      ...extra,
    } as never).parsed
  const enableInputs = (state: PlanState, ms: string[]): EnablementInputs => ({
    state,
    mints: ms,
    lookupTables: [],
  })

  it("from 'off': pause (run-scoped), materialize, check, unpause", () => {
    const ms = mints(3)
    const members = ms.map((m, i) => member(m, i))
    const x = expandEnablementFrom(
      ctxOf(),
      enable({ unpause: true }),
      enableInputs(stateOf(record({ laneMode: 'off' }), members, [], ms), ms),
    )
    const tail = names(x.specs).filter((n) => n !== 'setPoolGroupChainPolicy')
    assert.deepEqual(tail, [
      'pausePoolGroupChainLanes',
      'materializePoolGroupLanes',
      'checkLanes',
      'unpausePoolGroupChainLanes',
    ])
    assert.ok(ids(x.specs).includes(pauseId()))
  })

  it('a live subset chain: admissions of 4 create their lanes paused; no chain pause (M6)', () => {
    const ms = mints(6)
    const members = ms.map((m, i) => member(m, i))
    const blocked = expandEnablementFrom(
      ctxOf(),
      enable({ tokenAddresses: ms, unpause: true }),
      enableInputs(stateOf(record({ laneMode: 'subset' }), members, [], ms), ms),
    )
    assert.match(blocked.blockedBy?.reason ?? '', /acknowledgeLiveAdmission/)
    const x = expandEnablementFrom(
      ctxOf(),
      enable({
        tokenAddresses: ms,
        unpause: true,
        solana: { detachFromPoolGroupDefault: true, acknowledgeLiveAdmission: true },
      }),
      enableInputs(stateOf(record({ laneMode: 'subset' }), members, [], ms), ms),
    )
    assert.equal(x.blockedBy, undefined)
    const admits = x.specs.filter((s) => s.step.name === 'admitPoolGroupMembers')
    assert.deepEqual(
      admits.map((s) => [s.step.id, (s.step.inputs as { addTokens: string[] }).addTokens.length]),
      [
        [id('admitPoolGroupMembers', SEPOLIA, ms[0]!, 'run-r1'), 4],
        [id('admitPoolGroupMembers', SEPOLIA, ms[4]!, 'run-r1'), 2],
      ],
    )
    assert.ok(
      admits.every((s) => (s.step.inputs as { createLanesPaused?: boolean }).createLanesPaused),
    )
    assert.ok(!names(x.specs).includes('pausePoolGroupChainLanes'))
    assert.ok(!names(x.specs).includes('materializePoolGroupLanes'))
    assert.equal(names(x.specs).filter((n) => n === 'unpausePoolGroupLanes').length, 6)
  })

  it('widening a live subset: the listing members by subset first, then all-members', () => {
    const ms = mints(3)
    const members = ms.map((m, i) => member(m, i, i < 2))
    const x = expandEnablementFrom(
      ctxOf(),
      enable({ solana: { detachFromPoolGroupDefault: true, acknowledgeLiveAdmission: true } }),
      enableInputs(stateOf(record({ laneMode: 'subset' }), members, [], ms), ms),
    )
    const admits = x.specs.filter((s) => s.step.name === 'admitPoolGroupMembers')
    assert.equal(admits.length, 2)
    assert.deepEqual((admits[0]!.step.inputs as { addTokens: string[] }).addTokens, ms.slice(0, 2))
    assert.equal((admits[1]!.step.inputs as { laneMode: string }).laneMode, 'all-members')
    assert.deepEqual(admits[1]!.step.dependsOn, [admits[0]!.step.id])
  })
})

describe('removal goldens', () => {
  const removal = (ms: string[], solana: Record<string, unknown> = {}) =>
    parseRemoval({
      poolGroupAddress: GROUP.toBase58(),
      tokenAddress: ms[0]!,
      payer: OWNER,
      solana: { tokenAddresses: ms.slice(1), ...solana },
    }).parsed
  const leaving = (ms: string[]): RemovalInputs => ({
    slot: 1n,
    poolGroupId: 'gid',
    tokens: ms.map((m) => ({
      mint: m,
      owner: OWNER,
      member: { chains: [SEPOLIA] },
      lanes: [
        {
          key: { tokenAddress: m, remoteChainSelector: SEPOLIA },
          ownPools: [],
          groupPools: [POOL],
          driven: true,
          ownOutboundPaused: false,
          ownInboundPaused: false,
          ownFormat: 'long' as const,
          uid: null,
        },
      ],
    })),
  })
  const keys = (ms: string[]) =>
    ms.map((tokenAddress) => ({ tokenAddress, remoteChainSelector: SEPOLIA }))

  it('4 tokens batch: pauses per mint, one drop step, one member close', () => {
    const ms = mints(4)
    const x = expandRemovalFrom(ctxOf(), removal(ms), leaving(ms), () =>
      Promise.resolve({ stopped: true }),
    )
    const count = (n: string) => names(x.specs).filter((s) => s === n).length
    assert.equal(count('pauseLaneOutbound'), 4)
    assert.equal(count('awaitRemoteOutboundStop'), 4)
    assert.equal(count('dropChainsAndCloseLanes'), 1)
    assert.equal(count('closePoolGroupMembers'), 1)
    const close = x.specs.find((s) => s.step.name === 'closePoolGroupMembers')!
    assert.deepEqual(close.step.dependsOn, [id('setPoolGroupMemberRemoteTokens', ms[0]!)])
    // one wave holds every pause
    const wave = selectReady(
      x.specs.map((s) => s.step),
      { maxReadySteps: 20 },
    )
    assert.equal(wave.ready.length, 4)
  })

  it('the remote stop: a readable EVM side is never attested; an unreadable one is (M3, M4)', async () => {
    const ms = mints(1)
    const lanes = keys(ms)
    const run = async (
      stop: Awaited<ReturnType<Parameters<typeof expandRemovalFrom>[3] & {}>>,
      solana = {},
    ) => {
      const ctx = ctxOf()
      const x = expandRemovalFrom(ctx, removal(ms, solana), leaving(ms), () =>
        Promise.resolve(stop),
      )
      const pause = x.specs.find((s) => s.step.name === 'pauseLaneOutbound')!.step.id
      ctx.landed.add(pause)
      return evaluatePlan(
        ctx,
        () =>
          Promise.resolve({
            ...x,
            specs: x.specs.filter((s) => s.step.id !== pause),
          }),
        {},
      )
    }
    const sends = await run({ stopped: false, reason: 'still sends' })
    assert.match(sends.plan.blockedBy?.reason ?? '', /still sends/)
    // the drain confirmation never stands in for the remote stop
    const drainOnly = await run(
      { stopped: false, reason: 'still sends' },
      { confirmInFlightDrained: lanes },
    )
    assert.match(drainOnly.plan.blockedBy?.reason ?? '', /still sends/)
    const noGetChain = await run(
      { unread: 'pass getChain', attestable: false },
      { confirmRemoteOutboundStopped: lanes, confirmInFlightDrained: lanes },
    )
    assert.match(noGetChain.plan.blockedBy?.reason ?? '', /pass getChain/)
    const attested = await run(
      { unread: 'getChain could not serve it', attestable: true },
      { confirmRemoteOutboundStopped: lanes, confirmInFlightDrained: lanes },
    )
    assert.equal(attested.plan.blockedBy, undefined)
    assert.deepEqual(
      attested.ready.map((s) => s.step.name),
      ['dropChainsAndCloseLanes'],
    )
  })

  it('the remote stop from a read: delisted, standard pool (core reads), multi-token pool (R-minor 4)', () => {
    const known = (over: Record<string, unknown>) =>
      ({
        status: 'known',
        registryPool: POOL,
        readsLongData: false,
        legacyFromMultiTokenPools: [],
        ...over,
      }) as never
    const bucket = (capacity: bigint, rate: bigint) => ({ tokens: 0n, capacity, rate })
    assert.deepEqual(remoteStopOf(known({ registryPool: null })), { stopped: true })
    // a standard pool: no chain config toward us, or a 0/0 limiter, is stopped; else it sends
    assert.deepEqual(remoteStopOf(known({})), { stopped: true })
    assert.deepEqual(remoteStopOf(known({ back: { outbound: bucket(0n, 0n) } })), { stopped: true })
    // a disabled limiter (null) lets everything through: it sends
    const open = remoteStopOf(known({ back: { outbound: null } }))
    assert.ok('stopped' in open && !open.stopped)
    const sends = remoteStopOf(known({ back: { outbound: bucket(10n, 1n) } }))
    assert.ok(
      'stopped' in sends && !sends.stopped,
      'a standard pool with a live limiter is read as sending, not attestable',
    )
    // a multi-token pool: exists false is not stopped; paused is
    const lane = (over: Record<string, unknown>) =>
      ({
        exists: true,
        outboundStatus: { status: 'ok' },
        stopped: { outbound: false },
        ...over,
      }) as never
    const mttp = known({ readsLongData: true })
    assert.equal(
      (remoteStopOf(mttp, lane({ exists: false })) as { stopped: boolean }).stopped,
      false,
    )
    assert.deepEqual(remoteStopOf(mttp, lane({ outboundStatus: { status: 'paused' } })), {
      stopped: true,
    })
    assert.ok('unread' in remoteStopOf({ status: 'unknown', reason: 'x' } as never))
  })

  it('Squads: the pause split ids are stable (by the inbound flag, not by position)', () => {
    const ms = mints(1)
    const input = leaving(ms)
    input.tokens[0]!.lanes.push({
      ...input.tokens[0]!.lanes[0]!,
      key: { tokenAddress: ms[0]!, remoteChainSelector: 1n },
      ownInboundPaused: true,
    })
    const x = expandRemovalFrom(ctxOf([], 'r1', true), removal(ms), input, () =>
      Promise.resolve({ stopped: true }),
    )
    assert.deepEqual(
      x.specs.filter((s) => s.step.name === 'pauseLaneOutbound').map((s) => s.step.id),
      [
        id('setPoolGroupLanePause', ms[0]!, 'inbound-paused'),
        id('setPoolGroupLanePause', ms[0]!, 'inbound-open'),
      ],
    )
  })
})

describe('the plan reports what vanished from the pending set', () => {
  it('a pending id no longer planned is listed in vanishedPendingSteps', async () => {
    const ms = mints(1)
    const ctx = ctxOf([pauseId()])
    const plan = await evaluatePlan(
      ctx,
      () =>
        Promise.resolve(
          expandOnboardingFrom(
            ctx,
            onboardParams(ms),
            inputs(stateOf(record({ drivenLanesPaused: true }), [], [], ms)),
          ),
        ),
      { pendingStepHashes: { gone: '0x00' } },
    )
    assert.deepEqual(plan.plan.vanishedPendingSteps, ['gone'])
    assert.equal(plan.plan.runId, 'r1')
    void PublicKey
  })
})
