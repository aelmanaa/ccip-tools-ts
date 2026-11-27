/**
 * Planner scaling on a Surfpool fork of Solana Devnet (S6 fixes, PRD): N fresh mints (pools under
 * 22P6h4 onboarded with `onboardToken`, registered on interface 2, owned by the test signer) go
 * through the planners on the Devnet group G2 toward Sepolia, once signed with a wallet and once
 * through a 2-of-3 Squads vault (unsigned planners, default `maxReadySteps`, ready steps batched
 * with `toPoolGroupSquadsBatch`). Per mode:
 * 1. enable Sepolia from `'off'` (its pause), onboard the N behind that pause (join, materialize;
 *    the lane check refuses fresh mints: their Sepolia counterparts do not exist), remove the N
 *    (batched: the remote registry names no pool for them, so the remote side reads as stopped);
 * 2. lift the chain pause (no member left: the check has no lane), so Sepolia is live;
 * 3. onboard the N onto the live Sepolia (join without it, then paused creation), remove them.
 * It prints the transaction, signature and approval-round counts, the lanes per materialize and
 * paused-creation transaction, and the Squads execute CU.
 *
 * Run: `SCALING=1 SCALING_N=2,10,30 with-private-rpcs.sh node --test
 * src/cct/solana/pool-group/planners/planners-scaling.fork.test.ts` from `ccip-sdk` (long).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Wallet as AnchorWallet } from '@coral-xyz/anchor'
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from '@solana/web3.js'

import '../../../../index.ts'
import { reachableRpcEndpoint, rpcEndpoint } from '../../../../../../scripts/test-endpoints.ts'
import type { ChainGetter } from '../../../../chain.ts'
import { EVMChain } from '../../../../evm/index.ts'
import { networkInfo } from '../../../../networks.ts'
import {
  isSurfpoolAvailable,
  startFork,
  stopFork,
  surfnetRequest,
} from '../../../../solana/__tests__/surfpool.ts'
import { SolanaChain } from '../../../../solana/index.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { SolanaTokenManager } from '../../index.ts'
import { deriveTokenPoolConfigPda } from '../../programs/token-pool.ts'
import { SquadsHarness } from '../squads.test.helpers.ts'
import { toPoolGroupSquadsBatch } from '../squads.ts'
import type { GeneratePoolGroupPlanResult, SolanaMultiTokenPoolRemoteChainConfig } from './types.ts'

const PROGRAM = '22P6h4QV5wswBX63KCncFGctC9dyVRMjykBBDdhwXjg7'
const G2 = 'AgaDKRcgS8HhC3ZxphuKGouFqHUgx6yyj2z3vaX31nmY'
const SEPOLIA = networkInfo('ethereum-testnet-sepolia').chainSelector
const GROUP_OWNER_OFFSET = 8 + 1 + 1 + 32
const STATE_OWNER_OFFSET = 8 + 1 + 32 + 32 + 1 + 32 + 32
const SIZES = (process.env.SCALING_N ?? '2,10,30').split(',').map(Number)
const g = { poolProgramAddress: PROGRAM, poolGroupAddress: G2 }

/** One flow's counts. */
type Row = { flow: string; steps: number; txs: number; signatures: number; rounds: number }

