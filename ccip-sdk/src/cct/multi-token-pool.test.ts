import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { canonicalHash, canonicalJson, sealMultiTokenPoolSnapshot } from './canonical.ts'
import { CCTParamsInvalidError } from './errors.ts'
import {
  MULTI_TOKEN_POOL_LANE_CHECKS,
  MULTI_TOKEN_POOL_STEP_SIGNER_KINDS,
  parseMultiTokenPoolSnapshot,
  serializeMultiTokenPoolSnapshot,
} from './multi-token-pool.ts'

// non-round on purpose: a JSON.parse round trip would corrupt it
const BIG = 1234567890123456789n

const fields = {
  observedAt: 123_456_789n,
  operation: 'applyMultiTokenPoolInlineFeeConfigUpdates',
  expected: {
    'profile.lockOrBurnFlavor': 'burn',
    'buckets.outbound': { capacity: BIG, rate: 7n, enabled: true },
    decimals: 18,
    ratio: 0.5,
    remoteToken: new Uint8Array([0xde, 0xad]),
  },
  guardInputsHash: '0x' + '11'.repeat(32),
  calldataHash: '0x' + '22'.repeat(32),
}

describe('canonical JSON', () => {
  it('sorts keys deeply, so equal values give equal text whatever the key order', () => {
    assert.equal(
      canonicalJson({ b: 1n, a: { d: [{ y: 1, x: 2 }], c: 'z' } }),
      canonicalJson({ a: { c: 'z', d: [{ x: 2, y: 1 }] }, b: 1n }),
    )
    assert.equal(canonicalJson({ b: 1n, a: 2 }), '{"a":2.0,"b":1}')
  })

  it('writes bytes as 0x hex and drops undefined fields', () => {
    assert.equal(canonicalJson({ v: new Uint8Array([1, 255]), gone: undefined }), '{"v":"0x01ff"}')
  })

  it('hashes with keccak256', () => {
    assert.match(canonicalHash({ a: 1n }), /^0x[0-9a-f]{64}$/)
    assert.notEqual(canonicalHash({ a: 1n }), canonicalHash({ a: 1 }))
  })
})

describe('snapshot serialization', () => {
  const snapshot = sealMultiTokenPoolSnapshot(fields)

  it('round-trips with bigints and numbers keeping their types', () => {
    const parsed = parseMultiTokenPoolSnapshot(serializeMultiTokenPoolSnapshot(snapshot))
    // bytes come back as their canonical hex
    assert.deepEqual(parsed, {
      ...snapshot,
      expected: { ...fields.expected, remoteToken: '0xdead' },
    })
    const buckets = parsed.expected['buckets.outbound'] as { capacity: unknown }
    assert.equal(buckets.capacity, BIG)
    assert.equal(parsed.expected.decimals, 18)
    // the hash covers canonical forms, so the hex round trip keeps it valid
    assert.equal(
      sealMultiTokenPoolSnapshot({ ...parsed, hash: undefined } as never).hash,
      parsed.hash,
    )
  })

  it('refuses an edited snapshot', () => {
    const json = serializeMultiTokenPoolSnapshot(snapshot).replace('"burn"', '"lock"')
    assert.throws(
      () => parseMultiTokenPoolSnapshot(json),
      (e: unknown) => e instanceof CCTParamsInvalidError && e.context.param === 'json.hash',
    )
  })

  it('binds the building op: the same state and calldata under another op is another snapshot', () => {
    const a = sealMultiTokenPoolSnapshot(fields)
    const b = sealMultiTokenPoolSnapshot({
      ...fields,
      operation: 'applyMultiTokenPoolFeePolicyConfigUpdates',
    })
    assert.notEqual(a.hash, b.hash)
    // relabelling a stored snapshot for another op is an edit
    const relabelled = serializeMultiTokenPoolSnapshot({ ...a, operation: b.operation })
    assert.throws(() => parseMultiTokenPoolSnapshot(relabelled), CCTParamsInvalidError)
  })

  it('refuses text that is not a snapshot', () => {
    for (const json of ['not json {', '{"observedAt":"1"}', '[]'])
      assert.throws(
        () => parseMultiTokenPoolSnapshot(json),
        (e: unknown) => e instanceof CCTParamsInvalidError && e.context.param === 'json',
      )
  })
})

describe('shared runtime tuples', () => {
  it('lists unique lane checks and signer kinds', () => {
    assert.equal(new Set(MULTI_TOKEN_POOL_LANE_CHECKS).size, MULTI_TOKEN_POOL_LANE_CHECKS.length)
    // appended codes keep the earlier indices: LANE_UNREADABLE (local) after REMOTE_UNREADABLE (remote)
    assert.equal(MULTI_TOKEN_POOL_LANE_CHECKS.at(-1), 'LANE_UNREADABLE')
    assert.ok(
      MULTI_TOKEN_POOL_LANE_CHECKS.indexOf('REMOTE_UNREADABLE') <
        MULTI_TOKEN_POOL_LANE_CHECKS.indexOf('LANE_UNREADABLE'),
    )
    assert.equal(
      new Set(MULTI_TOKEN_POOL_STEP_SIGNER_KINDS).size,
      MULTI_TOKEN_POOL_STEP_SIGNER_KINDS.length,
    )
    assert.ok(MULTI_TOKEN_POOL_LANE_CHECKS.includes('POOL_DATA_FORMAT_MISMATCH'))
  })
})
