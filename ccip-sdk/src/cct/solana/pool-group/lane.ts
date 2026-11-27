/**
 * Reads one lane of a pool-groups program the way its transfer paths resolve it
 * (`resolve_lane_policy_with`, `require_lane_not_paused`, `load_lane_group_chain`,
 * `require_named_security_current`, `require_lane_ccvs_synced`): the `ChainConfig` and its marker,
 * the `ChainConfigV2` tail, the group chain record, the named policy records the tail references and
 * the cluster clock. Shared by the remote-lane reader and the pool-group lane reads.
 *
 * Failures are values ({@link Unread}), so the guard readers can fail closed and the public reads
 * can throw `CCTDataDecodeError`. Transport errors propagate.
 *
 * @packageDocumentation
 */

import type { Buffer } from 'buffer'

import { BN } from '@coral-xyz/anchor'
import { type AccountInfo, type Connection, PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js'

const SYSVAR_PROGRAM_ID = new PublicKey('Sysvar1111111111111111111111111111111111111')

import type { RateLimiterState } from '../../../chain.ts'
import {
  type TokenPoolChainConfig,
  decodeTokenPoolChainConfig,
  deriveTokenPoolChainConfigV2Pda,
} from '../../../solana/token-pool.ts'
import { convertRateLimiter } from '../../../solana/utils.ts'
import { CCTDataDecodeError } from '../../errors.ts'
import type { PoolDataFormat } from '../../multi-token-pool.ts'
import { deriveTokenPoolChainConfigPda } from '../programs/token-pool.ts'
import {
  type GroupChainPolicyAccount,
  type PolicyChainRecordAccount,
  type PoolGroupChainConfigV2,
  type PoolGroupClass,
  type PoolGroupLaneExt,
  type PoolGroupLaneMarker,
  POOL_GROUP_MAX_ACCOUNT_VERSION,
  chainConfigStandardLen,
  decodePoolGroupChainConfigV2,
  decodePoolGroupIdlAccount,
  decodePoolGroupLaneMarker,
  poolGroupChainAdmits,
  poolGroupPdas,
} from './accounts.ts'
import { POOL_GROUP_POLICY_CLASSES } from './types.ts'

/** A fact that could not be read: absent, or not as the program writes it. @internal */
export type Unread = { status: 'missing' | 'unknown'; reason: string }
/** An `'unknown'` fact. @internal */
export const unknown = (reason: string): Unread => ({ status: 'unknown', reason })
/** A `'missing'` fact. @internal */
export const missing = (reason: string): Unread => ({ status: 'missing', reason })
/** Whether `v` is an {@link Unread}. @internal */
export const isUnread = (v: unknown): v is Unread =>
  typeof v === 'object' && v !== null && 'status' in v && 'reason' in v

/**
 * The cluster's unix time from the Clock sysvar account (slot, epoch_start_timestamp, epoch,
 * leader_schedule_epoch, then unix_timestamp at offset 32).
 * @internal
 */
export function clockUnixTimestamp(clock: AccountInfo<Buffer> | null | undefined): bigint | Unread {
  if (!clock?.owner.equals(SYSVAR_PROGRAM_ID) || clock.data.length < 40)
    return unknown('the cluster clock cannot be read')
  return clock.data.readBigInt64LE(32)
}

/** Runs a decoder, turning a decode failure into an `'unknown'` reason. @internal */
export function tryDecode<T>(what: string, decode: () => T): T | Unread {
  try {
    return decode()
  } catch (err) {
    const reason = err instanceof CCTDataDecodeError ? err.context.reason : undefined
    const why =
      typeof reason === 'string' ? reason : err instanceof Error ? err.message : String(err)
    return unknown(`${what} cannot be decoded: ${why}`)
  }
}

/** IDL-decoded `PolicySections`. @internal */
export type IdlPolicySections = PolicyChainRecordAccount['sections']

/** A named policy record a lane references. @internal */
export type NamedRecord = {
  /** The `PolicyChainRecord`. */
  address: PublicKey
  /** Its `Policy`. */
  policy: PublicKey
  /** The decoded record. */
  record: PolicyChainRecordAccount
}

/** One lane as its transfer paths see it. @internal */
export type PoolGroupLaneState = {
  program: PublicKey
  mint: PublicKey
  selector: bigint
  chainConfig: { address: PublicKey; data: Buffer; base: TokenPoolChainConfig }
  kind: PoolGroupLaneMarker
  /** The lane's `ChainConfigV2`, when it exists and decodes with the pool-groups layout. */
  v2: { address: PublicKey; lane: PoolGroupChainConfigV2 } | null
  /** The tail; `null` on a standard lane. */
  ext: PoolGroupLaneExt | null
  /** The group chain record, on a lane linked to a group. */
  groupChain?: { address: PublicKey; data: Buffer; record: GroupChainPolicyAccount }
  /** Named records by slot, for every slot the tail's class sources use. */
  named: Map<number, NamedRecord>
  /** Cluster unix time, read with the records of a linked lane. */
  now?: bigint
}

function owned(
  acc: AccountInfo<Buffer> | null | undefined,
  address: PublicKey,
  program: PublicKey,
  what: string,
): AccountInfo<Buffer> | Unread {
  if (!acc) return unknown(`the lane's ${what} ${address.toBase58()} does not exist`)
  if (!acc.owner.equals(program))
    return unknown(`the lane's ${what} ${address.toBase58()} is not owned by the pool program`)
  return acc
}

/**
 * Decodes a `ChainConfig` as the standard burn-mint layout at its exact length (or with a marker),
 * else as the versioned CCTP/Lombard layout (one leading version byte, never marked). Anchor ignores
 * trailing bytes, so the length is what tells the layouts apart.
 */
function decodeChainConfig(data: Buffer, address: PublicKey): TokenPoolChainConfig | Unread {
  const what = `the ChainConfig ${address.toBase58()}`
  const standard = tryDecode(what, () => decodeTokenPoolChainConfig(data, 'burn-mint'))
  if (!isUnread(standard)) {
    const len = chainConfigStandardLen(standard)
    if (data.length === len || data.length === len + 8) return standard
  }
  const versioned = tryDecode(what, () => decodeTokenPoolChainConfig(data, 'cctp'))
  if (!isUnread(versioned) && data.length === chainConfigStandardLen(versioned) + 1)
    return versioned
  return isUnread(standard)
    ? standard
    : unknown(`${what} has length ${data.length}, which no pool layout writes`)
}

/**
 * Decodes a lane's `ChainConfig` and `ChainConfigV2` (already read) into its base state, before
 * the group records: the marker, the tail and their agreement.
 *
 * @returns The lane, `null` when it has no `ChainConfig`, or why it cannot be read.
 * @internal
 */
export function decodePoolGroupLaneBase(
  program: PublicKey,
  mint: PublicKey,
  selector: bigint,
  cc: AccountInfo<Buffer> | null | undefined,
  v2: AccountInfo<Buffer> | null | undefined,
): PoolGroupLaneState | null | Unread {
  const ccAddress = deriveTokenPoolChainConfigPda(program, selector, mint)
  const v2Address = deriveTokenPoolChainConfigV2Pda(program, selector, mint)
  if (!cc) return null
  for (const [acc, addr] of [
    [cc, ccAddress],
    [v2, v2Address],
  ] as const)
    if (acc && !acc.owner.equals(program))
      return unknown(`lane account ${addr.toBase58()} is not owned by the pool program`)
  const base = decodeChainConfig(cc.data, ccAddress)
  if (isUnread(base)) return base
  const kind = decodePoolGroupLaneMarker(cc.data, base)
  // An unmarked lane's ChainConfigV2 may be any pool's layout (Lombard swaps version and bump):
  // only a pool-groups version-2 tail there is a disagreement. A marked lane's must decode.
  const decoded = v2
    ? tryDecode(`the ChainConfigV2 ${v2Address.toBase58()}`, () =>
        decodePoolGroupChainConfigV2(v2.data, v2Address.toBase58()),
      )
    : null
  if (kind !== 'standard' && isUnread(decoded)) return decoded
  const lane = isUnread(decoded) ? null : decoded
  const ext = lane?.ext ?? null
  // the program requires the two records to agree (`require_link_marker_matches`)
  if ((kind !== 'standard') !== (ext !== null))
    return unknown(
      `the lane's ChainConfig marker (${kind}) and its ChainConfigV2 ${ext ? 'tail' : 'lack of a tail'} disagree`,
    )
  if (lane && (lane.mint !== mint.toBase58() || lane.remoteChainSelector !== selector))
    return unknown(`the ChainConfigV2 ${v2Address.toBase58()} names another mint or chain`)
  if (ext && (kind === 'driven') !== ext.groupDriven)
    return unknown(`the lane's ChainConfig marker (${kind}) and its group_driven flag disagree`)
  if (ext?.groupDriven && !ext.poolGroupAddress)
    return unknown('the lane is group-driven but names no pool group')
  const state: PoolGroupLaneState = {
    program,
    mint,
    selector,
    chainConfig: { address: ccAddress, data: cc.data, base },
    kind,
    v2: lane && { address: v2Address, lane },
    ext,
    named: new Map(),
  }
  return state
}

/** The group records a linked lane reads: its group chain record and named records by slot. */
type LaneRecordKeys = {
  group: PublicKey
  gcpAddress: PublicKey
  entries: { slot: number; policy: PublicKey; address: PublicKey }[]
}

/**
 * The accounts a lane's transfers read beyond its own: its group chain record and the named
 * records its class sources use. `null` for a lane not linked to a group.
 * @internal
 */
export function poolGroupLaneRecordKeys(state: PoolGroupLaneState): LaneRecordKeys | null | Unread {
  const { ext, program, selector } = state
  if (!ext?.poolGroupAddress) return null
  const group = new PublicKey(ext.poolGroupAddress)
  const gcpAddress = poolGroupPdas.groupChain(program, group, selector)
  const slots = new Map<number, PublicKey>()
  for (const cls of POOL_GROUP_POLICY_CLASSES) {
    const source = ext.classSource[cls]
    if (source.kind !== 'policy') continue
    const policy = ext.policySlots[source.slot]
    if (!policy)
      return unknown(`the lane takes ${cls} from policy slot ${source.slot}, which is empty`)
    slots.set(source.slot, new PublicKey(policy))
  }
  const entries = [...slots.entries()].map(([slot, policy]) => ({
    slot,
    policy,
    address: poolGroupPdas.policyChain(program, policy, selector),
  }))
  return { group, gcpAddress, entries }
}

/**
 * Attaches a linked lane's group records (read with the cluster clock) to its base state, checking
 * each record's owner, PDA, group, chain and version.
 * @param accounts - The accounts read, by base58 address; must hold every key of
 *   {@link poolGroupLaneRecordKeys}.
 * @internal
 */
export function attachPoolGroupLaneRecords(
  state: PoolGroupLaneState,
  keys: LaneRecordKeys,
  accounts: ReadonlyMap<string, AccountInfo<Buffer> | null>,
  now: bigint,
): PoolGroupLaneState | Unread {
  const { program, selector } = state
  const { group, gcpAddress, entries } = keys
  state.now = now
  const gcpInfo = accounts.get(gcpAddress.toBase58())
  const namedInfos = entries.map((e) => accounts.get(e.address.toBase58()))
  const gcpAccount = owned(gcpInfo, gcpAddress, program, 'group chain record')
  if (isUnread(gcpAccount)) return gcpAccount
  const record = tryDecode(`the group chain record ${gcpAddress.toBase58()}`, () =>
    decodePoolGroupIdlAccount('groupChainPolicy', gcpAccount.data, gcpAddress.toBase58()),
  )
  if (isUnread(record)) return record
  if (!record.group.equals(group) || BigInt(record.remoteChainSelector.toString()) !== selector)
    return unknown(`the group chain record ${gcpAddress.toBase58()} is not the lane's`)
  if (record.version > POOL_GROUP_MAX_ACCOUNT_VERSION)
    return unknown(`the group chain record has version ${record.version}, newer than this SDK`)
  state.groupChain = { address: gcpAddress, data: gcpAccount.data, record }

  for (const [i, { slot, policy, address }] of entries.entries()) {
    const acc = owned(namedInfos[i], address, program, `policy slot ${slot} chain record`)
    if (isUnread(acc)) return acc
    const named = tryDecode(`the policy chain record ${address.toBase58()}`, () =>
      decodePoolGroupIdlAccount('policyChainRecord', acc.data, address.toBase58()),
    )
    if (isUnread(named)) return named
    if (
      !named.group.equals(group) ||
      !named.policy.equals(policy) ||
      BigInt(named.remoteChainSelector.toString()) !== selector
    )
      return unknown(`the policy chain record ${address.toBase58()} is not the lane's`)
    if (named.version > POOL_GROUP_MAX_ACCOUNT_VERSION)
      return unknown(`the policy chain record has version ${named.version}, newer than this SDK`)
    state.named.set(slot, { address, policy, record: named })
  }
  return state
}

/**
 * Reads the lane of `program` for (`mint`, `selector`): its `ChainConfig` and `ChainConfigV2`, then,
 * on a linked lane, its group records with the cluster clock.
 *
 * @returns The lane, `null` when it has no `ChainConfig`, or why it cannot be read.
 * @internal
 */
export async function readPoolGroupLaneState(
  connection: Connection,
  program: PublicKey,
  mint: PublicKey,
  selector: bigint,
): Promise<PoolGroupLaneState | null | Unread> {
  const [cc, v2] = await connection.getMultipleAccountsInfo([
    deriveTokenPoolChainConfigPda(program, selector, mint),
    deriveTokenPoolChainConfigV2Pda(program, selector, mint),
  ])
  const state = decodePoolGroupLaneBase(program, mint, selector, cc, v2)
  if (state === null || isUnread(state)) return state
  const keys = poolGroupLaneRecordKeys(state)
  if (keys === null || isUnread(keys)) return keys ?? state
  const addresses = [keys.gcpAddress, ...keys.entries.map((e) => e.address)]
  const [clock, ...infos] = await connection.getMultipleAccountsInfo([
    SYSVAR_CLOCK_PUBKEY,
    ...addresses,
  ])
  const now = clockUnixTimestamp(clock)
  if (isUnread(now)) return now
  return attachPoolGroupLaneRecords(
    state,
    keys,
    new Map(addresses.map((a, i) => [a.toBase58(), infos[i] ?? null])),
    now,
  )
}

const CLASS_BIT: Record<PoolGroupClass, number> = {
  connection: 1,
  fee: 2,
  rateLimit: 4,
  security: 8,
}

/**
 * The record a lane takes `cls` from: `undefined` when inline (or not linked), else the sections of
 * the group chain record or the named record (which must carry the class).
 * @internal
 */
export function laneSectionsFor(
  state: PoolGroupLaneState,
  cls: PoolGroupClass,
): IdlPolicySections | undefined | Unread {
  const source = state.ext?.poolGroupAddress ? state.ext.classSource[cls] : undefined
  if (!source || source.kind === 'inline') return undefined
  if (source.kind === 'default') return state.groupChain?.record.policy
  const record = state.named.get(source.slot)
  if (!record || (record.record.classes & CLASS_BIT[cls]) === 0)
    return unknown(`the policy record in slot ${source.slot} does not carry ${cls}`)
  return record.record.sections
}

/** The format a lane sends (effective CONNECTION); a lane with a UID always sends long. @internal */
export function laneFormat(state: PoolGroupLaneState): PoolDataFormat | Unread {
  const connection = laneSectionsFor(state, 'connection')
  if (isUnread(connection)) return connection
  if (connection) return 'long' in connection.connection.poolDataFormat ? 'long' : 'legacy'
  return state.ext?.poolDataFormat ?? 'legacy'
}

/**
 * Pauses as transfers see them: on a linked lane the group, its chain record and the lane; on a
 * driven lane also `driven_lanes_paused` and a chain record that does not admit the member
 * (`GroupLaneNotEnabled` blocks both directions). An unlinked lane has none.
 * @internal
 */
export function lanePauses(state: PoolGroupLaneState): {
  pausedOutbound: boolean
  pausedInbound: boolean
  admitted?: boolean
} {
  const { ext, groupChain } = state
  if (!ext?.poolGroupAddress || !groupChain) return { pausedOutbound: false, pausedInbound: false }
  const gcp = groupChain.record
  if (state.kind !== 'driven')
    return {
      pausedOutbound: gcp.groupPaused || gcp.pausedOutbound || ext.pausedOutbound,
      pausedInbound: gcp.groupPaused || gcp.pausedInbound || ext.pausedInbound,
    }
  const admitted = poolGroupChainAdmits(gcp, groupChain.data, ext.memberIndex)
  const blocked = gcp.drivenLanesPaused || !admitted
  return {
    pausedOutbound: gcp.groupPaused || gcp.pausedOutbound || ext.pausedOutbound || blocked,
    pausedInbound: gcp.groupPaused || gcp.pausedInbound || ext.pausedInbound || blocked,
    admitted,
  }
}

/**
 * The lane's outbound bucket as transfers consume it: the stored bucket under the stored config, or,
 * with RATE_LIMIT from a policy record, under that record's config (`consume_under`, which caps the
 * stored tokens at the record's capacity without refilling).
 * @internal
 */
export function laneOutboundRateLimiter(state: PoolGroupLaneState): RateLimiterState | Unread {
  const stored = state.chainConfig.base.outboundRateLimit
  const rateLimit = laneSectionsFor(state, 'rateLimit')
  if (isUnread(rateLimit)) return rateLimit
  if (!rateLimit) return convertRateLimiter(stored)
  const cfg = rateLimit.rateLimit.outbound
  const tokens = BigInt(stored.tokens.toString())
  const capacity = BigInt(cfg.capacity.toString())
  return convertRateLimiter({
    tokens: new BN((tokens < capacity ? tokens : capacity).toString()),
    lastUpdated: stored.lastUpdated,
    cfg,
  })
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i])
const keys = (ks: readonly PublicKey[]) => ks.map((k) => k.toBase58())

