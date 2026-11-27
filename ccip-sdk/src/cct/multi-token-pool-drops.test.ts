import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

// the remote pool parser needs the families registered
import '../evm/index.ts'
import '../solana/index.ts'
import { CCTParamsInvalidError } from './errors.ts'
import {
  assertDropsConfirmed,
  droppedRemotePools,
  sealConfirmDropped,
} from './multi-token-pool-drops.ts'

// a Solana lane (base58 mint) toward an EVM chain, and one EVM pool trusted on it
const SEPOLIA = 16015286601757825753n
const MINT = 'So11111111111111111111111111111111111111112'
const POOL_A = '0x00000000000000000000000000000000000000a1'
const POOL_B = '0x00000000000000000000000000000000000000b2'
const lane = { tokenAddress: MINT, remoteChainSelector: SEPOLIA }

describe('multi-token pool drop confirmation (cct, family-neutral)', () => {
  it('finds dropped pools and a legacy flag turned off, and skips lanes without drops', () => {
    const dropped = droppedRemotePools([
      {
        lane,
        before: [
          { address: POOL_A, allowLegacyPoolData: true },
          { address: POOL_B, allowLegacyPoolData: false },
        ],
        after: [{ address: POOL_A, allowLegacyPoolData: false }],
      },
      { lane: { ...lane, remoteChainSelector: 1n }, before: [], after: [] },
    ])
    assert.deepEqual(dropped, [{ lane, remotePools: [POOL_B], flags: ['allowLegacyPoolData'] }])
  })

  it('refuses an unconfirmed drop with the shape to repeat, and passes a confirmed one in any spelling', () => {
    const dropped = [{ lane, remotePools: [POOL_B], flags: ['allowLegacyPoolData' as const] }]
    assert.throws(
      () => assertDropsConfirmed('op', dropped, [], { context: { recordType: 'remotePool' } }),
      (e: unknown) =>
        e instanceof CCTParamsInvalidError &&
        e.context.param === 'confirmDropped' &&
        e.context.recordType === 'remotePool' &&
        (e.context.dropped as unknown[]).length === 1,
    )
    // pools compare canonically (checksummed vs lower case)
    assertDropsConfirmed('op', dropped, [
      {
        lane,
        remotePools: [POOL_B.toUpperCase().replace('0X', '0x')],
        flags: ['allowLegacyPoolData'],
      },
    ])
    // the flag alone is not enough
    assert.throws(() => assertDropsConfirmed('op', dropped, [{ lane, remotePools: [POOL_B] }]))
  })

  it('seals confirmDropped stably: tokens in the family spelling, pools canonical, lanes and flags sorted', () => {
    const sealed = sealConfirmDropped(
      'op',
      [
        {
          lane: { ...lane, remoteChainSelector: 2n },
          flags: ['allowLegacyPoolData', 'allowLegacyPoolData'],
        },
        { lane, remotePools: [POOL_B, POOL_A] },
      ],
      (t) => String(t),
    )
    assert.equal(sealed?.length, 2)
    assert.equal(sealed![0]!.lane.remoteChainSelector, SEPOLIA)
    assert.equal(sealed![0]!.remotePools!.length, 2)
    assert.deepEqual(sealed![1]!.flags, ['allowLegacyPoolData'])
    assert.equal(sealConfirmDropped('op', [], String), undefined)
  })
})
