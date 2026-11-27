/**
 * The snapshot check of record-free PCM writes (roles, the default admin, fee withdrawal): their
 * sealed facts lie outside every lane, so each must be re-read by its own op. A re-check that only
 * compares the sealed values with themselves fails here.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ZeroAddress, getAddress } from 'ethers'

import type { MultiTokenPoolSnapshotCheck } from '../../../multi-token-pool.ts'
import { MULTI_TOKEN_POOL_OPERATIONS } from '../../multi-token-pool/contracts.ts'
import {
  type StackState,
  OWNER,
  PCM,
  POOL,
  defaultStack,
  stackChain,
} from '../../multi-token-pool/stack.test.helpers.ts'
import { NO_RECORD_CHANGE_FUNCTIONS } from '../calldata.ts'
import type { MultiTokenPoolUnsignedTx } from '../write-operation.ts'
import { CheckMultiTokenPoolSnapshot, RECORD_FREE_OPS } from './check-multi-token-pool-snapshot.ts'

const ALICE = getAddress('0x' + 'a1'.repeat(20))
const BOB = getAddress('0x' + 'b0'.repeat(20))
const FEE_TOKEN = getAddress('0x' + 'fe'.repeat(20))
const RECIPIENT = getAddress('0x' + 'ec'.repeat(20))
const SCHEDULE = 1_700_000_000n

/** One record-free op: how to build it, from whom, and how to move the fact it seals. */
type Case = {
  op: string
  params: Record<string, unknown>
  sender: string
  setup?: (s: StackState) => void
  move: (s: StackState) => void
  /** A path the check must report once `move` ran. */
  path: RegExp
}

/** The fee token at the pool: `balance` answers `balanceOf(POOL)`. */
function feeToken(s: StackState, balance: bigint) {
  s.others[FEE_TOKEN] = 'ERC20 1.0.0'
  s.views.balanceOf = () => [balance]
}

const CASES: Case[] = [
  {
    op: 'grantMultiTokenPoolRole',
    params: { poolConfigManager: PCM, role: 'PAUSER_ROLE', account: ALICE },
    sender: OWNER,
    move: (s) => (s.pcm.roles.PAUSER_ROLE = [ALICE]),
    path: /^roles\.PAUSER_ROLE\./,
  },
  {
    op: 'revokeMultiTokenPoolRole',
    params: { poolConfigManager: PCM, role: 'CONFIG_ROLE', account: OWNER },
    sender: OWNER,
    move: (s) => (s.pcm.roles.CONFIG_ROLE = []),
    path: /^roles\.CONFIG_ROLE\./,
  },
  {
    op: 'renounceMultiTokenPoolRole',
    params: { poolConfigManager: PCM, role: 'PAUSER_ROLE' },
    sender: ALICE,
    setup: (s) => (s.pcm.roles.PAUSER_ROLE = [ALICE]),
    // the holder lost the role in between: the renounce changes nothing now
    move: (s) => (s.pcm.roles.PAUSER_ROLE = []),
    path: /^roles\.PAUSER_ROLE\./,
  },
  {
    op: 'beginMultiTokenPoolDefaultAdminTransfer',
    params: { poolConfigManager: PCM, newAdmin: BOB },
    sender: OWNER,
    move: (s) => (s.pcm.pendingDefaultAdmin = [ALICE, SCHEDULE]),
    path: /^admin\.pending$/,
  },
  {
    op: 'acceptMultiTokenPoolDefaultAdminTransfer',
    params: { poolConfigManager: PCM },
    sender: BOB,
    setup: (s) => {
      s.pcm.pendingDefaultAdmin = [BOB, SCHEDULE]
      s.timestamp = Number(SCHEDULE) + 1
    },
    move: (s) => (s.pcm.pendingDefaultAdmin = [BOB, SCHEDULE + 600n]),
    path: /^admin\.pending$/,
  },
  {
    op: 'cancelMultiTokenPoolDefaultAdminTransfer',
    params: { poolConfigManager: PCM },
    sender: OWNER,
    setup: (s) => (s.pcm.pendingDefaultAdmin = [BOB, SCHEDULE]),
    move: (s) => (s.pcm.pendingDefaultAdmin = [ALICE, SCHEDULE + 1n]),
    path: /^admin\.pending$/,
  },
  {
    op: 'changeMultiTokenPoolDefaultAdminDelay',
    params: { poolConfigManager: PCM, newDelay: 60 },
    sender: OWNER,
    move: (s) => (s.pcm.delay = 7n),
    path: /^admin\.delay$/,
  },
  {
    op: 'rollbackMultiTokenPoolDefaultAdminDelay',
    params: { poolConfigManager: PCM },
    sender: OWNER,
    setup: (s) => (s.pcm.pendingDelay = [60n, SCHEDULE]),
    move: (s) => (s.pcm.pendingDelay = [90n, SCHEDULE]),
    path: /^admin\.pendingDelay$/,
  },
  {
    // the renounce the review replayed: cancelled and scheduled again after the build
    op: 'renounceMultiTokenPoolDefaultAdmin',
    params: { poolConfigManager: PCM, confirmPermanentFreeze: true },
    sender: OWNER,
    setup: (s) => {
      s.pcm.pendingDefaultAdmin = [ZeroAddress, SCHEDULE]
      s.timestamp = Number(SCHEDULE) + 1
    },
    move: (s) => {
      s.pcm.pendingDefaultAdmin = [ZeroAddress, SCHEDULE + 3_600n]
      s.timestamp = Number(SCHEDULE) + 7_200
    },
    path: /^admin\.pending$/,
  },
  {
    op: 'withdrawMultiTokenPoolFeeTokens',
    params: { poolAddress: POOL, feeTokens: [FEE_TOKEN], recipient: RECIPIENT },
    sender: OWNER,
    setup: (s) => {
      s.pcm.roles.FEE_COLLECTOR_ROLE = [OWNER]
      feeToken(s, 5n)
    },
    move: (s) => feeToken(s, 9n),
    path: /^balances\./,
  },
]

