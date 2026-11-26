import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BN, BorshAccountsCoder } from '@coral-xyz/anchor'
import { type Connection, Keypair, PublicKey } from '@solana/web3.js'
import { getAddress } from 'ethers'

// Register every chain family the way SDK consumers do via the package root
import '../../../index.ts'
import { EVMChain } from '../../../evm/index.ts'
import { networkInfo } from '../../../networks.ts'
import { SolanaChain } from '../../../solana/index.ts'
import { deriveTokenPoolChainConfigV2Pda } from '../../../solana/token-pool.ts'
import { deriveTokenAdminRegistryPda } from '../programs/router.ts'
import { deriveTokenPoolChainConfigPda, deriveTokenPoolConfigPda } from '../programs/token-pool.ts'
import {
  GROUP_CHAIN_POLICY_FIXED_LEN,
  LANE_DRIVEN_MARKER,
  LANE_LINKED_MARKER,
  poolGroupPdas,
  poolGroupsCoder,
} from './accounts.ts'
import { readSolanaRemoteLaneFacts, readSolanaRemotePoolFacts } from './remote-lane.ts'

const SEPOLIA = networkInfo('ethereum-testnet-sepolia').chainSelector
const PROGRAM = Keypair.generate().publicKey
const ROUTER = Keypair.generate().publicKey
const LUT = Keypair.generate().publicKey
const MINT = Keypair.generate().publicKey
const STATE = deriveTokenPoolConfigPda(PROGRAM, MINT)
const GROUP = Keypair.generate().publicKey
const POLICY = Keypair.generate().publicKey
const EVM_TOKEN = '0x1111111111111111111111111111111111111111'
const EVM_POOL = '0x2222222222222222222222222222222222222222'
const POLICY_POOL = '0x3333333333333333333333333333333333333333'

const pad32 = (hex: string) => Buffer.concat([Buffer.alloc(12), Buffer.from(hex.slice(2), 'hex')])
const disc = (name: string) => BorshAccountsCoder.accountDiscriminator(name)

/** An IDL type's zero value, patched, then encoded (zero bytes are a valid Borsh default). */
function encodeType(name: string, patch: (v: Record<string, unknown>) => void): Buffer {
  const value = poolGroupsCoder.types.decode<Record<string, unknown>>(name, Buffer.alloc(4096))
  patch(value)
  return poolGroupsCoder.types.encode(name, value)
}
const account = (name: string, body: Buffer) => Buffer.concat([disc(name), body])

function stateData(decimals = 9): Buffer {
  return account(
    'State',
    encodeType('State', (v) => {
      v.version = 1
      const config = v.config as Record<string, unknown>
      Object.assign(config, { mint: MINT, decimals, router: ROUTER })
    }),
  )
}

function registryData(interfaceVersion: number, lookupTable: PublicKey | null = LUT): Buffer {
  const data = Buffer.alloc(173)
  disc('TokenAdminRegistry').copy(data, 0)
  data[8] = 1
  ;(lookupTable ?? PublicKey.default).toBuffer().copy(data, 73)
  MINT.toBuffer().copy(data, 137)
  data[169] = 1 // resolution enabled
  data[171] = interfaceVersion
  return data
}

/** A `ChainConfig` at the program's standard length, with an optional marker after it. */
function chainConfigData(marker?: Buffer, pools = [EVM_POOL], token = pad32(EVM_TOKEN)): Buffer {
  const body = encodeType('ChainConfig', (v) => {
    const base = v.base as { remote: Record<string, unknown>; outboundRateLimit: { cfg: object } }
    base.remote.poolAddresses = pools.map((p) => ({ address: Buffer.from(p.slice(2), 'hex') }))
    base.remote.tokenAddress = { address: token }
    base.remote.decimals = 18
  })
  const standardLen = 8 + 139 + pools.reduce((n, p) => n + 4 + (p.length - 2) / 2, 0)
  const data = Buffer.alloc(standardLen + (marker ? 8 : 0))
  account('ChainConfig', body).copy(data, 0)
  marker?.copy(data, standardLen)
  return data
}

