/**
 * Multi-token pool (MTTP) detection shared by the core EVM reads and the CCT admin layer.
 *
 * @remarks Synchronous and RPC-free on purpose: core reads call it on every pool read after
 * `typeAndVersion`, so it must not add a probe. The CCT layer's exact, version-gated check is a
 * separate function built on top of this one.
 *
 * @packageDocumentation
 */

import type { LaneRecordType, LaneStatus } from '../chain.ts'

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
