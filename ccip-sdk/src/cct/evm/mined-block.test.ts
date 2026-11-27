import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CCIPBlockNotFoundError } from '../../errors/index.ts'
import { latestBlock, noteMinedBlock } from './mined-block.ts'

/** A provider whose cached head is `cached`, and whose node is at `node()` (uncached). */
function provider(cached: () => number, node: () => number = cached) {
  const sends: string[] = []
  return {
    sends,
    provider: {
      getBlockNumber: async () => cached(),
      send: async (method: string) => {
        sends.push(method)
        return `0x${node().toString(16)}`
      },
    },
  }
}

describe('mined-block floor (cct/evm)', () => {
  it('never pins before the last block a write mined: a cached head is re-read uncached', async () => {
    let node = 100
    const { provider: p, sends } = provider(
      () => 100,
      () => node,
    )
    const chain = { provider: p, network: { chainSelector: 1n } } as never
    assert.equal(await latestBlock(chain), 100)
    assert.deepEqual(sends, [])
    // the receipt says 105; the cache still answers 100, the node has 105
    node = 105
    noteMinedBlock(chain, 105)
    assert.equal(await latestBlock(chain), 105)
    assert.deepEqual(sends, ['eth_blockNumber'])
    // a later write at an older block does not lower the floor
    noteMinedBlock(chain, 103)
    assert.equal(await latestBlock(chain), 105)
  })

  it('keys the floor by chain selector: another EVMChain on the same network gets it', async () => {
    const a = { provider: provider(() => 200).provider, network: { chainSelector: 2n } } as never
    noteMinedBlock(a, 210)
    // a second chain object, another provider (another URL) on the same network
    const b = {
      provider: provider(
        () => 200,
        () => 210,
      ).provider,
      network: { chainSelector: 2n },
    }
    assert.equal(await latestBlock(b as never), 210)
    // another network has its own floor
    const c = { provider: provider(() => 50).provider, network: { chainSelector: 3n } } as never
    assert.equal(await latestBlock(c), 50)
  })

  it('fails with a documented, transient error when the node stays behind (lag or reorg)', async () => {
    const chain = {
      provider: provider(() => 300).provider,
      network: { chainSelector: 4n },
    } as never
    noteMinedBlock(chain, 305)
    await assert.rejects(latestBlock(chain), (e: unknown) => {
      assert.ok(e instanceof CCIPBlockNotFoundError)
      assert.equal(e.isTransient, true)
      assert.deepEqual([e.context.head, e.context.floor], [300, 305])
      assert.match(String(e.recovery), /rebuild the write/)
      return true
    })
  })

  it('falls back to a per-provider floor for a chain with no selector', async () => {
    const p = provider(
      () => 400,
      () => 410,
    ).provider
    noteMinedBlock({ provider: p } as never, 410)
    assert.equal(await latestBlock({ provider: p } as never), 410)
    assert.equal(await latestBlock({ provider: provider(() => 7).provider } as never), 7)
  })
})
