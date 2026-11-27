import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BorshInstructionCoder } from '@coral-xyz/anchor'
import { type VersionedTransaction, Keypair, PublicKey } from '@solana/web3.js'
import { getBytes, sha256, toUtf8Bytes } from 'ethers'

import '../../../index.ts'
import { deriveTokenPoolChainConfigV2Pda } from '../../../solana/token-pool.ts'
import {
  CCTDataDecodeError,
  CCTOperationUnsupportedError,
  CCTParamsInvalidError,
} from '../../errors.ts'
import {
  deriveTokenPoolChainConfigPda,
  deriveTokenPoolProgramDataPda,
} from '../programs/token-pool.ts'
import { LANE_LINKED_MARKER, poolGroupPdas } from './accounts.ts'
import {
  type Accounts,
  CCV,
  CC_ADDR,
  GCP,
  GROUP,
  MINT,
  NOW,
  POLICY,
  PROGRAM,
  RECORD,
  SEPOLIA,
  V2_ADDR,
  account,
  bn,
  chainConfigData,
  chainConfigV2Data,
  chainWith,
  encodeType,
  groupChainData,
  lane,
  policyChainData,
} from './fixtures.test.helpers.ts'
import {
  GetPoolGroup,
  GetPoolGroupLane,
  GetPoolGroupLanes,
  GetPoolGroupRequiredCCVs,
} from './operations/index.ts'
import { POOL_GROUPS_PROGRAM_IDL } from './program.ts'

const p = { poolProgramAddress: PROGRAM.toBase58() }
const laneKey = { ...p, tokenAddress: MINT.toBase58(), remoteChainSelector: SEPOLIA }
const ixCoder = new BorshInstructionCoder(POOL_GROUPS_PROGRAM_IDL)
const ixDisc = (name: string) =>
  Buffer.from(getBytes(sha256(toUtf8Bytes(`global:${name}`)))).subarray(0, 8)

/** The instruction a view simulation ran (the last one, after the compute-budget limit). */
function simulatedIx(tx: VersionedTransaction) {
  const msg = tx.message
  const keys = msg.getAccountKeys()
  const ix = msg.compiledInstructions.at(-1)!
  return {
    programId: keys.get(ix.programIdIndex)!,
    keys: ix.accountKeyIndexes.map((i) => keys.get(i)!),
    data: Buffer.from(ix.data),
  }
}

/** A successful view simulation returning `data` (as `Program return:` in the logs). */
const returning = (data: Buffer) => ({
  context: { slot: 0 },
  value: {
    err: null,
    logs: [`Program return: ${PROGRAM.toBase58()} ${data.toString('base64')}`],
    unitsConsumed: 0,
    returnData: null,
  },
})
/** A refused simulation with a custom program error. */
const refusing = (code: number) => ({
  context: { slot: 0 },
  value: {
    err: { InstructionError: [1, { Custom: code }] },
    logs: [`Program ${PROGRAM.toBase58()} failed: custom program error: ${code}`],
    unitsConsumed: 0,
    returnData: null,
  },
})

/** An `observe_lane_group` answer with the given bucket tokens, and an FTF bucket when `ftf`. */
function observation(outbound: bigint, ftf = false): Buffer {
  return encodeType('LaneGroupObservation', (v) => {
    v.mint = MINT
    v.remoteChainSelector = bn(SEPOLIA)
    v.group = GROUP
    ;(v.outboundRateLimit as Record<string, unknown>).tokens = bn(outbound)
    ;(v.inboundRateLimit as Record<string, unknown>).tokens = bn(7)
    if (ftf) {
      v.ftfOutboundRateLimit = { ...(v.outboundRateLimit as object), tokens: bn(3) }
      v.ftfInboundRateLimit = { ...(v.inboundRateLimit as object), tokens: bn(4) }
    }
  })
}

/** A lane linked to `GROUP`, RATE_LIMIT from the group default, SECURITY from named slot 0. */
function linkedLane(): Accounts {
  return lane({
    cc: chainConfigData(LANE_LINKED_MARKER),
    v2: chainConfigV2Data({ group: GROUP, sources: [0, 0, 1, 2], slots: [POLICY] }),
    extra: [
      [GCP, groupChainData()],
      [RECORD, policyChainData(8, 0)],
      [
        POLICY,
        account(
          'Policy',
          encodeType('Policy', (v) => Object.assign(v, { version: 1, group: GROUP, policyId: 5 })),
        ),
      ],
    ],
  })
}

