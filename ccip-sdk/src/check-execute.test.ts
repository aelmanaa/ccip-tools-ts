import assert from 'node:assert/strict'
import { after, beforeEach, describe, it, mock } from 'node:test'

import { AbiCoder, getAddress, hexlify, randomBytes } from 'ethers'

import { Chain } from './chain.ts'
import {
  CCIPFinalityNotAllowedError,
  CCIPInsufficientBalanceError,
  CCIPRateLimitExceededError,
  CCIPTokenDecimalsInsufficientError,
  CCIPTokenDecimalsUnavailableError,
} from './errors/index.ts'
import { ChainFamily, NetworkType } from './networks.ts'
// registers the EVM family in supportedChains, so the family-default decimals fallback
// (ChainStatic.decimals) resolves in the tests below
import './evm/index.ts'

const abi = AbiCoder.defaultAbiCoder()
const SOURCE_SELECTOR = 16015286601757825753n // sepolia
const DEST_SELECTOR = 16423721717087811551n // solana-devnet
const OFFRAMP = getAddress(hexlify(randomBytes(20)))
const POOL = getAddress(hexlify(randomBytes(20)))
const TOKEN = getAddress(hexlify(randomBytes(20)))
const TOKEN2 = getAddress(hexlify(randomBytes(20)))

/** A dest chain built straight on `Chain.prototype` — no family override. */
function makeChain(opts: {
  family?: ChainFamily
  decimals?: Record<string, number>
  poolTypeAndVersion?: string
  poolDecimals?: number
  balance?: bigint
  inboundRateLimiterState?: { tokens: bigint; capacity: bigint; rate: bigint }
}) {
  const decimals = opts.decimals ?? { [TOKEN]: 9 }
  const getTokenInfo = mock.fn((token: string) =>
    decimals[token] === undefined
      ? Promise.reject(new CCIPTokenDecimalsUnavailableError(token))
      : Promise.resolve({ decimals: decimals[token] ?? 9, symbol: 'CCIP-BnM', name: 'CCIP-BnM' }),
  )
  const getTokenAdminRegistryFor = mock.fn(() =>
    Promise.resolve(getAddress(hexlify(randomBytes(20)))),
  )
  const chain = Object.create(Chain.prototype) as Chain
  Object.assign(chain, {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    network: {
      name: 'solana-devnet',
      chainId: 'devnet',
      chainSelector: DEST_SELECTOR,
      family: opts.family ?? ChainFamily.Solana,
      networkType: NetworkType.Testnet,
    },
    getTokenAdminRegistryFor,
    getRegistryTokenConfig: mock.fn(() => Promise.resolve({ tokenPool: POOL })),
    getTokenPoolConfig: mock.fn(() =>
      Promise.resolve({
        typeAndVersion: opts.poolTypeAndVersion ?? 'BurnMintTokenPool 1.6.1',
        lockBox: undefined,
        ...(opts.poolDecimals != null && { decimals: opts.poolDecimals }),
      }),
    ),
    getTokenPoolRemote: mock.fn(() =>
      Promise.resolve({
        remoteToken: TOKEN,
        remotePools: [],
        inboundRateLimiterState: opts.inboundRateLimiterState,
        outboundRateLimiterState: undefined,
      }),
    ),
    getBalance: mock.fn(() => Promise.resolve(opts.balance ?? 10n ** 24n)),
    getTokenInfo,
  })
  return { chain, getTokenInfo, getTokenAdminRegistryFor }
}

const check = (
  chain: Chain,
  tokenAmounts: { token?: string; amount: bigint; extraData?: string }[],
) =>
  chain.checkExecute({
    offRamp: OFFRAMP,
    message: {
      sourceChainSelector: SOURCE_SELECTOR,
      tokenAmounts: tokenAmounts.map((ta) => ({ token: TOKEN, ...ta })),
    },
  })

/** A full bucket of 100,000 CCIP-BnM at 9 decimals — the live sepolia→solana-devnet numbers. */
const FULL_BUCKET = { tokens: 10n ** 14n, capacity: 10n ** 14n, rate: 167000000000n }
const dec = (d: bigint) => abi.encode(['uint256'], [d])

