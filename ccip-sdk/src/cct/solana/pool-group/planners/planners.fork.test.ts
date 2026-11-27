/**
 * The shared planners on a Surfpool fork of Solana Devnet (S6), on the S5 fixture: the Devnet group
 * G2 (AgaDKRcg…, CONNECTION long toward the Sepolia MTTP) and the mints D and E (pools under 22P6h4,
 * registered on interface 2), handed to a signer on the fork. Each run: enable Sepolia, onboard D
 * and E through the planner (the §5.1 order), then remove D. Once with a wallet (signed planners), once with a 2-of-3
 * Squads vault (unsigned planners, ready steps batched with `toPoolGroupSquadsBatch`). The
 * transaction and approval counts are printed for the PRD.
 *
 * Enablement moves Sepolia out of 'off' behind its own pause; onboarding (the same `runId`, and
 * that pause's id in `landedStepIds`) joins and materializes behind it, checks every lane, then
 * lifts it: the lanes go live through the real lane check (Surfpool 1.6+ runs the Devnet Router).
 * Removal reads the Sepolia side first (it still sends: blocked, and a drain confirmation does not
 * stand in for the remote stop), then a `getChain` that cannot serve Sepolia makes the remote side
 * unreadable and the caller attests it (`confirmRemoteOutboundStopped`) and the drain. Then D
 * onboards again onto the now live Sepolia: refused without `acknowledgeLiveAdmission`, and with it
 * D joins without Sepolia, one transaction lists Sepolia, creates the lane and pauses it, the lane
 * check runs on the real accounts, and the lane pause is lifted (S6 review M6).
 *
 * Run: `with-private-rpcs.sh node --test src/cct/solana/pool-group/planners/planners.fork.test.ts`
 * from `ccip-sdk` (needs `surfpool`).
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { Wallet as AnchorWallet } from '@coral-xyz/anchor'
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from '@solana/web3.js'

import '../../../../index.ts'
import { reachableRpcEndpoint, rpcEndpoint } from '../../../../../../scripts/test-endpoints.ts'
import type { ChainGetter } from '../../../../chain.ts'
import { EVMChain } from '../../../../evm/index.ts'
import { networkInfo } from '../../../../networks.ts'
import {
  type SurfpoolInstance,
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
const D = '9f8hfytiF6aiEgVuvPyGLEztWjipruyeF2H3JZmMBQEh'
const E = 'E1hE7Kxs6AuURHA9MmK9te8Yr7up8gcnUdNqQgvetKu8'
const TKD = '0xcd686cd10978a16d0a93375ac8de9aa141eed2f1'
const TKE = '0x347453eb3cadc615b97cbca1f6f57383678566d5'
const SEPOLIA = networkInfo('ethereum-testnet-sepolia').chainSelector
const GROUP_OWNER_OFFSET = 8 + 1 + 1 + 32
const STATE_OWNER_OFFSET = 8 + 1 + 32 + 32 + 1 + 32 + 32
/** Fork Router artifacts (see the header). */

/** A fork of Devnet with G2, D and E handed to `owner`. */
async function forkFixture(port: number, owner: PublicKey) {
  const fork: { surfpool?: SurfpoolInstance; connection?: SolanaChain['connection'] } = {}
  const started = await startFork({ upstreamUrl: rpcEndpoint('RPC_SOLANA_DEVNET'), port })
  Object.assign(fork, started)
  const chain = new SolanaChain(started.connection, networkInfo('solana-devnet'), {
    apiClient: null,
  })
  const rewrite = async (address: string, offset: number) => {
    const info = await started.connection.getAccountInfo(new PublicKey(address))
    assert.ok(info, `${address} exists`)
    const data = Buffer.from(info.data)
    owner.toBuffer().copy(data, offset)
    await surfnetRequest(started.connection, 'surfnet_setAccount', [
      address,
      {
        data: data.toString('hex'),
        lamports: info.lamports,
        owner: info.owner.toBase58(),
        executable: false,
      },
    ])
  }
  await rewrite(G2, GROUP_OWNER_OFFSET)
  for (const mint of [D, E])
    await rewrite(
      deriveTokenPoolConfigPda(new PublicKey(PROGRAM), new PublicKey(mint)).toBase58(),
      STATE_OWNER_OFFSET,
    )
  return { fork, chain }
}

