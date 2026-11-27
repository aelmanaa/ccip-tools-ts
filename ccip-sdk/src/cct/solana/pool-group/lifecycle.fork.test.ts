/**
 * Pool-group lifecycle and roles (S3a) on a Surfpool fork of Solana Devnet, against the pool-groups
 * program of record (22P6h4…, fork 7558722) as deployed there. Every write lands on the local fork.
 *
 * A fresh group goes through create (roles and chains), the squatting refusal, merged roles,
 * settings, a stale snapshot, the snapshot check, and a transfer and accept. The Devnet group
 * BDiS… (two linked lanes) is handed to a test key on the fork (its owner bytes rewritten), so the
 * lane guard runs on real lanes: a lower cap and an accept change their chain record.
 *
 * Run: `cd ccip-sdk && node --test src/cct/solana/pool-group/lifecycle.fork.test.ts` (needs
 * `surfpool`; `RPC_SOLANA_DEVNET` overrides the upstream).
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { BN, Wallet as AnchorWallet } from '@coral-xyz/anchor'
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'

import '../../../index.ts'
import { rpcEndpoint } from '../../../../../scripts/test-endpoints.ts'
import { networkInfo } from '../../../networks.ts'
import {
  type SurfpoolInstance,
  isSurfpoolAvailable,
  startFork,
  stopFork,
  surfnetRequest,
} from '../../../solana/__tests__/surfpool.ts'
import { SolanaChain } from '../../../solana/index.ts'
import { deriveTokenPoolChainConfigV2Pda } from '../../../solana/token-pool.ts'
import { CCTParamsInvalidError, CCTStateChangedError } from '../../errors.ts'
import { SolanaTokenManager } from '../index.ts'
import { deriveEventAuthorityPda } from '../programs/token-pool.ts'
import { poolGroupPdas } from './accounts.ts'
import { readPoolState } from './multi-token-pool-lane.ts'
import { createPoolGroupProgram } from './program.ts'

const PROGRAM = '22P6h4QV5wswBX63KCncFGctC9dyVRMjykBBDdhwXjg7'
const LINKED_GROUP = 'BDiSFAren1qkqK5BjT3JpFNbbTbawoC6YxVghrAwDGbt'
const SEPOLIA = networkInfo('ethereum-testnet-sepolia').chainSelector
const FUJI = networkInfo('avalanche-testnet-fuji').chainSelector
const PORT = 18_941
/** `Group.owner`: after the discriminator, version, bump and group id. */
const GROUP_OWNER_OFFSET = 8 + 1 + 1 + 32

