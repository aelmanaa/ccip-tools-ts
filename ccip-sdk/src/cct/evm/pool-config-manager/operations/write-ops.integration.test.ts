/**
 * The MTTP write ops built live and read-only on Sepolia: every write is projected, guarded and
 * `eth_call`ed from the stack's role holder, never sent.
 *
 * Skips (does not fail) when the pool is no longer a multi-token pool; RPC errors still fail.
 */
import assert from 'node:assert/strict'
import { Console } from 'node:console'
import { before, describe, it } from 'node:test'

import { reachableRpcEndpoint } from '../../../../../../scripts/test-endpoints.ts'
import { useResource } from '../../../../../../scripts/useResource.ts'
import type { ChainGetter } from '../../../../chain.ts'
import { EVMChain } from '../../../../evm/index.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { EVMTokenManager } from '../../index.ts'
import type { ApplyMultiTokenPoolTokenPolicyUpdatesParams } from './apply-multi-token-pool-token-policy-updates.ts'

const skip = !!process.env.SKIP_INTEGRATION_TESTS

await useResource(['sepolia', 'fuji'])

const testLogger = new Console(process.stdout, process.stderr)
if (!process.env.VERBOSE) testLogger.debug = () => {}

const FUJI = 14767482510784806043n
const V5V9_POOL = '0x6304228a2908E45fC87f6cc685E6fC309f5A8624'
/** Every v5v9 PCM role, the funded test signer. */
const OPERATOR = '0x9d087fC03ae39b088326b67fA3C788236645b717'
/** The mttp-core stack: a healthy Sepolia ↔ Fuji lane, and its CONFIG_ROLE holder. */
const CORE_POOL = '0x91b33bfc6B7E4ee5511BB654e9f93b6d3e72671b'
const CORE_OPERATOR = '0x3F7Ba502948E1A74d2eF94908CA3e0Bb8f17C7Ca'
const CORE_TOKEN = '0x6377325E0D7F2E0D2Bc770860F0eB3B6c62F7cEd'
/** The v5v9 factory UID provider; it maps only that factory's tokens. */
const UID_PROVIDER = '0x9359b78A22AE3Aa7EEfa4AB69A530B9afB20b5dC'
/** A v5v9 token whose connection comes from policy v5 (its Fuji side has no code). */
const TOKEN = '0x0a75baaC1fC96Af3F91c3e4a364Fd81e7B4dCf49'

