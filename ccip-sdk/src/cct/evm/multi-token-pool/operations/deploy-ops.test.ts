import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ZeroAddress, getAddress, getCreateAddress } from 'ethers'

import type { EVMChain } from '../../../../evm/index.ts'
import type { UnsignedEVMTx } from '../../../../evm/types.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import {
  type DeployMultiTokenPoolHooksParams,
  DeployMultiTokenPoolHooks,
} from '../../multi-token-pool-hooks/operations/deploy-multi-token-pool-hooks.ts'
import { DeployMultiTokenPoolProvider } from '../../multi-token-pool-providers/operations/deploy-multi-token-pool-provider.ts'
import { DeployPolicyStore } from '../../policy-store/operations/deploy-policy-store.ts'
import { DeployPoolConfigManager } from '../../pool-config-manager/operations/deploy-pool-config-manager.ts'
import { getMultiTokenPoolArtifact } from '../deploy-artifacts.ts'
import {
  CPS,
  FPS,
  OTHER,
  OWNER,
  PCM,
  RMN,
  ROUTER,
  SPS,
  TAR,
  defaultStack,
  stackChain,
} from '../stack.test.helpers.ts'
import { DeployMultiTokenPool } from './deploy-multi-token-pool.ts'

const EOA = getAddress('0x' + 'e0'.repeat(20))

const refusedAt = (param: string, reason?: RegExp) => (e: unknown) => {
  assert.ok(e instanceof CCTParamsInvalidError, String(e))
  assert.equal(e.context.param, param)
  if (reason) assert.match(String(e.context.reason), reason)
  return true
}

/** The init-code of a built deploy: the pinned bytecode, then the encoded constructor args. */
function initCode(tx: UnsignedEVMTx) {
  const [only] = tx.transactions
  assert.equal(only!.to ?? undefined, undefined, 'a deploy has no `to`')
  return String(only!.data)
}