type Tail = {
  group?: PublicKey
  sources?: [number, number, number, number]
  slots?: PublicKey[]
  pausedOutbound?: boolean
  format?: 0 | 1
  driven?: boolean
  memberIndex?: number
}

function chainConfigV2Data(tail?: Tail): Buffer {
  const body = encodeType('ChainConfigV2', (v) => {
    Object.assign(v, {
      version: tail ? 2 : 1,
      mint: MINT,
      remoteChainSelector: new BN(SEPOLIA.toString()),
    })
  })
  const data = account('ChainConfigV2', body)
  if (!tail) return data
  const ext = Buffer.alloc(32 + 4 + 128 + 1 + 1 + 1 + 8 + 1 + 4 + 27 + 1 + 1)
  ;(tail.group ?? PublicKey.default).toBuffer().copy(ext, 0)
  Buffer.from(tail.sources ?? [0, 0, 0, 0]).copy(ext, 32)
  ;(tail.slots ?? []).forEach((s, i) => s.toBuffer().copy(ext, 36 + 32 * i))
  ext[164] = tail.pausedOutbound ? 1 : 0
  ext[166] = tail.format ?? 0
  ext[175] = tail.driven ? 1 : 0
  ext.writeUInt32LE(tail.memberIndex ?? 0, 176)
  return Buffer.concat([data, ext])
}

function groupChainData(opts: {
  format?: 0 | 1
  laneMode?: 'off' | 'allMembers' | 'subset'
  drivenLanesPaused?: boolean
  groupPaused?: boolean
  bitmap?: number[]
}): Buffer {
  const body = encodeType('GroupChainPolicy', (v) => {
    v.group = GROUP
    v.remoteChainSelector = new BN(SEPOLIA.toString())
    v.groupPaused = !!opts.groupPaused
    v.drivenLanesPaused = !!opts.drivenLanesPaused
    v.laneMode = { [opts.laneMode ?? 'off']: {} }
    const connection = (v.policy as { connection: Record<string, unknown> }).connection
    connection.poolDataFormat = opts.format ? { long: {} } : { legacy32: {} }
    connection.remotePools = [
      {
        address: { address: Buffer.from(POLICY_POOL.slice(2), 'hex') },
        allowLegacyPoolData: false,
      },
    ]
  })
  const fixed = Buffer.alloc(GROUP_CHAIN_POLICY_FIXED_LEN)
  account('GroupChainPolicy', body).copy(fixed, 0)
  return Buffer.concat([fixed, Buffer.from(opts.bitmap ?? [])])
}

function policyChainData(classes: number, format: 0 | 1, group = GROUP): Buffer {
  return account(
    'PolicyChainRecord',
    encodeType('PolicyChainRecord', (v) => {
      v.group = group
      v.policy = POLICY
      v.classes = classes
      const connection = (v.sections as { connection: Record<string, unknown> }).connection
      connection.poolDataFormat = format ? { long: {} } : { legacy32: {} }
    }),
  )
}

type Accounts = Map<string, { data: Buffer; owner: PublicKey }>

function chainWith(accounts: Accounts, opts: { failOn?: PublicKey } = {}): SolanaChain {
  const get = (key: PublicKey) => {
    if (opts.failOn?.equals(key)) throw new Error('fetch failed: 503')
    const a = accounts.get(key.toBase58())
    return a ? { ...a, lamports: 1, executable: false } : null
  }
  const connection = {
    getAccountInfo: async (key: PublicKey) => get(key),
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(get),
    getAddressLookupTable: async (key: PublicKey) =>
      key.equals(LUT)
        ? { value: { state: { addresses: [LUT, PROGRAM, PROGRAM, STATE] } } }
        : { value: null },
    getSignaturesForAddress: async () => [],
  } as unknown as Connection
  return new SolanaChain(connection, networkInfo('solana-devnet'), { apiClient: null })
}

