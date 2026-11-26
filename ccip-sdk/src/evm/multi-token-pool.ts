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
