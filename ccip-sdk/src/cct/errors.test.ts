import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CCIPError, CCIPErrorCode, getDefaultRecovery, shouldRetry } from '../errors/index.ts'
import * as root from '../index.ts'
import { CCTStateChangedError } from './errors.ts'

describe('CCTStateChangedError', () => {
  const changed = [{ path: 'profile.flavor', expected: 'burn', actual: 'lock' }]
  const error = new CCTStateChangedError('someWrite', 'token profile moved', {
    context: { changed },
  })

  it('is a permanent CCIPError with its own code and recovery hint', () => {
    assert.ok(error instanceof CCIPError)
    assert.equal(error.name, 'CCTStateChangedError')
    assert.equal(error.code, CCIPErrorCode.CCT_STATE_CHANGED)
    assert.equal(error.isTransient, false)
    assert.equal(shouldRetry(error), false)
    assert.equal(error.recovery, getDefaultRecovery(CCIPErrorCode.CCT_STATE_CHANGED))
    assert.match(error.recovery ?? '', /rebuild/)
  })

  it('keeps the caller context and adds operation and reason', () => {
    assert.deepEqual(error.context, {
      changed,
      operation: 'someWrite',
      reason: 'token profile moved',
    })
    assert.match(error.message, /^someWrite: .*token profile moved$/)
  })

  it('stays permanent even when the caller asks for transient', () => {
    const forced = new CCTStateChangedError('op', 'moved', { isTransient: true })
    assert.equal(forced.isTransient, false)
  })

  it('is exported from the package root with the other CCT errors', () => {
    assert.equal(root.CCTStateChangedError, CCTStateChangedError)
  })
})
