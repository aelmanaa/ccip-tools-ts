/**
 * Section writes of pool-group records (`PolicySection`): parsing a partial
 * `PoolGroupSectionUpdate`, merging it over a record's current section, and reading back the
 * exact section a proposal's instruction carries. Program of record: chainlink-ccip-solana 7558722,
 * `base-token-pool/src/groups.rs:135-605` (`ConnectionPolicy`, `FeePolicy`, `RateLimitPolicy`,
 * `PolicySection::validate`).
 *
 * @packageDocumentation
 */

import { Buffer } from 'buffer'

import { BN } from '@coral-xyz/anchor'

import { getAddressBytes } from '../../../utils.ts'
import { CCTParamsInvalidError } from '../../errors.ts'
import type { RateLimitConfig } from '../../rate-limit.ts'
import { parseRemoteAddress } from '../../remote-address.ts'
import {
  parseAllowedFinality,
  parseTokenTransferFeeConfig,
} from '../token-pool/operations/chain-config-v2.ts'
import { parseRateLimitConfig } from '../token-pool/operations/set-chain-rate-limit.ts'
import { decodeFeeConfig, decodeRateLimitConfig, decodeSections } from './decode.ts'
import type { IdlPolicySections } from './lane.ts'
import type { PoolGroupPolicyClass } from './types.ts'

/** `MAX_POLICY_REMOTE_POOLS` (groups.rs:42). */
const MAX_POLICY_REMOTE_POOLS = 8
/** A `RemoteAddress` holds at most 64 bytes (`ConnectionPolicy::validate`). */
const MAX_REMOTE_ADDRESS_BYTES = 64

/** The classes a section write may carry: SECURITY changes only through the CCV schedule. */
const WRITABLE_CLASSES = ['connection', 'fee', 'rateLimit'] as const
/** A class a section write carries. @internal */
export type WritableClass = (typeof WRITABLE_CLASSES)[number]

const BUCKETS = [
  ['outbound', 'outbound'],
  ['inbound', 'inbound'],
  ['fastFinalityOutbound', 'ftfOutbound'],
  ['fastFinalityInbound', 'ftfInbound'],
] as const

/** A parsed section update: only the fields given, each already in the program's shape. @internal */
export type ParsedSectionUpdate =
  | {
      policyClass: 'connection'
      remotePools?: { address: Buffer; allowLegacyPoolData: boolean }[]
      poolDataFormat?: 'legacy' | 'long'
      allowedFinality?: { flags: number; blockDepth: number }
    }
  | { policyClass: 'fee'; fee: Record<string, unknown> }
  | {
      policyClass: 'rateLimit'
      buckets: Partial<Record<(typeof BUCKETS)[number][1], RateLimitConfig>>
    }

/** A section to write: an update to merge, or the exact section a proposal carries. @internal */
export type SectionWrite =
  | { kind: 'update'; update: ParsedSectionUpdate }
  | { kind: 'exact'; policyClass: WritableClass; idl: Record<string, unknown> }

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Parses one remote pool address of a CONNECTION section: in the remote chain's spelling for a
 * chain record, as `0x` hex for a default (which no chain owns; `getPoolGroup` returns it so).
 */
function parsePoolAddress(
  operation: string,
  param: string,
  value: unknown,
  selector: bigint | undefined,
): Buffer {
  if (selector !== undefined)
    return Buffer.from(getAddressBytes(parseRemoteAddress(operation, param, value, selector)))
  if (typeof value !== 'string' || !/^0x([0-9a-fA-F]{2})+$/.test(value))
    throw new CCTParamsInvalidError(
      operation,
      param,
      'a default record names no chain: give the remote pool as 0x hex of the bytes the OffRamp delivers',
    )
  const bytes = Buffer.from(value.slice(2), 'hex')
  if (bytes.every((b) => b === 0))
    throw new CCTParamsInvalidError(operation, param, 'must not be the zero address')
  return bytes
}

/**
 * Parses a `PoolGroupSectionUpdate`. `selector` is the record's chain (`undefined` for a
 * group or policy default).
 * @throws {@link CCTParamsInvalidError} if it is malformed, names SECURITY, or sets nothing
 * @internal
 */
