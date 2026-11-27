/**
 * Lane stops end to end on an anvil fork of Sepolia, signed by impersonated role holders of the
 * live MTTP stacks: a stop and its lift restore an inline lane exactly from the stop's snapshot,
 * and a policy lane from chain state (back on its policy); on the "v5v9" lane whose Fuji side does
 * not exist, a stop still goes through (it only tightens) and its lift is refused (`NO_REMOTE_POOL`).
 * The remote side is read live on Fuji.
 */

import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { Console } from 'node:console'
import { type AddressInfo, createServer } from 'node:net'
import { after, before, describe, it } from 'node:test'

import type { JsonRpcProvider } from 'ethers'
import { Instance } from 'prool'

import { reachableRpcEndpoint, rpcEndpoint } from '../../../../../../scripts/test-endpoints.ts'
import type { ChainGetter } from '../../../../chain.ts'
import {
  forkProvider,
  rejectionOf,
  withForkRetry,
} from '../../../../evm/fork-retry.test.helpers.ts'
import { EVMChain } from '../../../../evm/index.ts'
import { canonicalHash } from '../../../canonical.ts'
import {
  CCTParamsInvalidError,
  CCTStateChangedError,
  CCTTxNotConfirmedError,
} from '../../../errors.ts'
import type { RateLimitConfig } from '../../../rate-limit.ts'
import { EVMTokenManager } from '../../index.ts'
import { noteMinedBlock } from '../../mined-block.ts'
import { ApplyMultiTokenPoolInlineRateLimitBucketUpdates } from './apply-multi-token-pool-inline-rate-limit-bucket-updates.ts'
import { ApplyMultiTokenPoolRateLimitPolicyBucketUpdates } from './apply-multi-token-pool-rate-limit-policy-bucket-updates.ts'
import { mined as minedOn } from './fork.test.helpers.ts'
import {
  LiftMultiTokenPoolLaneStops,
  StopMultiTokenPoolLanes,
} from './stop-multi-token-pool-lanes.ts'

/** A port the OS reports free right now (the fork binds it immediately after). */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise((resolve) => server.close(resolve))
  return port
}

