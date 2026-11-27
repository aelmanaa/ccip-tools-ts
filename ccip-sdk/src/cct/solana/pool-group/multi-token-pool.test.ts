import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MINT_SIZE, MintLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import {
  type VersionedTransaction,
  Keypair,
  PublicKey,
  TransactionInstruction,
} from '@solana/web3.js'
import { getAddress, getBytes, sha256, toUtf8Bytes } from 'ethers'

import '../../../index.ts'
import type { Chain } from '../../../chain.ts'
import { canonicalHash } from '../../canonical.ts'
import { CCTParamsInvalidError } from '../../errors.ts'
import type { MultiTokenPoolLane, MultiTokenPoolSnapshot } from '../../multi-token-pool.ts'
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
  pad32,
  policyChainData,
} from './fixtures.test.helpers.ts'
import {
  type SolanaLaneRemoteBack,
  type SolanaLaneRemoteSide,
  evaluateSolanaLaneRemote,
} from './multi-token-pool-check.ts'
import {
  CheckMultiTokenPoolLane,
  CheckPoolGroupSnapshot,
  GetMultiTokenPoolLane,
  GetMultiTokenPoolTransferQuote,
} from './operations/index.ts'
import { poolGroupInstructionsHash } from './snapshot.ts'

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
  iface?: number
  pools?: Buffer[]
  poolType?: string
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
    iface: opts.iface ?? 2,
    cc: chainConfigData(LANE_LINKED_MARKER, opts.pools ?? [hex(EVM_POOL)], opts.token),
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
  const chain = chainWith(accounts, {
    typeAndVersion: async (...args: unknown[]) =>
      args[0] === PROGRAM.toBase58()
        ? [
            opts.poolType ?? 'BurnMintTokenPool',
            '2.1.0',
            `${opts.poolType ?? 'BurnMintTokenPool'} 2.1.0`,
          ]
        : ['CCIPRouter', '2.0.0', 'ccip-router 2.0.0'],
    simulate: async (tx) => {
      const d = viewOf(tx)
      if (d.equals(ixDisc('observe_lane_group'))) return returning(observation(opts.obs))
      if (d.equals(ixDisc('get_pool_fee'))) return returning(poolFee(opts.feeEnabled ?? true))
      if (d.equals(ixDisc('get_fallback_token_transfer_fee_v2'))) {
        const ret = Buffer.alloc(12)
        ret.writeUInt32LE(50, 0)
        ret.writeUInt32LE(90_000, 4)
        ret.writeUInt32LE(32, 8)
        return {
          context: { slot: 0 },
          value: {
            err: null,
            logs: [],
            unitsConsumed: 0,
            returnData: {
              programId: FEE_QUOTER.toBase58(),
              data: [ret.toString('base64'), 'base64'],
            },
          },
        }
      }
      return refusing
    },
  })
  Object.assign(chain, { _getRouterConfig: async () => ({ feeQuoter: FEE_QUOTER }) })
  return chain
}
const FEE_QUOTER = Keypair.generate().publicKey

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

