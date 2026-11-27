/**
 * E7 writes end to end on an anvil fork of Sepolia, signed by the impersonated default admin of the
 * live "mttp-core" stack: grant, revoke and renounce a role; the default admin lifecycle (begin,
 * cancel, accept after the delay, change and roll back the delay, schedule and complete a renounce);
 * and a fee withdrawal through the PCM, its amounts read from the pool's logs.
 */

import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { Console } from 'node:console'
import { type AddressInfo, createServer } from 'node:net'
import { after, before, describe, it } from 'node:test'

import {
  type JsonRpcProvider,
  Interface,
  ZeroAddress,
  getAddress,
  solidityPackedKeccak256,
  toBeHex,
} from 'ethers'
import { Instance } from 'prool'

import { rpcEndpoint } from '../../../../../../scripts/test-endpoints.ts'
import { forkProvider } from '../../../../evm/fork-retry.test.helpers.ts'
import { findBalancesSlot } from '../../../../evm/gas.ts'
import { EVMChain } from '../../../../evm/index.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { EVMTokenManager } from '../../index.ts'
import { noteMinedBlock } from '../../mined-block.ts'
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

const CORE_POOL = '0x91b33bfc6B7E4ee5511BB654e9f93b6d3e72671b'
const FEE_TOKEN = '0x6377325E0D7F2E0D2Bc770860F0eB3B6c62F7cEd' // an mttp-core token, used as a fee token
const ALICE = getAddress('0x' + 'a1'.repeat(20))
const BOB = getAddress('0x' + 'b0'.repeat(20))
const ERC20 = new Interface(['function balanceOf(address) view returns (uint256)'])

