/**
 * The snapshot check of record writes whose sealed values no lane covers, on an anvil fork of
 * Sepolia (the live mttp-core stack, role holders impersonated): a policy no token uses, a profile of
 * a token with no lanes, and a pause of a chain no lane goes to. Each proposal goes stale when what
 * it replaces moves, although its guard inputs do not.
 */

import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { Console } from 'node:console'
import { type AddressInfo, createServer } from 'node:net'
import { after, before, describe, it } from 'node:test'

import { type JsonRpcProvider, Wallet } from 'ethers'
import { Instance } from 'prool'

import { reachableRpcEndpoint, rpcEndpoint } from '../../../../../../scripts/test-endpoints.ts'
import type { ChainGetter } from '../../../../chain.ts'
import { forkProvider, withForkRetry } from '../../../../evm/fork-retry.test.helpers.ts'
import { EVMChain } from '../../../../evm/index.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import type { MultiTokenPoolSnapshotCheck } from '../../../multi-token-pool.ts'
import { EVMTokenManager } from '../../index.ts'
import { mined as minedOn } from './fork.test.helpers.ts'

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
const ARBITRUM_SEPOLIA = 3478487238524512106n
const CORE_POOL = '0x91b33bfc6B7E4ee5511BB654e9f93b6d3e72671b'
const CORE_CONFIG = '0x3F7Ba502948E1A74d2eF94908CA3e0Bb8f17C7Ca' // CONFIG_ROLE on mttp-core
const SEPOLIA_LINK = '0x779877A7B0D9E8603169DdbD7836e478b4624789' // an ERC20 mttp-core does not serve

