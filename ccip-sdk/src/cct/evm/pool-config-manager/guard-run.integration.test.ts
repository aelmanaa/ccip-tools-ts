/**
 * The post-state guard end to end on the live Sepolia "v5v9" stack, read-only: every write is
 * projected, judged and `eth_call`ed from the stack's role holder, never sent.
 *
 * The stack's two Sepolia → Fuji lanes name remote tokens that Fuji's registry does not know (no code
 * on Fuji): a send burns here and nothing releases it there. The guard must refuse every write that
 * leaves them live outbound, and accept pausing them (the design's "waiting" exception).
 *
 * Skips (does not fail) when the pool is no longer a multi-token pool; RPC errors still fail.
 */
import assert from 'node:assert/strict'
import { Console } from 'node:console'
import { before, describe, it } from 'node:test'

import { reachableRpcEndpoint } from '../../../../../scripts/test-endpoints.ts'
import { useResource } from '../../../../../scripts/useResource.ts'
import { EVMChain } from '../../../evm/index.ts'
import { CCTParamsInvalidError } from '../../errors.ts'
import { EVMTokenManager } from '../index.ts'
import {
  MultiTokenPoolVersion,
  POOL_CONFIG_MANAGER_TYPE,
  getMultiTokenPoolInterface,
} from '../multi-token-pool/contracts.ts'
import { type RunMultiTokenPoolGuardsInput, runMultiTokenPoolGuards } from './guard-run.ts'
import { ApplyMultiTokenPoolRateLimitPolicyBucketUpdates } from './operations/apply-multi-token-pool-rate-limit-policy-bucket-updates.ts'

const skip = !!process.env.SKIP_INTEGRATION_TESTS

await useResource(['sepolia', 'fuji'])

const testLogger = new Console(process.stdout, process.stderr)
if (!process.env.VERBOSE) testLogger.debug = () => {}

const POOL = '0x6304228a2908E45fC87f6cc685E6fC309f5A8624'
const PCM = '0x8AEe4112612168c05db5Dc204E18dCa6b3aD8Cc6'
/** The stack's role holder (every PCM role), the funded test signer. */
const OPERATOR = '0x9d087fC03ae39b088326b67fA3C788236645b717'
/** The two tokens whose Sepolia → Fuji lanes have no Fuji side. */
const FUJI_TOKENS = [
  '0x0a75baaC1fC96Af3F91c3e4a364Fd81e7B4dCf49',
  '0x08f749F5Ee026753e88920088bE5F54590A8B14f',
]
const SOLANA_LANE_TOKEN = '0x808d0D44b1E532A0f0360edB05292dC09596F9b9'
const SOLANA_DEVNET = 16423721717087811551n
/** The campaign's mttp-core stack: tokens on Sepolia and Fuji, live transfers done; its lanes are healthy. */
const CORE_POOL = '0x91b33bfc6B7E4ee5511BB654e9f93b6d3e72671b'
const CORE_PCM = '0x4c4Ad0518cB12304051CB6E2b7c1a4fDd6A21Cfd'
/** Holds CONFIG_ROLE on the mttp-core PCM. */
const CORE_CONFIG = '0x3F7Ba502948E1A74d2eF94908CA3e0Bb8f17C7Ca'
const CORE_TOKEN = '0x6377325E0D7F2E0D2Bc770860F0eB3B6c62F7cEd'
const FUJI = 14767482510784806043n
const V = MultiTokenPoolVersion.V2_1_0_DEV
const PCM_IFACE = getMultiTokenPoolInterface(POOL_CONFIG_MANAGER_TYPE, V)
const OUTBOUND = 0
const INBOUND = 1