/** The shared chain values, as G2's Sepolia record holds them (so no section is rewritten). */
async function sepoliaConfig(
  cct: SolanaTokenManager,
): Promise<SolanaMultiTokenPoolRemoteChainConfig> {
  const record = await cct.getPoolGroupChain({
    poolProgramAddress: PROGRAM,
    poolGroupAddress: G2,
    remoteChainSelector: SEPOLIA,
  })
  const { connection, fee, rateLimit } = record.policy
  return {
    remoteChainSelector: SEPOLIA,
    remotePools: connection.remotePools,
    poolDataFormat: connection.poolDataFormat,
    rateLimits: rateLimit,
    tokenTransferFeeConfig: fee.tokenTransferFeeConfig,
  }
}

const onboardingTokens = [
  {
    tokenAddress: D,
    remoteTokens: [
      { remoteChainSelector: SEPOLIA, remoteTokenAddress: TKD, remoteTokenDecimals: 18 },
    ],
  },
  {
    tokenAddress: E,
    remoteTokens: [
      { remoteChainSelector: SEPOLIA, remoteTokenAddress: TKE, remoteTokenDecimals: 18 },
    ],
  },
]
const g = { poolProgramAddress: PROGRAM, poolGroupAddress: G2 }

/** Transaction and approval counts of one flow. */
type Counts = { steps: number; transactions: number; approvals: number }
const counts: Record<string, Counts> = {}

