/**
 * The per-policy reads, policy names, subsets and inline configs, against the in-memory stack.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ZeroAddress, ZeroHash, encodeBytes32String, getAddress, zeroPadValue } from 'ethers'

// registers the EVM family, so EVM remote addresses decode to their canonical spelling
import '../../../../evm/index.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import {
  OTHER,
  PCM_IFACE,
  POOL,
  defaultStack,
  stackChain,
} from '../../multi-token-pool/stack.test.helpers.ts'
import { GetMultiTokenPoolConnectionPolicy } from './get-multi-token-pool-connection-policy.ts'
import { GetMultiTokenPoolFeePolicy } from './get-multi-token-pool-fee-policy.ts'
import { GetMultiTokenPoolInlineConfigs } from './get-multi-token-pool-inline-configs.ts'
import { GetMultiTokenPoolPolicyNames } from './get-multi-token-pool-policy-names.ts'
import { GetMultiTokenPoolRateLimitPolicy } from './get-multi-token-pool-rate-limit-policy.ts'
import { GetMultiTokenPoolSecurityPolicy } from './get-multi-token-pool-security-policy.ts'
import { GetMultiTokenPoolSubsetTokens } from './get-multi-token-pool-subset-tokens.ts'

const V5 = encodeBytes32String('v5')
const CHAIN = 16015286601757825753n
const TOKEN = getAddress('0x' + 'a1'.repeat(20))

/** The in-memory stack with a policy `v5` defined for every record type. */
function policyStack() {
  const state = defaultStack()
  state.views.getPolicyNames = () => Array.from({ length: 6 }, () => [V5])
  return state
}

