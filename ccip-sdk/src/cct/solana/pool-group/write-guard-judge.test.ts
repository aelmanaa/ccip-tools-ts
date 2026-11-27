/**
 * The post-state guard end to end on in-memory accounts: the simulation answers with the accounts a
 * write leaves, and every refusal path of `judgePoolGroupWrite` runs (fee cap, going live, an
 * unreadable lane, a cancelled pending CCV set, unconfirmed drops).
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js'
import bs58 from 'bs58'

import '../../../index.ts'
import { CCTParamsInvalidError } from '../../errors.ts'
import type { MultiTokenPoolLaneFinding } from '../../multi-token-pool.ts'
import { LANE_LINKED_MARKER } from './accounts.ts'
import {
  type Accounts,
  type Tail,
  CCV,
  CC_ADDR,
  EVM_POOL,
  GCP,
  GROUP,
  MINT,
  NOW,
  POLICY,
  POLICY_POOL,
  PROGRAM,
  RECORD,
  SEPOLIA,
  V2_ADDR as V2,
  account,
  chainConfigData,
  chainConfigV2Data,
  chainWith,
  encodeType,
  groupChainData,
  lane,
  policyChainData,
} from './fixtures.test.helpers.ts'
import { judgePoolGroupWrite } from './write-guard.ts'

/** A lane check that answers `findings` after the write and `before` without a post-state. */
function checker(
  findings: MultiTokenPoolLaneFinding['check'][] = [],
  before: MultiTokenPoolLaneFinding['check'][] = [],
) {
  const calls: { post: boolean; expectOpen: unknown }[] = []
  const of = (codes: MultiTokenPoolLaneFinding['check'][]) =>
    codes.map((check) => ({
      check,
      severity: 'error' as const,
      tokenAddress: MINT.toBase58(),
      remoteChainSelector: SEPOLIA,
      reason: `${check} found`,
    }))
  return {
    calls,
    checkLane: async (
      ...[, , params, , post]: Parameters<
        NonNullable<Parameters<typeof judgePoolGroupWrite>[0]['checkLane']>
      >
    ) => {
      calls.push({ post: !!post, expectOpen: params.expectOpen })
      return { findings: of(post ? findings : before) }
    },
  }
}

const PAYER = Keypair.generate().publicKey
const POLICY_ACCOUNT = account(
  'Policy',
  encodeType('Policy', (v) => Object.assign(v, { version: 1, group: GROUP, policyId: 0 })),
)
const laneKey = { tokenAddress: MINT.toBase58(), remoteChainSelector: SEPOLIA }

/** A lane linked to `GROUP` with `sources`, plus its group chain record (`gcp`) and named record. */
function linked(tail: Tail, gcp: Buffer, record?: Buffer): Accounts {
  return lane({
    cc: chainConfigData(LANE_LINKED_MARKER),
    v2: chainConfigV2Data({ group: GROUP, slots: [POLICY], ...tail }),
    extra: [
      [GCP, gcp],
      [POLICY, POLICY_ACCOUNT],
      ...(record ? ([[RECORD, record]] as [PublicKey, Buffer][]) : []),
    ],
  })
}

/**
 * A chain over `before` whose simulation leaves `after` (by address), serving `getProgramAccounts`
 * from `before`.
 */
