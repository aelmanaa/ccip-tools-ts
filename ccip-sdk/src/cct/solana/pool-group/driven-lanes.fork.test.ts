/**
 * Membership, driven lanes and linked lanes (S5) on a Surfpool fork of Solana Devnet, against the
 * pool-groups program of record (22P6h4…, fork 7558722) as deployed there. Every write lands on the
 * local fork.
 *
 * Fixture: the Devnet group G2 (AgaDKRcg…, CONNECTION long toward the Sepolia MTTP that holds TKD)
 * and the mints D and E (pools under 22P6h4, registered on interface 2, members of nothing), handed
 * to a test key on the fork (group owner and pool owners rewritten). Through the SDK alone: D and E
 * join, the Sepolia chain record admits every member paused, both lanes materialize, and the lift
 * makes D's lane live. Surfpool cannot execute the Devnet Router (`InvalidProgramForExecution`),
 * so the SDK's own lift is refused with the Router artifacts only; the op's instruction is then
 * judged with the real lane check minus them (local rules and the whole Sepolia side) and lands.
 * Then the round trip: pause, E dropped from the subset and its lane closed (drain gate), D's
 * chain dropped and its lane closed in the same transaction, both memberships closed.
 *
 * Run: `with-private-rpcs.sh node --test src/cct/solana/pool-group/driven-lanes.fork.test.ts` from
 * `ccip-sdk` (needs `surfpool`).
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { BN, Wallet as AnchorWallet } from '@coral-xyz/anchor'
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'

import '../../../index.ts'
import { reachableRpcEndpoint, rpcEndpoint } from '../../../../../scripts/test-endpoints.ts'
import type { ChainGetter } from '../../../chain.ts'
import { EVMChain } from '../../../evm/index.ts'
import { networkInfo } from '../../../networks.ts'
import {
  type SurfpoolInstance,
  isSurfpoolAvailable,
  startFork,
  stopFork,
  surfnetRequest,
} from '../../../solana/__tests__/surfpool.ts'
import { SolanaChain } from '../../../solana/index.ts'
import { CCTParamsInvalidError } from '../../errors.ts'
import { SolanaTokenManager } from '../index.ts'
import { deriveTokenPoolConfigPda } from '../programs/token-pool.ts'
import { poolGroupPdas } from './accounts.ts'
import { isForkRouterArtifact, judgeAndLand } from './fork-make-live.test.helpers.ts'
import { eventAccounts } from './operations/write-common.ts'
import { createPoolGroupProgram } from './program.ts'

const PROGRAM = '22P6h4QV5wswBX63KCncFGctC9dyVRMjykBBDdhwXjg7'
const G2 = 'AgaDKRcgS8HhC3ZxphuKGouFqHUgx6yyj2z3vaX31nmY'
const D = '9f8hfytiF6aiEgVuvPyGLEztWjipruyeF2H3JZmMBQEh'
const E = 'E1hE7Kxs6AuURHA9MmK9te8Yr7up8gcnUdNqQgvetKu8'
/** The Sepolia MTTP tokens of D and E (live-tested in the 2f Devnet run). */
const TKD = '0xcd686cd10978a16d0a93375ac8de9aa141eed2f1'
const TKE = '0x347453eb3cadc615b97cbca1f6f57383678566d5'
const SEPOLIA = networkInfo('ethereum-testnet-sepolia').chainSelector
const PORT = 18_963
/** `Group.owner`: after the discriminator, version, bump and group id. */
const GROUP_OWNER_OFFSET = 8 + 1 + 1 + 32
/** `State.config.owner`: discriminator, version, token program, mint, decimals, signer, token account. */
const STATE_OWNER_OFFSET = 8 + 1 + 32 + 32 + 1 + 32 + 32

const isParam = (param: string) => (e: unknown) =>
  e instanceof CCTParamsInvalidError && e.context.param === param

