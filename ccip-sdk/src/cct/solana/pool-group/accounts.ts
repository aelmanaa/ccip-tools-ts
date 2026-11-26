/**
 * Decoders and PDA derivations for the accounts of the Solana pool-groups program (the
 * `burnmint_token_pool 2.1.0` fork, IDL `pool-groups-7558722`).
 *
 * The IDL accounts decode with the vendored IDL coder. `GroupMember`, `GroupRegistry` and the
 * `ChainConfigV2` tail are not IDL accounts and are decoded by hand, with offsets after the 8-byte
 * discriminator taken from the program's `state.rs` and `groups.rs`. Every decoder throws
 * `CCTDataDecodeError` on bytes the program would not have written.
 *
 * @packageDocumentation
 */

import { Buffer } from 'buffer'

import type { IdlAccounts } from '@coral-xyz/anchor'
import { PublicKey } from '@solana/web3.js'

import { sizedCoder } from '../../../solana/coder.ts'
import {
  type BurnmintTokenPoolGroups,
  IDL as POOL_GROUPS_IDL,
} from '../../../solana/idl/pool-groups-7558722/BURN_MINT_TOKEN_POOL.ts'
import { toLeArray } from '../../../utils.ts'
import { CCTDataDecodeError } from '../../errors.ts'
import type { PoolDataFormat } from '../../multi-token-pool.ts'

/** Borsh coder of the pool-groups program's IDL. @internal */
export const poolGroupsCoder = sizedCoder(POOL_GROUPS_IDL)

/** `ChainConfig` marker of a lane whose `ChainConfigV2` carries a tail: sha256("ccip_tokenpool:lane_extended")[..8]. @internal */
export const LANE_LINKED_MARKER = Buffer.from('9addeb7061135af4', 'hex')
/** `ChainConfig` marker of a group-driven lane: sha256("ccip_tokenpool:lane_group_driven")[..8]. @internal */
export const LANE_DRIVEN_MARKER = Buffer.from('081f1f6e7b0e9308', 'hex')

// `ChainConfig::INIT_SPACE`: RemoteConfig (pool vec prefix 4, token RemoteAddress 4 + 64, decimals 1)
// and two RateLimitTokenBucket (tokens 8, last_updated 8, cfg: enabled 1, capacity 8, rate 8)
const CHAIN_CONFIG_INIT_SPACE = 4 + 4 + 64 + 1 + 2 * (8 + 8 + 17)
/** Bytes of a `GroupChainPolicy` before its subset bitmap (`GROUP_CHAIN_POLICY_FIXED_LEN`). @internal */
export const GROUP_CHAIN_POLICY_FIXED_LEN = 2074

const GROUP_MEMBER_DISCRIMINATOR = Buffer.from('64c8588f53e3a5a6', 'hex')
const GROUP_REGISTRY_DISCRIMINATOR = Buffer.from('c746ff66717a8902', 'hex')
const GROUP_REGISTRY_LEN = 8 + 1 + 1 + 32 + 4 + 4 + 32
const CHAIN_CONFIG_V2_STANDARD = 1
const CHAIN_CONFIG_V2_WITH_EXT = 2

/** Policy classes in the program's index order (`PolicyClass::index`). @internal */
export const POOL_GROUP_CLASS_ORDER = ['connection', 'fee', 'rateLimit', 'security'] as const
/** One policy class. @internal */
export type PoolGroupClass = (typeof POOL_GROUP_CLASS_ORDER)[number]

/** Where a lane reads one class from (`ClassSource`). @internal */
export type PoolGroupClassSourceByte =
  | { kind: 'inline' }
  | { kind: 'default' }
  | { kind: 'policy'; slot: 0 | 1 | 2 | 3 }

/** The lane kind a `ChainConfig` marker declares. @internal */
export type PoolGroupLaneMarker = 'standard' | 'linked' | 'driven'

/** A decoded `ChainConfigV2Ext` (the tail of a version-2 `ChainConfigV2`). @internal */
export type PoolGroupLaneExt = {
  /** The `Group` account, or `null` for a lane with only its own pool-data settings. */
  poolGroupAddress: string | null
  /** Per class, in {@link POOL_GROUP_CLASS_ORDER}. */
  classSource: Record<PoolGroupClass, PoolGroupClassSourceByte>
  /** Named policy accounts by slot; `null` for an empty slot. */
  policySlots: (string | null)[]
  pausedOutbound: boolean
  pausedInbound: boolean
  /** The lane's own format, used when `CONNECTION` is inline. */
  poolDataFormat: PoolDataFormat
  ccvEpoch: bigint
  groupDriven: boolean
  memberIndex: number
  /** Factory UID as `0x` hex, or `null`. */
  uid: string | null
  ccvPending: { outbound: string[]; inbound: string[]; epoch: bigint; activatesAt: bigint } | null
}

