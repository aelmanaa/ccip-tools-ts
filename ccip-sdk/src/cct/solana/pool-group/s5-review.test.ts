/**
 * Unit tests of the S5 review fixes: the drain gate (M2), sealed confirmations (M1), bitmap chunks
 * measured by the packer (M6), the lane-gate's refusals, metas and report (M5, m5, m10).
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Connection, Keypair, TransactionInstruction } from '@solana/web3.js'

import '../../../index.ts'
import { jsonParse } from '../../../utils.ts'
import { canonicalJson } from '../../canonical.ts'
import { CCTParamsInvalidError } from '../../errors.ts'
import { LANE_LINKED_MARKER } from './accounts.ts'
import {
  GCP,
  GROUP,
  MINT,
  PROGRAM,
  SEPOLIA,
  V2_ADDR,
  chainConfigData,
  chainConfigV2Data,
  chainWith,
  groupChainData,
  lane,
} from './fixtures.test.helpers.ts'
import { guardPoolGroupLaneOp, markedLaneState } from './lane-gate.ts'
import { isUnread } from './lane.ts'
import { decodeOwned } from './operations/common.ts'
import { bitmapChunks } from './operations/driven-lanes.ts'
import { readPoolGroupLaneStates } from './operations/lane.ts'
import { reopenedAdmissions, requireDrained } from './operations/members-common.ts'
import { sealLanes, unsealLanes } from './operations/write-common.ts'
import { SOLANA_MAX_ACCOUNT_LOCKS, measureTransaction } from './packer.ts'

const isParam = (param: string, text?: RegExp) => (e: unknown) =>
  e instanceof CCTParamsInvalidError &&
  e.context.param === param &&
  (!text || text.test(String(e.message)))

/** A linked lane of GROUP, with the chain record's driven-lanes pause and its own outbound flag. */
async function linkedState(opts: { drivenLanesPaused?: boolean; pausedOutbound?: boolean }) {
  const chain = chainWith(
    lane({
      cc: chainConfigData(LANE_LINKED_MARKER),
      v2: chainConfigV2Data({
        group: GROUP,
        sources: [1, 1, 1, 1],
        ...(opts.pausedOutbound && { pausedOutbound: true }),
      }),
      extra: [[GCP, groupChainData({ drivenLanesPaused: !!opts.drivenLanesPaused })]],
    }),
  )
  const [state] = await readPoolGroupLaneStates(chain, PROGRAM, [{ mint: MINT, selector: SEPOLIA }])
  if (!state || isUnread(state)) throw new Error('the fixture lane must read')
  return { chain, state }
}

const key = { tokenAddress: MINT.toBase58(), remoteChainSelector: SEPOLIA }

describe('S5 review M2: a pause is not a drain (design §7.6)', () => {
  it('refuses a close while outbound runs, even confirmed', async () => {
    const { state } = await linkedState({})
    assert.throws(
      () => requireDrained('closePoolGroupLanes', [{ key, state }], [key]),
      isParam('confirmInFlightDrained', /outbound runs/),
    )
  })
  it('refuses a close paused both ways but not confirmed drained', async () => {
    const { state } = await linkedState({ drivenLanesPaused: true })
    assert.throws(
      () => requireDrained('closePoolGroupLanes', [{ key, state }], []),
      isParam('confirmInFlightDrained', /a pause is not a drain/),
    )
  })
  it('accepts outbound paused here and confirmed drained', async () => {
    const { state } = await linkedState({ pausedOutbound: true })
    requireDrained('closePoolGroupLanes', [{ key, state }], [key])
  })
})

describe('S5 review M1: confirmations sealed into the snapshot', () => {
  it('round-trips through the snapshot JSON, sorted and de-duplicated', () => {
    const other = { tokenAddress: Keypair.generate().publicKey.toBase58(), remoteChainSelector: 7n }
    const sealed = sealLanes('confirmInFlightDrained', [key, other, key])
    const back = jsonParse(canonicalJson(sealed))
    assert.ok(typeof back === 'object' && back !== null)
    const lanes = unsealLanes(Object.fromEntries(Object.entries(back)), 'confirmInFlightDrained')
    assert.deepEqual(
      new Set(lanes.map((l) => `${l.tokenAddress}:${l.remoteChainSelector}`)),
      new Set([`${key.tokenAddress}:${SEPOLIA}`, `${other.tokenAddress}:7`]),
    )
    assert.deepEqual(unsealLanes({}, 'acknowledgeLiveAdmission'), [])
  })
})

