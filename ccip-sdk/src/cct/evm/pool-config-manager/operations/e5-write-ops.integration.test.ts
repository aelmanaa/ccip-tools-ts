/**
 * The E5 connection, subset, provider and remote pool writes, built live and read-only on the Sepolia
 * mttp-core stack: every write is projected, guarded and `eth_call`ed from the CONFIG_ROLE holder,
 * never sent.
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

const skip = !!process.env.SKIP_INTEGRATION_TESTS

await useResource(['sepolia', 'fuji'])

const testLogger = new Console(process.stdout, process.stderr)
if (!process.env.VERBOSE) testLogger.debug = () => {}

const FUJI = 14767482510784806043n
const CORE_POOL = '0x91b33bfc6B7E4ee5511BB654e9f93b6d3e72671b'
const CORE_OPERATOR = '0x3F7Ba502948E1A74d2eF94908CA3e0Bb8f17C7Ca'
/** An inline-only token on a healthy Fuji lane. */
const INLINE_TOKEN = '0x6377325E0D7F2E0D2Bc770860F0eB3B6c62F7cEd'
/** A token on connection policy core-pol. */
const POLICY_TOKEN = '0x3bb6c12433D96771B2B7B1c3D0Bbe27879e12d17'
/** A token whose inline remote pool record sends legacy data. */
const LEGACY_TOKEN = '0xE1ac2D2F2F60f8cC82A4A7134853118349F8e0a4'
/** A token whose inline remote pool record trusts two pools. */
const TWO_POOL_TOKEN = '0x84557ba2481E757553F479299f6Df129017320Dc'
const TWO_POOLS = [
  '0xD14C91AD5C5cb41c5E58e75FD09f1EE60aA08F2e',
  '0x45289275807E88A197391E060589D647e64519D5',
]

const refusedAt =
  (param: string, pattern?: RegExp) =>
  (e: unknown): boolean =>
    e instanceof CCTParamsInvalidError &&
    e.context.param === param &&
    (pattern === undefined || pattern.test(e.message))