/** A decoded `ChainConfigV2` with its tail. @internal */
export type PoolGroupChainConfigV2 = {
  version: number
  remoteChainSelector: bigint
  mint: string
  /** `null` on version 1 (no tail). */
  ext: PoolGroupLaneExt | null
}

/** A decoded `GroupMember`. @internal */
export type PoolGroupMemberAccount = {
  version: number
  poolGroupAddress: string
  mint: string
  memberIndex: number
  laneCount: number
  rentReceiver: string
  remoteTokens: { remoteChainSelectors: bigint[]; token: Buffer; decimals: number }[]
  lanePayers: { remoteChainSelector: bigint; payer: string }[]
}

/** A decoded `GroupRegistry`. @internal */
export type PoolGroupRegistryAccount = {
  version: number
  poolGroupAddress: string
  nextMemberIndex: number
  memberCount: number
}

/** IDL-decoded `GroupChainPolicy`. @internal */
export type GroupChainPolicyAccount = IdlAccounts<BurnmintTokenPoolGroups>['groupChainPolicy']
/** IDL-decoded `PolicyChainRecord`. @internal */
export type PolicyChainRecordAccount = IdlAccounts<BurnmintTokenPoolGroups>['policyChainRecord']

/** Bounds-checked little-endian Borsh reader over one account. */
class Cursor {
  offset: number
  private readonly data: Buffer
  private readonly account: string
  constructor(data: Buffer, account: string, offset: number) {
    this.data = data
    this.account = account
    this.offset = offset
  }
  private take(n: number): Buffer {
    if (this.offset + n > this.data.length) this.fail(`truncated at byte ${this.offset}`)
    const out = this.data.subarray(this.offset, this.offset + n)
    this.offset += n
    return out
  }
  fail(reason: string): never {
    throw new CCTDataDecodeError(this.account, { context: { reason } })
  }
  u8 = () => this.take(1).readUInt8(0)
  u32 = () => this.take(4).readUInt32LE(0)
  u64 = () => this.take(8).readBigUInt64LE(0)
  i64 = () => this.take(8).readBigInt64LE(0)
  bool = (): boolean => {
    const b = this.u8()
    if (b > 1) this.fail(`invalid bool ${b} at byte ${this.offset - 1}`)
    return b === 1
  }
  pubkey = () => new PublicKey(this.take(32)).toBase58()
  bytes = (n: number) => Buffer.from(this.take(n))
  vec = <T>(item: () => T): T[] => Array.from({ length: this.u32() }, item)
  option = <T>(item: () => T): T | null => (this.bool() ? item() : null)
  /** Throws unless every byte was consumed. */
  end(): void {
    if (this.offset !== this.data.length)
      this.fail(`length ${this.data.length}, expected ${this.offset}`)
  }
}

const DEFAULT_KEY = PublicKey.default.toBase58()

const POLICY_SLOTS = [0, 1, 2, 3] as const

function classSourceOf(cursor: Cursor): PoolGroupClassSourceByte {
  const byte = cursor.u8()
  if (byte === 0) return { kind: 'inline' }
  if (byte === 1) return { kind: 'default' }
  const slot = POLICY_SLOTS[byte - 2]
  if (slot === undefined) return cursor.fail(`invalid class source ${byte}`)
  return { kind: 'policy', slot }
}

/**
 * Reads the lane kind from a `ChainConfig` account: a marker sits right after the standard length
 * (`ChainConfig::standard_len`) of a linked or group-driven lane. Like the program, any other length
 * or trailing bytes read as a standard lane.
 *
 * @param data - Raw `ChainConfig` account data.
 * @param base - The account's decoded `base`, for its remote pool lengths.
 * @returns The lane kind.
 * @internal
 */
