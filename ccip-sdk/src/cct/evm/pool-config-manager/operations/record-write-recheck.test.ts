/**
 * The snapshot check of PCM record writes: what each op seals is re-read through its own
 * `sealedFrom`, from the proposal's calldata and a fresh read, never echoed from the snapshot. A
 * registered op that seals nothing, or seals something its touched state does not move, fails here.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ZeroAddress, getAddress } from 'ethers'

import { canonicalHash } from '../../../canonical.ts'
import { MULTI_TOKEN_POOL_OPERATIONS } from '../../multi-token-pool/contracts.ts'
import { type DecodedMultiTokenPoolWrite, NO_RECORD_CHANGE_FUNCTIONS } from '../calldata.ts'
import { C1, empty, inlineLane, on } from '../projection.test.helpers.ts'
import {
  type MultiTokenPoolRecordChange,
  type MultiTokenPoolRecordState,
  applyMultiTokenPoolRecordChanges,
} from '../projection.ts'
import type { PoolConfigManagerWriteContext } from '../write-operation.ts'
import { RECORD_WRITE_OPS } from './check-multi-token-pool-snapshot.ts'

const T = getAddress('0x' + '7a'.repeat(20))
const PCM = getAddress('0x' + '22'.repeat(20))
const key = { tokenAddress: T, remoteChainSelector: C1 }
const policyKey = { policyName: 'p', remoteChainSelector: C1 }
const limits = {
  outbound: on(true),
  inbound: on(true),
  fastFinalityOutbound: on(false),
  fastFinalityInbound: on(false),
}
const stop = { enabled: true, capacity: 0n, rate: 0n }

/** One policy record of every type, named `p`, on C1. */
const policyRecords: MultiTokenPoolRecordChange[] = (
  [
    ['connection', { onlySubsetTokens: true }],
    ['remotePool', { remotePoolAddresses: [getAddress('0x' + 'f1'.repeat(20))] }],
    ['rateLimit', { localDecimals: 18, rateLimits: limits }],
    [
      'fee',
      {
        feeConfig: {
          finalityFeeUSDCents: 1,
          fastFinalityFeeUSDCents: 2,
          finalityTransferFeeBps: 5,
          fastFinalityTransferFeeBps: 5,
        },
      },
    ],
    ['destOverhead', { destOverheadConfig: { destGasOverhead: 350_000, destBytesOverhead: 224 } }],
    [
      'security',
      { securityConfig: { outboundCCVs: [ZeroAddress], inboundCCVs: [ZeroAddress], hook: null } },
    ],
  ] as const
).map(
  ([type, fields]) =>
    ({ kind: 'setPolicyRecord', type, record: { ...policyKey, ...fields } }) as never,
)

/** The base state: T registered with every inline record on C1, policy `p` of every type, C1 known to the pause list. */
function base(): MultiTokenPoolRecordState {
  const s = applyMultiTokenPoolRecordChanges(empty(), [...inlineLane(T), ...policyRecords])
  s.tokens.find((t) => t.tokenAddress === T)!.profile = {
    tokenAddress: T,
    isRegistered: true,
    localDecimals: 18,
    lockOrBurnFlavor: 'burn',
    allowedFinality: { finalized: true },
    lockOrBurnAddress: null,
    additionalPoolDataProvider: null,
  } as never
  s.chainPauses.push({ remoteChainSelector: C1, outbound: false, inbound: false })
  return s
}

/** A representative decoded write per registered op: each moves what it touches. */
const WRITES: Record<
  string,
  { decoded: DecodedMultiTokenPoolWrite; setup?: (s: MultiTokenPoolRecordState) => void }
