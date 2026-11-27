import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MINT_SIZE, MintLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { type VersionedTransaction, Keypair, PublicKey } from '@solana/web3.js'
import { getAddress, getBytes, sha256, toUtf8Bytes } from 'ethers'

import '../../../index.ts'
import type { Chain } from '../../../chain.ts'
import { canonicalHash } from '../../canonical.ts'
import { CCTParamsInvalidError } from '../../errors.ts'
import type { MultiTokenPoolSnapshot } from '../../multi-token-pool.ts'
import { deriveTokenPoolSignerPda } from '../programs/token-pool.ts'
import { LANE_LINKED_MARKER } from './accounts.ts'
import {
  type Accounts,
  EVM_POOL,
  EVM_TOKEN,
  GCP,
  GROUP,
  MINT,
  POLICY,
  PROGRAM,
  RECORD,
  SEPOLIA,
  STATE,
  account,
  bn,
  chainConfigData,
  chainConfigV2Data,
  chainWith,
  encodeType,
  groupChainData,
  hex,
  lane,
  policyChainData,
} from './fixtures.test.helpers.ts'
import {
  CheckMultiTokenPoolLane,
  CheckPoolGroupSnapshot,
  GetMultiTokenPoolLane,
  GetMultiTokenPoolTransferQuote,
} from './operations/index.ts'

const KEY = {
  tokenAddress: MINT.toBase58(),
  remoteChainSelector: SEPOLIA,
  poolAddress: PROGRAM.toBase58(),
}
const ixDisc = (name: string) =>
  Buffer.from(getBytes(sha256(toUtf8Bytes(`global:${name}`)))).subarray(0, 8)
const viewOf = (tx: VersionedTransaction) =>
  Buffer.from(tx.message.compiledInstructions.at(-1)!.data).subarray(0, 8)
const returning = (data: Buffer) => ({
  context: { slot: 0 },
  value: {
    err: null,
    logs: [`Program return: ${PROGRAM.toBase58()} ${data.toString('base64')}`],
    unitsConsumed: 0,
    returnData: null,
  },
})
const refusing = {
  context: { slot: 0 },
  value: {
    err: { InstructionError: [1, { Custom: 6000 }] },
    logs: [],
    unitsConsumed: 0,
    returnData: null,
  },
}