function isAnvilAvailable(): boolean {
  try {
    execSync('anvil --version', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const skip = !!process.env.SKIP_INTEGRATION_TESTS || !isAnvilAvailable()
const testLogger = new Console(process.stdout, process.stderr)

const FUJI = 14767482510784806043n
const CORE_POOL = '0x91b33bfc6B7E4ee5511BB654e9f93b6d3e72671b'
const CORE_CONFIG = '0x3F7Ba502948E1A74d2eF94908CA3e0Bb8f17C7Ca' // CONFIG_ROLE on mttp-core
const INLINE_TOKEN = '0x6377325E0D7F2E0D2Bc770860F0eB3B6c62F7cEd' // inline rate limit record
const POLICY_TOKEN = '0x3bb6c12433D96771B2B7B1c3D0Bbe27879e12d17' // rate limit policy core-pol
const V5V9_POOL = '0x6304228a2908E45fC87f6cc685E6fC309f5A8624'
const V5V9_OPERATOR = '0x9d087fC03ae39b088326b67fA3C788236645b717'
const V5V9_FUJI_TOKEN = '0x0a75baaC1fC96Af3F91c3e4a364Fd81e7B4dCf49' // Fuji side missing

describe('MTTP lane stops (Sepolia fork)', { skip, timeout: 600_000 }, () => {
  let instance: ReturnType<typeof Instance.anvil> | undefined
  let chain: EVMChain
  let fuji: EVMChain
  let cct: EVMTokenManager
  let getChain: ChainGetter
  let deployed = false
  const stop = new StopMultiTokenPoolLanes()
  const lift = new LiftMultiTokenPoolLaneStops()

  before(async () => {
    instance = Instance.anvil(
      {
        forkUrl: rpcEndpoint('RPC_SEPOLIA'),
        chainId: 11155111,
        // a free port: several sessions run these forks on one machine, a fixed one collides
        port: await freePort(),
        retries: 8,
        timeout: 15_000,
        forkRetryBackoff: 1_000,
      },
      {},
    )
    await instance.start()
    const provider = await forkProvider(instance, { logger: testLogger })
    chain = await EVMChain.fromProvider(provider, { apiClient: null, logger: testLogger })
    fuji = await EVMChain.fromUrl(await reachableRpcEndpoint('RPC_FUJI'), {
      apiClient: null,
      logger: testLogger,
    })
    getChain = async () => fuji
    cct = EVMTokenManager.fromChain(chain)
    deployed = await cct.isMultiTokenPool({ poolAddress: CORE_POOL })
    for (const account of [CORE_CONFIG, V5V9_OPERATOR]) {
      await provider.send('anvil_impersonateAccount', [account])
      await provider.send('anvil_setBalance', [account, '0x56BC75E2D63100000'])
    }
  })

  after(async () => {
    chain.provider.destroy()
    fuji.provider.destroy()
    await instance?.stop()
  })

  const signer = (account: string) => (chain.provider as JsonRpcProvider).getSigner(account)
  const laneView = async (poolAddress: string, tokenAddress: string) => {
    const { sources, stopped, rateLimits } = await withForkRetry(() =>
      cct.getMultiTokenPoolLane({ poolAddress, tokenAddress, remoteChainSelector: FUJI }),
    )
    return { sources: sources.rateLimit, stopped, rateLimits }
  }
  /**
   * Asserts a build is refused as `expected` says. An upstream fork error is retried (it is never a
   * test failure); only the SDK's own refusal is judged.
   */
  const refused = async (build: () => Promise<unknown>, expected: (e: unknown) => boolean) =>
    assert.ok(expected(await withForkRetry(() => rejectionOf(build(), 'expected a refusal'))))
  const mined = async (write: Promise<{ hash: string }>) =>
    assert.equal(await minedOn(chain.provider as JsonRpcProvider, write), 1)

  it("restores an inline lane exactly from the stop's snapshot", async (t) => {
    if (!deployed) return t.skip('mttp-core not deployed')
    const lanes = [{ tokenAddress: INLINE_TOKEN, remoteChainSelector: FUJI }]
    const before = await laneView(CORE_POOL, INLINE_TOKEN)
    const built = await stop.generate(chain, {
      poolAddress: CORE_POOL,
      lanes,
      direction: 'outbound',
      sender: CORE_CONFIG,
    })
    const wallet = await signer(CORE_CONFIG)
    await mined(
      stop.execute(chain, {
        poolAddress: CORE_POOL,
        lanes,
        direction: 'outbound',
        wallet,
        expectedSnapshot: built.snapshot,
      }),
    )
    assert.deepEqual((await laneView(CORE_POOL, INLINE_TOKEN)).stopped, {
      outbound: true,
      inbound: false,
    })
    await mined(
      lift.execute(chain, {
        poolAddress: CORE_POOL,
        lanes,
        direction: 'outbound',
        wallet,
        getChain,
        restore: built.snapshot,
      }),
    )
    assert.deepEqual(await laneView(CORE_POOL, INLINE_TOKEN), before)
  })

  it('lifts a policy lane from chain state: the inline record goes, the policy applies again', async (t) => {
    if (!deployed) return t.skip('mttp-core not deployed')
    const lanes = [{ tokenAddress: POLICY_TOKEN, remoteChainSelector: FUJI }]
    const before = await laneView(CORE_POOL, POLICY_TOKEN)
    assert.equal(before.sources.kind, 'policy')
    const wallet = await signer(CORE_CONFIG)
    await mined(
      stop.execute(chain, { poolAddress: CORE_POOL, lanes, direction: 'outbound', wallet }),
    )
    const stopped = await laneView(CORE_POOL, POLICY_TOKEN)
    // the stop holds outbound, and copies inbound from the policy
    assert.equal(stopped.sources.kind, 'inline')
    assert.deepEqual(stopped.rateLimits.inbound, before.rateLimits.inbound)
    await mined(
      lift.execute(chain, {
        poolAddress: CORE_POOL,
        lanes,
        direction: 'outbound',
        wallet,
        getChain,
      }),
    )
    assert.deepEqual(await laneView(CORE_POOL, POLICY_TOKEN), before)
  })

  it('stops a lane whose remote side is missing, and refuses to lift it', async (t) => {
    if (!deployed) return t.skip('mttp-core not deployed')
    const lanes = [{ tokenAddress: V5V9_FUJI_TOKEN, remoteChainSelector: FUJI }]
    const wallet = await signer(V5V9_OPERATOR)
    // a stop only tightens: no lane rule refuses it, and it reads no remote fact (no getChain)
    await mined(
      stop.execute(chain, { poolAddress: V5V9_POOL, lanes, direction: 'outbound', wallet }),
    )
    await refused(
      () =>
        lift.generate(chain, {
          poolAddress: V5V9_POOL,
          lanes,
          direction: 'outbound',
          sender: V5V9_OPERATOR,
          getChain,
        }),
      (e: unknown) =>
        e instanceof CCTParamsInvalidError &&
        (e.context.findings as { check: string }[]).some((f) => f.check === 'NO_REMOTE_POOL'),
    )
  })

  it('lifts only the direction asked for: a lane stopped both ways keeps its other stop', async (t) => {
    if (!deployed) return t.skip('mttp-core not deployed')
    const lanes = [{ tokenAddress: POLICY_TOKEN, remoteChainSelector: FUJI }]
    const before = await laneView(CORE_POOL, POLICY_TOKEN)
    const wallet = await signer(CORE_CONFIG)
    const target = { poolAddress: CORE_POOL, lanes, wallet, getChain }
    await mined(stop.execute(chain, { ...target, direction: 'both' }))
    // from chain state, removing the inline record would lift inbound too: refused
    await refused(
      () =>
        lift.generate(chain, { poolAddress: CORE_POOL, lanes, direction: 'outbound', getChain }),
      (e: unknown) =>
        e instanceof CCTParamsInvalidError &&
        e.context.param === 'lanes[0]' &&
        /also stopped inbound/.test(e.message),
    )
    // with rateLimits, only outbound is taken from them: inbound stays stopped
    const open = { enabled: true, capacity: 10n ** 21n, rate: 10n ** 18n } as const
    await mined(
      lift.execute(chain, {
        ...target,
        direction: 'outbound',
        rateLimits: {
          outbound: open,
          inbound: open,
          fastFinalityOutbound: { enabled: false },
          fastFinalityInbound: { enabled: false },
        },
      }),
    )
    const half = await laneView(CORE_POOL, POLICY_TOKEN)
    assert.deepEqual(half.stopped, { outbound: false, inbound: true })
    // then inbound, from chain state: back on the policy, as before
    await mined(lift.execute(chain, { ...target, direction: 'inbound' }))
    const after = await laneView(CORE_POOL, POLICY_TOKEN)
    assert.equal(after.sources.kind, 'policy')
    assert.deepEqual(after, before)
  })

  it('R3 B1 repro: re-enabling fast-finality on a stopped broken lane is judged and refused', async (t) => {
    if (!deployed) return t.skip('mttp-core not deployed')
    const lane = { tokenAddress: V5V9_FUJI_TOKEN, remoteChainSelector: FUJI }
    const wallet = await signer(V5V9_OPERATOR)
    const bucket = new ApplyMultiTokenPoolInlineRateLimitBucketUpdates()
    const ftf = (config: RateLimitConfig) => ({
      poolAddress: V5V9_POOL,
      getChain,
      updates: [{ ...lane, direction: 'outbound' as const, fastFinality: true, config }],
    })
    // stop the lane outbound (both outbound buckets 0/0) unless an earlier case did
    if (!(await laneView(V5V9_POOL, V5V9_FUJI_TOKEN)).stopped.outbound)
      await mined(
        stop.execute(chain, {
          poolAddress: V5V9_POOL,
          lanes: [lane],
          direction: 'outbound',
          wallet,
        }),
      )
    // disabling the FTF bucket only makes FTF traffic use the stopped default bucket: still held
    await mined(bucket.execute(chain, { ...ftf({ enabled: false }), wallet }))
    assert.deepEqual((await laneView(V5V9_POOL, V5V9_FUJI_TOKEN)).stopped, {
      outbound: true,
      inbound: false,
    })
    // enabling it at 1e24 reopens FTF sends toward a chain with no pool: judged, refused
    await refused(
      () =>
        bucket.generate(chain, {
          ...ftf({ enabled: true, capacity: 10n ** 24n, rate: 10n ** 22n }),
          sender: V5V9_OPERATOR,
        }),
      (e: unknown) =>
        e instanceof CCTParamsInvalidError &&
        (e.context.findings as { check: string }[]).some((f) => f.check === 'NO_REMOTE_POOL'),
    )
  })

  it('binds the copied direction: a pending Safe stop goes stale when the policy moves under it (R1 M3)', async (t) => {
    if (!deployed) return t.skip('mttp-core not deployed')
    const lanes = [{ tokenAddress: POLICY_TOKEN, remoteChainSelector: FUJI }]
    // the proposal: an unsigned outbound stop, which copies inbound from the policy as it is now
    const built = await stop.generate(chain, {
      poolAddress: CORE_POOL,
      lanes,
      direction: 'outbound',
    })
    const policy = await withForkRetry(() =>
      cct.getMultiTokenPoolRateLimitPolicy({ poolAddress: CORE_POOL, policyName: 'core-pol' }),
    )
    const inbound = policy.records.find((r) => r.remoteChainSelector === FUJI)!.rateLimits.inbound
    assert.ok(inbound.enabled)
    // meanwhile the policy's inbound is clamped (a tightening: never judged)
    await mined(
      new ApplyMultiTokenPoolRateLimitPolicyBucketUpdates().execute(chain, {
        poolAddress: CORE_POOL,
        wallet: await signer(CORE_CONFIG),
        updates: [
          {
            policyName: 'core-pol',
            remoteChainSelector: FUJI,
            direction: 'inbound',
            fastFinality: false,
            config: { enabled: true, capacity: inbound.capacity / 2n, rate: inbound.rate / 2n },
          },
        ],
      }),
    )
    // executing the stop now would pin inbound back to the old, looser copy: the re-check says stale
    const check = await withForkRetry(() =>
      cct.checkMultiTokenPoolSnapshot({
        snapshot: built.snapshot,
        transaction: built,
        sender: CORE_CONFIG,
        getChain,
      }),
    )
    assert.equal(check.ok, false)
    assert.ok(check.changed.some((c) => c.path === 'guardInputsHash'))
  })

  it('an unpause judges only the lanes it makes live (R3 M2: token-paused lanes never block it)', async (t) => {
    if (!deployed) return t.skip('mttp-core not deployed')
    const wallet = await signer(V5V9_OPERATOR)
    // every registered token, some with lanes to Solana Devnet (which getChain cannot read)
    const { tokens } = await withForkRetry(() =>
      cct.getMultiTokenPoolConfiguredTokens({ poolAddress: V5V9_POOL }),
    )
    const v5 = { poolAddress: V5V9_POOL, wallet }
    await mined(cct.pauseMultiTokenPoolTokens({ ...v5, tokenAddresses: tokens, direction: 'both' }))
    await mined(cct.pauseMultiTokenPoolGlobally(v5))
    // every lane stays held by its token pause, so no lane goes live: nothing is judged, and a
    // getChain that serves only Fuji (no Devnet) is enough; before the fix, a Devnet lane that stays
    // paused refused it
    const unsigned = await cct.generateUnsignedUnpauseMultiTokenPoolGlobally({
      poolAddress: V5V9_POOL,
      sender: V5V9_OPERATOR,
      getChain,
    })
    assert.deepEqual(unsigned.goingLive, [])
    // lifting a broken lane's own token pause makes it live: judged, refused (0x08f7: its lane is
    // not stopped, unlike 0x0a75's after the B1 case, which an unpause correctly does not judge)
    await mined(cct.unpauseMultiTokenPoolGlobally({ ...v5, getChain }))
    await refused(
      () =>
        cct.generateUnsignedUnpauseMultiTokenPoolTokens({
          poolAddress: V5V9_POOL,
          sender: V5V9_OPERATOR,
          tokenAddresses: ['0x08f749F5Ee026753e88920088bE5F54590A8B14f'],
          direction: 'outbound',
          getChain,
        }),
      (e: unknown) =>
        e instanceof CCTParamsInvalidError &&
        (e.context.findings as { check: string }[]).some((f) => f.check === 'NO_REMOTE_POOL'),
    )
  })

  it('R3 M5 repro: a build right after a signed write sees the write (no sleep)', async (t) => {
    if (!deployed) return t.skip('mttp-core not deployed')
    const lanes = [{ tokenAddress: INLINE_TOKEN, remoteChainSelector: FUJI }]
    const wallet = await signer(CORE_CONFIG)
    const stop = { poolAddress: CORE_POOL, lanes, direction: 'outbound' } as const
    // the stop's snapshot, built first: a send the fork confirms late keeps it
    let { snapshot } = await withForkRetry(() =>
      cct.generateUnsignedStopMultiTokenPoolLanes({ ...stop, sender: CORE_CONFIG }),
    )
    let blockNumber: number
    try {
      ;({ snapshot, blockNumber } = await cct.stopMultiTokenPoolLanes({ ...stop, wallet }))
    } catch (err) {
      // the fork's upstream fetch outran the confirmation timeout: recover by the hash, never
      // resubmit, and record the block as the error's recovery says a caller does
      if (!(err instanceof CCTTxNotConfirmedError)) throw err
      const receipt = await (chain.provider as JsonRpcProvider).waitForTransaction(
        String(err.context.txHash),
        1,
        180_000,
      )
      assert.equal(receipt?.status, 1)
      blockNumber = receipt!.blockNumber
      noteMinedBlock(chain, blockNumber)
    }
    // immediately: before the fix this read the block before the stop ("not stopped: nothing to lift")
    const lift = await withForkRetry(() =>
      cct.generateUnsignedLiftMultiTokenPoolLaneStops({
        ...stop,
        getChain,
        restore: snapshot,
      }),
    )
    assert.ok(lift.snapshot.observedAt >= BigInt(blockNumber))
    await mined(cct.liftMultiTokenPoolLaneStops({ ...stop, wallet, getChain, restore: snapshot }))
  })

  it('a state move between the build and the send raises CCTStateChangedError (R1 m1)', async (t) => {
    if (!deployed) return t.skip('mttp-core not deployed')
    const lanes = [{ tokenAddress: POLICY_TOKEN, remoteChainSelector: FUJI }]
    const wallet = await signer(CORE_CONFIG)
    const clamp = async () => {
      const policy = await withForkRetry(() =>
        cct.getMultiTokenPoolRateLimitPolicy({ poolAddress: CORE_POOL, policyName: 'core-pol' }),
      )
      const inbound = policy.records.find((r) => r.remoteChainSelector === FUJI)!.rateLimits.inbound
      assert.ok(inbound.enabled)
      await mined(
        new ApplyMultiTokenPoolRateLimitPolicyBucketUpdates().execute(chain, {
          poolAddress: CORE_POOL,
          wallet,
          updates: [
            {
              policyName: 'core-pol',
              remoteChainSelector: FUJI,
              direction: 'inbound',
              fastFinality: false,
              config: { enabled: true, capacity: inbound.capacity - 1n, rate: inbound.rate },
            },
          ],
        }),
      )
    }
    // the policy moves right after the first build: the stop copies inbound, so the rebuilt
    // calldata differs, and the send is refused as a state change, not as a bad param
    class RacingStop extends StopMultiTokenPoolLanes {
      #builds = 0
      override async generate(...args: Parameters<StopMultiTokenPoolLanes['generate']>) {
        const unsigned = await super.generate(...args)
        if (this.#builds++ === 0) await clamp()
        return unsigned
      }
    }
    await refused(
      () =>
        new RacingStop().execute(chain, {
          poolAddress: CORE_POOL,
          lanes,
          direction: 'outbound',
          wallet,
        }),
      (e: unknown) =>
        e instanceof CCTStateChangedError &&
        (e.context.changed as { path: string }[]).some((c) => c.path === 'calldataHash'),
    )
  })

  it("refuses a restore from another pool's stop (R3 m1)", async (t) => {
    if (!deployed) return t.skip('mttp-core not deployed')
    const lanes = [{ tokenAddress: INLINE_TOKEN, remoteChainSelector: FUJI }]
    const built = await stop.generate(chain, {
      poolAddress: CORE_POOL,
      lanes,
      direction: 'outbound',
    })
    // the same lanes, sealed by another PCM (rehashed: the hash guards integrity, not origin)
    const { hash: _, ...fields } = {
      ...built.snapshot,
      expected: { ...built.snapshot.expected, 'stop.poolConfigManager': V5V9_POOL },
    }
    const foreign = { ...fields, hash: canonicalHash(fields) }
    await refused(
      () =>
        lift.generate(chain, {
          poolAddress: CORE_POOL,
          lanes,
          direction: 'outbound',
          restore: foreign,
        }),
      (e: unknown) =>
        e instanceof CCTParamsInvalidError &&
        e.context.param === 'restore' &&
        /is a stop on PoolConfigManager/.test(e.message),
    )
  })

  it('the guard enforces the drop confirmation (A21; kills R3 M36 off the live suite)', async (t) => {
    if (!deployed) return t.skip('mttp-core not deployed')
    const TWO_POOL_TOKEN = '0x84557ba2481E757553F479299f6Df129017320Dc'
    const [kept, dropped] = [
      '0xD14C91AD5C5cb41c5E58e75FD09f1EE60aA08F2e',
      '0x45289275807E88A197391E060589D647e64519D5',
    ]
    // a set that keeps one of the two trusted pools drops the other: refused until confirmed
    await refused(
      () =>
        cct.generateUnsignedApplyMultiTokenPoolInlineRemotePoolConfigUpdates({
          poolAddress: CORE_POOL,
          getChain,
          set: [
            {
              tokenAddress: TWO_POOL_TOKEN,
              remoteChainSelector: FUJI,
              trustPolicyRemotePools: false,
              poolDataFormat: 'long',
              remotePools: [{ address: kept, allowLegacyPoolData: false }],
            },
          ],
        }),
      (e: unknown) =>
        e instanceof CCTParamsInvalidError &&
        e.context.param === 'confirmDropped' &&
        JSON.stringify((e.context.dropped as { remotePools: string[] }[])[0]?.remotePools) ===
          JSON.stringify([dropped]),
    )
  })

  it('a pending stop is not made stale by an unrelated edit on the chain (R3 m4)', async (t) => {
    if (!deployed) return t.skip('mttp-core not deployed')
    const lanes = [{ tokenAddress: POLICY_TOKEN, remoteChainSelector: FUJI }]
    const built = await stop.generate(chain, {
      poolAddress: CORE_POOL,
      lanes,
      direction: 'outbound',
    })
    // another token's fee moves on the same chain
    const { fee } = await withForkRetry(() =>
      cct.getMultiTokenPoolInlineConfigs({ poolAddress: CORE_POOL, tokenAddress: INLINE_TOKEN }),
    )
    const record = fee!.find((r) => r.remoteChainSelector === FUJI)!
    await mined(
      cct.applyMultiTokenPoolInlineFeeConfigUpdates({
        poolAddress: CORE_POOL,
        wallet: await signer(CORE_CONFIG),
        getChain,
        set: [
          {
            ...record,
            feeConfig: {
              ...record.feeConfig,
              finalityFeeUSDCents: record.feeConfig.finalityFeeUSDCents + 1,
            },
          },
        ],
      }),
    )
    const check = await withForkRetry(() =>
      cct.checkMultiTokenPoolSnapshot({
        snapshot: built.snapshot,
        transaction: built,
        sender: CORE_CONFIG,
        getChain,
      }),
    )
    assert.deepEqual(check.changed, [])
    assert.equal(check.ok, true)
  })
})
