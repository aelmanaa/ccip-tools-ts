/**
 * Multi-token pool (MTTP) detection shared by the core EVM reads and the CCT admin layer.
 *
 * @remarks Synchronous and RPC-free on purpose: core reads call it on every pool read after
 * `typeAndVersion`, so it must not add a probe. The CCT layer's exact, version-gated check is a
 * separate function built on top of this one.
 *
 * @packageDocumentation
 */

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
