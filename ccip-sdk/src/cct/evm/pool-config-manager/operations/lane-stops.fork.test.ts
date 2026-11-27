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
import { forkProvider, withForkRetry } from '../../../../evm/fork-retry.test.helpers.ts'
import { EVMChain } from '../../../../evm/index.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { EVMTokenManager } from '../../index.ts'
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
    await assert.rejects(
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
    await assert.rejects(
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
})
