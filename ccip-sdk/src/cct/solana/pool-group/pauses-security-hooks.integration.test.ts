import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

import { Keypair } from '@solana/web3.js'

// Register every chain family the way SDK consumers do via the package root
import '../../../index.ts'
import { rpcEndpoint } from '../../../../../scripts/test-endpoints.ts'
import { useResource } from '../../../../../scripts/useResource.ts'
import { SolanaChain } from '../../../solana/index.ts'
import { CCTParamsInvalidError } from '../../errors.ts'
import { SolanaTokenManager } from '../index.ts'

// Live, read-only (account reads and simulations; nothing is sent): the S4 pause, CCV and hook
// writes built against the Devnet group BDiS… (linked lanes), as its owner would sign them.
// Override via RPC_SOLANA_DEVNET.
await useResource(['solana-devnet'])
const SOLANA_RPC = rpcEndpoint('RPC_SOLANA_DEVNET')
const skip = !!process.env.SKIP_INTEGRATION_TESTS

const PROGRAM = '22P6h4QV5wswBX63KCncFGctC9dyVRMjykBBDdhwXjg7'
const LINKED_GROUP = 'BDiSFAren1qkqK5BjT3JpFNbbTbawoC6YxVghrAwDGbt'
const ref = { poolProgramAddress: PROGRAM, poolGroupAddress: LINKED_GROUP }
const stranger = Keypair.generate().publicKey.toBase58()
const param = (name: string) => (e: unknown) =>
  e instanceof CCTParamsInvalidError && e.context.param === name

describe(
  'pool-group pauses, CCVs and hooks on Devnet (read-only)',
  { skip, timeout: 240_000 },
  () => {
    let cct: SolanaTokenManager
    let owner: string
    let lanes: Awaited<ReturnType<SolanaTokenManager['getPoolGroupLanes']>>
    before(async () => {
      cct = SolanaTokenManager.fromChain(await SolanaChain.fromUrl(SOLANA_RPC))
      owner = (await cct.getPoolGroup(ref)).owner
      lanes = await cct.getPoolGroupLanes(ref)
    })

    it('refuses a stranger on the pause, CCV and hook gates before simulation', async () => {
      const remoteChainSelector = lanes[0]!.remoteChainSelector
      const paused = (await cct.getPoolGroup(ref)).paused
      await assert.rejects(
        cct.generateUnsignedSetPoolGroupPause({ ...ref, paused: !paused, payer: stranger }),
        param('authority'),
      )
      await assert.rejects(
        cct.generateUnsignedSchedulePoolGroupCCVs({
          ...ref,
          remoteChainSelector,
          outbound: ['default'],
          inbound: [],
          payer: stranger,
        }),
        param('authority'),
      )
      await assert.rejects(
        cct.generateUnsignedActivatePoolGroupCCVsNow({
          ...ref,
          outbound: ['default'],
          inbound: [],
          payer: stranger,
        }),
        param('authority'),
      )
      await assert.rejects(
        cct.generateUnsignedCreatePoolGroupAllowlist({
          ...ref,
          enabled: true,
          admin: stranger,
          payer: stranger,
        }),
        param('authority'),
      )
    })

    it('the owner builds a chain pause (unjudged) and a CCV schedule with the default notice', async () => {
      const lane = lanes[0]!
      const record = await cct.getPoolGroupChain({
        ...ref,
        remoteChainSelector: lane.remoteChainSelector,
      })
      const pause = await cct.generateUnsignedSetPoolGroupChainPause({
        ...ref,
        remoteChainSelector: lane.remoteChainSelector,
        pausedOutbound: true,
        payer: owner,
      })
      if (record.pausedOutbound) assert.deepEqual(pause.transactions, [])
      else {
        assert.equal(pause.transactions.length, 1)
        // a pure pause never lists or judges lanes
        assert.deepEqual(pause.affectedLanes, [])
        assert.deepEqual(pause.goingLive, [])
      }
      const group = await cct.getPoolGroup(ref)
      const scheduled = await cct.generateUnsignedSchedulePoolGroupCCVs({
        ...ref,
        outbound: ['default'],
        inbound: ['default'],
        payer: owner,
      })
      const now = BigInt(Math.floor(Date.now() / 1000))
      assert.ok(scheduled.activatesAt >= now + group.minCCVActivationDelay - 120n)
      assert.equal(scheduled.transactions.length, 1)
    })

    it('freezeLookupTable refuses a table that does not exist', async () => {
      await assert.rejects(
        cct.generateUnsignedFreezeLookupTable({
          lookupTableAddress: Keypair.generate().publicKey.toBase58(),
          payer: owner,
        }),
        param('lookupTableAddress'),
      )
    })
  },
)