> = {}
const changes = (fn: string, list: MultiTokenPoolRecordChange[]): DecodedMultiTokenPoolWrite => ({
  functionName: fn,
  changes: list,
})
for (const type of [
  'connection',
  'remotePool',
  'rateLimit',
  'fee',
  'destOverhead',
  'security',
] as const) {
  const T_ = type[0]!.toUpperCase() + type.slice(1)
  // a policy record removed: present before, gone after
  WRITES[`applyMultiTokenPool${T_}PolicyConfigUpdates`] = {
    decoded: changes(`apply${T_}PolicyConfigUpdates`, [
      { kind: 'removePolicyRecord', type, ...policyKey },
    ]),
  }
  // an inline record removed
  WRITES[`applyMultiTokenPoolInline${T_}ConfigUpdates`] = {
    decoded: changes(`applyInline${T_}ConfigUpdates`, [{ kind: 'removeInline', type, ...key }]),
  }
}
WRITES.applyMultiTokenPoolInlineRateLimitBucketUpdates = {
  decoded: changes('applyInlineRateLimitBucketUpdates', [
    { kind: 'setInlineRateLimitBucket', ...key, bucket: 'outbound', config: on(false) },
  ]),
}
WRITES.applyMultiTokenPoolRateLimitPolicyBucketUpdates = {
  decoded: changes('applyRateLimitPolicyBucketUpdates', [
    { kind: 'setPolicyRateLimitBucket', ...policyKey, bucket: 'outbound', config: on(false) },
  ]),
}
WRITES.applyMultiTokenPoolRemoteTokenAddressProviderUpdates = {
  decoded: changes('applyRemoteTokenAddressProviderUpdates', [
    {
      kind: 'setRemoteTokenAddressProvider',
      policyName: 'p',
      provider: getAddress('0x' + '9e'.repeat(20)),
    },
  ]),
}
WRITES.applyMultiTokenPoolSubsetTokenUpdates = {
  decoded: changes('applySubsetTokenUpdates', [
    { kind: 'updateSubsetTokens', ...policyKey, add: [T] },
  ]),
}
WRITES.applyMultiTokenPoolTokenPolicyUpdates = {
  decoded: changes('assignFeePolicy', [
    { kind: 'assignPolicy', type: 'fee', tokenAddress: T, policyName: 'p' },
  ]),
}
WRITES.pauseMultiTokenPoolGlobally = {
  decoded: changes('pauseGlobally', [{ kind: 'setGlobalPause', paused: true }]),
}
WRITES.unpauseMultiTokenPoolGlobally = {
  decoded: changes('unpauseGlobally', [{ kind: 'setGlobalPause', paused: false }]),
  setup: (s) => (s.isGloballyPaused = true),
}
WRITES.pauseMultiTokenPoolTokens = {
  decoded: changes('pauseTokens', [{ kind: 'setTokenPause', tokenAddress: T, outbound: true }]),
}
WRITES.unpauseMultiTokenPoolTokens = {
  decoded: changes('unpauseTokens', [{ kind: 'setTokenPause', tokenAddress: T, outbound: false }]),
  setup: (s) => (s.tokens.find((t) => t.tokenAddress === T)!.isOutboundPaused = true),
}
WRITES.pauseMultiTokenPoolChains = {
  decoded: changes('pauseChains', [
    { kind: 'setChainPause', remoteChainSelector: C1, outbound: true },
  ]),
}
WRITES.unpauseMultiTokenPoolChains = {
  decoded: changes('unpauseChains', [
    { kind: 'setChainPause', remoteChainSelector: C1, outbound: false },
  ]),
  setup: (s) => (s.chainPauses[0]!.outbound = true),
}
WRITES.stopMultiTokenPoolLanes = {
  decoded: changes('applyInlineRateLimitConfigUpdates', [
    {
      kind: 'setInline',
      type: 'rateLimit',
      record: { ...key, rateLimits: { ...limits, outbound: stop, fastFinalityOutbound: stop } },
    },
  ]),
}
WRITES.liftMultiTokenPoolLaneStops = {
  decoded: changes('applyInlineRateLimitConfigUpdates', [
    { kind: 'removeInline', type: 'rateLimit', ...key },
  ]),
}
WRITES.applyMultiTokenPoolTokenProfileUpdates = {
  decoded: {
    functionName: 'applyTokenProfileUpdates',
    changes: [],
    profiles: { remove: [T], set: [] },
  },
}

const ctxOf = (state: MultiTokenPoolRecordState) =>
  ({
    address: PCM,
    version: '2.1.0-dev',
    blockTag: 1,
    state,
  }) as unknown as PoolConfigManagerWriteContext

/** What `op` seals for `decoded` on `state`. */
const sealed = (
  op: string,
  decoded: DecodedMultiTokenPoolWrite,
  state: MultiTokenPoolRecordState,
) =>
  (
    RECORD_WRITE_OPS.get(op) as unknown as {
      sealedFrom: (
        c: unknown,
        d: DecodedMultiTokenPoolWrite,
        x: PoolConfigManagerWriteContext,
      ) => Promise<Record<string, unknown>> | Record<string, unknown>
    }
  ).sealedFrom({}, decoded, ctxOf(state))

describe('snapshot check of PCM record writes', () => {
  it('registers every record-changing PCM op of the op map', () => {
    const recordOps = Object.entries(MULTI_TOKEN_POOL_OPERATIONS)
      .filter(([, t]) => {
        if (!(t.contracts as readonly string[]).includes('PoolConfigManager')) return false
        const fns =
          'function' in t ? [t.function] : Object.values(t.functions as Record<string, string>)
        return fns.some((f) => f !== 'constructor' && !NO_RECORD_CHANGE_FUNCTIONS.has(f))
      })
      .map(([name]) => name)
      .sort()
    assert.deepEqual([...RECORD_WRITE_OPS.keys()].sort(), recordOps)
    assert.deepEqual(Object.keys(WRITES).sort(), recordOps)
  })

  for (const [op, { decoded, setup }] of Object.entries(WRITES))
    it(`${op}: seals what its calldata touches, re-read from the state`, async () => {
      const before = base()
      setup?.(before)
      const after = applyMultiTokenPoolRecordChanges(structuredClone(before), decoded.changes)
      if (decoded.profiles)
        after.tokens.find((t) => t.tokenAddress === T)!.profile!.isRegistered = false
      const now = await sealed(op, decoded, before)
      assert.ok(Object.keys(now).length > 0, `${op} seals nothing`)
      // the state the write leaves differs where the write touches it: what is sealed must follow it
      assert.notEqual(
        canonicalHash(now),
        canonicalHash(await sealed(op, decoded, after)),
        `${op} ignores the state it seals`,
      )
    })
})