describe('MTTP role, admin and fee writes (Sepolia fork)', { skip, timeout: 600_000 }, () => {
  let instance: ReturnType<typeof Instance.anvil> | undefined
  let provider: JsonRpcProvider
  let chain: EVMChain
  let cct: EVMTokenManager
  let admin: string
  let deployed = false
  const target = { poolAddress: CORE_POOL }

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
    provider = await forkProvider(instance, { logger: testLogger })
    chain = await EVMChain.fromProvider(provider, { apiClient: null, logger: testLogger })
    cct = EVMTokenManager.fromChain(chain)
    deployed = await cct.isMultiTokenPool(target)
    if (!deployed) return
    admin = (await cct.getPoolConfigManagerState(target)).defaultAdmin
    for (const account of [admin, ALICE, BOB]) {
      await provider.send('anvil_impersonateAccount', [account])
      await provider.send('anvil_setBalance', [account, '0x56BC75E2D63100000'])
    }
  })

  after(async () => {
    chain.provider.destroy()
    await instance?.stop()
  })

  const wallet = (account: string) => provider.getSigner(account)
  const mined = async (write: Promise<{ hash: string }>) =>
    assert.equal(await minedOn(provider, write), 1)
  const roles = async (account: string) =>
    (await cct.getMultiTokenPoolRoles({ ...target, accounts: [account] }))[0]!.roles
  const refused = (param: string, pattern: RegExp) => (e: unknown) =>
    e instanceof CCTParamsInvalidError && e.context.param === param && pattern.test(e.message)
  /**
   * Moves the fork's clock past `seconds` and mines, then records the new head: ethers caches the
   * block number, and a build pinned to the block before the warp would judge the old time.
   */
  const warp = async (seconds: number) => {
    await provider.send('evm_increaseTime', [seconds])
    await provider.send('evm_mine', [])
    noteMinedBlock(chain, Number(await provider.send('eth_blockNumber', [])))
  }

  it('the snapshot check re-reads what a role or admin proposal sealed (E7 B1)', async (t) => {
    if (!deployed) return t.skip('mttp-core not deployed')
    const adminWallet = await wallet(admin)
    // a grant proposal, then the role granted another way: the check reports the role
    const grant = { ...target, role: 'PAUSER_ROLE', account: ALICE } as const
    const proposal = await cct.generateUnsignedGrantMultiTokenPoolRole({ ...grant, sender: admin })
    const fresh = await cct.checkMultiTokenPoolSnapshot({
      snapshot: proposal.snapshot,
      transaction: proposal,
      sender: admin,
    })
    assert.deepEqual([fresh.ok, fresh.changed], [true, []])
    await mined(cct.grantMultiTokenPoolRole({ ...grant, wallet: adminWallet }))
    const stale = await cct.checkMultiTokenPoolSnapshot({
      snapshot: proposal.snapshot,
      transaction: proposal,
      sender: admin,
    })
    assert.equal(stale.ok, false)
    assert.deepEqual(
      stale.changed.map((c) => c.path),
      [`roles.PAUSER_ROLE.${ALICE}`],
    )
    await mined(cct.revokeMultiTokenPoolRole({ ...grant, wallet: adminWallet }))

    // the review's replay: a matured renounce proposal, cancelled, then a renounce scheduled again
    const { defaultAdminDelay } = await cct.getPoolConfigManagerState(target)
    const begin = () =>
      mined(
        cct.beginMultiTokenPoolDefaultAdminTransfer({
          ...target,
          newAdmin: ZeroAddress,
          wallet: adminWallet,
        }),
      )
    await begin()
    await warp(defaultAdminDelay + 1)
    const renounce = await cct.generateUnsignedRenounceMultiTokenPoolDefaultAdmin({
      ...target,
      sender: admin,
      confirmPermanentFreeze: true,
    })
    await mined(cct.cancelMultiTokenPoolDefaultAdminTransfer({ ...target, wallet: adminWallet }))
    await warp(1)
    await begin()
    await warp(defaultAdminDelay + 1)
    const replay = await cct.checkMultiTokenPoolSnapshot({
      snapshot: renounce.snapshot,
      transaction: renounce,
      sender: admin,
    })
    assert.equal(replay.ok, false)
    assert.deepEqual(
      replay.changed.map((c) => c.path),
      ['admin.pending'],
    )
    await mined(cct.cancelMultiTokenPoolDefaultAdminTransfer({ ...target, wallet: adminWallet }))
    assert.equal((await cct.getPoolConfigManagerState(target)).defaultAdmin, admin)
  })

  it('grants, revokes and renounces a role, refusing the writes that change nothing', async (t) => {
    if (!deployed) return t.skip('mttp-core not deployed')
    const grant = { ...target, role: 'PAUSER_ROLE', account: ALICE } as const
    await mined(cct.grantMultiTokenPoolRole({ ...grant, wallet: await wallet(admin) }))
    assert.ok((await roles(ALICE)).includes('PAUSER_ROLE'))
    await assert.rejects(
      cct.generateUnsignedGrantMultiTokenPoolRole({ ...grant, sender: admin }),
      refused('account', /already holds PAUSER_ROLE/),
    )
    // only the holder renounces; a non-holder is refused by the gate
    await assert.rejects(
      cct.generateUnsignedRenounceMultiTokenPoolRole({
        ...target,
        role: 'PAUSER_ROLE',
        sender: BOB,
      }),
      refused('sender', /holds none of PAUSER_ROLE/),
    )
    await mined(
      cct.renounceMultiTokenPoolRole({
        ...target,
        role: 'PAUSER_ROLE',
        sender: ALICE,
        wallet: await wallet(ALICE),
      }),
    )
    assert.ok(!(await roles(ALICE)).includes('PAUSER_ROLE'))
    await assert.rejects(
      cct.generateUnsignedRevokeMultiTokenPoolRole({ ...grant, sender: admin }),
      refused('account', /does not hold PAUSER_ROLE/),
    )
    await mined(cct.grantMultiTokenPoolRole({ ...grant, wallet: await wallet(admin) }))
    await mined(cct.revokeMultiTokenPoolRole({ ...grant, wallet: await wallet(admin) }))
    assert.ok(!(await roles(ALICE)).includes('PAUSER_ROLE'))
  })

  it('withdraws fee tokens through the PCM and reports the amounts from the logs', async (t) => {
    if (!deployed) return t.skip('mttp-core not deployed')
    // the pool holds 7 tokens of fees (set on the fork), and ALICE collects them
    const slot = await findBalancesSlot(FEE_TOKEN, provider)
    const amount = 7n * 10n ** 18n
    await provider.send('anvil_setStorageAt', [
      FEE_TOKEN,
      solidityPackedKeccak256(['uint256', 'uint256'], [CORE_POOL, slot]),
      toBeHex(amount, 32),
    ])
    const params = { ...target, feeTokens: [FEE_TOKEN], recipient: BOB }
    await assert.rejects(
      cct.generateUnsignedWithdrawMultiTokenPoolFeeTokens({ ...params, sender: ALICE }),
      refused('sender', /FEE_COLLECTOR_ROLE/),
    )
    await assert.rejects(
      cct.generateUnsignedWithdrawMultiTokenPoolFeeTokens({ ...params, poolConfigManager: BOB }),
      refused('poolConfigManager', /is not the PoolConfigManager/),
    )
    await mined(
      cct.grantMultiTokenPoolRole({
        ...target,
        role: 'FEE_COLLECTOR_ROLE',
        account: ALICE,
        wallet: await wallet(admin),
      }),
    )
    const result = await cct.withdrawMultiTokenPoolFeeTokens({
      ...params,
      wallet: await wallet(ALICE),
    })
    assert.deepEqual(result.withdrawn, [{ token: getAddress(FEE_TOKEN), amount }])
    const balance = await provider.call({
      to: FEE_TOKEN,
      data: ERC20.encodeFunctionData('balanceOf', [BOB]),
    })
    assert.equal(BigInt(balance), amount)
  })

  it('runs the default admin lifecycle: cancel, delay change and rollback, accept, renounce', async (t) => {
    if (!deployed) return t.skip('mttp-core not deployed')
    const { defaultAdminDelay } = await cct.getPoolConfigManagerState(target)
    // the warp records the mined head: a build must never pin before it (E7 M4)
    const wait = () => warp(defaultAdminDelay + 1)
    // nothing pending: cancel and rollback are refused
    await assert.rejects(
      cct.generateUnsignedCancelMultiTokenPoolDefaultAdminTransfer({ ...target, sender: admin }),
      refused('poolAddress', /no pending default-admin transfer to cancel/),
    )
    await assert.rejects(
      cct.generateUnsignedRollbackMultiTokenPoolDefaultAdminDelay({ ...target, sender: admin }),
      refused('poolAddress', /no pending default-admin delay change/),
    )
    const adminWallet = await wallet(admin)
    // a delay change, rolled back
    await mined(
      cct.changeMultiTokenPoolDefaultAdminDelay({ ...target, newDelay: 3600, wallet: adminWallet }),
    )
    assert.ok('pendingDefaultAdminDelay' in (await cct.getPoolConfigManagerState(target)))
    await mined(cct.rollbackMultiTokenPoolDefaultAdminDelay({ ...target, wallet: adminWallet }))
    assert.ok(!('pendingDefaultAdminDelay' in (await cct.getPoolConfigManagerState(target))))
    // a transfer to BOB, cancelled
    await mined(
      cct.beginMultiTokenPoolDefaultAdminTransfer({
        ...target,
        newAdmin: BOB,
        wallet: adminWallet,
      }),
    )
    await assert.rejects(
      cct.generateUnsignedAcceptMultiTokenPoolDefaultAdminTransfer({ ...target, sender: ALICE }),
      refused('sender', /must be the pending default admin/),
    )
    await mined(cct.cancelMultiTokenPoolDefaultAdminTransfer({ ...target, wallet: adminWallet }))
    // a transfer to BOB, accepted after the delay
    await mined(
      cct.beginMultiTokenPoolDefaultAdminTransfer({
        ...target,
        newAdmin: BOB,
        wallet: adminWallet,
      }),
    )
    await wait()
    await mined(
      cct.acceptMultiTokenPoolDefaultAdminTransfer({ ...target, wallet: await wallet(BOB) }),
    )
    assert.equal((await cct.getPoolConfigManagerState(target)).defaultAdmin, BOB)
    // BOB schedules a renounce: refused before it matures, and without the confirmation
    const bobWallet = await wallet(BOB)
    await mined(
      cct.beginMultiTokenPoolDefaultAdminTransfer({
        ...target,
        newAdmin: ZeroAddress,
        wallet: bobWallet,
      }),
    )
    const state = await cct.getPoolConfigManagerState(target)
    assert.equal(state.pendingDefaultAdmin?.newAdmin, ZeroAddress)
    await assert.rejects(
      cct.generateUnsignedAcceptMultiTokenPoolDefaultAdminTransfer({ ...target, sender: BOB }),
      refused(
        'poolAddress',
        /renunciation, which must be completed with renounceMultiTokenPoolDefaultAdmin/,
      ),
    )
    if (defaultAdminDelay > 0)
      await assert.rejects(
        cct.generateUnsignedRenounceMultiTokenPoolDefaultAdmin({
          ...target,
          sender: BOB,
          confirmPermanentFreeze: true,
        }),
        refused('poolAddress', /matures at/),
      )
    await wait()
    // a pauser with no unpauser: after the renounce the next pause would be permanent (E7 M1)
    const { holders } = await cct.getMultiTokenPoolRoleHolders(target)
    for (const account of holders.UNPAUSER_ROLE)
      await mined(
        cct.revokeMultiTokenPoolRole({
          ...target,
          role: 'UNPAUSER_ROLE',
          account,
          wallet: bobWallet,
        }),
      )
    await mined(
      cct.grantMultiTokenPoolRole({
        ...target,
        role: 'PAUSER_ROLE',
        account: ALICE,
        wallet: bobWallet,
      }),
    )
    await assert.rejects(
      cct.generateUnsignedRenounceMultiTokenPoolDefaultAdmin({
        ...target,
        sender: BOB,
        confirmPermanentFreeze: true,
      }),
      refused('confirmPermanentPauses', /PAUSER_ROLE has holders/),
    )
    await mined(
      cct.renounceMultiTokenPoolDefaultAdmin({
        ...target,
        confirmPermanentFreeze: true,
        confirmPermanentPauses: true,
        sender: BOB,
        wallet: bobWallet,
      }),
    )
    assert.equal((await cct.getPoolConfigManagerState(target)).defaultAdmin, ZeroAddress)
  })
})