describe('MTTP deploys (2.1.0-dev bytecode)', () => {
  it('deployPolicyStore: one op for the three stores, the callers as constructor args', async () => {
    const { chain, calls } = stackChain()
    const op = new DeployPolicyStore()
    await assert.rejects(op.generate(chain, { type: 'PolicyStore' as never }), refusedAt('type'))
    await assert.rejects(
      op.generate(chain, { type: 'FeePolicyStore', authorizedCallers: [PCM, PCM.toLowerCase()] }),
      refusedAt('authorizedCallers', /duplicate/),
    )
    assert.deepEqual(calls, [])
    for (const type of [
      'ConnectionPolicyStore',
      'FeePolicyStore',
      'SecurityPolicyStore',
    ] as const) {
      const data = initCode(await op.generate(chain, { type, authorizedCallers: [PCM] }))
      const { bytecode, iface } = getMultiTokenPoolArtifact(type)
      assert.ok(data.startsWith(bytecode))
      assert.equal(data.slice(bytecode.length), iface.encodeDeploy([[PCM]]).slice(2))
    }
  })

  it('deployPoolConfigManager: checks each store slot and the Router registry; admin defaults to sender', async () => {
    const { chain, calls } = stackChain(defaultStack())
    const op = new DeployPoolConfigManager()
    const base = {
      tokenAdminRegistry: TAR,
      connectionPolicyStore: CPS,
      feePolicyStore: FPS,
      securityPolicyStore: SPS,
    }
    await assert.rejects(
      op.generate(chain, base),
      refusedAt('admin', /required when sender is omitted/),
    )
    assert.deepEqual(calls, [])
    await assert.rejects(
      op.generate(chain, { ...base, connectionPolicyStore: FPS, sender: OWNER }),
      refusedAt('connectionPolicyStore', /is not a ConnectionPolicyStore/),
    )
    await assert.rejects(
      op.generate(chain, { ...base, tokenAdminRegistry: OTHER, router: ROUTER, sender: OWNER }),
      refusedAt('tokenAdminRegistry', /is not the registry/),
    )
    const data = initCode(await op.generate(chain, { ...base, router: ROUTER, sender: OWNER }))
    const { bytecode, iface } = getMultiTokenPoolArtifact('PoolConfigManager')
    assert.equal(
      data.slice(bytecode.length),
      iface.encodeDeploy([TAR, CPS, FPS, SPS, OWNER]).slice(2),
    )
  })

  it('deployMultiTokenPool: rmnProxy, router and PCM required, encoded in constructor order', async () => {
    const { chain, calls } = stackChain()
    const op = new DeployMultiTokenPool()
    const params = {
      type: 'BurnMintMultiTokenPool',
      router: ROUTER,
      rmnProxy: RMN,
      poolConfigManager: PCM,
    } as const
    await assert.rejects(
      op.generate(chain, { ...params, rmnProxy: ZeroAddress }),
      refusedAt('rmnProxy'),
    )
    assert.deepEqual(calls, [])
    const data = initCode(await op.generate(chain, params))
    const { bytecode, iface } = getMultiTokenPoolArtifact('BurnMintMultiTokenPool')
    assert.equal(data.slice(bytecode.length), iface.encodeDeploy([RMN, ROUTER, PCM]).slice(2))
  })

  it('deployMultiTokenPoolProvider: SameAddress takes nothing, UID its factory', async () => {
    const { chain } = stackChain()
    const op = new DeployMultiTokenPoolProvider()
    await assert.rejects(
      op.generate(chain, {
        type: 'FactoryTokenWithUIDPoolDataProvider',
        tokenFactory: ZeroAddress,
      }),
      refusedAt('tokenFactory'),
    )
    const same = initCode(
      await op.generate(chain, { type: 'SameAddressRemoteTokenAddressProvider' }),
    )
    assert.equal(same, getMultiTokenPoolArtifact('SameAddressRemoteTokenAddressProvider').bytecode)
    const uid = initCode(
      await op.generate(chain, {
        type: 'FactoryTokenWithUIDPoolDataProvider',
        tokenFactory: OTHER,
      }),
    )
    const { bytecode, iface } = getMultiTokenPoolArtifact('FactoryTokenWithUIDPoolDataProvider')
    assert.equal(uid.slice(bytecode.length), iface.encodeDeploy([OTHER]).slice(2))
  })

  it('deployMultiTokenPoolHooks: a blocklist on the base hooks and an EOA engine are refused', async () => {
    const state = defaultStack()
    state.eoas = [EOA]
    const { chain } = stackChain(state)
    const op = new DeployMultiTokenPoolHooks()
    const base: DeployMultiTokenPoolHooksParams = {
      type: 'MultiTokenPoolHooks',
      allowlist: [],
      authorizedCallers: [OTHER],
    }
    await assert.rejects(
      op.generate(chain, { ...base, blocklist: OTHER }),
      refusedAt('blocklist', /ExternalBlocklist only/),
    )
    await assert.rejects(
      op.generate(chain, { ...base, policyEngine: EOA }),
      refusedAt('policyEngine', /deployed policy engine contract, not an EOA/),
    )
    const data = initCode(await op.generate(chain, base))
    const { bytecode, iface } = getMultiTokenPoolArtifact('MultiTokenPoolHooks')
    assert.equal(
      data.slice(bytecode.length),
      iface.encodeDeploy([[], ZeroAddress, [OTHER]]).slice(2),
    )
    const ext = initCode(
      await op.generate(chain, {
        ...base,
        type: 'MultiTokenPoolHooksExternalBlocklist',
        blocklist: OTHER,
      }),
    )
    const blocklist = getMultiTokenPoolArtifact('MultiTokenPoolHooksExternalBlocklist')
    assert.equal(
      ext.slice(blocklist.bytecode.length),
      blocklist.iface.encodeDeploy([[], ZeroAddress, OTHER, [OTHER]]).slice(2),
    )
  })
})

const SENDER = getAddress('0x' + '5e'.repeat(20))
const DEPLOYED = getCreateAddress({ from: SENDER, nonce: 0 })

