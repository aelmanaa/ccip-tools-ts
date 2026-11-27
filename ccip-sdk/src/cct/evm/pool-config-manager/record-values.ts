/**
 * The record values of the rate limit, fee, destination overhead and security writes: validated
 * before any RPC, as the stores validate them (chainlink-ccip c950d9bc `SecurityPolicyStore`
 * `_isValidRateLimitConfig`, `_validateSecurityConfig`; `FeePolicyStore` `_isValidFeeConfig`,
 * `_isValidDestOverheadConfig`), and returned canonical.
 *
 * @packageDocumentation
 */

import { ZeroAddress, getAddress } from 'ethers'

import { CCTParamsInvalidError } from '../../errors.ts'
import type { MultiTokenPoolRateLimits } from '../../multi-token-pool.ts'
import { parseRateLimitConfig } from '../token-pool/rate-limit.ts'
import {
  assertUnique,
  parseRecord,
  validateAddress,
  validateArray,
  validateUint16,
  validateUint32,
} from '../validate.ts'
import type {
  MultiTokenPoolDestOverheadConfig,
  MultiTokenPoolFeeConfig,
  MultiTokenPoolSecurityConfig,
} from './records.ts'

/** The four bucket names of a rate limit record. */
const BUCKETS = ['outbound', 'inbound', 'fastFinalityOutbound', 'fastFinalityInbound'] as const

/**
 * The four buckets of a rate limit record: each enabled with `rate <= capacity`, or disabled with
 * zero amounts (an omitted amount of a disabled bucket is `0n`).
 * @internal
 */
export function parseMultiTokenPoolRateLimits(
  operation: string,
  at: string,
  value: unknown,
): MultiTokenPoolRateLimits {
  const input = parseRecord(
    operation,
    at,
    value,
    'rate limits (outbound, inbound, fastFinalityOutbound, fastFinalityInbound)',
  )
  return Object.fromEntries(
    BUCKETS.map((b) => [b, parseRateLimitConfig(operation, `${at}.${b}`, input[b], null)]),
  ) as MultiTokenPoolRateLimits
}

/** The basis points a store accepts: below 100%. */
const BPS_DIVIDER = 10_000

/**
 * A fee record: `uint32` USD cents per tier, `uint16` token fee bps below 10,000 per tier.
 * @internal
 */
export function parseMultiTokenPoolFeeConfig(
  operation: string,
  at: string,
  value: unknown,
): MultiTokenPoolFeeConfig {
  const c = parseRecord(operation, at, value, 'fee config')
  validateUint32(operation, `${at}.finalityFeeUSDCents`, c.finalityFeeUSDCents)
  validateUint32(operation, `${at}.fastFinalityFeeUSDCents`, c.fastFinalityFeeUSDCents)
  for (const f of ['finalityTransferFeeBps', 'fastFinalityTransferFeeBps'] as const) {
    validateUint16(operation, `${at}.${f}`, c[f])
    if ((c[f] as number) >= BPS_DIVIDER)
      throw new CCTParamsInvalidError(
        operation,
        `${at}.${f}`,
        `is ${String(c[f])}: a token fee must be below 10,000 bps (100%)`,
      )
  }
  return c as MultiTokenPoolFeeConfig
}

/** The pool data a v1 release returns: the decimals word (`Pool.CCIP_LOCK_OR_BURN_V1_RET_BYTES`). */
const MIN_DEST_BYTES_OVERHEAD = 32

/**
 * A destination overhead record: non-zero `uint32` gas, and `uint32` bytes of at least 32 (the pool
 * data cap; the lane guard checks it carries the pool data the lane sends).
 * @internal
 */
export function parseMultiTokenPoolDestOverheadConfig(
  operation: string,
  at: string,
  value: unknown,
): MultiTokenPoolDestOverheadConfig {
  const c = parseRecord(operation, at, value, 'destination overhead config')
  validateUint32(operation, `${at}.destGasOverhead`, c.destGasOverhead)
  validateUint32(operation, `${at}.destBytesOverhead`, c.destBytesOverhead)
  if (c.destGasOverhead === 0)
    throw new CCTParamsInvalidError(
      operation,
      `${at}.destGasOverhead`,
      'must not be 0: the release needs gas',
    )
  if ((c.destBytesOverhead as number) < MIN_DEST_BYTES_OVERHEAD)
    throw new CCTParamsInvalidError(
      operation,
      `${at}.destBytesOverhead`,
      `is ${String(c.destBytesOverhead)}: it must be at least ${MIN_DEST_BYTES_OVERHEAD} (the pool data of a release)`,
    )
  return c as MultiTokenPoolDestOverheadConfig
}

/**
 * A security record: CCV lists without duplicates (`address(0)` is the ramps' default CCVs), and a
 * hook or `null`.
 * @internal
 */
export function parseMultiTokenPoolSecurityConfig(
  operation: string,
  at: string,
  value: unknown,
): MultiTokenPoolSecurityConfig {
  const c = parseRecord(operation, at, value, 'security config')
  const list = (field: 'outboundCCVs' | 'inboundCCVs') => {
    validateArray(operation, `${at}.${field}`, c[field])
    const ccvs = Array.from(c[field] as readonly unknown[], (a, i) => {
      validateAddress(operation, `${at}.${field}[${i}]`, a)
      return getAddress(a as string)
    })
    assertUnique(operation, `${at}.${field}`, ccvs, (a) => a, 'CCV')
    return ccvs
  }
  if (c.hook !== null) validateAddress(operation, `${at}.hook`, c.hook)
  const hook = c.hook === null ? null : getAddress(c.hook as string)
  if (hook === ZeroAddress)
    throw new CCTParamsInvalidError(
      operation,
      `${at}.hook`,
      'is the zero address: pass null for no hook',
    )
  return { outboundCCVs: list('outboundCCVs'), inboundCCVs: list('inboundCCVs'), hook }
}