function chainFor(before: Accounts, after: Map<PublicKey, Buffer>) {
  const post = new Map([...after].map(([k, d]) => [k.toBase58(), d]))
  return chainWith(before, {
    simulate: async (_tx, config?: unknown) => {
      const addresses = (config as { accounts: { addresses: string[] } }).accounts.addresses
      return {
        context: { slot: 101 },
        value: {
          err: null,
          logs: [],
          accounts: addresses.map((a) => {
            const data = post.get(a) ?? before.get(a)?.data
            return data
              ? {
                  data: [data.toString('base64'), 'base64'],
                  owner: PROGRAM.toBase58(),
                  lamports: 1,
                }
              : null
          }),
        },
      }
    },
    getProgramAccounts: async (program, config) => {
      const { filters } = config as { filters: { memcmp: { offset: number; bytes: string } }[] }
      return [...before.entries()]
        .filter(([, a]) => a.owner.equals(program))
        .filter(([, a]) =>
          filters.every(({ memcmp: { offset, bytes } }) =>
            a.data
              .subarray(offset, offset + bs58.decode(bytes).length)
              .equals(Buffer.from(bs58.decode(bytes))),
          ),
        )
        .map(([k, a]) => ({ pubkey: new PublicKey(k), account: { ...a, lamports: 1 } }))
    },
  })
}

/** A write of the group chain record (and any `extra` writable account). */
const writeOf = (...extra: PublicKey[]) =>
  new TransactionInstruction({
    programId: PROGRAM,
    keys: [
      { pubkey: GROUP, isSigner: false, isWritable: false },
      ...[GCP, ...extra].map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })),
    ],
    data: Buffer.alloc(8),
  })

const judge = (
  chain: ReturnType<typeof chainFor>,
  opts: Partial<Parameters<typeof judgePoolGroupWrite>[0]> = {},
) =>
  judgePoolGroupWrite({
    operation: 'op',
    chain,
    program: PROGRAM,
    group: GROUP,
    payer: PAYER,
    instructions: [writeOf()],
    // the lane check on mock chains: clean unless a case injects its own
    checkLane: checker().checkLane,
    ...opts,
  })

const refusedWith = (check: string) => (e: unknown) => {
  assert.ok(e instanceof CCTParamsInvalidError)
  assert.equal(e.context.param, 'guards')
  assert.match(e.message, new RegExp(check))
  return true
}

