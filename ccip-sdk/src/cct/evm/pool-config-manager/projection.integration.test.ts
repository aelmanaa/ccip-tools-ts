/**
 * Live agreement of the lane projection with the PCM's own resolved views, on the Sepolia "v5v9"
 * `BurnMintMultiTokenPool 2.1.0-dev` stack: the stored records are read at one block, resolved by
 * `resolveMultiTokenPoolLanes`, and compared field by field with every lane batch view read at the
 * same block, for every (token, chain) a record names, open or not.
 *
 * Skips (does not fail) when the pool is no longer a multi-token pool; RPC errors still fail.
 */
import assert from 'node:assert/strict'
import { Console } from 'node:console'
import { describe, it } from 'node:test'

import { reachableRpcEndpoint } from '../../../../../scripts/test-endpoints.ts'
import { useResource } from '../../../../../scripts/useResource.ts'
import { EVMChain } from '../../../evm/index.ts'
import { LANE_RECORD_TYPES } from '../../../evm/multi-token-pool.ts'
import { EVMTokenManager } from '../index.ts'
import { MultiTokenPoolVersion } from '../multi-token-pool/contracts.ts'
import { fromAbiRateLimitConfig } from '../token-pool/rate-limit.ts'
import { resolveMultiTokenPoolLanes } from './projection.ts'
import { readMultiTokenPoolRecordState } from './record-state.ts'

const skip = !!process.env.SKIP_INTEGRATION_TESTS

await useResource(['sepolia'])

const testLogger = new Console(process.stdout, process.stderr)
if (!process.env.VERBOSE) testLogger.debug = () => {}

const POOL = '0x6304228a2908E45fC87f6cc685E6fC309f5A8624'
const PCM = '0x8AEe4112612168c05db5Dc204E18dCa6b3aD8Cc6'

describe('lane projection vs PCM views (Sepolia v5v9)', { skip, timeout: 600_000 }, () => {
  it('resolves every lane exactly as the PCM views do, at one block', async (t) => {
    const chain = await EVMChain.fromUrl(await reachableRpcEndpoint('RPC_SEPOLIA'), {
      apiClient: null,
      logger: testLogger,
    })
    const cct = EVMTokenManager.fromChain(chain)
    if (!(await cct.isMultiTokenPool({ poolAddress: POOL })))
      return t.skip('v5v9 multi-token pool not deployed')

    const { state, blockNumber, lanes } = await readMultiTokenPoolRecordState(
      chain,
      PCM,
      MultiTokenPoolVersion.V2_1_0_DEV,
    )
    assert.ok(lanes.length > 0, 'the stack has open lanes')
    // every token on every chain any record names: open lanes, closed ones, and subset exclusions
    const chains = new Set<bigint>()
    for (const type of LANE_RECORD_TYPES) {
      for (const r of state.policies[type])
        if (r.remoteChainSelector) chains.add(r.remoteChainSelector)
      for (const tok of state.tokens)
        for (const r of tok.inline[type]) chains.add(r.remoteChainSelector)
    }
    const probe = state.tokens.flatMap((tok) =>
      [...chains].map((remoteChainSelector) => ({
        tokenAddress: tok.tokenAddress,
        remoteChainSelector,
      })),
    )
    const projected = resolveMultiTokenPoolLanes(state, probe)

    const at = { poolConfigManager: PCM, lanes: probe, blockTag: blockNumber }
    const [connections, levels, fees, buckets, verifications] = await Promise.all([
      cct.getMultiTokenPoolLaneConnections(at),
      cct.getMultiTokenPoolLaneRecordLevels(at),
      cct.getMultiTokenPoolLaneTokenTransferFeeConfigs(at),
      cct.getMultiTokenPoolLaneRateLimiterStates(at),
      cct.getMultiTokenPoolLaneVerifications(at),
    ])
    const byAddress = <T extends { address: string }>(xs: T[]) =>
      [...xs].sort((a, b) => a.address.localeCompare(b.address))

    projected.forEach((p, i) => {
      const where = `${p.tokenAddress} → ${p.remoteChainSelector} @${blockNumber}`
      const { tokenAddress: _t, remoteChainSelector: _c, ...live } = connections[i]!
      // remote pool order is storage order (swap-removed sets); compare as sets
      assert.deepEqual(
        { ...p.connection, remotePools: byAddress(p.connection.remotePools) },
        { ...live, remotePools: byAddress(live.remotePools) },
        `connection ${where}`,
      )
      assert.deepEqual(p.levels, levels[i]!.levels, `levels ${where}`)
      const { tokenAddress: _ft, remoteChainSelector: _fc, ...fee } = fees[i]!
      assert.deepEqual(p.tokenTransferFeeConfig, fee, `fee config ${where}`)
      const b = buckets[i]!
      assert.deepEqual(
        p.rateLimits,
        p.connection.hasConnection && p.levels.rateLimit !== 'none'
          ? {
              outbound: fromAbiRateLimitConfig(b.outbound),
              inbound: fromAbiRateLimitConfig(b.inbound),
              fastFinalityOutbound: fromAbiRateLimitConfig(b.fastFinalityOutbound),
              fastFinalityInbound: fromAbiRateLimitConfig(b.fastFinalityInbound),
            }
          : null,
        `rate limits ${where}`,
      )
      const { tokenAddress: _vt, remoteChainSelector: _vc, ...verification } = verifications[i]!
      assert.deepEqual(p.verification, verification, `verification ${where}`)
    })
    testLogger.info(
      `projection agrees on ${probe.length} lanes (${lanes.length} open) of ${state.tokens.length} tokens at block ${blockNumber}`,
    )
  })
})