/**
 * The lane's CCV copy against its SECURITY record at the cluster clock
 * (`require_lane_ccvs_synced`): `null` when SECURITY is inline or the lane is unlinked. `synced` is
 * whether transfers enforce the same set now; `failsClosedAt` is the earliest time from which they
 * will not, until the lane syncs: the activation of a pending set of the record that the lane has
 * not copied, or of a pending set the lane copied that the record no longer schedules (cancelled by
 * `reset_security` on an ownership accept, or replaced): at its `activates_at` the lane switches to
 * its copy (`lane_ccvs_at`, groups.rs:728-741) while the record keeps its set.
 * @internal
 */
export function laneCcvSync(
  state: PoolGroupLaneState,
): { epoch: bigint; synced: boolean; failsClosedAt?: bigint } | null | Unread {
  const sections = laneSectionsFor(state, 'security')
  if (isUnread(sections)) return sections
  const { ext, v2, now } = state
  if (!sections || !ext || now === undefined) return null
  if (!v2) return unknown('the lane takes SECURITY from a policy but has no ChainConfigV2')
  const { security } = sections
  const pendingActive = ext.ccvPending && now >= ext.ccvPending.activatesAt
  const copy =
    pendingActive && ext.ccvPending ? ext.ccvPending : { ...v2.lane.ccvs, epoch: ext.ccvEpoch }
  const recordPending = security.pending
  const recordActive =
    recordPending && now >= BigInt(recordPending.activatesAt.toString())
      ? recordPending
      : security.current
  const synced =
    sameList(copy.outbound, keys(recordActive.outbound)) &&
    sameList(copy.inbound, keys(recordActive.inbound))
  const upcoming =
    recordPending && now < BigInt(recordPending.activatesAt.toString()) ? recordPending : null
  const copied =
    upcoming &&
    ext.ccvPending &&
    ext.ccvPending.activatesAt === BigInt(upcoming.activatesAt.toString()) &&
    sameList(ext.ccvPending.outbound, keys(upcoming.outbound)) &&
    sameList(ext.ccvPending.inbound, keys(upcoming.inbound))
  // the lane's own pending copy, still to come, that the record no longer schedules
  const orphaned =
    ext.ccvPending && now < ext.ccvPending.activatesAt && !copied
      ? ext.ccvPending.activatesAt
      : undefined
  const recordAt = upcoming && !copied ? BigInt(upcoming.activatesAt.toString()) : undefined
  const at =
    orphaned !== undefined && recordAt !== undefined
      ? orphaned < recordAt
        ? orphaned
        : recordAt
      : (orphaned ?? recordAt)
  return { epoch: copy.epoch, synced, ...(at !== undefined && { failsClosedAt: at }) }
}

