import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import { getAddress } from 'ethers'

// Register every chain family the way SDK consumers do via the package root
import '../../../index.ts'
import {
  CCIPSolanaOffRampEventsNotFoundError,
  CCIPTypeVersionInvalidError,
} from '../../../errors/index.ts'
import { EVMChain } from '../../../evm/index.ts'
import { networkInfo } from '../../../networks.ts'
import { deriveTokenPoolConfigPda } from '../programs/token-pool.ts'
import { LANE_DRIVEN_MARKER, LANE_LINKED_MARKER } from './accounts.ts'
import {
  type Accounts,
  type Extra,
  type GroupChainOpts,
  type Tail,
  type TypeAndVersion,
  CCV,
  CC_ADDR,
  EVM_POOL,
  EVM_TOKEN,
  GCP,
  GROUP,
  LUT,
  LUT_PROGRAM,
  MINT,
  OFFRAMP,
  OTHER_PROGRAM,
  POLICY,
  POLICY_POOL,
  PROGRAM,
  RECORD,
  ROUTER,
  SEPOLIA,
  SOURCE_CHAIN,
  STATE,
  TAR,
  V2_ADDR,
  chainConfigData,
  chainConfigV2Data,
  chainWith,
  disc,
  groupChainData,
  hex,
  lane,
  lutData,
  pad32,
  policyChainData,
  registryData,
  sourceChainData,
  stateData,
} from './fixtures.test.helpers.ts'
import { readSolanaRemoteLaneFacts, readSolanaRemotePoolFacts } from './remote-lane.ts'

const set = (accounts: Accounts, key: PublicKey, data: Buffer, owner: PublicKey) => {
  accounts.set(key.toBase58(), { data, owner })
  return accounts
}

const query = (extra: { readRateLimits?: boolean } = {}) => ({
  remoteChainSelector: SEPOLIA,
  mint: MINT.toBase58(),
  trustedPools: [STATE.toBase58()],
  ...extra,
})
type Query = ReturnType<typeof query>

async function known(accounts: Accounts, q: Query = query()) {
  const facts = await readSolanaRemoteLaneFacts(chainWith(accounts), q)
  assert.equal(facts.status, 'known', 'reason' in facts ? facts.reason : '')
  return facts
}
async function unknownReason(
  accounts: Accounts,
  q: Query = query(),
  chainOpts: Parameters<typeof chainWith>[1] = {},
) {
  const facts = await readSolanaRemoteLaneFacts(chainWith(accounts, chainOpts), q)
  assert.equal(facts.status, 'unknown')
  return 'reason' in facts ? facts.reason : ''
}
const linked = (tail: Tail = {}, extra: Extra = []) =>
  lane({
    cc: chainConfigData(LANE_LINKED_MARKER),
    v2: chainConfigV2Data({ group: GROUP, sources: [1, 1, 1, 1], ...tail }),
    extra: [[GCP, groupChainData()], ...extra],
  })