describe(
  'shared planners, signed (wallet), on the Devnet fork',
  { skip: !isSurfpoolAvailable(), timeout: 1_200_000 },
  () => {
    const owner = Keypair.generate()
    const wallet = () => new AnchorWallet(owner)
    let fx: Awaited<ReturnType<typeof forkFixture>>
    let cct: SolanaTokenManager
    let getChain: ChainGetter
    let runId = ''
    before(async () => {
      fx = await forkFixture(18_971, owner.publicKey)
      cct = SolanaTokenManager.fromChain(fx.chain)
      const sig = await fx.chain.connection.requestAirdrop(owner.publicKey, 20 * LAMPORTS_PER_SOL)
      await fx.chain.connection.confirmTransaction(sig)
      const sepolia = await EVMChain.fromUrl(await reachableRpcEndpoint('RPC_SEPOLIA'))
      getChain = async (selector) => {
        if (selector === SEPOLIA) return sepolia
        throw new CCTParamsInvalidError('test', 'getChain', `no RPC for ${selector}`)
      }
    })
    after(() => stopFork(fx.fork))

    const tally = (name: string, steps: { hashes: string[] }[]) => {
      const transactions = steps.reduce((n, s) => n + s.hashes.length, 0)
      // a wallet signs every transaction once
      counts[name] = { steps: steps.length, transactions, approvals: transactions }
    }

    it('onboarding before the chain is enabled is refused: remoteTokens is the exact lane set', async () => {
      await assert.rejects(
        cct.getMultiTokenPoolTokenOnboardingPlan({
          ...g,
          tokens: onboardingTokens,
          payer: owner.publicKey.toBase58(),
        }),
        (e: unknown) =>
          e instanceof CCTParamsInvalidError && /enable the chain first/.test(e.message),
      )
    })

    let pauseId = ''
    it("enable Sepolia: the record leaves off behind this run's pause; a re-plan never lifts it without the landed id", async () => {
      const remoteChain = await sepoliaConfig(cct)
      const base = { ...g, remoteChain, tokenAddresses: 'all-members' as const }
      const r = await cct.enableMultiTokenPoolChain({ ...base, getChain, wallet: wallet() })
      assert.equal(r.blockedBy, undefined, r.blockedBy?.reason ?? '')
      assert.deepEqual(
        r.steps.map((s) => s.name),
        ['pausePoolGroupChainLanes'],
      )
      tally('enable (wallet)', r.steps)
      pauseId = r.steps[0]!.id
      runId = r.runId
      assert.ok(pauseId.endsWith(`/run-${runId}`), pauseId)
      const record = await cct.getPoolGroupChain({ ...g, remoteChainSelector: SEPOLIA })
      assert.equal(record.laneMode, 'all-members')
      assert.equal(record.drivenLanesPaused, true)
      // another run (a new runId) never lifts it, even with the old landed id (M2)
      const again = await cct.getMultiTokenPoolChainEnablementPlan({
        ...base,
        unpause: true,
        landedStepIds: [pauseId],
        payer: owner.publicKey.toBase58(),
      })
      assert.match(again.blockedBy?.reason ?? '', /landedStepIds/)
      assert.notEqual(again.runId, runId)
    })

    it('onboard D and E behind that pause: join, materialize paused, check, then lift the landed pause; lanes live (§5.1 check)', async () => {
      const r = await cct.onboardMultiTokenPoolTokens({
        ...g,
        tokens: onboardingTokens,
        unpause: true,
        runId,
        landedStepIds: [pauseId],
        getChain,
        wallet: wallet(),
      })
      assert.equal(r.blockedBy, undefined, r.blockedBy?.reason ?? '')
      assert.deepEqual(
        r.steps.map((s) => s.name),
        ['joinPoolGroup', 'materializePoolGroupLanes', 'unpausePoolGroupChainLanes'],
      )
      tally('onboard 2 tokens (wallet)', r.steps)
      for (const { tokenAddress } of onboardingTokens) {
        const check = await cct.checkMultiTokenPoolLane({
          poolAddress: PROGRAM,
          tokenAddress,
          remoteChainSelector: SEPOLIA,
          getChain,
          expectOpen: ['outbound', 'inbound'],
        })
        assert.ok(
          check.ok,
          `${tokenAddress}: ${check.findings.map((f) => `${f.check}: ${f.reason}`).join('; ')}`,
        )
      }
      const plan = await cct.getMultiTokenPoolTokenOnboardingPlan({
        ...g,
        tokens: onboardingTokens,
        getChain,
        payer: owner.publicKey.toBase58(),
      })
      assert.deepEqual(plan.steps, [])
    })

    it('remove D: pause outbound, await the drain until confirmed, drop and close in one tx, close the member', async () => {
      const lane = { tokenAddress: D, remoteChainSelector: SEPOLIA }
      // read through getChain, the Sepolia side still sends: blocked at the remote stop
      const blocked = await cct.removeMultiTokenPoolToken({
        ...g,
        tokenAddress: D,
        getChain,
        wallet: wallet(),
      })
      assert.deepEqual(
        blocked.steps.map((s) => s.name),
        ['pauseLaneOutbound'],
      )
      assert.match(blocked.blockedBy?.reason ?? '', /still sends/)
      // M4: the drain attestation never stands in for the remote stop of a readable remote
      const drainOnly = await cct.getMultiTokenPoolTokenRemovalPlan({
        ...g,
        tokenAddress: D,
        getChain,
        solana: { confirmInFlightDrained: [lane] },
        payer: owner.publicKey.toBase58(),
      })
      assert.match(drainOnly.blockedBy?.reason ?? '', /still sends/)
      // ... nor does omitting getChain: an EVM side the SDK reads needs it
      const noGetChain = await cct.getMultiTokenPoolTokenRemovalPlan({
        ...g,
        tokenAddress: D,
        solana: { confirmRemoteOutboundStopped: [lane], confirmInFlightDrained: [lane] },
        payer: owner.publicKey.toBase58(),
      })
      assert.match(noGetChain.blockedBy?.reason ?? '', /pass getChain/)
      // a getChain that cannot serve Sepolia leaves the remote unread: the caller attests it
      const unreachable: ChainGetter = (selector) =>
        Promise.reject(new CCTParamsInvalidError('test', 'getChain', `unreachable ${selector}`))
      const r = await cct.removeMultiTokenPoolToken({
        ...g,
        tokenAddress: D,
        getChain: unreachable,
        solana: { confirmRemoteOutboundStopped: [lane], confirmInFlightDrained: [lane] },
        wallet: wallet(),
      })
      assert.equal(r.blockedBy, undefined, r.blockedBy?.reason ?? '')
      assert.deepEqual(
        r.steps.map((s) => s.name),
        ['dropChainsAndCloseLanes', 'closePoolGroupMembers'],
      )
      tally('remove 1 token (wallet)', [...blocked.steps, ...r.steps])
      const { poolGroupMembers } = await cct.getPoolGroupMembers(g)
      const mints = poolGroupMembers.map((m) => m.tokenAddress)
      assert.ok(mints.includes(E) && !mints.includes(D), String(mints))
    })

    it('onboard D onto the live Sepolia: refused without the acknowledgement; with it, created paused in one tx, checked, lifted (M6)', async () => {
      const record = await cct.getPoolGroupChain({ ...g, remoteChainSelector: SEPOLIA })
      assert.equal(record.drivenLanesPaused, false, 'Sepolia is live')
      const tokens = [onboardingTokens[0]!]
      const refused = await cct.onboardMultiTokenPoolTokens({
        ...g,
        tokens,
        unpause: true,
        getChain,
        wallet: wallet(),
      })
      assert.deepEqual(
        refused.steps.map((s) => s.name),
        ['joinPoolGroup'],
      )
      assert.match(refused.blockedBy?.reason ?? '', /acknowledgeLiveAdmission/)
      // the join listed no live chain: no one can materialize D's Sepolia lane
      const [joined] = (await cct.getPoolGroupMembers({ ...g, tokenAddresses: [D] }))
        .poolGroupMembers
      assert.deepEqual(joined?.remoteTokens, [])
      const r = await cct.onboardMultiTokenPoolTokens({
        ...g,
        tokens,
        unpause: true,
        getChain,
        solana: { acknowledgeLiveAdmission: true },
        wallet: wallet(),
      })
      assert.equal(r.blockedBy, undefined, r.blockedBy?.reason ?? '')
      assert.deepEqual(
        r.steps.map((s) => s.name),
        ['admitPausedLanes', 'unpausePoolGroupLanes'],
      )
      // one transaction listed Sepolia, created the lane and paused it
      assert.equal(r.steps[0]!.hashes.length, 1)
      tally('onboard 1 token onto a live chain (wallet)', [...refused.steps, ...r.steps])
      const check = await cct.checkMultiTokenPoolLane({
        poolAddress: PROGRAM,
        tokenAddress: D,
        remoteChainSelector: SEPOLIA,
        getChain,
        expectOpen: ['outbound', 'inbound'],
      })
      assert.ok(check.ok, check.findings.map((f) => `${f.check}: ${f.reason}`).join('; '))
    })
  },
)

