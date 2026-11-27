/**
 * Unit tests of the shared planners on Solana (S6): the ready-step engine, the unpause rule, the
 * runner (virtual steps, actor blocks, the signed loop) and the §4.1 runtime refusals.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Keypair, PublicKey } from '@solana/web3.js'

import '../../../../index.ts'
import { networkInfo } from '../../../../networks.ts'
import type { SolanaChain } from '../../../../solana/index.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import type { Expansion, PlannerContext, StepSpec } from './context.ts'
import { parseEnablement } from './enable-chain.ts'
import { planStep, resolveActor, selectReady, stepsConflict, unpauseDecision } from './engine.ts'
import { memberRemoteTokensOf, parseOnboarding } from './onboard.ts'
import { parseRemoval } from './remove-token.ts'
import { evaluatePlan, executeFlow } from './run.ts'

const SEPOLIA = networkInfo('ethereum-testnet-sepolia').chainSelector
const BASE = networkInfo('ethereum-testnet-sepolia-base-1').chainSelector
const mint = () => Keypair.generate().publicKey.toBase58()
const PAYER = Keypair.generate().publicKey.toBase58()
const GROUP = Keypair.generate().publicKey.toBase58()

const step = (id: string, extra: Partial<Parameters<typeof planStep<string>>[0]> = {}) =>
  planStep<string>({
    id,
    name: id,
    operation: 'op',
    summary: id,
    inputs: { id },
    writeSet: [],
    guardReads: [],
    signer: { kind: 'anyone', address: PAYER },
    ...extra,
  })

const isParam = (param: string) => (e: unknown) =>
  e instanceof CCTParamsInvalidError && e.context.param === param

describe('ready-step engine', () => {
  it('a write meeting a write or a guard read conflicts; disjoint steps commute', () => {
    const a = step('a', { writeSet: ['k'] })
    assert.equal(stepsConflict(a, step('b', { writeSet: ['k'] })), true)
    assert.equal(stepsConflict(a, step('c', { guardReads: ['k'] })), true)
    assert.equal(stepsConflict(step('d', { guardReads: ['k'] }), a), true)
    assert.equal(stepsConflict(a, step('e', { writeSet: ['j'], guardReads: ['i'] })), false)
  })

  it('ready = dependencies landed, not pending, no conflict with another ready one; maxReadySteps holds back', () => {
    const steps = [
      step('a', { writeSet: ['x'] }),
      step('b', { writeSet: ['x'] }), // conflicts with a
      step('c', { dependsOn: ['a'] }), // waits for a
      step('d', { writeSet: ['y'] }),
      step('e', { writeSet: ['z'] }),
    ]
    const all = selectReady(steps, { maxReadySteps: Infinity })
    assert.deepEqual(
      all.ready.map((s) => s.id),
      ['a', 'd', 'e'],
    )
    const capped = selectReady(steps, { maxReadySteps: 2 })
    assert.deepEqual(
      capped.ready.map((s) => s.id),
      ['a', 'd'],
    )
    assert.equal(capped.moreReady, 1)
  })

  it('a pending step holds its resources; a moved pending step is stale', () => {
    const a = step('a', { writeSet: ['x'] })
    const b = step('b', { writeSet: ['x'] })
    const r = selectReady([a, b], {
      maxReadySteps: Infinity,
      pendingStepHashes: { a: a.inputsHash, zz: 'gone' },
    })
    assert.deepEqual(r.pendingSteps, ['a'])
    assert.deepEqual(r.ready, [])
    const moved = selectReady([a], { maxReadySteps: 5, pendingStepHashes: { a: '0xold' } })
    assert.equal(moved.stalePendingSteps[0]?.id, 'a')
  })

  it('inputsHash is canonical: key order does not matter', () => {
    const x = planStep({ ...step('a'), inputs: { b: 1n, a: [1, 2] } })
    const y = planStep({ ...step('a'), inputs: { a: [1, 2], b: 1n } })
    assert.equal(x.inputsHash, y.inputsHash)
  })

  it('actors: matcher list, record, resolver, else the fallback', () => {
    const signer = { kind: 'pool-owner' as const, tokenAddress: 'T' }
    assert.equal(
      resolveActor([{ kind: 'pool-owner', tokenAddress: 'T', address: 'A' }], signer, 'F'),
      'A',
    )
    assert.equal(resolveActor({ 'pool-owner': 'B' }, signer, 'F'), 'B')
    assert.equal(
      resolveActor(() => undefined, signer, 'F'),
      'F',
    )
    assert.equal(resolveActor(undefined, { ...signer, address: 'S' }, 'F'), 'S')
  })
})

describe('the unpause rule (A16, OC2)', () => {
  it("lifts only this run's own pause: planned, or landed (memory or landedStepIds)", () => {
    const id = 'net/g/pausePoolGroupChainLanes/1'
    assert.deepEqual(
      unpauseDecision({ pauseStepId: id, pausePlanned: true, landed: new Set(), what: 'x' }),
      {
        lift: true,
        dependsOn: [id],
      },
    )
    assert.deepEqual(
      unpauseDecision({ pauseStepId: id, pausePlanned: false, landed: new Set([id]), what: 'x' }),
      {
        lift: true,
        dependsOn: [],
      },
    )
    const foreign = unpauseDecision({
      pauseStepId: id,
      pausePlanned: false,
      landed: new Set(),
      what: 'x',
    })
    assert.equal(foreign.lift, false)
    assert.ok(!foreign.lift && foreign.block.steps?.includes(id))
    assert.ok(!foreign.lift && /landedStepIds/.test(foreign.block.reason))
  })
})

/** A context over no chain: the runner tests never read one. */
function ctxOf(actor = PAYER): PlannerContext {
  return {
    operation: 'test',
    chain: { network: networkInfo('solana-devnet') } as unknown as SolanaChain,
    ref: { program: Keypair.generate().publicKey, group: new PublicKey(GROUP) },
    payer: PAYER,
    actor,
    landed: new Set(),
    squads: false,
  }
}