export function parseSectionUpdate(
  operation: string,
  value: unknown,
  selector: bigint | undefined,
): ParsedSectionUpdate {
  const param = 'section'
  if (!isRecord(value)) throw new CCTParamsInvalidError(operation, param, 'must be an object')
  const cls = value.policyClass
  if (cls === 'security')
    throw new CCTParamsInvalidError(
      operation,
      `${param}.policyClass`,
      'SECURITY is written only through the CCV schedule and hook ops',
    )
  if (!(WRITABLE_CLASSES as readonly unknown[]).includes(cls))
    throw new CCTParamsInvalidError(
      operation,
      `${param}.policyClass`,
      `must be one of ${WRITABLE_CLASSES.join(', ')}`,
    )
  if (cls === 'connection') {
    const c = value.connection
    if (!isRecord(c))
      throw new CCTParamsInvalidError(operation, `${param}.connection`, 'must be an object')
    const out: ParsedSectionUpdate = { policyClass: 'connection' }
    if (c.remotePools !== undefined) {
      if (!Array.isArray(c.remotePools))
        throw new CCTParamsInvalidError(
          operation,
          `${param}.connection.remotePools`,
          'must be an array',
        )
      if (c.remotePools.length > MAX_POLICY_REMOTE_POOLS)
        throw new CCTParamsInvalidError(
          operation,
          `${param}.connection.remotePools`,
          `a record trusts at most ${MAX_POLICY_REMOTE_POOLS} remote pools (TooManyPolicyRemotePools)`,
        )
      const seen = new Set<string>()
      out.remotePools = Array.from(c.remotePools, (p: unknown, i) => {
        const at = `${param}.connection.remotePools[${i}]`
        if (!isRecord(p)) throw new CCTParamsInvalidError(operation, at, 'must be an object')
        const address = parsePoolAddress(operation, `${at}.address`, p.address, selector)
        if (address.length > MAX_REMOTE_ADDRESS_BYTES)
          throw new CCTParamsInvalidError(
            operation,
            `${at}.address`,
            `is ${address.length} bytes, above ${MAX_REMOTE_ADDRESS_BYTES}`,
          )
        if (seen.has(address.toString('hex')))
          throw new CCTParamsInvalidError(
            operation,
            `${at}.address`,
            'must not duplicate an earlier pool (RemotePoolAddressAlreadyExisted)',
          )
        seen.add(address.toString('hex'))
        if (typeof p.allowLegacyPoolData !== 'boolean')
          throw new CCTParamsInvalidError(
            operation,
            `${at}.allowLegacyPoolData`,
            'must be a boolean',
          )
        return { address, allowLegacyPoolData: p.allowLegacyPoolData }
      })
    }
    if (c.poolDataFormat !== undefined) {
      if (c.poolDataFormat !== 'legacy' && c.poolDataFormat !== 'long')
        throw new CCTParamsInvalidError(
          operation,
          `${param}.connection.poolDataFormat`,
          "must be 'legacy' or 'long'",
        )
      out.poolDataFormat = c.poolDataFormat
    }
    if (c.allowedFinality !== undefined)
      out.allowedFinality = parseAllowedFinality(operation, c.allowedFinality)
    if (Object.keys(out).length === 1)
      throw new CCTParamsInvalidError(
        operation,
        `${param}.connection`,
        'must set at least one field',
      )
    return out
  }
  if (cls === 'fee') {
    const fee = value.tokenTransferFeeConfig
    if (!isRecord(fee) || !Object.keys(fee).length)
      throw new CCTParamsInvalidError(
        operation,
        `${param}.tokenTransferFeeConfig`,
        'must be an object setting at least one field',
      )
    return { policyClass: 'fee', fee }
  }
  const rl = value.rateLimit
  if (!isRecord(rl))
    throw new CCTParamsInvalidError(operation, `${param}.rateLimit`, 'must be an object')
  const buckets: Extract<ParsedSectionUpdate, { policyClass: 'rateLimit' }>['buckets'] = {}
  for (const key of Object.keys(rl)) {
    const bucket = BUCKETS.find(([name]) => name === key)
    if (!bucket)
      throw new CCTParamsInvalidError(
        operation,
        `${param}.rateLimit.${key}`,
        `is not a bucket (${BUCKETS.map(([n]) => n).join(', ')})`,
      )
    if (rl[key] === undefined) continue
    buckets[bucket[1]] = parseRateLimitConfig(operation, `${param}.rateLimit.${key}`, rl[key])
  }
  if (!Object.keys(buckets).length)
    throw new CCTParamsInvalidError(operation, `${param}.rateLimit`, 'must set at least one bucket')
  return { policyClass: 'rateLimit', buckets }
}

