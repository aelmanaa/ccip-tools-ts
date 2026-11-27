/**
 * Account fixtures of a pool-groups lane toward Sepolia, shared by the pool-group unit tests.
 *
 * @packageDocumentation
 */

import { BN, BorshAccountsCoder } from '@coral-xyz/anchor'
import {
  type Connection,
  type VersionedTransaction,
  AddressLookupTableProgram,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
} from '@solana/web3.js'

import { networkInfo } from '../../../networks.ts'
import { SolanaChain } from '../../../solana/index.ts'
import { deriveTokenPoolChainConfigV2Pda } from '../../../solana/token-pool.ts'
import { deriveTokenAdminRegistryPda } from '../programs/router.ts'
import { deriveTokenPoolChainConfigPda, deriveTokenPoolConfigPda } from '../programs/token-pool.ts'
import { GROUP_CHAIN_POLICY_FIXED_LEN, poolGroupPdas, poolGroupsCoder } from './accounts.ts'
import type { IdlPolicySections } from './lane.ts'

export const SEPOLIA = networkInfo('ethereum-testnet-sepolia').chainSelector
export const PROGRAM = Keypair.generate().publicKey
export const OTHER_PROGRAM = Keypair.generate().publicKey
export const ROUTER = Keypair.generate().publicKey
export const LUT = Keypair.generate().publicKey
export const MINT = Keypair.generate().publicKey
export const STATE = deriveTokenPoolConfigPda(PROGRAM, MINT)
export const GROUP = Keypair.generate().publicKey
export const POLICY = Keypair.generate().publicKey
export const CCV = Keypair.generate().publicKey
export const EVM_TOKEN = '0x1111111111111111111111111111111111111111'
export const EVM_POOL = '0x2222222222222222222222222222222222222222'
export const POLICY_POOL = '0x3333333333333333333333333333333333333333'
export const NOW = 1_800_000_000n
export const LUT_PROGRAM = AddressLookupTableProgram.programId
export const OFFRAMP = Keypair.generate().publicKey
export const SOURCE_CHAIN = PublicKey.findProgramAddressSync(
  [Buffer.from('source_chain_state'), Buffer.from(new BigUint64Array([SEPOLIA]).buffer)],
  OFFRAMP,
)[0]

export const hex = (h: string) => Buffer.from(h.slice(2), 'hex')
export const pad32 = (h: string) => Buffer.concat([Buffer.alloc(12), hex(h)])
export const disc = (name: string) => BorshAccountsCoder.accountDiscriminator(name)
export const bn = (v: bigint | number) => new BN(v.toString())

/** An IDL type's zero value, patched, then encoded (zero bytes are a valid Borsh default). */
export function encodeType(name: string, patch: (v: Record<string, unknown>) => void): Buffer {
  const value = poolGroupsCoder.types.decode<Record<string, unknown>>(name, Buffer.alloc(4096))
  patch(value)
  return poolGroupsCoder.types.encode(name, value)
}
export const account = (name: string, body: Buffer) => Buffer.concat([disc(name), body])

export function stateData(mint = MINT, router = ROUTER, decimals = 9): Buffer {
  return account(
    'State',
    encodeType('State', (v) => {
      v.version = 1
      Object.assign(v.config as object, { mint, decimals, router })
    }),
  )
}

export function registryData(
  interfaceVersion: number,
  lookupTable: PublicKey | null = LUT,
  size = 173,
): Buffer {
  const data = Buffer.alloc(size)
  disc('TokenAdminRegistry').copy(data, 0)
  data[8] = 1
  ;(lookupTable ?? PublicKey.default).toBuffer().copy(data, 73)
  MINT.toBuffer().copy(data, 137)
  if (size >= 172) {
    data[169] = 1 // resolution enabled
    data[171] = interfaceVersion
  }
  return data
}

/** An address lookup table account (`LookupTableMeta` is 56 bytes). */
export function lutData(addresses: PublicKey[], deactivated = false): Buffer {
  const meta = Buffer.alloc(56)
  meta.writeUInt32LE(1, 0)
  meta.writeBigUInt64LE(deactivated ? 5n : 0xffff_ffff_ffff_ffffn, 4)
  return Buffer.concat([meta, ...addresses.map((a) => a.toBuffer())])
}

