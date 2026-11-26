import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'

import { BN, BorshAccountsCoder } from '@coral-xyz/anchor'
import { Keypair, PublicKey } from '@solana/web3.js'

import { CCTDataDecodeError } from '../../errors.ts'
import {
  GROUP_CHAIN_POLICY_FIXED_LEN,
  LANE_DRIVEN_MARKER,
  LANE_LINKED_MARKER,
  decodePoolGroupChainConfigV2,
  decodePoolGroupIdlAccount,
  decodePoolGroupLaneMarker,
  decodePoolGroupMember,
  decodePoolGroupRegistry,
  poolGroupChainAdmits,
  poolGroupsCoder,
} from './accounts.ts'

const u32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(n)
  return b
}
const key = () => Keypair.generate().publicKey

describe('pool-group account decoders', () => {
  it('markers are the program constants', () => {
    const tag = (s: string) => createHash('sha256').update(s).digest().subarray(0, 8)
    assert.ok(LANE_LINKED_MARKER.equals(tag('ccip_tokenpool:lane_extended')))
    assert.ok(LANE_DRIVEN_MARKER.equals(tag('ccip_tokenpool:lane_group_driven')))
  })

  it('reads the lane marker only right after the standard length', () => {
    const base = { remote: { poolAddresses: [{ address: Buffer.alloc(20) }] } } as const
    const standard = 8 + 139 + 24
    const at = (len: number, marker?: Buffer) => {
      const data = Buffer.alloc(len)
      marker?.copy(data, len - 8)
      return decodePoolGroupLaneMarker(data, base)
    }
    assert.equal(at(standard), 'standard')
    assert.equal(at(standard + 8, LANE_LINKED_MARKER), 'linked')
    assert.equal(at(standard + 8, LANE_DRIVEN_MARKER), 'driven')
    assert.equal(at(standard + 8, Buffer.alloc(8, 1)), 'standard')
    assert.equal(at(standard + 9, LANE_LINKED_MARKER), 'standard')
  })

  it('decodes a GroupMember to its exact length, lane payers included', () => {
    const group = key()
    const mint = key()
    const payer = key()
    const data = Buffer.concat([
      Buffer.from('64c8588f53e3a5a6', 'hex'),
      Buffer.from([1, 254]),
      group.toBuffer(),
      mint.toBuffer(),
      u32(7),
      u32(1),
      PublicKey.default.toBuffer(),
      u32(1), // remote_tokens
      u32(2),
      u64(1n),
      u64(2n),
      u32(20),
      Buffer.alloc(20, 0xab),
      Buffer.from([18]),
      u32(1), // lane_payers
      u64(2n),
      payer.toBuffer(),
    ])
    const member = decodePoolGroupMember(data, 'm')
    assert.equal(member.poolGroupAddress, group.toBase58())
    assert.equal(member.mint, mint.toBase58())
    assert.equal(member.memberIndex, 7)
    assert.deepEqual(member.remoteTokens[0]?.remoteChainSelectors, [1n, 2n])
    assert.equal(member.remoteTokens[0].decimals, 18)
    assert.deepEqual(member.lanePayers, [{ remoteChainSelector: 2n, payer: payer.toBase58() }])
    assert.throws(
      () => decodePoolGroupMember(Buffer.concat([data, Buffer.alloc(1)]), 'm'),
      CCTDataDecodeError,
    )
    assert.throws(
      () => decodePoolGroupMember(data.subarray(0, data.length - 1), 'm'),
      CCTDataDecodeError,
    )
  })

  it('decodes a GroupRegistry of exactly 82 bytes', () => {
    const group = key()
    const data = Buffer.concat([
      Buffer.from('c746ff66717a8902', 'hex'),
      Buffer.from([1, 255]),
      group.toBuffer(),
      u32(10),
      u32(3),
      Buffer.alloc(32),
    ])
    assert.deepEqual(decodePoolGroupRegistry(data, 'r'), {
      version: 1,
      poolGroupAddress: group.toBase58(),
      nextMemberIndex: 10,
      memberCount: 3,
    })
    assert.throws(() => decodePoolGroupRegistry(data.subarray(0, 81), 'r'), CCTDataDecodeError)
  })

  it('decodes ChainConfigV2 versions 1 and 2 at their exact lengths', () => {
    const mint = key()
    const policy = key()
    const body = (version: number) =>
      Buffer.concat([
        BorshAccountsCoder.accountDiscriminator('ChainConfigV2'),
        Buffer.from([255, version]),
        u64(5n),
        mint.toBuffer(),
        Buffer.alloc(4 + 21 + 8),
        u32(1),
        key().toBuffer(),
        u32(0),
        u32(0),
        u32(0),
      ])
    const v1 = decodePoolGroupChainConfigV2(body(1), 'a')
    assert.equal(v1.version, 1)
    assert.equal(v1.remoteChainSelector, 5n)
    assert.equal(v1.mint, mint.toBase58())
    assert.equal(v1.ext, null)
    assert.equal(v1.ccvs.outbound.length, 1)
    assert.deepEqual(v1.ccvs.inbound, [])
    assert.throws(() =>
      decodePoolGroupChainConfigV2(Buffer.concat([body(1), Buffer.alloc(1)]), 'a'),
    )

    const group = key()
    const tail = Buffer.concat([
      group.toBuffer(),
      Buffer.from([1, 2, 0, 5]),
      policy.toBuffer(),
      Buffer.alloc(96),
      Buffer.from([1, 0, 1]),
      u64(9n),
      Buffer.from([1]),
      u32(4),
      Buffer.alloc(27),
      Buffer.from([1]),
      Buffer.alloc(32, 0xcd),
      Buffer.from([1]),
      u32(0),
      u32(1),
      key().toBuffer(),
      u64(10n),
      u64(11n),
    ])
    const v2 = decodePoolGroupChainConfigV2(Buffer.concat([body(2), tail]), 'a')
    assert.equal(v2.ext?.poolGroupAddress, group.toBase58())
    assert.deepEqual(v2.ext.classSource, {
      connection: { kind: 'default' },
      fee: { kind: 'policy', slot: 0 },
      rateLimit: { kind: 'inline' },
      security: { kind: 'policy', slot: 3 },
    })
    assert.deepEqual(v2.ext.policySlots, [policy.toBase58(), null, null, null])
    assert.equal(v2.ext.pausedOutbound, true)
    assert.equal(v2.ext.poolDataFormat, 'long')
    assert.equal(v2.ext.groupDriven, true)
    assert.equal(v2.ext.memberIndex, 4)
    assert.equal(v2.ext.uid, `0x${'cd'.repeat(32)}`)
    assert.equal(v2.ext.ccvPending?.activatesAt, 11n)
    const bad = (mutate: (b: Buffer) => void) => {
      const data = Buffer.concat([body(2), tail])
      mutate(data)
      return () => decodePoolGroupChainConfigV2(data, 'a')
    }
    const tailAt = body(2).length
    assert.throws(
      bad((b) => (b[tailAt + 35] = 6)),
      CCTDataDecodeError,
    ) // class source
    assert.throws(
      bad((b) => (b[tailAt + 166] = 2)),
      CCTDataDecodeError,
    ) // pool data format
    assert.throws(
      bad((b) => (b[9] = 3)),
      CCTDataDecodeError,
    ) // version
    assert.throws(() =>
      decodePoolGroupChainConfigV2(Buffer.concat([body(2), tail, Buffer.alloc(1)]), 'a'),
    )
    assert.throws(() => decodePoolGroupChainConfigV2(Buffer.alloc(100), 'a'), CCTDataDecodeError)
  })

  it('subset admission: bit i % 8 of byte i / 8 after the fixed length', () => {
    const data = Buffer.concat([Buffer.alloc(2074), Buffer.from([0b1000_0001, 0b0000_0010])])
    const subset = { laneMode: { subset: {} } }
    assert.equal(poolGroupChainAdmits(subset, data, 0), true)
    assert.equal(poolGroupChainAdmits(subset, data, 7), true)
    assert.equal(poolGroupChainAdmits(subset, data, 9), true)
    assert.equal(poolGroupChainAdmits(subset, data, 8), false)
    assert.equal(poolGroupChainAdmits(subset, data, 40), false)
    assert.equal(poolGroupChainAdmits({ laneMode: { allMembers: {} } }, data, 99), true)
    assert.equal(poolGroupChainAdmits({ laneMode: { off: {} } }, data, 0), false)
  })

  it('GROUP_CHAIN_POLICY_FIXED_LEN is 8 + INIT_SPACE of the IDL GroupChainPolicy', () => {
    // the program pins no literal: INIT_SPACE is the record with every max_len vector full
    // (MAX_POLICY_REMOTE_POOLS 8, RemoteAddress 64, MAX_POLICY_CCVS 8, engine statics 4) and every
    // option set
    const key = PublicKey.unique()
    const ccvs = Array.from({ length: 8 }, () => key)
    const record = poolGroupsCoder.types.decode<{
      policy: Record<string, Record<string, unknown>>
    }>('GroupChainPolicy', Buffer.alloc(4096))
    record.policy.connection!.remotePools = Array.from({ length: 8 }, () => ({
      address: { address: Buffer.alloc(64, 1) },
      allowLegacyPoolData: true,
    }))
    const set = { outbound: ccvs, inbound: ccvs, epoch: new BN(1) }
    Object.assign(record.policy.security!, {
      current: set,
      pending: { ...set, activatesAt: new BN(1) },
      hook: {
        allowlist: key,
        blocklist: key,
        policyEngine: {
          program: key,
          staticAccounts: [key, key, key, key],
          writableStatics: 0,
          onSend: true,
          onReceive: true,
        },
      },
    })
    const encoded = poolGroupsCoder.types.encode('GroupChainPolicy', record)
    assert.equal(8 + encoded.length, GROUP_CHAIN_POLICY_FIXED_LEN)
  })

  it('maps IDL decode failures to CCTDataDecodeError', () => {
    assert.throws(
      () => decodePoolGroupIdlAccount('groupChainPolicy', Buffer.alloc(16), 'x'),
      CCTDataDecodeError,
    )
  })
})
