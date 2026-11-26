/**
 * Canonical JSON for hashing: the SDK's `jsonStringify` over a copy of the value with object keys
 * sorted and byte arrays as `0x` hex. Internal to the CCT layer (snapshots, step input hashes).
 *
 * @packageDocumentation
 */

import { Buffer } from 'buffer'

import { id as keccak256Utf8 } from 'ethers'

import { jsonStringify } from '../utils.ts'
import type { MultiTokenPoolSnapshot } from './multi-token-pool.ts'

/**
 * A deep copy of `value` with object keys sorted and byte arrays as `0x` hex, so that
 * {@link jsonStringify} of it is canonical: equal values always give equal text.
 */
function canonicalize(value: unknown): unknown {
  if (value instanceof Uint8Array) return '0x' + Buffer.from(value).toString('hex')
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonicalize(v)]),
    )
  return value
}

/**
 * The canonical JSON of `value`: the SDK's {@link jsonStringify} (bigints as bare integers, other
 * numbers with a `.0` suffix, so {@link jsonParse} reads them back as the same types) over a copy
 * with sorted keys and byte arrays as `0x` hex. Snapshots, `step.inputsHash` and `planHash` hash it.
 * @internal
 */
export function canonicalJson(value: unknown): string {
  return jsonStringify(canonicalize(value))
}

/** keccak256 of {@link canonicalJson}. @internal */
export function canonicalHash(value: unknown): string {
  return keccak256Utf8(canonicalJson(value))
}

/**
 * Seals a snapshot by computing its `hash`. @internal
 * @param fields - Every snapshot field but `hash`.
 */
export function sealMultiTokenPoolSnapshot(
  fields: Omit<MultiTokenPoolSnapshot, 'hash'>,
): MultiTokenPoolSnapshot {
  return { ...fields, hash: canonicalHash(fields) }
}
