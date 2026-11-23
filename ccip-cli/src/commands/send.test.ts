import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { describeCCVCoverage } from './send.ts'

describe('describeCCVCoverage', () => {
  it('flags a message carrying fewer CCVs than needed', () => {
    assert.equal(
      describeCCVCoverage({ messageCCVs: ['0x1'], needed: 2, enoughCCVs: false }),
      'NOT ENOUGH: the message carries 1 CCV; the destination needs 2 (requiredCCVs + optionalThreshold): the executor will not execute it',
    )
  })

  it('reports a sufficient count', () => {
    assert.equal(
      describeCCVCoverage({ messageCCVs: ['0x1', '0x2'], needed: 2, enoughCCVs: true }),
      'the message carries 2 CCVs; the destination needs 2 (requiredCCVs + optionalThreshold): enough by count',
    )
  })

  it('says when the source side is unknown', () => {
    assert.match(
      describeCCVCoverage({ needed: 1 }),
      /the source will put on the message are unknown/,
    )
  })
})
