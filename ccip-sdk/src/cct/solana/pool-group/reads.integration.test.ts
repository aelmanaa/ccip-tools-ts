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
import { CCTParamsInvalidError } from '../../errors.ts'
import { POOL_GROUP_FEATURES, SolanaTokenManager } from '../index.ts'
import { poolGroupsCoder } from './accounts.ts'

// Live, read-only (account reads and simulations): the pool-groups program of record on Solana
// Devnet (fork 7558722, stage 2f), as the 2f live runs left it. Override via RPC_SOLANA_DEVNET.
await useResource(['solana-devnet'])
const SOLANA_RPC = rpcEndpoint('RPC_SOLANA_DEVNET')
const skip = !!process.env.SKIP_INTEGRATION_TESTS

const PROGRAM = '22P6h4QV5wswBX63KCncFGctC9dyVRMjykBBDdhwXjg7'
const SEPOLIA = networkInfo('ethereum-testnet-sepolia').chainSelector
// group G2 and a lane linked to group BDiS… (CONNECTION from the group record)
const G2 = 'AgaDKRcgS8HhC3ZxphuKGouFqHUgx6yyj2z3vaX31nmY'
const LINKED_GROUP = 'BDiSFAren1qkqK5BjT3JpFNbbTbawoC6YxVghrAwDGbt'
const LINKED_MINT = '7fnodAydd3NckCgAeMRX7ck8dYvo85NHtrFs95CAgfYe'
const ref = { poolProgramAddress: PROGRAM }

describe('pool-group reads on Devnet', { skip, timeout: 180_000 }, () => {
  let chain: SolanaChain
  let cct: SolanaTokenManager
  const listsOf = async (name: string) =>
    chain.connection.getProgramAccounts(new PublicKey(PROGRAM), {
      filters: [
        {
          memcmp: { offset: 0, bytes: bs58.encode(BorshAccountsCoder.accountDiscriminator(name)) },
        },
      ],
    })
  before(async () => {
    chain = await SolanaChain.fromUrl(SOLANA_RPC)
    cct = SolanaTokenManager.fromChain(chain)
  })

  it('features, program config, group and its chain record', async () => {
    assert.deepEqual(await cct.getPoolGroupFeatures(ref), [...POOL_GROUP_FEATURES])
    const config = await cct.getTokenPoolGlobalConfig(ref)
    assert.equal(config.defaultRouter, 'Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C')
    const group = await cct.getPoolGroup({ ...ref, poolGroupAddress: G2 })
    assert.equal(group.poolGroupAddress, G2)
    assert.ok(group.remoteChainSelectors.includes(SEPOLIA))
    assert.deepEqual(group.features, [...POOL_GROUP_FEATURES])
    await assert.rejects(
      cct.getPoolGroup({
        ...ref,
        poolGroupAddress: G2,
        expectedOwner: PublicKey.unique().toBase58(),
      }),
      CCTParamsInvalidError,
    )
    const record = await cct.getPoolGroupChain({
      ...ref,
      poolGroupAddress: G2,
      remoteChainSelector: SEPOLIA,
    })
    assert.equal(record.poolGroupAddress, G2)
    assert.equal(typeof record.drivenLanesPaused, 'boolean')
    assert.ok(['off', 'all-members', 'subset'].includes(record.laneMode))
    const members = await cct.getPoolGroupMembers({ ...ref, poolGroupAddress: G2 })
    assert.equal(members.registry?.poolGroupAddress, G2)
    assert.equal(members.poolGroupMembers.length, members.registry.memberCount)
  })

  it('a linked lane, its group lanes, required CCVs and the extended remotes', async () => {
    const lane = await cct.getPoolGroupLane({
      ...ref,
      tokenAddress: LINKED_MINT,
      remoteChainSelector: SEPOLIA,
    })
    assert.equal(lane.kind, 'linked')
    assert.equal(lane.poolGroupAddress, LINKED_GROUP)
    assert.equal(lane.classSource?.connection.kind, 'default')
    assert.equal(lane.poolDataFormat, 'long')
    assert.match(lane.remoteToken, /^0x[0-9a-fA-F]{40}$/)
    assert.ok(lane.rateLimits, 'observe_lane_group simulated')
    const lanes = await cct.getPoolGroupLanes({ ...ref, poolGroupAddress: LINKED_GROUP })
    assert.ok(lanes.some((l) => l.tokenAddress === LINKED_MINT))
    for (const l of lanes) assert.equal(l.poolGroupAddress, LINKED_GROUP)
    const ccvs = await cct.getPoolGroupRequiredCCVs({
      ...ref,
      tokenAddress: LINKED_MINT,
      remoteChainSelector: SEPOLIA,
      amount: 1n,
      direction: 'outbound',
    })
    assert.ok(['inline', 'pool-group-copy'].includes(ccvs.source))
    const remotes = await cct.getTokenPoolRemotes({
      ...ref,
      tokenAddress: LINKED_MINT,
      remoteChainSelector: SEPOLIA,
    })
    assert.deepEqual(remotes['ethereum-testnet-sepolia']?.poolGroup, {
      kind: 'linked',
      poolGroupAddress: LINKED_GROUP,
    })
  })

  it('hook lists: entries, membership and a record with hooks', async () => {
    const [allowlist] = await listsOf('Allowlist')
    const [blocklist] = await listsOf('Blocklist')
    assert.ok(allowlist && blocklist)
    const allowed = await cct.getPoolGroupListEntries({ ...ref, list: allowlist.pubkey.toBase58() })
    assert.equal(allowed.kind, 'allowlist')
    assert.equal(allowed.complete, true)
    for (const entry of allowed.entries)
      assert.equal(
        await cct.hasPoolGroupListEntry({
          ...ref,
          list: allowlist.pubkey.toBase58(),
          address: entry.address!,
        }),
        true,
      )
    assert.equal(
      await cct.hasPoolGroupListEntry({
        ...ref,
        list: allowlist.pubkey.toBase58(),
        address: PublicKey.unique().toBase58(),
      }),
      false,
    )
    const blocked = await cct.getPoolGroupListEntries({ ...ref, list: blocklist.pubkey.toBase58() })
    assert.equal(blocked.kind, 'blocklist')
    for (const entry of blocked.entries) {
      assert.match(entry.addressHash, /^0x[0-9a-f]{64}$/)
      if (entry.address)
        assert.equal(
          await cct.hasPoolGroupListEntry({
            ...ref,
            list: blocklist.pubkey.toBase58(),
            address: entry.address,
          }),
          true,
        )
    }
    // a SECURITY record naming a list: one of the group chain records
    const records = await listsOf('GroupChainPolicy')
    const withHook = records.find(({ account }) => {
      const r = poolGroupsCoder.accounts.decode('groupChainPolicy', account.data)
      return !!r.policy.security.hook
    })
    if (withHook) {
      const hooks = await cct.getPoolGroupHooks({ ...ref, record: withHook.pubkey.toBase58() })
      assert.ok(hooks.hook)
      assert.ok(hooks.lists.length > 0)
      assert.ok(hooks.hookAuthority)
    }
  })
})
