/**
 * The multi-token pool bytecode is pinned to chainlink-ccip `c950d9bc` until a contracts-ccip
 * release ships it: each file's bytecode must hash to the sha256 its header records (and checks on
 * regeneration, through the source's git blob id). A file edited by hand, or regenerated from another source, fails here.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const DIR = import.meta.dirname
const files = readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))

describe('MTTP bytecode pins (2.1.0-dev, chainlink-ccip c950d9bc)', () => {
  it('vendors the nine multi-token pool contracts', () => {
    assert.equal(files.length, 9)
  })

  for (const file of files)
    it(`${file}: the bytecode hashes to the sha256 its header records and checks`, async () => {
      const source = readFileSync(join(DIR, file), 'utf8')
      const recorded = source.match(/^ \* sha256: ([0-9a-f]{64})$/m)?.[1]
      const blob = source.match(/^ \* blob: ([0-9a-f]{40})$/m)?.[1]
      const path = source.match(/^ \* source: (chains\/evm\/gobindings\/\S+\.go)$/m)?.[1]
      assert.ok(recorded, 'the header records a sha256')
      assert.ok(blob && path, 'the header records the source path and its blob id')
      assert.ok(
        source.includes(`if (blob !== '${blob}')`),
        'the generator checks the recorded blob id',
      )
      assert.ok(
        source.includes(`chainlink-ccip/raw/c950d9bcab28ec9f6d52c4e38919c81a45deb8ca/${path}')`),
        'the generator fetches the recorded source at the pinned commit',
      )
      const { default: bytecode } = (await import(join(DIR, file))) as { default: string }
      assert.match(bytecode, /^0x[0-9a-f]+$/)
      assert.equal(createHash('sha256').update(bytecode).digest('hex'), recorded)
    })
})