/** The accounts of one lane of `PROGRAM` toward Sepolia. */
function lane(opts: {
  iface?: number
  cc?: Buffer
  v2?: Buffer | null
  extra?: [PublicKey, Buffer][]
}): Accounts {
  const m: Accounts = new Map()
  const put = (k: PublicKey, data: Buffer, owner = PROGRAM) => m.set(k.toBase58(), { data, owner })
  put(STATE, stateData())
  put(deriveTokenAdminRegistryPda(ROUTER, MINT), registryData(opts.iface ?? 2), ROUTER)
  if (opts.cc) put(deriveTokenPoolChainConfigPda(PROGRAM, SEPOLIA, MINT), opts.cc)
  if (opts.v2) put(deriveTokenPoolChainConfigV2Pda(PROGRAM, SEPOLIA, MINT), opts.v2)
  for (const [k, d] of opts.extra ?? []) put(k, d)
  return m
}

const query = (extra: { readRateLimits?: boolean } = {}) => ({
  remoteChainSelector: SEPOLIA,
  mint: MINT.toBase58(),
  trustedPools: [STATE.toBase58()],
  ...extra,
})
const GCP = poolGroupPdas.groupChain(PROGRAM, GROUP, SEPOLIA)

describe('readSolanaRemoteLaneFacts', () => {
  it('reads a standard lane: legacy, no long data, canonical EVM spellings, inline bucket', async () => {
    const chain = chainWith(lane({ cc: chainConfigData(), v2: chainConfigV2Data() }))
    const facts = await readSolanaRemoteLaneFacts(chain, query({ readRateLimits: true }))
    assert.equal(facts.status, 'known')
    assert.equal(facts.laneKind, 'standard')
    assert.equal(facts.poolDataFormat, 'legacy')
    assert.equal(facts.readsLongData, false)
    assert.equal(facts.registryPool, STATE.toBase58())
    assert.equal(facts.interfaceVersion, 2)
    // stored 32-byte padded, returned checksummed at 20 bytes
    assert.equal(facts.back?.remoteToken, getAddress(EVM_TOKEN))
    assert.deepEqual(facts.back.remotePools, [getAddress(EVM_POOL)])
    assert.equal(facts.back.remoteDecimals, 9)
    assert.ok('outboundRateLimiterState' in facts.back)
    assert.equal(facts.back.outboundRateLimiterState, null) // disabled bucket
  })

  it('reads a marked lane with its own long format: long data on interface 2 only', async () => {
    const accounts = lane({
      cc: chainConfigData(LANE_LINKED_MARKER),
      v2: chainConfigV2Data({ format: 1 }),
    })
    const two = await readSolanaRemoteLaneFacts(chainWith(accounts), query())
    assert.equal(two.status === 'known' && two.readsLongData, true)
    const one = await readSolanaRemoteLaneFacts(
      chainWith(
        lane({
          iface: 1,
          cc: chainConfigData(LANE_LINKED_MARKER),
          v2: chainConfigV2Data({ format: 1 }),
        }),
      ),
      query(),
    )
    assert.equal(one.status === 'known' && one.readsLongData, false)
  })

  it('resolves CONNECTION from the group record: format and trusted pools, pauses folded in', async () => {
    const accounts = lane({
      cc: chainConfigData(LANE_LINKED_MARKER),
      v2: chainConfigV2Data({ group: GROUP, sources: [1, 0, 1, 0], format: 0 }),
      extra: [[GCP, groupChainData({ format: 1, groupPaused: true })]],
    })
    const facts = await readSolanaRemoteLaneFacts(
      chainWith(accounts),
      query({ readRateLimits: true }),
    )
    assert.equal(facts.status, 'known')
    assert.equal(facts.poolDataFormat, 'long')
    assert.equal(facts.readsLongData, true)
    assert.deepEqual(facts.back?.remotePools, [getAddress(EVM_POOL), getAddress(POLICY_POOL)])
    assert.equal(facts.back.pausedOutbound, true)
    assert.equal(facts.back.pausedInbound, true)
    assert.equal(facts.back.outboundRateLimiterState, undefined)
    assert.match(facts.back.outboundUnknownReason ?? '', /policy record/)
  })

  it('resolves CONNECTION from a named policy record and checks it carries the class', async () => {
    const recordAddr = poolGroupPdas.policyChain(PROGRAM, POLICY, SEPOLIA)
    const base = {
      cc: chainConfigData(LANE_LINKED_MARKER),
      v2: chainConfigV2Data({ group: GROUP, sources: [2, 0, 0, 0], slots: [POLICY] }),
    }
    const ok = await readSolanaRemoteLaneFacts(
      chainWith(
        lane({
          ...base,
          extra: [
            [GCP, groupChainData({})],
            [recordAddr, policyChainData(1, 1)],
          ],
        }),
      ),
      query(),
    )
    assert.equal(ok.status === 'known' && ok.poolDataFormat, 'long')
    const notCarried = await readSolanaRemoteLaneFacts(
      chainWith(
        lane({
          ...base,
          extra: [
            [GCP, groupChainData({})],
            [recordAddr, policyChainData(2, 1)],
          ],
        }),
      ),
      query(),
    )
    assert.equal(notCarried.status, 'unknown')
    const otherGroup = await readSolanaRemoteLaneFacts(
      chainWith(
        lane({
          ...base,
          extra: [
            [GCP, groupChainData({})],
            [recordAddr, policyChainData(1, 1, POLICY)],
          ],
        }),
      ),
      query(),
    )
    assert.equal(otherGroup.status, 'unknown')
    const absent = await readSolanaRemoteLaneFacts(
      chainWith(lane({ ...base, extra: [[GCP, groupChainData({})]] })),
      query(),
    )
    assert.equal(absent.status, 'unknown')
  })

  it('reads a group-driven lane: admission from the subset bitmap, driven pause', async () => {
    const driven = (gcp: Buffer, memberIndex: number) =>
      lane({
        cc: chainConfigData(LANE_DRIVEN_MARKER),
        v2: chainConfigV2Data({ group: GROUP, sources: [1, 1, 1, 1], driven: true, memberIndex }),
        extra: [[GCP, gcp]],
      })
    const admitted = await readSolanaRemoteLaneFacts(
      chainWith(
        driven(groupChainData({ laneMode: 'subset', bitmap: [0b0000_0100], format: 1 }), 2),
      ),
      query(),
    )
    assert.equal(admitted.status, 'known')
    assert.equal(admitted.laneKind, 'driven')
    assert.equal(admitted.readsLongData, true)
    assert.equal(admitted.back?.admitted, true)
    assert.equal(admitted.back.pausedOutbound, false)
    const notAdmitted = await readSolanaRemoteLaneFacts(
      chainWith(driven(groupChainData({ laneMode: 'subset', bitmap: [0b0000_0100] }), 3)),
      query(),
    )
    assert.equal(notAdmitted.status === 'known' && notAdmitted.back?.admitted, false)
    const paused = await readSolanaRemoteLaneFacts(
      chainWith(driven(groupChainData({ laneMode: 'allMembers', drivenLanesPaused: true }), 0)),
      query(),
    )
    assert.equal(paused.status === 'known' && paused.back?.admitted, true)
    assert.equal(paused.status === 'known' && paused.back?.pausedInbound, true)
  })

  it('fails closed when the marker and the tail disagree', async () => {
    for (const [cc, v2] of [
      [chainConfigData(LANE_LINKED_MARKER), chainConfigV2Data()],
      [chainConfigData(), chainConfigV2Data({ format: 1 })],
      [chainConfigData(LANE_DRIVEN_MARKER), chainConfigV2Data({ format: 1 })],
      [chainConfigData(LANE_LINKED_MARKER), chainConfigV2Data({ group: GROUP, driven: true })],
    ] as const) {
      const facts = await readSolanaRemoteLaneFacts(chainWith(lane({ cc, v2 })), query())
      assert.equal(facts.status, 'unknown')
    }
  })

  it('fails closed on a linked lane without its group record, or a corrupt tail', async () => {
    const noRecord = await readSolanaRemoteLaneFacts(
      chainWith(
        lane({ cc: chainConfigData(LANE_LINKED_MARKER), v2: chainConfigV2Data({ group: GROUP }) }),
      ),
      query(),
    )
    assert.equal(noRecord.status, 'unknown')
    const corrupt = chainConfigV2Data({ format: 1 })
    const truncated = await readSolanaRemoteLaneFacts(
      chainWith(
        lane({
          cc: chainConfigData(LANE_LINKED_MARKER),
          v2: corrupt.subarray(0, corrupt.length - 1),
        }),
      ),
      query(),
    )
    assert.equal(truncated.status, 'unknown')
  })

  it('fails closed on a remote token that is not an EVM address', async () => {
    const dirty = Buffer.alloc(32, 0xff)
    const facts = await readSolanaRemoteLaneFacts(
      chainWith(lane({ cc: chainConfigData(undefined, [EVM_POOL], dirty), v2: null })),
      query(),
    )
    assert.equal(facts.status, 'unknown')
  })

  it('a registry without a pool, or a pool without a lane, is known', async () => {
    const accounts = lane({})
    accounts.set(deriveTokenAdminRegistryPda(ROUTER, MINT).toBase58(), {
      data: registryData(2, null),
      owner: ROUTER,
    })
    const noPool = await readSolanaRemoteLaneFacts(chainWith(accounts), query())
    assert.deepEqual(noPool, {
      status: 'known',
      registryPool: null,
      laneKind: 'none',
      readsLongData: false,
      interfaceVersion: 2,
    })
    const noLane = await readSolanaRemoteLaneFacts(chainWith(lane({})), query())
    assert.equal(noLane.status === 'known' && noLane.laneKind, 'none')
    assert.equal(noLane.status === 'known' && noLane.back, undefined)
  })

  it('missing and unknown inputs', async () => {
    const chain = chainWith(lane({}))
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

  it('propagates transport errors', async () => {
    const chain = chainWith(lane({ cc: chainConfigData() }), {
      failOn: deriveTokenAdminRegistryPda(ROUTER, MINT),
    })
    await assert.rejects(readSolanaRemoteLaneFacts(chain, query()), /503/)
  })
})

describe('readSolanaRemotePoolFacts', () => {
  const params = { remoteChainSelector: SEPOLIA, poolAddress: STATE.toBase58() }
  it('true only for the registry pool of a marked long lane on interface 2', async () => {
    const long = lane({
      cc: chainConfigData(LANE_LINKED_MARKER),
      v2: chainConfigV2Data({ format: 1 }),
    })
    assert.deepEqual(await readSolanaRemotePoolFacts(chainWith(long), params), {
      status: 'known',
      isMultiTokenPool: true,
    })
    const standard = lane({ cc: chainConfigData(), v2: chainConfigV2Data() })
    assert.deepEqual(await readSolanaRemotePoolFacts(chainWith(standard), params), {
      status: 'known',
      isMultiTokenPool: false,
    })
    const iface1 = lane({
      iface: 1,
      cc: chainConfigData(LANE_LINKED_MARKER),
      v2: chainConfigV2Data({ format: 1 }),
    })
    assert.deepEqual(await readSolanaRemotePoolFacts(chainWith(iface1), params), {
      status: 'known',
      isMultiTokenPool: false,
    })
  })
  it('missing pool, undecodable pool, inconsistent lane', async () => {
    const chain = chainWith(lane({}))
    assert.equal(
      (
        await readSolanaRemotePoolFacts(chain, {
          ...params,
          poolAddress: Keypair.generate().publicKey.toBase58(),
        })
      ).status,
      'missing',
    )
    const accounts = lane({ extra: [[GCP, groupChainData({})]] })
    assert.equal(
      (
        await readSolanaRemotePoolFacts(chainWith(accounts), {
          ...params,
          poolAddress: GCP.toBase58(),
        })
      ).status,
      'unknown',
    )
    const bad = lane({ cc: chainConfigData(LANE_LINKED_MARKER), v2: chainConfigV2Data() })
    assert.equal((await readSolanaRemotePoolFacts(chainWith(bad), params)).status, 'unknown')
  })
})
