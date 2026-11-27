import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { getAddress } from 'ethers'

import '../../../index.ts'
import { CCIPTokenPoolChainConfigNotFoundError } from '../../../errors/index.ts'
import { EVMChain } from '../../../evm/index.ts'
import type { MultiTokenPoolLane } from '../../multi-token-pool.ts'
import { EVM_POOL, EVM_TOKEN, MINT, STATE } from './fixtures.test.helpers.ts'
import {
  type EvmRemoteReads,
  type SolanaLaneRemoteSide,
  readEvmRemote,
} from './multi-token-pool-check.ts'
import type { SolanaMultiTokenPoolLaneRead } from './multi-token-pool-lane.ts'

const SOLANA_DEVNET = 16423721717087811551n
const REGISTRY = getAddress('0x00000000000000000000000000000000000000aa')
const LEGACY_POOL = getAddress('0x00000000000000000000000000000000000000bb')
const POOL = getAddress(EVM_POOL)
const TOKEN = getAddress(EVM_TOKEN)
const UID = `0x${'ab'.repeat(32)}`

type Known = Extract<SolanaLaneRemoteSide, { status: 'known' }>
type Unread = Exclude<SolanaLaneRemoteSide, Known>

/** Asserts a side's status and narrows it. */
function as(side: SolanaLaneRemoteSide, status: 'known'): Known
function as(side: SolanaLaneRemoteSide, status: Unread['status']): Unread
function as(side: SolanaLaneRemoteSide, status: SolanaLaneRemoteSide['status']) {
  assert.equal(side.status, status)
  return side
}

/** A Solana lane read: legacy or long, trusting `pools`, with a UID when given. */
function read(
  opts: { long?: boolean; uid?: string; pools?: MultiTokenPoolLane['remotePools'] } = {},
) {
  return {
    pool: { address: STATE },
    state: { ext: { uid: opts.uid ?? null } },
    lane: {
      remoteToken: TOKEN,
      remotePools: opts.pools ?? [{ address: POOL, allowLegacyPoolData: false }],
      poolDataFormat: opts.long ? 'long' : 'legacy',
      rateLimits: { outbound: null, inbound: null },
    },
  } as unknown as SolanaMultiTokenPoolLaneRead
}

/** An EVM chain answering the reads the reader makes itself. */
function evm(opts: {
  types?: Record<string, string | Error>
  remotes?: () => Promise<unknown>
  registry?: () => Promise<string>
}) {
  const remote = Object.create(EVMChain.prototype) as EVMChain
  Object.assign(remote, {
    typeAndVersion: async (address: string) => {
      const t = opts.types?.[address] ?? 'BurnMintTokenPool'
      if (t instanceof Error) throw t
      return [t, '2.0.0', `${t} 2.0.0`]
    },
    getTokenAdminRegistryFor: opts.registry ?? (async () => REGISTRY),
    getTokenPoolRemotes: opts.remotes ?? (async () => ({})),
    getTokenInfo: async () => ({ decimals: 18 }),
  })
  return remote
}

/** The EVM stack's reads, recorded. */
function reads(opts: { registryPool?: string | null; view?: Partial<MultiTokenPoolLane> } = {}) {
  const calls: { sends?: string } = {}
  const r: EvmRemoteReads = {
    readRegistryPool: async () => (opts.registryPool === undefined ? POOL : opts.registryPool),
    getMultiTokenPoolLane: async () =>
      ({
        exists: true,
        remoteToken: MINT.toBase58(),
        remotePools: [{ address: STATE.toBase58(), allowLegacyPoolData: false }],
        poolDataFormat: 'long',
        rateLimits: { outbound: null, inbound: null },
        hasHooks: false,
        ...opts.view,
      }) as MultiTokenPoolLane,
    readRemoteMultiTokenPoolSide: async (_r, _p, _t, _s, sends) => {
      calls.sends = sends
      return { remoteAcceptsOutbound: true, remoteSendsData: '0x', remoteSendsLegacy: false }
    },
  }
  return { r, calls }
}

