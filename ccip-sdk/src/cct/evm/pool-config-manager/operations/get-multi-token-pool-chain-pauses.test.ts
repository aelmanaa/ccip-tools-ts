import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { AbiCoder, toBeHex, zeroPadValue } from 'ethers'

import {
  CPS,
  POOL,
  STORE_IFACE,
  defaultStack,
  stackChain,
} from '../../multi-token-pool/stack.test.helpers.ts'
import { GetMultiTokenPoolChainPauses } from './get-multi-token-pool-chain-pauses.ts'

const CHAIN = 16015286601757825753n

describe('GetMultiTokenPoolChainPauses (cct/evm pool-config-manager)', () => {
  it('finds chains from the store logs and reports their current flags', async () => {
    const state = defaultStack()
    state.logs.push({
      address: CPS,
      blockNumber: 500,
      topics: [STORE_IFACE.getEvent('ChainPauseSet')!.topicHash, zeroPadValue(toBeHex(CHAIN), 32)],
      data: AbiCoder.defaultAbiCoder().encode(['bool', 'bool'], [true, false]),
    })
    state.views.getLaneConnectionBatch = ([lanes]) => [
      (lanes as unknown[]).map(() => [
        false,
        true,
        false,
        false,
        false,
        false,
        true,
        false,
        false,
        '0x',
        [],
      ]),
    ]
    const r = await new GetMultiTokenPoolChainPauses().query(stackChain(state).chain, {
      poolAddress: POOL,
    })
    assert.deepEqual(r.chains, [{ remoteChainSelector: CHAIN, outbound: true, inbound: false }])
    assert.equal(r.global, false)
    assert.equal(r.complete, true)
  })

  it('reads the global flag with no chain found', async () => {
    const state = defaultStack()
    state.views.getLaneConnectionBatch = ([lanes]) => [
      (lanes as unknown[]).map(() => [
        false,
        true,
        true,
        true,
        false,
        false,
        false,
        false,
        false,
        '0x',
        [],
      ]),
    ]
    const r = await new GetMultiTokenPoolChainPauses().query(stackChain(state).chain, {
      poolAddress: POOL,
      fromBlock: 200,
    })
    assert.deepEqual(r.chains, [])
    assert.equal(r.global, true)
    assert.equal(r.complete, false)
  })
})