describe('judgePoolGroupWrite', () => {
  // FEE from named slot 0 (500 bps); the chain record mirrors the cap
  const feeLane = (cap: number) =>
    linked(
      { sources: [0, 2, 0, 0] },
      groupChainData({ maxBpsFee: cap }),
      policyChainData(2, 0, { feeBps: 500 }),
    )

  it('a cap below the FEE policy fails the lane closed outbound only: refused, or a warning', async () => {
    const before = feeLane(1_000)
    const after = new Map([[GCP, groupChainData({ maxBpsFee: 100 })]])
    await assert.rejects(judge(chainFor(before, after)), refusedWith('TRANSFER_FEE_ABOVE_CAP'))
    const r = await judge(chainFor(before, after), { failsClosedSeverity: 'warning' })
    assert.deepEqual(r.affectedLanes, [laneKey])
    assert.deepEqual(
      r.findings.map((f) => [f.check, f.severity]),
      [['TRANSFER_FEE_ABOVE_CAP', 'warning']],
    )
    assert.match(r.findings[0]!.reason, /every send/)
    assert.equal(r.failingClosed.length, 1)
    // inbound never stopped: lifting the cap problem later is not "going live" inbound
    assert.deepEqual(r.goingLive, [])
  })

  it('a lower cap on a lane already capped is not newly failing closed (codes compare)', async () => {
    const r = await judge(
      chainFor(feeLane(400), new Map([[GCP, groupChainData({ maxBpsFee: 300 })]])),
    )
    assert.deepEqual(r.findings, [])
  })

  it("scope 'loosened': a clamp builds on a lane that fails a rule; loosening it is judged", async () => {
    // RATE_LIMIT from the group default, FEE from a named policy above the new cap
    const before = linked(
      { sources: [0, 2, 1, 0] },
      groupChainData({ maxBpsFee: 1_000 }),
      policyChainData(2, 0, { feeBps: 500 }),
    )
    const clamp = new Map([[GCP, groupChainData({ maxBpsFee: 100, outboundCapacity: 50 })]])
    const r = await judge(chainFor(before, clamp), { scope: 'loosened' })
    assert.deepEqual(r.affectedLanes, [laneKey])
    assert.deepEqual(r.findings, [])
    const loosen = new Map([[GCP, groupChainData({ maxBpsFee: 100, outboundCapacity: 500 })]])
    await assert.rejects(
      judge(chainFor(before, loosen), { scope: 'loosened' }),
      refusedWith('TRANSFER_FEE_ABOVE_CAP'),
    )
  })

  it("scope 'none' lists no lanes for a created record, and refuses an edit in place", async () => {
    const before = feeLane(1_000)
    const created = Keypair.generate().publicKey
    const r = await judge(chainFor(before, new Map([[created, policyChainData(2, 0)]])), {
      scope: 'none',
      instructions: [writeOf(created)],
    })
    assert.deepEqual(r.affectedLanes, [])
    await assert.rejects(
      judge(chainFor(before, new Map([[GCP, groupChainData({ maxBpsFee: 100 })]])), {
        scope: 'none',
      }),
      /edits the lane account/,
    )
  })

  it('a write that makes a lane live runs the lane check on the post-state; its errors refuse', async () => {
    const before = linked({ sources: [0, 0, 0, 0] }, groupChainData({ groupPaused: true }))
    const after = new Map([[GCP, groupChainData()]])
    const failing = checker(['POOL_DATA_FORMAT_MISMATCH'])
    await assert.rejects(judge(chainFor(before, after), failing), (e: unknown) => {
      assert.ok(e instanceof CCTParamsInvalidError)
      assert.deepEqual(e.context.goingLive, [laneKey])
      assert.match(e.message, /POOL_DATA_FORMAT_MISMATCH/)
      return true
    })
    // one call, after the write, with both directions expected open
    assert.deepEqual(failing.calls, [{ post: true, expectOpen: ['outbound', 'inbound'] }])
    const clean = checker()
    const r = await judge(chainFor(before, after), clean)
    assert.deepEqual(r.goingLive, [laneKey])
    // a lane that already failed the rule before the write still refuses when it goes live
    await assert.rejects(
      judge(chainFor(before, after), checker(['NO_REMOTE_POOL'], ['NO_REMOTE_POOL'])),
      /NO_REMOTE_POOL/,
    )
    // an accept only reports
    const accept = checker(['NO_REMOTE_POOL'])
    const w = await judge(chainFor(before, after), { goingLiveSeverity: 'warning', ...accept })
    assert.deepEqual(w.goingLive, [laneKey])
    assert.deepEqual(accept.calls, [])
  })

  it('A23: a CONNECTION change on a lane live before and after runs the lane check; new errors refuse', async () => {
    // CONNECTION from the group default: a format flip to long on the shared record
    const before = linked({ sources: [1, 0, 0, 0] }, groupChainData())
    const after = new Map([[GCP, groupChainData({ format: 1 })]])
    // the flip also drops the legacy allowance on the record's pool: confirmed here
    const confirmDropped: unknown = await judge(chainFor(before, after), checker()).catch(
      (e: unknown) => (e instanceof CCTParamsInvalidError ? e.context.dropped : undefined),
    )
    assert.ok(Array.isArray(confirmDropped))
    const opts = { confirmDropped }
    await assert.rejects(
      judge(chainFor(before, after), { ...opts, ...checker(['POOL_DATA_FORMAT_MISMATCH']) }),
      /POOL_DATA_FORMAT_MISMATCH/,
    )
    // an error the lane already had is reported, not refused
    const had = checker(['REMOTE_LANE_MISMATCH'], ['REMOTE_LANE_MISMATCH'])
    const r = await judge(chainFor(before, after), { ...opts, ...had })
    assert.deepEqual(
      r.findings.map((f) => [f.check, f.severity]),
      [['REMOTE_LANE_MISMATCH', 'warning']],
    )
    assert.deepEqual(
      had.calls.map((c) => c.post),
      [true, false],
    )
    // an unreadable remote is never waived, even when it was unreadable before too
    await assert.rejects(
      judge(chainFor(before, after), {
        ...opts,
        ...checker(['REMOTE_UNREADABLE'], ['REMOTE_UNREADABLE']),
      }),
      /REMOTE_UNREADABLE/,
    )
    // a write that leaves CONNECTION and FEE as they are runs no check
    const none = checker(['POOL_DATA_FORMAT_MISMATCH'])
    await judge(chainFor(before, new Map([[GCP, groupChainData({ maxBpsFee: 900 })]])), none)
    assert.deepEqual(none.calls, [])
  })

  it('A23: an unreadable lane is touched when a named record on its chain changes', async () => {
    const broken = Buffer.concat([policyChainData(2, 0).subarray(0, 8), Buffer.alloc(3)])
    const before = linked({ sources: [0, 2, 0, 0] }, groupChainData(), broken)
    // another policy's record on the same chain changes; the lane's own record cannot be read
    const other = Keypair.generate().publicKey
    before.set(other.toBase58(), { data: policyChainData(2, 0), owner: PROGRAM })
    const after = new Map([[other, policyChainData(2, 1)]])
    await assert.rejects(
      judge(chainFor(before, after), { instructions: [writeOf(other)] }),
      refusedWith('LANE_UNREADABLE'),
    )
  })

  it('A23: a SECURITY source change on a live lane is refused unless the CCVs stay or it is confirmed; H1: it runs the lane check', async () => {
    const pending = { outbound: [CCV], inbound: [], epoch: 2n, activatesAt: NOW + 3_600n }
    const before = linked({ sources: [0, 0, 0, 0] }, groupChainData())
    // the write moves SECURITY to the group default, and the lane's CCV copy changes
    const after = new Map([
      [
        V2,
        chainConfigV2Data({
          group: GROUP,
          slots: [POLICY],
          sources: [0, 0, 0, 1],
          ccvPending: pending,
        }),
      ],
    ])
    const ix = [writeOf(V2)]
    await assert.rejects(judge(chainFor(before, after), { instructions: ix }), (e: unknown) => {
      assert.ok(e instanceof CCTParamsInvalidError)
      assert.equal(e.context.param, 'confirmCCVChanges')
      return true
    })
    const r = await judge(chainFor(before, after), {
      instructions: ix,
      confirmCCVChanges: [laneKey],
      failsClosedSeverity: 'warning',
    })
    assert.deepEqual(r.affectedLanes, [laneKey])
    // the same lists under the new source: nothing to confirm
    const same = new Map([
      [V2, chainConfigV2Data({ group: GROUP, slots: [POLICY], sources: [0, 0, 0, 1] })],
    ])
    await judge(chainFor(before, same), { instructions: ix, failsClosedSeverity: 'warning' })
    // H1: a SECURITY source change on a live lane runs the full lane check (its hooks change)
    const hooked = checker(['HOOK_CALLER_MISSING'])
    await assert.rejects(
      judge(chainFor(before, same), {
        instructions: ix,
        failsClosedSeverity: 'warning',
        ...hooked,
      }),
      /HOOK_CALLER_MISSING/,
    )
    assert.deepEqual(
      hooked.calls.map((c) => c.post),
      [true, false],
    )
  })

  it('A23 (N1): a SECURITY source change that clears threshold CCVs needs a confirmation, base lists equal', async () => {
    const thresholds = { amount: 1_000n, outbound: [CCV] }
    const before = linked({ sources: [0, 0, 0, 0], thresholds }, groupChainData())
    // the sync from the group default clears the thresholds; the base lists stay empty
    const after = new Map([
      [V2, chainConfigV2Data({ group: GROUP, slots: [POLICY], sources: [0, 0, 0, 1] })],
    ])
    await assert.rejects(
      judge(chainFor(before, after), { instructions: [writeOf(V2)] }),
      (e: unknown) => e instanceof CCTParamsInvalidError && e.context.param === 'confirmCCVChanges',
    )
    await judge(chainFor(before, after), {
      instructions: [writeOf(V2)],
      confirmCCVChanges: [laneKey],
      failsClosedSeverity: 'warning',
    })
  })

  it('A23: the snapshot hashes a ChainConfig without its bucket state', async () => {
    const at = (tokens: number) =>
      linked({ sources: [0, 0, 0, 0] }, groupChainData()).set(CC_ADDR.toBase58(), {
        data: chainConfigData(LANE_LINKED_MARKER, undefined, undefined, {
          tokens,
          lastUpdated: tokens,
        }),
        owner: PROGRAM,
      })
    const write = new Map([
      [CC_ADDR, chainConfigData(LANE_LINKED_MARKER, [], undefined, { tokens: 1, lastUpdated: 1 })],
    ])
    const ix = {
      instructions: [writeOf(CC_ADDR)],
      ...checker(),
      confirmDropped: [{ lane: laneKey, remotePools: [EVM_POOL] }],
    }
    const a = await judge(chainFor(at(10), write), ix)
    const b = await judge(chainFor(at(20), write), ix)
    assert.equal(a.guardInputsHash, b.guardInputsHash)
  })

  it('a lane unreadable before and after is never skipped: LANE_UNREADABLE fails closed', async () => {
    const broken = Buffer.concat([policyChainData(2, 0).subarray(0, 8), Buffer.alloc(3)])
    const before = linked({ sources: [0, 2, 0, 0] }, groupChainData(), broken)
    const after = new Map([[GCP, groupChainData({ groupPaused: true })]])
    await assert.rejects(judge(chainFor(before, after)), refusedWith('LANE_UNREADABLE'))
    // an accept judges at warning: a lane it cannot read never blocks the hand-over
    const accept = await judge(chainFor(before, after), { failsClosedSeverity: 'warning' })
    assert.deepEqual(accept.unreadable, [laneKey])
    assert.deepEqual(
      accept.findings.map((f) => [f.check, f.severity]),
      [['LANE_UNREADABLE', 'warning']],
    )
    const r = await judge(chainFor(before, after), { reportFindings: true })
    assert.deepEqual(r.affectedLanes, [laneKey])
    assert.deepEqual(
      r.findings.map((f) => [f.check, f.severity]),
      [['LANE_UNREADABLE', 'error']],
    )
  })

  it('a cancelled pending CCV set the lane copied fails it closed later: a warning on accept', async () => {
    const pending = { outbound: [CCV], inbound: [], epoch: 2n, activatesAt: NOW + 3_600n }
    // SECURITY from the group default; the lane copied the record's pending set
    const before = linked(
      { sources: [0, 0, 0, 1], ccvPending: pending },
      groupChainData({ pending }),
    )
    const after = new Map([[GCP, groupChainData()]])
    await assert.rejects(judge(chainFor(before, after)), refusedWith('CCVS_NOT_SYNCED'))
    const r = await judge(chainFor(before, after), { failsClosedSeverity: 'warning' })
    assert.deepEqual(
      r.findings.map((f) => [f.check, f.severity]),
      [['CCVS_NOT_SYNCED', 'warning']],
    )
    assert.deepEqual(
      r.failingClosed.map((l) => l.tokenAddress),
      [MINT.toBase58()],
    )
    assert.match(r.findings[0]!.reason, new RegExp(String(NOW + 3_600n)))
  })

  it('an unchanged lane with a synced pending set is clean', async () => {
    const pending = { outbound: [CCV], inbound: [], epoch: 2n, activatesAt: NOW + 3_600n }
    const before = linked(
      { sources: [0, 0, 0, 1], ccvPending: pending },
      groupChainData({ pending }),
    )
    const after = new Map([[GCP, groupChainData({ pending, groupPaused: true })]])
    const r = await judge(chainFor(before, after))
    assert.deepEqual(r.findings, [])
  })

  it('drops of trusted remote pools are refused unless confirmed for the lane', async () => {
    const before = linked({ sources: [1, 0, 0, 0] }, groupChainData())
    const after = new Map([[GCP, groupChainData({ remotePools: [] })]])
    await assert.rejects(judge(chainFor(before, after)), (e: unknown) => {
      assert.ok(e instanceof CCTParamsInvalidError)
      assert.equal(e.context.param, 'confirmDropped')
      return true
    })
    const r = await judge(chainFor(before, after), {
      confirmDropped: [{ lane: laneKey, remotePools: [POLICY_POOL] }],
      ...checker(),
    })
    assert.deepEqual(r.affectedLanes, [laneKey])
    // the lane's own pool stays trusted: inbound is still live, nothing goes live
    assert.deepEqual(r.goingLive, [])
    assert.ok(EVM_POOL)
  })

  it('a write that changes no lane account lists no lanes', async () => {
    const before = linked({ sources: [0, 0, 0, 0] }, groupChainData())
    const r = await judge(chainFor(before, new Map()))
    assert.deepEqual(r.affectedLanes, [])
  })
})