describe('the runner', () => {
  it('a virtual check runs once its dependencies landed; a refusal blocks what depends on it', async () => {
    let checks = 0
    const check: StepSpec<string> = {
      step: step('check', { dependsOn: ['w'] }),
      evaluate: () => {
        checks++
        return Promise.resolve({ reason: 'refused' })
      },
    }
    const unpause: StepSpec<string> = {
      step: step('unpause', { dependsOn: ['check'] }),
      run: noRun(),
    }
    const expand = (specs: StepSpec<string>[]) => () =>
      Promise.resolve<Expansion<string>>({ specs, findings: [], observedAt: 1n })
    const first = await evaluatePlan(
      ctxOf(),
      expand([{ step: step('w'), run: noRun() }, check, unpause]),
      {},
    )
    assert.equal(checks, 0)
    assert.deepEqual(
      first.ready.map((s) => s.step.id),
      ['w'],
    )
    const after = await evaluatePlan(ctxOf(), expand([check, unpause]), { maxReadySteps: 5 })
    assert.equal(checks, 1)
    assert.deepEqual(after.ready, [])
    assert.equal(after.plan.blockedBy?.reason, 'refused')
  })

  it('a passing check counts as landed: the step after it is ready', async () => {
    const r = await evaluatePlan(
      ctxOf(),
      () =>
        Promise.resolve({
          specs: [
            { step: step('check'), evaluate: () => Promise.resolve(null) },
            { step: step('unpause', { dependsOn: ['check'] }), run: noRun() },
          ],
          findings: [],
          observedAt: 1n,
        }),
      {},
    )
    assert.deepEqual(
      r.ready.map((s) => s.step.id),
      ['unpause'],
    )
  })

  it('signed: a step of another actor is never attempted and comes back in blockedBy.actor', async () => {
    const other = Keypair.generate().publicKey.toBase58()
    const r = await evaluatePlan(
      ctxOf(),
      () =>
        Promise.resolve({
          specs: [
            { step: step('x', { signer: { kind: 'pool-owner', address: other } }), run: noRun() },
          ],
          findings: [],
          observedAt: 1n,
        }),
      {},
      PAYER,
    )
    assert.deepEqual(r.ready, [])
    assert.equal(r.plan.blockedBy?.actor?.address, other)
  })

  it('signed loop: lands, records landed ids, calls onStep, re-plans until empty', async () => {
    const ctx = ctxOf()
    const remaining = ['a', 'b']
    const seen: string[] = []
    const wallet = { publicKey: new PublicKey(PAYER), signTransaction: () => undefined }
    const r = await executeFlow(
      ctx,
      () =>
        Promise.resolve({
          specs: remaining.map((id) => ({
            step: step(id),
            run: {
              generate: () => Promise.reject(new Error('unsigned')),
              execute: () => {
                remaining.splice(remaining.indexOf(id), 1)
                return Promise.resolve({ hashes: [`h-${id}`], findings: [] })
              },
            },
          })),
          findings: [],
          observedAt: 1n,
        }),
      { onStep: (s) => void seen.push(s.id) },
      wallet as never,
    )
    assert.deepEqual(
      r.steps.map((s) => s.id),
      ['a', 'b'],
    )
    assert.deepEqual(seen, ['a', 'b'])
    assert.deepEqual([...ctx.landed], ['a', 'b'])
    assert.equal(r.blockedBy, undefined)
  })
})

/** A run that is never called. */
function noRun(): NonNullable<StepSpec<string>['run']> {
  return {
    generate: () => Promise.reject(new Error('not built')),
    execute: () => Promise.reject(new Error('not landed')),
  }
}