function mintData(authority: PublicKey | null): Buffer {
  const data = Buffer.alloc(MINT_SIZE)
  MintLayout.encode(
    {
      mintAuthorityOption: authority ? 1 : 0,
      mintAuthority: authority ?? PublicKey.default,
      supply: 0n,
      decimals: 9,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  )
  return data
}

type Obs = { fee?: { bps: number; bytes: number; gas: number }; outbound?: [bigint, bigint] }
/** An `observe_lane_group` answer: enabled buckets, and the effective fee config when `fee`. */
const observation = ({ fee, outbound = [100n, 1n] }: Obs = {}) =>
  encodeType('LaneGroupObservation', (v) => {
    v.mint = MINT
    v.remoteChainSelector = bn(SEPOLIA)
    v.group = GROUP
    Object.assign(v.outboundRateLimit as object, {
      isEnabled: true,
      capacity: bn(outbound[0]),
      rate: bn(outbound[1]),
      tokens: bn(outbound[0]),
    })
    Object.assign(v.inboundRateLimit as object, {
      isEnabled: true,
      capacity: bn(1_000),
      rate: bn(10),
      tokens: bn(1_000),
    })
    if (fee)
      v.feeConfig = {
        destGasOverhead: fee.gas,
        destBytesOverhead: fee.bytes,
        finalityFee: 7,
        fastFinalityFee: 9,
        finalityBpsFee: fee.bps,
        fastFinalityBpsFee: fee.bps,
        isEnabled: true,
      }
  })
const poolFee = (enabled: boolean) =>
  encodeType('GetFeeResult', (v) =>
    Object.assign(v, {
      destGasLimit: 250_000,
      destBytesOverhead: 224,
      fee: 7,
      tokenFeeBps: 25,
      isEnabled: enabled,
    }),
  )

type Opts = {
  long?: boolean
  groupPaused?: boolean
  token?: Buffer
  mintAuthority?: PublicKey | null
  obs?: Obs
  feeEnabled?: boolean
}
/** A lane linked to `GROUP` (CONNECTION from the group when `long`), its mint, and the views. */
function setup(opts: Opts = {}) {
  const accounts: Accounts = lane({
    cc: chainConfigData(LANE_LINKED_MARKER, [hex(EVM_POOL)], opts.token),
    v2: chainConfigV2Data({
      group: GROUP,
      sources: [opts.long ? 1 : 0, 0, 1, 2],
      slots: [POLICY],
    }),
    extra: [
      [GCP, groupChainData({ format: opts.long ? 1 : 0, groupPaused: !!opts.groupPaused })],
      [RECORD, policyChainData(8, 0)],
      [
        POLICY,
        account(
          'Policy',
          encodeType('Policy', (v) => Object.assign(v, { version: 1, group: GROUP, policyId: 5 })),
        ),
      ],
      [
        MINT,
        mintData(
          opts.mintAuthority === undefined
            ? deriveTokenPoolSignerPda(PROGRAM, MINT)
            : opts.mintAuthority,
        ),
        TOKEN_PROGRAM_ID,
      ],
    ],
  })
  return chainWith(accounts, {
    simulate: async (tx) => {
      const d = viewOf(tx)
      if (d.equals(ixDisc('observe_lane_group'))) return returning(observation(opts.obs))
      if (d.equals(ixDisc('get_pool_fee'))) return returning(poolFee(opts.feeEnabled ?? true))
      return refusing
    },
  })
}

/** A Sepolia stand-in answering the core reads the lane check uses. */
function sepolia(opts: { registryPool?: string | null; type?: string; back?: boolean } = {}) {
  const pool = opts.registryPool === undefined ? EVM_POOL : opts.registryPool
  return {
    getTokenAdminRegistryFor: async () => '0x4444444444444444444444444444444444444444',
    getRegistryTokenConfig: async () => ({
      administrator: EVM_POOL,
      ...(pool && { tokenPool: pool }),
    }),
    typeAndVersion: async () => [opts.type ?? 'BurnMintMultiTokenPool', '2.0.0', ''],
    getTokenPoolRemotes: async () => ({
      'solana-devnet': {
        remoteToken:
          opts.back === false ? Keypair.generate().publicKey.toBase58() : MINT.toBase58(),
        remotePools: [STATE.toBase58()],
        outboundRateLimiterState: null,
        inboundRateLimiterState: null,
      },
    }),
    getTokenInfo: async () => ({ decimals: 18 }),
  } as unknown as Chain
}

describe('getMultiTokenPoolLane (Solana)', () => {
  it('the shared shape: sources, buckets, fee, CCVs, statuses', async () => {
    const view = await new GetMultiTokenPoolLane().query(
      setup({ obs: { fee: { bps: 25, bytes: 224, gas: 250_000 } } }),
      KEY,
    )
    assert.equal(view.family, 'SVM')
    assert.equal(view.exists, true)
    assert.equal(view.remoteToken, getAddress(EVM_TOKEN))
    assert.deepEqual(view.remotePools, [
      { address: getAddress(EVM_POOL), allowLegacyPoolData: true },
    ])
    assert.deepEqual(view.sources.rateLimit, { kind: 'default' })
    assert.deepEqual(view.sources.security, { kind: 'policy', policy: { id: 5 } })
    assert.deepEqual(view.sources.connection, { kind: 'inline' })
    assert.equal(view.rateLimits.outbound?.capacity, 100n)
    assert.equal(view.tokenTransferFeeConfig?.finalityTransferFeeBps, 25)
    assert.deepEqual(view.outboundStatus, { status: 'ok' })
    assert.deepEqual(view.stopped, { outbound: false, inbound: false })
  })

  it('a group pause is a global pause; a 0/0 bucket is a stop; a missing lane is incomplete', async () => {
    const paused = await new GetMultiTokenPoolLane().query(
      setup({ groupPaused: true, obs: { outbound: [0n, 0n] } }),
      KEY,
    )
    assert.deepEqual(paused.outboundStatus, {
      status: 'paused',
      scope: 'global',
      direction: 'outbound',
    })
    assert.equal(paused.stopped.outbound, true)
    const none = await new GetMultiTokenPoolLane().query(setup(), {
      ...KEY,
      remoteChainSelector: 3478487238524512106n,
    })
    assert.equal(none.exists, false)
    assert.deepEqual(none.outboundStatus, { status: 'incomplete', missing: ['connection'] })
  })

  it('refuses the EVM-only registryAddress', async () => {
    await assert.rejects(
      new GetMultiTokenPoolLane().query(setup(), { ...KEY, registryAddress: EVM_POOL }),
      CCTParamsInvalidError,
    )
  })
})

describe('checkMultiTokenPoolLane (Solana)', () => {
  const checks = async (opts: Opts, getChain?: () => Promise<Chain>) => {
    const r = await new CheckMultiTokenPoolLane().query(setup(opts), {
      ...KEY,
      expectOpen: ['inbound'],
      ...(getChain && { getChain }),
    })
    return { ...r, codes: r.findings.filter((f) => f.severity === 'error').map((f) => f.check) }
  }

  it('fails closed without getChain', async () => {
    const r = await checks({})
    assert.equal(r.remote, 'unknown')
    assert.equal(r.ok, false)
    assert.deepEqual(r.codes, ['REMOTE_UNREADABLE'])
  })

  it('a healthy legacy lane passes with the remote side read', async () => {
    const r = await checks({}, async () => sepolia({ type: 'BurnMintTokenPool' }))
    assert.equal(r.remote, 'known')
    assert.deepEqual(r.codes, [])
  })

  it('local rules: mint authority, 20-byte token, long data without a fee record', async () => {
    const r = await checks(
      { mintAuthority: Keypair.generate().publicKey, token: hex(EVM_TOKEN), long: true },
      async () => sepolia(),
    )
    assert.ok(r.codes.includes('POOL_CANNOT_MINT_BURN'))
    assert.ok(r.codes.includes('REMOTE_TOKEN_ENCODING'))
    assert.ok(r.codes.includes('NO_FEE_RECORD'))
  })

  it('remote rules: no remote pool (missing), long data to a legacy-only pool (F14)', async () => {
    const none = await checks({}, async () => sepolia({ registryPool: null }))
    assert.equal(none.remote, 'missing')
    assert.ok(none.codes.includes('NO_REMOTE_POOL'))
    const f14 = await checks(
      { long: true, obs: { fee: { bps: 0, bytes: 224, gas: 250_000 } } },
      async () => sepolia({ type: 'BurnMintTokenPool' }),
    )
    assert.ok(f14.codes.includes('POOL_DATA_FORMAT_MISMATCH'))
  })
})

describe('getMultiTokenPoolTransferQuote (Solana)', () => {
  it('quotes the token fee and net amount from get_pool_fee', async () => {
    const q = await new GetMultiTokenPoolTransferQuote().query(setup(), { ...KEY, amount: 10_000n })
    assert.deepEqual(q, {
      feeUSDCents: 7n,
      destGasOverhead: 250_000,
      destBytesOverhead: 224,
      tokenFeeBps: 25,
      feeDeducted: 25n,
      netAmount: 9_975n,
      hasFeeRecord: true,
    })
  })

  it('a legacy lane without a fee record quotes no token fee; a long one throws', async () => {
    const legacy = await new GetMultiTokenPoolTransferQuote().query(setup({ feeEnabled: false }), {
      ...KEY,
      amount: 10_000n,
    })
    assert.equal(legacy.hasFeeRecord, false)
    assert.equal(legacy.netAmount, 10_000n)
    await assert.rejects(
      new GetMultiTokenPoolTransferQuote().query(setup({ feeEnabled: false, long: true }), {
        ...KEY,
        amount: 10_000n,
      }),
      CCTParamsInvalidError,
    )
    await assert.rejects(
      new GetMultiTokenPoolTransferQuote().query(setup(), { ...KEY, amount: 1n << 64n }),
      CCTParamsInvalidError,
    )
  })
})

describe('checkPoolGroupSnapshot', () => {
  const fields = {
    observedAt: 1n,
    operation: 'applyMultiTokenPoolTokenProfileUpdates',
    expected: {},
    guardInputsHash: `0x${'00'.repeat(32)}`,
    calldataHash: `0x${'00'.repeat(32)}`,
  }
  const ref = { poolProgramAddress: PROGRAM.toBase58(), poolGroupAddress: GROUP.toBase58() }

  it('refuses an edited snapshot, and one no Solana pool-group op built', async () => {
    const snapshot: MultiTokenPoolSnapshot = { ...fields, hash: canonicalHash(fields) }
    await assert.rejects(
      new CheckPoolGroupSnapshot().query(setup(), {
        ...ref,
        snapshot: { ...snapshot, observedAt: 2n },
      }),
      /is not the snapshot an op returned/,
    )
    await assert.rejects(
      new CheckPoolGroupSnapshot().query(setup(), { ...ref, snapshot }),
      /not a Solana pool-group op/,
    )
  })
})