/** A 2.x OffRamp `SourceChain`: one on-ramp, one default CCV, then `legacy_address_length`. */
export function sourceChainData(legacyAddressLength?: number): Buffer {
  const vec = (n: number) => {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(n)
    return b
  }
  return Buffer.concat([
    Buffer.alloc(8 + 1 + 1 + 8 + 1),
    vec(1),
    Buffer.alloc(68),
    vec(1),
    Buffer.alloc(32),
    vec(0),
    legacyAddressLength === undefined ? Buffer.alloc(0) : Buffer.from([legacyAddressLength]),
  ])
}

export function clockData(now = NOW): Buffer {
  const data = Buffer.alloc(40)
  data.writeBigInt64LE(now, 32)
  return data
}

/** A `ChainConfig` at the program's standard length, with an optional marker after it. */
export function chainConfigData(
  marker?: Buffer,
  pools: Buffer[] = [hex(EVM_POOL)],
  token: Buffer = pad32(EVM_TOKEN),
  bucket: { tokens: number; lastUpdated: number } = {
    tokens: 500,
    lastUpdated: Math.floor(Date.now() / 1000),
  },
): Buffer {
  const body = encodeType('ChainConfig', (v) => {
    const base = v.base as {
      remote: Record<string, unknown>
      outboundRateLimit: Record<string, unknown>
    }
    // a stored bucket of 500 tokens, under a disabled stored config
    base.outboundRateLimit.tokens = bn(bucket.tokens)
    base.outboundRateLimit.lastUpdated = bn(bucket.lastUpdated)
    base.remote.poolAddresses = pools.map((address) => ({ address }))
    base.remote.tokenAddress = { address: token }
    base.remote.decimals = 18
  })
  const standardLen = 8 + 139 + pools.reduce((n, p) => n + 4 + p.length, 0)
  const data = Buffer.alloc(standardLen + (marker ? 8 : 0))
  account('ChainConfig', body).copy(data, 0)
  marker?.copy(data, standardLen)
  return data
}

export type Tail = {
  group?: PublicKey
  sources?: [number, number, number, number]
  slots?: PublicKey[]
  pausedOutbound?: boolean
  format?: 0 | 1
  driven?: boolean
  memberIndex?: number
  uid?: Buffer
  /** A pending CCV set the lane copied. */
  ccvPending?: { outbound: PublicKey[]; inbound: PublicKey[]; epoch: bigint; activatesAt: bigint }
}

/** A Borsh `Vec<Pubkey>`. */
const keyVec = (keys: PublicKey[]) => {
  const len = Buffer.alloc(4)
  len.writeUInt32LE(keys.length)
  return Buffer.concat([len, ...keys.map((k) => k.toBuffer())])
}

export function chainConfigV2Data(tail?: Tail, mint = MINT): Buffer {
  const body = encodeType('ChainConfigV2', (v) => {
    Object.assign(v, { version: tail ? 2 : 1, mint, remoteChainSelector: bn(SEPOLIA) })
  })
  const data = account('ChainConfigV2', body)
  if (!tail) return data
  const ext = Buffer.alloc(32 + 4 + 128 + 1 + 1 + 1 + 8 + 1 + 4 + 27)
  ;(tail.group ?? PublicKey.default).toBuffer().copy(ext, 0)
  Buffer.from(tail.sources ?? [0, 0, 0, 0]).copy(ext, 32)
  ;(tail.slots ?? []).forEach((s, i) => s.toBuffer().copy(ext, 36 + 32 * i))
  ext[164] = tail.pausedOutbound ? 1 : 0
  ext[166] = tail.format ?? 0
  ext[175] = tail.driven ? 1 : 0
  ext.writeUInt32LE(tail.memberIndex ?? 0, 176)
  const uid = tail.uid ? Buffer.concat([Buffer.from([1]), tail.uid]) : Buffer.from([0])
  const p = tail.ccvPending
  const pending = p
    ? (() => {
        const tail8 = Buffer.alloc(16)
        tail8.writeBigUInt64LE(p.epoch, 0)
        tail8.writeBigInt64LE(p.activatesAt, 8)
        return Buffer.concat([Buffer.from([1]), keyVec(p.outbound), keyVec(p.inbound), tail8])
      })()
    : Buffer.from([0])
  return Buffer.concat([data, ext, uid, pending])
}

