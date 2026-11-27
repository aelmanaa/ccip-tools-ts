import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import '../../../index.ts'
import { networkInfo } from '../../../networks.ts'
import { CCTParamsInvalidError } from '../../errors.ts'
import { encodeType, poolGroupSectionsFixture } from './fixtures.test.helpers.ts'
import { exactSection, parseSectionUpdate, sectionArg } from './sections.ts'

const SEPOLIA = networkInfo('ethereum-testnet-sepolia').chainSelector
const POOL = '0x2222222222222222222222222222222222222222'
const refused = (param: string) => (e: unknown) =>
  e instanceof CCTParamsInvalidError && e.context.param === param

describe('pool-group section writes', () => {
  const current = poolGroupSectionsFixture()

  it('a FEE update merges over the record: omitted fields keep their value', () => {
    const update = parseSectionUpdate(
      'op',
      { policyClass: 'fee', tokenTransferFeeConfig: { finalityTransferFeeBps: 7 } },
      SEPOLIA,
    )
    const arg = sectionArg('op', { kind: 'update', update }, current, 1_000)
    assert.ok('fee' in arg)
    const fee = arg.fee![0].tokenTransferFeeConfig
    assert.equal(fee.finalityBpsFee, 7)
    assert.equal(fee.destBytesOverhead, 64)
    assert.equal(fee.fastFinalityBpsFee, 3)
  })

  it('a FEE above the cap is refused, as the program does', () => {
    const update = parseSectionUpdate(
      'op',
      { policyClass: 'fee', tokenTransferFeeConfig: { finalityTransferFeeBps: 500 } },
      SEPOLIA,
    )
    assert.throws(
      () => sectionArg('op', { kind: 'update', update }, current, 100),
      refused('section.tokenTransferFeeConfig'),
    )
  })

  it('a RATE_LIMIT update replaces only the buckets given', () => {
    const update = parseSectionUpdate(
      'op',
      {
        policyClass: 'rateLimit',
        rateLimit: { inbound: { enabled: true, capacity: 9n, rate: 1n } },
      },
      SEPOLIA,
    )
    const arg = sectionArg('op', { kind: 'update', update }, current, 1_000)
    assert.ok('rateLimit' in arg)
    assert.equal(arg.rateLimit![0].inbound.capacity.toString(), '9')
    assert.equal(arg.rateLimit![0].outbound.capacity.toString(), '100')
  })

  it('CONNECTION: pools in the chain spelling; a default takes 0x hex; at most 8, no duplicates', () => {
    const update = parseSectionUpdate(
      'op',
      {
        policyClass: 'connection',
        connection: { remotePools: [{ address: POOL, allowLegacyPoolData: false }] },
      },
      SEPOLIA,
    )
    const arg = sectionArg('op', { kind: 'update', update }, current, 1_000)
    assert.ok('connection' in arg)
    assert.equal(
      Buffer.from(arg.connection![0].remotePools[0]!.address.address).toString('hex'),
      POOL.slice(2),
    )
    // the format is kept
    assert.deepEqual(arg.connection![0].poolDataFormat, current.connection.poolDataFormat)
    assert.throws(
      () =>
        parseSectionUpdate(
          'op',
          {
            policyClass: 'connection',
            connection: { remotePools: [{ address: 'not hex', allowLegacyPoolData: false }] },
          },
          undefined,
        ),
      refused('section.connection.remotePools[0].address'),
    )
    const dup = { address: POOL, allowLegacyPoolData: false }
    assert.throws(
      () =>
        parseSectionUpdate(
          'op',
          { policyClass: 'connection', connection: { remotePools: [dup, dup] } },
          SEPOLIA,
        ),
      refused('section.connection.remotePools[1].address'),
    )
    assert.throws(
      () =>
        parseSectionUpdate(
          'op',
          {
            policyClass: 'connection',
            connection: { remotePools: Array.from({ length: 9 }, () => dup) },
          },
          SEPOLIA,
        ),
      refused('section.connection.remotePools'),
    )
  })

  it('refuses SECURITY, an unknown class, an empty update and an unknown bucket', () => {
    assert.throws(
      () => parseSectionUpdate('op', { policyClass: 'security' }, SEPOLIA),
      refused('section.policyClass'),
    )
    assert.throws(
      () => parseSectionUpdate('op', { policyClass: 'x' }, SEPOLIA),
      refused('section.policyClass'),
    )
    assert.throws(
      () => parseSectionUpdate('op', { policyClass: 'connection', connection: {} }, SEPOLIA),
      refused('section.connection'),
    )
    assert.throws(
      () =>
        parseSectionUpdate(
          'op',
          { policyClass: 'rateLimit', rateLimit: { sideways: { enabled: false } } },
          SEPOLIA,
        ),
      refused('section.rateLimit.sideways'),
    )
  })

  it("a proposal's exact section is kept as it is", () => {
    const idl = { rateLimit: { 0: current.rateLimit } }
    const exact = exactSection('op', idl)
    assert.equal(exact.kind, 'exact')
    assert.equal(sectionArg('op', exact, current, 0), idl)
    assert.throws(() => exactSection('op', { other: {} }), refused('transactions'))
    assert.ok(encodeType)
  })
})