describe(
  'MTTP E5 write ops, built read-only (Sepolia mttp-core)',
  { skip, timeout: 900_000 },
  () => {
    let cct: EVMTokenManager
    let getChain: ChainGetter
    let deployed = false
    const core = { poolAddress: CORE_POOL, sender: CORE_OPERATOR } as const

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
      deployed = await cct.isMultiTokenPool({ poolAddress: CORE_POOL })
    })

    it('refuses removing a connection policy still in use, naming the fix', async (t) => {
      if (!deployed) return t.skip('mttp-core not deployed')
      await assert.rejects(
        cct.generateUnsignedApplyMultiTokenPoolConnectionPolicyConfigUpdates({
          ...core,
          getChain,
          policiesToRemove: ['core-pol'],
        }),
        refusedAt('policiesToRemove[0]', /PolicyInUse/),
      )
    })

    it('refuses a subset add for a token not in the policy, and builds one for a policy token', async (t) => {
      if (!deployed) return t.skip('mttp-core not deployed')
      await assert.rejects(
        cct.generateUnsignedApplyMultiTokenPoolSubsetTokenUpdates({
          ...core,
          getChain,
          add: [{ policyName: 'core-pol', remoteChainSelector: FUJI, tokenAddress: INLINE_TOKEN }],
        }),
        refusedAt('add[0].tokenAddress', /TokenNotInPolicy/),
      )
      // the record is not a subset record: the add changes no lane, and the write is simulated
      const unsigned = await cct.generateUnsignedApplyMultiTokenPoolSubsetTokenUpdates({
        ...core,
        getChain,
        add: [{ policyName: 'core-pol', remoteChainSelector: FUJI, tokenAddress: POLICY_TOKEN }],
      })
      assert.equal(unsigned.simulatedFrom, 'sender')
      assert.equal(unsigned.snapshot.operation, 'applyMultiTokenPoolSubsetTokenUpdates')
    })

    it('builds a provider update that keeps the provider, and refuses an unknown policy', async (t) => {
      if (!deployed) return t.skip('mttp-core not deployed')
      const lanes = await cct.getMultiTokenPoolConnectionPolicy({
        poolAddress: CORE_POOL,
        policyName: 'core-pol',
      })
      const provider = lanes.remoteTokenAddressProvider!
      const unsigned =
        await cct.generateUnsignedApplyMultiTokenPoolRemoteTokenAddressProviderUpdates({
          ...core,
          getChain,
          updates: [{ policyName: 'core-pol', remoteTokenAddressProvider: provider }],
        })
      // the snapshot seals the provider the write replaces
      const sealed = Object.entries(unsigned.snapshot.expected).find(([k]) =>
        k.startsWith('providers.'),
      )
      assert.equal(sealed?.[1], provider)
      await assert.rejects(
        cct.generateUnsignedApplyMultiTokenPoolRemoteTokenAddressProviderUpdates({
          ...core,
          getChain,
          updates: [{ policyName: 'no-such-policy', remoteTokenAddressProvider: provider }],
        }),
        refusedAt('updates[0].policyName', /PolicyNotFound/),
      )
    })

    it('refuses removing an inline remote pool record that sends legacy data', async (t) => {
      if (!deployed) return t.skip('mttp-core not deployed')
      await assert.rejects(
        cct.generateUnsignedApplyMultiTokenPoolInlineRemotePoolConfigUpdates({
          ...core,
          getChain,
          remove: [{ tokenAddress: LEGACY_TOKEN, remoteChainSelector: FUJI }],
        }),
        refusedAt('remove[0]', /LegacyRemotePoolRecord/),
      )
    })

    it('refuses a set that drops a pool unless confirmed, then judges the lane with the confirmation', async (t) => {
      if (!deployed) return t.skip('mttp-core not deployed')
      const set = [
        {
          tokenAddress: TWO_POOL_TOKEN,
          remoteChainSelector: FUJI,
          trustPolicyRemotePools: false,
          poolDataFormat: 'long' as const,
          remotePools: [{ address: TWO_POOLS[0]!, allowLegacyPoolData: false }],
        },
      ]
      await assert.rejects(
        cct.generateUnsignedApplyMultiTokenPoolInlineRemotePoolConfigUpdates({
          ...core,
          getChain,
          set,
        }),
        (e: unknown) =>
          refusedAt('confirmDropped')(e) &&
          JSON.stringify((e as CCTParamsInvalidError).context.remotePools) ===
            JSON.stringify([TWO_POOLS[1]]),
      )
      // confirmed: the drop guard passes and the lane guard decides (it may still refuse the lane)
      await cct
        .generateUnsignedApplyMultiTokenPoolInlineRemotePoolConfigUpdates({
          ...core,
          getChain,
          set,
          confirmDropped: [
            {
              lane: { tokenAddress: TWO_POOL_TOKEN, remoteChainSelector: FUJI },
              remotePools: [TWO_POOLS[1]!],
            },
          ],
        })
        .then(
          (u) =>
            testLogger.info(
              `drop confirmed: built, warnings ${u.warnings.map((w) => w.check).join(',')}`,
            ),
          (e: unknown) => {
            assert.ok(
              e instanceof CCTParamsInvalidError && e.context.param !== 'confirmDropped',
              String(e),
            )
            testLogger.info(`drop confirmed: refused by ${String(e.context.param)}`)
          },
        )
    })

    it('refuses removing a remote pool policy record its lanes still trust', async (t) => {
      if (!deployed) return t.skip('mttp-core not deployed')
      // the policy lanes then trust no remote pool: refused, naming the fix
      await assert.rejects(
        cct.generateUnsignedApplyMultiTokenPoolRemotePoolPolicyConfigUpdates({
          ...core,
          getChain,
          recordsToRemove: [{ policyName: 'core-pol', remoteChainSelector: FUJI }],
        }),
        (e: unknown) =>
          e instanceof CCTParamsInvalidError &&
          e.context.param === 'guards' &&
          e.context.recordType === 'remotePool' &&
          new Set(
            (e.context.findings as { check: string; tokenAddress: string }[])
              .filter((f) => f.check === 'NO_REMOTE_POOL')
              .map((f) => f.tokenAddress),
          ).size ===
            new Set((e.context.findings as { tokenAddress: string }[]).map((f) => f.tokenAddress))
              .size,
      )
    })

    it('refuses removing the inline connection of a lane without confirmClosing, builds it confirmed, without a sender', async (t) => {
      if (!deployed) return t.skip('mttp-core not deployed')
      const remove = [{ tokenAddress: INLINE_TOKEN, remoteChainSelector: FUJI }]
      await assert.rejects(
        cct.generateUnsignedApplyMultiTokenPoolInlineConnectionConfigUpdates({
          ...core,
          getChain,
          remove,
        }),
        (e: unknown) =>
          e instanceof CCTParamsInvalidError &&
          e.context.param === 'guards' &&
          (e.context.findings as { check: string }[]).some((f) => f.check === 'LANE_CLOSED'),
      )
      const unsigned = await cct.generateUnsignedApplyMultiTokenPoolInlineConnectionConfigUpdates({
        poolAddress: CORE_POOL,
        getChain,
        remove,
        confirmClosing: remove,
      })
      assert.equal(unsigned.simulatedFrom, 'pcm')
      assert.deepEqual(unsigned.affectedLanes, remove)
      testLogger.info(
        `inline connection removal, no sender: projectionVerified ${unsigned.projectionVerified}`,
      )
    })
  },
)