describe(
  'pool-group membership and driven lanes (Devnet fork, G2 with D and E)',
  { skip: !isSurfpoolAvailable(), timeout: 1_200_000 },
  () => {
    const fork: { surfpool?: SurfpoolInstance; connection?: SolanaChain['connection'] } = {}
    let cct: SolanaTokenManager
    let chain: SolanaChain
    let getChain: ChainGetter
    const owner = Keypair.generate()
    const wallet = () => new AnchorWallet(owner)
    const g = { poolProgramAddress: PROGRAM, poolGroupAddress: G2 }
    const lane = (tokenAddress: string) => ({ tokenAddress, remoteChainSelector: SEPOLIA })

    /** Rewrites 32 bytes of an account on the fork. */
    async function rewrite(address: string, offset: number, key: PublicKey) {
      const connection = fork.connection!
      const info = await connection.getAccountInfo(new PublicKey(address))
      assert.ok(info, `${address} exists`)
      const data = Buffer.from(info.data)
      key.toBuffer().copy(data, offset)
      await surfnetRequest(connection, 'surfnet_setAccount', [
        address,
        {
          data: data.toString('hex'),
          lamports: info.lamports,
          owner: info.owner.toBase58(),
          executable: false,
        },
      ])
    }

    before(async () => {
      const started = await startFork({ upstreamUrl: rpcEndpoint('RPC_SOLANA_DEVNET'), port: PORT })
      Object.assign(fork, started)
      chain = new SolanaChain(started.connection, networkInfo('solana-devnet'), { apiClient: null })
      cct = SolanaTokenManager.fromChain(chain)
      const sepolia = await EVMChain.fromUrl(await reachableRpcEndpoint('RPC_SEPOLIA'))
      getChain = async (selector) => {
        if (selector === SEPOLIA) return sepolia
        throw new CCTParamsInvalidError('test', 'getChain', `no RPC for ${selector}`)
      }
      const sig = await started.connection.requestAirdrop(owner.publicKey, 20 * LAMPORTS_PER_SOL)
      await started.connection.confirmTransaction(sig)
      await rewrite(G2, GROUP_OWNER_OFFSET, owner.publicKey)
      for (const mint of [D, E])
        await rewrite(
          deriveTokenPoolConfigPda(new PublicKey(PROGRAM), new PublicKey(mint)).toBase58(),
          STATE_OWNER_OFFSET,
          owner.publicKey,
        )
    })
    after(() => stopFork(fork))

    it('join: a remote token another member lists is refused; D and E join with predicted indices', async () => {
      const remote = (token: string) => [{ remoteChainSelectors: [SEPOLIA], token, decimals: 18 }]
      await assert.rejects(
        cct.generateUnsignedJoinPoolGroup({
          ...g,
          poolGroupMembers: [
            { tokenAddress: D, remoteTokens: remote(TKD) },
            { tokenAddress: E, remoteTokens: remote(TKD) },
          ],
          payer: owner.publicKey.toBase58(),
        }),
        (e: unknown) => isParam('poolGroupMembers')(e) && /REMOTE_TOKEN_SHARED/.test(String(e)),
      )
      const before = await cct.getPoolGroupMembers(g)
      const r = await cct.joinPoolGroup({
        ...g,
        poolGroupMembers: [
          { tokenAddress: D, remoteTokens: remote(TKD) },
          { tokenAddress: E, remoteTokens: remote(TKE) },
        ],
        wallet: wallet(),
      })
      // the chain record is off: nothing is admitted, nothing goes live
      assert.deepEqual(r.goingLive, [])
      assert.equal(r.poolGroupTrust?.owner, owner.publicKey.toBase58())
      const next = before.registry?.nextMemberIndex ?? 0
      assert.deepEqual(r.memberIndices, { [D]: next, [E]: next + 1 })
      const { poolGroupMembers } = await cct.getPoolGroupMembers(g)
      assert.deepEqual(
        Object.fromEntries(poolGroupMembers.map((m) => [m.tokenAddress, m.memberIndex])),
        { [D]: next, [E]: next + 1 },
      )
    })

    it('chain lanes: enabling from off must pause; bounds are pre-flighted', async () => {
      const c = { ...g, remoteChainSelector: SEPOLIA }
      await assert.rejects(
        cct.generateUnsignedSetPoolGroupChainLanes({
          ...c,
          laneMode: 'all-members',
          drivenLanesPaused: false,
          payer: owner.publicKey.toBase58(),
        }),
        isParam('drivenLanesPaused'),
      )
      await assert.rejects(
        cct.generateUnsignedSetPoolGroupChainLanes({
          ...c,
          laneMode: 'subset',
          drivenLanesPaused: true,
          addMemberIndices: [1_000],
          payer: owner.publicKey.toBase58(),
        }),
        isParam('addMemberIndices'),
      )
      await cct.setPoolGroupChainLanes({
        ...c,
        laneMode: 'all-members',
        drivenLanesPaused: true,
        wallet: wallet(),
      })
      const record = await cct.getPoolGroupChain(c)
      assert.equal(record.laneMode, 'all-members')
      assert.equal(record.drivenLanesPaused, true)
    })

    it('materialize (crank): both lanes are created paused, nothing goes live', async () => {
      const r = await cct.materializePoolGroupLanes({
        ...g,
        remoteChainSelector: SEPOLIA,
        tokenAddresses: [D, E],
        getChain,
        wallet: wallet(),
      })
      assert.deepEqual(r.goingLive, [])
      const lanes = await cct.getPoolGroupLanes({
        ...g,
        remoteChainSelector: SEPOLIA,
        kind: 'driven',
      })
      assert.deepEqual(new Set(lanes.map((l) => l.tokenAddress)), new Set([D, E]))
      // a repeat builds nothing: both lanes exist
      const again = await cct.generateUnsignedMaterializePoolGroupLanes({
        ...g,
        remoteChainSelector: SEPOLIA,
        payer: owner.publicKey.toBase58(),
      })
      assert.deepEqual(again.transactions, [])
    })

    it('make-live: the lift needs the admission acknowledged and runs the lane check; it lands', async (t) => {
      const c = { ...g, remoteChainSelector: SEPOLIA }
      // the subset keeps D only: E's lane stays closed when the chain runs
      const { poolGroupMembers } = await cct.getPoolGroupMembers(g)
      const d = poolGroupMembers.find((m) => m.tokenAddress === D)!
      await cct.setPoolGroupChainLanes({
        ...c,
        laneMode: 'subset',
        addMemberIndices: [d.memberIndex],
        wallet: wallet(),
      })
      await assert.rejects(
        cct.generateUnsignedSetPoolGroupChainLanes({
          ...c,
          drivenLanesPaused: false,
          getChain,
          payer: owner.publicKey.toBase58(),
        }),
        isParam('acknowledgeLiveAdmission'),
      )
      const lift = {
        ...c,
        drivenLanesPaused: false,
        acknowledgeLiveAdmission: [lane(D)],
        getChain,
      }
      let landed = false
      try {
        const r = await cct.setPoolGroupChainLanes({ ...lift, wallet: wallet() })
        assert.ok(r.goingLive.some((l) => l.tokenAddress === D))
        landed = true
        t.diagnostic('the SDK op landed the lift: its lane check passed on the post-state')
      } catch (err) {
        // the fork's Router cannot run: only its artifacts may refuse the lift
        assert.ok(err instanceof CCTParamsInvalidError, String(err))
        const findings = (err.context.findings ?? []) as Parameters<
          typeof isForkRouterArtifact
        >[0][]
        assert.ok(findings.length > 0, err.message)
        assert.deepEqual(
          findings.filter((f) => !isForkRouterArtifact(f)),
          [],
          `only fork artifacts refuse the lift: ${err.message}`,
        )
      }
      if (!landed) {
        t.diagnostic(
          'fork Router artifacts refused the SDK op: judged with the real check minus them',
        )
        const program = new PublicKey(PROGRAM)
        const group = new PublicKey(G2)
        const ix = await createPoolGroupProgram(chain, program, owner.publicKey)
          .methods.setGroupChainLanes(new BN(SEPOLIA.toString()), {
            mode: { subset: {} },
            drivenLanesPaused: false,
            bitmapWrite: null,
            remove: [],
            add: [],
          })
          .accountsStrict({
            group,
            groupChainPolicy: poolGroupPdas.groupChain(program, group, SEPOLIA),
            groupRegistry: poolGroupPdas.groupRegistry(program, group),
            authority: owner.publicKey,
            systemProgram: PublicKey.default,
            ...eventAccounts(program),
          })
          .instruction()
        const { judgement } = await judgeAndLand({
          chain,
          program,
          group,
          signer: owner,
          instructions: [ix],
          getChain,
        })
        // D goes live from the post-state; E stays out of the subset
        assert.deepEqual(
          judgement.goingLive.map((l) => l.tokenAddress),
          [D],
        )
        assert.ok(
          !judgement.findings.some((f) => f.check === 'LANE_PAUSED' && f.severity === 'error'),
        )
      }
      const lanes = await cct.getPoolGroupLanes({
        ...g,
        remoteChainSelector: SEPOLIA,
        kind: 'driven',
      })
      const dl = lanes.find((l) => l.tokenAddress === D)!
      const el = lanes.find((l) => l.tokenAddress === E)!
      assert.equal(dl.admitted, true)
      assert.equal(dl.pausedOutbound || dl.pausedInbound, false)
      assert.equal(el.admitted, false)
    })

    it('close: refused on a running lane without the drain confirmed; E closes once confirmed', async () => {
      const c = { ...g, remoteChainSelector: SEPOLIA }
      // E is out of the subset (closable), but the chain runs: in-flight inbound must be drained
      await assert.rejects(
        cct.generateUnsignedClosePoolGroupLanes({
          ...c,
          tokenAddresses: [E],
          payer: owner.publicKey.toBase58(),
        }),
        isParam('confirmInFlightDrained'),
      )
      // a lane still admitted is refused
      await assert.rejects(
        cct.generateUnsignedClosePoolGroupLanes({
          ...c,
          tokenAddresses: [D],
          confirmInFlightDrained: [lane(D)],
          payer: owner.publicKey.toBase58(),
        }),
        (err: unknown) =>
          isParam('tokenAddresses')(err) && /GroupLaneStillEnabled/.test(String(err)),
      )
      const r = await cct.closePoolGroupLanes({
        ...c,
        tokenAddresses: [E],
        confirmInFlightDrained: [lane(E)],
        getChain,
        wallet: wallet(),
      })
      assert.ok(r.affectedLanes.some((l) => l.tokenAddress === E))
      const lanes = await cct.getPoolGroupLanes({
        ...g,
        remoteChainSelector: SEPOLIA,
        kind: 'driven',
      })
      assert.deepEqual(
        lanes.map((l) => l.tokenAddress),
        [D],
      )
    })

    it('round trip: pause, D drops its chain and closes its lane in one write, memberships close', async () => {
      const c = { ...g, remoteChainSelector: SEPOLIA }
      // dropping a live lane needs its confirmation
      await assert.rejects(
        cct.generateUnsignedSetPoolGroupMemberRemoteTokens({
          ...g,
          removeChains: [lane(D)],
          payer: owner.publicKey.toBase58(),
        }),
        isParam('confirmDroppedLanes'),
      )
      await cct.setPoolGroupChainLanes({ ...c, drivenLanesPaused: true, wallet: wallet() })
      const r = await cct.setPoolGroupMemberRemoteTokens({
        ...g,
        removeChains: [lane(D)],
        closeDroppedLanes: true,
        getChain,
        wallet: wallet(),
      })
      assert.deepEqual(r.staleLanes, [lane(D)])
      assert.deepEqual(r.lanesToClose, [lane(D)])
      assert.deepEqual(
        await cct.getPoolGroupLanes({ ...g, remoteChainSelector: SEPOLIA, kind: 'driven' }),
        [],
      )
      const closed = await cct.closePoolGroupMembers({
        ...g,
        tokenAddresses: [D, E],
        wallet: wallet(),
      })
      assert.ok(closed.transactions.length >= 1)
      const { poolGroupMembers } = await cct.getPoolGroupMembers(g)
      assert.ok(!poolGroupMembers.some((m) => m.tokenAddress === D || m.tokenAddress === E))
    })
  },
)