describe('getPoolGroupLane', () => {
  it('a linked lane: class sources, policy id, pauses, buckets with the FTF override', async () => {
    const seen: string[] = []
    const chain = chainWith(linkedLane(), {
      simulate: async (tx) => {
        const ix = simulatedIx(tx)
        assert.ok(ix.data.subarray(0, 8).equals(ixDisc('observe_lane_group')))
        seen.push(...ix.keys.map((k) => k.toBase58()))
        return returning(observation(42n, true))
      },
    })
    const r = await new GetPoolGroupLane().query(chain, laneKey)
    assert.equal(r.kind, 'linked')
    assert.equal(r.poolGroupAddress, GROUP.toBase58())
    const sources = r.classSource
    if (!sources) return assert.fail('a linked lane has class sources')
    assert.deepEqual(sources.rateLimit, { kind: 'default' })
    assert.deepEqual(sources.security, {
      kind: 'policy',
      slot: 0,
      policyAddress: POLICY.toBase58(),
      policyId: 5,
    })
    assert.deepEqual(r.rateLimits, {
      outbound: 42n,
      inbound: 7n,
      fastFinalityOutbound: 3n,
      fastFinalityInbound: 4n,
    })
    assert.equal(r.pausedOutbound, false)
    // the group record first, then the named record, as remaining accounts
    assert.ok(seen.includes(GCP.toBase58()) && seen.includes(RECORD.toBase58()))
  })

  it('a refused bucket simulation throws CCTOperationUnsupportedError; transport errors propagate', async () => {
    const refused = chainWith(linkedLane(), { simulate: async () => refusing(6000) })
    await assert.rejects(
      new GetPoolGroupLane().query(refused, laneKey),
      CCTOperationUnsupportedError,
    )
    const down = chainWith(linkedLane(), {
      simulate: async () => {
        throw new TypeError('fetch failed')
      },
    })
    await assert.rejects(new GetPoolGroupLane().query(down, laneKey), TypeError)
  })

  it('a standard lane is not simulated and has no buckets', async () => {
    let simulated = 0
    const chain = chainWith(lane({ cc: chainConfigData(), v2: chainConfigV2Data() }), {
      simulate: async () => {
        simulated++
        return refusing(101)
      },
    })
    const r = await new GetPoolGroupLane().query(chain, laneKey)
    assert.equal(r.kind, 'standard')
    assert.equal(r.rateLimits, undefined)
    assert.equal(simulated, 0)
  })
})

describe('getPoolGroupLanes', () => {
  it('filters by discriminator, version 2 and selector; keeps this group; skips orphan tails; batches', async () => {
    const other = Keypair.generate().publicKey
    const orphan = Keypair.generate().publicKey
    const accounts = linkedLane()
    // a group account for the existence check
    accounts.set(GROUP.toBase58(), {
      data: account(
        'Group',
        encodeType('Group', (v) => Object.assign(v, { version: 1, owner: CCV })),
      ),
      owner: PROGRAM,
    })
    const tails = [
      {
        pubkey: V2_ADDR,
        data: chainConfigV2Data({ group: GROUP, sources: [0, 0, 1, 2], slots: [POLICY] }),
      },
      // another group's lane
      {
        pubkey: deriveTokenPoolChainConfigV2Pda(PROGRAM, SEPOLIA, other),
        data: chainConfigV2Data({ group: other }, other),
      },
      // a tail whose ChainConfig is gone
      {
        pubkey: deriveTokenPoolChainConfigV2Pda(PROGRAM, SEPOLIA, orphan),
        data: chainConfigV2Data({ group: GROUP }, orphan),
      },
    ]
    let filters: unknown
    const calls = { multi: 0 }
    const chain = chainWith(accounts, {
      calls,
      getProgramAccounts: async (_program, config) => {
        filters = (config as { filters: unknown }).filters
        return tails.map(({ pubkey, data }) => ({
          pubkey,
          account: { data, owner: PROGRAM, lamports: 1, executable: false },
        }))
      },
      simulate: async () => returning(observation(1n)),
    })
    const lanes = await new GetPoolGroupLanes().query(chain, {
      ...p,
      poolGroupAddress: GROUP.toBase58(),
      remoteChainSelector: SEPOLIA,
    })
    assert.deepEqual(
      lanes.map((l) => l.tokenAddress),
      [MINT.toBase58()],
    )
    const sel = Buffer.alloc(8)
    sel.writeBigUInt64LE(SEPOLIA)
    assert.deepEqual(
      (filters as { memcmp: { offset: number } }[]).map((f) => f.memcmp.offset),
      [0, 9, 10],
    )
    // the group (with the clock), the lanes' accounts, their records: three paged reads, one policy read
    assert.ok(calls.multi <= 4, `${calls.multi} multi-account reads`)
    // driven only: none
    const driven = await new GetPoolGroupLanes().query(chain, {
      ...p,
      poolGroupAddress: GROUP.toBase58(),
      kind: 'driven',
    })
    assert.deepEqual(driven, [])
  })
})