describe('checkMultiTokenPoolLane (Solana): local rules', () => {
  const checks = async (opts: Opts, getChain?: () => Promise<Chain>) => {
    const r = await new CheckMultiTokenPoolLane().query(setup(opts), {
      ...KEY,
      expectOpen: ['inbound'],
      ...(getChain && { getChain }),
    })
    return {
      ...r,
      codes: r.findings.filter((f) => f.severity === 'error').map((f) => f.check),
      warnings: r.findings.filter((f) => f.severity === 'warning').map((f) => f.check),
    }
  }

  it('fails closed without getChain; the lock budget is reported unmeasured without a 2.0 send path', async () => {
    const r = await checks({})
    assert.equal(r.remote, 'unknown')
    assert.equal(r.ok, false)
    assert.deepEqual(r.codes, ['REMOTE_UNREADABLE'])
    assert.ok(r.warnings.includes('ACCOUNT_LOCKS_EXCEEDED'))
  })

  it('mint authority, 20-byte token and long data without a fee record', async () => {
    const r = await checks({
      mintAuthority: Keypair.generate().publicKey,
      token: hex(EVM_TOKEN),
      long: true,
    })
    assert.ok(r.codes.includes('POOL_CANNOT_MINT_BURN'))
    assert.ok(r.codes.includes('REMOTE_TOKEN_ENCODING'))
    assert.ok(r.codes.includes('NO_FEE_RECORD'))
  })

  it('mint authority is not judged on a lock-release pool', async () => {
    const r = await checks({
      mintAuthority: Keypair.generate().publicKey,
      poolType: 'LockReleaseTokenPool',
    })
    assert.ok(!r.codes.includes('POOL_CANNOT_MINT_BURN'))
  })

  it('a marked lane on interface 1, and a stored pool not trimmed to the OffRamp length', async () => {
    const r = await checks({ iface: 1, pools: [pad32(EVM_POOL)] })
    assert.ok(r.codes.includes('TOKEN_NOT_REGISTERED'))
    assert.ok(r.codes.includes('REMOTE_LANE_MISMATCH'))
  })

  it('a non-EVM chain from getChain for an EVM selector is unread', async () => {
    const r = await checks({}, async () => ({}) as Chain)
    assert.equal(r.remote, 'unknown')
    assert.ok(r.codes.includes('REMOTE_UNREADABLE'))
  })
})

