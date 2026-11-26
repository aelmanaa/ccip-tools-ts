import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { ZeroHash, encodeBytes32String } from 'ethers'

import { CCTParamsInvalidError } from '../../errors.ts'
import {
  LANE_BATCH_SIZE,
  decodePolicyName,
  encodePolicyName,
  readLaneBatches,
} from './contracts.ts'

describe('policy names', () => {
  it('encodes text left-aligned (not keccak) and decodes it back', () => {
    const word = encodePolicyName('op', 'p', 'v5')
    assert.equal(word, encodeBytes32String('v5'))
    assert.equal(decodePolicyName(word), 'v5')
  })

  it('passes a raw bytes32 through, and decodes a non-printable id as hex', () => {
    const raw = '0x' + 'ab'.repeat(32)
    assert.equal(encodePolicyName('op', 'p', raw.toUpperCase().replace('0X', '0x')), raw)
    assert.equal(decodePolicyName(raw), raw)
  })

  it('reads the zero word as no policy, and refuses to write it', () => {
    assert.equal(decodePolicyName(ZeroHash), null)
    assert.throws(() => encodePolicyName('op', 'p', ZeroHash), CCTParamsInvalidError)
  })

  it('refuses empty, too long and non-printable names, with a typed error', () => {
    // 32 bytes leaves no NUL terminator: such a name is written (and read back) as raw hex
    for (const name of ['', 'x'.repeat(32), 'x'.repeat(33), 'tab\tname', 1])
      assert.throws(() => encodePolicyName('op', 'p', name), CCTParamsInvalidError)
  })

  it('round-trips a 31-character name, and reads a full 32-byte word as raw hex', () => {
    const name = 'n'.repeat(31)
    assert.equal(decodePolicyName(encodePolicyName('op', 'p', name)), name)
    const full = '0x' + '78'.repeat(32)
    assert.equal(decodePolicyName(full), full)
    assert.equal(encodePolicyName('op', 'p', full), full)
  })
})

describe('readLaneBatches', () => {
  it('reads in chunks of 100, in parallel, keeping input order', async () => {
    const lanes = Array.from({ length: 2 * LANE_BATCH_SIZE + 5 }, (_, i) => ({
      tokenAddress: '0x' + i.toString(16).padStart(40, '0'),
      remoteChainSelector: BigInt(i),
    }))
    const sizes: number[] = []
    const out = await readLaneBatches(lanes, async (chunk) => {
      sizes.push(chunk.length)
      return chunk.map((l) => l.remoteChainSelector)
    })
    assert.deepEqual(sizes, [100, 100, 5])
    assert.deepEqual(
      out,
      lanes.map((l) => l.remoteChainSelector),
    )
  })
})
