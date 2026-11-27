/**
 * Pool-group chain records, the default, named policies and lane assignments (S3b) on a Surfpool
 * fork of Solana Devnet, against the pool-groups program of record (22P6h4…, fork 7558722) as
 * deployed there. Every write lands on the local fork.
 *
 * A fresh group goes through chain records, default and chain-record sections (merge, detach,
 * re-attach, the fee cap), and a named policy's whole lifecycle. The Devnet group BDiS… (linked
 * lanes) is handed to a test key on the fork (its owner, and its lanes' pool owners, rewritten via
 * `surfnet_setAccount`), so the lane guard runs on real lanes: a CONNECTION drop with and without
 * `confirmDropped` (sealed and re-checked), a RATE_LIMIT clamp, a bucket reset and an assignment.
 *
 * Run: `cd ccip-sdk && node --test src/cct/solana/pool-group/chains-policies.fork.test.ts` (needs
 * `surfpool`; `RPC_SOLANA_DEVNET` overrides the upstream).
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { Wallet as AnchorWallet } from '@coral-xyz/anchor'
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'

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
import { CCTParamsInvalidError } from '../../errors.ts'
import { SolanaTokenManager } from '../index.ts'
import { deriveTokenPoolConfigPda } from '../programs/token-pool.ts'
import type { PoolGroupSectionUpdate } from './write-types.ts'

const PROGRAM = '22P6h4QV5wswBX63KCncFGctC9dyVRMjykBBDdhwXjg7'
const LINKED_GROUP = 'BDiSFAren1qkqK5BjT3JpFNbbTbawoC6YxVghrAwDGbt'
const SEPOLIA = networkInfo('ethereum-testnet-sepolia').chainSelector
const FUJI = networkInfo('avalanche-testnet-fuji').chainSelector
const THIRD = networkInfo('ethereum-testnet-sepolia-arbitrum-1').chainSelector
const PORT = 18_951
/** `Group.owner`: after the discriminator, version, bump and group id. */
const GROUP_OWNER_OFFSET = 8 + 1 + 1 + 32
/** `State.config.owner`: discriminator, version, token program, mint, decimals, signer, token account. */
const STATE_OWNER_OFFSET = 8 + 1 + 32 + 32 + 1 + 32 + 32

const isParam = (param: string) => (e: unknown) =>
  e instanceof CCTParamsInvalidError && e.context.param === param

