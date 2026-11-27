/**
 * The multi-token pool deploys end to end on an anvil fork of Sepolia: a fresh account builds a
 * whole stack from scratch (three stores, the PCM, the pool, hooks, both providers) with the
 * `2.1.0-dev` bytecode, wires the stores to the PCM, and the stack read finds it all. The Router, RMN
 * proxy and registry are read from the live mttp-core pool, not hardcoded.
 */

import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { Console } from 'node:console'
import { type AddressInfo, createServer } from 'node:net'
import { after, before, describe, it } from 'node:test'

import { type JsonRpcProvider, Wallet, getAddress } from 'ethers'
import { Instance } from 'prool'

import { rpcEndpoint } from '../../../../../../scripts/test-endpoints.ts'
import { forkProvider, withForkRetry } from '../../../../evm/fork-retry.test.helpers.ts'
import { EVMChain } from '../../../../evm/index.ts'
import { DeployMultiTokenPoolHooks } from '../../multi-token-pool-hooks/operations/deploy-multi-token-pool-hooks.ts'
import { GetMultiTokenPoolHooksState } from '../../multi-token-pool-hooks/operations/get-multi-token-pool-hooks-state.ts'
import { DeployMultiTokenPoolProvider } from '../../multi-token-pool-providers/operations/deploy-multi-token-pool-provider.ts'
import { DeployPolicyStore } from '../../policy-store/operations/deploy-policy-store.ts'
import { UpdatePolicyStoreAuthorizedCallers } from '../../policy-store/operations/update-policy-store-authorized-callers.ts'
import { DeployPoolConfigManager } from '../../pool-config-manager/operations/deploy-pool-config-manager.ts'
import {
  deployed,
  mined as minedOn,
} from '../../pool-config-manager/operations/fork.test.helpers.ts'
import { POLICY_STORE_TYPES } from '../contracts.ts'
import { DeployMultiTokenPool } from './deploy-multi-token-pool.ts'
import { GetMultiTokenPoolStack } from './get-multi-token-pool-stack.ts'
import { GetMultiTokenPoolState } from './get-multi-token-pool-state.ts'

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

const CORE_POOL = '0x91b33bfc6B7E4ee5511BB654e9f93b6d3e72671b' // mttp-core: only its Router is read

describe('MTTP deploys: a stack from scratch (Sepolia fork)', { skip, timeout: 900_000 }, () => {
  let instance: ReturnType<typeof Instance.anvil> | undefined
  let provider: JsonRpcProvider
  let chain: EVMChain

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
  })

  after(async () => {
    chain.provider.destroy()
    await instance?.stop()
  })

  const mined = async (write: Promise<{ hash: string }>) =>
    assert.equal(await minedOn(provider, write), 1)
  const deploy = (write: Promise<{ contractAddress: string }>) => deployed(chain, provider, write)

  it('deploys and wires a whole stack, and the stack read finds it', async () => {
    const deployer = Wallet.createRandom().address
    await provider.send('anvil_impersonateAccount', [deployer])
    await provider.send('anvil_setBalance', [deployer, '0x56BC75E2D63100000'])
    const wallet = await provider.getSigner(deployer)
    const live = await withForkRetry(() =>
      new GetMultiTokenPoolState().query(chain, { poolAddress: CORE_POOL }),
    )
    const tokenAdminRegistry = getAddress(await chain.getTokenAdminRegistryFor(live.router))

    const stores = {} as Record<(typeof POLICY_STORE_TYPES)[number], string>
    for (const type of POLICY_STORE_TYPES) {
      stores[type] = await deploy(new DeployPolicyStore().execute(chain, { type, wallet }))
    }
    const pcm = await deploy(
      new DeployPoolConfigManager().execute(chain, {
        tokenAdminRegistry,
        connectionPolicyStore: stores.ConnectionPolicyStore,
        feePolicyStore: stores.FeePolicyStore,
        securityPolicyStore: stores.SecurityPolicyStore,
        router: live.router,
        wallet,
      }),
    )
    // the stores authorize their PCM (F5: it is a PCM over them)
    for (const store of Object.values(stores))
      await mined(
        new UpdatePolicyStoreAuthorizedCallers().execute(chain, {
          policyStore: store,
          addedCallers: [pcm],
          wallet,
        }),
      )
    const pool = await deploy(
      new DeployMultiTokenPool().execute(chain, {
        type: 'BurnMintMultiTokenPool',
        router: live.router,
        rmnProxy: live.rmnProxy,
        poolConfigManager: pcm,
        wallet,
      }),
    )
    const hooks = await deploy(
      new DeployMultiTokenPoolHooks().execute(chain, {
        type: 'MultiTokenPoolHooks',
        allowlist: [],
        authorizedCallers: [pool],
        wallet,
      }),
    )
    const sameAddress = await deploy(
      new DeployMultiTokenPoolProvider().execute(chain, {
        type: 'SameAddressRemoteTokenAddressProvider',
        wallet,
      }),
    )
    const uid = await deploy(
      new DeployMultiTokenPoolProvider().execute(chain, {
        type: 'FactoryTokenWithUIDPoolDataProvider',
        tokenFactory: pcm,
        wallet,
      }),
    )

    // the stack read finds the whole of it, owned by the deployer
    const stack = await withForkRetry(() =>
      new GetMultiTokenPoolStack().query(chain, { poolAddress: pool }),
    )
    assert.equal(stack.pool.typeAndVersion, 'BurnMintMultiTokenPool 2.1.0-dev')
    assert.equal(stack.pool.owner, getAddress(deployer))
    assert.equal(stack.pool.poolConfigManager, pcm)
    assert.equal(stack.pool.router, getAddress(live.router))
    assert.equal(stack.poolConfigManager.defaultAdmin, getAddress(deployer))
    for (const type of POLICY_STORE_TYPES) {
      assert.equal(stack.policyStores[type].address, stores[type])
      assert.deepEqual(stack.policyStores[type].authorizedCallers, [pcm])
      assert.equal(stack.policyStores[type].owner, getAddress(deployer))
    }
    const hooksState = await withForkRetry(() =>
      new GetMultiTokenPoolHooksState().query(chain, { hooks: hooks }),
    )
    assert.equal(hooksState.allowlistEnabled, false)
    assert.deepEqual(hooksState.authorizedCallers, [pool])
    for (const [address, type] of [
      [sameAddress, 'SameAddressRemoteTokenAddressProvider'],
      [uid, 'FactoryTokenWithUIDPoolDataProvider'],
    ] as const)
      assert.equal((await chain.typeAndVersion(address))[0], type)
  })
})