void describe('Chain.checkExecute — amount denomination', () => {
  void beforeEach(() => mock.restoreAll())
  void after(() => mock.restoreAll())

  void it('18→9: a source-denominated amount is converted before hitting the bucket', async () => {
    // 0.001 CCIP-BnM from an 18-decimals source = 1e15 source units, 1e6 dest; unconverted,
    // 1e15 exceeds even a full 1e14 bucket
    const { chain } = makeChain({ inboundRateLimiterState: FULL_BUCKET })
    assert.equal(await check(chain, [{ amount: 10n ** 15n, extraData: dec(18n) }]), true)
  })

  void it('18→9: an amount genuinely over the bucket still throws, reporting dest units', async () => {
    const { chain } = makeChain({
      inboundRateLimiterState: { tokens: 10n ** 5n, capacity: 10n ** 14n, rate: 1n },
    })
    await assert.rejects(
      () => check(chain, [{ amount: 10n ** 15n, extraData: dec(18n) }]),
      (err: unknown) => {
        assert.ok(err instanceof CCIPRateLimitExceededError)
        assert.equal(err.context['amount'], 10n ** 6n) // dest-denominated, not 1e15
        assert.equal(err.context['sourceAmount'], 10n ** 15n)
        assert.equal(err.context['sourceDecimals'], 18)
        assert.equal(err.context['destDecimals'], 9)
        return true
      },
    )
  })

  void it('9→18: an amount that only exceeds the bucket after conversion is blocked', async () => {
    // 1 token is 1e9 at the source, 1e18 here; unconverted it fits the 1e17 bucket, on-chain it
    // does not
    const { chain } = makeChain({
      decimals: { [TOKEN]: 18 },
      inboundRateLimiterState: { tokens: 10n ** 17n, capacity: 10n ** 18n, rate: 1n },
    })
    await assert.rejects(
      () => check(chain, [{ amount: 10n ** 9n, extraData: dec(9n) }]),
      CCIPRateLimitExceededError,
    )
  })

  void it('equal decimals => no conversion', async () => {
    const { chain } = makeChain({
      inboundRateLimiterState: { tokens: 10n ** 5n, capacity: 10n ** 14n, rate: 1n },
    })
    await assert.rejects(
      () => check(chain, [{ amount: 10n ** 6n, extraData: dec(9n) }]),
      (err: unknown) => {
        assert.ok(err instanceof CCIPRateLimitExceededError)
        assert.equal(err.context['amount'], 10n ** 6n)
        return true
      },
    )
  })

  void it('0 declared decimals is a declaration, not an absent one', async () => {
    // a 0-decimal SPL mint emits 32 zero bytes; treating that as "undeclared" compares 1e9× low
    const { chain } = makeChain({
      inboundRateLimiterState: { tokens: 10n ** 5n, capacity: 10n ** 14n, rate: 1n },
    })
    await assert.rejects(
      () => check(chain, [{ amount: 1n, extraData: dec(0n) }]),
      (err: unknown) => {
        assert.ok(err instanceof CCIPRateLimitExceededError)
        assert.equal(err.context['amount'], 10n ** 9n) // 1 whole token at 9 decimals
        return true
      },
    )
  })

  void it('an amount the dest token cannot represent is rejected, not silently passed', async () => {
    // 1 unit at 18 decimals truncates to 0 at 9 — it would clear every bucket and balance
    const { chain } = makeChain({ inboundRateLimiterState: FULL_BUCKET })
    await assert.rejects(
      () => check(chain, [{ amount: 1n, extraData: dec(18n) }]),
      CCIPTokenDecimalsInsufficientError,
    )
  })

  void it('no extraData => amount is already dest-denominated, compared as-is', async () => {
    const { chain, getTokenInfo } = makeChain({
      inboundRateLimiterState: { tokens: 10n ** 5n, capacity: 10n ** 14n, rate: 1n },
    })
    await assert.rejects(() => check(chain, [{ amount: 10n ** 6n }]), CCIPRateLimitExceededError)
    assert.equal(getTokenInfo.mock.callCount(), 0) // no decimals read when nothing is declared
  })

  void it('extraData that declares no decimals => identity, no throw', async () => {
    // a short CCTP-style payload; the USDC hybrid pool's abi.encode(LOCK_RELEASE_FLAG) — 32 bytes
    // but far outside the decimals range; and a plain out-of-range word
    for (const extraData of ['0xfa7c07de', abi.encode(['bytes4'], ['0xfa7c07de']), dec(999n)]) {
      const { chain, getTokenInfo } = makeChain({ inboundRateLimiterState: FULL_BUCKET })
      assert.equal(await check(chain, [{ amount: 10n ** 6n, extraData }]), true, extraData)
      assert.equal(getTokenInfo.mock.callCount(), 0, extraData) // no conversion attempted
    }
  })

  void it('converts per token, resolving the registry once', async () => {
    const { chain, getTokenAdminRegistryFor } = makeChain({
      decimals: { [TOKEN]: 9, [TOKEN2]: 18 },
      inboundRateLimiterState: { tokens: 10n ** 14n, capacity: 10n ** 18n, rate: 1n },
    })
    // TOKEN2 declares 9 source decimals against an 18-decimals dest token => 1e15, over the bucket
    await assert.rejects(
      () =>
        check(chain, [
          { amount: 10n ** 6n },
          { token: TOKEN2, amount: 10n ** 6n, extraData: dec(9n) },
        ]),
      (err: unknown) => {
        assert.ok(err instanceof CCIPRateLimitExceededError)
        assert.equal(err.context['token'], TOKEN2)
        assert.equal(err.context['amount'], 10n ** 15n)
        return true
      },
    )
    assert.equal(getTokenAdminRegistryFor.mock.callCount(), 1)
  })

  void it('EVM pools debit the bucket in source units below 1.6.1, local units from 1.6.1', async () => {
    // @1.6.0 _validateReleaseOrMint consumes releaseOrMintIn.amount; @1.6.1 it consumes localAmount
    for (const [version, expected] of [
      ['LockReleaseTokenPool 1.5.1', 10n ** 15n],
      ['LockReleaseTokenPool 1.6.0', 10n ** 15n],
      ['LockReleaseTokenPool 1.6.1', 10n ** 6n],
      ['LockReleaseTokenPool 2.0.0', 10n ** 6n],
    ] as const) {
      const { chain } = makeChain({
        family: ChainFamily.EVM,
        poolTypeAndVersion: version,
        inboundRateLimiterState: { tokens: 10n ** 5n, capacity: 10n ** 14n, rate: 1n },
      })
      await assert.rejects(
        () => check(chain, [{ amount: 10n ** 15n, extraData: dec(18n) }]),
        (err: unknown) => {
          assert.ok(err instanceof CCIPRateLimitExceededError)
          assert.equal(err.context['amount'], expected, version)
          return true
        },
      )
    }
  })

  void it('a non-EVM pool reporting an old version still uses local units', async () => {
    // Solana's validate_release_or_mint debits parsed_amount at every version
    const { chain } = makeChain({
      poolTypeAndVersion: 'BurnMintTokenPool 1.6.0',
      inboundRateLimiterState: FULL_BUCKET,
    })
    assert.equal(await check(chain, [{ amount: 10n ** 15n, extraData: dec(18n) }]), true)
  })

  void it('LockRelease liquidity is compared in dest units too', async () => {
    const { chain } = makeChain({
      poolTypeAndVersion: 'LockReleaseTokenPool 1.5.1',
      balance: 10n ** 14n, // 100,000 CCIP-BnM at 9 decimals — plenty for 0.001
    })
    assert.equal(await check(chain, [{ amount: 10n ** 15n, extraData: dec(18n) }]), true)
  })

  void it('LockRelease genuinely short of liquidity still throws, reporting dest units', async () => {
    const { chain } = makeChain({
      poolTypeAndVersion: 'LockReleaseTokenPool 1.5.1',
      balance: 10n ** 5n,
    })
    await assert.rejects(
      () => check(chain, [{ amount: 10n ** 15n, extraData: dec(18n) }]),
      (err: unknown) => {
        assert.ok(err instanceof CCIPInsufficientBalanceError)
        assert.equal(err.context['need'], (10n ** 6n).toString()) // dest units, not 1e15
        assert.equal(err.context['have'], (10n ** 5n).toString())
        return true
      },
    )
  })

  void it('a dest token without decimals() converts via the pool-declared decimals', async () => {
    // the dest token implements no decimals() — the pool's declared decimals (9) are the
    // authoritative fallback, so the 18-decimals source amount still converts to dest units
    const { chain } = makeChain({
      decimals: {},
      poolDecimals: 9,
      inboundRateLimiterState: FULL_BUCKET,
    })
    assert.equal(await check(chain, [{ amount: 10n ** 15n, extraData: dec(18n) }]), true)
  })

  void it('a dest token without decimals() falls back to the family default when the pool cannot declare either', async () => {
    // neither the dest token nor its pool (v1.5.0) can declare — the family's static default
    // (18 on EVM) is the last resort: 1e15 at 18 source decimals stays 1e15 dest units
    const { chain } = makeChain({
      family: ChainFamily.EVM,
      decimals: {},
      inboundRateLimiterState: { tokens: 10n ** 16n, capacity: 10n ** 18n, rate: 1n },
    })
    assert.equal(await check(chain, [{ amount: 10n ** 15n, extraData: dec(18n) }]), true)
  })
})

