/**
 * The lane view and the lane check on live Sepolia lanes, read-only: a healthy mttp-core lane to Fuji,
 * the v5v9 lane whose Fuji side does not exist, and a v5v9 lane to Solana devnet (whose remote side
 * the SDK cannot read yet, so the check fails closed).
 *
 * Skips (does not fail) when a pool is no longer a multi-token pool; RPC errors still fail.
 */
import assert from 'node:assert/strict'
import { Console } from 'node:console'
import { before, describe, it } from 'node:test'

import { reachableRpcEndpoint } from '../../../../../../scripts/test-endpoints.ts'
import { useResource } from '../../../../../../scripts/useResource.ts'
import type { ChainGetter } from '../../../../chain.ts'
import { CCIPLocalTokenRequiredError } from '../../../../errors/index.ts'
import { EVMChain } from '../../../../evm/index.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { EVMTokenManager } from '../../index.ts'

const skip = !!process.env.SKIP_INTEGRATION_TESTS

await useResource(['sepolia', 'fuji'])

const testLogger = new Console(process.stdout, process.stderr)
if (!process.env.VERBOSE) testLogger.debug = () => {}

const FUJI = 14767482510784806043n
const SOLANA_DEVNET = 16423721717087811551n
const CORE = {
  poolAddress: '0x91b33bfc6B7E4ee5511BB654e9f93b6d3e72671b',
  tokenAddress: '0x6377325E0D7F2E0D2Bc770860F0eB3B6c62F7cEd',
  remoteChainSelector: FUJI,
}
const V5V9_FUJI = {
  poolAddress: '0x6304228a2908E45fC87f6cc685E6fC309f5A8624',
  tokenAddress: '0x0a75baaC1fC96Af3F91c3e4a364Fd81e7B4dCf49',
  remoteChainSelector: FUJI,
}
const V5V9_SOLANA = {
  poolAddress: '0x6304228a2908E45fC87f6cc685E6fC309f5A8624',
  tokenAddress: '0x808d0D44b1E532A0f0360edB05292dC09596F9b9',
  remoteChainSelector: SOLANA_DEVNET,
}

describe('MTTP lane view and lane check (Sepolia, read-only)', { skip, timeout: 600_000 }, () => {
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
    deployed =
      (await cct.isMultiTokenPool({ poolAddress: CORE.poolAddress })) &&
      (await cct.isMultiTokenPool({ poolAddress: V5V9_FUJI.poolAddress }))
  })

  it('reads the family-neutral lane, with policy and inline sources', async (t) => {
    if (!deployed) return t.skip('stacks not deployed')
    const core = await cct.getMultiTokenPoolLane(CORE)
    assert.equal(core.family, 'EVM')
    assert.equal(core.exists, true)
    assert.deepEqual(core.outboundStatus, { status: 'ok' })
    const v5 = await cct.getMultiTokenPoolLane(V5V9_FUJI)
    assert.deepEqual(v5.sources.connection, { kind: 'policy', policy: { name: 'v5' } })
  })

  it('passes a healthy lane end to end', async (t) => {
    if (!deployed) return t.skip('stacks not deployed')
    const r = await cct.checkMultiTokenPoolLane({ ...CORE, getChain })
    assert.equal(r.remote, 'known')
    assert.deepEqual(
      r.findings.filter((f) => f.severity === 'error'),
      [],
    )
    assert.equal(r.ok, true)
  })

  it('finds the lane whose remote side does not exist', async (t) => {
    if (!deployed) return t.skip('stacks not deployed')
    const r = await cct.checkMultiTokenPoolLane({ ...V5V9_FUJI, getChain })
    assert.equal(r.ok, false)
    assert.ok(r.findings.some((f) => f.check === 'NO_REMOTE_POOL' && f.severity === 'error'))
  })

  it('fails closed on a remote side it cannot read', async (t) => {
    if (!deployed) return t.skip('stacks not deployed')
    const r = await cct.checkMultiTokenPoolLane({ ...V5V9_SOLANA, getChain })
    assert.equal(r.ok, false)
    assert.equal(r.remote, 'unknown')
  })

  it('quotes a transfer with the token fee the Router leaves out, rounded down as the pool does', async (t) => {
    if (!deployed) return t.skip('stacks not deployed')
    const amount = 123_456_789_012_345_678n
    for (const lane of [CORE, V5V9_FUJI]) {
      const q = await cct.getMultiTokenPoolTransferQuote({ ...lane, amount })
      assert.equal(q.hasFeeRecord, true)
      assert.equal(q.feeDeducted, (amount * BigInt(q.tokenFeeBps)) / 10_000n)
      assert.equal(q.netAmount, amount - q.feeDeducted)
    }
    // the v5v9 token allows only finalized transfers
    await assert.rejects(
      cct.getMultiTokenPoolTransferQuote({ ...V5V9_FUJI, amount, finality: 5 }),
      (e: unknown) => e instanceof CCTParamsInvalidError && e.context.param === 'finality',
    )
  })

  it('answers getFee, getTokenTransferFeeConfig and isSupportedToken per token on a multi-token pool', async (t) => {
    if (!deployed) return t.skip('stacks not deployed')
    const fee = await cct.getFee({
      poolAddress: CORE.poolAddress,
      remoteChainSelector: FUJI,
      tokenAddress: CORE.tokenAddress,
    })
    const quote = await cct.getMultiTokenPoolTransferQuote({ ...CORE, amount: 1n })
    assert.deepEqual(
      [fee.tokenFeeBps, fee.destGasOverhead, fee.destBytesOverhead],
      [quote.tokenFeeBps, quote.destGasOverhead, quote.destBytesOverhead],
    )
    const config = await cct.getTokenTransferFeeConfig({
      poolAddress: CORE.poolAddress,
      remoteChainSelector: FUJI,
      tokenAddress: CORE.tokenAddress,
    })
    assert.equal(config.isEnabled, true)
    assert.equal(config.destBytesOverhead, fee.destBytesOverhead)
    assert.equal(
      await cct.isSupportedToken({
        poolAddress: CORE.poolAddress,
        tokenAddress: CORE.tokenAddress,
      }),
      true,
    )
    assert.equal(
      await cct.isSupportedToken({
        poolAddress: CORE.poolAddress,
        tokenAddress: '0x000000000000000000000000000000000000dEaD',
      }),
      false,
    )
    // without the token a multi-token pool cannot say which lane
    await assert.rejects(
      cct.getFee({ poolAddress: CORE.poolAddress, remoteChainSelector: FUJI }),
      CCIPLocalTokenRequiredError,
    )
  })
})