const toIdlBucket = (c: RateLimitConfig) => ({
  enabled: c.enabled,
  capacity: new BN((c.capacity ?? 0n).toString()),
  rate: new BN((c.rate ?? 0n).toString()),
})

/**
 * The `PolicySection` instruction argument a write sends: an update merged over the record's
 * current `sections` (omitted fields keep their value; kept remote pools keep their stored bytes),
 * or a proposal's exact section. FEE BPS above `maxBpsFee` is refused here, as the program does.
 * @throws {@link CCTParamsInvalidError} if the merged section is invalid
 * @internal
 */
export function sectionArg(
  operation: string,
  write: SectionWrite,
  current: IdlPolicySections,
  maxBpsFee: number,
): Record<string, unknown> {
  if (write.kind === 'exact') return write.idl
  const u = write.update
  if (u.policyClass === 'connection') {
    const c = current.connection
    return {
      connection: {
        0: {
          remotePools: u.remotePools
            ? u.remotePools.map((p) => ({
                address: { address: p.address },
                allowLegacyPoolData: p.allowLegacyPoolData,
              }))
            : c.remotePools,
          poolDataFormat: u.poolDataFormat
            ? u.poolDataFormat === 'long'
              ? { long: {} }
              : { legacy32: {} }
            : c.poolDataFormat,
          allowedFinalityConfig: u.allowedFinality ?? c.allowedFinalityConfig,
        },
      },
    }
  }
  if (u.policyClass === 'fee') {
    const fee = parseTokenTransferFeeConfig(operation, {
      ...decodeFeeConfig(current.fee.tokenTransferFeeConfig),
      ...u.fee,
    })
    const bps = Math.max(fee.finalityBpsFee, fee.fastFinalityBpsFee)
    if (bps > maxBpsFee)
      throw new CCTParamsInvalidError(
        operation,
        'section.tokenTransferFeeConfig',
        `a BPS fee of ${bps} is above the pool group's cap of ${maxBpsFee} bps (BpsFeeAboveGroupMax)`,
      )
    return { fee: { 0: { tokenTransferFeeConfig: fee } } }
  }
  const r = current.rateLimit
  const pick = (k: (typeof BUCKETS)[number][1]) => {
    const given = u.buckets[k]
    return given ? toIdlBucket(given) : r[k]
  }
  return {
    rateLimit: {
      0: {
        inbound: pick('inbound'),
        outbound: pick('outbound'),
        ftfInbound: pick('ftfInbound'),
        ftfOutbound: pick('ftfOutbound'),
      },
    },
  }
}

/** The class of a section write. @internal */
export const sectionClass = (write: SectionWrite): WritableClass =>
  write.kind === 'exact' ? write.policyClass : write.update.policyClass

/**
 * A proposal's section: the decoded `PolicySection` of its instruction, kept exact.
 * @throws {@link CCTParamsInvalidError} if it is not a CONNECTION, FEE or RATE_LIMIT section
 * @internal
 */
export function exactSection(operation: string, decoded: unknown): SectionWrite {
  if (isRecord(decoded))
    for (const cls of WRITABLE_CLASSES)
      if (decoded[cls] !== undefined) return { kind: 'exact', policyClass: cls, idl: decoded }
  throw new CCTParamsInvalidError(
    operation,
    'transactions',
    'the instruction carries no CONNECTION, FEE or RATE_LIMIT section',
  )
}

/**
 * One class of a record's sections as the snapshot keeps it (decoded, so it compares stably).
 * @internal
 */
export function sectionValue(
  sections: IdlPolicySections,
  cls: PoolGroupPolicyClass,
  selector: bigint | undefined,
): unknown {
  return decodeSections(sections, 0n, selector)[cls]
}

/**
 * A record's RATE_LIMIT, as the shared four-bucket shape (for the "loosened" judgement).
 * @internal
 */
export function rateLimitsOf(sections: IdlPolicySections) {
  const r = sections.rateLimit
  return {
    outbound: decodeRateLimitConfig(r.outbound),
    inbound: decodeRateLimitConfig(r.inbound),
    fastFinalityOutbound: decodeRateLimitConfig(r.ftfOutbound),
    fastFinalityInbound: decodeRateLimitConfig(r.ftfInbound),
  }
}

/** The bit of a class (`PolicyClass::bit`). @internal */
export const classBit = (cls: PoolGroupPolicyClass): number =>
  1 << ['connection', 'fee', 'rateLimit', 'security'].indexOf(cls)