/** A direction of a lane's transfers. @internal */
export type LaneDirection = 'outbound' | 'inbound'

const BOTH: readonly LaneDirection[] = ['outbound', 'inbound']

/** Why a lane that is not paused reverts transfers, and in which directions. @internal */
export type LaneFailsClosed = {
  /** The program error transfers hit. */
  code: 'BpsFeeAboveGroupMax' | 'PolicySecurityStale' | 'GroupCcvsNotSynced'
  /** The code with the values that cause it. */
  reason: string
  /** The directions that revert. */
  directions: readonly LaneDirection[]
}

/**
 * Why every transfer on the lane reverts although it is not paused, if it does: SECURITY from a
 * named record of an older security generation than the group's (`PolicySecurityStale`), a CCV
 * copy out of step with its record (`GroupCcvsNotSynced`), or FEE from a policy whose BPS fee is
 * above the cap the chain record mirrors (`BpsFeeAboveGroupMax`, `resolve_lane_policy_with`,
 * chainlink-ccip-solana 7558722 `base-token-pool/src/groups.rs:903-911`: a cap lowered after the
 * fee was written applies at once). The fee rule blocks sends only: FEE is resolved on the send path
 * alone (`SEND_CLASSES` has it, `RECEIVE_CLASSES` does not, groups.rs:72-83). The SECURITY reasons
 * block both directions.
 * @internal
 */