describe('judgePoolGroupWrite: S4 review fixes', () => {
  const live = () => linked({ sources: [0, 0, 0, 1] }, groupChainData())
  const engine = {
    program: Keypair.generate().publicKey,
    statics: [Keypair.generate().publicKey, Keypair.generate().publicKey],
    onSend: true,
    onReceive: false,
  }

  it('M1: a hook change on a live lane runs the lane check on the post-state', async () => {
    const after = new Map([[GCP, groupChainData({ hook: { engine } })]])
    const c = checker(['ACCOUNT_LOCKS_EXCEEDED'])
    await assert.rejects(judge(chainFor(live(), after), c), refusedWith('ACCOUNT_LOCKS_EXCEEDED'))
    assert.deepEqual(
      c.calls.map((x) => x.post),
      [true, false],
    )
  })

  it('M1: the send footprint counts the records and the hook accounts a send resolves', async () => {
    const { readPoolGroupLaneStates } = await import('./operations/lane.ts')
    const { laneSendFootprint, sendLockDelta } = await import('./lane-hooks.ts')
    const read = async (gcp: Buffer) => {
      const [s] = await readPoolGroupLaneStates(
        chainWith(linked({ sources: [0, 0, 0, 1] }, gcp)),
        PROGRAM,
        [{ mint: MINT, selector: SEPOLIA }],
      )
      assert.ok(s && 'chainConfig' in s)
      return s
    }
    const plain = await read(groupChainData())
    assert.deepEqual([...laneSendFootprint(plain)], [GCP.toBase58()])
    const hooked = await read(
      groupChainData({
        hook: {
          allowlist: Keypair.generate().publicKey,
          blocklist: Keypair.generate().publicKey,
          engine,
        },
      }),
    )
    // allowlist entry 1, blocklist entries 2, engine program, hook authority and 2 statics 4
    assert.equal(sendLockDelta(plain, hooked), 7)
    assert.equal(sendLockDelta(hooked, plain), -7)
    // a receive-only engine adds nothing to a send
    const receiveOnly = await read(
      groupChainData({ hook: { engine: { ...engine, onSend: false, onReceive: true } } }),
    )
    assert.equal(sendLockDelta(plain, receiveOnly), 0)
  })

  it('M2: an unreadable lane is refused at unreadableSeverity error, whatever failsClosedSeverity', async () => {
    const broken = Buffer.concat([policyChainData(2, 0).subarray(0, 8), Buffer.alloc(3)])
    const before = linked({ sources: [0, 2, 0, 0] }, groupChainData(), broken)
    const after = new Map([[GCP, groupChainData({ groupPaused: true })]])
    await assert.rejects(
      judge(chainFor(before, after), {
        failsClosedSeverity: 'warning',
        unreadableSeverity: 'error',
      }),
      refusedWith('LANE_UNREADABLE'),
    )
  })

  it('M4: bestEffort reports a lane listing the RPC refuses instead of refusing the write', async () => {
    const before = live()
    const after = new Map([[GCP, groupChainData({ groupPaused: true })]])
    const gpaRefused = chainFor(before, after)
    Object.assign(gpaRefused.connection, {
      getProgramAccounts: async () => {
        throw new Error('410 Gone: getProgramAccounts is disabled')
      },
    })
    await assert.rejects(judge(gpaRefused))
    const r = await judge(gpaRefused, { bestEffort: true })
    assert.match(r.unlisted ?? '', /getProgramAccounts/)
    assert.deepEqual(r.affectedLanes, [])
  })
})

