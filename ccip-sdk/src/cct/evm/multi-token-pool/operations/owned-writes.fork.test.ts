/**
 * Owner-gated MTTP writes (the pool, a policy store, the hooks) end to end on anvil forks: Sepolia for
 * the live mttp-core pool and its stores, Fuji for the live hook contracts. Every owner is read from
 * chain and impersonated; nothing is hardcoded but the targets.
 */

import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { Console } from 'node:console'
import { type AddressInfo, createServer } from 'node:net'
import { after, before, describe, it } from 'node:test'

import {
  type JsonRpcProvider,
  Wallet,
  ZeroAddress,
  getAddress,
  toBeHex,
  zeroPadValue,
} from 'ethers'
import { Instance } from 'prool'

import { type RpcEnvName, rpcEndpoint } from '../../../../../../scripts/test-endpoints.ts'
import type { ChainGetter } from '../../../../chain.ts'
import {
  forkProvider,
  rejectionOf,
  withForkRetry,
} from '../../../../evm/fork-retry.test.helpers.ts'
import { EVMChain } from '../../../../evm/index.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { EVMTokenManager } from '../../index.ts'
import { GetMultiTokenPoolHooksState } from '../../multi-token-pool-hooks/operations/get-multi-token-pool-hooks-state.ts'
import {
  ApplyMultiTokenPoolHooksAllowlistUpdates,
  SetMultiTokenPoolHooksBlocklist,
  SetMultiTokenPoolHooksPolicyEngine,
} from '../../multi-token-pool-hooks/operations/hooks-config-writes.ts'
import { UpdateMultiTokenPoolHooksAuthorizedCallers } from '../../multi-token-pool-hooks/operations/update-multi-token-pool-hooks-authorized-callers.ts'
import { mined as minedOn } from '../../pool-config-manager/operations/fork.test.helpers.ts'
import { readOwnership } from '../contracts.ts'
import { GetMultiTokenPoolStack } from './get-multi-token-pool-stack.ts'
import {
  AcceptMultiTokenPoolHooksOwnership,
  AcceptMultiTokenPoolOwnership,
  AcceptPolicyStoreOwnership,
  TransferMultiTokenPoolHooksOwnership,
  TransferMultiTokenPoolOwnership,
  TransferPolicyStoreOwnership,
} from './ownership-writes.ts'

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

const CORE_POOL = '0x91b33bfc6B7E4ee5511BB654e9f93b6d3e72671b' // mttp-core, Sepolia
const FUJI_HOOKS = getAddress('0xcfd121c8801f70eda03ff03b6cf11fe51b2da603') // MultiTokenPoolHooks
const FUJI_BLOCKLIST_HOOKS = getAddress('0xac2252c295a9a7c49f50702de2a09e67876a993b')

/** An anvil fork of `rpc` on a free port, with its chain. */
async function fork(rpc: RpcEnvName, chainId: number) {
  const instance = Instance.anvil(
    {
      forkUrl: rpcEndpoint(rpc),
      chainId,
      port: await freePort(),
      retries: 8,
      timeout: 15_000,
      forkRetryBackoff: 1_000,
    },
    {},
  )
  await instance.start()
  const provider = await forkProvider(instance, { logger: testLogger })
  const chain = await EVMChain.fromProvider(provider, { apiClient: null, logger: testLogger })
  return { instance, provider, chain }
}

/** Funds and impersonates `account` on a fork, and returns its signer. */
async function impersonate(provider: JsonRpcProvider, account: string) {
  await provider.send('anvil_impersonateAccount', [account])
  await provider.send('anvil_setBalance', [account, '0x56BC75E2D63100000'])
  return provider.getSigner(account)
}