describe(
  'pool-group lifecycle and roles (Devnet fork)',
  { skip: !isSurfpoolAvailable(), timeout: 600_000 },
  () => {
    const fork: { surfpool?: SurfpoolInstance; connection?: SolanaChain['connection'] } = {}
    let cct: SolanaTokenManager
    const [owner, next, other, ops] = [
      Keypair.generate(),
      Keypair.generate(),
      Keypair.generate(),
      Keypair.generate(),
    ]
    const ref = { poolProgramAddress: PROGRAM }
    let poolGroupAddress: string

    before(async () => {
      const started = await startFork({ upstreamUrl: rpcEndpoint('RPC_SOLANA_DEVNET'), port: PORT })
      Object.assign(fork, started)
      const chain = new SolanaChain(started.connection, networkInfo('solana-devnet'), {
        apiClient: null,
      })
      cct = SolanaTokenManager.fromChain(chain)
      for (const key of [owner, next, other]) {
        const sig = await started.connection.requestAirdrop(key.publicKey, 10 * LAMPORTS_PER_SOL)
        await started.connection.confirmTransaction(sig)
      }
    })
    after(() => stopFork(fork))

    it('creates a group with roles and two chains in one transaction', async () => {
      const r = await cct.createPoolGroup({
        ...ref,
        initialRoles: { feeAdmin: ops.publicKey.toBase58(), pauser: null },
        initialChains: [SEPOLIA, FUJI],
        wallet: new AnchorWallet(owner),
      })
      poolGroupAddress = r.poolGroupAddress
      assert.equal(r.transactions.length, 1)
      assert.deepEqual(r.affectedLanes, [])
      const g = await cct.getPoolGroup({ ...ref, poolGroupAddress })
      assert.equal(g.owner, owner.publicKey.toBase58())
      assert.equal(g.roles.feeAdmin, ops.publicKey.toBase58())
      assert.equal(g.roles.pauser, null)
      assert.equal(g.roles.policyAdmin, owner.publicKey.toBase58())
      assert.deepEqual(g.remoteChainSelectors, [SEPOLIA, FUJI])
      assert.equal(g.maxBpsFee, 1_000)
      assert.equal(g.minCCVActivationDelay, 86_400n)
    })

    it('refuses an id someone else owns; completes only missing chains for its owner', async () => {
      const poolGroupId = (await cct.getPoolGroup({ ...ref, poolGroupAddress })).poolGroupId
      await assert.rejects(
        cct.createPoolGroup({ ...ref, poolGroupId, wallet: new AnchorWallet(other) }),
        (e: unknown) => e instanceof CCTParamsInvalidError && e.context.param === 'poolGroupId',
      )
      const unsigned = await cct.generateUnsignedCreatePoolGroup({
        ...ref,
        poolGroupId,
        initialChains: [SEPOLIA, FUJI],
        payer: owner.publicKey.toBase58(),
      })
      assert.equal(unsigned.transactions.length, 0)
    })

    it('merges roles; a non-owner is refused before simulation', async () => {
      const r = await cct.setPoolGroupRoles({
        ...ref,
        poolGroupAddress,
        roles: { pauser: ops.publicKey.toBase58() },
        wallet: new AnchorWallet(owner),
      })
      assert.ok(r.snapshot)
      const g = await cct.getPoolGroup({ ...ref, poolGroupAddress })
      assert.equal(g.roles.pauser, ops.publicKey.toBase58())
      assert.equal(g.roles.feeAdmin, ops.publicKey.toBase58())
      await assert.rejects(
        cct.setPoolGroupRoles({
          ...ref,
          poolGroupAddress,
          roles: { pauser: null },
          wallet: new AnchorWallet(other),
        }),
        (e: unknown) => e instanceof CCTParamsInvalidError && e.context.param === 'authority',
      )
    })

    it('a stale snapshot is refused; the snapshot check reports what moved', async () => {
      const unsigned = await cct.generateUnsignedSetPoolGroupRoles({
        ...ref,
        poolGroupAddress,
        roles: { unpauser: ops.publicKey.toBase58() },
        payer: owner.publicKey.toBase58(),
      })
      const check = await cct.checkPoolGroupSnapshot({
        ...ref,
        poolGroupAddress,
        snapshot: unsigned.snapshot!,
        transaction: unsigned.transactions[0]!,
      })
      assert.equal(check.ok, true, JSON.stringify(check.changed))
      // someone changes the roles meanwhile
      await cct.setPoolGroupRoles({
        ...ref,
        poolGroupAddress,
        roles: { rateLimitAdmin: ops.publicKey.toBase58() },
        wallet: new AnchorWallet(owner),
      })
      const moved = await cct.checkPoolGroupSnapshot({
        ...ref,
        poolGroupAddress,
        snapshot: unsigned.snapshot!,
        transaction: unsigned.transactions[0]!,
      })
      assert.equal(moved.ok, false)
      assert.deepEqual(
        moved.changed.map((c) => c.path),
        ['group.roles'],
      )
      await assert.rejects(
        cct.setPoolGroupRoles({
          ...ref,
          poolGroupAddress,
          roles: { unpauser: ops.publicKey.toBase58() },
          expectedSnapshot: unsigned.snapshot!,
          wallet: new AnchorWallet(owner),
        }),
        CCTStateChangedError,
      )
    })

    it('settings: lowers the cap and lengthens the notice; a higher cap is refused', async () => {
      await cct.setPoolGroupSettings({
        ...ref,
        poolGroupAddress,
        maxBpsFee: 500,
        minCCVActivationDelay: 172_800,
        wallet: new AnchorWallet(owner),
      })
      const g = await cct.getPoolGroup({ ...ref, poolGroupAddress })
      assert.equal(g.maxBpsFee, 500)
      assert.equal(g.minCCVActivationDelay, 172_800n)
      assert.equal(g.openMembership, false)
      await assert.rejects(
        cct.setPoolGroupSettings({
          ...ref,
          poolGroupAddress,
          maxBpsFee: 600,
          wallet: new AnchorWallet(owner),
        }),
        (e: unknown) => e instanceof CCTParamsInvalidError && e.context.param === 'maxBpsFee',
      )
    })

    it('transfer and accept: roles cleared, follow-ups listed; only the proposed owner accepts', async () => {
      await cct.transferPoolGroupOwnership({
        ...ref,
        poolGroupAddress,
        proposedOwner: next.publicKey.toBase58(),
        wallet: new AnchorWallet(owner),
      })
      await assert.rejects(
        cct.acceptPoolGroupOwnership({ ...ref, poolGroupAddress, wallet: new AnchorWallet(other) }),
        (e: unknown) => e instanceof CCTParamsInvalidError && e.context.param === 'authority',
      )
      const r = await cct.acceptPoolGroupOwnership({
        ...ref,
        poolGroupAddress,
        wallet: new AnchorWallet(next),
      })
      assert.ok(r.followUps?.some((f) => f.operation === 'setPoolGroupRoles'))
      const g = await cct.getPoolGroup({ ...ref, poolGroupAddress })
      assert.equal(g.owner, next.publicKey.toBase58())
      assert.equal(g.proposedOwner, null)
      assert.ok(Object.values(g.roles).every((v) => v === null))
    })

    it('a group with linked lanes: a lower cap and an accept judge their lanes', async () => {
      const connection = fork.connection!
      const address = new PublicKey(LINKED_GROUP)
      const info = await connection.getAccountInfo(address)
      assert.ok(info, 'the Devnet group exists')
      const data = Buffer.from(info.data)
      owner.publicKey.toBuffer().copy(data, GROUP_OWNER_OFFSET)
      await surfnetRequest(connection, 'surfnet_setAccount', [
        LINKED_GROUP,
        {
          data: data.toString('hex'),
          lamports: info.lamports,
          owner: info.owner.toBase58(),
          executable: false,
        },
      ])
      const before = await cct.getPoolGroup({ ...ref, poolGroupAddress: LINKED_GROUP })
      assert.equal(before.owner, owner.publicKey.toBase58())
      const lanes = await cct.getPoolGroupLanes({ ...ref, poolGroupAddress: LINKED_GROUP })
      assert.ok(lanes.length >= 1)

      const lower = await cct.generateUnsignedSetPoolGroupSettings({
        ...ref,
        poolGroupAddress: LINKED_GROUP,
        maxBpsFee: before.maxBpsFee - 1,
        payer: owner.publicKey.toBase58(),
      })
      assert.deepEqual(
        lower.affectedLanes.map((l) => l.tokenAddress).sort(),
        lanes.map((l) => l.tokenAddress).sort(),
      )
      assert.deepEqual(lower.goingLive, [])

      await cct.transferPoolGroupOwnership({
        ...ref,
        poolGroupAddress: LINKED_GROUP,
        proposedOwner: next.publicKey.toBase58(),
        wallet: new AnchorWallet(owner),
      })
      const accepted = await cct.acceptPoolGroupOwnership({
        ...ref,
        poolGroupAddress: LINKED_GROUP,
        wallet: new AnchorWallet(next),
      })
      assert.equal(accepted.affectedLanes.length, lanes.length)
      assert.deepEqual(accepted.goingLive, [])
      const after = await cct.getPoolGroup({ ...ref, poolGroupAddress: LINKED_GROUP })
      assert.equal(after.owner, next.publicKey.toBase58())
      assert.equal(after.securityGeneration, before.securityGeneration + 1)
      // the lanes still work: no named SECURITY policy, nothing pending was cancelled
      const check = await cct.checkMultiTokenPoolLane({
        tokenAddress: lanes[0]!.tokenAddress,
        remoteChainSelector: lanes[0]!.remoteChainSelector,
        poolAddress: PROGRAM,
      })
      assert.deepEqual(
        check.findings.filter((f) => f.check === 'CCVS_NOT_SYNCED').map((f) => f.reason),
        [],
      )
    })

    it('resume: a partial landing is completed with the same id; passed roles that differ are written', async () => {
      const chains = Array.from({ length: 20 }, (_, i) => BigInt(1_000 + i))
      const unsigned = await cct.generateUnsignedCreatePoolGroup({
        ...ref,
        initialChains: chains,
        payer: owner.publicKey.toBase58(),
      })
      // the chains past the first transaction need the group: a resume follow-up, same id
      assert.equal(unsigned.transactions.length, 1)
      assert.equal(unsigned.resumed, false)
      const resume = unsigned.followUps?.find((f) => f.operation === 'createPoolGroup')
      assert.equal(resume?.inputs?.poolGroupId, unsigned.poolGroupId)
      // only the first transaction lands (as after an expired second send)
      const connection = fork.connection!
      const first = unsigned.transactions[0]!
      const { blockhash } = await connection.getLatestBlockhash()
      const tx = new VersionedTransaction(
        new TransactionMessage({
          payerKey: owner.publicKey,
          recentBlockhash: blockhash,
          instructions: first.instructions,
        }).compileToV0Message(),
      )
      tx.sign([owner])
      await connection.confirmTransaction(await connection.sendTransaction(tx))
      const landed = await cct.getPoolGroup({ ...ref, poolGroupAddress: unsigned.poolGroupAddress })
      const resumed = await cct.createPoolGroup({
        ...ref,
        poolGroupId: unsigned.poolGroupId,
        initialChains: chains,
        initialRoles: { pauser: ops.publicKey.toBase58() },
        wallet: new AnchorWallet(owner),
      })
      assert.equal(resumed.resumed, true)
      assert.equal(resumed.poolGroupId, unsigned.poolGroupId)
      const g = await cct.getPoolGroup({ ...ref, poolGroupAddress: unsigned.poolGroupAddress })
      assert.deepEqual(
        [...g.remoteChainSelectors].sort((a, b) => Number(a - b)),
        chains,
      )
      assert.ok(landed.remoteChainSelectors.length < chains.length)
      assert.equal(g.roles.pauser, ops.publicKey.toBase58())
      // N3: a lowered notice is scheduled once; a rerun with the same value builds nothing
      const lower = await cct.createPoolGroup({
        ...ref,
        poolGroupId: unsigned.poolGroupId,
        minCCVActivationDelay: 3_600,
        wallet: new AnchorWallet(owner),
      })
      assert.equal(lower.transactions.length, 1)
      const again = await cct.generateUnsignedCreatePoolGroup({
        ...ref,
        poolGroupId: unsigned.poolGroupId,
        minCCVActivationDelay: 3_600,
        payer: owner.publicKey.toBase58(),
      })
      assert.equal(again.transactions.length, 0)
      // a higher cap on resume is refused, naming the fix
      await assert.rejects(
        cct.generateUnsignedCreatePoolGroup({
          ...ref,
          poolGroupId: unsigned.poolGroupId,
          maxBpsFee: 2_000,
          payer: owner.publicKey.toBase58(),
        }),
        (e: unknown) => e instanceof CCTParamsInvalidError && e.context.param === 'maxBpsFee',
      )
    })

    it('signed: a create with more chains than one transaction holds adds them all', async () => {
      const chains = Array.from({ length: 24 }, (_, i) => BigInt(2_000 + i))
      const r = await cct.createPoolGroup({
        ...ref,
        initialChains: chains,
        wallet: new AnchorWallet(other),
      })
      assert.ok(r.transactions.length > 1)
      assert.equal(r.followUps, undefined)
      const g = await cct.getPoolGroup({ ...ref, poolGroupAddress: r.poolGroupAddress })
      assert.deepEqual(
        [...g.remoteChainSelectors].sort((a, b) => Number(a - b)),
        chains,
      )
    })

    it('the snapshot check refuses a proposal of another pool group', async () => {
      const unsigned = await cct.generateUnsignedSetPoolGroupRoles({
        ...ref,
        poolGroupAddress,
        roles: { unpauser: null },
        payer: next.publicKey.toBase58(),
      })
      const other = await cct.createPoolGroup({ ...ref, wallet: new AnchorWallet(next) })
      await assert.rejects(
        cct.checkPoolGroupSnapshot({
          ...ref,
          poolGroupAddress: other.poolGroupAddress,
          snapshot: unsigned.snapshot!,
          transaction: unsigned.transactions[0]!,
        }),
        (e: unknown) => e instanceof CCTParamsInvalidError && e.context.param === 'transactions',
      )
    })

    it('accept cancels a pending CCV set lanes synced: a warning and the sync follow-up', async (t) => {
      const connection = fork.connection!
      const lanes = await cct.getPoolGroupLanes({ ...ref, poolGroupAddress: LINKED_GROUP })
      const synced = lanes.filter((l) => l.classSource?.security.kind === 'default')
      if (!synced.length) return t.skip('no lane of the Devnet group takes SECURITY from the group')
      const group = await cct.getPoolGroup({ ...ref, poolGroupAddress: LINKED_GROUP })
      // the current owner (`next`, from the test above) makes itself security admin and schedules
      const current = Keypair.fromSecretKey(next.secretKey)
      assert.equal(group.owner, current.publicKey.toBase58())
      await cct.setPoolGroupRoles({
        ...ref,
        poolGroupAddress: LINKED_GROUP,
        roles: { securityAdmin: current.publicKey.toBase58() },
        wallet: new AnchorWallet(current),
      })
      const program = new PublicKey(PROGRAM)
      const groupKey = new PublicKey(LINKED_GROUP)
      const selector = synced[0]!.remoteChainSelector
      const client = createPoolGroupProgram(cct.chain, program, current.publicKey)
      const clock = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY)
      const now = clock!.data.readBigInt64LE(32)
      const events = { eventAuthority: deriveEventAuthorityPda(program), program }
      const schedule = await client.methods
        .scheduleGroupCcvs({
          remoteChainSelector: new BN(selector.toString()),
          policyId: null,
          outbound: [PublicKey.default, Keypair.generate().publicKey],
          inbound: [PublicKey.default],
          activatesAt: new BN((now + group.minCCVActivationDelay + 600n).toString()),
        })
        .accountsStrict({ group: groupKey, authority: current.publicKey, ...events })
        .remainingAccounts([
          {
            pubkey: poolGroupPdas.groupChain(program, groupKey, selector),
            isSigner: false,
            isWritable: true,
          },
        ])
        .instruction()
      const sameChain = synced.filter((l) => l.remoteChainSelector === selector)
      const laneMetas = []
      for (const l of sameChain) {
        const mint = new PublicKey(l.tokenAddress)
        const pool = await readPoolState('test', cct.chain, program, mint)
        laneMetas.push(
          { pubkey: pool.address, isSigner: false, isWritable: false },
          {
            pubkey: deriveTokenPoolChainConfigV2Pda(program, selector, mint),
            isSigner: false,
            isWritable: true,
          },
          { pubkey: pool.state.owner, isSigner: false, isWritable: false },
        )
      }
      const sync = await client.methods
        .syncGroupCcvs({ remoteChainSelector: new BN(selector.toString()) })
        .accountsStrict({
          group: groupKey,
          groupChainPolicy: poolGroupPdas.groupChain(program, groupKey, selector),
          payer: current.publicKey,
          systemProgram: SystemProgram.programId,
          ...events,
        })
        .remainingAccounts(laneMetas)
        .instruction()
      const { blockhash } = await connection.getLatestBlockhash()
      const tx = new VersionedTransaction(
        new TransactionMessage({
          payerKey: current.publicKey,
          recentBlockhash: blockhash,
          instructions: [schedule, sync],
        }).compileToV0Message(),
      )
      tx.sign([current])
      await connection.confirmTransaction(await connection.sendTransaction(tx))

      const successor = Keypair.generate()
      const sig = await connection.requestAirdrop(successor.publicKey, LAMPORTS_PER_SOL)
      await connection.confirmTransaction(sig)
      await cct.transferPoolGroupOwnership({
        ...ref,
        poolGroupAddress: LINKED_GROUP,
        proposedOwner: successor.publicKey.toBase58(),
        wallet: new AnchorWallet(current),
      })
      const accepted = await cct.acceptPoolGroupOwnership({
        ...ref,
        poolGroupAddress: LINKED_GROUP,
        wallet: new AnchorWallet(successor),
      })
      const warned = accepted.findings.filter((f) => f.check === 'CCVS_NOT_SYNCED')
      assert.deepEqual(
        warned.map((f) => f.tokenAddress).sort(),
        sameChain.map((l) => l.tokenAddress).sort(),
      )
      assert.ok(warned.every((f) => f.severity === 'warning'))
      const followUp = accepted.followUps?.find(
        (f) => f.operation === 'syncPoolGroupCCVs' && f.inputs?.remoteChainSelector === selector,
      )
      assert.ok(
        followUp,
        JSON.stringify(accepted.followUps, (_, v: unknown) =>
          typeof v === 'bigint' ? v.toString() : v,
        ),
      )
    })
  },
)
