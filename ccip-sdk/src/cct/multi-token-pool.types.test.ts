/**
 * Compile-time checks of the shared multi-token pool types (X0): the family-neutral rate limit, the
 * family extension blocks, and the literal `family` of each manager. A regression fails `tsc`.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { EVMTokenManager } from './evm/index.ts'
import type { MultiTokenPoolRateLimits as EVMRecordsRateLimits } from './evm/pool-config-manager/records.ts'
import type { RateLimitConfig as EVMRateLimitConfig } from './evm/token-pool/rate-limit.ts'
import type { MultiTokenPoolFamilyExtension, MultiTokenPoolRateLimits } from './multi-token-pool.ts'
import type { RateLimitConfig } from './rate-limit.ts'
import type { SolanaTokenManager } from './solana/index.ts'
import type { RateLimitConfig as SolanaRateLimitConfig } from './solana/token-pool/operations/set-chain-rate-limit.ts'

/** `true` only when A and B are each assignable to the other. */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
const assertType = <T extends true>(_: T) => undefined

describe('shared multi-token pool types (compile time)', () => {
  it('makes both family RateLimitConfig types the neutral one', () => {
    assertType<MutuallyAssignable<EVMRateLimitConfig, RateLimitConfig>>(true)
    assertType<MutuallyAssignable<SolanaRateLimitConfig, RateLimitConfig>>(true)
    // the EVM records path still exports the moved shape
    assertType<MutuallyAssignable<EVMRecordsRateLimits, MultiTokenPoolRateLimits>>(true)
    assert.ok(true)
  })

  it('types each manager family as a literal', () => {
    assertType<MutuallyAssignable<EVMTokenManager['family'], 'EVM'>>(true)
    assertType<MutuallyAssignable<SolanaTokenManager['family'], 'SVM'>>(true)
    assert.ok(true)
  })

  it("keeps one family's block out of the other family's input", () => {
    type EVMInput = MultiTokenPoolFamilyExtension<'evm', { chunkSize?: number }>
    type EVMRequired = MultiTokenPoolFamilyExtension<'evm', { rateLimitDecimals: number }>
    const optional: EVMInput = {}
    const withBlock: EVMInput = { evm: { chunkSize: 2 } }
    const required: EVMRequired = { evm: { rateLimitDecimals: 18 } }
    // @ts-expect-error: a required family block cannot be omitted
    const missing: EVMRequired = {}
    // @ts-expect-error: the other family's block is refused
    const crossed: EVMInput = { solana: { chunkSize: 2 } }
    assert.deepEqual([optional, withBlock, required, missing, crossed].length, 5)
  })
})
