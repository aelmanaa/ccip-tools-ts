/**
 * The snapshot check of PCM record writes: what each op seals is re-read through its own
 * `sealedFrom`, from the proposal's calldata and a fresh read, never echoed from the snapshot. A
 * registered op that seals nothing, or seals something its touched state does not move, fails here.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ZeroAddress, getAddress } from 'ethers'

import { canonicalHash } from '../../../canonical.ts'
import {
  MULTI_TOKEN_POOL_OPERATIONS,
  MultiTokenPoolVersion,
  POOL_CONFIG_MANAGER_TYPE,
  getMultiTokenPoolInterface,
} from '../../multi-token-pool/contracts.ts'
import {
  type DecodedMultiTokenPoolWrite,
  NO_RECORD_CHANGE_FUNCTIONS,
  decodeMultiTokenPoolWrite,
} from '../calldata.ts'
import { encodePolicyName } from '../contracts.ts'
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

  describe("encode → decode → sealedFrom, on each op's real calldata (n3)", () => {
    const P = getAddress('0x' + '9e'.repeat(20))
    const U = getAddress('0x' + '7b'.repeat(20))
    /** A chain stub for the few reads an encode makes (token decimals, a provider's type). */
    const chain = {
      getTokenInfo: async () => ({ decimals: 18, symbol: 'U' }),
      typeAndVersion: async () => ['SameAddressRemoteTokenAddressProvider', '2.1.0-dev', 'x'],
      provider: { getCode: async () => '0x60806040' },
    }
    /** Real params per op, each touching what its WRITES case touches. */
    const PARAMS: Record<
      string,
      { params: Record<string, unknown>; setup?: (s: MultiTokenPoolRecordState) => void }
    > = {}
    for (const type of [
      'connection',
      'remotePool',
      'rateLimit',
      'fee',
      'destOverhead',
      'security',
    ] as const) {
      const T_ = type[0]!.toUpperCase() + type.slice(1)
      PARAMS[`applyMultiTokenPool${T_}PolicyConfigUpdates`] = {
        params: { recordsToRemove: [policyKey] },
      }
      PARAMS[`applyMultiTokenPoolInline${T_}ConfigUpdates`] = { params: { remove: [key] } }
    }
    const bucket = {
      remoteChainSelector: C1,
      direction: 'outbound',
      fastFinality: false,
      config: { enabled: false },
    }
    PARAMS.applyMultiTokenPoolInlineRateLimitBucketUpdates = {
      params: { updates: [{ tokenAddress: T, ...bucket }] },
    }
    PARAMS.applyMultiTokenPoolRateLimitPolicyBucketUpdates = {
      params: { updates: [{ policyName: 'p', ...bucket }] },
    }
    PARAMS.applyMultiTokenPoolRemoteTokenAddressProviderUpdates = {
      params: { updates: [{ policyName: 'p', remoteTokenAddressProvider: P }] },
    }
    PARAMS.applyMultiTokenPoolSubsetTokenUpdates = {
      params: { add: [{ ...policyKey, tokenAddress: T }] },
      setup: (s) =>
        (s.tokens.find((t) => t.tokenAddress === T)!.policies.connection = 'p' as never),
    }
    PARAMS.applyMultiTokenPoolTokenPolicyUpdates = {
      params: { recordType: 'fee', assignments: [{ tokenAddress: T, policyName: 'p' }] },
    }
    PARAMS.pauseMultiTokenPoolGlobally = { params: {} }
    PARAMS.unpauseMultiTokenPoolGlobally = { params: {}, setup: (s) => (s.isGloballyPaused = true) }
    PARAMS.pauseMultiTokenPoolTokens = { params: { tokenAddresses: [T], direction: 'outbound' } }
    PARAMS.unpauseMultiTokenPoolTokens = {
      params: { tokenAddresses: [T], direction: 'outbound' },
      setup: (s) => (s.tokens.find((t) => t.tokenAddress === T)!.isOutboundPaused = true),
    }
    PARAMS.pauseMultiTokenPoolChains = {
      params: { remoteChainSelectors: [C1], direction: 'outbound' },
    }
    PARAMS.unpauseMultiTokenPoolChains = {
      params: { remoteChainSelectors: [C1], direction: 'outbound' },
      setup: (s) => (s.chainPauses[0]!.outbound = true),
    }
    PARAMS.stopMultiTokenPoolLanes = { params: { lanes: [key], direction: 'outbound' } }
    PARAMS.liftMultiTokenPoolLaneStops = {
      params: { lanes: [key], direction: 'outbound' },
      setup: (s) => {
        const rl = s.tokens.find((t) => t.tokenAddress === T)!.inline.rateLimit[0]!
        rl.rateLimits = { ...rl.rateLimits, outbound: stop, fastFinalityOutbound: stop }
        s.tokens.find((t) => t.tokenAddress === T)!.policies.rateLimit = 'p' as never
      },
    }
    PARAMS.applyMultiTokenPoolTokenProfileUpdates = {
      params: {
        profilesToSet: [
          {
            tokenAddress: U,
            localDecimals: 18,
            lockOrBurnFlavor: 'burn',
            allowedFinality: { finalityDepth: 0 },
            lockOrBurnAddress: null,
            additionalPoolDataProvider: null,
          },
        ],
      },
    }

    it('covers every registered op', () => {
      assert.deepEqual(Object.keys(PARAMS).sort(), [...RECORD_WRITE_OPS.keys()].sort())
    })

    for (const [name, { params, setup }] of Object.entries(PARAMS))
      it(`${name}: seals what its own calldata touches, and calls the op map's function`, async () => {
        const state = base()
        setup?.(state)
        const op = RECORD_WRITE_OPS.get(name) as unknown as {
          prepare: (p: unknown) => unknown
          encode: (
            c: unknown,
            p: unknown,
            x: PoolConfigManagerWriteContext,
          ) => Promise<{ data: string }>
          sealedFrom: (
            c: unknown,
            d: DecodedMultiTokenPoolWrite,
            x: PoolConfigManagerWriteContext,
          ) => Promise<Record<string, unknown>> | Record<string, unknown>
        }
        const ctx = {
          ...ctxOf(state),
          staticConfig: {},
          policyNames: Object.fromEntries(
            (
              ['connection', 'remotePool', 'rateLimit', 'fee', 'destOverhead', 'security'] as const
            ).map((t) => [t, new Set([encodePolicyName('test', 'p', 'p').toLowerCase()])]),
          ),
          rateLimitPolicyDecimals: new Map([
            [encodePolicyName('test', 'p', 'p').toLowerCase(), 18],
          ]),
        } as unknown as PoolConfigManagerWriteContext
        // the profile op also reads the pools serving the PCM (the registry), which its live tests
        // cover: here its calldata comes straight from the PCM ABI
        const data =
          name === 'applyMultiTokenPoolTokenProfileUpdates'
            ? getMultiTokenPoolInterface(
                POOL_CONFIG_MANAGER_TYPE,
                MultiTokenPoolVersion.V2_1_0_DEV,
              ).encodeFunctionData('applyTokenProfileUpdates', [
                [],
                [[U, 18, 0, '0x00000000', ZeroAddress, ZeroAddress]],
              ])
            : (await op.encode(chain, op.prepare({ poolConfigManager: PCM, ...params }), ctx)).data
        const decoded = decodeMultiTokenPoolWrite(data, MultiTokenPoolVersion.V2_1_0_DEV)
        const target = MULTI_TOKEN_POOL_OPERATIONS[name as keyof typeof MULTI_TOKEN_POOL_OPERATIONS]
        const functions =
          'function' in target
            ? [target.function]
            : Object.values(target.functions as Record<string, string>)
        assert.ok(
          functions.includes(decoded.functionName),
          `${name} encodes ${decoded.functionName}`,
        )
        const fromCalldata = await op.sealedFrom(chain, decoded, ctx)
        assert.ok(Object.keys(fromCalldata).length > 0, `${name} seals nothing from its calldata`)
        // the representative write touches the same records, so it seals the same paths
        if (decoded.profiles) assert.deepEqual(Object.keys(fromCalldata), [`profiles.${U}`])
        else
          assert.deepEqual(
            Object.keys(fromCalldata).sort(),
            Object.keys(await sealed(name, WRITES[name]!.decoded, state)).sort(),
          )
      })
  })
})
