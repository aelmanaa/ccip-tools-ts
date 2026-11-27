import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BN, BorshAccountsCoder } from '@coral-xyz/anchor'
import { type Connection, PublicKey } from '@solana/web3.js'

import type { TokenPoolRemote } from '../../../../chain.ts'
import { networkInfo } from '../../../../networks.ts'
import type { SolanaChain } from '../../../../solana/index.ts'
import { getMultipleAccountsInfoPaged } from '../../../../solana/utils.ts'
import { CCTDataDecodeError, CCTParamsInvalidError } from '../../../errors.ts'
import { LANE_LINKED_MARKER, poolGroupsCoder } from '../../pool-group/accounts.ts'
import { deriveTokenPoolConfigPda } from '../../programs/token-pool.ts'
import { GetTokenPoolRemotes } from './get-token-pool-remotes.ts'

function key(byte: number): PublicKey {
  return new PublicKey(Uint8Array.from({ length: 32 }, () => byte))
}

const REMOTES: Record<string, TokenPoolRemote> = {
  'ethereum-mainnet': {
    remoteToken: '0x1234',
    remotePools: ['0x5678'],
    inboundRateLimiterState: { tokens: 25n, capacity: 50n, rate: 5n },
    outboundRateLimiterState: null,
  },
}

describe('GetTokenPoolRemotes (cct/solana)', () => {
  const mint = key(2)
  const program = key(3)
  const selector = 5009297550715157269n

  const account = (data: Buffer) => ({ data, owner: program, lamports: 1, executable: false })

  /** A chain whose core read returns `REMOTES` with `laneAccounts`. */
  function chain(
    laneAccounts: Record<string, { chainConfig: unknown; chainConfigV2?: unknown }> = {},
    { all = false }: { all?: boolean } = {},
  ): SolanaChain {
    return {
      connection: { getAccountInfo: async () => ({}) },
      _getTokenPoolRemotesWithAccounts: async (state: string, remoteChainSelector?: bigint) => {
        assert.equal(state, deriveTokenPoolConfigPda(program, mint).toBase58())
        assert.equal(remoteChainSelector, all ? undefined : selector)
        return { remotes: { ...REMOTES }, tokenPoolProgram: program, mint, laneAccounts }
      },
    } as unknown as SolanaChain
  }

  describe('query', () => {
    it('returns core remote configs for the selected chain', async () => {
      const remotes = await new GetTokenPoolRemotes().query(chain(), {
        tokenAddress: mint.toBase58(),
        poolProgramAddress: program.toBase58(),
        remoteChainSelector: selector,
      })
      assert.deepEqual(remotes, REMOTES)
    })

    it('omits the selector to read all remote configs', async () => {
      const remotes = await new GetTokenPoolRemotes().query(chain({}, { all: true }), {
        tokenAddress: mint.toBase58(),
        poolProgramAddress: program.toBase58(),
      })
      assert.deepEqual(remotes, REMOTES)
    })
  })

  const group = key(9)
  const ccLen = 8 + 139
  /** A burn-mint `ChainConfig` with no pools, optionally followed by the linked marker. */
  function chainConfig(marked: boolean) {
    const zero = poolGroupsCoder.types.decode<Record<string, unknown>>(
      'ChainConfig',
      Buffer.alloc(512),
    )
    const body = poolGroupsCoder.types.encode('ChainConfig', zero)
    const cc = Buffer.alloc(ccLen + (marked ? 8 : 0))
    Buffer.concat([BorshAccountsCoder.accountDiscriminator('ChainConfig'), body]).copy(cc)
    if (marked) LANE_LINKED_MARKER.copy(cc, ccLen)
    return cc
  }
  /** A version-2 `ChainConfigV2` with a tail naming `group`, linked. */
  function chainConfigV2(version = 2, withTail = true) {
    const v2Zero = poolGroupsCoder.types.decode<Record<string, unknown>>(
      'ChainConfigV2',
      Buffer.alloc(512),
    )
    const v2Body = poolGroupsCoder.types.encode('ChainConfigV2', {
      ...v2Zero,
      version,
      mint,
      remoteChainSelector: new BN(networkInfo('ethereum-mainnet').chainSelector.toString()),
    })
    const tail = Buffer.alloc(209)
    group.toBuffer().copy(tail, 0)
    tail[32] = 1
    return Buffer.concat([
      BorshAccountsCoder.accountDiscriminator('ChainConfigV2'),
      v2Body,
      ...(withTail ? [tail] : []),
    ])
  }
  const query = (lanes: Record<string, { chainConfig: unknown; chainConfigV2?: unknown }>) =>
    new GetTokenPoolRemotes().query(chain(lanes, { all: true }), {
      tokenAddress: mint.toBase58(),
      poolProgramAddress: program.toBase58(),
    })

  it('marks a pool-group lane with its kind and group, from the accounts core read', async () => {
    const remotes = await query({
      'ethereum-mainnet': {
        chainConfig: account(chainConfig(true)),
        chainConfigV2: account(chainConfigV2()),
      },
    })
    assert.deepEqual(remotes['ethereum-mainnet']?.poolGroup, {
      kind: 'linked',
      poolGroupAddress: group.toBase58(),
    })
  })

  it('leaves a standard lane and a version-1 ChainConfigV2 unmarked', async () => {
    const remotes = await query({
      'ethereum-mainnet': {
        chainConfig: account(chainConfig(false)),
        chainConfigV2: account(chainConfigV2(1, false)),
      },
    })
    assert.equal(remotes['ethereum-mainnet']?.poolGroup, undefined)
  })

  it('throws CCTDataDecodeError on a marker without a tail, and on a tail that does not decode', async () => {
    await assert.rejects(
      query({
        'ethereum-mainnet': { chainConfig: account(chainConfig(true)), chainConfigV2: null },
      }),
      CCTDataDecodeError,
    )
    await assert.rejects(
      query({
        'ethereum-mainnet': {
          chainConfig: account(chainConfig(true)),
          chainConfigV2: account(chainConfigV2().subarray(0, 40)),
        },
      }),
      CCTDataDecodeError,
    )
  })

  it('pages multi-account reads 100 keys at a time (more than 50 remotes)', async () => {
    const calls: number[] = []
    const keys = Array.from({ length: 250 }, (_, i) => key(i % 255))
    const out = await getMultipleAccountsInfoPaged(
      {
        getMultipleAccountsInfo: async (k: PublicKey[]) => {
          calls.push(k.length)
          return k.map(() => null)
        },
      } as unknown as Connection,
      keys,
    )
    assert.deepEqual(calls, [100, 100, 50])
    assert.equal(out.length, 250)
  })

  describe('validation', () => {
    it('validates the token address and optional remote selector before reading', async () => {
      const cases: Array<[Partial<{ tokenAddress: string; remoteChainSelector: bigint }>, string]> =
        [
          [{ tokenAddress: 'invalid' }, 'tokenAddress'],
          [{ remoteChainSelector: -1n }, 'remoteChainSelector'],
          [{ remoteChainSelector: 1 as never }, 'remoteChainSelector'],
        ]
      for (const [opts, param] of cases) {
        await assert.rejects(
          new GetTokenPoolRemotes().query(chain(), {
            tokenAddress: mint.toBase58(),
            poolProgramAddress: program.toBase58(),
            remoteChainSelector: selector,
            ...opts,
          }),
          (error: unknown) =>
            error instanceof CCTParamsInvalidError && error.context.param === param,
        )
      }
    })
  })
})
