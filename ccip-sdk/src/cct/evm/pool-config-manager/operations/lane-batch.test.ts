/**
 * The six PCM lane batch views share validation, chunking and decoding rules; each view gets one
 * decoding case here, against the in-memory stack.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ZeroAddress, getAddress, zeroPadValue } from 'ethers'

// registers the EVM family, so EVM remote addresses decode to their canonical spelling
import '../../../../evm/index.ts'
import { CCTDataDecodeError, CCTParamsInvalidError } from '../../../errors.ts'
import {
  OTHER,
  POOL,
  STORE_IFACE,
  defaultStack,
  revert,
  stackChain,
} from '../../multi-token-pool/stack.test.helpers.ts'
import { GetMultiTokenPoolLaneConnections } from './get-multi-token-pool-lane-connections.ts'
import { GetMultiTokenPoolLaneFees } from './get-multi-token-pool-lane-fees.ts'
import { GetMultiTokenPoolLaneRateLimiterStates } from './get-multi-token-pool-lane-rate-limiter-states.ts'
import { GetMultiTokenPoolLaneRecordLevels } from './get-multi-token-pool-lane-record-levels.ts'
import { GetMultiTokenPoolLaneTokenTransferFeeConfigs } from './get-multi-token-pool-lane-token-transfer-fee-configs.ts'
import { GetMultiTokenPoolLaneVerifications } from './get-multi-token-pool-lane-verifications.ts'

const TOKEN = getAddress('0x' + 'a1'.repeat(20))
const ETH_SEPOLIA = 16015286601757825753n
const UNKNOWN = 123_456_789_123n
const lane = { tokenAddress: TOKEN, remoteChainSelector: ETH_SEPOLIA }

describe('lane batch views (cct/evm pool-config-manager)', () => {
  it('rejects bad lanes before any RPC, naming the entry', async () => {
    const { chain, calls } = stackChain()
    for (const [lanes, param] of [
      [[], 'lanes'],
      [[{ tokenAddress: 'x', remoteChainSelector: 1n }], 'lanes[0].tokenAddress'],
      [[{ tokenAddress: TOKEN, remoteChainSelector: -1n }], 'lanes[0].remoteChainSelector'],
    ] as const)
      await assert.rejects(
        new GetMultiTokenPoolLaneConnections().query(chain, {
          poolAddress: POOL,
          lanes: lanes as never,
        }),
        (e: unknown) => e instanceof CCTParamsInvalidError && e.context.param === param,
      )
    assert.deepEqual(calls, [])
  })

  it('decodes connections: format, canonical remote addresses, raw hex for an unknown chain', async () => {
    const state = defaultStack()
    state.views.getLaneConnectionBatch = ([lanes]) => [
      (lanes as unknown[]).map(() => [
        true,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        true,
        zeroPadValue(OTHER, 32),
        [
          { remotePoolAddress: zeroPadValue(POOL, 32), allowLegacyPoolDataOnReceive: true },
          { remotePoolAddress: '0x', allowLegacyPoolDataOnReceive: false },
        ],
      ]),
    ]
    const [known, unknown] = await new GetMultiTokenPoolLaneConnections().query(
      stackChain(state).chain,
      {
        poolAddress: POOL,
        lanes: [lane, { tokenAddress: TOKEN, remoteChainSelector: UNKNOWN }],
      },
    )
    assert.equal(known!.poolDataFormat, 'legacy')
    assert.equal(known!.remoteToken, OTHER)
    assert.deepEqual(known!.remotePools, [{ address: POOL, allowLegacyPoolData: true }])
    assert.equal(unknown!.remoteToken, zeroPadValue(OTHER, 32).toLowerCase())
    assert.equal(known!.tokenAddress, TOKEN)
  })

  it('decodes record levels per type', async () => {
    const state = defaultStack()
    state.views.getLaneRecordLevelBatch = () => [[1], [2], [3], [0], [1], [2]]
    const [r] = await new GetMultiTokenPoolLaneRecordLevels().query(stackChain(state).chain, {
      poolAddress: POOL,
      lanes: [lane],
    })
    assert.deepEqual(r!.levels, {
      connection: 'inline',
      remotePool: 'policy-chain',
      rateLimit: 'policy-default',
      fee: 'none',
      destOverhead: 'inline',
      security: 'policy-chain',
    })
  })

  it('marks lanes whose finality is disallowed instead of failing the batch', async () => {
    const state = defaultStack()
    const BAD = getAddress('0x' + 'b2'.repeat(20))
    state.views.getFeeBatch = ([lanes]) => {
      const keys = lanes as { localToken: string }[]
      if (keys.some((k) => getAddress(k.localToken) === BAD))
        throw revert(STORE_IFACE, 'InvalidRequestedFinality', ['0x00000005', '0x00000000'])
      return [keys.map(() => [12n, 90_000, 640, 25, true])]
    }
    const r = await new GetMultiTokenPoolLaneFees().query(stackChain(state).chain, {
      poolAddress: POOL,
      lanes: [lane, { tokenAddress: BAD, remoteChainSelector: ETH_SEPOLIA }],
      finality: 5,
    })
    assert.deepEqual(r[0], {
      ...lane,
      finalityNotAllowed: false,
      feeUSDCents: 12n,
      destGasOverhead: 90_000,
      destBytesOverhead: 640,
      tokenFeeBps: 25,
      isEnabled: true,
    })
    assert.deepEqual(r[1], {
      tokenAddress: BAD,
      remoteChainSelector: ETH_SEPOLIA,
      finalityNotAllowed: true,
    })
  })

  it('decodes fee configs, buckets and verifications', async () => {
    const state = defaultStack()
    const bucket = [5n, 1_700_000_000, true, 10n, 1n]
    state.views.getTokenTransferFeeConfigBatch = () => [[[90_000, 640, 10, 20, 5, 15, true]]]
    state.views.getCurrentRateLimiterStateBatch = () => [[[bucket, bucket, bucket, bucket]]]
    state.views.getLaneVerificationBatch = () => [[ZeroAddress], [[ZeroAddress, OTHER]], [[]]]
    const { chain } = stackChain(state)
    const [fee] = await new GetMultiTokenPoolLaneTokenTransferFeeConfigs().query(chain, {
      poolAddress: POOL,
      lanes: [lane],
    })
    assert.equal(fee!.fastFinalityTransferFeeBps, 15)
    const [rl] = await new GetMultiTokenPoolLaneRateLimiterStates().query(chain, {
      poolAddress: POOL,
      lanes: [lane],
    })
    assert.deepEqual(rl!.fastFinalityInbound, {
      tokens: 5n,
      lastUpdated: 1_700_000_000,
      isEnabled: true,
      capacity: 10n,
      rate: 1n,
    })
    const [v] = await new GetMultiTokenPoolLaneVerifications().query(chain, {
      poolAddress: POOL,
      lanes: [lane],
    })
    assert.deepEqual(v, {
      ...lane,
      hook: null,
      outboundCCVs: [ZeroAddress, OTHER],
      inboundCCVs: [],
    })
  })

  it('sends the requested finality as bytes4, and rejects a malformed one before any RPC', async () => {
    const state = defaultStack()
    const seen: unknown[] = []
    state.views.getFeeBatch = ([lanes, finality]) => (
      seen.push(finality),
      [(lanes as unknown[]).map(() => [0n, 0, 0, 0, false])]
    )
    const { chain, calls } = stackChain(state)
    for (const finality of [5, 'safe', 'finalized'] as const)
      await new GetMultiTokenPoolLaneFees().query(chain, {
        poolAddress: POOL,
        lanes: [lane],
        finality,
      })
    assert.deepEqual(seen, ['0x00000005', '0x00010000', '0x00000000'])
    const before = calls.length
    for (const finality of ['Safe', 1.5, 0, 70_000])
      await assert.rejects(
        new GetMultiTokenPoolLaneFees().query(chain, {
          poolAddress: POOL,
          lanes: [lane],
          finality: finality as never,
        }),
        (e: unknown) => e instanceof CCTParamsInvalidError && e.context.param === 'finality',
      )
    assert.equal(calls.length, before)
  })

  it('rethrows a fee revert other than a disallowed finality', async () => {
    const state = defaultStack()
    state.views.getFeeBatch = () => {
      throw revert(STORE_IFACE, 'LocalTokenNotRegistered', [TOKEN])
    }
    await assert.rejects(
      new GetMultiTokenPoolLaneFees().query(stackChain(state).chain, {
        poolAddress: POOL,
        lanes: [lane],
      }),
      (e: unknown) => (e as { code?: string }).code === 'CALL_EXCEPTION',
    )
  })

  it('throws on a stored remote address the remote family rejects, instead of hiding it', async () => {
    const state = defaultStack()
    state.views.getLaneConnectionBatch = ([lanes]) => [
      (lanes as unknown[]).map(() => [
        true,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        '0x' + 'ff'.repeat(12) + OTHER.slice(2), // dirty high bytes: not an EVM address word
        [],
      ]),
    ]
    await assert.rejects(
      new GetMultiTokenPoolLaneConnections().query(stackChain(state).chain, {
        poolAddress: POOL,
        lanes: [lane],
      }),
      CCTDataDecodeError,
    )
  })

  it('refuses a record level outside the enum instead of reading it as none', async () => {
    const state = defaultStack()
    state.views.getLaneRecordLevelBatch = () => [[7], [1], [1], [1], [1], [1]]
    await assert.rejects(
      new GetMultiTokenPoolLaneRecordLevels().query(stackChain(state).chain, {
        poolAddress: POOL,
        lanes: [lane],
      }),
      CCTDataDecodeError,
    )
  })

  it('refuses a view whose columns are shorter than the lanes, instead of an ethers error', async () => {
    const state = defaultStack()
    state.views.getLaneVerificationBatch = () => [[], [[]], [[]]]
    await assert.rejects(
      new GetMultiTokenPoolLaneVerifications().query(stackChain(state).chain, {
        poolAddress: POOL,
        lanes: [lane],
      }),
      CCTDataDecodeError,
    )
    state.views.getFeeBatch = () => [[]]
    await assert.rejects(
      new GetMultiTokenPoolLaneFees().query(stackChain(state).chain, {
        poolAddress: POOL,
        lanes: [lane],
      }),
      CCTDataDecodeError,
    )
  })
})