describe('policy reads (cct/evm pool-config-manager)', () => {
  it('passes the encoded name and decodes a connection policy', async () => {
    const state = policyStack()
    const asked: unknown[] = []
    state.views.getConnectionPolicy = ([name]) => (
      asked.push(name),
      [2, OTHER, [[V5, CHAIN, true]]]
    )
    const r = await new GetMultiTokenPoolConnectionPolicy().query(stackChain(state).chain, {
      poolAddress: POOL,
      policyName: 'v5',
    })
    assert.deepEqual(asked, [V5])
    assert.deepEqual(r, {
      policyName: 'v5',
      exists: true,
      tokenCount: 2,
      remoteTokenAddressProvider: OTHER,
      records: [{ policyName: 'v5', remoteChainSelector: CHAIN, onlySubsetTokens: true }],
    })
  })

  it('re-keys rate limits to enabled; a policy keeps its stored decimals after its records go, a missing one reads null', async () => {
    const state = policyStack()
    const b = (on: boolean) => [on, on ? 100n : 0n, on ? 1n : 0n]
    state.views.getRateLimitPolicy = () => [
      1,
      18,
      [[V5, 0n, 18, [b(true), b(false), b(false), b(false)]]],
    ]
    const r = await new GetMultiTokenPoolRateLimitPolicy().query(stackChain(state).chain, {
      poolAddress: POOL,
      policyName: 'v5',
    })
    assert.equal(r.localDecimals, 18)
    assert.deepEqual(r.records[0]!.rateLimits.outbound, { enabled: true, capacity: 100n, rate: 1n })
    assert.deepEqual(r.records[0]!.rateLimits.inbound, { enabled: false, capacity: 0n, rate: 0n })
    // every record removed: the policy still exists, and the store still checks its decimals
    state.views.getRateLimitPolicy = () => [0, 18, []]
    const emptied = await new GetMultiTokenPoolRateLimitPolicy().query(stackChain(state).chain, {
      poolAddress: POOL,
      policyName: 'v5',
    })
    assert.equal(emptied.localDecimals, 18)
    // a policy that does not exist (its stored decimals read 0): null
    state.views.getPolicyNames = () => Array.from({ length: 6 }, () => [])
    state.views.getRateLimitPolicy = () => [0, 0, []]
    const missing = await new GetMultiTokenPoolRateLimitPolicy().query(stackChain(state).chain, {
      poolAddress: POOL,
      policyName: 'v5',
    })
    assert.equal(missing.exists, false)
    assert.equal(missing.localDecimals, null)
  })

  it('decodes fee and security records', async () => {
    const state = policyStack()
    state.views.getFeePolicy = () => [3, [[V5, CHAIN, [10, 20, 5, 15]]]]
    state.views.getSecurityPolicy = () => [3, [[V5, 0n, [[ZeroAddress], [], OTHER]]]]
    const { chain } = stackChain(state)
    const fee = await new GetMultiTokenPoolFeePolicy().query(chain, {
      poolAddress: POOL,
      policyName: 'v5',
    })
    assert.deepEqual(fee.records[0]!.feeConfig, {
      finalityFeeUSDCents: 10,
      fastFinalityFeeUSDCents: 20,
      finalityTransferFeeBps: 5,
      fastFinalityTransferFeeBps: 15,
    })
    const sec = await new GetMultiTokenPoolSecurityPolicy().query(chain, {
      poolAddress: POOL,
      policyName: 'v5',
    })
    assert.deepEqual(sec.records[0]!.securityConfig, {
      outboundCCVs: [ZeroAddress],
      inboundCCVs: [],
      hook: OTHER,
    })
  })

  it('tells a mistyped policy from an empty one, and echoes a raw name as hex', async () => {
    const state = policyStack()
    state.views.getFeePolicy = () => [0, []]
    const { chain } = stackChain(state)
    const typo = await new GetMultiTokenPoolFeePolicy().query(chain, {
      poolAddress: POOL,
      policyName: 'v6',
    })
    assert.deepEqual(typo, { policyName: 'v6', exists: false, tokenCount: 0, records: [] })
    const raw = '0x' + '78'.repeat(32)
    const byHex = await new GetMultiTokenPoolFeePolicy().query(chain, {
      poolAddress: POOL,
      policyName: raw,
    })
    assert.equal(byHex.policyName, raw)
    assert.equal(byHex.exists, false)
    // a defined policy with no records still exists
    const empty = await new GetMultiTokenPoolFeePolicy().query(chain, {
      poolAddress: POOL,
      policyName: 'v5',
    })
    assert.equal(empty.exists, true)
  })

  it('reads the policy and its existence at one block', async () => {
    const state = policyStack()
    state.views.getFeePolicy = () => [0, []]
    const { chain, callBlocks } = stackChain(state)
    await new GetMultiTokenPoolFeePolicy().query(chain, { poolAddress: POOL, policyName: 'v5' })
    const tags = callBlocks
      .filter((c) => c.name === 'getFeePolicy' || c.name === 'getPolicyNames')
      .map((c) => c.blockTag)
    assert.equal(tags.length, 2)
    assert.equal(new Set(tags).size, 1)
    assert.notEqual(tags[0], undefined)
  })

  it('rejects an invalid policy name before any RPC', async () => {
    const { chain, calls } = stackChain()
    for (const policyName of ['', 'x'.repeat(32), ZeroHash])
      await assert.rejects(
        new GetMultiTokenPoolFeePolicy().query(chain, { poolAddress: POOL, policyName }),
        (e: unknown) => e instanceof CCTParamsInvalidError && e.context.param === 'policyName',
      )
    assert.deepEqual(calls, [])
  })

  it('lists policy names per record type, text or raw', async () => {
    const state = defaultStack()
    const raw = '0x' + 'ff'.repeat(32)
    state.views.getPolicyNames = () => [[V5], [V5, raw], [], [], [], []]
    const r = await new GetMultiTokenPoolPolicyNames().query(stackChain(state).chain, {
      poolAddress: POOL,
    })
    assert.deepEqual(r, {
      connection: ['v5'],
      remotePool: ['v5', raw],
      rateLimit: [],
      fee: [],
      destOverhead: [],
      security: [],
    })
  })

  it('pages subset tokens at one block', async () => {
    const state = policyStack()
    const tokens = Array.from({ length: 250 }, (_, i) =>
      getAddress('0x' + (i + 1).toString(16).padStart(40, 'c')),
    )
    state.views.getSubsetTokens = ([, , start, max]) => [
      true,
      tokens.slice(Number(start), Number(start as bigint) + Number(max)),
    ]
    const r = await new GetMultiTokenPoolSubsetTokens().query(stackChain(state).chain, {
      poolAddress: POOL,
      policyName: 'v5',
      remoteChainSelector: CHAIN,
    })
    assert.deepEqual(r, {
      policyName: 'v5',
      exists: true,
      onlySubsetTokens: true,
      tokens,
      blockNumber: 1_000,
    })
  })

  it('reads only the requested inline types, decoding remote addresses', async () => {
    const state = defaultStack()
    state.views.getInlineConnectionConfigs = () => [[[TOKEN, CHAIN, zeroPadValue(OTHER, 32)]]]
    state.views.getInlineFeeConfigs = () => [[[TOKEN, CHAIN, [1, 2, 3, 4]]]]
    const { chain, calls } = stackChain(state)
    const r = await new GetMultiTokenPoolInlineConfigs().query(chain, {
      poolAddress: POOL,
      tokenAddress: TOKEN,
      types: ['connection'],
    })
    assert.deepEqual(r, {
      connection: [{ tokenAddress: TOKEN, remoteChainSelector: CHAIN, remoteToken: OTHER }],
    })
    // the fee view was not read, only the connection one
    assert.ok(
      !calls.some((c) => c.endsWith(PCM_IFACE.getFunction('getInlineFeeConfigs')!.selector)),
    )
    assert.ok(
      calls.some((c) => c.endsWith(PCM_IFACE.getFunction('getInlineConnectionConfigs')!.selector)),
    )
    await assert.rejects(
      new GetMultiTokenPoolInlineConfigs().query(chain, {
        poolAddress: POOL,
        tokenAddress: TOKEN,
        types: ['nope' as never],
      }),
      (e: unknown) => e instanceof CCTParamsInvalidError && e.context.param === 'types[0]',
    )
  })
})
