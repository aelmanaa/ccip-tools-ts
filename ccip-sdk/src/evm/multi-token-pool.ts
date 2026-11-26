/**
 * Multi-token pool (MTTP) detection and the PoolConfigManager view-struct decoders, shared by the core
 * EVM reads and the CCT admin layer.
 *
 * @remarks Synchronous and RPC-free on purpose: core reads call it on every pool read after
 * `typeAndVersion`, so it must not add a probe. The CCT layer's exact, version-gated check is a
 * separate function built on top of this one.
 *
 * @packageDocumentation
 */

import { ZeroAddress, getAddress } from 'ethers'

import type { LaneRecordType, LaneStatus } from '../chain.ts'
import { type FinalityAllowed, decodeFinalityAllowed } from '../extra-args.ts'

/**
 * Whether a pool type serves multiple tokens and keeps their configuration in a PoolConfigManager
 * (e.g. `BurnMintMultiTokenPool`); these pools need the local token for every config read.
 *
 * @param type - The normalized contract type from `typeAndVersion`.
 * @internal
 */
export function isMultiTokenPoolType(type: string): boolean {
  return type.includes('MultiTokenPool')
}

/**
 * The PCM `LockOrBurnFlavor` enum, kebab-cased like the SDK's other string enums, in enum order
 * (index = on-chain value). `BurnMintMultiTokenPool` serves every flavor but `'lock'`. Shared by
 * the core reads (which find a token's lock box) and the CCT layer.
 */
export const LOCK_OR_BURN_FLAVORS = [
  'burn',
  'burn-from',
  'burn-with-from',
  'burn-to-address',
  'lock',
] as const
/** One lock-or-burn flavor. */
export type LockOrBurnFlavor = (typeof LOCK_OR_BURN_FLAVORS)[number]

/**
 * `IPoolConfigManager.LockOrBurnFlavor.Lock`: the pool locks the token on send, in its lock box.
 * @internal
 */
export const MULTI_TOKEN_POOL_LOCK_FLAVOR = LOCK_OR_BURN_FLAVORS.indexOf('lock')

/**
 * The record types of `PoolConfigManager.getLaneRecordLevelBatch`, in the order of its outputs;
 * a lane level of 0 (`RecordLevel.None`) means the record is missing.
 * @internal
 */
export const LANE_RECORD_TYPES = [
  'connection',
  'remotePool',
  'rateLimit',
  'fee',
  'destOverhead',
  'security',
] as const satisfies readonly LaneRecordType[]
// every LaneRecordType is listed: a new one fails to compile here instead of reading as missing
const _ALL_LANE_RECORD_TYPES: Exclude<
  LaneRecordType,
  (typeof LANE_RECORD_TYPES)[number]
> extends never
  ? true
  : never = true
void _ALL_LANE_RECORD_TYPES
/** Record types that an inbound transfer does not need. */
const OUTBOUND_ONLY_RECORD_TYPES: ReadonlySet<LaneRecordType> = new Set(['fee', 'destOverhead'])

/** Pause flags of a `PoolConfigManager.LaneConnection`. @internal */
export type LanePauseFlags = {
  isGloballyPaused: boolean
  isTokenOutboundPaused: boolean
  isTokenInboundPaused: boolean
  isChainOutboundPaused: boolean
  isChainInboundPaused: boolean
}

/**
 * The {@link LaneStatus} of a multi-token pool lane in one direction: the broadest pause first
 * (global, then chain, then token), then the records that a transfer in that direction needs.
 * @param pauses - The lane's pause flags from `getLaneConnectionBatch`.
 * @param recordLevels - The lane's `RecordLevel` per {@link LANE_RECORD_TYPES} entry.
 * @param direction - The transfer direction.
 * @internal
 */
export function toMultiTokenLaneStatus(
  pauses: LanePauseFlags,
  recordLevels: readonly bigint[],
  direction: 'outbound' | 'inbound',
): LaneStatus {
  const outbound = direction === 'outbound'
  if (pauses.isGloballyPaused) return { status: 'paused', scope: 'global', direction }
  if (outbound ? pauses.isChainOutboundPaused : pauses.isChainInboundPaused)
    return { status: 'paused', scope: 'chain', direction }
  if (outbound ? pauses.isTokenOutboundPaused : pauses.isTokenInboundPaused)
    return { status: 'paused', scope: 'token', direction }
  const missing = LANE_RECORD_TYPES.filter(
    (type, i) => !recordLevels[i] && (outbound || !OUTBOUND_ONLY_RECORD_TYPES.has(type)),
  )
  return missing.length ? { status: 'incomplete', missing } : { status: 'ok' }
}

// ─── PoolConfigManager view structs ─────────────────────────────────────────────────────────
// One raw decoder per struct, for both layers. Each caller keeps its own policy on top: core throws
// on a lane without a remote token and decodes addresses for the remote family; the CCT layer
// returns `null` and falls back to hex for a family it cannot decode.

/** Whether ABI-encoded bytes or an address are empty or all zero. @internal */
export function isZeroHex(value: string): boolean {
  return /^(0x)?0*$/.test(value)
}

/** `address(0)` in an optional address field reads as `null`. @internal */
export function nullableAddress(value: string): string | null {
  const a = getAddress(value)
  return a === ZeroAddress ? null : a
}