describe('MTTP write ops, built read-only (Sepolia)', { skip, timeout: 600_000 }, () => {
  let cct: EVMTokenManager
  let getChain: ChainGetter
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
    cct = EVMTokenManager.fromChain(sepolia)
    getChain = async (selector) => {
      if (BigInt(selector) === fuji.network.chainSelector) return fuji
      throw new CCTParamsInvalidError('test', 'getChain', `no RPC for ${selector}`)
    }
    deployed = await cct.isMultiTokenPool({ poolAddress: V5V9_POOL })
  })

  const clearConnection: ApplyMultiTokenPoolTokenPolicyUpdatesParams = {
    poolAddress: V5V9_POOL,
    recordType: 'connection',
    assignments: [{ tokenAddress: TOKEN, policyName: null }],
  }

  it('refuses a policy clear that closes a lane, naming the record type', async (t) => {
    if (!deployed) return t.skip('v5v9 not deployed')
    await assert.rejects(
      cct.generateUnsignedApplyMultiTokenPoolTokenPolicyUpdates({
        ...clearConnection,
        sender: OPERATOR,
        getChain,
      }),
      (e: unknown) =>
        e instanceof CCTParamsInvalidError &&
        e.context.param === 'guards' &&
        e.context.recordType === 'connection' &&
        (e.context.findings as { check: string }[]).some((f) => f.check === 'LANE_CLOSED'),
    )
  })

  it('builds the clear once the closing is confirmed, with what a reviewer needs', async (t) => {
    if (!deployed) return t.skip('v5v9 not deployed')
    const lane = { tokenAddress: TOKEN, remoteChainSelector: FUJI }
    const unsigned = await cct.generateUnsignedApplyMultiTokenPoolTokenPolicyUpdates({
      ...clearConnection,
      sender: OPERATOR,
      getChain,
      confirmClosing: [lane],
    })
    assert.equal(unsigned.transactions.length, 1)
    assert.deepEqual(unsigned.affectedLanes, [lane])
    assert.deepEqual(unsigned.goingLive, [])
    assert.deepEqual(
      unsigned.warnings.map((w) => w.check),
      ['LANE_CLOSED'],
    )
    assert.equal(unsigned.snapshot.operation, 'applyMultiTokenPoolTokenPolicyUpdates')
    assert.equal(unsigned.snapshot.expected[`policies.connection.${TOKEN}`], 'v5')
    testLogger.info(`projectionVerified: ${unsigned.projectionVerified}`)
    // the proposal re-checks clean through the snapshot check
    const check = await cct.checkMultiTokenPoolSnapshot({
      snapshot: unsigned.snapshot,
      transaction: unsigned,
      sender: OPERATOR,
      getChain,
    })
    assert.equal(check.ok, true)
  })

  it('refuses a sender that holds none of the gate roles before any guard read', async (t) => {
    if (!deployed) return t.skip('v5v9 not deployed')
    await assert.rejects(
      cct.generateUnsignedApplyMultiTokenPoolTokenPolicyUpdates({
        ...clearConnection,
        sender: '0x000000000000000000000000000000000000dEaD',
        getChain,
        confirmClosing: [{ tokenAddress: TOKEN, remoteChainSelector: FUJI }],
      }),
      (e: unknown) =>
        e instanceof CCTParamsInvalidError &&
        e.context.param === 'sender' &&
        JSON.stringify(e.context.roles) ===
          JSON.stringify(['CONFIG_ROLE', 'TOKEN_MANAGER_ROLE', 'CONNECTION_ROLE']),
    )
  })

  const core = { poolAddress: CORE_POOL, sender: CORE_OPERATOR } as const

  it("builds a profile update and judges the token's lanes again", async (t) => {
    if (!deployed) return t.skip('v5v9 not deployed')
    const unsigned = await cct.generateUnsignedApplyMultiTokenPoolTokenProfileUpdates({
      ...core,
      getChain,
      profilesToUpdate: [{ tokenAddress: CORE_TOKEN, allowedFinality: { finalityDepth: 5 } }],
    })
    assert.equal(unsigned.snapshot.operation, 'applyMultiTokenPoolTokenProfileUpdates')
    assert.deepEqual(unsigned.affectedLanes, [
      { tokenAddress: CORE_TOKEN, remoteChainSelector: FUJI },
    ])
    assert.ok(unsigned.snapshot.expected[`profiles.${CORE_TOKEN}`])
    testLogger.info(`profile update projectionVerified: ${unsigned.projectionVerified}`)
  })

  it('refuses a live provider change without allowLiveProfileChange (F1)', async (t) => {
    if (!deployed) return t.skip('v5v9 not deployed')
    await assert.rejects(
      cct.generateUnsignedApplyMultiTokenPoolTokenProfileUpdates({
        ...core,
        getChain,
        profilesToUpdate: [{ tokenAddress: CORE_TOKEN, additionalPoolDataProvider: UID_PROVIDER }],
      }),
      (e: unknown) =>
        e instanceof CCTParamsInvalidError && e.context.param === 'allowLiveProfileChange',
    )
  })

  it('refuses, even when allowed, a provider that does not map the token: every send would revert', async (t) => {
    if (!deployed) return t.skip('v5v9 not deployed')
    await assert.rejects(
      cct.generateUnsignedApplyMultiTokenPoolTokenProfileUpdates({
        ...core,
        getChain,
        allowLiveProfileChange: true,
        profilesToUpdate: [{ tokenAddress: CORE_TOKEN, additionalPoolDataProvider: UID_PROVIDER }],
      }),
      (e: unknown) =>
        e instanceof CCTParamsInvalidError &&
        e.context.param === 'guards' &&
        (e.context.findings as { check: string; reason: string }[]).some(
          (f) => f.check === 'UID_MISMATCH' && /refuses to produce data/.test(f.reason),
        ),
    )
  })

  it("refuses 'lock' on a pool that does not serve it (F13)", async (t) => {
    if (!deployed) return t.skip('v5v9 not deployed')
    await assert.rejects(
      cct.generateUnsignedApplyMultiTokenPoolTokenProfileUpdates({
        ...core,
        getChain,
        allowLiveProfileChange: true,
        profilesToUpdate: [
          { tokenAddress: CORE_TOKEN, lockOrBurnFlavor: 'lock', lockOrBurnAddress: CORE_OPERATOR },
        ],
      }),
      (e: unknown) =>
        e instanceof CCTParamsInvalidError &&
        e.context.param === 'profilesToUpdate[0].lockOrBurnFlavor',
    )
  })

  it('refuses deregistering a token with config left, and registering a registered one', async (t) => {
    if (!deployed) return t.skip('v5v9 not deployed')
    await assert.rejects(
      cct.generateUnsignedApplyMultiTokenPoolTokenProfileUpdates({
        poolAddress: V5V9_POOL,
        sender: OPERATOR,
        tokensToRemove: [TOKEN],
      }),
      (e: unknown) => e instanceof CCTParamsInvalidError && e.context.param === 'tokensToRemove[0]',
    )
    await assert.rejects(
      cct.generateUnsignedApplyMultiTokenPoolTokenProfileUpdates({
        ...core,
        profilesToSet: [
          {
            tokenAddress: CORE_TOKEN,
            lockOrBurnFlavor: 'burn',
            allowedFinality: { finalityDepth: 0 },
            lockOrBurnAddress: null,
            additionalPoolDataProvider: null,
          },
        ],
      }),
      (e: unknown) =>
        e instanceof CCTParamsInvalidError && e.context.param === 'profilesToSet[0].tokenAddress',
    )
  })
})
