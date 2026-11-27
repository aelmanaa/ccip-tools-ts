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

// Live, read-only (account reads and simulations; nothing is sent): the S3a pre-checks and
// refusals on the pool-groups program of record on Solana Devnet. Override via RPC_SOLANA_DEVNET.
await useResource(['solana-devnet'])
const SOLANA_RPC = rpcEndpoint('RPC_SOLANA_DEVNET')
const skip = !!process.env.SKIP_INTEGRATION_TESTS

const PROGRAM = '22P6h4QV5wswBX63KCncFGctC9dyVRMjykBBDdhwXjg7'
// a group with two linked lanes (all classes from the group's chain record)
const LINKED_GROUP = 'BDiSFAren1qkqK5BjT3JpFNbbTbawoC6YxVghrAwDGbt'
const ref = { poolProgramAddress: PROGRAM, poolGroupAddress: LINKED_GROUP }
const stranger = Keypair.generate().publicKey.toBase58()
const param = (name: string) => (e: unknown) =>
  e instanceof CCTParamsInvalidError && e.context.param === name

describe(
  'pool-group lifecycle pre-checks on Devnet (read-only)',
  { skip, timeout: 180_000 },
  () => {
    let cct: SolanaTokenManager
    let owner: string
    before(async () => {
      cct = SolanaTokenManager.fromChain(await SolanaChain.fromUrl(SOLANA_RPC))
      owner = (await cct.getPoolGroup(ref)).owner
    })

    it('refuses writes by a non-owner and an accept with nothing pending', async () => {
      await assert.rejects(
        cct.generateUnsignedSetPoolGroupRoles({ ...ref, roles: { pauser: null }, payer: stranger }),
        param('authority'),
      )
      await assert.rejects(
        cct.generateUnsignedTransferPoolGroupOwnership({
          ...ref,
          proposedOwner: stranger,
          payer: stranger,
        }),
        param('authority'),
      )
      await assert.rejects(
        cct.generateUnsignedAcceptPoolGroupOwnership({ ...ref, payer: stranger }),
        (e: unknown) => param('authority')(e) && /no ownership transfer is pending/.test(String(e)),
      )
    })

    it('refuses a create at an id someone else owns', async () => {
      const { poolGroupId } = await cct.getPoolGroup(ref)
      await assert.rejects(
        cct.generateUnsignedCreatePoolGroup({
          poolProgramAddress: PROGRAM,
          poolGroupId,
          payer: stranger,
        }),
        param('poolGroupId'),
      )
    })

    it("the owner's lower cap: built and judged on the group's lanes, the snapshot checks; a higher cap is refused", async () => {
      const group = await cct.getPoolGroup(ref)
      const lanes = await cct.getPoolGroupLanes(ref)
      const unsigned = await cct.generateUnsignedSetPoolGroupSettings({
        ...ref,
        maxBpsFee: group.maxBpsFee - 1,
        payer: owner,
      })
      assert.equal(unsigned.transactions.length, 1)
      assert.deepEqual(
        unsigned.affectedLanes.map((l) => l.tokenAddress).sort(),
        lanes.map((l) => l.tokenAddress).sort(),
      )
      assert.deepEqual(unsigned.goingLive, [])
      const check = await cct.checkPoolGroupSnapshot({
        ...ref,
        snapshot: unsigned.snapshot!,
        transaction: unsigned.transactions[0]!,
      })
      assert.equal(check.ok, true)
      await assert.rejects(
        cct.generateUnsignedSetPoolGroupSettings({
          ...ref,
          maxBpsFee: group.maxBpsFee + 1,
          payer: owner,
        }),
        param('maxBpsFee'),
      )
    })
  },
)
