import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

// Register every chain family the way SDK consumers do via the package root
import '../../../index.ts'
import { reachableRpcEndpoint } from '../../../../../scripts/test-endpoints.ts'
import { useResource } from '../../../../../scripts/useResource.ts'
import type { ChainGetter } from '../../../chain.ts'
import { EVMChain } from '../../../evm/index.ts'
import { networkInfo } from '../../../networks.ts'
import { SolanaChain } from '../../../solana/index.ts'
import { CCTParamsInvalidError } from '../../errors.ts'
import { MULTI_TOKEN_POOL_LANE_CHECKS } from '../../multi-token-pool.ts'
import { SolanaTokenManager } from '../index.ts'

// Live, read-only: the pool-groups program of record on Solana Devnet (fork 7558722, stage 2f), the
// group-linked lane of 7fnod… toward Ethereum Sepolia, read on both sides. Override the RPCs via
// RPC_SOLANA_DEVNET and RPC_SEPOLIA.
await useResource(['solana-devnet', 'ethereum-testnet-sepolia'])
const skip = !!process.env.SKIP_INTEGRATION_TESTS

const PROGRAM = '22P6h4QV5wswBX63KCncFGctC9dyVRMjykBBDdhwXjg7'
const SEPOLIA = networkInfo('ethereum-testnet-sepolia').chainSelector
const LINKED_MINT = '7fnodAydd3NckCgAeMRX7ck8dYvo85NHtrFs95CAgfYe'
const LANE = { tokenAddress: LINKED_MINT, remoteChainSelector: SEPOLIA, poolAddress: PROGRAM }

describe('shared multi-token pool reads on Devnet pool groups', { skip, timeout: 300_000 }, () => {
  let cct: SolanaTokenManager
  let getChain: ChainGetter
  before(async () => {
    const solana = await SolanaChain.fromUrl(await reachableRpcEndpoint('RPC_SOLANA_DEVNET'))
    const sepolia = await EVMChain.fromUrl(await reachableRpcEndpoint('RPC_SEPOLIA'))
    cct = SolanaTokenManager.fromChain(solana)
    getChain = async (selector) => {
      if (BigInt(selector) === SEPOLIA) return sepolia
      throw new CCTParamsInvalidError('test', 'getChain', `no RPC for ${selector}`)
    }
  })

  it('getMultiTokenPoolLane: the linked lane in the shared shape', async () => {
    const lane = await cct.getMultiTokenPoolLane(LANE)
    assert.equal(lane.family, 'SVM')
    assert.equal(lane.exists, true)
    assert.match(lane.remoteToken ?? '', /^0x[0-9a-fA-F]{40}$/)
    assert.ok(lane.remotePools.length > 0)
    assert.equal(lane.poolDataFormat, 'long')
    assert.equal(lane.sources.connection.kind, 'default')
    assert.equal(lane.outboundStatus.status, 'ok')
  })

  it('checkMultiTokenPoolLane: the healthy lane passes, with the Sepolia side read', async () => {
    const r = await cct.checkMultiTokenPoolLane({ ...LANE, getChain })
    for (const f of r.findings) assert.ok(MULTI_TOKEN_POOL_LANE_CHECKS.includes(f.check))
    assert.equal(r.remote, 'known')
    assert.equal(r.ok, true, JSON.stringify(r.findings))
  })

  it('checkMultiTokenPoolLane: fails closed without getChain', async () => {
    const r = await cct.checkMultiTokenPoolLane(LANE)
    assert.equal(r.remote, 'unknown')
    assert.equal(r.ok, false)
    assert.ok(r.findings.some((f) => f.check === 'REMOTE_UNREADABLE' && f.severity === 'error'))
  })

  it('getMultiTokenPoolTransferQuote: the pool fee with the token fee and net amount', async () => {
    const q = await cct.getMultiTokenPoolTransferQuote({ ...LANE, amount: 1_000_000n })
    assert.equal(q.hasFeeRecord, true)
    assert.equal(q.netAmount + q.feeDeducted, 1_000_000n)
  })
})
