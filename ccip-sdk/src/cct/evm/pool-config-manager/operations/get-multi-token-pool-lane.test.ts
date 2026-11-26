/**
 * getMultiTokenPoolLane on the in-memory stack: the family-neutral mapping of the lane views.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ZeroAddress, ZeroHash, encodeBytes32String, getAddress, zeroPadValue } from 'ethers'

// registers the EVM family, so EVM remote addresses decode to their canonical spelling
import '../../../../evm/index.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { OTHER, POOL, defaultStack, stackChain } from '../../multi-token-pool/stack.test.helpers.ts'
import { GetMultiTokenPoolLane } from './get-multi-token-pool-lane.ts'

const TOKEN = getAddress('0x' + 'a1'.repeat(20))
const CHAIN = 16015286601757825753n
const HOOK = getAddress('0x' + 'cc'.repeat(20))
const bucket = (enabled: boolean, capacity: bigint, rate: bigint) => [
  capacity,
  1_700_000_000,
  enabled,
  capacity,
  rate,
]

/** A lane whose connection and fee come from policy `v5`, the rest inline; outbound stopped. */
function laneStack(o: { fee?: boolean; chainPaused?: boolean } = {}) {
  const state = defaultStack()
  state.views.getLaneConnectionBatch = () => [
    [
      [
        true,
        !!o.chainPaused,
        false,
        false,
        false,
        false,
        !!o.chainPaused,
        false,
        false,
        zeroPadValue(OTHER, 32),
        [{ remotePoolAddress: zeroPadValue(POOL, 32), allowLegacyPoolDataOnReceive: false }],
      ],
    ],
  ]
  // connection: policy chain (2), remote pool: inline (1), rate limit: inline, fee: policy default (3) or none
  state.views.getLaneRecordLevelBatch = () => [[2], [1], [1], [o.fee === false ? 0 : 3], [1], [1]]
  state.views.getTokenTransferFeeConfigBatch = () => [
    [[250_000, 224, 10, 20, 5, 15, o.fee !== false]],
  ]
  state.views.getCurrentRateLimiterStateBatch = () => [
    [[bucket(true, 0n, 0n), bucket(true, 100n, 1n), bucket(false, 0n, 0n), bucket(true, 50n, 1n)]],
  ]
  state.views.getLaneVerificationBatch = () => [[HOOK], [[ZeroAddress]], [[]]]
  state.views.getTokenConfigBatch = () => [
    [
      [
        true,
        18,
        0,
        '0x00000000',
        ZeroAddress,
        ZeroAddress,
        [CHAIN],
        encodeBytes32String('v5'),
        ZeroHash,
        ZeroHash,
        encodeBytes32String('v5'),
        ZeroHash,
        ZeroHash,
      ],
    ],
  ]
  return state
}

describe('GetMultiTokenPoolLane (cct/evm pool-config-manager)', () => {
  const params = { poolAddress: POOL, tokenAddress: TOKEN, remoteChainSelector: CHAIN }

  it('maps the lane views to the family-neutral lane', async () => {
    const lane = await new GetMultiTokenPoolLane().query(stackChain(laneStack()).chain, params)
    assert.equal(lane.family, 'EVM')
    assert.equal(lane.exists, true)
    assert.equal(lane.remoteToken, OTHER)
    assert.deepEqual(lane.sources.connection, { kind: 'policy', policy: { name: 'v5' } })
    assert.deepEqual(lane.sources.remotePool, { kind: 'inline' })
    assert.deepEqual(lane.sources.fee, { kind: 'default', policy: { name: 'v5' } })
    // an enabled 0/0 outbound bucket is a stop; a disabled fast bucket is omitted
    assert.deepEqual(lane.stopped, { outbound: true, inbound: false })
    assert.equal('fastFinalityOutbound' in lane.rateLimits, false)
    assert.deepEqual(lane.rateLimits.fastFinalityInbound, { tokens: 50n, capacity: 50n, rate: 1n })
    assert.equal(lane.tokenTransferFeeConfig?.destGasOverhead, 250_000)
    assert.deepEqual(lane.ccvs, { outbound: [ZeroAddress], inbound: [] })
    assert.equal(lane.hasHooks, true)
    assert.deepEqual(lane.outboundStatus, { status: 'ok' })
  })

  it('omits the fee config without a fee record, and reports what an outbound transfer misses', async () => {
    const lane = await new GetMultiTokenPoolLane().query(
      stackChain(laneStack({ fee: false })).chain,
      params,
    )
    assert.equal(lane.tokenTransferFeeConfig, undefined)
    assert.deepEqual(lane.sources.fee, { kind: 'none' })
    assert.deepEqual(lane.outboundStatus, { status: 'incomplete', missing: ['fee'] })
    assert.deepEqual(lane.inboundStatus, { status: 'ok' })
  })

  it('reports a chain pause as core LaneStatus', async () => {
    const lane = await new GetMultiTokenPoolLane().query(
      stackChain(laneStack({ chainPaused: true })).chain,
      params,
    )
    assert.deepEqual(lane.outboundStatus, {
      status: 'paused',
      scope: 'chain',
      direction: 'outbound',
    })
    assert.deepEqual(lane.inboundStatus, { status: 'ok' })
  })

  it('needs poolAddress or registryAddress, and refuses a malformed key, before any RPC', async () => {
    const { chain, calls } = stackChain()
    for (const [bad, param] of [
      [{ tokenAddress: TOKEN, remoteChainSelector: CHAIN }, 'poolAddress'],
      [{ ...params, tokenAddress: '0x12' }, 'tokenAddress'],
      [{ ...params, remoteChainSelector: -1n }, 'remoteChainSelector'],
    ] as const)
      await assert.rejects(
        new GetMultiTokenPoolLane().query(chain, bad as never),
        (e: unknown) => e instanceof CCTParamsInvalidError && e.context.param === param,
      )
    assert.deepEqual(calls, [])
  })
})