export function decodePoolGroupLaneMarker(
  data: Buffer,
  base: { remote: { poolAddresses: readonly { address: { length: number } }[] } },
): PoolGroupLaneMarker {
  const len =
    8 +
    CHAIN_CONFIG_INIT_SPACE +
    base.remote.poolAddresses.reduce((sum, pool) => sum + 4 + pool.address.length, 0)
  if (data.length !== len + 8) return 'standard'
  const marker = data.subarray(len)
  if (marker.equals(LANE_LINKED_MARKER)) return 'linked'
  if (marker.equals(LANE_DRIVEN_MARKER)) return 'driven'
  return 'standard'
}

/**
 * Decodes a `ChainConfigV2` with its tail. Version 1 is the body alone at its exact length;
 * version 2 is the body followed by a `ChainConfigV2Ext`, also at its exact length.
 *
 * @param data - Raw `ChainConfigV2` account data.
 * @param account - Its address, for errors.
 * @returns The lane's selector, mint and tail.
 * @throws {@link CCTDataDecodeError} if the discriminator, version or length is not one the
 *   program writes
 * @internal
 */
export function decodePoolGroupChainConfigV2(
  data: Buffer,
  account: string,
): PoolGroupChainConfigV2 {
  const c = new Cursor(data, account, 0)
  if (!data.subarray(0, 8).equals(BorshAccountsDiscriminator.chainConfigV2))
    c.fail('not a ChainConfigV2 account')
  c.offset = 8
  c.u8() // bump
  const version = c.u8()
  const remoteChainSelector = c.u64()
  const mint = c.pubkey()
  c.bytes(4) // allowed_finality_config
  c.bytes(4 + 4 + 4 + 4 + 2 + 2 + 1) // token_transfer_fee_config
  c.u64() // ccv threshold_amount
  for (let i = 0; i < 4; i++) c.vec(c.pubkey)
  if (version === CHAIN_CONFIG_V2_STANDARD) {
    c.end()
    return { version, remoteChainSelector, mint, ext: null }
  }
  if (version !== CHAIN_CONFIG_V2_WITH_EXT) c.fail(`unknown ChainConfigV2 version ${version}`)
  const group = c.pubkey()
  const classSource: Record<PoolGroupClass, PoolGroupClassSourceByte> = {
    connection: classSourceOf(c),
    fee: classSourceOf(c),
    rateLimit: classSourceOf(c),
    security: classSourceOf(c),
  }
  const policySlots = Array.from({ length: 4 }, () => {
    const key = c.pubkey()
    return key === DEFAULT_KEY ? null : key
  })
  const pausedOutbound = c.bool()
  const pausedInbound = c.bool()
  const format = c.u8()
  if (format > 1) c.fail(`invalid pool data format ${format}`)
  const ccvEpoch = c.u64()
  const groupDriven = c.bool()
  const memberIndex = c.u32()
  c.bytes(27) // reserved
  const uid = c.option(() => `0x${c.bytes(32).toString('hex')}`)
  const ccvPending = c.option(() => ({
    outbound: c.vec(c.pubkey),
    inbound: c.vec(c.pubkey),
    epoch: c.u64(),
    activatesAt: c.i64(),
  }))
  c.end()
  return {
    version,
    remoteChainSelector,
    mint,
    ext: {
      poolGroupAddress: group === DEFAULT_KEY ? null : group,
      classSource,
      policySlots,
      pausedOutbound,
      pausedInbound,
      poolDataFormat: format === 1 ? 'long' : 'legacy',
      ccvEpoch,
      groupDriven,
      memberIndex,
      uid,
      ccvPending,
    },
  }
}

/**
 * Decodes a `GroupMember`. Its length must equal what was consumed (`GroupMember::space` omits
 * `lane_payers`, so it is not used).
 *
 * @param data - Raw account data.
 * @param account - Its address, for errors.
 * @returns The member.
 * @throws {@link CCTDataDecodeError} on a wrong discriminator or length
 * @internal
 */
export function decodePoolGroupMember(data: Buffer, account: string): PoolGroupMemberAccount {
  const c = new Cursor(data, account, 0)
  if (!c.bytes(8).equals(GROUP_MEMBER_DISCRIMINATOR)) c.fail('not a GroupMember account')
  const version = c.u8()
  c.u8() // bump
  const poolGroupAddress = c.pubkey()
  const mint = c.pubkey()
  const memberIndex = c.u32()
  const laneCount = c.u32()
  const rentReceiver = c.pubkey()
  const remoteTokens = c.vec(() => ({
    remoteChainSelectors: c.vec(c.u64),
    token: c.bytes(c.u32()),
    decimals: c.u8(),
  }))
  const lanePayers = c.vec(() => ({ remoteChainSelector: c.u64(), payer: c.pubkey() }))
  c.end()
  return {
    version,
    poolGroupAddress,
    mint,
    memberIndex,
    laneCount,
    rentReceiver,
    remoteTokens,
    lanePayers,
  }
}

