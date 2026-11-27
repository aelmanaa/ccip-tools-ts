import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

import { Keypair } from '@solana/web3.js'

// Register every chain family the way SDK consumers do via the package root
import '../../../index.ts'
import { rpcEndpoint } from '../../../../../scripts/test-endpoints.ts'
import { useResource } from '../../../../../scripts/useResource.ts'
import { networkInfo } from '../../../networks.ts'
import { SolanaChain } from '../../../solana/index.ts'
import { CCTParamsInvalidError } from '../../errors.ts'
import { SolanaTokenManager } from '../index.ts'

// Live, read-only (account reads and simulations; nothing is sent): the S5 membership and
// driven-lane writes built against the Devnet group G2 (AgaDKRcg…) and the linked group BDiS…,
// and the extended lane ops on a linked lane. Override via RPC_SOLANA_DEVNET.
await useResource(['solana-devnet'])
const SOLANA_RPC = rpcEndpoint('RPC_SOLANA_DEVNET')
const skip = !!process.env.SKIP_INTEGRATION_TESTS

const PROGRAM = '22P6h4QV5wswBX63KCncFGctC9dyVRMjykBBDdhwXjg7'
const G2 = 'AgaDKRcgS8HhC3ZxphuKGouFqHUgx6yyj2z3vaX31nmY'
const LINKED_GROUP = 'BDiSFAren1qkqK5BjT3JpFNbbTbawoC6YxVghrAwDGbt'
const D = '9f8hfytiF6aiEgVuvPyGLEztWjipruyeF2H3JZmMBQEh'
const TKD = '0xcd686cd10978a16d0a93375ac8de9aa141eed2f1'
const SEPOLIA = networkInfo('ethereum-testnet-sepolia').chainSelector
const stranger = Keypair.generate().publicKey.toBase58()
const param = (name: string) => (e: unknown) =>
  e instanceof CCTParamsInvalidError && e.context.param === name

describe(
  'pool-group membership, driven lanes and extended lane ops on Devnet (read-only)',
  { skip, timeout: 240_000 },
  () => {
    let cct: SolanaTokenManager
    let owner: string
    const g = { poolProgramAddress: PROGRAM, poolGroupAddress: G2 }
    before(async () => {
      cct = SolanaTokenManager.fromChain(await SolanaChain.fromUrl(SOLANA_RPC))
      owner = (await cct.getPoolGroup(g)).owner
    })

    it('a join builds for the group owner (as pool owner); another group owner is refused by expectedOwner', async () => {
      const join = {
        ...g,
        poolGroupMembers: [
          {
            tokenAddress: D,
            remoteTokens: [{ remoteChainSelectors: [SEPOLIA], token: TKD, decimals: 18 }],
          },
        ],
      }
      const r = await cct.generateUnsignedJoinPoolGroup({ ...join, payer: owner })
      assert.equal(r.transactions.length, 1)
      assert.equal(r.poolGroupTrust?.owner, owner)
      assert.equal(typeof r.memberIndices[D], 'number')
      await assert.rejects(
        cct.generateUnsignedJoinPoolGroup({ ...join, payer: stranger }),
        param('expectedOwner'),
      )
    })

    it('a stranger may not change the chain lanes; nothing to materialize or close builds nothing', async () => {
      await assert.rejects(
        cct.generateUnsignedSetPoolGroupChainLanes({
          ...g,
          remoteChainSelector: SEPOLIA,
          laneMode: 'all-members',
          drivenLanesPaused: true,
          payer: stranger,
        }),
        param('authority'),
      )
      const m = await cct.generateUnsignedMaterializePoolGroupLanes({
        ...g,
        remoteChainSelector: SEPOLIA,
        payer: stranger,
      })
      assert.deepEqual(m.transactions, [])
      const c = await cct.generateUnsignedClosePoolGroupLanes({
        ...g,
        remoteChainSelector: SEPOLIA,
        payer: stranger,
      })
      assert.deepEqual(c.transactions, [])
    })

    it('extended lane ops on a linked lane: RATE_LIMIT from the group and a delete are refused with the pool-group op', async () => {
      const ref = { poolProgramAddress: PROGRAM, poolGroupAddress: LINKED_GROUP }
      const lane = (await cct.getPoolGroupLanes(ref)).find(
        (l) =>
          l.remoteChainSelector === SEPOLIA &&
          l.kind === 'linked' &&
          l.classSource?.rateLimit.kind !== 'inline',
      )
      assert.ok(lane, 'a linked lane with RATE_LIMIT from the group')
      const payer = (
        await cct.getTokenPoolState({
          tokenAddress: lane.tokenAddress,
          poolProgramAddress: PROGRAM,
        })
      ).config.owner
      const base = {
        tokenAddress: lane.tokenAddress,
        poolProgramAddress: PROGRAM,
        remoteChainSelector: SEPOLIA,
        payer,
      }
      await assert.rejects(
        cct.generateUnsignedSetChainRateLimit({
          ...base,
          inbound: { enabled: false },
          outbound: { enabled: false },
        }),
        /RateLimitFromGroup/,
      )
      await assert.rejects(cct.generateUnsignedDeleteChainRemoteConfig(base), /LaneLinked/)
      const state = await cct.getTokenPoolState({
        tokenAddress: lane.tokenAddress,
        poolProgramAddress: PROGRAM,
      })
      assert.ok(state.poolGroupFeatures?.includes('groups'))
    })
  },
)