/** Builds `c` on its stack, then checks the proposal, after `move` when asked. */
async function buildAndCheck(c: Case, moved: boolean): Promise<MultiTokenPoolSnapshotCheck> {
  const state = defaultStack()
  c.setup?.(state)
  const { chain } = stackChain(state)
  const op = RECORD_FREE_OPS.get(c.op)!
  const built = (await op.generate(chain, {
    ...c.params,
    sender: c.sender,
  } as never)) as MultiTokenPoolUnsignedTx
  if (moved) c.move(state)
  return new CheckMultiTokenPoolSnapshot().query(chain, {
    snapshot: built.snapshot,
    transaction: built,
    sender: c.sender,
  })
}

describe('snapshot check of record-free PCM writes', () => {
  it('registers every record-free PCM op (the op map against the decoder)', () => {
    const recordFree = Object.entries(MULTI_TOKEN_POOL_OPERATIONS)
      .filter(
        ([, t]) =>
          (t.contracts as readonly string[]).includes('PoolConfigManager') &&
          'function' in t &&
          NO_RECORD_CHANGE_FUNCTIONS.has(t.function),
      )
      .map(([name]) => name)
      .sort()
    assert.deepEqual([...RECORD_FREE_OPS.keys()].sort(), recordFree)
    assert.deepEqual(CASES.map((c) => c.op).sort(), recordFree)
  })

  for (const c of CASES) {
    it(`${c.op}: passes on unchanged state, reports the fact that moved`, async () => {
      const unchanged = await buildAndCheck(c, false)
      assert.deepEqual(unchanged.changed, [])
      assert.equal(unchanged.ok, true)
      const moved = await buildAndCheck(c, true)
      assert.equal(moved.ok, false)
      assert.ok(
        moved.changed.some((ch) => c.path.test(ch.path)),
        `expected a change at ${c.path}, got ${moved.changed.map((ch) => ch.path).join(', ')}`,
      )
    })

    it(`${c.op}: seals a fact read from chain, not only guard paths`, async () => {
      const state = defaultStack()
      c.setup?.(state)
      const built = (await RECORD_FREE_OPS.get(c.op)!.generate(stackChain(state).chain, {
        ...c.params,
        sender: c.sender,
      } as never)) as MultiTokenPoolUnsignedTx
      assert.ok(Object.keys(built.snapshot.expected).some((p) => c.path.test(p)))
    })
  }
})