describe(
  'pool-group chain records and policies (Devnet fork)',
  { skip: !isSurfpoolAvailable(), timeout: 900_000 },
  () => {
    const fork: { surfpool?: SurfpoolInstance; connection?: SolanaChain['connection'] } = {}
    let cct: SolanaTokenManager
    const [owner, other] = [Keypair.generate(), Keypair.generate()]
    const wallet = () => new AnchorWallet(owner)
    const ref = { poolProgramAddress: PROGRAM }
    let poolGroupAddress: string

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
      const chain = new SolanaChain(started.connection, networkInfo('solana-devnet'), {
        apiClient: null,
      })
      cct = SolanaTokenManager.fromChain(chain)
      for (const key of [owner, other]) {
        const sig = await started.connection.requestAirdrop(key.publicKey, 10 * LAMPORTS_PER_SOL)
        await started.connection.confirmTransaction(sig)
      }
      const r = await cct.createPoolGroup({
        ...ref,
        initialChains: [SEPOLIA, FUJI],
        wallet: wallet(),
      })
      poolGroupAddress = r.poolGroupAddress
    })
    after(() => stopFork(fork))

    it('adds and removes a chain record; a duplicate and a non-manager are refused', async () => {
      const g = { ...ref, poolGroupAddress }
      await assert.rejects(
        cct.addPoolGroupChain({ ...g, remoteChainSelector: SEPOLIA, wallet: wallet() }),
        isParam('remoteChainSelector'),
      )
      await assert.rejects(
        cct.addPoolGroupChain({
          ...g,
          remoteChainSelector: THIRD,
          wallet: new AnchorWallet(other),
        }),
        isParam('authority'),
      )
      const added = await cct.addPoolGroupChain({
        ...g,
        remoteChainSelector: THIRD,
        wallet: wallet(),
      })
      assert.deepEqual(added.affectedLanes, [])
      assert.ok((await cct.getPoolGroup(g)).remoteChainSelectors.includes(THIRD))
      await cct.removePoolGroupChain({ ...g, remoteChainSelector: THIRD, wallet: wallet() })
      assert.ok(!(await cct.getPoolGroup(g)).remoteChainSelectors.includes(THIRD))
    })

    it('the default: a merged FEE write reaches every chain record that follows it', async () => {
      const g = { ...ref, poolGroupAddress }
      await cct.setPoolGroupDefault({
        ...g,
        section: {
          policyClass: 'fee',
          tokenTransferFeeConfig: {
            isEnabled: true,
            destBytesOverhead: 64,
            finalityTransferFeeBps: 10,
          },
        },
        wallet: wallet(),
      })
      // merged: the next write keeps the earlier fields
      await cct.setPoolGroupDefault({
        ...g,
        section: { policyClass: 'fee', tokenTransferFeeConfig: { fastFinalityTransferFeeBps: 15 } },
        wallet: wallet(),
      })
      const chainRecord = await cct.getPoolGroupChain({ ...g, remoteChainSelector: SEPOLIA })
      const fee = chainRecord.policy.fee.tokenTransferFeeConfig
      assert.equal(fee.finalityTransferFeeBps, 10)
      assert.equal(fee.fastFinalityTransferFeeBps, 15)
      assert.equal(fee.destBytesOverhead, 64)
      // the cap is 1,000 bps
      await assert.rejects(
        cct.generateUnsignedSetPoolGroupDefault({
          ...g,
          section: {
            policyClass: 'fee',
            tokenTransferFeeConfig: { finalityTransferFeeBps: 1_001 },
          },
          payer: owner.publicKey.toBase58(),
        }),
        isParam('section.tokenTransferFeeConfig'),
      )
    })

    it('a chain record: detaching is explicit; re-attaching copies the default', async () => {
      const g = { ...ref, poolGroupAddress, remoteChainSelector: FUJI }
      const outbound = { enabled: true, capacity: 1_000n, rate: 10n }
      const section = { policyClass: 'rateLimit', rateLimit: { outbound } } as const
      await assert.rejects(
        cct.setPoolGroupChainPolicy({ ...g, section, wallet: wallet() }),
        isParam('detachFromPoolGroupDefault'),
      )
      await cct.setPoolGroupChainPolicy({
        ...g,
        section,
        detachFromPoolGroupDefault: true,
        wallet: wallet(),
      })
      let record = await cct.getPoolGroupChain(g)
      assert.ok(!record.inheritsDefault.includes('rateLimit'))
      assert.deepEqual(record.policy.rateLimit.outbound, outbound)
      // the snapshot check of a section write holds while nothing moved
      const unsigned = await cct.generateUnsignedSetPoolGroupChainPolicy({
        ...g,
        section: { policyClass: 'rateLimit', rateLimit: { inbound: outbound } },
        payer: owner.publicKey.toBase58(),
      })
      const check = await cct.checkPoolGroupSnapshot({
        ...ref,
        poolGroupAddress,
        snapshot: unsigned.snapshot!,
        transaction: unsigned.transactions[0]!,
      })
      assert.equal(check.ok, true, JSON.stringify(check.changed))
      await cct.inheritPoolGroupDefault({ ...g, policyClass: 'rateLimit', wallet: wallet() })
      record = await cct.getPoolGroupChain(g)
      assert.ok(record.inheritsDefault.includes('rateLimit'))
      await assert.rejects(
        cct.inheritPoolGroupDefault({ ...g, policyClass: 'security', wallet: wallet() }),
        isParam('policyClass'),
      )
    })

    it('a named policy: create, record, default, edit (detach explicit), close', async () => {
      const g = { ...ref, poolGroupAddress }
      const created = await cct.createPoolGroupPolicy({ ...g, classes: ['fee'], wallet: wallet() })
      const { policyId } = created
      assert.equal(policyId, 0)
      await cct.initPoolGroupPolicyChainRecord({
        ...g,
        policyId,
        remoteChainSelector: SEPOLIA,
        wallet: wallet(),
      })
      await cct.setPoolGroupPolicyDefault({
        ...g,
        policyId,
        section: {
          policyClass: 'fee',
          tokenTransferFeeConfig: {
            isEnabled: true,
            destBytesOverhead: 64,
            finalityTransferFeeBps: 25,
          },
        },
        wallet: wallet(),
      })
      const section = {
        policyClass: 'fee',
        tokenTransferFeeConfig: { finalityTransferFeeBps: 30 },
      } as const
      await assert.rejects(
        cct.editPoolGroupPolicyChainRecord({
          ...g,
          policyId,
          remoteChainSelector: SEPOLIA,
          section,
          wallet: wallet(),
        }),
        isParam('detachFromPolicyDefault'),
      )
      await cct.editPoolGroupPolicyChainRecord({
        ...g,
        policyId,
        remoteChainSelector: SEPOLIA,
        section,
        detachFromPolicyDefault: true,
        wallet: wallet(),
      })
      const record = await cct.getPoolGroupPolicyChainRecord({
        ...g,
        policyId,
        remoteChainSelector: SEPOLIA,
      })
      assert.equal(record.sections.fee.tokenTransferFeeConfig.finalityTransferFeeBps, 30)
      assert.equal(record.sections.fee.tokenTransferFeeConfig.destBytesOverhead, 64)
      // a class the policy does not carry is refused before simulation
      await assert.rejects(
        cct.generateUnsignedSetPoolGroupPolicyDefault({
          ...g,
          policyId,
          section: { policyClass: 'rateLimit', rateLimit: { outbound: { enabled: false } } },
          payer: owner.publicKey.toBase58(),
        }),
        isParam('section.policyClass'),
      )
      await assert.rejects(
        cct.closePoolGroupPolicy({ ...g, policyId, wallet: wallet() }),
        isParam('policyId'),
      )
      await cct.closePoolGroupPolicyChainRecord({
        ...g,
        policyId,
        remoteChainSelector: SEPOLIA,
        wallet: wallet(),
      })
      await cct.closePoolGroupPolicy({ ...g, policyId, wallet: wallet() })
      // the id is never reused
      const next = await cct.generateUnsignedCreatePoolGroupPolicy({
        ...g,
        classes: ['rateLimit'],
        payer: owner.publicKey.toBase58(),
      })
      assert.equal(next.policyId, 1)
    })

    describe('a group with linked lanes (BDiS, handed to a test key)', () => {
      const g = { ...ref, poolGroupAddress: LINKED_GROUP }
      let lanes: Awaited<ReturnType<SolanaTokenManager['getPoolGroupLanes']>>

      before(async () => {
        await rewrite(LINKED_GROUP, GROUP_OWNER_OFFSET, owner.publicKey)
        lanes = await cct.getPoolGroupLanes(g)
        assert.ok(lanes.length >= 1)
        // the owner signs every role (accept clears roles; set them all to the test key)
        await cct.setPoolGroupRoles({
          ...g,
          roles: {
            policyAdmin: owner.publicKey.toBase58(),
            connectionAdmin: owner.publicKey.toBase58(),
            feeAdmin: owner.publicKey.toBase58(),
            rateLimitAdmin: owner.publicKey.toBase58(),
          },
          wallet: wallet(),
        })
      })

      it('a RATE_LIMIT clamp on the lanes builds; their lanes are reported', async () => {
        const lane = lanes[0]!
        const record = await cct.getPoolGroupChain({
          ...g,
          remoteChainSelector: lane.remoteChainSelector,
        })
        const detach = record.inheritsDefault.includes('rateLimit')
        const r = await cct.generateUnsignedSetPoolGroupChainPolicy({
          ...g,
          remoteChainSelector: lane.remoteChainSelector,
          section: {
            policyClass: 'rateLimit',
            rateLimit: { outbound: { enabled: true, capacity: 1n, rate: 1n } },
          },
          ...(detach && { detachFromPoolGroupDefault: true }),
          payer: owner.publicKey.toBase58(),
        })
        assert.equal(r.transactions.length, 1)
        assert.deepEqual(r.goingLive, [])
      })

      it('a CONNECTION drop of trusted pools is refused, then built with confirmDropped (sealed, re-checked)', async (t) => {
        const lane = lanes.find((l) => l.classSource?.connection.kind === 'default')
        if (!lane) return t.skip('no lane takes CONNECTION from the group')
        const chainRecord = await cct.getPoolGroupChain({
          ...g,
          remoteChainSelector: lane.remoteChainSelector,
        })
        // a pool only the record trusts: add one, then drop it
        const detach = chainRecord.inheritsDefault.includes('connection')
        const kept = chainRecord.policy.connection.remotePools
        const extra = `0x${Buffer.from(Keypair.generate().publicKey.toBytes().subarray(0, 20)).toString('hex')}`
        await cct.setPoolGroupChainPolicy({
          ...g,
          remoteChainSelector: lane.remoteChainSelector,
          section: {
            policyClass: 'connection',
            connection: { remotePools: [...kept, { address: extra, allowLegacyPoolData: false }] },
          },
          ...(detach && { detachFromPoolGroupDefault: true }),
          wallet: wallet(),
        })
        const drop: PoolGroupSectionUpdate = {
          policyClass: 'connection',
          connection: { remotePools: [] },
        }
        const params = {
          ...g,
          remoteChainSelector: lane.remoteChainSelector,
          section: drop,
          payer: owner.publicKey.toBase58(),
        }
        let dropped: unknown
        await assert.rejects(cct.generateUnsignedSetPoolGroupChainPolicy(params), (e: unknown) => {
          assert.ok(e instanceof CCTParamsInvalidError)
          assert.equal(e.context.param, 'confirmDropped')
          dropped = e.context.dropped
          return true
        })
        const confirmDropped = (
          dropped as {
            lane: { tokenAddress: string; remoteChainSelector: bigint }
            remotePools: string[]
          }[]
        ).map(({ lane, remotePools }) => ({ lane, remotePools }))
        const built = await cct.generateUnsignedSetPoolGroupChainPolicy({
          ...params,
          confirmDropped,
        })
        assert.ok(built.affectedLanes.length >= 1)
        const check = await cct.checkPoolGroupSnapshot({
          ...ref,
          poolGroupAddress: LINKED_GROUP,
          snapshot: built.snapshot!,
          transaction: built.transactions[0]!,
        })
        assert.equal(check.ok, true, JSON.stringify(check))
      })

      it('assigns and resets lanes the test key owns; another key is refused', async (t) => {
        const lane = lanes[0]!
        const mint = new PublicKey(lane.tokenAddress)
        const state = deriveTokenPoolConfigPda(new PublicKey(PROGRAM), mint)
        await assert.rejects(
          cct.generateUnsignedAssignPoolGroupLanePolicies({
            ...g,
            remoteChainSelector: lane.remoteChainSelector,
            tokenAddresses: [lane.tokenAddress],
            classSource: {
              connection: { kind: 'default' },
              fee: { kind: 'default' },
              rateLimit: { kind: 'default' },
              security: { kind: 'inline' },
            },
            payer: owner.publicKey.toBase58(),
          }),
          isParam('authority'),
        )
        await rewrite(state.toBase58(), STATE_OWNER_OFFSET, owner.publicKey)
        const current = lane.classSource!
        const keep = (k: 'connection' | 'fee' | 'rateLimit' | 'security') =>
          current[k].kind === 'policy'
            ? { kind: 'policy' as const, policyId: current[k].policyId }
            : { kind: current[k].kind }
        // the same sources again: a no-op assignment that still runs every check
        const assigned = await cct.generateUnsignedAssignPoolGroupLanePolicies({
          ...g,
          remoteChainSelector: lane.remoteChainSelector,
          tokenAddresses: [lane.tokenAddress],
          classSource: {
            connection: keep('connection'),
            fee: keep('fee'),
            rateLimit: keep('rateLimit'),
            security: keep('security'),
          },
          payer: owner.publicKey.toBase58(),
        })
        assert.equal(assigned.transactions.length, 1)
        assert.equal(assigned.poolGroupTrust?.owner, owner.publicKey.toBase58())
        const check = await cct.checkPoolGroupSnapshot({
          ...ref,
          poolGroupAddress: LINKED_GROUP,
          snapshot: assigned.snapshot!,
          transaction: assigned.transactions[0]!,
        })
        assert.equal(check.ok, true, JSON.stringify(check))
        if (current.rateLimit.kind !== 'default')
          return t.skip('the lane does not take RATE_LIMIT from the group default')
        const reset = await cct.resetPoolGroupLaneBuckets({
          ...g,
          remoteChainSelector: lane.remoteChainSelector,
          tokenAddresses: [lane.tokenAddress],
          wallet: wallet(),
        })
        assert.equal(reset.transactions.length, 1)
      })
    })
  },
)
