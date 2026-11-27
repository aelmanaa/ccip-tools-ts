/**
 * Pool-group pauses, SECURITY, hooks and `freezeLookupTable` (S4) on a Surfpool fork of Solana
 * Devnet, against the pool-groups program of record (22P6h4…, fork 7558722) as deployed there.
 * Every write lands on the local fork.
 *
 * A fresh group goes through the pause and CCV ops (gates, merges, F2, the notice, the inheritance
 * rule), the hook lists (create, entries, admin hand-over, hook config) and the engine refusals; an
 * empty, then extended, lookup table is frozen. The Devnet group BDiS… (linked lanes, handed to a
 * test key on the fork) runs the make-live check: a chain or lane pause lands unjudged; lifting it
 * is refused without `getChain`, and with it lands only when the lane check passes (else it is
 * refused with the errors `checkMultiTokenPoolLane` reports on the lane).
 *
 * Run: `cd ccip-sdk && node --test src/cct/solana/pool-group/pauses-security-hooks.fork.test.ts`
 * (needs `surfpool`; `RPC_SOLANA_DEVNET` and `RPC_SEPOLIA` override).
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { Wallet as AnchorWallet } from '@coral-xyz/anchor'
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from '@solana/web3.js'

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

const PROGRAM = '22P6h4QV5wswBX63KCncFGctC9dyVRMjykBBDdhwXjg7'
const LINKED_GROUP = 'BDiSFAren1qkqK5BjT3JpFNbbTbawoC6YxVghrAwDGbt'
const SEPOLIA = networkInfo('ethereum-testnet-sepolia').chainSelector
const FUJI = networkInfo('avalanche-testnet-fuji').chainSelector
const PORT = 18_961
/** `Group.owner`: after the discriminator, version, bump and group id. */
const GROUP_OWNER_OFFSET = 8 + 1 + 1 + 32
/** `State.config.owner`: discriminator, version, token program, mint, decimals, signer, token account. */
const STATE_OWNER_OFFSET = 8 + 1 + 32 + 32 + 1 + 32 + 32

const isParam = (param: string) => (e: unknown) =>
  e instanceof CCTParamsInvalidError && e.context.param === param

