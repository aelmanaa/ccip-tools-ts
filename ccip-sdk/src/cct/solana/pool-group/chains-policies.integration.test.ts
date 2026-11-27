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

// Live, read-only (account reads and simulations; nothing is sent): the S3b chain-record and policy
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
  'pool-group chain records and policies on Devnet (read-only)',
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

    it('refuses a stranger on every gate before simulation', async () => {
      const remoteChainSelector = lanes[0]!.remoteChainSelector
      await assert.rejects(
        cct.generateUnsignedAddPoolGroupChain({ ...ref, remoteChainSelector: 1n, payer: stranger }),
        param('authority'),
      )
      await assert.rejects(
        cct.generateUnsignedSetPoolGroupChainPolicy({
          ...ref,
          remoteChainSelector,
          section: { policyClass: 'rateLimit', rateLimit: { outbound: { enabled: false } } },
          detachFromPoolGroupDefault: true,
          payer: stranger,
        }),
        param('authority'),
      )
      await assert.rejects(
        cct.generateUnsignedCreatePoolGroupPolicy({ ...ref, classes: ['fee'], payer: stranger }),
        param('authority'),
      )
    })

    it("the owner's RATE_LIMIT clamp on a chain record: built and judged on its lanes, the snapshot checks", async () => {
      const lane = lanes[0]!
      const chainRecord = await cct.getPoolGroupChain({
        ...ref,
        remoteChainSelector: lane.remoteChainSelector,
      })
      const unsigned = await cct.generateUnsignedSetPoolGroupChainPolicy({
        ...ref,
        remoteChainSelector: lane.remoteChainSelector,
        section: {
          policyClass: 'rateLimit',
          rateLimit: { outbound: { enabled: true, capacity: 1n, rate: 1n } },
        },
        ...(chainRecord.inheritsDefault.includes('rateLimit') && {
          detachFromPoolGroupDefault: true,
        }),
        payer: owner,
      })
      assert.equal(unsigned.transactions.length, 1)
      assert.ok(unsigned.affectedLanes.some((l) => l.tokenAddress === lane.tokenAddress))
      assert.deepEqual(unsigned.goingLive, [])
      const check = await cct.checkPoolGroupSnapshot({
        ...ref,
        snapshot: unsigned.snapshot!,
        transaction: unsigned.transactions[0]!,
      })
      assert.equal(check.ok, true, JSON.stringify(check.changed))
    })

    it("the owner's next policy: the id is nextPolicyId; a lane owned by someone else cannot be assigned by the group owner", async () => {
      const group = await cct.getPoolGroup(ref)
      const created = await cct.generateUnsignedCreatePoolGroupPolicy({
        ...ref,
        classes: ['fee', 'rateLimit'],
        payer: owner,
      })
      assert.equal(created.policyId, group.nextPolicyId)
      assert.equal(created.transactions.length, 1)
      await assert.rejects(
        cct.generateUnsignedAssignPoolGroupLanePolicies({
          ...ref,
          remoteChainSelector: lanes[0]!.remoteChainSelector,
          tokenAddresses: [lanes[0]!.tokenAddress],
          classSource: {
            connection: { kind: 'default' },
            fee: { kind: 'default' },
            rateLimit: { kind: 'default' },
            security: { kind: 'default' },
          },
          expectedOwner: owner,
          payer: stranger,
        }),
        param('authority'),
      )
    })
  },
)