/** A decoded `IPoolConfigManager.LaneConnection`, its addresses decoded by the caller. @internal */
export type DecodedLaneConnection = LanePauseFlags & {
  /** Whether a connection record resolves. */
  hasConnection: boolean
  /** Any pause in the outbound direction. */
  isOutboundPaused: boolean
  /** Any pause in the inbound direction. */
  isInboundPaused: boolean
  /** `'legacy'` when the lane sends 32-byte pool data (`useLegacyPoolDataOnSend`). */
  poolDataFormat: 'legacy' | 'long'
  /** The remote token, or `null` when empty or all zero. */
  remoteToken: string | null
  /** Trusted remote pools; empty or all-zero entries are dropped. */
  remotePools: {
    /** The remote pool. */
    address: string
    /** Whether it may send legacy pool data. */
    allowLegacyPoolData: boolean
  }[]
}

/**
 * Decodes a `LaneConnection` struct (as `resultToObject` returns it).
 * @param raw - The struct.
 * @param decodeAddress - Decodes a non-zero remote address from its stored bytes.
 * @internal
 */
export function decodeLaneConnection(
  raw: LanePauseFlags & {
    hasConnection: boolean
    isOutboundPaused: boolean
    isInboundPaused: boolean
    useLegacyPoolDataOnSend: boolean
    remoteToken: string
    remotePools: readonly { remotePoolAddress: string; allowLegacyPoolDataOnReceive: boolean }[]
  },
  decodeAddress: (bytes: string) => string,
): DecodedLaneConnection {
  return {
    hasConnection: raw.hasConnection,
    isOutboundPaused: raw.isOutboundPaused,
    isInboundPaused: raw.isInboundPaused,
    isGloballyPaused: raw.isGloballyPaused,
    isTokenOutboundPaused: raw.isTokenOutboundPaused,
    isTokenInboundPaused: raw.isTokenInboundPaused,
    isChainOutboundPaused: raw.isChainOutboundPaused,
    isChainInboundPaused: raw.isChainInboundPaused,
    poolDataFormat: raw.useLegacyPoolDataOnSend ? 'legacy' : 'long',
    remoteToken: isZeroHex(raw.remoteToken) ? null : decodeAddress(raw.remoteToken),
    remotePools: decodeRemotePools(raw.remotePools, decodeAddress),
  }
}

/**
 * Decodes a `RemotePool[]` (a lane connection's or a remote pool record's): empty or all-zero entries
 * are dropped, `allowLegacyPoolDataOnReceive` becomes `allowLegacyPoolData`.
 * @internal
 */
export function decodeRemotePools(
  raw: readonly { remotePoolAddress: string; allowLegacyPoolDataOnReceive: boolean }[],
  decodeAddress: (bytes: string) => string,
): DecodedLaneConnection['remotePools'] {
  return raw
    .filter((p) => !isZeroHex(p.remotePoolAddress))
    .map((p) => ({
      address: decodeAddress(p.remotePoolAddress),
      allowLegacyPoolData: p.allowLegacyPoolDataOnReceive,
    }))
}

/** The registry and stores of a PCM's `getStaticConfig`. @internal */
export type PoolConfigManagerStores = {
  /** The TokenAdminRegistry. */
  tokenAdminRegistry: string
  /** The ConnectionPolicyStore. */
  connectionPolicyStore: string
  /** The FeePolicyStore. */
  feePolicyStore: string
  /** The SecurityPolicyStore. */
  securityPolicyStore: string
}

/** Decodes the four outputs of `PoolConfigManager.getStaticConfig`. @internal */
export function decodePoolConfigManagerStaticConfig([tar, cps, fps, sps]: readonly [
  unknown,
  unknown,
  unknown,
  unknown,
]): PoolConfigManagerStores {
  return {
    tokenAdminRegistry: getAddress(String(tar)),
    connectionPolicyStore: getAddress(String(cps)),
    feePolicyStore: getAddress(String(fps)),
    securityPolicyStore: getAddress(String(sps)),
  }
}

/** The token-profile fields of a `TokenConfig` or `TokenProfile`, the flavor left raw. @internal */
export type DecodedTokenProfile = {
  /** Decimals the pool uses for the token. */
  localDecimals: number
  /** The `LockOrBurnFlavor` value (index into {@link LOCK_OR_BURN_FLAVORS}). */
  lockOrBurnFlavor: number
  /** Faster-than-finality the token allows. */
  allowedFinality: FinalityAllowed
  /** Burn sink or lock box, or `null`. */
  lockOrBurnAddress: string | null
  /** Additional pool data provider, or `null`. */
  additionalPoolDataProvider: string | null
}

/** Decodes the profile fields of a `TokenConfig` or `TokenProfile` struct. @internal */
export function decodeTokenProfileFields(raw: {
  localDecimals: bigint | number
  lockOrBurnFlavor: bigint | number
  allowedFinalityConfig: string
  lockOrBurnAddress: string
  additionalPoolDataProvider: string
}): DecodedTokenProfile {
  return {
    localDecimals: Number(raw.localDecimals),
    lockOrBurnFlavor: Number(raw.lockOrBurnFlavor),
    allowedFinality: decodeFinalityAllowed(raw.allowedFinalityConfig),
    lockOrBurnAddress: nullableAddress(raw.lockOrBurnAddress),
    additionalPoolDataProvider: nullableAddress(raw.additionalPoolDataProvider),
  }
}