describe('S5 review M6: bitmap chunks measured by the packer', () => {
  const chain = { connection: new Connection('http://127.0.0.1:1'), logger: console }
  const payer = Keypair.generate().publicKey
  const authority = Keypair.generate().publicKey
  // set_group_chain_lanes: 6 accounts + the event pair; data = 8 + 8 + mode/pause/option + bytes
  const accounts = Array.from({ length: 8 }, (_, i) => ({
    pubkey: i === 3 ? authority : Keypair.generate().publicKey,
    isSigner: i === 3,
    isWritable: i === 1 || i === 3,
  }))
  const ixOf = (bytes: Buffer) =>
    new TransactionInstruction({
      programId: PROGRAM,
      keys: accounts,
      data: Buffer.concat([Buffer.alloc(35), bytes]),
    })
  const items = (w: { bytes: Buffer }) =>
    Promise.resolve([{ tokenAddresses: [], instructions: [ixOf(w.bytes)] }])
  const bitmap = { byteOffset: 0, bytes: Buffer.alloc(2_000, 0xff) }

  for (const executor of ['wallet', 'squads-v4'] as const)
    it(`a 2,000-byte write splits into chunks that each fit (${executor})`, async () => {
      const chunks = await bitmapChunks(
        'setPoolGroupChainLanes',
        { payer, budget: { executor, computeUnitPrice: 0 } },
        bitmap,
        items,
        chain,
      )
      assert.ok(chunks.length >= 3, `${chunks.length} chunks`)
      assert.equal(
        chunks.reduce((n, c) => n + c.bytes.length, 0),
        2_000,
      )
      assert.deepEqual(
        chunks.map((c) => c.byteOffset),
        chunks.map((_, i) => i * chunks[0]!.bytes.length),
      )
      // the largest chunk compiles under the limit; one more byte would not have been chosen
      const m = measureTransaction(payer, [ixOf(chunks[0]!.bytes)], [])
      assert.ok(m.locks <= SOLANA_MAX_ACCOUNT_LOCKS)
      assert.ok(chunks[0]!.bytes.length < 800, 'the old 800-byte chunk never fitted')
    })

  it('Squads chunks are smaller than wallet chunks (500 B outer margin)', async () => {
    const [wallet = [], squads = []] = await Promise.all(
      (['wallet', 'squads-v4'] as const).map((executor) =>
        bitmapChunks(
          'setPoolGroupChainLanes',
          { payer, budget: { executor, computeUnitPrice: 0 } },
          bitmap,
          items,
          chain,
        ),
      ),
    )
    assert.ok(squads[0]!.bytes.length < wallet[0]!.bytes.length)
  })
})

describe('S5 review M5, m5, m10: the lane gate', () => {
  const payer = Keypair.generate().publicKey
  const ix = new TransactionInstruction({ programId: PROGRAM, keys: [], data: Buffer.alloc(8) })

  it('refuses CCV lists on a lane that takes SECURITY from its group (they would be ignored)', async () => {
    const { chain, state } = await linkedState({})
    await assert.rejects(
      guardPoolGroupLaneOp({
        operation: 'editChainConfigV2',
        chain,
        state,
        kind: 'editChainConfigV2',
        payer,
        instruction: ix,
        options: {},
        setsCcvs: true,
      }),
      isParam('ccvConfig', /schedulePoolGroupCCVs/),
    )
  })

  it('a lane with only its own pool-data settings: delete names setPoolGroupLanePoolData; a rate limit write gets the V2', async () => {
    const chain = chainWith(
      lane({ cc: chainConfigData(LANE_LINKED_MARKER), v2: chainConfigV2Data({ format: 1 }) }),
    )
    const state = await markedLaneState(chain, PROGRAM, MINT, SEPOLIA)
    assert.ok(state)
    await assert.rejects(
      guardPoolGroupLaneOp({
        operation: 'deleteChainRemoteConfig',
        chain,
        state,
        kind: 'deleteChainConfig',
        payer,
        instruction: ix,
        options: {},
      }),
      isParam('tokenAddress', /setPoolGroupLanePoolData/),
    )
    const r = await guardPoolGroupLaneOp({
      operation: 'setChainRateLimit',
      chain,
      state,
      kind: 'setRateLimit',
      payer,
      instruction: ix,
      options: {},
    })
    assert.ok(r.instruction.keys.at(-1)!.pubkey.equals(V2_ADDR))
    assert.equal(r.poolGroup, undefined)
  })

  it('a ChainConfig no pool layout writes fails closed', async () => {
    const chain = chainWith(lane({ cc: Buffer.alloc(40), v2: null }))
    await assert.rejects(
      markedLaneState(chain, PROGRAM, MINT, SEPOLIA),
      isParam('tokenAddress', /cannot be decoded/),
    )
  })

  it('a standard lane is untouched', async () => {
    const chain = chainWith(lane({ cc: chainConfigData(), v2: chainConfigV2Data() }))
    assert.equal(await markedLaneState(chain, PROGRAM, MINT, SEPOLIA), null)
  })
})

describe('S5 review M3: a lift that re-opens admission', () => {
  const recordOf = (opts: Parameters<typeof groupChainData>[0]) => {
    const data = groupChainData(opts)
    return {
      data,
      record: decodeOwned(
        'groupChainPolicy',
        { data, owner: PROGRAM, lamports: 1, executable: false },
        GCP,
        PROGRAM,
      ),
    }
  }
  it('reads no member when no record re-opens', async () => {
    const chain = chainWith(new Map(), {
      getProgramAccounts: () => Promise.reject(new Error('must not list')),
    })
    const r = recordOf({ laneMode: 'allMembers', drivenLanesPaused: true })
    assert.deepEqual(
      await reopenedAdmissions('setPoolGroupPause', chain, { program: PROGRAM, group: GROUP }, [
        { selector: SEPOLIA, ...r, after: { ...r.record, groupPaused: true } },
      ]),
      [],
    )
  })
  it('lists the members when a record runs again (fails closed without getProgramAccounts)', async () => {
    const r = recordOf({ laneMode: 'allMembers', groupPaused: true })
    let listed = 0
    const chain = chainWith(new Map(), {
      getProgramAccounts: () => {
        listed++
        return Promise.resolve([])
      },
    })
    assert.deepEqual(
      await reopenedAdmissions('setPoolGroupPause', chain, { program: PROGRAM, group: GROUP }, [
        { selector: SEPOLIA, ...r, after: { ...r.record, groupPaused: false } },
      ]),
      [],
    )
    assert.equal(listed, 1)
  })
})
