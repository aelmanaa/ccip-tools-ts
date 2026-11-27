/** The pure parts of the S5 ops: subset bounds and updates, member remote tokens, shared tokens. */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import '../../../index.ts'
import { networkInfo } from '../../../networks.ts'
import { CCTParamsInvalidError } from '../../errors.ts'
import { applySubset, checkSubsetBounds } from './operations/driven-lanes.ts'
import {
  memberEntriesOf,
  parseMemberChains,
  publicRemoteTokens,
  requireAdmissionAcknowledged,
  requireOwnRemoteTokens,
} from './operations/members-common.ts'

const SEPOLIA = networkInfo('ethereum-testnet-sepolia').chainSelector
const FUJI = networkInfo('avalanche-testnet-fuji').chainSelector
const SOLANA = networkInfo('solana-devnet').chainSelector
const TOKEN = '0xcd686cd10978a16d0a93375ac8de9aa141eed2f1'
const param = (name: string) => (e: unknown) =>
  e instanceof CCTParamsInvalidError && e.context.param === name

describe('subset bounds (apply_subset_updates)', () => {
  it('indices below nextMemberIndex; a write within ceil(next / 8) bytes with spare bits clear', () => {
    checkSubsetBounds('op', 10, [{ param: 'add', values: [0, 9] }], {
      byteOffset: 0,
      bytes: Uint8Array.of(0xff, 0x03),
    })
    assert.throws(() => checkSubsetBounds('op', 10, [{ param: 'add', values: [10] }]), param('add'))
    // byte 2 is past the 2 bytes 10 members use
    assert.throws(
      () => checkSubsetBounds('op', 10, [], { byteOffset: 1, bytes: Uint8Array.of(0, 0) }),
      param('bitmapWrite'),
    )
    // bit 10 (byte 1, bit 2) belongs to no member yet
    assert.throws(
      () => checkSubsetBounds('op', 10, [], { byteOffset: 1, bytes: Uint8Array.of(0x04) }),
      /InvalidMemberIndex/,
    )
    // a full last byte has no spare bits
    checkSubsetBounds('op', 16, [], { byteOffset: 1, bytes: Uint8Array.of(0xff) })
  })

  it('applies the raw write, then removals, then additions, growing the bitmap', () => {
    const out = applySubset(
      Buffer.from([0b0000_0011]),
      { byteOffset: 0, bytes: Uint8Array.of(0x0f) },
      [1],
      [9],
    )
    assert.deepEqual([...out], [0b0000_1101, 0b0000_0010])
  })
})

describe('member remote tokens', () => {
  it('parses per chain (EVM stored padded), regroups chains that share a token, refuses repeats', () => {
    const chains = parseMemberChains('op', 'remoteTokens', [
      { remoteChainSelectors: [SEPOLIA, FUJI], token: TOKEN, decimals: 18 },
    ])
    assert.equal(chains.get(SEPOLIA)!.token.length, 32)
    assert.equal(memberEntriesOf(chains).length, 1)
    assert.deepEqual(publicRemoteTokens(chains)[0]!.remoteChainSelectors, [SEPOLIA, FUJI])
    assert.throws(
      () =>
        parseMemberChains('op', 'remoteTokens', [
          { remoteChainSelectors: [SEPOLIA], token: TOKEN, decimals: 18 },
          { remoteChainSelectors: [SEPOLIA], token: TOKEN, decimals: 6 },
        ]),
      /listed twice/,
    )
    assert.throws(() =>
      parseMemberChains('op', 'remoteTokens', [
        { remoteChainSelectors: [SEPOLIA, SOLANA], token: TOKEN, decimals: 18 },
      ]),
    )
  })

  it('REMOTE_TOKEN_SHARED: a token another member lists on the chain is refused', () => {
    const mine = parseMemberChains('op', 'r', [
      { remoteChainSelectors: [SEPOLIA], token: TOKEN, decimals: 18 },
    ])
    assert.throws(
      () =>
        requireOwnRemoteTokens(
          'op',
          'p',
          [{ mint: 'A', chains: mine }],
          [{ mint: 'B', chains: mine }],
        ),
      /REMOTE_TOKEN_SHARED/,
    )
    // the same member rewriting its own list is no sharing
    requireOwnRemoteTokens('op', 'p', [{ mint: 'A', chains: mine }], [{ mint: 'A', chains: mine }])
  })

  it('live admission: refused unless each lane is acknowledged', () => {
    const l = { tokenAddress: 'A', remoteChainSelector: SEPOLIA }
    assert.throws(
      () => requireAdmissionAcknowledged('op', [l], []),
      param('acknowledgeLiveAdmission'),
    )
    requireAdmissionAcknowledged('op', [l], [l])
    requireAdmissionAcknowledged('op', [l], 'all')
  })
})