describe('readEvmRemote (the EVM side of a Solana lane)', () => {
  it('a multi-token pool: the lane back from getMultiTokenPoolLane, matched on the serving State', async () => {
    const { r, calls } = reads()
    const side = await readEvmRemote(
      evm({ types: { [POOL]: 'MultiTokenPool' } }),
      read({ long: true }),
      SOLANA_DEVNET,
      r,
    )
    const known = as(side, 'known')
    assert.equal(known.readsLongData, true)
    assert.equal(known.registryPool, POOL)
    assert.deepEqual(known.back, {
      remoteToken: MINT.toBase58(),
      trustsServing: true,
      allowLegacyFromServing: false,
      sends: 'long',
      outbound: null,
      hasHooks: false,
    })
    assert.equal(calls.sends, '0x')
    // a lane back that trusts another pool, not the serving State
    const other = reads({
      view: { remotePools: [{ address: MINT.toBase58(), allowLegacyPoolData: true }] },
    })
    const s2 = await readEvmRemote(
      evm({ types: { [POOL]: 'MultiTokenPool' } }),
      read({ long: true }),
      SOLANA_DEVNET,
      other.r,
    )
    assert.equal(s2.status === 'known' && s2.back?.trustsServing, false)
  })

  it('a UID lane sends its UID to the remote provider; a legacy lane sends nothing', async () => {
    const long = reads()
    await readEvmRemote(
      evm({ types: { [POOL]: 'MultiTokenPool' } }),
      read({ long: true, uid: UID }),
      SOLANA_DEVNET,
      long.r,
    )
    assert.equal(long.calls.sends, UID)
    const legacy = reads()
    await readEvmRemote(
      evm({ types: { [POOL]: 'MultiTokenPool' } }),
      read({ uid: UID }),
      SOLANA_DEVNET,
      legacy.r,
    )
    assert.equal(legacy.calls.sends, '0x')
  })

  it('a standard pool: the lane back from getTokenPoolRemotes, legacy both ways', async () => {
    const { r } = reads()
    const side = await readEvmRemote(
      evm({
        remotes: async () => ({
          'solana-devnet': {
            remoteToken: MINT.toBase58(),
            remotePools: [STATE.toBase58()],
            outboundRateLimiterState: null,
          },
        }),
      }),
      read(),
      SOLANA_DEVNET,
      r,
    )
    const known = as(side, 'known')
    assert.equal(known.readsLongData, false)
    assert.deepEqual(known.back, {
      remoteToken: MINT.toBase58(),
      trustsServing: true,
      allowLegacyFromServing: true,
      sends: 'legacy',
      outbound: null,
      hasHooks: false,
    })
    // no chain config back: no lane back, still known
    const none = await readEvmRemote(
      evm({
        remotes: async () => {
          throw new CCIPTokenPoolChainConfigNotFoundError(POOL, TOKEN, String(SOLANA_DEVNET))
        },
      }),
      read(),
      SOLANA_DEVNET,
      r,
    )
    assert.equal(none.status === 'known' && none.back, undefined)
  })

  it('unread sides: no registry pool, a trusted pool or registry pool that is no CCIP contract', async () => {
    const empty = await readEvmRemote(
      evm({}),
      read(),
      SOLANA_DEVNET,
      reads({ registryPool: null }).r,
    )
    assert.deepEqual(empty.status === 'known' && empty.registryPool, null)
    const notCcip = Object.assign(new Error('could not decode result data'), { code: 'BAD_DATA' })
    const unlocated = await readEvmRemote(
      evm({ registry: async () => Promise.reject(notCcip) }),
      read(),
      SOLANA_DEVNET,
      reads().r,
    )
    assert.equal(unlocated.status, 'missing')
    const custom = await readEvmRemote(
      evm({ types: { [POOL]: notCcip } }),
      read(),
      SOLANA_DEVNET,
      reads().r,
    )
    assert.match(as(custom, 'unknown').reason, /does not report a CCIP typeAndVersion/)
    // a legacy-allowed trusted pool that is a multi-token pool is reported
    const legacy = await readEvmRemote(
      evm({ types: { [POOL]: 'MultiTokenPool', [LEGACY_POOL]: 'MultiTokenPool' } }),
      read({
        pools: [
          { address: POOL, allowLegacyPoolData: false },
          { address: LEGACY_POOL, allowLegacyPoolData: true },
        ],
      }),
      SOLANA_DEVNET,
      reads().r,
    )
    assert.deepEqual(legacy.status === 'known' && legacy.legacyFromMultiTokenPools, [LEGACY_POOL])
    // an EVM selector whose chain is not an EVMChain
    const wrong = await readEvmRemote({} as EVMChain, read(), SOLANA_DEVNET, reads().r)
    assert.equal(wrong.status, 'unknown')
  })

  it('a transport error propagates', async () => {
    const timeout = Object.assign(new Error('timeout'), { code: 'TIMEOUT' })
    await assert.rejects(
      readEvmRemote(
        evm({ registry: async () => Promise.reject(timeout) }),
        read(),
        SOLANA_DEVNET,
        reads().r,
      ),
      (e: unknown) => e === timeout,
    )
    await assert.rejects(
      readEvmRemote(evm({ types: { [POOL]: timeout } }), read(), SOLANA_DEVNET, reads().r),
      (e: unknown) => e === timeout,
    )
  })
})