describe('PoolGroupWriteOperation partition (S4 review M5)', () => {
  it('a crank whose every lane the judge refuses throws the refusal (N3)', async () => {
    const { PoolGroupWriteOperation, parseWriteBase } = await import('./write-operation.ts')
    type Parsed = ReturnType<typeof parseWriteBase>
    const before = linked({ sources: [0, 0, 0, 0] }, groupChainData({ groupPaused: true }))
    const after = new Map([[GCP, groupChainData()]])
    const failing = checker(['NO_REMOTE_POOL'])
    class Crank extends PoolGroupWriteOperation<{ payer: string }, Parsed> {
      readonly name = 'crank'
      protected override prepare(p: { payer: string }): Parsed {
        return parseWriteBase(this.name, PROGRAM, p)
      }
      protected plan(_chain: unknown, parsed: Parsed) {
        const out = !!parsed.excludedLanes?.some((l) => l.tokenAddress === MINT.toBase58())
        return Promise.resolve({
          group: GROUP,
          items: out ? [] : [{ tokenAddresses: [MINT.toBase58()], instructions: [writeOf()] }],
          judge: { checkLane: failing.checkLane },
          expected: {},
          extra: {},
          partition: {
            operation: 'crank',
            inputs: (left: { tokenAddress: string }[]) => ({
              tokenAddresses: left.map((l) => l.tokenAddress),
            }),
          },
        })
      }
      protected fromInstructions(): Parsed {
        throw new Error('not used')
      }
    }
    // the only lane is refused: that is the refusal, never an empty success (re-check N3)
    await assert.rejects(
      new Crank().generate(chainFor(before, after), { payer: PAYER.toBase58() }),
      (e: unknown) => {
        assert.ok(e instanceof CCTParamsInvalidError)
        assert.equal(e.context.param, 'guards')
        assert.match(e.message, /every lane was refused/)
        assert.deepEqual(
          (e.context.findings as { check: string }[]).map((f) => f.check),
          ['NO_REMOTE_POOL'],
        )
        return true
      },
    )
  })
})