/** A signer whose deployment mines at the CREATE address of (SENDER, nonce 0), as main's tests. */
function fakeSigner() {
  return {
    signTransaction: () => Promise.resolve('0x'),
    getAddress: () => Promise.resolve(SENDER),
    populateTransaction: (tx: unknown) => Promise.resolve({ ...(tx as object) }),
    sendTransaction: () =>
      Promise.resolve({
        hash: '0x' + 'ab'.repeat(32),
        wait: () => Promise.resolve({ status: 1, contractAddress: DEPLOYED }),
      }),
  }
}

/** The stack stub, with the nonce hooks `execute` uses. */
function executingChain() {
  const { chain } = stackChain(defaultStack())
  return Object.assign(chain, { nextNonce: async () => 0, rollbackNonce: () => {} })
}

describe('MTTP deploys: the verification field (contract name + encoded constructor args)', () => {
  const wallet = fakeSigner()
  const cases = [
    {
      name: 'deployPolicyStore',
      run: (c: EVMChain) =>
        new DeployPolicyStore().execute(c, {
          type: 'SecurityPolicyStore',
          authorizedCallers: [PCM],
          wallet,
        }),
      contract: 'SecurityPolicyStore',
      args: [[PCM]],
    },
    {
      name: 'deployPoolConfigManager',
      run: (c: EVMChain) =>
        new DeployPoolConfigManager().execute(c, {
          tokenAdminRegistry: TAR,
          connectionPolicyStore: CPS,
          feePolicyStore: FPS,
          securityPolicyStore: SPS,
          admin: OWNER,
          wallet,
        }),
      contract: 'PoolConfigManager',
      args: [TAR, CPS, FPS, SPS, OWNER],
    },
    {
      name: 'deployMultiTokenPool',
      run: (c: EVMChain) =>
        new DeployMultiTokenPool().execute(c, {
          type: 'BurnMintMultiTokenPool',
          router: ROUTER,
          rmnProxy: RMN,
          poolConfigManager: PCM,
          wallet,
        }),
      contract: 'BurnMintMultiTokenPool',
      args: [RMN, ROUTER, PCM],
    },
    {
      name: 'deployMultiTokenPoolProvider (UID)',
      run: (c: EVMChain) =>
        new DeployMultiTokenPoolProvider().execute(c, {
          type: 'FactoryTokenWithUIDPoolDataProvider',
          tokenFactory: OTHER,
          wallet,
        }),
      contract: 'FactoryTokenWithUIDPoolDataProvider',
      args: [OTHER],
    },
    {
      name: 'deployMultiTokenPoolProvider (SameAddress)',
      run: (c: EVMChain) =>
        new DeployMultiTokenPoolProvider().execute(c, {
          type: 'SameAddressRemoteTokenAddressProvider',
          wallet,
        }),
      contract: 'SameAddressRemoteTokenAddressProvider',
      args: [],
    },
    {
      name: 'deployMultiTokenPoolHooks (external blocklist)',
      run: (c: EVMChain) =>
        new DeployMultiTokenPoolHooks().execute(c, {
          type: 'MultiTokenPoolHooksExternalBlocklist',
          allowlist: [OWNER],
          blocklist: OTHER,
          authorizedCallers: [PCM],
          wallet,
        }),
      contract: 'MultiTokenPoolHooksExternalBlocklist',
      args: [[OWNER], ZeroAddress, OTHER, [PCM]],
    },
  ] as const

  for (const { name, run, contract, args } of cases)
    it(`${name}: names ${contract} and carries its encoded constructor args`, async () => {
      const result = await run(executingChain())
      assert.equal(result.contractAddress, DEPLOYED)
      const { iface } = getMultiTokenPoolArtifact(contract)
      const encoded = iface.encodeDeploy(args as unknown as unknown[])
      assert.deepEqual(result.verification, { contract, encodedConstructorArgs: encoded })
    })
})
