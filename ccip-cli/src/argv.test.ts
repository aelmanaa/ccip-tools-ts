import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import yargs from 'yargs'

import { coerceFormat, lastIfRepeated, preprocessArgv } from './argv.ts'
import { Format } from './commands/index.ts'

/** Keep argv untouched by the non-TTY `--no-interactive` append, which has its own test below. */
const rewrite = (...argv: string[]) => preprocessArgv(argv, true)

/** A repeated shorthand must behave like the single flag it stands for — see {@link lastIfRepeated}. */
describe('preprocessArgv shorthand rewrites', () => {
  it('rewrites each shorthand to its canonical form', () => {
    assert.deepEqual(rewrite('--json'), ['--format=json'])
    assert.deepEqual(rewrite('--no-api'), ['--api=false'])
    assert.deepEqual(rewrite('--no-estimate-gas-limit'), ['--estimate-gas-limit=-100'])
  })

  it('rewrites every occurrence, leaving the collapse to each option coerce', () => {
    // Collapsing is each option's `coerce`; see preprocessArgv. `parsed option values` pins the result.
    assert.deepEqual(rewrite('--json', '--json'), ['--format=json', '--format=json'])
    assert.deepEqual(rewrite('--no-api', '--no-api'), ['--api=false', '--api=false'])
  })

  it('keeps unrelated args and their order', () => {
    assert.deepEqual(rewrite('show', '0xabc', '--json', '--rpc', 'url'), [
      'show',
      '0xabc',
      '--format=json',
      '--rpc',
      'url',
    ])
  })

  it('leaves args that collide with Object.prototype keys untouched', () => {
    for (const arg of ['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__']) {
      assert.deepEqual(rewrite('parse', arg), ['parse', arg])
    }
  })

  it('never rewrites past a `--` separator', () => {
    assert.deepEqual(rewrite('parse', '0xabc', '--', '--json'), ['parse', '0xabc', '--', '--json'])
  })

  it('appends --no-interactive only for a non-TTY stdin, and only once', () => {
    assert.deepEqual(preprocessArgv(['--json'], false), ['--format=json', '--no-interactive'])
    assert.deepEqual(preprocessArgv(['--json', '--no-interactive'], false), [
      '--format=json',
      '--no-interactive',
    ])
    assert.deepEqual(preprocessArgv(['--json'], true), ['--format=json'])
  })
})

describe('lastIfRepeated', () => {
  it('passes a scalar through unchanged', () => {
    assert.equal(lastIfRepeated('json'), 'json')
    assert.equal(lastIfRepeated(undefined), undefined)
  })

  it('takes the last occurrence of a repeated option, so it is never an array', () => {
    assert.equal(lastIfRepeated(['json', 'json']), 'json')
    assert.equal(lastIfRepeated(['json', 'log']), 'log')
    assert.equal(lastIfRepeated([-100, 10]), 10)
  })
})

describe('coerceFormat', () => {
  it('collapses repeats to the last occurrence', () => {
    assert.equal(coerceFormat(Format.json), Format.json)
    assert.equal(coerceFormat([Format.json, Format.json]), Format.json)
    assert.equal(coerceFormat([Format.json, Format.log]), Format.log)
  })

  it('surfaces an invalid occurrence in either position, for yargs `choices` to reject', () => {
    const bogus = 'bogus' as Format
    assert.equal(coerceFormat([bogus, Format.json]), bogus)
    assert.equal(coerceFormat([Format.json, bogus]), bogus)
  })
})

/** The layer commands actually consume: the parsed option value, not the argv strings. */
describe('parsed option values', () => {
  const globalOpts = {
    format: { choices: Object.values(Format), default: Format.pretty, coerce: coerceFormat },
    api: {
      type: 'string',
      coerce: (arg: string | string[] | undefined): string | boolean => {
        const value = lastIfRepeated(arg)
        if (value === 'false' || value === 'no') return false
        if (value == null || value === 'true' || value === 'yes') return true
        return value
      },
    },
  } as const
  const parse = (...argv: string[]) =>
    yargs(preprocessArgv(argv, true)).options(globalOpts).parseSync()

  it('resolves a repeated --json to the json format', () => {
    assert.equal(parse('--json').format, Format.json)
    assert.equal(parse('--json', '--json').format, Format.json)
    assert.equal(parse('--format', 'json', '--format', 'json').format, Format.json)
    assert.equal(parse('--format', 'json', '--format', 'log').format, Format.log)
  })

  it('keeps a repeated --no-api disabled instead of re-enabling the API', () => {
    assert.equal(parse('--no-api').api, false)
    assert.equal(parse('--no-api', '--no-api').api, false)
    assert.equal(parse('--api', 'https://example.test').api, 'https://example.test')
    assert.equal(parse('--api=true').api, true)
    // Absent: yargs skips `coerce` for an option with no default, so it stays undefined — which
    // consumers read as enabled (`argv.api !== false`, e.g. show.ts / manual-exec.ts).
    assert.equal(parse().api, undefined)
  })
})