/**
 * Decodes a `GroupRegistry` (82 bytes).
 *
 * @param data - Raw account data.
 * @param account - Its address, for errors.
 * @returns The registry.
 * @throws {@link CCTDataDecodeError} on a wrong discriminator or length
 * @internal
 */
export function decodePoolGroupRegistry(data: Buffer, account: string): PoolGroupRegistryAccount {
  const c = new Cursor(data, account, 0)
  if (data.length !== GROUP_REGISTRY_LEN)
    c.fail(`length ${data.length}, expected ${GROUP_REGISTRY_LEN}`)
  if (!c.bytes(8).equals(GROUP_REGISTRY_DISCRIMINATOR)) c.fail('not a GroupRegistry account')
  const version = c.u8()
  c.u8() // bump
  return {
    version,
    poolGroupAddress: c.pubkey(),
    nextMemberIndex: c.u32(),
    memberCount: c.u32(),
  }
}

/**
 * Decodes an IDL account of the pool-groups program, mapping coder failures to
 * `CCTDataDecodeError`.
 *
 * @param name - The IDL account name.
 * @param data - Raw account data.
 * @param account - Its address, for errors.
 * @returns The decoded account.
 * @internal
 */
export function decodePoolGroupIdlAccount<N extends keyof IdlAccounts<BurnmintTokenPoolGroups>>(
  name: N,
  data: Buffer,
  account: string,
): IdlAccounts<BurnmintTokenPoolGroups>[N] {
  try {
    return poolGroupsCoder.accounts.decode<IdlAccounts<BurnmintTokenPoolGroups>[N]>(name, data)
  } catch (err) {
    throw new CCTDataDecodeError(account, {
      cause: err instanceof Error ? err : undefined,
      context: { reason: `not a ${name} account` },
    })
  }
}

/** Account discriminators the hand decoders check. */
const BorshAccountsDiscriminator = {
  chainConfigV2: Buffer.from([63, 128, 8, 247, 39, 249, 249, 204]),
}

/**
 * Whether a chain record admits the member at `memberIndex` (`lane_mode_admits`): `Off` never,
 * `AllMembers` always, `Subset` when bit `i % 8` of byte `i / 8` of the bitmap after
 * {@link GROUP_CHAIN_POLICY_FIXED_LEN} is set.
 *
 * @param record - The decoded record.
 * @param data - The record's raw data (for the bitmap).
 * @param memberIndex - The member's index.
 * @returns Whether the member's group-driven lane is enabled.
 * @internal
 */
export function poolGroupChainAdmits(
  record: Pick<GroupChainPolicyAccount, 'laneMode'>,
  data: Buffer,
  memberIndex: number,
): boolean {
  if ('allMembers' in record.laneMode) return true
  if (!('subset' in record.laneMode)) return false
  const byte = data[GROUP_CHAIN_POLICY_FIXED_LEN + Math.floor(memberIndex / 8)]
  return byte !== undefined && ((byte >> (memberIndex % 8)) & 1) === 1
}

const seed = (s: string) => Buffer.from(s)

/**
 * PDAs of the pool-groups program beyond the standard pool ones (`deriveTokenPoolConfigPda`,
 * `deriveTokenPoolChainConfigPda`, `deriveTokenPoolChainConfigV2Pda`).
 * @internal
 */
export const poolGroupPdas = {
  groupChain: (program: PublicKey, group: PublicKey, selector: bigint) =>
    PublicKey.findProgramAddressSync(
      [seed('ccip_tokenpool_group_chain'), group.toBuffer(), toLeArray(selector, 8)],
      program,
    )[0],
  policyChain: (program: PublicKey, policy: PublicKey, selector: bigint) =>
    PublicKey.findProgramAddressSync(
      [seed('ccip_tokenpool_policy_chain'), policy.toBuffer(), toLeArray(selector, 8)],
      program,
    )[0],
  groupMember: (program: PublicKey, mint: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [seed('ccip_tokenpool_group_member'), mint.toBuffer()],
      program,
    )[0],
  groupRegistry: (program: PublicKey, group: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [seed('ccip_tokenpool_group_registry'), group.toBuffer()],
      program,
    )[0],
}