describe(
  'snapshot check of record writes no lane covers (Sepolia fork)',
  { skip, timeout: 900_000 },
  () => {
    let instance: ReturnType<typeof Instance.anvil> | undefined
    let provider: JsonRpcProvider
    let chain: EVMChain
    let fuji: EVMChain
    let cct: EVMTokenManager
    let getChain: ChainGetter
    let admin: string
    let deployed = false
    const target = { poolAddress: CORE_POOL }

    before(async () => {
      instance = Instance.anvil(
        {
          forkUrl: rpcEndpoint('RPC_SEPOLIA'),
          chainId: 11155111,
          port: await freePort(),
          retries: 8,
          timeout: 15_000,
          forkRetryBackoff: 1_000,
        },
        {},
      )
      await instance.start()
      provider = await forkProvider(instance, { logger: testLogger })
      chain = await EVMChain.fromProvider(provider, { apiClient: null, logger: testLogger })
      fuji = await EVMChain.fromUrl(await reachableRpcEndpoint('RPC_FUJI'), {
        apiClient: null,
        logger: testLogger,
      })
      getChain = async () => fuji
      cct = EVMTokenManager.fromChain(chain)
      deployed = await cct.isMultiTokenPool(target)
      if (!deployed) return
      admin = (await cct.getPoolConfigManagerState(target)).defaultAdmin
      for (const account of [CORE_CONFIG, admin]) {
        await provider.send('anvil_impersonateAccount', [account])
        await provider.send('anvil_setBalance', [account, '0x56BC75E2D63100000'])
      }
    })

    after(async () => {
      chain.provider.destroy()
      fuji.provider.destroy()
      await instance?.stop()
    })

    const signer = (account: string) => provider.getSigner(account)
    const mined = async (write: Promise<{ hash: string }>) =>
      assert.equal(await minedOn(provider, write), 1)
    const check = (
      proposal: Awaited<ReturnType<EVMTokenManager['generateUnsignedPauseMultiTokenPoolChains']>>,
      sender: string,
    ) =>
      withForkRetry(() =>
        cct.checkMultiTokenPoolSnapshot({
          snapshot: proposal.snapshot,
          transaction: proposal,
          sender,
          getChain,
        }),
      )
    /** Stale on `path` only: the guard inputs did not move, so only the re-read sealed value catches it. */
    const staleOn = (result: MultiTokenPoolSnapshotCheck, path: RegExp) => {
      assert.equal(result.ok, false)
      assert.ok(
        result.changed.some((c) => path.test(c.path)),
        result.changed.map((c) => c.path).join(),
      )
      assert.ok(!result.changed.some((c) => c.path === 'guardInputsHash'))
    }

    it('a policy no token uses: a proposal goes stale when the record moves', async (t) => {
      if (!deployed) return t.skip('mttp-core not deployed')
      const fee = (cents: number) => ({
        policyName: `recheck-${Date.now()}`,
        remoteChainSelector: FUJI,
        feeConfig: {
          finalityFeeUSDCents: cents,
          fastFinalityFeeUSDCents: cents,
          finalityTransferFeeBps: 5,
          fastFinalityTransferFeeBps: 5,
        },
      })
      const record = fee(1)
      const at = (cents: number) => ({
        ...record,
        feeConfig: { ...record.feeConfig, finalityFeeUSDCents: cents },
      })
      const wallet = await signer(CORE_CONFIG)
      await mined(
        cct.applyMultiTokenPoolFeePolicyConfigUpdates({
          ...target,
          recordsToSet: [record],
          wallet,
        }),
      )
      const proposal = await cct.generateUnsignedApplyMultiTokenPoolFeePolicyConfigUpdates({
        ...target,
        recordsToSet: [at(3)],
        sender: CORE_CONFIG,
      })
      assert.deepEqual(proposal.affectedLanes, [])
      assert.deepEqual((await check(proposal, CORE_CONFIG)).changed, [])
      await mined(
        cct.applyMultiTokenPoolFeePolicyConfigUpdates({ ...target, recordsToSet: [at(7)], wallet }),
      )
      staleOn(await check(proposal, CORE_CONFIG), /^policies\.fee\./)
    })

    it('a token with no lanes: a registration proposal goes stale when the token is registered', async (t) => {
      if (!deployed) return t.skip('mttp-core not deployed')
      const profile = (tokenAddress: string) => ({
        tokenAddress,
        localDecimals: 18,
        lockOrBurnFlavor: 'burn' as const,
        allowedFinality: { finalityDepth: 0 },
        lockOrBurnAddress: null,
        additionalPoolDataProvider: null,
      })
      // an address with no code cannot be registered: the store's decimals() decode reverts
      await assert.rejects(
        cct.generateUnsignedApplyMultiTokenPoolTokenProfileUpdates({
          ...target,
          getChain,
          profilesToSet: [profile(Wallet.createRandom().address)],
          sender: CORE_CONFIG,
        }),
        (e: unknown) =>
          e instanceof CCTParamsInvalidError &&
          e.context.param === 'profilesToSet[0].tokenAddress' &&
          /has no code/.test(String(e.context.reason)),
      )
      // a real ERC20 the stack does not serve (LINK, 18 decimals): no lane, no record
      const proposal = await cct.generateUnsignedApplyMultiTokenPoolTokenProfileUpdates({
        ...target,
        getChain,
        profilesToSet: [profile(SEPOLIA_LINK)],
        sender: CORE_CONFIG,
      })
      assert.deepEqual(proposal.affectedLanes, [])
      assert.deepEqual((await check(proposal, CORE_CONFIG)).changed, [])
      await mined(
        cct.applyMultiTokenPoolTokenProfileUpdates({
          ...target,
          getChain,
          profilesToSet: [profile(SEPOLIA_LINK)],
          wallet: await signer(CORE_CONFIG),
        }),
      )
      staleOn(await check(proposal, CORE_CONFIG), new RegExp(`^profiles\\.${SEPOLIA_LINK}$`))
    })

    it('a chain no lane goes to: a pause proposal goes stale when the chain is paused', async (t) => {
      if (!deployed) return t.skip('mttp-core not deployed')
      const pause = {
        ...target,
        remoteChainSelectors: [ARBITRUM_SEPOLIA],
        direction: 'outbound' as const,
      }
      const proposal = await cct.generateUnsignedPauseMultiTokenPoolChains({
        ...pause,
        sender: admin,
      })
      // no lane goes there: only the sealed pause flag records what the proposal replaces
      assert.deepEqual(proposal.affectedLanes, [])
      assert.deepEqual((await check(proposal, admin)).changed, [])
      await mined(cct.pauseMultiTokenPoolChains({ ...pause, wallet: await signer(admin) }))
      staleOn(await check(proposal, admin), new RegExp(`^pauses\\.chain\\.${ARBITRUM_SEPOLIA}$`))
      await mined(
        cct.unpauseMultiTokenPoolChains({ ...pause, getChain, wallet: await signer(admin) }),
      )
    })
  },
)
