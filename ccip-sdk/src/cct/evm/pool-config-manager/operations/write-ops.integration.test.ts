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
import { CCTContractTypeInvalidError, CCTParamsInvalidError } from '../../../errors.ts'
import { EVMTokenManager } from '../../index.ts'
import {
  MultiTokenPoolVersion,
  POOL_CONFIG_MANAGER_TYPE,
  getMultiTokenPoolInterface,
} from '../../multi-token-pool/contracts.ts'
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

  it('without a sender, simulates the store calls from the PoolConfigManager (A20)', async (t) => {
    if (!deployed) return t.skip('v5v9 not deployed')
    const unsigned = await cct.generateUnsignedApplyMultiTokenPoolTokenProfileUpdates({
      poolAddress: CORE_POOL,
      getChain,
      profilesToUpdate: [{ tokenAddress: CORE_TOKEN, allowedFinality: { finalityDepth: 5 } }],
    })
    assert.equal(unsigned.simulatedFrom, 'pcm')
    assert.equal(unsigned.transactions[0]!.from, undefined)
    testLogger.info(`no-sender projectionVerified: ${unsigned.projectionVerified}`)
  })

  it('refuses an unknown policy and a rate limit policy of other decimals, naming the record type', async (t) => {
    if (!deployed) return t.skip('v5v9 not deployed')
    const assign = (recordType: 'fee' | 'rateLimit', policyName: string) =>
      cct.generateUnsignedApplyMultiTokenPoolTokenPolicyUpdates({
        ...core,
        getChain,
        recordType,
        assignments: [{ tokenAddress: CORE_TOKEN, policyName }],
      })
    await assert.rejects(
      assign('fee', 'no-such-policy'),
      (e: unknown) =>
        e instanceof CCTParamsInvalidError &&
        e.context.param === 'assignments[0].policyName' &&
        e.context.recordType === 'fee' &&
        /PolicyNotFound/.test(e.message),
    )
    // sc6 is a 6-decimal rate limit policy; the core token has 18 decimals
    await assert.rejects(
      assign('rateLimit', 'sc6'),
      (e: unknown) =>
        e instanceof CCTParamsInvalidError &&
        e.context.recordType === 'rateLimit' &&
        /InvalidRateLimitPolicyDecimals/.test(e.message),
    )
  })

  it('reads the PoolConfigManager state once per build (D38)', async (t) => {
    if (!deployed) return t.skip('v5v9 not deployed')
    const pcm = getMultiTokenPoolInterface(
      POOL_CONFIG_MANAGER_TYPE,
      MultiTokenPoolVersion.V2_1_0_DEV,
    )
    const counted = {
      [pcm.getFunction('getPolicyNames')!.selector]: 'getPolicyNames',
      [pcm.getFunction('getTokenConfigBatch')!.selector]: 'getTokenConfigBatch',
    }
    const counts: Record<string, number> = {}
    const provider = cct.chain.provider
    const call = provider.call.bind(provider)
    provider.call = (tx) => {
      const name = counted[String(tx.data).slice(0, 10)]
      if (name) counts[name] = (counts[name] ?? 0) + 1
      return call(tx)
    }
    try {
      await cct.generateUnsignedApplyMultiTokenPoolTokenProfileUpdates({
        ...core,
        getChain,
        profilesToUpdate: [{ tokenAddress: CORE_TOKEN, allowedFinality: { finalityDepth: 5 } }],
      })
    } finally {
      provider.call = call
    }
    // one full state read for the op and the guard; the profiles come from it
    assert.deepEqual(counts, { getPolicyNames: 1, getTokenConfigBatch: 1 })
  })

  it('redirects every single-token op given a multi-token pool to its MTTP op', async (t) => {
    if (!deployed) return t.skip('v5v9 not deployed')
    const FUJI_SELECTOR = 14767482510784806043n
    const pool = { poolAddress: CORE_POOL }
    const redirects: [Promise<unknown>, RegExp][] = [
      [
        cct.generateUnsignedAddRemotePool({
          ...pool,
          remoteChainSelector: FUJI_SELECTOR,
          remotePoolAddress: CORE_POOL,
        }),
        /applyMultiTokenPoolInlineRemotePoolConfigUpdates/,
      ],
      [
        cct.generateUnsignedRemoveRemotePool({
          ...pool,
          remoteChainSelector: FUJI_SELECTOR,
          remotePoolAddress: CORE_POOL,
        }),
        /applyMultiTokenPoolInlineRemotePoolConfigUpdates/,
      ],
      [
        cct.generateUnsignedSetAllowedFinalityConfig({
          ...pool,
          allowedFinality: { finalityDepth: 5 },
        }),
        /applyMultiTokenPoolTokenProfileUpdates/,
      ],
      [
        cct.generateUnsignedSetChainRateLimiterConfigs({
          ...pool,
          updates: [
            {
              remoteChainSelector: FUJI_SELECTOR,
              outboundRateLimiterConfig: { enabled: false },
              inboundRateLimiterConfig: { enabled: false },
            },
          ],
        }),
        /applyMultiTokenPoolInlineRateLimitConfigUpdates/,
      ],
      [
        cct.generateUnsignedApplyTokenTransferFeeConfigUpdates({
          ...pool,
          updates: [],
          disables: [FUJI_SELECTOR],
        }),
        /applyMultiTokenPoolInlineFeeConfigUpdates and applyMultiTokenPoolInlineDestOverheadConfigUpdates/,
      ],
      [
        cct.generateUnsignedApplyCCVConfigUpdates({
          ...pool,
          ccvConfigArgs: [
            {
              remoteChainSelector: FUJI_SELECTOR,
              outboundCCVs: [],
              thresholdOutboundCCVs: [],
              inboundCCVs: [],
              thresholdInboundCCVs: [],
            },
          ],
        }),
        /applyMultiTokenPoolInlineSecurityConfigUpdates/,
      ],
    ]
    for (const [built, op] of redirects)
      await assert.rejects(
        built,
        (e: unknown) =>
          e instanceof CCTContractTypeInvalidError && op.test(String(e.context.reason)),
      )
  })

  it('builds every E6 write through the facade, re-setting the live values (no-op writes)', async (t) => {
    if (!deployed) return t.skip('v5v9 not deployed')
    const FUJI_SELECTOR = 14767482510784806043n
    const INLINE_TOKEN = '0x6377325E0D7F2E0D2Bc770860F0eB3B6c62F7cEd'
    const POLICY_TOKEN = '0x3bb6c12433D96771B2B7B1c3D0Bbe27879e12d17'
    const target = { poolAddress: CORE_POOL, getChain }
    const lane = { tokenAddress: INLINE_TOKEN, remoteChainSelector: FUJI_SELECTOR }
    const inline = await cct.getMultiTokenPoolInlineConfigs({
      poolAddress: CORE_POOL,
      tokenAddress: INLINE_TOKEN,
    })
    const policy = { poolAddress: CORE_POOL, policyName: 'core-pol' }
    const fuji = <R extends { remoteChainSelector: bigint }>(records: R[]) =>
      records.filter((r) => r.remoteChainSelector === FUJI_SELECTOR)
    const [rateLimit, fee, destOverhead, security] = await Promise.all([
      cct.getMultiTokenPoolRateLimitPolicy(policy),
      cct.getMultiTokenPoolFeePolicy(policy),
      cct.getMultiTokenPoolDestOverheadPolicy(policy),
      cct.getMultiTokenPoolSecurityPolicy(policy),
    ])
    const builds = {
      inlineRateLimit: cct.generateUnsignedApplyMultiTokenPoolInlineRateLimitConfigUpdates({
        ...target,
        set: inline.rateLimit!,
      }),
      inlineFee: cct.generateUnsignedApplyMultiTokenPoolInlineFeeConfigUpdates({
        ...target,
        set: inline.fee!,
      }),
      inlineDestOverhead: cct.generateUnsignedApplyMultiTokenPoolInlineDestOverheadConfigUpdates({
        ...target,
        set: inline.destOverhead!,
      }),
      inlineSecurity: cct.generateUnsignedApplyMultiTokenPoolInlineSecurityConfigUpdates({
        ...target,
        set: inline.security!,
      }),
      rateLimitPolicy: cct.generateUnsignedApplyMultiTokenPoolRateLimitPolicyConfigUpdates({
        ...target,
        recordsToSet: fuji(rateLimit.records),
      }),
      feePolicy: cct.generateUnsignedApplyMultiTokenPoolFeePolicyConfigUpdates({
        ...target,
        recordsToSet: fuji(fee.records),
      }),
      destOverheadPolicy: cct.generateUnsignedApplyMultiTokenPoolDestOverheadPolicyConfigUpdates({
        ...target,
        recordsToSet: fuji(destOverhead.records),
      }),
      securityPolicy: cct.generateUnsignedApplyMultiTokenPoolSecurityPolicyConfigUpdates({
        ...target,
        recordsToSet: fuji(security.records),
      }),
      inlineBucket: cct.generateUnsignedApplyMultiTokenPoolInlineRateLimitBucketUpdates({
        ...target,
        updates: [
          { ...lane, direction: 'outbound', fastFinality: false, config: { enabled: false } },
        ],
      }),
      policyBucket: cct.generateUnsignedApplyMultiTokenPoolRateLimitPolicyBucketUpdates({
        ...target,
        updates: [
          {
            policyName: 'core-pol',
            remoteChainSelector: FUJI_SELECTOR,
            direction: 'inbound',
            fastFinality: false,
            config: fuji(rateLimit.records)[0]!.rateLimits.inbound,
          },
        ],
      }),
      pauseTokens: cct.generateUnsignedPauseMultiTokenPoolTokens({
        poolAddress: CORE_POOL,
        tokenAddresses: [POLICY_TOKEN],
        direction: 'outbound',
      }),
      stop: cct.generateUnsignedStopMultiTokenPoolLanes({
        poolAddress: CORE_POOL,
        lanes: [{ tokenAddress: POLICY_TOKEN, remoteChainSelector: FUJI_SELECTOR }],
        direction: 'outbound',
      }),
    }
    for (const [name, built] of Object.entries(builds)) {
      const unsigned = await built
      testLogger.info(
        `${name}: simulatedFrom ${unsigned.simulatedFrom}, projectionVerified ${unsigned.projectionVerified}, ${unsigned.affectedLanes.length} lane(s)`,
      )
      assert.equal(unsigned.transactions.length, 1, name)
    }
  })

  it('builds the E7 role, admin and fee writes through the facade, and names the state refusals', async (t) => {
    if (!deployed) return t.skip('v5v9 not deployed')
    const target = { poolAddress: CORE_POOL }
    const FRESH = '0x00000000000000000000000000000000000E7E7E'
    const built = [
      await cct.generateUnsignedGrantMultiTokenPoolRole({
        ...target,
        role: 'PAUSER_ROLE',
        account: FRESH,
      }),
      await cct.generateUnsignedBeginMultiTokenPoolDefaultAdminTransfer({
        ...target,
        newAdmin: FRESH,
      }),
      await cct.generateUnsignedChangeMultiTokenPoolDefaultAdminDelay({ ...target, newDelay: 60 }),
      await cct.generateUnsignedWithdrawMultiTokenPoolFeeTokens({
        ...target,
        feeTokens: ['0x6377325E0D7F2E0D2Bc770860F0eB3B6c62F7cEd'],
        recipient: FRESH,
      }),
    ]
    for (const unsigned of built) {
      // record-free: nothing projected, nothing simulated without a sender
      assert.deepEqual(unsigned.affectedLanes, [])
      assert.equal(unsigned.simulatedFrom, 'none')
    }
    const refused = (param: string, pattern: RegExp) => (e: unknown) =>
      e instanceof CCTParamsInvalidError && e.context.param === param && pattern.test(e.message)
    // the live PCM has no pending transfer and no pending delay change
    const state = await cct.getPoolConfigManagerState(target)
    if (!('pendingDefaultAdmin' in state)) {
      await assert.rejects(
        cct.generateUnsignedAcceptMultiTokenPoolDefaultAdminTransfer(target),
        refused('poolAddress', /no pending default-admin transfer/),
      )
      await assert.rejects(
        cct.generateUnsignedCancelMultiTokenPoolDefaultAdminTransfer(target),
        refused('poolAddress', /to cancel/),
      )
      await assert.rejects(
        cct.generateUnsignedRenounceMultiTokenPoolDefaultAdmin({
          ...target,
          sender: state.defaultAdmin,
          confirmPermanentFreeze: true,
        }),
        refused('poolAddress', /no scheduled renounce/),
      )
    }
    if (!('pendingDefaultAdminDelay' in state))
      await assert.rejects(
        cct.generateUnsignedRollbackMultiTokenPoolDefaultAdminDelay(target),
        refused('poolAddress', /no pending default-admin delay change/),
      )
    await assert.rejects(
      cct.generateUnsignedRevokeMultiTokenPoolRole({
        ...target,
        role: 'PAUSER_ROLE',
        account: FRESH,
      }),
      refused('account', /does not hold PAUSER_ROLE/),
    )
  })
})
