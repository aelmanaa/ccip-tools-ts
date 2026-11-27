/**
 * applyMultiTokenPoolTokenProfileUpdates: what it refuses before any RPC. The write itself, and the
 * guards that read the chain, are built live in `write-ops.integration.test.ts`.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { getAddress } from 'ethers'

import { CCTParamsInvalidError } from '../../../errors.ts'
import { POOL, stackChain } from '../../multi-token-pool/stack.test.helpers.ts'
import { ApplyMultiTokenPoolTokenProfileUpdates } from './apply-multi-token-pool-token-profile-updates.ts'

const T = getAddress('0x' + 'a1'.repeat(20))
const EOA = getAddress('0x' + 'b2'.repeat(20))
const profile = {
  tokenAddress: T,
  lockOrBurnFlavor: 'burn',
  allowedFinality: { finalityDepth: 0 },
  lockOrBurnAddress: null,
  additionalPoolDataProvider: null,
} as const

describe('ApplyMultiTokenPoolTokenProfileUpdates (cct/evm pool-config-manager)', () => {
  it('refuses bad profiles and unconfirmed burn targets before any RPC', async () => {
    const { chain, calls } = stackChain()
    const set = (p: object) => ({ poolAddress: POOL, profilesToSet: [{ ...profile, ...p }] })
    for (const [bad, param] of [
      [{ poolAddress: POOL }, 'profilesToSet'],
      [set({ lockOrBurnFlavor: 'mint' }), 'profilesToSet[0].lockOrBurnFlavor'],
      [
        set({ allowedFinality: { finalityDepth: 70_000 } }),
        'profilesToSet[0].allowedFinality.finalityDepth',
      ],
      [set({ localDecimals: 300 }), 'profilesToSet[0].localDecimals'],
      [set({ lockOrBurnAddress: undefined }), 'profilesToSet[0].lockOrBurnAddress'],
      [set({ lockOrBurnFlavor: 'burn-to-address' }), 'profilesToSet[0].lockOrBurnAddress'],
      [
        set({ lockOrBurnFlavor: 'burn-to-address', lockOrBurnAddress: '0x' + '00'.repeat(20) }),
        'profilesToSet[0].lockOrBurnAddress',
      ],
      // an EOA sink receives every burnt token: confirmed by repeating it
      [set({ lockOrBurnFlavor: 'burn-to-address', lockOrBurnAddress: EOA }), 'confirmBurnAddress'],
      [{ poolAddress: POOL, profilesToUpdate: [{ tokenAddress: T }] }, 'profilesToUpdate[0]'],
      [
        { poolAddress: POOL, profilesToUpdate: [{ tokenAddress: T, localDecimals: 6 }] },
        'profilesToUpdate[0].localDecimals',
      ],
      [
        {
          poolAddress: POOL,
          profilesToSet: [profile],
          profilesToUpdate: [{ tokenAddress: T, allowedFinality: { finalityDepth: 1 } }],
        },
        'profilesToUpdate[0].tokenAddress',
      ],
      [
        {
          poolAddress: POOL,
          tokensToRemove: [T],
          profilesToUpdate: [{ tokenAddress: T, allowedFinality: { finalityDepth: 1 } }],
        },
        'profilesToUpdate[0].tokenAddress',
      ],
    ] as const)
      await assert.rejects(
        new ApplyMultiTokenPoolTokenProfileUpdates().generate(chain, bad as never),
        (e: unknown) => e instanceof CCTParamsInvalidError && e.context.param === param,
        param,
      )
    assert.deepEqual(calls, [])
  })

  it('accepts 0x…dEaD, or a confirmed sink, without confirmation errors', async () => {
    const { chain } = stackChain()
    for (const p of [
      {
        lockOrBurnFlavor: 'burn-to-address',
        lockOrBurnAddress: '0x000000000000000000000000000000000000dEaD',
      },
      { lockOrBurnFlavor: 'burn-to-address', lockOrBurnAddress: EOA },
    ])
      // past validation, the stub refuses the unknown token read: any error but a param one
      await assert.rejects(
        new ApplyMultiTokenPoolTokenProfileUpdates().generate(chain, {
          poolAddress: POOL,
          profilesToSet: [{ ...profile, ...p } as never],
          confirmBurnAddress: [EOA],
        }),
        (e: unknown) =>
          !(
            e instanceof CCTParamsInvalidError &&
            String(e.context.param).includes('lockOrBurnAddress')
          ) && !(e instanceof CCTParamsInvalidError && e.context.param === 'confirmBurnAddress'),
      )
  })
})