export type GroupChainOpts = {
  format?: 0 | 1
  laneMode?: 'off' | 'allMembers' | 'subset'
  drivenLanesPaused?: boolean
  groupPaused?: boolean
  bitmap?: number[]
  policyPoolLegacy?: boolean
  ccvs?: PublicKey[]
  securityGeneration?: number
  group?: PublicKey
  selector?: bigint
  /** The cap the record mirrors (`max_bps_fee`, set). */
  maxBpsFee?: number
  /** The record's FEE BPS (finality tier). */
  feeBps?: number
  /** The record's CONNECTION remote pools; defaults to `[POLICY_POOL]`. */
  remotePools?: string[]
  /** The record's RATE_LIMIT outbound capacity; defaults to 100. */
  outboundCapacity?: number
  /** A pending CCV set of the record's SECURITY. */
  pending?: { outbound: PublicKey[]; inbound: PublicKey[]; epoch: bigint; activatesAt: bigint }
}

export function groupChainData(opts: GroupChainOpts = {}): Buffer {
  const body = encodeType('GroupChainPolicy', (v) => {
    v.version = 1
    v.group = opts.group ?? GROUP
    v.remoteChainSelector = bn(opts.selector ?? SEPOLIA)
    v.groupPaused = !!opts.groupPaused
    v.drivenLanesPaused = !!opts.drivenLanesPaused
    v.securityGeneration = opts.securityGeneration ?? 0
    v.laneMode = { [opts.laneMode ?? 'off']: {} }
    if (opts.maxBpsFee !== undefined)
      Object.assign(v, { maxBpsFee: opts.maxBpsFee, maxBpsFeeSet: true })
    if (opts.feeBps !== undefined)
      Object.assign(
        (v.policy as { fee: { tokenTransferFeeConfig: Record<string, unknown> } }).fee
          .tokenTransferFeeConfig,
        { finalityBpsFee: opts.feeBps, isEnabled: true },
      )
    const policy = v.policy as {
      connection: Record<string, unknown>
      rateLimit: { outbound: Record<string, unknown> }
      security: { current: Record<string, unknown> }
    }
    // the record's RATE_LIMIT: capacity 100, rate 1
    Object.assign(policy.rateLimit.outbound, {
      enabled: true,
      capacity: bn(opts.outboundCapacity ?? 100),
      rate: bn(1),
    })
    policy.security.current.outbound = opts.ccvs ?? []
    policy.connection.poolDataFormat = opts.format ? { long: {} } : { legacy32: {} }
    policy.connection.remotePools = (opts.remotePools ?? [POLICY_POOL]).map((pool) => ({
      address: { address: hex(pool) },
      allowLegacyPoolData: !!opts.policyPoolLegacy,
    }))
    if (opts.pending)
      Object.assign(policy.security, {
        pending: {
          outbound: opts.pending.outbound,
          inbound: opts.pending.inbound,
          epoch: bn(opts.pending.epoch),
          activatesAt: bn(opts.pending.activatesAt),
        },
      })
  })
  const fixed = Buffer.alloc(GROUP_CHAIN_POLICY_FIXED_LEN)
  account('GroupChainPolicy', body).copy(fixed, 0)
  return Buffer.concat([fixed, Buffer.from(opts.bitmap ?? [])])
}

export function policyChainData(
  classes: number,
  format: 0 | 1,
  opts: { group?: PublicKey; securityGeneration?: number; feeBps?: number } = {},
): Buffer {
  return account(
    'PolicyChainRecord',
    encodeType('PolicyChainRecord', (v) => {
      v.version = 1
      v.group = opts.group ?? GROUP
      v.policy = POLICY
      v.remoteChainSelector = bn(SEPOLIA)
      v.classes = classes
      v.securityGeneration = opts.securityGeneration ?? 0
      const sections = v.sections as {
        connection: Record<string, unknown>
        fee: { tokenTransferFeeConfig: Record<string, unknown> }
      }
      sections.connection.poolDataFormat = format ? { long: {} } : { legacy32: {} }
      if (opts.feeBps !== undefined)
        Object.assign(sections.fee.tokenTransferFeeConfig, {
          finalityBpsFee: opts.feeBps,
          destBytesOverhead: 32,
          isEnabled: true,
        })
    }),
  )
}

export type Accounts = Map<string, { data: Buffer; owner: PublicKey }>
export type TypeAndVersion = () => Promise<[string, string, string]>

