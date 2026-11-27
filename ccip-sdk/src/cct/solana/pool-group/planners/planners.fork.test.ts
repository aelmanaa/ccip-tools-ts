/**
 * The shared planners on a Surfpool fork of Solana Devnet (S6), on the S5 fixture: the Devnet group
 * G2 (AgaDKRcg…, CONNECTION long toward the Sepolia MTTP) and the mints D and E (pools under 22P6h4,
 * registered on interface 2), handed to a signer on the fork. Each run: enable Sepolia, onboard D
 * and E through the planner, then remove D. Once with a wallet (signed planners), once with a 2-of-3
 * Squads vault (unsigned planners, ready steps batched with `toPoolGroupSquadsBatch`). The
 * transaction and approval counts are printed for the PRD.
 *
 * Fork limit: Surfpool 1.1.2 cannot run the Devnet Router (an SBPF v3 ELF), so every lane check
 * reads it as "not a CCIP Router" (TOKEN_NOT_REGISTERED, POOL_DATA_FORMAT_MISMATCH). No lane can be
 * made live here: enablement runs without `unpause` (the chain stays paused behind its own pause
 * step), onboarding ends at `checkLanes`, blocked by those artifacts only, and removal confirms the
 * drain (the remote side is not read).
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
const ARTIFACTS = /TOKEN_NOT_REGISTERED|POOL_DATA_FORMAT_MISMATCH/

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

    it('enable Sepolia: the record leaves off behind its own pause; nothing else to write', async () => {
      const remoteChain = await sepoliaConfig(cct)
      const plan = await cct.getMultiTokenPoolChainEnablementPlan({
        ...g,
        remoteChain,
        tokenAddresses: 'all-members',
        payer: owner.publicKey.toBase58(),
      })
      assert.deepEqual(
        plan.steps.map((s) => s.name),
        ['pausePoolGroupChainLanes', 'checkLanes'],
      )
      const r = await cct.enableMultiTokenPoolChain({
        ...g,
        remoteChain,
        tokenAddresses: 'all-members',
        getChain,
        wallet: wallet(),
      })
      assert.equal(r.blockedBy, undefined, r.blockedBy?.reason ?? '')
      assert.deepEqual(
        r.steps.map((s) => s.name),
        ['pausePoolGroupChainLanes'],
      )
      tally('enable (wallet)', r.steps)
      const record = await cct.getPoolGroupChain({ ...g, remoteChainSelector: SEPOLIA })
      assert.equal(record.laneMode, 'all-members')
      assert.equal(record.drivenLanesPaused, true)
      // a re-plan with unpause and no landed ids fails closed: the pause is named, never lifted
      const again = await cct.getMultiTokenPoolChainEnablementPlan({
        ...g,
        remoteChain,
        tokenAddresses: 'all-members',
        unpause: true,
        payer: owner.publicKey.toBase58(),
      })
      assert.match(again.blockedBy?.reason ?? '', /landedStepIds/)
      assert.ok(
        again.blockedBy?.steps?.some((id) => id.endsWith(`pausePoolGroupChainLanes/${SEPOLIA}`)),
      )
      // with this run's pause listed as landed, the unpause is planned (it would lift only that)
      const landed = await cct.getMultiTokenPoolChainEnablementPlan({
        ...g,
        remoteChain,
        tokenAddresses: 'all-members',
        unpause: true,
        landedStepIds: r.steps.map((s) => s.id),
        payer: owner.publicKey.toBase58(),
      })
      assert.ok(landed.steps.some((s) => s.name === 'unpausePoolGroupChainLanes'))
    })

    it('onboard D and E: joins and lanes land paused; the plan ends at checkLanes, blocked by fork artifacts only', async () => {
      const r = await cct.onboardMultiTokenPoolTokens({
        ...g,
        tokens: onboardingTokens,
        getChain,
        wallet: wallet(),
      })
      assert.deepEqual(
        new Set(r.steps.map((s) => s.name)),
        new Set(['joinPoolGroup', 'materializePoolGroupLanes']),
      )
      tally('onboard 2 tokens (wallet)', r.steps)
      assert.ok(r.blockedBy, 'blocked at the lane check')
      const reasons = r.blockedBy.reason.split('; ').filter((x) => /→/.test(x))
      assert.ok(reasons.length && reasons.every((x) => ARTIFACTS.test(x)), r.blockedBy.reason)
      const lanes = await cct.getPoolGroupLanes({
        ...g,
        remoteChainSelector: SEPOLIA,
        kind: 'driven',
      })
      assert.deepEqual(new Set(lanes.map((l) => l.tokenAddress)), new Set([D, E]))
      assert.ok(lanes.every((l) => l.pausedOutbound && l.pausedInbound))
      // a resume plans nothing more to write: the state shows every landed step
      const plan = await cct.getMultiTokenPoolTokenOnboardingPlan({
        ...g,
        tokens: onboardingTokens,
        payer: owner.publicKey.toBase58(),
      })
      assert.deepEqual(
        plan.steps.map((s) => s.name),
        ['checkLanes'],
      )
    })

    it('remove D: pause outbound, await the drain until confirmed, drop and close in one tx, close the member', async () => {
      const lane = { tokenAddress: D, remoteChainSelector: SEPOLIA }
      const blocked = await cct.removeMultiTokenPoolToken({
        ...g,
        tokenAddress: D,
        wallet: wallet(),
      })
      assert.deepEqual(
        blocked.steps.map((s) => s.name),
        ['pauseLaneOutbound'],
      )
      assert.match(blocked.blockedBy?.reason ?? '', /confirmInFlightDrained/)
      const r = await cct.removeMultiTokenPoolToken({
        ...g,
        tokenAddress: D,
        solana: { confirmInFlightDrained: [lane] },
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
    before(async () => {
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
          maxReadySteps: 20,
          landedStepIds: landed,
          solana: { budget },
        }),
      )
      assert.equal(enable.blockedBy, undefined, enable.blockedBy?.reason ?? '')
      const onboard = await waves('onboard 2 tokens (Squads)', () =>
        cct.generateUnsignedOnboardMultiTokenPoolTokens({
          ...g,
          tokens: onboardingTokens,
          payer: vault,
          maxReadySteps: 20,
          landedStepIds: landed,
          solana: { budget },
        }),
      )
      assert.ok(
        onboard.blockedBy && ARTIFACTS.test(onboard.blockedBy.reason),
        onboard.blockedBy?.reason ?? 'not blocked',
      )
      const lane = { tokenAddress: D, remoteChainSelector: SEPOLIA }
      const removed = await waves('remove 1 token (Squads)', () =>
        cct.generateUnsignedRemoveMultiTokenPoolToken({
          ...g,
          tokenAddress: D,
          payer: vault,
          maxReadySteps: 20,
          landedStepIds: landed,
          solana: { budget, confirmInFlightDrained: [lane] },
        }),
      )
      assert.equal(removed.blockedBy, undefined, removed.blockedBy?.reason ?? '')
      const { poolGroupMembers } = await cct.getPoolGroupMembers(g)
      const mints = poolGroupMembers.map((m) => m.tokenAddress)
      assert.ok(mints.includes(E) && !mints.includes(D), String(mints))
      console.log('S6 planner counts', JSON.stringify(counts))
      console.log('S6 Squads execute CU', JSON.stringify(squads.executeCU))
    })
  },
)
