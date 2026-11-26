/**
 * The pure parts of the guard framework: snapshot checks, the sealed guard options, and the
 * attestation rules. The framework end to end runs live in `guard-run.integration.test.ts`.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { getAddress } from 'ethers'

import { sealMultiTokenPoolSnapshot } from '../../canonical.ts'
import { CCTParamsInvalidError, CCTStateChangedError } from '../../errors.ts'
import type { MultiTokenPoolRemoteAttestation } from '../../multi-token-pool.ts'
import { MAX_ATTESTATION_SECONDS, attestationRefusal } from './guard-facts.ts'
import { assertSnapshotHolds, guardOptionsOf } from './guard-run.ts'

const OP = 'applyMultiTokenPoolInlineFeeConfigUpdates'
const T = getAddress('0x' + 'a1'.repeat(20))
const snapshot = sealMultiTokenPoolSnapshot({
  observedAt: 100n,
  operation: OP,
  expected: { 'fee.bps': 5, 'guard.options': {} },
  guardInputsHash: '0x' + '11'.repeat(32),
  calldataHash: '0x' + '22'.repeat(32),
})
const current = {
  calldataHash: snapshot.calldataHash,
  guardInputsHash: snapshot.guardInputsHash,
  expected: snapshot.expected,
}

describe('snapshot checks (cct/evm pool-config-manager)', () => {
  it('holds when nothing moved', () => {
    assert.doesNotThrow(() => assertSnapshotHolds(OP, snapshot, current))
  })

  it("refuses another op's snapshot, and one for other calldata, as a caller mistake", () => {
    assert.throws(
      () => assertSnapshotHolds('applyMultiTokenPoolFeePolicyConfigUpdates', snapshot, current),
      (e: unknown) => e instanceof CCTParamsInvalidError && /was built by/.test(e.message),
    )
    assert.throws(
      () => assertSnapshotHolds(OP, snapshot, { ...current, calldataHash: '0x' + '33'.repeat(32) }),
      (e: unknown) => e instanceof CCTParamsInvalidError && /other calldata/.test(e.message),
    )
  })

  it('lists every moved value and the moved guard inputs, as a state change', () => {
    assert.throws(
      () =>
        assertSnapshotHolds(OP, snapshot, {
          ...current,
          expected: { ...current.expected, 'fee.bps': 6 },
          guardInputsHash: '0x' + '44'.repeat(32),
        }),
      (e: unknown) =>
        e instanceof CCTStateChangedError &&
        !e.isTransient &&
        JSON.stringify((e.context.changed as { path: string }[]).map((c) => c.path)) ===
          JSON.stringify(['fee.bps', 'guardInputsHash']),
    )
  })

  it('seals guard options in a stable shape, defaults dropped', () => {
    assert.deepEqual(guardOptionsOf({}), {})
    const a = guardOptionsOf({
      confirmClosing: [
        { tokenAddress: T.toLowerCase(), remoteChainSelector: 2n },
        { tokenAddress: T, remoteChainSelector: 1n },
      ],
      migrationWindowChains: [3n, 1n],
      allowDroppingDefaultCCVs: false,
    })
    assert.deepEqual(a, {
      confirmClosing: [
        { tokenAddress: T, remoteChainSelector: 1n },
        { tokenAddress: T, remoteChainSelector: 2n },
      ],
      migrationWindowChains: [1n, 3n],
    })
  })
})

describe('remote attestations (cct/evm pool-config-manager)', () => {
  // an unknown selector: a family the SDK cannot read, where attestations apply
  const UNKNOWN_FAMILY = 1n << 63n
  const att = (
    o: Partial<MultiTokenPoolRemoteAttestation> = {},
  ): MultiTokenPoolRemoteAttestation => ({
    remoteChainSelector: UNKNOWN_FAMILY,
    remoteToken: '0x01',
    remotePoolAddress: '0x02',
    acceptsLongPoolData: true,
    attestedAt: 1_000n,
    validUntil: 1_000n + 3_600n,
    reason: 'checked by ops',
    ...o,
  })

  it('accepts a fresh attestation for a family the SDK cannot read', () => {
    assert.equal(attestationRefusal(att(), { now: 2_000n }), undefined)
  })

  it('refuses EVM and Solana remotes, expired or over-long ones, and live-making checks', () => {
    assert.match(
      attestationRefusal(att({ remoteChainSelector: 16015286601757825753n }), { now: 2_000n })!,
      /EVM/,
    )
    assert.match(
      attestationRefusal(att({ remoteChainSelector: 16423721717087811551n }), { now: 2_000n })!,
      /SVM|Solana/i,
    )
    assert.match(attestationRefusal(att(), { now: 10_000n })!, /expired/)
    assert.match(
      attestationRefusal(att({ validUntil: 1_000n + MAX_ATTESTATION_SECONDS + 1n }), {
        now: 2_000n,
      })!,
      /24 hours/,
    )
    assert.match(attestationRefusal(att(), { now: 2_000n, makesLive: true })!, /live/)
    assert.match(
      attestationRefusal(att({ attestedAt: 5_000n, validUntil: 6_000n }), { now: 2_000n })!,
      /future/,
    )
  })
})