describe('S4 review: hook rules (M1) and Squads pauses (M3)', () => {
  it("M1: a hook list that is not the program's is refused; an empty enabled allowlist warns", async () => {
    const { readPoolGroupLaneStates } = await import('./operations/lane.ts')
    const { checkLaneHooks } = await import('./lane-hooks.ts')
    const allowlist = Keypair.generate().publicKey
    const blocklist = Keypair.generate().publicKey
    const accounts = linked(
      { sources: [0, 0, 0, 1] },
      groupChainData({ hook: { allowlist, blocklist } }),
    )
    accounts.set(allowlist.toBase58(), {
      owner: PROGRAM,
      data: account(
        'Allowlist',
        encodeType('Allowlist', (v) =>
          Object.assign(v, { version: 1, group: GROUP, enabled: true }),
        ),
      ),
    })
    const chain = chainWith(accounts)
    const [state] = await readPoolGroupLaneStates(chain, PROGRAM, [
      { mint: MINT, selector: SEPOLIA },
    ])
    assert.ok(state && 'chainConfig' in state)
    const found: [string, string, string][] = []
    await checkLaneHooks(
      chain,
      state,
      new Set(['outbound', 'inbound'] as const),
      () => 'error',
      (check, severity, reason) => found.push([check, severity, reason]),
      true,
    )
    assert.deepEqual(
      found.map(([c, s, r]) => [c, s, /blocklist/.test(r) ? 'blocklist' : 'allowlist']),
      [
        ['HOOK_CALLER_MISSING', 'warning', 'allowlist'],
        ['HOOK_CALLER_MISSING', 'error', 'blocklist'],
        ['HOOK_CALLER_MISSING', 'warning', 'blocklist'],
      ],
    )
  })

  it('M3: a one-direction pause under Squads is refused before any RPC', async () => {
    const { POOL_GROUP_PAUSE_OPERATIONS } = await import('./operations/pauses.ts')
    const chain = chainWith(new Map())
    const base = {
      poolProgramAddress: PROGRAM.toBase58(),
      poolGroupAddress: GROUP.toBase58(),
      payer: PAYER.toBase58(),
      budget: { executor: 'squads-v4' as const },
    }
    await assert.rejects(
      POOL_GROUP_PAUSE_OPERATIONS.setPoolGroupChainPause.generate(chain, {
        ...base,
        remoteChainSelector: SEPOLIA,
        pausedOutbound: true,
      }),
      (e: unknown) => e instanceof CCTParamsInvalidError && e.context.param === 'pausedInbound',
    )
    await assert.rejects(
      POOL_GROUP_PAUSE_OPERATIONS.setPoolGroupLanePause.generate(chain, {
        ...base,
        tokenAddress: MINT.toBase58(),
        remoteChainSelectors: [SEPOLIA],
        pausedInbound: true,
      }),
      (e: unknown) => e instanceof CCTParamsInvalidError && e.context.param === 'pausedOutbound',
    )
    // durable nonces execute later too (re-check N1); the facade types carry them
    const { budget: _, ...wallet } = base
    const deferred = {
      ...wallet,
      remoteChainSelector: SEPOLIA,
      pausedOutbound: true,
      durableNonces: {
        accounts: [{ nonceAccount: PAYER.toBase58(), nonceAuthority: PAYER.toBase58() }],
      },
    }
    await assert.rejects(
      POOL_GROUP_PAUSE_OPERATIONS.setPoolGroupChainPause.generate(chain, deferred),
      (e: unknown) => e instanceof CCTParamsInvalidError && e.context.param === 'pausedInbound',
    )
  })
})