export function chainWith(
  accounts: Accounts,
  opts: {
    failOn?: PublicKey
    typeAndVersion?: TypeAndVersion
    network?: string
    offRamps?: () => Promise<string[]>
    /** Answers `simulateTransaction` (the pool's views). */
    simulate?: (tx: VersionedTransaction) => Promise<unknown>
    /** Answers `getProgramAccounts`. */
    getProgramAccounts?: (program: PublicKey, config: unknown) => Promise<unknown>
    /** Counts `getMultipleAccountsInfo` calls. */
    calls?: { multi: number }
  } = {},
): SolanaChain {
  const get = (key: PublicKey) => {
    if (opts.failOn?.equals(key)) throw new TypeError('fetch failed: 503')
    const a = accounts.get(key.toBase58())
    return a ? { ...a, lamports: 1, executable: false } : null
  }
  const connection = {
    getAccountInfo: async (key: PublicKey) => get(key),
    getMultipleAccountsInfo: async (keys: PublicKey[]) => {
      if (opts.calls) opts.calls.multi++
      return keys.map(get)
    },
    getMultipleAccountsInfoAndContext: async (keys: PublicKey[]) => {
      if (opts.calls) opts.calls.multi++
      return { context: { slot: 100 }, value: keys.map(get) }
    },
    getSignaturesForAddress: async () => [],
    ...(opts.simulate && { simulateTransaction: opts.simulate }),
    ...(opts.getProgramAccounts && { getProgramAccounts: opts.getProgramAccounts }),
  } as unknown as Connection
  const chain = new SolanaChain(connection, networkInfo(opts.network ?? 'solana-devnet'), {
    apiClient: null,
  })
  const routerType: TypeAndVersion = async () => ['CCIPRouter', '2.0.0', 'ccip-router 2.0.0']
  Object.assign(chain, {
    typeAndVersion: opts.typeAndVersion ?? routerType,
    getOffRampsForRouter: opts.offRamps ?? (async () => [OFFRAMP.toBase58()]),
  })
  return chain
}

export const CC_ADDR = deriveTokenPoolChainConfigPda(PROGRAM, SEPOLIA, MINT)
export const V2_ADDR = deriveTokenPoolChainConfigV2Pda(PROGRAM, SEPOLIA, MINT)
export const TAR = deriveTokenAdminRegistryPda(ROUTER, MINT)
export const GCP = poolGroupPdas.groupChain(PROGRAM, GROUP, SEPOLIA)
export const RECORD = poolGroupPdas.policyChain(PROGRAM, POLICY, SEPOLIA)
export type Extra = [PublicKey, Buffer, PublicKey?][]

/** The accounts of one lane of `PROGRAM` toward Sepolia. */
export function lane(
  opts: { iface?: number; cc?: Buffer; v2?: Buffer | null; extra?: Extra } = {},
) {
  const m: Accounts = new Map()
  const put = (k: PublicKey, data: Buffer, owner = PROGRAM) => m.set(k.toBase58(), { data, owner })
  put(STATE, stateData())
  put(TAR, registryData(opts.iface ?? 2), ROUTER)
  put(LUT, lutData([LUT, TAR, PROGRAM, STATE]), LUT_PROGRAM)
  put(
    SYSVAR_CLOCK_PUBKEY,
    clockData(),
    new PublicKey('Sysvar1111111111111111111111111111111111111'),
  )
  put(SOURCE_CHAIN, sourceChainData(20), OFFRAMP)
  if (opts.cc) put(CC_ADDR, opts.cc)
  if (opts.v2) put(V2_ADDR, opts.v2)
  for (const [k, d, owner] of opts.extra ?? []) put(k, d, owner)
  return m
}

/** A record's `PolicySections` (FEE 64-byte overhead, BPS 5/3; outbound bucket capacity 100). */
export function poolGroupSectionsFixture(): IdlPolicySections {
  const v = poolGroupsCoder.types.decode<IdlPolicySections>('PolicySections', Buffer.alloc(4096))
  Object.assign(v.fee.tokenTransferFeeConfig, {
    destBytesOverhead: 64,
    finalityBpsFee: 5,
    fastFinalityBpsFee: 3,
    isEnabled: true,
  })
  Object.assign(v.rateLimit.outbound, { enabled: true, capacity: bn(100), rate: bn(1) })
  return v
}