export function laneFailsClosed(state: PoolGroupLaneState): LaneFailsClosed | undefined | Unread {
  const fee = laneSectionsFor(state, 'fee')
  if (isUnread(fee)) return fee
  const gcp = state.groupChain?.record
  if (fee && gcp?.maxBpsFeeSet) {
    const { finalityBpsFee, fastFinalityBpsFee } = fee.fee.tokenTransferFeeConfig
    const bps = Math.max(finalityBpsFee, fastFinalityBpsFee)
    if (bps > gcp.maxBpsFee)
      return {
        code: 'BpsFeeAboveGroupMax',
        reason: `BpsFeeAboveGroupMax: the lane's FEE policy charges ${bps} bps, above the pool group's cap of ${gcp.maxBpsFee} bps`,
        directions: ['outbound'],
      }
  }
  const source = state.ext?.poolGroupAddress ? state.ext.classSource.security : undefined
  if (source?.kind === 'policy') {
    const record = state.named.get(source.slot)
    const group = state.groupChain?.record.securityGeneration
    if (record && group !== undefined && record.record.securityGeneration !== group)
      return {
        code: 'PolicySecurityStale',
        reason: `PolicySecurityStale: the SECURITY record is of security generation ${record.record.securityGeneration}, the pool group's is ${group}`,
        directions: BOTH,
      }
  }
  const sync = laneCcvSync(state)
  if (isUnread(sync)) return sync
  if (sync && !sync.synced)
    return {
      code: 'GroupCcvsNotSynced',
      reason: "GroupCcvsNotSynced: the lane's CCV copy differs from its SECURITY record",
      directions: BOTH,
    }
  return undefined
}

/** The finding code, record type and fix of a {@link laneFailsClosed} code. @internal */
export function laneFailsClosedFinding(code: LaneFailsClosed['code']): {
  check: 'TRANSFER_FEE_ABOVE_CAP' | 'CCVS_NOT_SYNCED'
  recordType: 'fee' | 'security'
  fix: string
} {
  return code === 'BpsFeeAboveGroupMax'
    ? {
        check: 'TRANSFER_FEE_ABOVE_CAP',
        recordType: 'fee',
        fix: "lower the FEE policy's BPS fees to the cap",
      }
    : { check: 'CCVS_NOT_SYNCED', recordType: 'security', fix: 'sync the lane' }
}