describe('fast-finality semantics (e6 B1, chainlink-ccip-solana 7558722 v2.rs consume_rate_limit_in_group)', () => {
  it("re-enabling FTF on a lane stopped through the default bucket loosens it: scope 'loosened' judges it", async () => {
    // RATE_LIMIT from the group default, FEE from a named policy; the write lowers the cap below it
    const record = policyChainData(2, 0, { feeBps: 500 })
    const stopped = groupChainData({ maxBpsFee: 1_000, outboundCapacity: 0, outboundRate: 0 })
    const before = linked({ sources: [0, 2, 1, 0] }, stopped, record)
    // FTF transfers fell back to the stopped default bucket; an enabled FTF bucket reopens them
    const reopened = new Map([
      [
        GCP,
        groupChainData({
          maxBpsFee: 100,
          outboundCapacity: 0,
          outboundRate: 0,
          ftfOutbound: { capacity: 50, rate: 1 },
        }),
      ],
    ])
    await assert.rejects(
      judge(chainFor(before, reopened), { scope: 'loosened' }),
      refusedWith('TRANSFER_FEE_ABOVE_CAP'),
    )
    // the same stop with FTF still disabled is a clamp: it builds
    const same = new Map([
      [GCP, groupChainData({ maxBpsFee: 100, outboundCapacity: 0, outboundRate: 0 })],
    ])
    const r = await judge(chainFor(before, same), { scope: 'loosened' })
    assert.deepEqual(r.findings, [])
  })
})
