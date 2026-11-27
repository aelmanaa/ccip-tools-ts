/**
 * Squads v4 propose/execute of pool-group writes (T1c), on a Surfpool fork of Solana Devnet: the
 * Squads v4 program and the pool-groups program of record (22P6h4…, fork 7558722) as deployed there.
 * Every write lands on the local fork only.
 *
 * A 2-of-3 multisig's vault creates pool groups through the packer (`budget.executor: 'squads-v4'`)
 * and the Squads export: one `vaultTransactionCreate` proposal, then a batch of several steps from
 * `toPoolGroupSquadsBatch`. The sizes of the Squads transactions are measured against the margins
 * the packer reserves.
 *
 * Run: `cd ccip-sdk && node --test src/cct/solana/pool-group/squads.fork.test.ts` (needs `surfpool`;
 * `VERBOSE=1` mirrors the fork's logs; `RPC_SOLANA_DEVNET` overrides the upstream).
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { BN } from '@coral-xyz/anchor'
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PACKET_DATA_SIZE,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js'

import '../../../index.ts'
import { rpcEndpoint } from '../../../../../scripts/test-endpoints.ts'
import { networkInfo } from '../../../networks.ts'
import {
  type SurfpoolInstance,
  isSurfpoolAvailable,
  startFork,
  stopFork,
} from '../../../solana/__tests__/surfpool.ts'
import { SolanaChain } from '../../../solana/index.ts'
import { CCTParamsInvalidError } from '../../errors.ts'
import { deriveEventAuthorityPda } from '../programs/token-pool.ts'
import { poolGroupPdas } from './accounts.ts'
import { GetPoolGroup } from './operations/index.ts'
import {
  SOLANA_MAX_ACCOUNT_LOCKS,
  SQUADS_EXECUTE_LOCKS,
  SQUADS_OUTER_BYTES,
  measureTransaction,
  packPoolGroupTransactions,
  squadsMessageBytes,
} from './packer.ts'
import { createPoolGroupProgram } from './program.ts'
import { SquadsHarness, squadsTransactionMessage } from './squads.test.helpers.ts'
import { toPoolGroupSquadsBatch, toPoolGroupSquadsTransaction } from './squads.ts'

const PROGRAM = new PublicKey('22P6h4QV5wswBX63KCncFGctC9dyVRMjykBBDdhwXjg7')
const PORT = 18_921

describe(
  'Squads v4 execution of pool-group writes (Devnet fork)',
  { skip: !isSurfpoolAvailable(), timeout: 600_000 },
  () => {
    const fork: { surfpool?: SurfpoolInstance; connection?: SolanaChain['connection'] } = {}
    let chain: SolanaChain
    let squads: SquadsHarness
    const [creator, m1, m2, m3] = [
      Keypair.generate(),
      Keypair.generate(),
      Keypair.generate(),
      Keypair.generate(),
    ]

    before(async () => {
      const started = await startFork({ upstreamUrl: rpcEndpoint('RPC_SOLANA_DEVNET'), port: PORT })
      Object.assign(fork, started)
      chain = new SolanaChain(started.connection, networkInfo('solana-devnet'), { apiClient: null })
      for (const key of [creator, m1, m2, m3]) {
        const sig = await started.connection.requestAirdrop(key.publicKey, 10 * LAMPORTS_PER_SOL)
        await started.connection.confirmTransaction(sig)
      }
      squads = new SquadsHarness(started.connection)
      await squads.create(
        creator,
        Keypair.generate(),
        [m1.publicKey, m2.publicKey, m3.publicKey],
        2,
      )
      // the vault pays inner rent
      const fund = SystemProgram.transfer({
        fromPubkey: creator.publicKey,
        toPubkey: squads.vault,
        lamports: 2 * LAMPORTS_PER_SOL,
      })
      await squads.send('fundVault', [creator], [fund])
    })
    after(() => stopFork(fork))

    /** A `create_group` the vault signs and pays for, owned by the vault. */
    async function createGroupItem() {
      const groupId = Keypair.generate().publicKey
      const group = poolGroupPdas.group(PROGRAM, groupId)
      const ix = await createPoolGroupProgram(chain, PROGRAM)
        .methods.createGroup({
          groupId,
          maxBpsFee: null,
          openMembership: false,
          minCcvActivationDelay: new BN(0),
        })
        .accountsStrict({
          group,
          authority: squads.vault,
          systemProgram: SystemProgram.programId,
          eventAuthority: deriveEventAuthorityPda(PROGRAM),
          program: PROGRAM,
        })
        .instruction()
      return { group, item: { tokenAddresses: [], instructions: [ix], createdPdas: [group] } }
    }

    const ownerOf = async (group: PublicKey) =>
      (
        await new GetPoolGroup().query(chain, {
          poolProgramAddress: PROGRAM.toBase58(),
          poolGroupAddress: group.toBase58(),
        })
      ).owner

    it('one vault transaction: pack for Squads, propose, approve 2 of 3, execute', async () => {
      const { group, item } = await createGroupItem()
      const { transactions } = await packPoolGroupTransactions({
        operation: 'test',
        chain,
        payer: squads.vault,
        items: [item],
        budget: { executor: 'squads-v4' },
      })
      assert.equal(transactions.length, 1)
      const tx = toPoolGroupSquadsTransaction(transactions[0]!, squads.vault.toBase58())
      const index = await squads.propose(m1, tx)
      await squads.approve(index, m1, m2)
      await squads.execute(m3, index, tx)
      assert.equal(await ownerOf(group), squads.vault.toBase58())

      // the margins the packer reserves hold for the measured Squads transactions
      const inner = measureTransaction(squads.vault, tx.instructions, tx.lookupTables)
      const create = squads.sizes.get('vaultTransactionCreate')!
      const execute = squads.sizes.get('vaultTransactionExecute')!
      const message = squadsTransactionMessage(squads.vault, tx.instructions, tx.lookupTables).bytes
      console.log('squads margins', { inner, messageBytes: message.length, create, execute })
      assert.ok(
        create.bytes - squadsMessage(tx) <= SQUADS_OUTER_BYTES,
        `create adds ${create.bytes - squadsMessage(tx)} B`,
      )
      assert.ok(
        execute.locks - inner.locks <= SQUADS_EXECUTE_LOCKS,
        `execute adds ${execute.locks - inner.locks} locks`,
      )
      assert.ok(create.bytes <= PACKET_DATA_SIZE && execute.locks <= SOLANA_MAX_ACCOUNT_LOCKS)
    })

    it('a batch of ready steps: toPoolGroupSquadsBatch, one approval round, every step executed', async () => {
      const steps = []
      const groups: PublicKey[] = []
      for (let i = 0; i < 3; i++) {
        const { group, item } = await createGroupItem()
        groups.push(group)
        const { transactions } = await packPoolGroupTransactions({
          operation: 'test',
          chain,
          payer: squads.vault,
          items: [item],
          budget: { executor: 'squads-v4' },
        })
        steps.push({ id: `group-${i}`, transactions })
      }
      const { batches, otherActorSteps } = toPoolGroupSquadsBatch({
        ready: steps,
        vault: squads.vault.toBase58(),
      })
      assert.equal(batches.length, 1)
      assert.deepEqual(otherActorSteps, [])
      const batch = batches[0]!
      const index = await squads.proposeBatch(m1, batch.transactions)
      await squads.approve(index, m2, m3)
      await squads.executeBatch(m1, index, batch.transactions)
      for (const group of groups) assert.equal(await ownerOf(group), squads.vault.toBase58())
      const add = squads.sizes.get('batchAddTransaction')!
      const execute = squads.sizes.get('batchExecuteTransaction')!
      console.log('squads batch margins', { add, execute })
      assert.ok(add.bytes <= PACKET_DATA_SIZE && execute.locks <= SOLANA_MAX_ACCOUNT_LOCKS)
    })

    /** The Squads message of a vault transaction, checked against the packer's computed length. */
    function squadsMessage(tx: ReturnType<typeof toPoolGroupSquadsTransaction>) {
      const { bytes, message } = squadsTransactionMessage(
        squads.vault,
        tx.instructions,
        tx.lookupTables,
      )
      assert.equal(squadsMessageBytes(message), bytes.length)
      return bytes.length
    }

    /** The largest item the packer accepts for Squads (a create_group plus a memo), and one byte more. */
    async function packedMaximum() {
      const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
      const memo = (n: number) =>
        new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.alloc(n, 0x61) })
      const { group, item } = await createGroupItem()
      const packWith = (n: number) =>
        packPoolGroupTransactions({
          operation: 'test',
          chain,
          payer: squads.vault,
          items: [{ ...item, instructions: [...item.instructions, memo(n)] }],
          budget: { executor: 'squads-v4' },
        })
      let [lo, hi] = [0, 1_000]
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2)
        const fits = await packWith(mid).then(
          () => true,
          (err: unknown) => {
            if (err instanceof CCTParamsInvalidError) return false
            throw err
          },
        )
        if (fits) lo = mid
        else hi = mid - 1
      }
      return { group, packWith, lo }
    }

    it('the worst proposer transaction at the computed maximum: limit, price and a separate rent payer', async () => {
      const rentPayer = Keypair.generate()
      const sig = await fork.connection!.requestAirdrop(rentPayer.publicKey, 10 * LAMPORTS_PER_SOL)
      await fork.connection!.confirmTransaction(sig)
      const worst = { computeUnitPrice: 10_000, rentPayer }
      // one vault transaction
      {
        const { group, packWith, lo } = await packedMaximum()
        const tx = toPoolGroupSquadsTransaction(
          (await packWith(lo)).transactions[0]!,
          squads.vault.toBase58(),
        )
        const inner = measureTransaction(squads.vault, tx.instructions, tx.lookupTables)
        const index = await squads.propose(m1, tx, worst).catch((err: unknown) => {
          console.log('worst create', { inner, create: squads.sizes.get('vaultTransactionCreate') })
          throw err
        })
        const create = squads.sizes.get('vaultTransactionCreate')!
        const message = squadsMessage(tx)
        console.log('worst create', { inner, message, create, outer: create.bytes - message })
        assert.ok(create.bytes <= PACKET_DATA_SIZE, `create ${create.bytes} B`)
        assert.ok(create.bytes - message <= SQUADS_OUTER_BYTES)
        await squads.approve(index, m1, m2)
        await squads.execute(m3, index, tx)
        assert.equal(await ownerOf(group), squads.vault.toBase58())
      }
      // one batch transaction
      {
        const { group, packWith, lo } = await packedMaximum()
        const tx = toPoolGroupSquadsTransaction(
          (await packWith(lo)).transactions[0]!,
          squads.vault.toBase58(),
        )
        const inner = measureTransaction(squads.vault, tx.instructions, tx.lookupTables)
        const index = await squads.proposeBatch(m1, [tx], worst).catch((err: unknown) => {
          console.log('worst batch add', { inner, add: squads.sizes.get('batchAddTransaction') })
          throw err
        })
        const add = squads.sizes.get('batchAddTransaction')!
        const message = squadsMessage(tx)
        console.log('worst batch add', { inner, message, add, outer: add.bytes - message })
        // the packer's maximum fills the worst batch add exactly
        assert.equal(add.bytes, PACKET_DATA_SIZE)
        assert.equal(add.bytes - message, SQUADS_OUTER_BYTES)
        await squads.approve(index, m2, m3)
        await squads.executeBatch(m1, index, [tx])
        assert.equal(await ownerOf(group), squads.vault.toBase58())
      }
    })

    it('the computed maximum proposes and executes; one byte more is refused by the packer', async () => {
      const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')
      const memo = (n: number) =>
        new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.alloc(n, 0x61) })
      const { group, item } = await createGroupItem()
      const packWith = (n: number) =>
        packPoolGroupTransactions({
          operation: 'test',
          chain,
          payer: squads.vault,
          items: [{ ...item, instructions: [...item.instructions, memo(n)] }],
          budget: { executor: 'squads-v4' },
        })
      // the largest memo the packer accepts: the inner message at the Squads byte limit
      let [lo, hi] = [0, 1_000]
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2)
        const fits = await packWith(mid).then(
          () => true,
          (err: unknown) => {
            if (err instanceof CCTParamsInvalidError) return false
            throw err
          },
        )
        if (fits) lo = mid
        else hi = mid - 1
      }
      await assert.rejects(packWith(lo + 1), CCTParamsInvalidError)
      const { transactions } = await packWith(lo)
      const tx = toPoolGroupSquadsTransaction(transactions[0]!, squads.vault.toBase58())
      const inner = measureTransaction(squads.vault, tx.instructions, tx.lookupTables)
      assert.equal(squadsMessage(tx) + SQUADS_OUTER_BYTES, PACKET_DATA_SIZE)
      const index = await squads.propose(m1, tx)
      await squads.approve(index, m1, m2)
      await squads.execute(m3, index, tx)
      assert.equal(await ownerOf(group), squads.vault.toBase58())
      console.log('squads at the maximum', {
        inner,
        create: squads.sizes.get('vaultTransactionCreate'),
        execute: squads.sizes.get('vaultTransactionExecute'),
      })
    })
  },
)