describe('readSolanaRemoteLaneFacts', () => {
  it('reads a standard lane: canonical and raw EVM spellings, decimals, inline bucket', async () => {
    const facts = await known(lane({ cc: chainConfigData(), v2: chainConfigV2Data() }), {
      ...query(),
      readRateLimits: true,
    })
    assert.equal(facts.laneKind, 'standard')
    assert.equal(facts.poolDataFormat, 'legacy')
    assert.equal(facts.uid, null)
    assert.equal(facts.readsLongData, false)
    assert.equal(facts.registryPool, STATE.toBase58())
    assert.equal(facts.interfaceVersion, 2)
    assert.ok(facts.back)
    // stored 32-byte padded, returned checksummed at 20 bytes and raw at 32
    assert.equal(facts.back.remoteToken, getAddress(EVM_TOKEN))
    assert.equal(facts.back.remoteTokenRaw, `0x${pad32(EVM_TOKEN).toString('hex')}`)
    assert.equal(facts.back.remoteTokenDecimals, 18)
    assert.equal(facts.back.remoteDecimals, 9)
    assert.deepEqual(facts.back.remotePools, [
      { address: getAddress(EVM_POOL), raw: EVM_POOL, source: 'own', allowLegacyPoolData: true },
    ])
    assert.equal(facts.back.outboundRateLimiterState, null) // disabled stored bucket
    assert.equal(facts.back.failsClosed, undefined)
    assert.equal(facts.sourcePoolAddressLength, 20)
  })

  it("reads the OffRamp's legacy_address_length for the EVM chain, or null", async () => {
    const base = () => lane({ cc: chainConfigData(), v2: null })
    const length = async (accounts: Accounts, opts: Parameters<typeof chainWith>[1] = {}) => {
      const facts = await readSolanaRemoteLaneFacts(chainWith(accounts, opts), query())
      if (facts.status !== 'known') return assert.fail(facts.reason)
      return facts.sourcePoolAddressLength
    }
    assert.equal(await length(base()), 20)
    assert.equal(await length(set(base(), SOURCE_CHAIN, sourceChainData(32), OFFRAMP)), 32)
    // an OffRamp that predates the field, or another owner
    assert.equal(await length(set(base(), SOURCE_CHAIN, sourceChainData(), OFFRAMP)), null)
    assert.equal(await length(set(base(), SOURCE_CHAIN, sourceChainData(20), PROGRAM)), null)
    // no OffRamp for the chain, or only a 1.6 one
    const none = async () => {
      throw new CCIPSolanaOffRampEventsNotFoundError(ROUTER.toBase58())
    }
    assert.equal(await length(base(), { offRamps: none }), null)
    const v16: TypeAndVersion = async () => ['CCIPOfframp', '1.6.0', 'ccip-offramp 1.6.0']
    // the Router check reads the same type_version: answer Router for it, 1.6 for the OffRamp
    const mixed: TypeAndVersion = async (...args: unknown[]) =>
      args[0] === OFFRAMP.toBase58() ? v16() : ['CCIPRouter', '2.0.0', 'ccip-router 2.0.0']
    assert.equal(await length(base(), { typeAndVersion: mixed }), null)
    // two 2.x OffRamps that disagree
    const other = Keypair.generate().publicKey
    const otherChain = PublicKey.findProgramAddressSync(
      [Buffer.from('source_chain_state'), Buffer.from(new BigUint64Array([SEPOLIA]).buffer)],
      other,
    )[0]
    const two = async () => [OFFRAMP.toBase58(), other.toBase58()]
    assert.equal(
      await length(set(base(), otherChain, sourceChainData(32), other), { offRamps: two }),
      null,
    )
    // no lane back: not read
    assert.equal(await length(lane()), undefined)
    // memoized per chain, Router and source: a second call does no new OffRamp discovery
    let discoveries = 0
    const counting = async () => {
      discoveries++
      return [OFFRAMP.toBase58()]
    }
    const chain = chainWith(base(), { offRamps: counting })
    for (let i = 0; i < 3; i++) await readSolanaRemoteLaneFacts(chain, query())
    assert.equal(discoveries, 1)
    // a failed discovery is not kept
    let attempts = 0
    const flaky = async () => {
      if (attempts++ === 0) throw new Error('fetch failed: 503')
      return [OFFRAMP.toBase58()]
    }
    const retry = chainWith(base(), { offRamps: flaky })
    await assert.rejects(readSolanaRemoteLaneFacts(retry, query()), /503/)
    const again = await readSolanaRemoteLaneFacts(retry, query())
    assert.equal(again.status === 'known' && again.sourcePoolAddressLength, 20)
    assert.equal(attempts, 2)
    // transport errors propagate
    await assert.rejects(
      readSolanaRemoteLaneFacts(chainWith(base(), { failOn: SOURCE_CHAIN }), query()),
      /503/,
    )
    const down = async () => {
      throw new Error('fetch failed: 503')
    }
    await assert.rejects(
      readSolanaRemoteLaneFacts(chainWith(base(), { offRamps: down }), query()),
      /503/,
    )
  })

  it('keeps the stored byte encodings: a 20-byte token and a padded pool', async () => {
    const facts = await known(
      lane({ cc: chainConfigData(undefined, [pad32(EVM_POOL)], hex(EVM_TOKEN)), v2: null }),
    )
    assert.ok(facts.back)
    assert.equal(facts.back.remoteToken, getAddress(EVM_TOKEN))
    assert.equal(facts.back.remoteTokenRaw, EVM_TOKEN)
    assert.equal(facts.back.remotePools[0]?.address, getAddress(EVM_POOL))
    assert.equal(facts.back.remotePools[0].raw, `0x${pad32(EVM_POOL).toString('hex')}`)
  })

  it('a marked lane with its own long format: long data on interface 2 only, no legacy', async () => {
    const own = (iface: number) =>
      lane({ iface, cc: chainConfigData(LANE_LINKED_MARKER), v2: chainConfigV2Data({ format: 1 }) })
    const two = await known(own(2))
    assert.equal(two.readsLongData, true)
    assert.equal(two.back?.remotePools[0]?.allowLegacyPoolData, false)
    assert.equal((await known(own(1))).readsLongData, false)
  })

  it('returns the UID; a UID lane accepts no legacy data', async () => {
    const uid = Buffer.alloc(32, 0xab)
    const facts = await known(
      lane({ cc: chainConfigData(LANE_LINKED_MARKER), v2: chainConfigV2Data({ uid }) }),
    )
    assert.equal(facts.uid, `0x${uid.toString('hex')}`)
    assert.equal(facts.back?.remotePools[0]?.allowLegacyPoolData, false)
  })

  it('resolves CONNECTION and RATE_LIMIT from the group record, with per-pool legacy flags', async () => {
    const accounts = (gcp: GroupChainOpts) =>
      lane({
        cc: chainConfigData(LANE_LINKED_MARKER),
        v2: chainConfigV2Data({ group: GROUP, sources: [1, 0, 1, 0], format: 0 }),
        extra: [[GCP, groupChainData(gcp)]],
      })
    const long = await known(accounts({ format: 1, groupPaused: true }), {
      ...query(),
      readRateLimits: true,
    })
    assert.equal(long.poolDataFormat, 'long')
    assert.equal(long.readsLongData, true)
    assert.ok(long.back)
    assert.deepEqual(
      long.back.remotePools.map((p) => [p.address, p.source, p.allowLegacyPoolData]),
      [
        [getAddress(EVM_POOL), 'own', false],
        [getAddress(POLICY_POOL), 'policy', false],
      ],
    )
    assert.equal(long.back.pausedOutbound, true)
    assert.equal(long.back.pausedInbound, true)
    // RATE_LIMIT from the group record: the stored 500 tokens capped at the record's capacity
    const outbound = long.back.outboundRateLimiterState
    assert.ok(outbound)
    assert.equal(outbound.capacity, 100n)
    assert.equal(outbound.rate, 1n)
    assert.equal(outbound.tokens, 100n)

    for (const policyPoolLegacy of [false, true]) {
      const legacy = await known(accounts({ format: 0, policyPoolLegacy }))
      assert.deepEqual(
        legacy.back?.remotePools.map((p) => p.allowLegacyPoolData),
        [true, policyPoolLegacy],
      )
    }
  })

  it("resolves CONNECTION from a named policy record and checks it is the lane's", async () => {
    const tail: Tail = { sources: [2, 0, 0, 0], slots: [POLICY] }
    assert.equal(
      (await known(linked(tail, [[RECORD, policyChainData(1, 1)]]))).poolDataFormat,
      'long',
    )
    assert.match(
      await unknownReason(linked(tail, [[RECORD, policyChainData(2, 1)]])),
      /does not carry connection/,
    )
    assert.match(
      await unknownReason(linked(tail, [[RECORD, policyChainData(1, 1, { group: POLICY })]])),
      /is not the lane's/,
    )
    assert.match(await unknownReason(linked(tail)), /does not exist/)
    assert.match(
      await unknownReason(linked(tail, [[RECORD, policyChainData(1, 1), OTHER_PROGRAM]])),
      /not owned by the pool program/,
    )
    assert.match(await unknownReason(linked({ sources: [2, 0, 0, 0] })), /which is empty/)
    // RATE_LIMIT from a named record that does not carry it
    assert.match(
      await unknownReason(
        linked({ sources: [0, 0, 2, 0], slots: [POLICY] }, [[RECORD, policyChainData(1, 1)]]),
        { ...query(), readRateLimits: true },
      ),
      /does not carry rateLimit/,
    )
  })

  it('reports a lane that fails closed: stale SECURITY generation, unsynced CCV copy', async () => {
    const stale = await known(
      lane({
        cc: chainConfigData(LANE_LINKED_MARKER),
        v2: chainConfigV2Data({ group: GROUP, sources: [1, 1, 1, 2], slots: [POLICY] }),
        extra: [
          [GCP, groupChainData({ securityGeneration: 2 })],
          [RECORD, policyChainData(8, 0, { securityGeneration: 1 })],
        ],
      }),
    )
    assert.match(stale.back?.failsClosed ?? '', /PolicySecurityStale/)
    const unsynced = await known(
      lane({
        cc: chainConfigData(LANE_LINKED_MARKER),
        v2: chainConfigV2Data({ group: GROUP, sources: [1, 1, 1, 1] }),
        extra: [[GCP, groupChainData({ ccvs: [CCV] })]],
      }),
    )
    assert.match(unsynced.back?.failsClosed ?? '', /GroupCcvsNotSynced/)
    // a cap lowered after the FEE was written applies at once (`BpsFeeAboveGroupMax`)
    const capped = await known(
      lane({
        cc: chainConfigData(LANE_LINKED_MARKER),
        v2: chainConfigV2Data({ group: GROUP, sources: [1, 1, 1, 1] }),
        extra: [[GCP, groupChainData({ maxBpsFee: 40, feeBps: 50 })]],
      }),
    )
    assert.match(capped.back?.failsClosed ?? '', /BpsFeeAboveGroupMax: .* 50 bps, above .* 40 bps/)
    const atCap = await known(
      lane({
        cc: chainConfigData(LANE_LINKED_MARKER),
        v2: chainConfigV2Data({ group: GROUP, sources: [1, 1, 1, 1] }),
        extra: [[GCP, groupChainData({ maxBpsFee: 50, feeBps: 50 })]],
      }),
    )
    assert.equal(atCap.back?.failsClosed, undefined)
    assert.equal((await known(linked())).back?.failsClosed, undefined)
  })

  it('reads a group-driven lane: admission and the driven pause fold into the pauses', async () => {
    const driven = (gcp: GroupChainOpts, memberIndex: number, tail: Tail = {}) =>
      lane({
        cc: chainConfigData(LANE_DRIVEN_MARKER),
        v2: chainConfigV2Data({
          group: GROUP,
          sources: [1, 1, 1, 1],
          driven: true,
          memberIndex,
          ...tail,
        }),
        extra: [[GCP, groupChainData(gcp)]],
      })
    const cases: [GroupChainOpts, number, boolean, boolean][] = [
      [{ laneMode: 'subset', bitmap: [0b0000_0100], format: 1 }, 2, true, false],
      [{ laneMode: 'subset', bitmap: [0b0000_0100] }, 3, false, true],
      [{ laneMode: 'subset', bitmap: [0xff] }, 40, false, true], // beyond the bitmap
      [{ laneMode: 'allMembers' }, 0, true, false],
      [{ laneMode: 'allMembers', drivenLanesPaused: true }, 0, true, true],
      [{ laneMode: 'off' }, 0, false, true],
    ]
    for (const [gcp, index, admitted, paused] of cases) {
      const facts = await known(driven(gcp, index))
      assert.equal(facts.laneKind, 'driven')
      assert.ok(facts.back)
      assert.equal(facts.back.admitted, admitted, JSON.stringify(gcp))
      assert.equal(facts.back.pausedOutbound, paused)
      assert.equal(facts.back.pausedInbound, paused)
    }
    assert.equal((await known(driven(cases[0]![0], 2))).readsLongData, true)
    // inline CONNECTION on a driven lane: the lane's own format
    const inline = await known(
      driven({ laneMode: 'allMembers' }, 0, { sources: [0, 1, 1, 1], format: 1 }),
    )
    assert.equal(inline.poolDataFormat, 'long')
    // a driven tail with no group is never written by the program
    assert.match(
      await unknownReason(
        lane({ cc: chainConfigData(LANE_DRIVEN_MARKER), v2: chainConfigV2Data({ driven: true }) }),
      ),
      /names no pool group/,
    )
  })

  it('fails closed when the marker and the tail disagree', async () => {
    for (const [cc, v2] of [
      [chainConfigData(LANE_LINKED_MARKER), chainConfigV2Data()],
      [chainConfigData(), chainConfigV2Data({ format: 1 })],
      [chainConfigData(LANE_DRIVEN_MARKER), chainConfigV2Data({ format: 1 })],
      [chainConfigData(LANE_LINKED_MARKER), chainConfigV2Data({ group: GROUP, driven: true })],
    ] as const)
      await unknownReason(lane({ cc, v2 }))
  })

  it("fails closed on a marked lane's corrupt tail, not on an unmarked lane's other layout", async () => {
    const tail = chainConfigV2Data({ format: 1 })
    await unknownReason(
      lane({ cc: chainConfigData(LANE_LINKED_MARKER), v2: tail.subarray(0, tail.length - 1) }),
    )
    // another pool's ChainConfigV2 layout next to an unmarked lane: the tail does not apply
    const other = Buffer.concat([disc('ChainConfigV2'), Buffer.from([1, 7]), Buffer.alloc(3)])
    assert.equal((await known(lane({ cc: chainConfigData(), v2: other }))).laneKind, 'standard')
    // a ChainConfigV2 of another mint
    await unknownReason(
      lane({
        cc: chainConfigData(LANE_LINKED_MARKER),
        v2: chainConfigV2Data({ format: 1 }, Keypair.generate().publicKey),
      }),
    )
  })

  it("fails closed on lane accounts of another owner, or a group record not the lane's", async () => {
    const cc = chainConfigData(LANE_LINKED_MARKER)
    const v2 = chainConfigV2Data({ group: GROUP, sources: [1, 1, 1, 1] })
    const gcp = groupChainData()
    await unknownReason(
      lane({
        v2,
        extra: [
          [CC_ADDR, cc, OTHER_PROGRAM],
          [GCP, gcp],
        ],
      }),
    )
    await unknownReason(
      lane({
        cc,
        extra: [
          [V2_ADDR, v2, OTHER_PROGRAM],
          [GCP, gcp],
        ],
      }),
    )
    await unknownReason(lane({ cc, v2, extra: [[GCP, gcp, OTHER_PROGRAM]] }))
    await unknownReason(lane({ cc, v2 }))
    await unknownReason(lane({ cc, v2, extra: [[GCP, groupChainData({ group: POLICY })]] }))
    await unknownReason(lane({ cc, v2, extra: [[GCP, groupChainData({ selector: 1n })]] }))
  })

  it('reads a versioned (CCTP/Lombard) ChainConfig by its length; an odd length is unknown', async () => {
    const standard = chainConfigData()
    // the versioned layout: one schema byte before `base`, never marked
    const versioned = Buffer.concat([
      standard.subarray(0, 8),
      Buffer.from([1]),
      standard.subarray(8),
    ])
    const facts = await known(lane({ cc: versioned, v2: null }))
    assert.equal(facts.laneKind, 'standard')
    assert.equal(facts.back?.remoteToken, getAddress(EVM_TOKEN))
    assert.match(
      await unknownReason(lane({ cc: Buffer.concat([standard, Buffer.alloc(3)]), v2: null })),
      /no pool layout writes/,
    )
  })

  it('a driven lane with RATE_LIMIT from a named slot and readRateLimits', async () => {
    const facts = await known(
      lane({
        cc: chainConfigData(LANE_DRIVEN_MARKER),
        v2: chainConfigV2Data({
          group: GROUP,
          sources: [1, 1, 2, 1],
          slots: [POLICY],
          driven: true,
        }),
        extra: [
          [GCP, groupChainData({ laneMode: 'allMembers' })],
          [RECORD, policyChainData(4, 0)],
        ],
      }),
      { ...query(), readRateLimits: true },
    )
    assert.equal(facts.laneKind, 'driven')
    // the named record's RATE_LIMIT is the zero (disabled) config
    assert.equal(facts.back?.outboundRateLimiterState, null)
  })

  it('fails closed on a remote token that is not an EVM address', async () => {
    await unknownReason(
      lane({ cc: chainConfigData(undefined, [hex(EVM_POOL)], Buffer.alloc(32, 0xff)), v2: null }),
    )
  })

  it('M1: refuses a trusted pool State outside its PDA, or a Router that is not one', async () => {
    // a State outside its PDA (another program owns it)
    const outside = set(lane({ cc: chainConfigData() }), STATE, stateData(), OTHER_PROGRAM)
    assert.match(await unknownReason(outside), /not the pool State PDA/)
    // a lookalike program's State at its own PDA: its Router goes through getTokenAdminRegistryFor
    const fakeRouter = Keypair.generate().publicKey
    const fakeState = deriveTokenPoolConfigPda(OTHER_PROGRAM, MINT)
    const forged = lane({ extra: [[fakeState, stateData(MINT, fakeRouter), OTHER_PROGRAM]] })
    const q = { ...query(), trustedPools: [fakeState.toBase58()] }
    const typed =
      (type: string): TypeAndVersion =>
      async () => [type, '2.0.0', `${type} 2.0.0`]
    assert.match(
      await unknownReason(forged, q, { typeAndVersion: typed('burnmintTokenPool') }),
      /is not a CCIP Router/,
    )
    const invalid: TypeAndVersion = async () => {
      throw new CCIPTypeVersionInvalidError('garbage')
    }
    assert.match(
      await unknownReason(forged, q, { typeAndVersion: invalid }),
      /is not a CCIP Router/,
    )
    const down: TypeAndVersion = async () => {
      throw new Error('fetch failed: 503')
    }
    await assert.rejects(
      readSolanaRemoteLaneFacts(chainWith(forged, { typeAndVersion: down }), q),
      /503/,
    )
    // a Router answer: read, with the Router reported for information
    const facts = await known(lane({ cc: chainConfigData() }))
    assert.equal(facts.router, ROUTER.toBase58())
  })

  it('reads the registry pool when it differs from the trusted pool, and checks it', async () => {
    const other = deriveTokenPoolConfigPda(OTHER_PROGRAM, MINT)
    const withPool = (data: Buffer | null, owner = OTHER_PROGRAM) => {
      const accounts = set(lane(), LUT, lutData([LUT, TAR, OTHER_PROGRAM, other]), LUT_PROGRAM)
      return data ? set(accounts, other, data, owner) : accounts
    }
    const facts = await known(withPool(stateData()))
    assert.equal(facts.registryPool, other.toBase58())
    assert.equal(facts.poolProgram, OTHER_PROGRAM.toBase58())
    assert.equal(facts.laneKind, 'none')
    assert.equal(
      (await readSolanaRemoteLaneFacts(chainWith(withPool(null)), query())).status,
      'missing',
    )
    await unknownReason(withPool(stateData(Keypair.generate().publicKey)))
    await unknownReason(withPool(stateData(), PROGRAM)) // not at its PDA under its owner
  })

  it('registry: no pool is known; a bad or missing lookup table is unknown; the 1.6 layout is interface 1', async () => {
    const noLane = await known(lane())
    assert.equal(noLane.laneKind, 'none')
    assert.equal(noLane.back, undefined)
    assert.deepEqual(await known(set(lane(), TAR, registryData(2, null), ROUTER)), {
      status: 'known',
      registryPool: null,
      router: ROUTER.toBase58(),
      laneKind: 'none',
      readsLongData: false,
      interfaceVersion: 2,
    })
    const defaultEntry = set(
      lane(),
      LUT,
      lutData([LUT, TAR, PROGRAM, PublicKey.default]),
      LUT_PROGRAM,
    )
    assert.equal((await known(defaultEntry)).registryPool, null)
    const notRegistered = lane()
    notRegistered.delete(TAR.toBase58())
    assert.equal((await known(notRegistered)).registryPool, null)
    // the table is missing, not a table, undecodable, deactivated or too short
    const missingTable = lane()
    missingTable.delete(LUT.toBase58())
    assert.match(await unknownReason(missingTable), /does not exist/)
    const table = (data: Buffer, owner = LUT_PROGRAM) => set(lane(), LUT, data, owner)
    assert.match(
      await unknownReason(table(lutData([LUT]), SystemProgram.programId)),
      /not an address lookup table/,
    )
    assert.match(await unknownReason(table(Buffer.alloc(10))), /cannot be decoded/)
    assert.match(
      await unknownReason(table(lutData([LUT, TAR, PROGRAM, STATE], true))),
      /deactivated/,
    )
    assert.match(await unknownReason(table(lutData([LUT, TAR]))), /no pool entry/)
    // a system-owned account with no data at the registry PDA
    await unknownReason(set(lane(), TAR, Buffer.alloc(0), SystemProgram.programId))
    // the 1.6 layout (169 bytes) predates interface 2
    const legacy = await known(
      set(
        lane({ cc: chainConfigData(LANE_LINKED_MARKER), v2: chainConfigV2Data({ format: 1 }) }),
        TAR,
        registryData(0, LUT, 169),
        ROUTER,
      ),
    )
    assert.equal(legacy.interfaceVersion, 1)
    assert.equal(legacy.readsLongData, false)
  })

  it('missing and unknown inputs', async () => {
    const chain = chainWith(lane())
    assert.equal(
      (await readSolanaRemoteLaneFacts(chain, { ...query(), trustedPools: [] })).status,
      'missing',
    )
    const absent = Keypair.generate().publicKey.toBase58()
    assert.equal(
      (await readSolanaRemoteLaneFacts(chain, { ...query(), trustedPools: [absent] })).status,
      'missing',
    )
    assert.equal(
      (await readSolanaRemoteLaneFacts(chain, { ...query(), mint: 'not-base58!' })).status,
      'unknown',
    )
    const evm = Object.create(EVMChain.prototype) as EVMChain
    Object.assign(evm, { network: networkInfo('ethereum-testnet-sepolia') })
    assert.equal((await readSolanaRemoteLaneFacts(evm, query())).status, 'unknown')
  })

  it('propagates transport errors at every RPC', async () => {
    const pool = {
      remoteChainSelector: SEPOLIA,
      poolAddress: STATE.toBase58(),
    }
    for (const failOn of [STATE, TAR, LUT, CC_ADDR, GCP]) {
      const chain = () => chainWith(linked(), { failOn })
      await assert.rejects(readSolanaRemoteLaneFacts(chain(), query()), /503/, failOn.toBase58())
      await assert.rejects(readSolanaRemotePoolFacts(chain(), pool), /503/, failOn.toBase58())
    }
    // the registry pool fetch, when it differs from the trusted pool
    const other = deriveTokenPoolConfigPda(OTHER_PROGRAM, MINT)
    const accounts = set(lane(), LUT, lutData([LUT, TAR, OTHER_PROGRAM, other]), LUT_PROGRAM)
    await assert.rejects(
      readSolanaRemoteLaneFacts(chainWith(accounts, { failOn: other }), query()),
      /503/,
    )
  })
})

