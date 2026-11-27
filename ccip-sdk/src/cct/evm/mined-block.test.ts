import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { latestBlock, noteMinedBlock } from './mined-block.ts'

describe('mined-block floor (cct/evm)', () => {
  it('never pins before the last block a write mined on the provider, per provider', async () => {
    let head = 100
    const provider = { getBlockNumber: async () => head }
    const chain = { provider } as never
    assert.equal(await latestBlock(chain), 100)
    // the receipt says 105, the provider still answers its cached 100
    noteMinedBlock(chain, 105)
    assert.equal(await latestBlock(chain), 105)
    // a later write at an older block does not lower the floor; the head moving past it wins
    noteMinedBlock(chain, 103)
    assert.equal(await latestBlock(chain), 105)
    head = 110
    assert.equal(await latestBlock(chain), 110)
    // another provider has its own floor
    const other = { provider: { getBlockNumber: async () => 50 } } as never
    assert.equal(await latestBlock(other), 50)
  })
})
