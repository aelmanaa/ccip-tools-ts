import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Keypair } from '@solana/web3.js'

import '../../../index.ts'
import { networkInfo } from '../../../networks.ts'
import { CCTParamsInvalidError, CCTStateChangedError } from '../../errors.ts'
import { assertDropsConfirmed } from '../../multi-token-pool-drops.ts'
import { laneFailsClosedFinding } from './lane.ts'
import { poolGroupGuardOptionsOf, sealPoolGroupSnapshot } from './write-guard.ts'

const SEPOLIA = networkInfo('ethereum-testnet-sepolia').chainSelector
const MINT = Keypair.generate().publicKey.toBase58()
const POOL_A = '0x2222222222222222222222222222222222222222'
const POOL_B = '0x3333333333333333333333333333333333333333'
const lane = { tokenAddress: MINT, remoteChainSelector: SEPOLIA }

describe('A21: dropped trusted remote pools', () => {
  it('refuses an unconfirmed drop, naming the lane and the pools', () => {
    assert.throws(
      () => assertDropsConfirmed('op', [{ lane, remotePools: [POOL_A, POOL_B] }], []),
      (e: unknown) => {
        assert.ok(e instanceof CCTParamsInvalidError)
        assert.equal(e.context.param, 'confirmDropped')
        assert.deepEqual(e.context.dropped, [{ lane, remotePools: [POOL_A, POOL_B], flags: [] }])
        return true
      },
    )
  })

  it('accepts a confirmed drop, any address spelling; a partial confirmation still refuses the rest', () => {
    assertDropsConfirmed(
      'op',
      [{ lane, remotePools: [POOL_A], flags: ['allowLegacyPoolData'] }],
      [
        {
          lane,
          remotePools: [POOL_A.toUpperCase().replace('0X', '0x')],
          flags: ['allowLegacyPoolData'],
        },
      ],
    )
    assert.throws(
      () =>
        assertDropsConfirmed(
          'op',
          [{ lane, remotePools: [POOL_A, POOL_B] }],
          [{ lane, remotePools: [POOL_A] }],
        ),
      (e: unknown) =>
        e instanceof CCTParamsInvalidError &&
        JSON.stringify(e.context.dropped, (_, v: unknown) =>
          typeof v === 'bigint' ? v.toString() : v,
        ).includes(POOL_B),
    )
  })

  it('another lane’s confirmation does not count', () => {
    const otherLane = {
      tokenAddress: Keypair.generate().publicKey.toBase58(),
      remoteChainSelector: SEPOLIA,
    }
    assert.throws(
      () =>
        assertDropsConfirmed(
          'op',
          [{ lane, remotePools: [POOL_A] }],
          [{ lane: otherLane, remotePools: [POOL_A] }],
        ),
      CCTParamsInvalidError,
    )
  })

  it('seals the options in a stable shape: lanes and pools sorted, empty dropped', () => {
    const b = Keypair.generate().publicKey.toBase58()
    const sealed = poolGroupGuardOptionsOf('op', {
      confirmDropped: [
        { lane: { tokenAddress: b, remoteChainSelector: SEPOLIA }, remotePools: [POOL_B, POOL_A] },
        { lane, flags: ['allowLegacyPoolData', 'allowLegacyPoolData'] },
      ],
    })
    const keys = sealed.confirmDropped!.map((d) => d.lane.tokenAddress)
    assert.deepEqual(keys, [...keys].sort())
    const withPools = sealed.confirmDropped!.find((d) => d.lane.tokenAddress === b)!
    assert.deepEqual(withPools.remotePools, [POOL_A, POOL_B])
    assert.deepEqual(sealed.confirmDropped!.find((d) => d.lane.tokenAddress === MINT)!.flags, [
      'allowLegacyPoolData',
    ])
    assert.deepEqual(poolGroupGuardOptionsOf('op', { confirmDropped: [] }), {})
    assert.throws(
      () =>
        poolGroupGuardOptionsOf('op', {
          confirmDropped: [{ lane: { tokenAddress: 'not-a-key', remoteChainSelector: SEPOLIA } }],
        }),
      CCTParamsInvalidError,
    )
  })
})

describe('laneFailsClosedFinding', () => {
  it('maps the fee cap to TRANSFER_FEE_ABOVE_CAP and the rest to CCVS_NOT_SYNCED', () => {
    assert.equal(laneFailsClosedFinding('BpsFeeAboveGroupMax').check, 'TRANSFER_FEE_ABOVE_CAP')
    assert.equal(laneFailsClosedFinding('PolicySecurityStale').check, 'CCVS_NOT_SYNCED')
    assert.equal(laneFailsClosedFinding('GroupCcvsNotSynced').recordType, 'security')
  })
})

describe('sealPoolGroupSnapshot with expectedSnapshot', () => {
  const seal = (expected: Record<string, unknown>, calldataHash: string, operation = 'op') =>
    sealPoolGroupSnapshot({
      operation,
      slot: 1n,
      expected,
      guardOptions: {},
      guardInputsHash: 'none',
      calldataHash,
    })
  const HASH_A = `0x${'aa'.repeat(32)}`
  const HASH_B = `0x${'bb'.repeat(32)}`

  it('state moved and other instructions: the move is reported (CCTStateChangedError)', async () => {
    const snapshot = await seal({ 'group.roles': 'x' }, HASH_A)
    await assert.rejects(
      sealPoolGroupSnapshot({
        operation: 'op',
        slot: 2n,
        expected: { 'group.roles': 'y' },
        guardOptions: {},
        guardInputsHash: 'none',
        calldataHash: HASH_B,
        expectedSnapshot: snapshot,
      }),
      (e: unknown) => e instanceof CCTStateChangedError && /group\.roles/.test(e.message),
    )
  })

  it('a snapshot of another op is refused as params, not as a state move', async () => {
    const snapshot = await seal({ 'group.roles': 'x' }, HASH_A, 'otherOp')
    await assert.rejects(
      sealPoolGroupSnapshot({
        operation: 'op',
        slot: 2n,
        expected: { 'group.roles': 'y' },
        guardOptions: {},
        guardInputsHash: 'none',
        calldataHash: HASH_B,
        expectedSnapshot: snapshot,
      }),
      (e: unknown) => e instanceof CCTParamsInvalidError && !(e instanceof CCTStateChangedError),
    )
  })

  it('the same state and instructions hold', async () => {
    const snapshot = await seal({ 'group.roles': 'x' }, HASH_A)
    await sealPoolGroupSnapshot({
      operation: 'op',
      slot: 2n,
      expected: { 'group.roles': 'x' },
      guardOptions: {},
      guardInputsHash: 'none',
      calldataHash: HASH_A,
      expectedSnapshot: snapshot,
    })
  })
})