describe('§4.1 runtime refusals (Solana)', () => {
  const ref = { poolGroupAddress: GROUP }
  const remoteChain = {
    remoteChainSelector: SEPOLIA,
    remotePools: [
      { address: '0x2222222222222222222222222222222222222222', allowLegacyPoolData: false },
    ],
    rateLimits: {
      outbound: { enabled: false },
      inbound: { enabled: false },
      fastFinalityOutbound: { enabled: false },
      fastFinalityInbound: { enabled: false },
    },
    tokenTransferFeeConfig: {
      destGasOverhead: 200_000,
      destBytesOverhead: 192,
      finalityFeeUSDCents: 0,
      fastFinalityFeeUSDCents: 0,
      finalityTransferFeeBps: 0,
      fastFinalityTransferFeeBps: 0,
      isEnabled: true,
    },
  } as const
  const enable = (extra: Record<string, unknown>) =>
    parseEnablement({
      ...ref,
      remoteChain,
      tokenAddresses: 'all-members',
      payer: PAYER,
      ...extra,
    } as never)

  it("refuses the other family's literal, a string policy and a non-admitted remote token", () => {
    assert.throws(() => enable({ tokenAddresses: 'all-policy-tokens' }), isParam('tokenAddresses'))
    assert.throws(() => enable({ policy: 'standard' }), isParam('policy'))
    assert.throws(
      () =>
        enable({
          tokenAddresses: [mint()],
          remoteTokens: [
            {
              tokenAddress: mint(),
              remoteTokenAddress: '0x1111111111111111111111111111111111111111',
              remoteTokenDecimals: 18,
            },
          ],
        }),
      isParam('remoteTokens[0].tokenAddress'),
    )
    assert.equal(enable({}).parsed.tokens, 'all-members')
  })

  it("refuses the other family's extension and signer (undefined counts as absent)", () => {
    const tokens = [{ tokenAddress: mint(), remoteTokens: [] }]
    assert.throws(
      () =>
        parseOnboarding({ ...ref, tokens: [{ ...tokens[0]!, evm: {} }], payer: PAYER } as never),
      isParam('tokens[0].evm'),
    )
    assert.ok(
      parseOnboarding({
        ...ref,
        tokens: [{ ...tokens[0]!, evm: undefined }],
        payer: PAYER,
      } as never),
    )
  })

  it('onboarding: a fresh pool group id with solana.create, refused without; repeated chains refused', () => {
    const t = { tokenAddress: mint(), remoteTokens: [] }
    const created = parseOnboarding({ tokens: [t], solana: { create: {} }, payer: PAYER })
    assert.ok(created.parsed.poolGroupId)
    assert.throws(() => parseOnboarding({ tokens: [t], payer: PAYER }), isParam('poolGroupAddress'))
    const r = {
      remoteChainSelector: SEPOLIA,
      remoteTokenAddress: '0x1111111111111111111111111111111111111111',
      remoteTokenDecimals: 18,
    }
    assert.throws(
      () =>
        parseOnboarding({
          ...ref,
          tokens: [{ tokenAddress: mint(), remoteTokens: [r, r] }],
          payer: PAYER,
        }),
      isParam('tokens[0].remoteTokens[1].remoteChainSelector'),
    )
    assert.throws(
      () =>
        parseOnboarding({
          ...ref,
          tokens: [t],
          solana: {
            create: { chains: [{ remoteChainSelector: SEPOLIA, laneMode: 'all-members' }] },
          },
          payer: PAYER,
        }),
      isParam('solana.create.chains[0].sections'),
    )
  })

  it('member remote tokens: chains of one family with the same token share an entry', () => {
    const tok = '0x1111111111111111111111111111111111111111'
    assert.deepEqual(
      memberRemoteTokensOf([
        { selector: SEPOLIA, token: tok, decimals: 18 },
        { selector: BASE, token: tok.toUpperCase().replace('0X', '0x'), decimals: 18 },
      ]).map((e) => e.remoteChainSelectors),
      [[SEPOLIA, BASE]],
    )
  })

  it('removal: chains and drain confirmations are parsed; repeats refused', () => {
    const tokenAddress = mint()
    const r = parseRemoval({
      ...ref,
      tokenAddress,
      payer: PAYER,
      solana: { confirmInFlightDrained: [{ tokenAddress, remoteChainSelector: SEPOLIA }] },
    })
    assert.ok(r.parsed.confirmed.has(`${tokenAddress}:${SEPOLIA}`))
    assert.throws(
      () =>
        parseRemoval({
          ...ref,
          tokenAddress,
          payer: PAYER,
          solana: { remoteChainSelectors: [SEPOLIA, SEPOLIA] },
        }),
      isParam('solana.remoteChainSelectors'),
    )
  })
})
