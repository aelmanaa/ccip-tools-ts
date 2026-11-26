/**
 * The family-neutral rate-limit shape CCT callers write, shared by the EVM and Solana managers.
 *
 * @remarks Types only. Each family's `RateLimitConfig` is an alias of {@link RateLimitConfig}, so
 * cross-family code writes one shape; each family's parser keeps its own bound (EVM `uint128`,
 * Solana `u64`) and its version rules, so a value valid on one family can still be refused on the
 * other, with a dotted param path.
 *
 * @packageDocumentation
 */

/**
 * Configuration for one direction of a rate limiter, as CCT callers write it.
 *
 * @remarks The discriminant is spelled `enabled` (the EVM ABI says `isEnabled`; the ops re-key it).
 * Distinct from the read-side `RateLimiterState`, which also carries the live `tokens` balance: that
 * is what a pool reports, this is what a caller sets. Amounts are in local token units: for a token
 * with 6 decimals, `1_000_000n` is one token.
 */
export type RateLimitConfig =
  | {
      /** Whether this directional rate limit is enforced. */
      enabled: true
      /** Maximum token amount in the bucket, at least `rate`. */
      capacity: bigint
      /** Token amount restored to the bucket per second, no greater than `capacity`. */
      rate: bigint
    }
  | {
      /** Whether this directional rate limit is enforced. */
      enabled: false
      /** Must be zero when provided; defaults to zero. */
      capacity?: bigint
      /** Must be zero when provided; defaults to zero. */
      rate?: bigint
    }