describe('readSolanaRemotePoolFacts', () => {
  const params = {
    remoteChainSelector: SEPOLIA,
    poolAddress: STATE.toBase58(),
  }
  const pool = (accounts: Accounts) => readSolanaRemotePoolFacts(chainWith(accounts), params)

  it('true only for the registry pool of a marked long lane on interface 2', async () => {
    const long = (iface = 2) =>
      lane({ iface, cc: chainConfigData(LANE_LINKED_MARKER), v2: chainConfigV2Data({ format: 1 }) })
    assert.deepEqual(await pool(long()), { status: 'known', isMultiTokenPool: true })
    assert.deepEqual(await pool(lane({ cc: chainConfigData(), v2: chainConfigV2Data() })), {
      status: 'known',
      isMultiTokenPool: false,
    })
    assert.deepEqual(await pool(long(1)), { status: 'known', isMultiTokenPool: false })
    const driven = lane({
      cc: chainConfigData(LANE_DRIVEN_MARKER),
      v2: chainConfigV2Data({ group: GROUP, sources: [1, 1, 1, 1], driven: true }),
      extra: [[GCP, groupChainData({ laneMode: 'allMembers', format: 1 })]],
    })
    assert.deepEqual(await pool(driven), { status: 'known', isMultiTokenPool: true })
  })

  it('missing pool, undecodable pool, inconsistent lane', async () => {
    const absent = Keypair.generate().publicKey.toBase58()
    assert.equal(
      (await readSolanaRemotePoolFacts(chainWith(lane()), { ...params, poolAddress: absent }))
        .status,
      'missing',
    )
    const records = chainWith(lane({ extra: [[GCP, groupChainData()]] }))
    assert.equal(
      (await readSolanaRemotePoolFacts(records, { ...params, poolAddress: GCP.toBase58() })).status,
      'unknown',
    )
    const bad = lane({ cc: chainConfigData(LANE_LINKED_MARKER), v2: chainConfigV2Data() })
    assert.equal((await pool(bad)).status, 'unknown')
  })
})
