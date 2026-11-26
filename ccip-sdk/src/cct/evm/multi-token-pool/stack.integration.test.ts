/**
 * Read-only integration tests of the multi-token pool (MTTP) stack reads, against the live Sepolia
 * "v5v9" `BurnMintMultiTokenPool 2.1.0-dev` stack that docs-cct-foundry deployed.
 *
 * Each SDK read is checked against a raw read of the same state. When the pool is no longer a
 * multi-token pool, the tests skip (they do not fail); RPC errors still fail them.
 */
import assert from 'node:assert/strict'
import { Console } from 'node:console'
import { before, describe, it } from 'node:test'

import { Contract, getAddress } from 'ethers'

import { reachableRpcEndpoint } from '../../../../../scripts/test-endpoints.ts'
import { useResource } from '../../../../../scripts/useResource.ts'
import { EVMChain } from '../../../evm/index.ts'
import { EVMTokenManager } from '../index.ts'

const skip = !!process.env.SKIP_INTEGRATION_TESTS

await useResource(['sepolia'])

const testLogger = new Console(process.stdout, process.stderr)
if (!process.env.VERBOSE) testLogger.debug = () => {}

// ── docs-cct-foundry v5v9 stack on Ethereum Sepolia ──
const POOL = '0x6304228a2908E45fC87f6cc685E6fC309f5A8624'
const PCM = '0x8AEe4112612168c05db5Dc204E18dCa6b3aD8Cc6'
const RAW = [
  'function owner() view returns (address)',
  'function getRouter() view returns (address)',
  'function getPoolConfigManager() view returns (address)',
  'function getStaticConfig() view returns (address,address,address,address)',
  'function defaultAdmin() view returns (address)',
  'function getAllAuthorizedCallers() view returns (address[])',
  'function getAllConfiguredTokens(uint64,uint64) view returns (address[])',
]

describe('multi-token pool stack reads (Sepolia v5v9)', { skip, timeout: 300_000 }, () => {
  let chain: EVMChain
  let cct: EVMTokenManager
  let deployed = false

  before(async () => {
    chain = await EVMChain.fromUrl(await reachableRpcEndpoint('RPC_SEPOLIA'), {
      apiClient: null,
      logger: testLogger,
    })
    cct = EVMTokenManager.fromChain(chain)
    deployed = await cct.isMultiTokenPool({ poolAddress: POOL })
  })

  const raw = (address: string) => new Contract(address, RAW, chain.provider)

  it('reads the pool as the raw getters report it', async (t) => {
    if (!deployed) return t.skip('v5v9 multi-token pool not deployed')
    const state = await cct.getMultiTokenPoolState({ poolAddress: POOL })
    assert.equal(state.type, 'BurnMintMultiTokenPool')
    assert.equal(state.version, '2.1.0-dev')
    assert.equal(state.owner, getAddress(await raw(POOL).getFunction('owner')()))
    assert.equal(state.router, getAddress(await raw(POOL).getFunction('getRouter')()))
    assert.equal(state.poolConfigManager, getAddress(PCM))
  })

  it('reads the PCM, its stores and their callers', async (t) => {
    if (!deployed) return t.skip('v5v9 multi-token pool not deployed')
    const pcm = await cct.getPoolConfigManagerState({ poolAddress: POOL })
    const [tar, cps, fps, sps] = await raw(PCM).getFunction('getStaticConfig')()
    assert.deepEqual(
      [
        pcm.tokenAdminRegistry,
        pcm.connectionPolicyStore,
        pcm.feePolicyStore,
        pcm.securityPolicyStore,
      ],
      [tar, cps, fps, sps].map((a: string) => getAddress(a)),
    )
    assert.equal(pcm.defaultAdmin, getAddress(await raw(PCM).getFunction('defaultAdmin')()))
    for (const store of [cps, fps, sps] as string[]) {
      const s = await cct.getPolicyStoreState({ policyStore: store })
      assert.deepEqual(
        s.authorizedCallers,
        ((await raw(store).getFunction('getAllAuthorizedCallers')()) as string[]).map((a) =>
          getAddress(a),
        ),
      )
      assert.ok(s.authorizedCallers.includes(getAddress(PCM)))
    }
  })

  it('finds the default admin among the role holders, complete from deployment', async (t) => {
    if (!deployed) return t.skip('v5v9 multi-token pool not deployed')
    const { defaultAdmin } = await cct.getPoolConfigManagerState({ poolConfigManager: PCM })
    const holders = await cct.getMultiTokenPoolRoleHolders({ poolConfigManager: PCM })
    assert.ok(holders.holders.DEFAULT_ADMIN_ROLE.includes(defaultAdmin))
    assert.equal(holders.complete, true)
    const [roles] = await cct.getMultiTokenPoolRoles({
      poolConfigManager: PCM,
      accounts: [defaultAdmin],
    })
    assert.ok(roles!.roles.includes('DEFAULT_ADMIN_ROLE'))
  })

  it('audits the stack without errors', async (t) => {
    if (!deployed) return t.skip('v5v9 multi-token pool not deployed')
    const { findings } = await cct.getMultiTokenPoolStack({ poolAddress: POOL })
    assert.deepEqual(
      findings.filter((f) => f.severity === 'error'),
      [],
    )
  })

  it('lists the registered tokens and reads every lane view of each', async (t) => {
    if (!deployed) return t.skip('v5v9 multi-token pool not deployed')
    const { tokens, blockNumber } = await cct.getMultiTokenPoolConfiguredTokens({
      poolAddress: POOL,
    })
    const raw = (
      (await new Contract(PCM, RAW, chain.provider).getFunction('getAllConfiguredTokens')(
        0n,
        1000n,
        {
          blockTag: blockNumber,
        },
      )) as string[]
    ).map((a) => getAddress(a))
    assert.deepEqual(tokens, raw)
    assert.ok(tokens.length > 0)
    const configs = await cct.getMultiTokenPoolTokenConfigs({
      poolAddress: POOL,
      tokenAddresses: tokens,
    })
    assert.ok(configs.every((c) => c.isRegistered))
    const lanes = configs.flatMap((c) =>
      c.supportedChains.map((remoteChainSelector) => ({
        tokenAddress: c.tokenAddress,
        remoteChainSelector,
      })),
    )
    const [connections, levels, verifications] = await Promise.all([
      cct.getMultiTokenPoolLaneConnections({ poolAddress: POOL, lanes }),
      cct.getMultiTokenPoolLaneRecordLevels({ poolAddress: POOL, lanes }),
      cct.getMultiTokenPoolLaneVerifications({ poolAddress: POOL, lanes }),
    ])
    // every supported chain has a connection, which resolves from somewhere
    assert.ok(connections.every((c) => c.hasConnection && c.remoteToken))
    assert.ok(levels.every((l) => l.levels.connection !== 'none'))
    assert.equal(verifications.length, lanes.length)
    // a finality no token on a lane allows is marked, not thrown
    const fees = await cct.getMultiTokenPoolLaneFees({ poolAddress: POOL, lanes, finality: 1 })
    assert.equal(fees.length, lanes.length)
  })
})
