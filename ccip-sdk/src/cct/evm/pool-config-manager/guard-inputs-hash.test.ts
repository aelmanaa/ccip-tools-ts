import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { guardInputsHashOf } from './guard-run.ts'
import type { MultiTokenPoolGuardFacts } from './guards.ts'
import type { ProjectedMultiTokenPoolLane } from './projection.ts'

/** A stand-in lane: the hash only canonicalizes what it is given. */
const lane = (tag: string) => ({ tag }) as unknown as ProjectedMultiTokenPoolLane
const facts: MultiTokenPoolGuardFacts = {
  remoteLanes: new Map(),
  remotePools: new Map(),
  hookCallers: new Map(),
  servingPools: [],
  additionalPoolDataBytes: new Map(),
}
const own = [{ before: lane('own-before'), after: lane('own-after') }]

describe('guardInputsHashOf (E6 N4)', () => {
  it("a judged write seals the chain's other lanes: an edit on one makes the proposal stale", () => {
    assert.notEqual(
      guardInputsHashOf(true, own, [lane('other')], facts),
      guardInputsHashOf(true, own, [lane('other, edited')], facts),
    )
  })

  it('a write that judges nothing seals only its own lanes (R3 m4)', () => {
    assert.equal(
      guardInputsHashOf(false, own, [lane('other')], facts),
      guardInputsHashOf(false, own, [lane('other, edited')], facts),
    )
    assert.notEqual(
      guardInputsHashOf(false, own, [], facts),
      guardInputsHashOf(false, [{ before: lane('own-before'), after: lane('moved') }], [], facts),
    )
  })
})
