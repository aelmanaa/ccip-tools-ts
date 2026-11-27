import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BorshAccountsCoder } from '@coral-xyz/anchor'
import { PublicKey } from '@solana/web3.js'

import type { TokenPoolRemote } from '../../../../chain.ts'
import { networkInfo } from '../../../../networks.ts'
import type { SolanaChain } from '../../../../solana/index.ts'
import { deriveTokenPoolChainConfigV2Pda } from '../../../../solana/token-pool.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { LANE_LINKED_MARKER, poolGroupsCoder } from '../../pool-group/accounts.ts'
import {
  deriveTokenPoolChainConfigPda,
  deriveTokenPoolConfigPda,
} from '../../programs/token-pool.ts'
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

  function chain(): SolanaChain {
    return {
      // the pool state under `program`; no lane accounts (not a pool-groups program)
      connection: {
        getAccountInfo: async () => ({}),
        getMultipleAccountsInfo: async (keys: unknown[]) => keys.map(() => null),
      },
      getTokenPoolRemotes: async (state: string, remoteChainSelector?: bigint) => {
        assert.equal(state, deriveTokenPoolConfigPda(program, mint).toBase58())
        assert.equal(remoteChainSelector, selector)
        return REMOTES
      },
    } as unknown as SolanaChain
  }

  describe('query', () => {
    it('delegates selected remote config decoding to the chain reader', async () => {
      const remotes = await new GetTokenPoolRemotes().query(chain(), {
        tokenAddress: mint.toBase58(),
        poolProgramAddress: program.toBase58(),
        remoteChainSelector: selector,
      })

      assert.equal(remotes, REMOTES)
    })

    it('omits the selector to read all remote configs', async () => {
      const chainWithAll = {
        connection: {
          getAccountInfo: async () => ({}),
          getMultipleAccountsInfo: async (keys: unknown[]) => keys.map(() => null),
        },
        getTokenPoolRemotes: async (_state: string, remoteChainSelector?: bigint) => {
          assert.equal(remoteChainSelector, undefined)
          return REMOTES
        },
      } as unknown as SolanaChain

      const remotes = await new GetTokenPoolRemotes().query(chainWithAll, {
        tokenAddress: mint.toBase58(),
        poolProgramAddress: program.toBase58(),
      })

      assert.equal(remotes, REMOTES)
    })
  })

  it('marks a pool-group lane with its kind and group', async () => {
    const group = key(9)
    const remoteSelector = networkInfo('ethereum-mainnet').chainSelector
    const zero = poolGroupsCoder.types.decode<Record<string, unknown>>(
      'ChainConfig',
      Buffer.alloc(512),
    )
    const body = poolGroupsCoder.types.encode('ChainConfig', zero)
    const ccLen = 8 + 139
    const cc = Buffer.alloc(ccLen + 8)
    Buffer.concat([BorshAccountsCoder.accountDiscriminator('ChainConfig'), body]).copy(cc)
    LANE_LINKED_MARKER.copy(cc, ccLen)
    const v2Zero = poolGroupsCoder.types.decode<Record<string, unknown>>(
      'ChainConfigV2',
      Buffer.alloc(512),
    )
    const v2Body = poolGroupsCoder.types.encode('ChainConfigV2', { ...v2Zero, version: 2 })
    const tail = Buffer.alloc(209)
    group.toBuffer().copy(tail, 0)
    tail[32] = 1
    const v2 = Buffer.concat([
      BorshAccountsCoder.accountDiscriminator('ChainConfigV2'),
      v2Body,
      tail,
    ])
    const accounts = new Map([
      [deriveTokenPoolChainConfigPda(program, remoteSelector, mint).toBase58(), cc],
      [deriveTokenPoolChainConfigV2Pda(program, remoteSelector, mint).toBase58(), v2],
    ])
    const marked = {
      connection: {
        getAccountInfo: async () => ({}),
        getMultipleAccountsInfo: async (keys: PublicKey[]) =>
          keys.map((k) => {
            const data = accounts.get(k.toBase58())
            return data ? { data, owner: program, lamports: 1, executable: false } : null
          }),
      },
      getTokenPoolRemotes: async () => ({ ...REMOTES }),
    } as unknown as SolanaChain
    const remotes = await new GetTokenPoolRemotes().query(marked, {
      tokenAddress: mint.toBase58(),
      poolProgramAddress: program.toBase58(),
    })
    assert.deepEqual(remotes['ethereum-mainnet']?.poolGroup, {
      kind: 'linked',
      poolGroupAddress: group.toBase58(),
    })
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