describe(
  'shared planners, unsigned (Squads v4 vault), on the Devnet fork',
  { skip: !isSurfpoolAvailable(), timeout: 1_200_000 },
  () => {
    const [creator, m1, m2, m3] = [
      Keypair.generate(),
      Keypair.generate(),
      Keypair.generate(),
      Keypair.generate(),
    ]
    let squads: SquadsHarness
    let fx: Awaited<ReturnType<typeof forkFixture>>
    let cct: SolanaTokenManager
    let vault: string
    const landed: string[] = []
    const runId = 'squads-fork-run'
    let getChain: ChainGetter
    before(async () => {
      const sepolia = await EVMChain.fromUrl(await reachableRpcEndpoint('RPC_SEPOLIA'))
      getChain = async (selector) => {
        if (selector === SEPOLIA) return sepolia
        throw new CCTParamsInvalidError('test', 'getChain', `no RPC for ${selector}`)
      }
      fx = await forkFixture(18_973, PublicKey.default)
      for (const key of [creator, m1, m2, m3]) {
        const sig = await fx.chain.connection.requestAirdrop(key.publicKey, 10 * LAMPORTS_PER_SOL)
        await fx.chain.connection.confirmTransaction(sig)
      }
      squads = new SquadsHarness(fx.chain.connection)
      // CALIBRATE=1: run executes at the maximum limit and print what each consumed
      if (process.env.CALIBRATE) squads.computeUnitLimitOverride = 1_400_000
      await squads.create(
        creator,
        Keypair.generate(),
        [m1.publicKey, m2.publicKey, m3.publicKey],
        2,
      )
      vault = squads.vault.toBase58()
      await squads.send(
        'fundVault',
        [creator],
        [
          SystemProgram.transfer({
            fromPubkey: creator.publicKey,
            toPubkey: squads.vault,
            lamports: 3 * LAMPORTS_PER_SOL,
          }),
        ],
      )
      // hand G2 and the pools to the vault
      const rewrite = async (address: string, offset: number) => {
        const info = await fx.chain.connection.getAccountInfo(new PublicKey(address))
        const data = Buffer.from(info!.data)
        squads.vault.toBuffer().copy(data, offset)
        await surfnetRequest(fx.chain.connection, 'surfnet_setAccount', [
          address,
          {
            data: data.toString('hex'),
            lamports: info!.lamports,
            owner: info!.owner.toBase58(),
            executable: false,
          },
        ])
      }
      await rewrite(G2, GROUP_OWNER_OFFSET)
      for (const mint of [D, E])
        await rewrite(
          deriveTokenPoolConfigPda(new PublicKey(PROGRAM), new PublicKey(mint)).toBase58(),
          STATE_OWNER_OFFSET,
        )
      cct = SolanaTokenManager.fromChain(fx.chain)
    })
    after(() => stopFork(fx.fork))

    /** One approval wave per call: build the ready steps, batch them, propose, approve, execute. */
    async function waves<N extends string>(
      name: string,
      build: () => Promise<GeneratePoolGroupPlanResult<N>>,
    ) {
      const c: Counts = { steps: 0, transactions: 0, approvals: 0 }
      let last: GeneratePoolGroupPlanResult<N> | undefined
      for (let wave = 0; wave < 10; wave++) {
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
        for (const b of batches) {
          const index = await squads.proposeBatch(m1, b.transactions)
          await squads.approve(index, m1, m2)
          await squads.executeBatch(m3, index, b.transactions)
          c.approvals++
          c.transactions += b.transactions.length
        }
        c.steps += last.ready.length
        landed.push(...last.ready.map((r) => r.step.id))
      }
      counts[name] = c
      return last!
    }

    it('enable, onboard 2, remove 1 through Squads batches', async () => {
      const remoteChain = await sepoliaConfig(cct)
      const budget = { executor: 'squads-v4' as const }
      const enable = await waves('enable (Squads)', () =>
        cct.generateUnsignedEnableMultiTokenPoolChain({
          ...g,
          remoteChain,
          tokenAddresses: 'all-members',
          payer: vault,
          getChain,
          runId,
          landedStepIds: landed,
          solana: { budget },
        }),
      )
      assert.equal(enable.blockedBy, undefined, enable.blockedBy?.reason ?? '')
      const onboard = await waves('onboard 2 tokens (Squads)', () =>
        cct.generateUnsignedOnboardMultiTokenPoolTokens({
          ...g,
          tokens: onboardingTokens,
          unpause: true,
          payer: vault,
          getChain,
          runId,
          landedStepIds: landed,
          solana: { budget },
        }),
      )
      assert.equal(onboard.blockedBy, undefined, onboard.blockedBy?.reason ?? '')
      assert.equal(
        (await cct.getPoolGroupChain({ ...g, remoteChainSelector: SEPOLIA })).drivenLanesPaused,
        false,
      )
      const lane = { tokenAddress: D, remoteChainSelector: SEPOLIA }
      const unreachable: ChainGetter = (selector) =>
        Promise.reject(new CCTParamsInvalidError('test', 'getChain', `unreachable ${selector}`))
      const removed = await waves('remove 1 token (Squads)', () =>
        cct.generateUnsignedRemoveMultiTokenPoolToken({
          ...g,
          tokenAddress: D,
          payer: vault,
          getChain: unreachable,
          runId,
          landedStepIds: landed,
          solana: {
            budget,
            confirmRemoteOutboundStopped: [lane],
            confirmInFlightDrained: [lane],
          },
        }),
      )
      assert.equal(removed.blockedBy, undefined, removed.blockedBy?.reason ?? '')
      const { poolGroupMembers } = await cct.getPoolGroupMembers(g)
      const mints = poolGroupMembers.map((m) => m.tokenAddress)
      assert.ok(mints.includes(E) && !mints.includes(D), String(mints))
      // D again, onto the live Sepolia: paused creation in one vault transaction, then the lift
      const live = await waves('onboard 1 token onto a live chain (Squads)', () =>
        cct.generateUnsignedOnboardMultiTokenPoolTokens({
          ...g,
          tokens: [onboardingTokens[0]!],
          unpause: true,
          payer: vault,
          getChain,
          runId,
          landedStepIds: landed,
          solana: { budget, acknowledgeLiveAdmission: true },
        }),
      )
      assert.equal(live.blockedBy, undefined, live.blockedBy?.reason ?? '')
      const check = await cct.checkMultiTokenPoolLane({
        poolAddress: PROGRAM,
        tokenAddress: D,
        remoteChainSelector: SEPOLIA,
        getChain,
        expectOpen: ['outbound', 'inbound'],
      })
      assert.ok(check.ok, check.findings.map((f) => `${f.check}: ${f.reason}`).join('; '))
      console.log('S6 planner counts', JSON.stringify(counts))
      console.log('S6 Squads execute CU', JSON.stringify(squads.executeCU))
      // the SDK's outer limit covers what each execute consumed (the calibrated overhead)
      if (!process.env.CALIBRATE)
        for (const x of squads.executeCU) assert.ok(x.consumed <= x.limit, JSON.stringify(x))
    })
  },
)