describe('getPoolGroupRequiredCCVs', () => {
  const answer = () =>
    returning(encodeType('GetRequiredCCVsOut', (v) => Object.assign(v, { requiredCcvs: [CCV] })))

  it('encodes the amount big-endian and the finality as flags and depth; reports the source', async () => {
    let args: Record<string, unknown> | undefined
    const chain = chainWith(lane({ cc: chainConfigData(), v2: chainConfigV2Data() }), {
      simulate: async (tx) => {
        const ix = simulatedIx(tx)
        args = ixCoder.decode(ix.data)?.data as Record<string, unknown>
        return answer()
      },
    })
    const r = await new GetPoolGroupRequiredCCVs().query(chain, {
      ...laneKey,
      amount: 0x0102n,
      direction: 'outbound',
      finality: 5,
    })
    const input = args!.getRequiredCcvsIn as {
      amount: { beBytes: number[] }
      requestedFinalityConfig: { flags: number; blockDepth: number }
    }
    assert.deepEqual(input.amount.beBytes.slice(-2), [1, 2])
    assert.equal(input.amount.beBytes.length, 32)
    assert.deepEqual(input.requestedFinalityConfig, { flags: 0, blockDepth: 5 })
    assert.deepEqual(r.ccvs, [CCV.toBase58()])
    assert.equal(r.source, 'inline')
    assert.equal(r.finalityApplied, true)
    const inbound = await new GetPoolGroupRequiredCCVs().query(chain, {
      ...laneKey,
      amount: 1n,
      direction: 'inbound',
      finality: 5,
    })
    assert.equal(inbound.finalityApplied, false)
  })

  it('SECURITY from the pool group answers from the synced copy', async () => {
    const chain = chainWith(linkedLane(), { simulate: async () => answer() })
    const r = await new GetPoolGroupRequiredCCVs().query(chain, {
      ...laneKey,
      amount: 1n,
      direction: 'outbound',
      finality: 'safe',
    })
    assert.equal(r.source, 'pool-group-copy')
    assert.equal(r.finalityApplied, false)
    assert.equal(typeof r.synced, 'boolean')
  })

  it('refuses an outbound amount above u64 before any RPC; a refused simulation is a CCT error', async () => {
    const chain = chainWith(lane({ cc: chainConfigData(), v2: chainConfigV2Data() }), {
      simulate: async () => refusing(6001),
    })
    await assert.rejects(
      new GetPoolGroupRequiredCCVs().query(chain, {
        ...laneKey,
        amount: 1n << 64n,
        direction: 'outbound',
      }),
      CCTParamsInvalidError,
    )
    await assert.rejects(
      new GetPoolGroupRequiredCCVs().query(chain, {
        ...laneKey,
        amount: 1n,
        direction: 'outbound',
      }),
      CCTOperationUnsupportedError,
    )
  })
})

describe('getPoolGroup', () => {
  /** A group with a pending delay applying at `appliesAt` (0: none), and an upgradeable program. */
  function groupChain(appliesAt: bigint) {
    const accounts = lane()
    accounts.set(GROUP.toBase58(), {
      data: account(
        'Group',
        encodeType('Group', (v) =>
          Object.assign(v, {
            version: 1,
            owner: CCV,
            minCcvActivationDelay: bn(604_800),
            pendingMinCcvActivationDelay: bn(3_600),
            pendingMinCcvActivationDelayAt: bn(appliesAt),
          }),
        ),
      ),
      owner: PROGRAM,
    })
    const programData = Buffer.alloc(45)
    programData.writeUInt32LE(3, 0)
    programData.writeBigUInt64LE(77n, 4)
    accounts.set(deriveTokenPoolProgramDataPda(PROGRAM).toBase58(), {
      data: programData,
      owner: new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),
    })
    // every probed feature answers "absent" (InstructionFallbackNotFound)
    return chainWith(accounts, { simulate: async () => refusing(101) })
  }
  const ref = { ...p, poolGroupAddress: GROUP.toBase58() }

  it('reports the delay in force: a pending decrease whose time has come applies', async () => {
    const applied = await new GetPoolGroup().query(groupChain(NOW - 1n), ref)
    assert.equal(applied.minCCVActivationDelay, 3_600n)
    assert.equal(applied.pendingMinCCVActivationDelay, null)
    const pending = await new GetPoolGroup().query(groupChain(NOW + 1n), ref)
    assert.equal(pending.minCCVActivationDelay, 604_800n)
    assert.deepEqual(pending.pendingMinCCVActivationDelay, { delay: 3_600n, appliesAt: NOW + 1n })
    const none = await new GetPoolGroup().query(groupChain(0n), ref)
    assert.equal(none.pendingMinCCVActivationDelay, null)
    // a decoded Group proves `groups` without a probe
    assert.deepEqual(none.features, ['groups'])
  })
})

describe('lane accounts', () => {
  it('a marker without a tail is refused as not written by the program', async () => {
    const chain = chainWith(lane({ cc: chainConfigData(LANE_LINKED_MARKER), v2: null }))
    await assert.rejects(
      new GetPoolGroupLane().query(chain, laneKey),
      (err: unknown) =>
        err instanceof CCTDataDecodeError && /disagree/.test(String(err.context.reason)),
    )
    assert.equal(
      CC_ADDR.toBase58(),
      deriveTokenPoolChainConfigPda(PROGRAM, SEPOLIA, MINT).toBase58(),
    )
    assert.ok(poolGroupPdas.groupChain(PROGRAM, GROUP, SEPOLIA).equals(GCP))
  })
})