type Bucket = { tokens: bigint; capacity: bigint; rate: bigint } | null
const bucketOf = (tokens: bigint): Bucket => ({ tokens, capacity: tokens, rate: 1n })

/**
 * A chain on `Chain.prototype` with one single-token pool (no lane status). `fast` = the 2.0
 * fast-finality buckets (`undefined`: a pre-2.0 pool, which reports none).
 */
function singleTokenPoolChain(opts: {
  outbound?: Bucket
  inbound?: Bucket
  fast?: { outbound: Bucket; inbound: Bucket }
  finalityDepth?: number
  fastFinalityTransferFeeBps?: number
}) {
  const getTokenPoolConfig = mock.fn((_pool: string, _opts?: unknown) =>
    Promise.resolve({
      typeAndVersion: opts.fast ? 'BurnMintTokenPool 2.0.0' : 'BurnMintTokenPool 1.6.1',
      lockBox: undefined,
      finalityDepth: opts.finalityDepth ?? 1,
      tokenTransferFeeConfig:
        opts.fastFinalityTransferFeeBps != null
          ? {
              isEnabled: true,
              finalityTransferFeeBps: 0,
              fastFinalityTransferFeeBps: opts.fastFinalityTransferFeeBps,
            }
          : undefined,
    }),
  )
  const chain = Object.create(Chain.prototype) as Chain
  Object.assign(chain, {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    network: {
      name: 'ethereum-testnet-sepolia',
      chainId: 11155111,
      chainSelector: SOURCE_SELECTOR,
      family: ChainFamily.EVM,
      networkType: NetworkType.Testnet,
    },
    getTokenAdminRegistryFor: mock.fn(() => Promise.resolve(getAddress(hexlify(randomBytes(20))))),
    getRegistryTokenConfig: mock.fn(() => Promise.resolve({ tokenPool: POOL })),
    getTokenPoolConfig,
    getTokenPoolRemote: mock.fn(() =>
      Promise.resolve({
        remoteToken: TOKEN,
        remotePools: [],
        outboundRateLimiterState: opts.outbound ?? null,
        inboundRateLimiterState: opts.inbound ?? null,
        ...(opts.fast && {
          fastOutboundRateLimiterState: opts.fast.outbound,
          fastInboundRateLimiterState: opts.fast.inbound,
        }),
      }),
    ),
    getBalance: mock.fn(() => Promise.resolve(10n ** 24n)),
    getTokenInfo: mock.fn(() => Promise.resolve({ decimals: 18, symbol: 'T', name: 'T' })),
  })
  return { chain, getTokenPoolConfig }
}