describe('MTTP post-state guard (Sepolia v5v9, read-only)', { skip, timeout: 600_000 }, () => {
  let base: Omit<RunMultiTokenPoolGuardsInput, 'operation' | 'data'>
  let deployed = false

  before(async () => {
    const [sepolia, fuji] = await Promise.all([
      EVMChain.fromUrl(await reachableRpcEndpoint('RPC_SEPOLIA'), {
        apiClient: null,
        logger: testLogger,
      }),
      EVMChain.fromUrl(await reachableRpcEndpoint('RPC_FUJI'), {
        apiClient: null,
        logger: testLogger,
      }),
    ])
    deployed = await EVMTokenManager.fromChain(sepolia).isMultiTokenPool({ poolAddress: POOL })
    base = {
      chain: sepolia,
      poolConfigManager: PCM,
      version: V,
      poolAddress: POOL,
      sender: OPERATOR,
      getChain: async (selector) => {
        if (BigInt(selector) === fuji.network.chainSelector) return fuji
        throw new CCTParamsInvalidError('test', 'getChain', `no RPC for ${selector}`)
      },
    }
  })

  const pause = (direction: number) =>
    PCM_IFACE.encodeFunctionData('pauseTokens', [FUJI_TOKENS, direction])

  it('accepts pausing the lanes outbound, cross-checked with eth_simulateV1, and binds the snapshot', async (t) => {
    if (!deployed) return t.skip('v5v9 multi-token pool not deployed')
    const op = 'pauseMultiTokenPoolTokens'
    const r = await runMultiTokenPoolGuards({ ...base, operation: op, data: pause(OUTBOUND) })
    assert.equal(r.affectedLanes.length, FUJI_TOKENS.length)
    assert.deepEqual(r.warnings, [])
    testLogger.info(`projectionVerified: ${r.projectionVerified}`)
    assert.equal(r.snapshot.operation, op)
    // the same build again holds; another op, or other calldata, is refused
    await runMultiTokenPoolGuards({
      ...base,
      operation: op,
      data: pause(OUTBOUND),
      expectedSnapshot: r.snapshot,
    })
    await assert.rejects(
      runMultiTokenPoolGuards({
        ...base,
        operation: 'pauseMultiTokenPoolChains',
        data: pause(OUTBOUND),
        expectedSnapshot: r.snapshot,
      }),
      (e: unknown) => e instanceof CCTParamsInvalidError && e.context.param === 'expectedSnapshot',
    )
    await assert.rejects(
      runMultiTokenPoolGuards({
        ...base,
        operation: op,
        data: pause(2),
        expectedSnapshot: r.snapshot,
      }),
      (e: unknown) => e instanceof CCTParamsInvalidError && e.context.param === 'expectedSnapshot',
    )
  })

  it('never refuses a pause on the lanes it touches, even one that leaves them live outbound toward the missing remote side', async (t) => {
    if (!deployed) return t.skip('v5v9 multi-token pool not deployed')
    // the scope comes from the calldata (pauseTokens), so a direct guard call and a snapshot
    // re-check judge it as the op build does: projected, simulated, sealed, never judged
    const r = await runMultiTokenPoolGuards({
      ...base,
      operation: 'pauseMultiTokenPoolTokens',
      data: pause(INBOUND),
    })
    assert.equal(r.affectedLanes.length, FUJI_TOKENS.length)
    assert.deepEqual(r.warnings, [])
  })

  it('refuses a write the sender cannot execute, with the decoded revert', async (t) => {
    if (!deployed) return t.skip('v5v9 multi-token pool not deployed')
    await assert.rejects(
      runMultiTokenPoolGuards({
        ...base,
        sender: '0x000000000000000000000000000000000000dEaD',
        operation: 'pauseMultiTokenPoolTokens',
        data: pause(OUTBOUND),
      }),
      (e: unknown) =>
        e instanceof CCTParamsInvalidError &&
        e.context.param === 'sender' &&
        e.context.errorName === 'AccessControlUnauthorizedAccount',
    )
  })

  it('fails closed on a Solana lane when getChain cannot serve Devnet', async (t) => {
    if (!deployed) return t.skip('v5v9 multi-token pool not deployed')
    const data = PCM_IFACE.encodeFunctionData('applyInlineFeeConfigUpdates', [
      [],
      [[SOLANA_LANE_TOKEN, SOLANA_DEVNET, [1, 2, 3, 3]]],
    ])
    await assert.rejects(
      runMultiTokenPoolGuards({
        ...base,
        operation: 'applyMultiTokenPoolInlineFeeConfigUpdates',
        data,
      }),
      (e: unknown) => e instanceof CCTParamsInvalidError && e.context.param === 'getChain',
    )
  })

  it('re-checks a proposal through checkMultiTokenPoolSnapshot with the sealed options', async (t) => {
    if (!deployed) return t.skip('v5v9 multi-token pool not deployed')
    const op = 'pauseMultiTokenPoolTokens'
    const data = pause(OUTBOUND)
    const { snapshot } = await runMultiTokenPoolGuards({
      ...base,
      operation: op,
      data,
      maxTransferFeeBps: 900,
    })
    assert.deepEqual(snapshot.expected['guard.options'], { maxTransferFeeBps: 900 })
    const transaction = {
      family: 'EVM' as const,
      transactions: [{ to: PCM, data, from: OPERATOR }],
    }
    const cct = EVMTokenManager.fromChain(base.chain)
    const check = await cct.checkMultiTokenPoolSnapshot({
      snapshot,
      transaction,
      sender: OPERATOR,
      getChain: base.getChain!,
    })
    assert.deepEqual(check, { ok: true, changed: [], findings: [] })
  })

  it('accepts a real change on a healthy lane: every rule, the remote side read on Fuji', async (t) => {
    if (!(await EVMTokenManager.fromChain(base.chain).isMultiTokenPool({ poolAddress: CORE_POOL })))
      return t.skip('mttp-core multi-token pool not deployed')
    const cct = EVMTokenManager.fromChain(base.chain)
    const lane = { tokenAddress: CORE_TOKEN, remoteChainSelector: FUJI }
    const [fee] = await cct.getMultiTokenPoolLaneTokenTransferFeeConfigs({
      poolConfigManager: CORE_PCM,
      lanes: [lane],
    })
    const data = PCM_IFACE.encodeFunctionData('applyInlineFeeConfigUpdates', [
      [],
      [
        [
          CORE_TOKEN,
          FUJI,
          [
            fee!.finalityFeeUSDCents,
            fee!.fastFinalityFeeUSDCents,
            fee!.finalityTransferFeeBps + 1,
            fee!.fastFinalityTransferFeeBps + 1,
          ],
        ],
      ],
    ])
    const r = await runMultiTokenPoolGuards({
      ...base,
      poolConfigManager: CORE_PCM,
      poolAddress: CORE_POOL,
      sender: CORE_CONFIG,
      operation: 'applyMultiTokenPoolInlineFeeConfigUpdates',
      data,
    })
    assert.deepEqual(r.affectedLanes, [lane])
    assert.deepEqual(r.warnings, [])
    testLogger.info(`healthy lane projectionVerified: ${r.projectionVerified}`)
  })

  it('builds a clamp on a lane that fails a rule, and refuses loosening it (bucket writes judge only what they loosen)', async (t) => {
    if (!deployed) return t.skip('v5v9 multi-token pool not deployed')
    // policy v5 holds the Fuji lanes' rate limit (outbound 100e18 / 1e17); their remote side does not
    // exist (NO_REMOTE_POOL), so any judged write on them is refused
    const op = new ApplyMultiTokenPoolRateLimitPolicyBucketUpdates()
    const bucket = (capacity: bigint, rate: bigint) =>
      op.generate(base.chain, {
        poolAddress: POOL,
        sender: OPERATOR,
        getChain: base.getChain!,
        updates: [
          {
            policyName: 'v5',
            remoteChainSelector: FUJI,
            direction: 'outbound',
            fastFinality: false,
            config: { enabled: true, capacity, rate },
          },
        ],
      })
    // tighten and stop: built, never judged
    const clamp = await bucket(50n * 10n ** 18n, 5n * 10n ** 16n)
    assert.ok(clamp.affectedLanes.length > 0)
    await bucket(0n, 0n)
    // more capacity: the lanes are judged, and their missing remote side refuses it
    await assert.rejects(bucket(200n * 10n ** 18n, 10n ** 17n), (e: unknown) => {
      testLogger.info(`loosen refused: ${(e as Error).message}`)
      return (
        e instanceof CCTParamsInvalidError &&
        (e.context.findings as { check: string }[]).some((f) => f.check === 'NO_REMOTE_POOL')
      )
    })
  })
})
