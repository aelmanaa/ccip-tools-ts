import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { getAddress } from 'ethers'

import { CCTParamsInvalidError } from '../../../errors.ts'
import { PCM, defaultStack, stackChain } from '../../multi-token-pool/stack.test.helpers.ts'
import { GetMultiTokenPoolConfiguredTokens } from './get-multi-token-pool-configured-tokens.ts'

describe('GetMultiTokenPoolConfiguredTokens (cct/evm pool-config-manager)', () => {
  it('pages to the end, every page at one block', async () => {
    const state = defaultStack()
    state.pcm.tokens = Array.from({ length: 5 }, (_, i) =>
      getAddress('0x' + (i + 1).toString(16).padStart(40, 'a')),
    )
    const blockTags: unknown[] = []
    const { chain } = stackChain(state)
    const call = chain.provider.call.bind(chain.provider)
    chain.provider.call = (tx: { blockTag?: unknown }) => (
      blockTags.push(tx.blockTag),
      call(tx as never)
    )
    const r = await new GetMultiTokenPoolConfiguredTokens().query(chain, {
      poolConfigManager: PCM,
      pageSize: 2,
    })
    assert.deepEqual(r, { tokens: state.pcm.tokens, blockNumber: 1_000 })
    // 3 pages after typeAndVersion: 2 + 2 + 1, each pinned to block 1000
    assert.deepEqual(blockTags.slice(-3).map(Number), [1_000, 1_000, 1_000])
  })

  it('rejects a zero page size before any RPC', async () => {
    const { chain, calls } = stackChain()
    await assert.rejects(
      new GetMultiTokenPoolConfiguredTokens().query(chain, { poolConfigManager: PCM, pageSize: 0 }),
      CCTParamsInvalidError,
    )
    assert.deepEqual(calls, [])
  })
})