describe('MTTP owner-gated writes (Sepolia and Fuji forks)', { skip, timeout: 900_000 }, () => {
  let sepolia: Awaited<ReturnType<typeof fork>>
  let fuji: Awaited<ReturnType<typeof fork>>
  let store: string
  const newOwner = Wallet.createRandom().address

  before(async () => {
    ;[sepolia, fuji] = await Promise.all([fork('RPC_SEPOLIA', 11155111), fork('RPC_FUJI', 43113)])
    const stack = await withForkRetry(() =>
      new GetMultiTokenPoolStack().query(sepolia.chain, { poolAddress: CORE_POOL }),
    )
    store = stack.policyStores.ConnectionPolicyStore.address
  })

  after(async () => {
    for (const f of [sepolia, fuji] as (typeof sepolia | undefined)[]) {
      f?.chain.provider.destroy()
      await f?.instance.stop()
    }
  })

  const mined = async (provider: JsonRpcProvider, write: Promise<{ hash: string }>) =>
    assert.equal(await minedOn(provider, write), 1)

  /** Transfers `target` to a fresh account, accepts as it, and checks both steps on chain. */
  async function roundTrip(
    f: Awaited<ReturnType<typeof fork>>,
    target: string,
    transfer: (wallet: Awaited<ReturnType<typeof impersonate>>) => Promise<{ hash: string }>,
    accept: (wallet: Awaited<ReturnType<typeof impersonate>>) => Promise<{ hash: string }>,
  ) {
    const { owner } = await withForkRetry(() => readOwnership(f.chain, target))
    await mined(f.provider, transfer(await impersonate(f.provider, owner)))
    assert.deepEqual(await withForkRetry(() => readOwnership(f.chain, target)), {
      owner,
      pendingOwner: newOwner,
    })
    await mined(f.provider, accept(await impersonate(f.provider, newOwner)))
    assert.deepEqual(await withForkRetry(() => readOwnership(f.chain, target)), {
      owner: newOwner,
      pendingOwner: null,
    })
    return owner
  }

  it('moves the pool through transfer and accept', async () => {
    const transfer = new TransferMultiTokenPoolOwnership()
    const accept = new AcceptMultiTokenPoolOwnership()
    const previous = await roundTrip(
      sepolia,
      CORE_POOL,
      (wallet) => transfer.execute(sepolia.chain, { poolAddress: CORE_POOL, newOwner, wallet }),
      (wallet) => accept.execute(sepolia.chain, { poolAddress: CORE_POOL, wallet }),
    )
    // the old owner can no longer propose
    const refusal = await withForkRetry(() =>
      rejectionOf(
        transfer.generate(sepolia.chain, {
          poolAddress: CORE_POOL,
          newOwner: previous,
          sender: previous,
        }),
        'expected a refusal',
      ),
    )
    assert.ok(refusal instanceof CCTParamsInvalidError)
    assert.equal(refusal.context.param, 'newOwner')
  })

  it('moves a policy store through transfer and accept', async () => {
    await roundTrip(
      sepolia,
      store,
      (wallet) =>
        new TransferPolicyStoreOwnership().execute(sepolia.chain, {
          policyStore: store,
          newOwner,
          wallet,
        }),
      (wallet) =>
        new AcceptPolicyStoreOwnership().execute(sepolia.chain, { policyStore: store, wallet }),
    )
  })

  for (const hooks of [FUJI_HOOKS, FUJI_BLOCKLIST_HOOKS])
    it(`moves hook contract ${hooks} through transfer and accept`, async () => {
      await roundTrip(
        fuji,
        hooks,
        (wallet) =>
          new TransferMultiTokenPoolHooksOwnership().execute(fuji.chain, {
            hooks,
            newOwner,
            wallet,
          }),
        (wallet) => new AcceptMultiTokenPoolHooksOwnership().execute(fuji.chain, { hooks, wallet }),
      )
    })

  it('refuses an accept by anyone but the pending owner', async () => {
    const { owner } = await withForkRetry(() => readOwnership(sepolia.chain, CORE_POOL))
    const refusal = await withForkRetry(() =>
      rejectionOf(
        new AcceptMultiTokenPoolOwnership().generate(sepolia.chain, {
          poolAddress: CORE_POOL,
          sender: owner,
        }),
        'expected a refusal',
      ),
    )
    assert.ok(refusal instanceof CCTParamsInvalidError)
    assert.match(String(refusal.context.reason), /no ownership transfer is pending/)
  })

  describe('hook settings (Fuji)', () => {
    const state = (hooks: string) =>
      withForkRetry(() => new GetMultiTokenPoolHooksState().query(fuji.chain, { hooks }))
    const ownerWallet = async (hooks: string) =>
      impersonate(
        fuji.provider,
        (await withForkRetry(() => readOwnership(fuji.chain, hooks))).owner,
      )
    const refusal = (build: () => Promise<unknown>) =>
      withForkRetry(() => rejectionOf(build(), 'expected a refusal'))

    it('adds and removes an allowlisted sender', async (t) => {
      if (!(await state(FUJI_HOOKS)).allowlistEnabled)
        return t.skip('hooks built without an allowlist')
      const sender = Wallet.createRandom().address
      const op = new ApplyMultiTokenPoolHooksAllowlistUpdates()
      await mined(
        fuji.provider,
        op.execute(fuji.chain, {
          hooks: FUJI_HOOKS,
          adds: [sender],
          wallet: await ownerWallet(FUJI_HOOKS),
        }),
      )
      assert.ok((await state(FUJI_HOOKS)).allowlist.includes(getAddress(sender)))
      // adding it again changes nothing: refused, as main's applyAllowlistUpdates
      const again = await refusal(() =>
        op.generate(fuji.chain, { hooks: FUJI_HOOKS, adds: [sender] }),
      )
      assert.ok(again instanceof CCTParamsInvalidError && again.context.param === 'adds')
      await mined(
        fuji.provider,
        op.execute(fuji.chain, {
          hooks: FUJI_HOOKS,
          removes: [sender],
          wallet: await ownerWallet(FUJI_HOOKS),
        }),
      )
      assert.ok(!(await state(FUJI_HOOKS)).allowlist.includes(getAddress(sender)))
    })

    it('sets and clears the external blocklist; an EOA is refused before sending', async () => {
      const op = new SetMultiTokenPoolHooksBlocklist()
      const eoa = await refusal(() =>
        op.generate(fuji.chain, {
          hooks: FUJI_BLOCKLIST_HOOKS,
          blocklist: Wallet.createRandom().address,
        }),
      )
      assert.ok(eoa instanceof CCTParamsInvalidError && eoa.context.param === 'blocklist')
      // any contract with code passes the contract's own check (it is called only at transfer time)
      await mined(
        fuji.provider,
        op.execute(fuji.chain, {
          hooks: FUJI_BLOCKLIST_HOOKS,
          blocklist: FUJI_HOOKS,
          wallet: await ownerWallet(FUJI_BLOCKLIST_HOOKS),
        }),
      )
      assert.equal((await state(FUJI_BLOCKLIST_HOOKS)).blocklist, FUJI_HOOKS)
      await mined(
        fuji.provider,
        op.execute(fuji.chain, {
          hooks: FUJI_BLOCKLIST_HOOKS,
          blocklist: ZeroAddress,
          wallet: await ownerWallet(FUJI_BLOCKLIST_HOOKS),
        }),
      )
      assert.equal((await state(FUJI_BLOCKLIST_HOOKS)).blocklist, null)
    })

    it('refuses a policy engine that is an EOA, or that reverts attach() when simulated', async () => {
      const op = new SetMultiTokenPoolHooksPolicyEngine()
      const eoa = await refusal(() =>
        op.generate(fuji.chain, {
          hooks: FUJI_HOOKS,
          newPolicyEngine: Wallet.createRandom().address,
        }),
      )
      assert.ok(eoa instanceof CCTParamsInvalidError && eoa.context.param === 'newPolicyEngine')
      // a contract without attach(): the write reverts from the owner, named before any signature
      const { owner } = await withForkRetry(() => readOwnership(fuji.chain, FUJI_HOOKS))
      const reverted = await refusal(() =>
        op.generate(fuji.chain, {
          hooks: FUJI_HOOKS,
          newPolicyEngine: FUJI_BLOCKLIST_HOOKS,
          sender: owner,
        }),
      )
      assert.ok(reverted instanceof CCTParamsInvalidError)
      assert.equal(reverted.context.simulatedFrom, 'sender')
    })
  })

  it('refuses removing a pool from the hooks while it serves a lane on them; the check re-reads the lanes', async () => {
    // a live mttp-core lane (Sepolia → Fuji, inline records), and the Fuji hooks' code copied onto a
    // fresh Sepolia address (no MTTP hooks are deployed on Sepolia): owner set in its slot 1
    const token = getAddress('0x6377325E0D7F2E0D2Bc770860F0eB3B6c62F7cEd')
    const FUJI = 14767482510784806043n
    const config = '0x3F7Ba502948E1A74d2eF94908CA3e0Bb8f17C7Ca' // CONFIG_ROLE on mttp-core
    const pool = getAddress(CORE_POOL)
    const hooks = Wallet.createRandom().address
    const owner = Wallet.createRandom().address
    await sepolia.provider.send('anvil_setCode', [hooks, await fuji.provider.getCode(FUJI_HOOKS)])
    await sepolia.provider.send('anvil_setStorageAt', [
      hooks,
      toBeHex(1, 32),
      zeroPadValue(owner, 32),
    ])
    const cct = EVMTokenManager.fromChain(sepolia.chain)
    const getChain: ChainGetter = async (selector) =>
      BigInt(selector) === FUJI ? fuji.chain : sepolia.chain
    const callers = new UpdateMultiTokenPoolHooksAuthorizedCallers()
    await mined(
      sepolia.provider,
      callers.execute(sepolia.chain, {
        hooks,
        addedCallers: [pool],
        wallet: await impersonate(sepolia.provider, owner),
      }),
    )
    const lanes = [{ tokenAddress: token, remoteChainSelector: FUJI }]
    const [lane] = await withForkRetry(() =>
      cct.getMultiTokenPoolLaneVerifications({ poolAddress: pool, lanes }),
    )
    const security = (hook: string | null) => ({
      ...lanes[0]!,
      securityConfig: { outboundCCVs: lane!.outboundCCVs, inboundCCVs: lane!.inboundCCVs, hook },
    })
    const configWallet = await impersonate(sepolia.provider, config)
    const setSecurity = (hook: string | null) =>
      mined(
        sepolia.provider,
        cct.applyMultiTokenPoolInlineSecurityConfigUpdates({
          poolAddress: pool,
          set: [security(hook)],
          getChain,
          wallet: configWallet,
        }),
      )
    // a lane with a hook needs 100,000 more destination gas (the guard's minimum, 300,000)
    const { destOverhead } = await withForkRetry(() =>
      cct.getMultiTokenPoolInlineConfigs({ poolAddress: pool, tokenAddress: token }),
    )
    const overhead = destOverhead!.find((r) => r.remoteChainSelector === FUJI)!
    await mined(
      sepolia.provider,
      cct.applyMultiTokenPoolInlineDestOverheadConfigUpdates({
        poolAddress: pool,
        set: [
          {
            ...overhead,
            destOverheadConfig: { ...overhead.destOverheadConfig, destGasOverhead: 350_000 },
          },
        ],
        getChain,
        wallet: configWallet,
      }),
    )
    await setSecurity(hooks)
    const remove = { hooks, removedCallers: [pool] }
    const refusal = await withForkRetry(() =>
      rejectionOf(callers.generate(sepolia.chain, remove), 'expected a refusal'),
    )
    assert.ok(refusal instanceof CCTParamsInvalidError)
    assert.equal(refusal.context.param, 'removedCallers[0]')
    assert.match(String(refusal.context.reason), new RegExp(`${token}:${FUJI}`))
    const proposal = await callers.generate(sepolia.chain, {
      ...remove,
      confirmClosing: lanes,
      sender: owner,
    })
    assert.deepEqual(proposal.snapshot.expected[`removed.${pool}.lanes`], [`${token}:${FUJI}`])
    const check = () =>
      withForkRetry(() =>
        cct.checkMultiTokenPoolSnapshot({
          snapshot: proposal.snapshot,
          transaction: proposal,
          sender: owner,
        }),
      )
    assert.deepEqual((await check()).changed, [])
    // the lane leaves the hooks: the proposal was judged on a lane it no longer stops
    await setSecurity(null)
    const stale = await check()
    assert.equal(stale.ok, false)
    assert.deepEqual(
      stale.changed.map((c) => c.path),
      [`removed.${pool}.lanes`],
    )
  })
})