describe('checkMultiTokenPoolLane (Solana): remote rules', () => {
  const SERVING = STATE.toBase58()
  const view = (patch: Partial<MultiTokenPoolLane> = {}): MultiTokenPoolLane => ({
    family: 'SVM',
    tokenAddress: MINT.toBase58(),
    remoteChainSelector: SEPOLIA,
    exists: true,
    remoteToken: getAddress(EVM_TOKEN),
    remotePools: [{ address: getAddress(EVM_POOL), allowLegacyPoolData: true }],
    poolDataFormat: 'legacy',
    sources: {} as MultiTokenPoolLane['sources'],
    rateLimits: { outbound: null, inbound: { tokens: 10n, capacity: 10n, rate: 1n } },
    stopped: { outbound: false, inbound: false },
    ccvs: { outbound: [], inbound: [] },
    hasHooks: false,
    outboundStatus: { status: 'ok' },
    inboundStatus: { status: 'ok' },
    ...patch,
  })
  const back = (patch: Partial<SolanaLaneRemoteBack> = {}): SolanaLaneRemoteBack => ({
    remoteToken: MINT.toBase58(),
    trustsServing: true,
    allowLegacyFromServing: true,
    sends: 'legacy',
    outbound: null,
    hasHooks: false,
    ...patch,
  })
  type Known = Extract<SolanaLaneRemoteSide, { status: 'known' }>
  const known = (patch: Partial<Known> = {}): Known => ({
    status: 'known',
    registryPool: getAddress(EVM_POOL),
    readsLongData: true,
    back: back(),
    legacyFromMultiTokenPools: [],
    multiTokenPoolSide: {
      remoteAcceptsOutbound: true,
      remoteSendsData: '0x',
      remoteSendsLegacy: true,
    },
    ...patch,
  })
  const judge = (
    side: SolanaLaneRemoteSide,
    lanePatch: Partial<MultiTokenPoolLane> = {},
    local: { uid?: string; readsLongData?: boolean } = {},
  ) => {
    const found: { check: string; severity: string }[] = []
    const remote = evaluateSolanaLaneRemote(
      {
        lane: view(lanePatch),
        uid: local.uid ?? null,
        readsLongData: local.readsLongData ?? true,
        servingPool: SERVING,
        localDecimals: 9,
      },
      side,
      (check, severity) => found.push({ check, severity }),
    )
    return {
      remote,
      errors: found.filter((f) => f.severity === 'error').map((f) => f.check),
      found,
    }
  }
  const LONG = { poolDataFormat: 'long' } as const
  const UID = `0x${'ab'.repeat(32)}`

  it('a healthy legacy lane toward a multi-token pool passes', () => {
    const r = judge(known())
    assert.equal(r.remote, 'known')
    assert.deepEqual(r.errors, [])
  })

  it('B1.1: legacy data into a multi-token pool lane without allowLegacyPoolData', () => {
    assert.deepEqual(judge(known({ back: back({ allowLegacyFromServing: false }) })).errors, [
      'POOL_DATA_FORMAT_MISMATCH',
    ])
  })

  it('B1.2: the remote sends legacy data into a long or UID lane', () => {
    assert.ok(judge(known(), LONG).errors.includes('POOL_DATA_FORMAT_MISMATCH'))
    const uid = judge(
      known({
        multiTokenPoolSide: {
          remoteSendsData: UID,
          remoteAcceptsOutbound: true,
          remoteSendsLegacy: true,
        },
      }),
      {},
      { uid: UID },
    )
    assert.ok(uid.errors.includes('POOL_DATA_FORMAT_MISMATCH'))
  })

  it('F14: the remote sends long data to a pool that cannot read it', () => {
    const r = judge(known({ back: back({ sends: 'long' }) }), {}, { readsLongData: false })
    assert.deepEqual(r.errors, ['POOL_DATA_FORMAT_MISMATCH'])
  })

  it('UID pairing: refused outbound data, a remote that sends another UID; a paired UID lane passes', () => {
    assert.deepEqual(
      judge(
        known({
          multiTokenPoolSide: {
            remoteAcceptsOutbound: false,
            remoteSendsData: '0x',
            remoteSendsLegacy: false,
          },
        }),
        {
          ...LONG,
        },
      ).errors.filter((c) => c === 'UID_MISMATCH'),
      ['UID_MISMATCH'],
    )
    const other = judge(
      known({
        back: back({ sends: 'long' }),
        multiTokenPoolSide: {
          remoteAcceptsOutbound: true,
          remoteSendsData: `0x${'cd'.repeat(32)}`,
          remoteSendsLegacy: false,
        },
      }),
      LONG,
      { uid: UID },
    )
    assert.deepEqual(other.errors, ['UID_MISMATCH'])
    const paired = judge(
      known({
        back: back({ sends: 'long' }),
        multiTokenPoolSide: {
          remoteAcceptsOutbound: true,
          remoteSendsData: UID,
          remoteSendsLegacy: false,
        },
      }),
      LONG,
      { uid: UID },
    )
    assert.deepEqual(paired.errors, [])
  })

  it('an unread remote multi-token pool side fails closed', () => {
    assert.ok(
      judge(
        known({
          multiTokenPoolSide: { remoteSideUnread: 'unknown variant', remoteSendsLegacy: false },
        }),
      ).errors.includes('REMOTE_UNREADABLE'),
    )
  })

  it('M1: a long lane needs a lane back that trusts the serving pool', () => {
    const noBack = { ...known(), back: undefined }
    assert.ok(judge(noBack, LONG).errors.includes('REMOTE_LANE_MISMATCH'))
    assert.ok(
      judge(known({ back: back({ trustsServing: false, sends: 'long' }) }), LONG).errors.includes(
        'REMOTE_LANE_MISMATCH',
      ),
    )
  })

  it('M2: an attested legacy lane still needs its lane back read', () => {
    const attested = known({
      attestation: {
        remoteChainSelector: SEPOLIA,
        remoteToken: getAddress(EVM_TOKEN),
        remotePoolAddress: getAddress(EVM_POOL),
        acceptsLongPoolData: true,
        attestedAt: 0n,
        validUntil: 1n,
        reason: 'test',
      },
    })
    assert.deepEqual(judge(attested).errors, ['REMOTE_LANE_MISMATCH'])
    assert.deepEqual(judge(attested, LONG).errors, [])
  })

  it('no remote pool is missing, waived only while the token is paused or stopped outbound', () => {
    const none = known({ registryPool: null })
    const r = judge(none)
    assert.equal(r.remote, 'missing')
    assert.deepEqual(r.errors, ['NO_REMOTE_POOL'])
    const chainPaused = judge(none, {
      outboundStatus: { status: 'paused', scope: 'chain', direction: 'outbound' },
    })
    assert.deepEqual(chainPaused.errors, ['NO_REMOTE_POOL'])
    const tokenPaused = judge(none, {
      outboundStatus: { status: 'paused', scope: 'token', direction: 'outbound' },
    })
    assert.deepEqual(tokenPaused.errors, [])
    assert.equal(tokenPaused.remote, 'missing')
    const stopped = judge(none, { stopped: { outbound: true, inbound: false } })
    assert.deepEqual(stopped.errors, [])
    assert.equal(stopped.remote, 'missing')
    // an inbound stop does not hold sends
    assert.deepEqual(judge(none, { stopped: { outbound: false, inbound: true } }).errors, [
      'NO_REMOTE_POOL',
    ])
  })

  it('legacy data from a multi-token pool, and inbound below the remote outbound in local units', () => {
    const r = judge(
      known({
        legacyFromMultiTokenPools: [getAddress(EVM_POOL)],
        back: back({ outbound: { tokens: 0n, capacity: 100n * 10n ** 9n, rate: 10n ** 9n } }),
        remoteDecimals: 18,
      }),
    )
    assert.ok(r.errors.includes('LEGACY_RECEIVE_FROM_MULTI_TOKEN_POOL'))
    // 100e9 at 18 decimals is 100 at 9: above the local capacity 10
    assert.ok(r.found.some((f) => f.check === 'INBOUND_BELOW_REMOTE_OUTBOUND'))
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

  it('a legacy lane without a fee record quotes the FeeQuoter fallback; a long one throws', async () => {
    const legacy = await new GetMultiTokenPoolTransferQuote().query(setup({ feeEnabled: false }), {
      ...KEY,
      amount: 10_000n,
    })
    assert.deepEqual(legacy, {
      feeUSDCents: 50n,
      destGasOverhead: 90_000,
      destBytesOverhead: 32,
      tokenFeeBps: 0,
      feeDeducted: 0n,
      netAmount: 10_000n,
      hasFeeRecord: false,
    })
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
  const ix = new TransactionInstruction({ programId: PROGRAM, keys: [], data: Buffer.from([1]) })
  const transaction = { family: 'SVM' as const, instructions: [ix] }
  const fields = {
    observedAt: 1n,
    operation: 'applyMultiTokenPoolTokenProfileUpdates',
    expected: {},
    guardInputsHash: `0x${'00'.repeat(32)}`,
    calldataHash: poolGroupInstructionsHash([ix]),
  }
  const ref = {
    poolProgramAddress: PROGRAM.toBase58(),
    poolGroupAddress: GROUP.toBase58(),
    transaction,
  }

  it('refuses an edited snapshot, other instructions, and an op that registers no re-check', async () => {
    const snapshot: MultiTokenPoolSnapshot = { ...fields, hash: canonicalHash(fields) }
    await assert.rejects(
      new CheckPoolGroupSnapshot().query(setup(), {
        ...ref,
        snapshot: { ...snapshot, observedAt: 2n },
      }),
      /is not the snapshot an op returned/,
    )
    const other = new TransactionInstruction({
      programId: PROGRAM,
      keys: [],
      data: Buffer.from([2]),
    })
    await assert.rejects(
      new CheckPoolGroupSnapshot().query(setup(), {
        ...ref,
        snapshot,
        transaction: { family: 'SVM', instructions: [other] },
      }),
      /covers other instructions/,
    )
    await assert.rejects(
      new CheckPoolGroupSnapshot().query(setup(), { ...ref, snapshot }),
      /no Solana write op is registered yet/,
    )
  })
})
