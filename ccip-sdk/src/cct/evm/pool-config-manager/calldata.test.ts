/**
 * PCM calldata → record changes. Every state-changing PCM function is either decoded or listed as
 * changing no record, so an ABI addition fails here instead of being guarded as a no-op.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  FunctionFragment,
  ZeroAddress,
  encodeBytes32String,
  getAddress,
  zeroPadValue,
} from 'ethers'

// registers the EVM family, so EVM remote addresses decode to their canonical spelling
import '../../../evm/index.ts'
import { CCTParamsInvalidError } from '../../errors.ts'
import {
  MultiTokenPoolVersion,
  POOL_CONFIG_MANAGER_TYPE,
  getMultiTokenPoolInterface,
} from '../multi-token-pool/contracts.ts'
import { NO_RECORD_CHANGE_FUNCTIONS, decodeMultiTokenPoolWrite } from './calldata.ts'

const V = MultiTokenPoolVersion.V2_1_0_DEV
const PCM = getMultiTokenPoolInterface(POOL_CONFIG_MANAGER_TYPE, V)
const TOKEN = getAddress('0x' + 'a1'.repeat(20))
const POOL = getAddress('0x' + 'f1'.repeat(20))
const CCV = getAddress('0x' + 'dd'.repeat(20))
const CHAIN = 16015286601757825753n
const P = encodeBytes32String('p')
const bucket = (cap: bigint) => [cap > 0n, cap, cap / 10n]
const decode = (fn: string, args: unknown[]) =>
  decodeMultiTokenPoolWrite(PCM.encodeFunctionData(fn, args), V)

describe('PCM calldata decoding (cct/evm pool-config-manager)', () => {
  it('decodes every state-changing PCM function, or lists it as changing no record', () => {
    const writes = PCM.fragments.filter(
      (f): f is FunctionFragment =>
        f instanceof FunctionFragment &&
        f.stateMutability !== 'view' &&
        f.stateMutability !== 'pure',
    )
    assert.ok(writes.length > 30)
    for (const f of writes) {
      const data = PCM.encodeFunctionData(
        f,
        f.inputs.map((i) => zeroOf(i.type, i.components)),
      )
      assert.doesNotThrow(() => decodeMultiTokenPoolWrite(data, V), f.name)
    }
    for (const name of NO_RECORD_CHANGE_FUNCTIONS) assert.ok(PCM.getFunction(name), name)
  })

  it('refuses calldata that is not a PCM call', () => {
    assert.throws(() => decodeMultiTokenPoolWrite('0xdeadbeef', V), CCTParamsInvalidError)
  })

  it('decodes inline sets after removals, with canonical remote addresses', () => {
    const { changes } = decode('applyInlineRemotePoolConfigUpdates', [
      [[TOKEN, CHAIN]],
      [[TOKEN, CHAIN, true, [true, [[zeroPadValue(POOL, 32), true]]]]],
    ])
    assert.deepEqual(changes, [
      { kind: 'removeInline', type: 'remotePool', tokenAddress: TOKEN, remoteChainSelector: CHAIN },
      {
        kind: 'setInline',
        type: 'remotePool',
        record: {
          tokenAddress: TOKEN,
          remoteChainSelector: CHAIN,
          trustPolicyRemotePools: true,
          poolDataFormat: 'legacy',
          remotePools: [{ address: POOL, allowLegacyPoolData: true }],
        },
      },
    ])
  })

  it('decodes policy updates in store order: record removals, policy removals, sets', () => {
    const { changes } = decode('applySecurityPolicyConfigUpdates', [
      [[P, 0n]],
      [encodeBytes32String('old')],
      [[P, CHAIN, [[CCV], [], ZeroAddress]]],
    ])
    assert.deepEqual(changes, [
      { kind: 'removePolicyRecord', type: 'security', policyName: 'p', remoteChainSelector: 0n },
      { kind: 'removePolicy', type: 'security', policyName: 'old' },
      {
        kind: 'setPolicyRecord',
        type: 'security',
        record: {
          policyName: 'p',
          remoteChainSelector: CHAIN,
          securityConfig: { outboundCCVs: [CCV], inboundCCVs: [], hook: null },
        },
      },
    ])
  })

  it('decodes assignments, unassigning with the zero word', () => {
    const { changes } = decode('applyTokenFeePolicyUpdates', [
      [
        [TOKEN, P],
        [POOL, '0x' + '00'.repeat(32)],
      ],
    ])
    assert.deepEqual(changes, [
      { kind: 'assignPolicy', type: 'fee', tokenAddress: TOKEN, policyName: 'p' },
      { kind: 'assignPolicy', type: 'fee', tokenAddress: POOL, policyName: null },
    ])
  })

  it('decodes bucket updates to the bucket they set', () => {
    const { changes } = decode('applyInlineRateLimitBucketUpdates', [
      [
        [TOKEN, CHAIN, 1, true, bucket(100n)],
        [TOKEN, CHAIN, 0, false, bucket(0n)],
      ],
    ])
    assert.deepEqual(
      changes.map((c) => (c.kind === 'setInlineRateLimitBucket' ? c.bucket : c.kind)),
      ['fastFinalityInbound', 'outbound'],
    )
  })

  it('decodes pause directions: Outbound, Inbound, Both', () => {
    const flags = (direction: number) => decode('pauseChains', [[CHAIN], direction]).changes[0]
    assert.deepEqual(flags(0), {
      kind: 'setChainPause',
      remoteChainSelector: CHAIN,
      outbound: true,
    })
    assert.deepEqual(flags(1), { kind: 'setChainPause', remoteChainSelector: CHAIN, inbound: true })
    assert.deepEqual(flags(2), {
      kind: 'setChainPause',
      remoteChainSelector: CHAIN,
      outbound: true,
      inbound: true,
    })
    assert.deepEqual(decode('unpauseTokens', [[TOKEN], 2]).changes, [
      { kind: 'setTokenPause', tokenAddress: TOKEN, outbound: false, inbound: false },
    ])
    assert.deepEqual(decode('unpauseGlobally', []).changes, [
      { kind: 'setGlobalPause', paused: false },
    ])
  })

  it('decodes subset edits as removals, then additions', () => {
    const { changes } = decode('applySubsetTokenUpdates', [[[P, CHAIN, POOL]], [[P, CHAIN, TOKEN]]])
    assert.deepEqual(changes, [
      { kind: 'updateSubsetTokens', policyName: 'p', remoteChainSelector: CHAIN, remove: [POOL] },
      { kind: 'updateSubsetTokens', policyName: 'p', remoteChainSelector: CHAIN, add: [TOKEN] },
    ])
  })

  it('reports token profile updates separately: they change no lane record', () => {
    const r = decode('applyTokenProfileUpdates', [
      [POOL],
      [[TOKEN, 18, 0, '0x00000000', ZeroAddress, ZeroAddress]],
    ])
    assert.deepEqual(r.changes, [])
    assert.ok(r.profiles)
    assert.deepEqual(r.profiles.remove, [POOL])
    assert.equal(r.profiles.set[0]?.lockOrBurnAddress, null)
  })
})

/** A zero value of an ABI type, for encoding every function with empty arguments. */
function zeroOf(
  type: string,
  components?: readonly { type: string; components?: unknown }[] | null,
): unknown {
  if (type.endsWith(']')) return []
  if (type === 'tuple') return (components ?? []).map((c) => zeroOf(c.type, c.components as never))
  if (type === 'bool') return false
  if (type === 'address') return ZeroAddress
  if (type === 'bytes' || type === 'string') return '0x'
  if (type.startsWith('bytes')) return '0x' + '00'.repeat(Number(type.slice(5)))
  return 0
}
