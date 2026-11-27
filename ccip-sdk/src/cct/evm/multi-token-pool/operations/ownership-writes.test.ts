import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Interface, ZeroAddress, getAddress } from 'ethers'

import { CCTContractTypeInvalidError, CCTParamsInvalidError } from '../../../errors.ts'
import { AcceptPoolOwnership } from '../../token-pool/operations/accept-pool-ownership.ts'
import { SetDynamicConfig } from '../../token-pool/operations/set-dynamic-config.ts'
import { TransferPoolOwnership } from '../../token-pool/operations/transfer-pool-ownership.ts'
import {
  CPS,
  OTHER,
  OWNER,
  POOL,
  WRITE_IFACE,
  defaultStack,
  revert,
  stackChain,
} from '../stack.test.helpers.ts'
import {
  AcceptMultiTokenPoolHooksOwnership,
  AcceptMultiTokenPoolOwnership,
  AcceptPolicyStoreOwnership,
  TransferMultiTokenPoolHooksOwnership,
  TransferMultiTokenPoolOwnership,
  TransferPolicyStoreOwnership,
} from './ownership-writes.ts'

const HOOKS = getAddress('0x' + 'cc'.repeat(20))
const NEW_OWNER = getAddress('0x' + 'dd'.repeat(20))
const OZ = new Interface(['error CannotTransferToSelf()', 'error MustBeProposedOwner()'])

/** A stack whose hooks contract is owned by OWNER, with an optional pending owner. */
function withHooks(pendingOwner = ZeroAddress) {
  const state = defaultStack()
  state.others[HOOKS] = 'MultiTokenPoolHooks 2.1.0-dev'
  state.auxOwners[HOOKS] = { owner: OWNER, pendingOwner }
  state.views.owner = () => [OWNER]
  return state
}

/** The decoded write of a built transaction. */
const decode = (tx: { transactions: { data?: string | null }[] }) =>
  WRITE_IFACE.parseTransaction({ data: String(tx.transactions[0]!.data) })!

const refusedAt = (param: RegExp | string, reason?: RegExp) => (e: unknown) => {
  assert.ok(e instanceof CCTParamsInvalidError, String(e))
  if (typeof param === 'string') assert.equal(e.context.param, param)
  else assert.match(String(e.context.param), param)
  if (reason) assert.match(String(e.context.reason), reason)
  return true
}