describe(
  'pool-group pauses, SECURITY, hooks and lookup tables (Devnet fork)',
  { skip: !isSurfpoolAvailable(), timeout: 900_000 },
  () => {
    const fork: { surfpool?: SurfpoolInstance; connection?: SolanaChain['connection'] } = {}
    let cct: SolanaTokenManager
    let getChain: ChainGetter
    const [owner, other] = [Keypair.generate(), Keypair.generate()]
    const wallet = (k = owner) => new AnchorWallet(k)
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
      const sepolia = await EVMChain.fromUrl(await reachableRpcEndpoint('RPC_SEPOLIA'))
      getChain = async (selector) => {
        if (selector === SEPOLIA) return sepolia
        throw new CCTParamsInvalidError('test', 'getChain', `no RPC for ${selector}`)
      }
      for (const key of [owner, other]) {
        const sig = await started.connection.requestAirdrop(key.publicKey, 10 * LAMPORTS_PER_SOL)
        await started.connection.confirmTransaction(sig)
      }
      const r = await cct.createPoolGroup({
        ...ref,
        initialChains: [SEPOLIA, FUJI],
        minCCVActivationDelay: 60,
        wallet: wallet(),
      })
      poolGroupAddress = r.poolGroupAddress
    })
    after(() => stopFork(fork))

    it('the group pause: set, a repeat builds nothing, a key without the role is refused, lifted', async () => {
      const g = { ...ref, poolGroupAddress }
      await cct.setPoolGroupPause({ ...g, paused: true, wallet: wallet() })
      assert.equal((await cct.getPoolGroup(g)).paused, true)
      const again = await cct.generateUnsignedSetPoolGroupPause({
        ...g,
        paused: true,
        payer: owner.publicKey.toBase58(),
      })
      assert.deepEqual(again.transactions, [])
      await assert.rejects(
        cct.generateUnsignedSetPoolGroupPause({
          ...g,
          paused: false,
          payer: other.publicKey.toBase58(),
        }),
        isParam('authority'),
      )
      // no lane is linked: nothing goes live, so nothing is checked
      const lifted = await cct.setPoolGroupPause({ ...g, paused: false, wallet: wallet() })
      assert.deepEqual(lifted.goingLive, [])
      assert.equal((await cct.getPoolGroup(g)).paused, false)
    })

    it('a chain pause: an omitted direction keeps its flag', async () => {
      const g = { ...ref, poolGroupAddress, remoteChainSelector: SEPOLIA }
      await cct.setPoolGroupChainPause({ ...g, pausedInbound: true, wallet: wallet() })
      await cct.setPoolGroupChainPause({ ...g, pausedOutbound: true, wallet: wallet() })
      const record = await cct.getPoolGroupChain(g)
      assert.equal(record.pausedOutbound, true)
      assert.equal(record.pausedInbound, true)
      await cct.setPoolGroupChainPause({
        ...g,
        pausedOutbound: false,
        pausedInbound: false,
        wallet: wallet(),
      })
      await assert.rejects(
        cct.generateUnsignedSetPoolGroupChainPause({ ...g, payer: owner.publicKey.toBase58() }),
        isParam('pausedOutbound'),
      )
    })

    it('CCVs: F2, the notice, a schedule detaches the record, then dropping is allowed', async () => {
      const g = { ...ref, poolGroupAddress, remoteChainSelector: SEPOLIA }
      const ccv = Keypair.generate().publicKey.toBase58()
      const payer = owner.publicKey.toBase58()
      await assert.rejects(
        cct.generateUnsignedSchedulePoolGroupCCVs({ ...g, outbound: [ccv], inbound: [], payer }),
        isParam('outbound'),
      )
      await assert.rejects(
        cct.generateUnsignedSchedulePoolGroupCCVs({
          ...g,
          outbound: ['default', ccv],
          inbound: [],
          activatesAt: 1n,
          payer,
        }),
        isParam('activatesAt'),
      )
      // the record still follows the default for SECURITY: its settings are refused
      await assert.rejects(
        cct.generateUnsignedSetPoolGroupAllowDroppingDefaultCCVs({ ...g, allow: true, payer }),
        isParam('remoteChainSelector'),
      )
      const scheduled = await cct.schedulePoolGroupCCVs({
        ...g,
        outbound: ['default', ccv],
        inbound: [],
        wallet: wallet(),
      })
      assert.ok(scheduled.activatesAt > BigInt(Math.floor(Date.now() / 1000)))
      const record = await cct.getPoolGroupChain(g)
      assert.ok(!record.inheritsDefault.includes('security'))
      await cct.setPoolGroupAllowDroppingDefaultCCVs({ ...g, allow: true, wallet: wallet() })
      assert.equal((await cct.getPoolGroupChain(g)).policy.security.allowDroppingDefaultCCVs, true)
      // the emergency path on the group default, owner only
      await assert.rejects(
        cct.generateUnsignedActivatePoolGroupCCVsNow({
          ...ref,
          poolGroupAddress,
          outbound: ['default'],
          inbound: [],
          payer: other.publicKey.toBase58(),
        }),
        isParam('authority'),
      )
      await cct.activatePoolGroupCCVsNow({
        ...ref,
        poolGroupAddress,
        outbound: ['default'],
        inbound: ['default'],
        wallet: wallet(),
      })
      // no lane: nothing to sync
      const sync = await cct.generateUnsignedSyncPoolGroupCCVs({ ...g, payer })
      assert.deepEqual(sync.transactions, [])
    })

    it('a named SECURITY policy is reset by the owner', async () => {
      const g = { ...ref, poolGroupAddress }
      const { policyId } = await cct.createPoolGroupPolicy({
        ...g,
        classes: ['security'],
        wallet: wallet(),
      })
      await cct.initPoolGroupPolicyChainRecord({
        ...g,
        policyId,
        remoteChainSelector: SEPOLIA,
        wallet: wallet(),
      })
      const r = await cct.resetPoolGroupPolicySecurity({ ...g, policyId, wallet: wallet() })
      assert.equal(r.transactions.length, 1)
    })

    it('hook lists: create, entries (repeats dropped), hook config, admin hand-over; engine refusals', async () => {
      const g = { ...ref, poolGroupAddress }
      const payer = owner.publicKey.toBase58()
      const { listAddress: allowlist } = await cct.createPoolGroupAllowlist({
        ...g,
        enabled: true,
        admin: payer,
        wallet: wallet(),
      })
      await cct.applyPoolGroupListUpdates({
        ...ref,
        list: allowlist,
        add: [other.publicKey.toBase58(), payer],
        wallet: wallet(),
      })
      const repeat = await cct.generateUnsignedApplyPoolGroupListUpdates({
        ...ref,
        list: allowlist,
        add: [other.publicKey.toBase58()],
        remove: [Keypair.generate().publicKey.toBase58()],
        payer,
      })
      assert.deepEqual(repeat.transactions, [])
      await assert.rejects(
        cct.generateUnsignedApplyPoolGroupListUpdates({
          ...ref,
          list: allowlist,
          add: ['0x1111111111111111111111111111111111111111'],
          payer,
        }),
        isParam('add[0]'),
      )
      const { listAddress: blocklist } = await cct.createPoolGroupBlocklist({
        ...ref,
        admin: payer,
        wallet: wallet(),
      })
      await cct.applyPoolGroupListUpdates({
        ...ref,
        list: blocklist,
        add: ['0x2222222222222222222222222222222222222222'],
        wallet: wallet(),
      })
      await cct.setPoolGroupHookConfig({ ...g, allowlist, blocklist, wallet: wallet() })
      const hooks = await cct.getPoolGroupHooks({ ...ref, record: poolGroupAddress })
      assert.ok(hooks.hook)
      assert.equal(hooks.hook.allowlist, allowlist)
      assert.equal(hooks.hook.blocklist, blocklist)
      await cct.transferPoolGroupListAdmin({
        ...ref,
        list: allowlist,
        proposedAdmin: other.publicKey.toBase58(),
        wallet: wallet(),
      })
      await assert.rejects(
        cct.generateUnsignedAcceptPoolGroupListAdmin({ ...ref, list: allowlist, payer }),
        isParam('authority'),
      )
      await cct.acceptPoolGroupListAdmin({ ...ref, list: allowlist, wallet: wallet(other) })
      const engine = {
        staticAccounts: [],
        writableStatics: [],
        onSend: true,
        onReceive: false,
      }
      await assert.rejects(
        cct.generateUnsignedSetPoolGroupPolicyEngine({
          ...g,
          engine: { ...engine, program: SystemProgram.programId.toBase58() },
          payer,
        }),
        isParam('engine.program'),
      )
      await assert.rejects(
        cct.generateUnsignedSetPoolGroupPolicyEngine({
          ...g,
          engine: { ...engine, program: Keypair.generate().publicKey.toBase58() },
          payer,
        }),
        isParam('engine.program'),
      )
      const none = await cct.generateUnsignedSetPoolGroupPolicyEngine({ ...g, engine: null, payer })
      assert.deepEqual(none.transactions, [])
    })

    it('freezeLookupTable: an empty table is refused; extended, it freezes; frozen, it is refused', async () => {
      const { lookupTableAddress } = await cct.createLookupTable({
        mode: 'createEmpty',
        wallet: wallet(),
      })
      await assert.rejects(
        cct.generateUnsignedFreezeLookupTable({
          lookupTableAddress,
          payer: owner.publicKey.toBase58(),
        }),
        /empty/,
      )
      await cct.appendToLookupTable({
        lookupTableAddress,
        additionalAddresses: [Keypair.generate().publicKey.toBase58()],
        wallet: wallet(),
      })
      await assert.rejects(
        cct.generateUnsignedFreezeLookupTable({
          lookupTableAddress,
          payer: other.publicKey.toBase58(),
        }),
        isParam('authority'),
      )
      await cct.freezeLookupTable({ lookupTableAddress, wallet: wallet() })
      await assert.rejects(
        cct.generateUnsignedFreezeLookupTable({
          lookupTableAddress,
          payer: owner.publicKey.toBase58(),
        }),
        /already frozen/,
      )
    })

    describe('the make-live check on linked lanes (BDiS, handed to a test key)', () => {
      const g = { ...ref, poolGroupAddress: LINKED_GROUP }
      let lanes: Awaited<ReturnType<SolanaTokenManager['getPoolGroupLanes']>>

      before(async () => {
        await rewrite(LINKED_GROUP, GROUP_OWNER_OFFSET, owner.publicKey)
        lanes = await cct.getPoolGroupLanes(g)
        assert.ok(lanes.length >= 1)
      })

      /** The error codes the lane check reports on a lane now, expecting it open both ways. */
      const errorsNow = async (lane: (typeof lanes)[number]) =>
        new Set(
          (await cct.checkMultiTokenPoolLane({ ...lane, poolAddress: PROGRAM, getChain })).findings
            .filter((f) => f.severity === 'error' && f.check !== 'LANE_PAUSED')
            .map((f) => f.check),
        )

      /**
       * Lifting a pause either lands (the lane passes the check: it is reported in `goingLive`) or is
       * refused with the same errors the lane check reports on the lane directly.
       */
      async function liftOrRefused(
        lane: (typeof lanes)[number],
        lift: () => Promise<{ goingLive: { tokenAddress: string }[] }>,
      ) {
        const expected = await errorsNow(lane)
        try {
          const r = await lift()
          assert.equal(
            expected.size,
            0,
            `lifted although the check reports ${[...expected].join(', ')}`,
          )
          assert.ok(r.goingLive.some((l) => l.tokenAddress === lane.tokenAddress))
        } catch (e) {
          assert.ok(e instanceof CCTParamsInvalidError, String(e))
          const found = new Set(
            (e.context.findings as { check: string; tokenAddress: string }[])
              .filter((f) => f.tokenAddress === lane.tokenAddress)
              .map((f) => f.check),
          )
          assert.ok(expected.size > 0, `refused although the check is clean: ${e.message}`)
          for (const code of expected) assert.ok(found.has(code), `${code} reported`)
        }
      }

      it('a chain pause lands unjudged; lifting it needs getChain and runs the lane check', async (t) => {
        const lane = lanes.find((l) => l.remoteChainSelector === SEPOLIA)
        if (!lane) return t.skip('no lane toward Sepolia')
        const view = await cct.getMultiTokenPoolLane({ ...lane, poolAddress: PROGRAM })
        if (view.outboundStatus.status !== 'ok')
          return t.skip('the lane is not live outbound before the test')
        const c = { ...g, remoteChainSelector: SEPOLIA }
        const paused = await cct.setPoolGroupChainPause({
          ...c,
          pausedOutbound: true,
          wallet: wallet(),
        })
        // a pure pause lists and judges no lane
        assert.deepEqual(paused.affectedLanes, [])
        await assert.rejects(
          cct.generateUnsignedSetPoolGroupChainPause({
            ...c,
            pausedOutbound: false,
            payer: owner.publicKey.toBase58(),
          }),
          (e: unknown) =>
            e instanceof CCTParamsInvalidError &&
            /REMOTE_UNREADABLE/.test(e.message) &&
            /Pass getChain/.test(e.message),
        )
        await liftOrRefused(lane, () =>
          cct.setPoolGroupChainPause({ ...c, pausedOutbound: false, getChain, wallet: wallet() }),
        )
      })

      it('a lane pause by the pool owner lands; lifting it runs the lane check', async (t) => {
        const lane = lanes.find((l) => l.remoteChainSelector === SEPOLIA)
        if (!lane) return t.skip('no lane toward Sepolia')
        const state = deriveTokenPoolConfigPda(
          new PublicKey(PROGRAM),
          new PublicKey(lane.tokenAddress),
        )
        await rewrite(state.toBase58(), STATE_OWNER_OFFSET, other.publicKey)
        const l = { ...g, tokenAddress: lane.tokenAddress, remoteChainSelectors: [SEPOLIA] }
        await cct.setPoolGroupLanePause({ ...l, pausedInbound: true, wallet: wallet(other) })
        assert.equal((await cct.getPoolGroupLane({ ...ref, ...lane })).pausedInbound, true)
        await liftOrRefused(lane, () =>
          cct.setPoolGroupLanePause({
            ...l,
            pausedInbound: false,
            getChain,
            wallet: wallet(other),
          }),
        )
      })
    })
  },
)