const send = (chain: Chain, amount: bigint, finality?: 'finalized' | 'safe' | number) =>
  chain.checkSendMessage({
    router: OFFRAMP,
    destChainSelector: DEST_SELECTOR,
    message: {
      tokenAmounts: [{ token: TOKEN, amount }],
      ...(finality != null && { extraArgs: { gasLimit: 0n, finality } }),
    },
  })

const receive = (chain: Chain, amount: bigint, finality?: 'finalized' | 'safe' | number) =>
  chain.checkExecute({
    offRamp: OFFRAMP,
    message: {
      sourceChainSelector: DEST_SELECTOR,
      tokenAmounts: [{ token: TOKEN, amount }],
      ...(finality != null && { finality }),
    },
  })

void describe('fast-finality buckets of single-token pools', () => {
  void it('checkSendMessage refuses a fast transfer over the fast outbound bucket', async () => {
    const { chain } = singleTokenPoolChain({
      outbound: bucketOf(100_000n),
      fast: { outbound: bucketOf(10n), inbound: bucketOf(10n) },
    })
    await assert.rejects(send(chain, 11n, 1), (err: unknown) => {
      assert.ok(err instanceof CCIPRateLimitExceededError)
      assert.equal(err.context['tokens'], 10n)
      assert.equal(err.context['amount'], 11n)
      return true
    })
    assert.equal(await send(chain, 10n, 1), true)
    // finalized messages still use the default bucket
    assert.equal(await send(chain, 11n, 'finalized'), true)
    assert.equal(await send(chain, 11n), true)
  })

  void it('checkSendMessage accepts a fast transfer when only the default bucket is empty', async () => {
    const { chain } = singleTokenPoolChain({
      outbound: bucketOf(0n),
      fast: { outbound: bucketOf(10n), inbound: bucketOf(10n) },
    })
    assert.equal(await send(chain, 5n, 1), true)
    await assert.rejects(send(chain, 5n, 'finalized'), CCIPRateLimitExceededError)
  })

  void it('checkSendMessage falls back to the default bucket when the fast one is disabled', async () => {
    const { chain } = singleTokenPoolChain({
      outbound: bucketOf(100n),
      fast: { outbound: null, inbound: null },
    })
    assert.equal(await send(chain, 100n, 1), true)
    await assert.rejects(send(chain, 101n, 1), (err: unknown) => {
      assert.ok(err instanceof CCIPRateLimitExceededError)
      assert.equal(err.context['tokens'], 100n)
      return true
    })
  })

  void it('checkSendMessage checks the fast bucket for the amount after the fast fee, and the allowed finality', async () => {
    const { chain } = singleTokenPoolChain({
      outbound: bucketOf(100_000n),
      fast: { outbound: bucketOf(995n), inbound: null },
      fastFinalityTransferFeeBps: 50,
      finalityDepth: 5,
    })
    assert.equal(await send(chain, 1000n, 5), true)
    await assert.rejects(send(chain, 1001n, 5), CCIPRateLimitExceededError)
    await assert.rejects(send(chain, 1n, 2), CCIPFinalityNotAllowedError)
  })

  void it('checkSendMessage keeps the pre-2.0 path: default bucket, full amount, no pool config read', async () => {
    const { chain, getTokenPoolConfig } = singleTokenPoolChain({ outbound: bucketOf(10n) })
    assert.equal(await send(chain, 10n, 1), true)
    await assert.rejects(send(chain, 11n, 1), CCIPRateLimitExceededError)
    assert.equal(getTokenPoolConfig.mock.calls.length, 0)
  })

  void it('checkExecute refuses a fast message over the fast inbound bucket', async () => {
    const { chain } = singleTokenPoolChain({
      inbound: bucketOf(100_000n),
      fast: { outbound: bucketOf(10n), inbound: bucketOf(10n) },
    })
    await assert.rejects(receive(chain, 11n, 1), (err: unknown) => {
      assert.ok(err instanceof CCIPRateLimitExceededError)
      assert.equal(err.context['tokens'], 10n)
      return true
    })
    assert.equal(await receive(chain, 10n, 1), true)
    assert.equal(await receive(chain, 11n, 'finalized'), true)
    assert.equal(await receive(chain, 11n), true)
  })

  void it('checkExecute uses the default inbound bucket when the fast one is disabled or absent', async () => {
    const disabled = singleTokenPoolChain({
      inbound: bucketOf(100n),
      fast: { outbound: null, inbound: null },
    })
    assert.equal(await receive(disabled.chain, 100n, 1), true)
    await assert.rejects(receive(disabled.chain, 101n, 1), CCIPRateLimitExceededError)
    const v16 = singleTokenPoolChain({ inbound: bucketOf(100n) })
    assert.equal(await receive(v16.chain, 100n, 1), true)
  })
})
