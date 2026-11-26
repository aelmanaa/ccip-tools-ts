import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

import { BorshAccountsCoder } from '@coral-xyz/anchor'
import { PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'

// Register every chain family the way SDK consumers do via the package root
import '../../../index.ts'
import { rpcEndpoint } from '../../../../../scripts/test-endpoints.ts'
import { useResource } from '../../../../../scripts/useResource.ts'
import { networkInfo } from '../../../networks.ts'
import { SolanaChain } from '../../../solana/index.ts'
import { decodeTokenPoolChainConfig } from '../../../solana/token-pool.ts'
import { deriveTokenPoolChainConfigPda, deriveTokenPoolConfigPda } from '../programs/token-pool.ts'
import {
  decodePoolGroupChainConfigV2,
  decodePoolGroupIdlAccount,
  decodePoolGroupLaneMarker,
  decodePoolGroupRegistry,
} from './accounts.ts'
import { readSolanaRemoteLaneFacts, readSolanaRemotePoolFacts } from './remote-lane.ts'

// Live, read-only: the pool-groups program of record on Solana Devnet (fork 7558722, stage 2f) and
// lanes toward Ethereum Sepolia left by the 2f live runs. Override the RPC via RPC_SOLANA_DEVNET.
await useResource(['solana-devnet'])
const SOLANA_RPC = rpcEndpoint('RPC_SOLANA_DEVNET')
const skip = !!process.env.SKIP_INTEGRATION_TESTS

const PROGRAM = new PublicKey('22P6h4QV5wswBX63KCncFGctC9dyVRMjykBBDdhwXjg7')
const SEPOLIA = networkInfo('ethereum-testnet-sepolia').chainSelector
// a lane linked to a pool group, CONNECTION from the group's chain record (long format; the
// lane's own format is legacy)
const LINKED_MINT = '7fnodAydd3NckCgAeMRX7ck8dYvo85NHtrFs95CAgfYe'
// a marked lane outside any group, with its own long format
const OWN_LONG_MINT = '5BUaucEh5vUg1yM49YkqjxcAbyqyZCRjfw5MoTrSjRFQ'
// group G2's Sepolia chain record: owned by the program, but not a pool State
const G2_SEPOLIA_RECORD = 'AEfsBzTHVd3i6ZfGYCcTKEQjLbgmhMEk8XhUP7d1pcSD'

const stateOf = (mint: string) => deriveTokenPoolConfigPda(PROGRAM, new PublicKey(mint)).toBase58()
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/

describe('readSolanaRemoteLaneFacts on Devnet pool groups', { skip, timeout: 120_000 }, () => {
  let chain: SolanaChain
  before(async () => {
    chain = await SolanaChain.fromUrl(SOLANA_RPC)
  })

  it('reads a group-linked lane, its group record and canonical EVM addresses', async () => {
    const facts = await readSolanaRemoteLaneFacts(chain, {
      remoteChainSelector: SEPOLIA,
      mint: LINKED_MINT,
      trustedPools: [stateOf(LINKED_MINT)],
      readRateLimits: true,
    })
    assert.equal(facts.status, 'known', 'reason' in facts ? facts.reason : '')
    assert.equal(facts.registryPool, stateOf(LINKED_MINT))
    assert.equal(facts.poolProgram, PROGRAM.toBase58())
    // no `router` given: Devnet's Router from the table
    assert.equal(facts.routerVerified, true)
    assert.equal(facts.laneKind, 'linked')
    // the lane's own format is legacy; the group's chain record sends the long format
    assert.equal(facts.poolDataFormat, 'long')
    assert.equal(facts.readsLongData, facts.interfaceVersion === 2)
    assert.ok(facts.back)
    assert.match(facts.back.remoteToken, EVM_ADDRESS)
    assert.ok(facts.back.remotePools.length > 0)
    for (const pool of facts.back.remotePools) {
      assert.match(pool.address, EVM_ADDRESS)
      assert.match(pool.raw, /^0x([0-9a-f]{40}|[0-9a-f]{64})$/)
    }
    assert.match(facts.back.remoteTokenRaw, /^0x[0-9a-f]+$/)
    assert.equal(typeof facts.back.remoteDecimals, 'number')
    assert.equal(typeof facts.back.remoteTokenDecimals, 'number')
    assert.equal(facts.back.failsClosed, undefined)
    // RATE_LIMIT comes from the group's record: the bucket under the record's config
    assert.ok('outboundRateLimiterState' in facts.back)
  })

  it("reads a marked lane's own long format; long data needs interface 2", async () => {
    const facts = await readSolanaRemoteLaneFacts(chain, {
      remoteChainSelector: SEPOLIA,
      mint: OWN_LONG_MINT,
      trustedPools: [stateOf(OWN_LONG_MINT)],
      readRateLimits: true,
    })
    assert.equal(facts.status, 'known', 'reason' in facts ? facts.reason : '')
    assert.equal(facts.laneKind, 'linked')
    assert.equal(facts.poolDataFormat, 'long')
    assert.equal(facts.readsLongData, facts.interfaceVersion === 2)
    assert.ok(facts.back && 'outboundRateLimiterState' in facts.back)
    const pool = await readSolanaRemotePoolFacts(chain, {
      remoteChainSelector: SEPOLIA,
      poolAddress: stateOf(OWN_LONG_MINT),
    })
    assert.deepEqual(pool, { status: 'known', isMultiTokenPool: facts.readsLongData })
  })

  it('fails closed on a trusted pool that is not a pool State', async () => {
    const facts = await readSolanaRemoteLaneFacts(chain, {
      remoteChainSelector: SEPOLIA,
      mint: LINKED_MINT,
      trustedPools: [G2_SEPOLIA_RECORD],
    })
    assert.equal(facts.status, 'unknown')
    const pool = await readSolanaRemotePoolFacts(chain, {
      remoteChainSelector: SEPOLIA,
      poolAddress: G2_SEPOLIA_RECORD,
    })
    assert.equal(pool.status, 'unknown')
  })

  it('reports a trusted pool that does not exist as missing', async () => {
    const facts = await readSolanaRemoteLaneFacts(chain, {
      remoteChainSelector: SEPOLIA,
      mint: LINKED_MINT,
      trustedPools: [stateOf(PublicKey.unique().toBase58())],
    })
    assert.equal(facts.status, 'missing')
  })

  it('decodes every lane, group chain record and registry of the program by hand', async () => {
    const byDiscriminator = (bytes: Buffer) =>
      chain.connection.getProgramAccounts(PROGRAM, {
        filters: [{ memcmp: { offset: 0, bytes: bs58.encode(bytes) } }],
      })
    const lanes = await byDiscriminator(BorshAccountsCoder.accountDiscriminator('ChainConfigV2'))
    assert.ok(lanes.length > 0)
    const kinds = new Set<string>()
    for (const { pubkey, account } of lanes) {
      const lane = decodePoolGroupChainConfigV2(account.data, pubkey.toBase58())
      const cc = await chain.connection.getAccountInfo(
        deriveTokenPoolChainConfigPda(PROGRAM, lane.remoteChainSelector, new PublicKey(lane.mint)),
      )
      if (!cc) continue
      const kind = decodePoolGroupLaneMarker(cc.data, decodeTokenPoolChainConfig(cc.data))
      kinds.add(kind)
      // the marker and the tail always agree on chain
      assert.equal(kind !== 'standard', lane.ext !== null, pubkey.toBase58())
      assert.equal(kind === 'driven', !!lane.ext?.groupDriven, pubkey.toBase58())
    }
    assert.ok(kinds.has('linked'))
    // Devnet has no driven lane since the 2f run closed them; S5 creates one through the SDK
    if (process.env.EXPECT_DRIVEN_LANES) assert.ok(kinds.has('driven'), 'no driven lane on Devnet')
    for (const { pubkey, account } of await byDiscriminator(
      BorshAccountsCoder.accountDiscriminator('GroupChainPolicy'),
    ))
      decodePoolGroupIdlAccount('groupChainPolicy', account.data, pubkey.toBase58())
    for (const { pubkey, account } of await byDiscriminator(Buffer.from('c746ff66717a8902', 'hex')))
      decodePoolGroupRegistry(account.data, pubkey.toBase58())
  })
})