describe(
  'planner scaling on the Devnet fork',
  { skip: !isSurfpoolAvailable() || !process.env.SCALING, timeout: 7_200_000 },
  () => {
    for (const N of SIZES)
      it(`N = ${N}`, async () => {
        const owner = Keypair.generate()
        const started = await startFork({ upstreamUrl: rpcEndpoint('RPC_SOLANA_DEVNET') })
        const conn = started.connection
        try {
          const chain = new SolanaChain(conn, networkInfo('solana-devnet'), { apiClient: null })
          const cct = SolanaTokenManager.fromChain(chain)
          const sepolia = await EVMChain.fromUrl(await reachableRpcEndpoint('RPC_SEPOLIA'))
          const getChain: ChainGetter = async (selector) => {
            if (selector === SEPOLIA) return sepolia
            throw new CCTParamsInvalidError('test', 'getChain', `no RPC for ${selector}`)
          }
          await conn.confirmTransaction(
            await conn.requestAirdrop(owner.publicKey, 100 * LAMPORTS_PER_SOL),
          )
          const rewrite = async (address: string, offset: number, to: PublicKey) => {
            const info = await conn.getAccountInfo(new PublicKey(address))
            assert.ok(info, `${address} exists`)
            const data = Buffer.from(info.data)
            to.toBuffer().copy(data, offset)
            await surfnetRequest(conn, 'surfnet_setAccount', [
              address,
              {
                data: data.toString('hex'),
                lamports: info.lamports,
                owner: info.owner.toBase58(),
                executable: false,
              },
            ])
          }
          await rewrite(G2, GROUP_OWNER_OFFSET, owner.publicKey)
          const wallet = new AnchorWallet(owner)

          // ── setup (not counted): N fresh mints, pools onboarded on interface 2 ──
          const mints: string[] = []
          for (let i = 0; i < N; i++) {
            const { tokenAddress } = await cct.deployToken({
              decimals: 9,
              withMetaplex: false,
              wallet,
            })
            await cct.onboardToken({
              tokenAddress,
              poolType: 'burn-mint',
              poolProgramAddress: PROGRAM,
              remoteChains: [],
              wallet,
            })
            mints.push(tokenAddress)
          }
          const tokens = mints.map((tokenAddress, i) => ({
            tokenAddress,
            remoteTokens: [
              {
                remoteChainSelector: SEPOLIA,
                remoteTokenAddress: `0x${(0xa000 + i).toString(16).padStart(40, '0')}`,
                remoteTokenDecimals: 18,
              },
            ],
          }))
          const record = await cct.getPoolGroupChain({ ...g, remoteChainSelector: SEPOLIA })
          const { connection, fee, rateLimit } = record.policy
          const remoteChain: SolanaMultiTokenPoolRemoteChainConfig = {
            remoteChainSelector: SEPOLIA,
            remotePools: connection.remotePools,
            poolDataFormat: connection.poolDataFormat,
            rateLimits: rateLimit,
            tokenTransferFeeConfig: fee.tokenTransferFeeConfig,
          }
          const lanes = mints.map((tokenAddress) => ({
            tokenAddress,
            remoteChainSelector: SEPOLIA,
          }))
          const removal = {
            ...g,
            tokenAddress: mints[0]!,
            getChain,
          }
          const removalSolana = { tokenAddresses: mints.slice(1), confirmInFlightDrained: lanes }
          const rows: Row[] = []
          const perTx: Record<string, number[]> = {}
          const lanesPerTx = (
            name: string,
            steps: { name: string; progress: number; n: number }[],
          ) => {
            for (const s of steps)
              if (s.name === name && s.n) (perTx[name] ??= []).push(s.progress / s.n)
          }

          // ── wallet (signed planners) ──
          {
            const tally = (
              flow: string,
              steps: { name: string; progress: number; hashes: string[] }[],
            ) => {
              const txs = steps.reduce((n, s) => n + s.hashes.length, 0)
              rows.push({
                flow: `${flow} (wallet)`,
                steps: steps.length,
                txs,
                signatures: txs,
                rounds: 0,
              })
              lanesPerTx(
                'materializePoolGroupLanes',
                steps.map((s) => ({ ...s, n: s.hashes.length })),
              )
              lanesPerTx(
                'admitPausedLanes',
                steps.map((s) => ({ ...s, n: s.hashes.length })),
              )
            }
            const base = { ...g, remoteChain, tokenAddresses: 'all-members' as const, getChain }
            const enable = await cct.enableMultiTokenPoolChain({ ...base, wallet })
            assert.equal(enable.blockedBy, undefined, enable.blockedBy?.reason ?? '')
            tally('enable from off', enable.steps)
            const runId = enable.runId
            const landed = enable.steps.map((s) => s.id)
            const onboard = await cct.onboardMultiTokenPoolTokens({
              ...g,
              tokens,
              unpause: true,
              runId,
              landedStepIds: landed,
              getChain,
              wallet,
            })
            assert.match(onboard.blockedBy?.reason ?? '', /lane check refuses/)
            tally(`onboard ${N} behind the chain pause (to the check)`, onboard.steps)
            const removed = await cct.removeMultiTokenPoolToken({
              ...removal,
              solana: removalSolana,
              wallet,
            })
            assert.equal(removed.blockedBy, undefined, removed.blockedBy?.reason ?? '')
            tally(`remove ${N}`, removed.steps)
            const lift = await cct.enableMultiTokenPoolChain({
              ...base,
              unpause: true,
              runId,
              landedStepIds: landed,
              wallet,
            })
            assert.equal(lift.blockedBy, undefined, lift.blockedBy?.reason ?? '')
            tally('lift the chain pause', lift.steps)
            const live = await cct.onboardMultiTokenPoolTokens({
              ...g,
              tokens,
              unpause: true,
              runId,
              getChain,
              solana: { acknowledgeLiveAdmission: true },
              wallet,
            })
            assert.match(live.blockedBy?.reason ?? '', /lane check refuses/)
            tally(`onboard ${N} onto the live chain (to the check)`, live.steps)
            const removedLive = await cct.removeMultiTokenPoolToken({
              ...removal,
              solana: removalSolana,
              wallet,
            })
            assert.equal(removedLive.blockedBy, undefined, removedLive.blockedBy?.reason ?? '')
            tally(`remove ${N} (live chain)`, removedLive.steps)
            // back to 'off' for the Squads run
            await cct.setPoolGroupChainLanes({
              ...g,
              remoteChainSelector: SEPOLIA,
              laneMode: 'off',
              wallet,
            })
          }

          // ── Squads v4 vault (unsigned planners) ──
          const [creator, m1, m2, m3] = [0, 1, 2, 3].map(() => Keypair.generate())
          for (const key of [creator!, m1!, m2!, m3!])
            await conn.confirmTransaction(
              await conn.requestAirdrop(key.publicKey, 10 * LAMPORTS_PER_SOL),
            )
          const squads = new SquadsHarness(conn)
          await squads.create(
            creator!,
            Keypair.generate(),
            [m1!.publicKey, m2!.publicKey, m3!.publicKey],
            2,
          )
          const vault = squads.vault.toBase58()
          await squads.send(
            'fundVault',
            [creator!],
            [
              SystemProgram.transfer({
                fromPubkey: creator!.publicKey,
                toPubkey: squads.vault,
                lamports: 5 * LAMPORTS_PER_SOL,
              }),
            ],
          )
          await rewrite(G2, GROUP_OWNER_OFFSET, squads.vault)
          for (const m of mints)
            await rewrite(
              deriveTokenPoolConfigPda(new PublicKey(PROGRAM), new PublicKey(m)).toBase58(),
              STATE_OWNER_OFFSET,
              squads.vault,
            )
          const landed: string[] = []
          const runId = `scaling-${N}`
          const budget = { executor: 'squads-v4' as const }
          async function waves<Nm extends string>(
            flow: string,
            build: () => Promise<GeneratePoolGroupPlanResult<Nm>>,
          ) {
            const row: Row = {
              flow: `${flow} (Squads)`,
              steps: 0,
              txs: 0,
              signatures: 0,
              rounds: 0,
            }
            let last: GeneratePoolGroupPlanResult<Nm> | undefined
            for (let wave = 0; wave < 20; wave++) {
              last = await build()
              if (!last.ready.length) break
              const { batches, otherActorSteps } = toPoolGroupSquadsBatch({
                ready: last.ready.map((r) => ({ id: r.step.id, transactions: r.transactions })),
                vault,
                snapshots: Object.fromEntries(
                  last.ready.flatMap((r) => (r.snapshot ? [[r.step.id, r.snapshot]] : [])),
                ),
              })
              assert.deepEqual(otherActorSteps, [])
              lanesPerTx(
                'materializePoolGroupLanes',
                last.ready.map((r) => ({ ...r.step, n: r.transactions.length })),
              )
              lanesPerTx(
                'admitPausedLanes',
                last.ready.map((r) => ({ ...r.step, n: r.transactions.length })),
              )
              for (const b of batches) {
                const index = await squads.proposeBatch(m1!, b.transactions)
                await squads.approve(index, m1!, m2!)
                await squads.executeBatch(m3!, index, b.transactions)
                row.rounds++
                // a proposal and two approvals, then an execute per transaction
                row.signatures += 3 + b.transactions.length
                row.txs += b.transactions.length
              }
              row.steps += last.ready.length
              landed.push(...last.ready.map((r) => r.step.id))
            }
            rows.push(row)
            return last!
          }
          const common = { payer: vault, getChain, runId, landedStepIds: landed }
          const base = { ...g, remoteChain, tokenAddresses: 'all-members' as const }
          const enable = await waves('enable from off', () =>
            cct.generateUnsignedEnableMultiTokenPoolChain({
              ...base,
              ...common,
              solana: { budget },
            }),
          )
          assert.equal(enable.blockedBy, undefined, enable.blockedBy?.reason ?? '')
          const onboard = await waves(`onboard ${N} behind the chain pause (to the check)`, () =>
            cct.generateUnsignedOnboardMultiTokenPoolTokens({
              ...g,
              tokens,
              unpause: true,
              ...common,
              solana: { budget },
            }),
          )
          assert.match(onboard.blockedBy?.reason ?? '', /lane check refuses/)
          const removed = await waves(`remove ${N}`, () =>
            cct.generateUnsignedRemoveMultiTokenPoolToken({
              ...removal,
              ...common,
              solana: { budget, ...removalSolana },
            }),
          )
          assert.equal(removed.blockedBy, undefined, removed.blockedBy?.reason ?? '')
          await waves('lift the chain pause', () =>
            cct.generateUnsignedEnableMultiTokenPoolChain({
              ...base,
              ...common,
              unpause: true,
              solana: { budget },
            }),
          )
          const live = await waves(`onboard ${N} onto the live chain (to the check)`, () =>
            cct.generateUnsignedOnboardMultiTokenPoolTokens({
              ...g,
              tokens,
              unpause: true,
              ...common,
              solana: { budget, acknowledgeLiveAdmission: true },
            }),
          )
          assert.match(live.blockedBy?.reason ?? '', /lane check refuses/)
          await waves(`remove ${N} (live chain)`, () =>
            cct.generateUnsignedRemoveMultiTokenPoolToken({
              ...removal,
              ...common,
              solana: { budget, ...removalSolana },
            }),
          )
          console.log(`S6 scaling N=${N}`, JSON.stringify(rows))
          console.log(`S6 scaling N=${N} lanes per tx`, JSON.stringify(perTx))
          console.log(`S6 scaling N=${N} Squads execute CU`, JSON.stringify(squads.executeCU))
          for (const x of squads.executeCU) assert.ok(x.consumed <= x.limit, JSON.stringify(x))
        } finally {
          await new Promise((r) => setTimeout(r, 1_500))
          await stopFork(started)
        }
      })
  },
)