describe('MTTP ownership writes', () => {
  describe('transfer', () => {
    it('encodes transferOwnership(newOwner) to the pool, simulated from the owner', async () => {
      const { chain, callBlocks } = stackChain()
      const tx = await new TransferMultiTokenPoolOwnership().generate(chain, {
        poolAddress: POOL,
        newOwner: NEW_OWNER,
        sender: OWNER,
      })
      const [only] = tx.transactions
      assert.equal(only!.to, POOL)
      assert.equal(only!.from, OWNER)
      const decoded = decode(tx)
      assert.equal(decoded.name, 'transferOwnership')
      assert.equal(decoded.args[0], NEW_OWNER)
      assert.equal(tx.simulatedFrom, 'sender')
      assert.deepEqual(tx.affectedLanes, [])
      assert.equal('snapshot' in tx, false)
      // the simulation is pinned to the block the owner was read at
      const sim = callBlocks.find((c) => c.name === 'transferOwnership')!
      assert.equal(sim.blockTag, 1_000)
    })

    it('builds without sender (multisig), not simulated', async () => {
      const { chain, calls } = stackChain()
      const tx = await new TransferMultiTokenPoolOwnership().generate(chain, {
        poolAddress: POOL,
        newOwner: NEW_OWNER,
      })
      assert.equal(tx.simulatedFrom, 'none')
      assert.ok(!calls.some((c) => c.startsWith(`call:${POOL}:0xf2fde38b`)))
    })

    it('allows ZeroAddress as newOwner (retracts a pending transfer), as main', async () => {
      const { chain } = stackChain()
      const tx = await new TransferMultiTokenPoolOwnership().generate(chain, {
        poolAddress: POOL,
        newOwner: ZeroAddress,
        sender: OWNER,
      })
      assert.equal(decode(tx).args[0], ZeroAddress)
    })

    it('refuses before any RPC: a zero pool, a malformed newOwner, newOwner equal to sender', async () => {
      const { chain, calls } = stackChain()
      const op = new TransferMultiTokenPoolOwnership()
      await assert.rejects(
        op.generate(chain, { poolAddress: ZeroAddress, newOwner: NEW_OWNER }),
        refusedAt('poolAddress'),
      )
      await assert.rejects(
        op.generate(chain, { poolAddress: POOL, newOwner: '0x12' }),
        refusedAt('newOwner'),
      )
      await assert.rejects(
        op.generate(chain, { poolAddress: POOL, newOwner: OWNER, sender: OWNER }),
        refusedAt('newOwner', /CannotTransferToSelf/),
      )
      assert.deepEqual(calls, [])
    })

    it('refuses a sender that is not the owner, and the current owner as newOwner', async () => {
      const { chain } = stackChain()
      const op = new TransferMultiTokenPoolOwnership()
      await assert.rejects(
        op.generate(chain, { poolAddress: POOL, newOwner: NEW_OWNER, sender: OTHER }),
        refusedAt('sender', new RegExp(`multi-token pool owner \\(${OWNER}\\)`)),
      )
      // with no sender the bound holds against the chain
      await assert.rejects(
        op.generate(chain, { poolAddress: POOL, newOwner: OWNER }),
        refusedAt('newOwner', /CannotTransferToSelf/),
      )
    })

    it('refuses a write that reverts when simulated, with the decoded error', async () => {
      const state = defaultStack()
      state.writes = {
        transferOwnership: () => {
          throw revert(OZ, 'CannotTransferToSelf')
        },
      }
      const { chain } = stackChain(state)
      await assert.rejects(
        new TransferMultiTokenPoolOwnership().generate(chain, {
          poolAddress: POOL,
          newOwner: NEW_OWNER,
          sender: OWNER,
        }),
        (e: unknown) => {
          assert.ok(e instanceof CCTParamsInvalidError)
          assert.equal(e.context.simulatedFrom, 'sender')
          assert.equal(e.context.errorName, 'CannotTransferToSelf')
          return true
        },
      )
    })

    it('a policy store: targets the store; a pool given as policyStore is refused by type', async () => {
      const { chain } = stackChain()
      const tx = await new TransferPolicyStoreOwnership().generate(chain, {
        policyStore: CPS,
        newOwner: NEW_OWNER,
        sender: OWNER,
      })
      assert.equal(tx.transactions[0]!.to, CPS)
      await assert.rejects(
        new TransferPolicyStoreOwnership().generate(chain, {
          policyStore: POOL,
          newOwner: NEW_OWNER,
        }),
        CCTContractTypeInvalidError,
      )
    })

    it('a hook contract: gated on type only, owner from storage', async () => {
      const { chain } = stackChain(withHooks())
      const tx = await new TransferMultiTokenPoolHooksOwnership().generate(chain, {
        hooks: HOOKS,
        newOwner: NEW_OWNER,
        sender: OWNER,
      })
      assert.equal(tx.transactions[0]!.to, HOOKS)
      await assert.rejects(
        new TransferMultiTokenPoolHooksOwnership().generate(chain, {
          hooks: HOOKS,
          newOwner: NEW_OWNER,
          sender: OTHER,
        }),
        refusedAt('sender', /hook contract owner/),
      )
    })
  })

  describe('accept', () => {
    it('encodes acceptOwnership(), sent by the pending owner', async () => {
      const state = defaultStack()
      state.pool.pendingOwner = NEW_OWNER
      const { chain } = stackChain(state)
      const tx = await new AcceptMultiTokenPoolOwnership().generate(chain, {
        poolAddress: POOL,
        sender: NEW_OWNER,
      })
      assert.equal(decode(tx).name, 'acceptOwnership')
      assert.equal(tx.transactions[0]!.from, NEW_OWNER)
    })

    it('refuses the current owner, another account, and an accept with nothing pending', async () => {
      const state = defaultStack()
      state.stores[CPS]!.pendingOwner = NEW_OWNER
      const { chain } = stackChain(state)
      const op = new AcceptPolicyStoreOwnership()
      await assert.rejects(
        op.generate(chain, { policyStore: CPS, sender: OWNER }),
        refusedAt('sender', new RegExp(`pending owner of the policy store \\(${NEW_OWNER}\\)`)),
      )
      const idle = stackChain(withHooks())
      await assert.rejects(
        new AcceptMultiTokenPoolHooksOwnership().generate(idle.chain, {
          hooks: HOOKS,
          sender: NEW_OWNER,
        }),
        refusedAt('sender', /no ownership transfer is pending/),
      )
    })

    it('builds without sender (the pending owner signs offline)', async () => {
      const { chain } = stackChain(withHooks(NEW_OWNER))
      const tx = await new AcceptMultiTokenPoolHooksOwnership().generate(chain, { hooks: HOOKS })
      assert.equal(tx.simulatedFrom, 'none')
    })
  })

  describe("main's pool ownership ops redirect", () => {
    for (const [op, instead] of [
      [new TransferPoolOwnership(), 'transferMultiTokenPoolOwnership'],
      [new AcceptPoolOwnership(), 'acceptMultiTokenPoolOwnership'],
    ] as const)
      it(`${op.name} names ${instead}`, async () => {
        const { chain } = stackChain()
        await assert.rejects(
          op.generate(chain, { poolAddress: POOL, newOwner: NEW_OWNER }),
          (e: unknown) => {
            assert.ok(e instanceof CCTContractTypeInvalidError)
            assert.match(String(e.context.reason), new RegExp(instead))
            assert.match(String(e.context.reason), /has its own op/)
            return true
          },
        )
      })
  })

  it("main's setDynamicConfig names setMultiTokenPoolRouter", async () => {
    const { chain } = stackChain()
    await assert.rejects(
      new SetDynamicConfig().generate(chain, {
        poolAddress: POOL,
        router: NEW_OWNER,
        rateLimitAdmin: ZeroAddress,
        feeAdmin: ZeroAddress,
      }),
      (e: unknown) => {
        assert.ok(e instanceof CCTContractTypeInvalidError)
        assert.match(String(e.context.reason), /setMultiTokenPoolRouter/)
        return true
      },
    )
  })
})
