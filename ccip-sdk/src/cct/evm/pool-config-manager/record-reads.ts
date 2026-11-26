/**
 * The PCM's stored-record reads, each one view call plus its decode, at an optional block: the
 * per-policy and inline-config ops are built on them, and so is the projection's state loader, which
 * needs every read at one block.
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

import type { LaneRecordType } from '../../../chain.ts'
import type { EVMChain } from '../../../evm/index.ts'
import { resultToObject } from '../../../evm/types.ts'
import { decodeRemoteAddress } from '../../remote-address.ts'
import { nullableAddress } from '../multi-token-pool/contracts.ts'
import { type PoolConfigManagerReader, readPagesAtBlock } from './contracts.ts'
import {
  decodeDestOverheadConfig,
  decodeFeeConfig,
  decodeInlineKey,
  decodeInlineRemotePoolConfig,
  decodePolicyRecordKey,
  decodeRateLimits,
  decodeSecurityConfig,
} from './decode.ts'
import type { GetMultiTokenPoolConnectionPolicyResult } from './operations/get-multi-token-pool-connection-policy.ts'
import type { GetMultiTokenPoolDestOverheadPolicyResult } from './operations/get-multi-token-pool-dest-overhead-policy.ts'
import type { GetMultiTokenPoolFeePolicyResult } from './operations/get-multi-token-pool-fee-policy.ts'
import type { GetMultiTokenPoolInlineConfigsResult } from './operations/get-multi-token-pool-inline-configs.ts'
import type { GetMultiTokenPoolRateLimitPolicyResult } from './operations/get-multi-token-pool-rate-limit-policy.ts'
import type { GetMultiTokenPoolRemotePoolPolicyResult } from './operations/get-multi-token-pool-remote-pool-policy.ts'
import type { GetMultiTokenPoolSecurityPolicyResult } from './operations/get-multi-token-pool-security-policy.ts'
import type { MultiTokenPoolPolicyIdentity } from './operations/policy-query.ts'

/** Call overrides of a record read: the block to read at (latest when omitted). @internal */
export type RecordReadOverrides = { blockTag?: number }

type Records<R> = Omit<R, keyof MultiTokenPoolPolicyIdentity>

/**
 * One policy's records per record type, from its `get<Type>Policy` view.
 * @internal
 */
export const POLICY_RECORD_READERS = {
  connection: async (
    pcm: PoolConfigManagerReader,
    policyWord: string,
    overrides: RecordReadOverrides = {},
  ): Promise<Records<GetMultiTokenPoolConnectionPolicyResult>> => {
    const [tokenCount, provider, records] = await pcm.getConnectionPolicy(policyWord, overrides)
    return {
      tokenCount: Number(tokenCount),
      remoteTokenAddressProvider: nullableAddress(resultToObject(provider)),
      records: records.map((raw) => {
        const r = resultToObject(raw)
        return { ...decodePolicyRecordKey(r), onlySubsetTokens: r.onlySubsetTokens }
      }),
    }
  },
  remotePool: async (
    pcm: PoolConfigManagerReader,
    policyWord: string,
    overrides: RecordReadOverrides = {},
  ): Promise<Records<GetMultiTokenPoolRemotePoolPolicyResult>> => {
    const [tokenCount, records] = await pcm.getRemotePoolPolicy(policyWord, overrides)
    return {
      tokenCount: Number(tokenCount),
      records: records.map((raw) => {
        const r = resultToObject(raw)
        const key = decodePolicyRecordKey(r)
        return {
          ...key,
          remotePoolAddresses: r.remotePoolAddresses.map((a: string) =>
            decodeRemoteAddress(a, key.remoteChainSelector),
          ),
        }
      }),
    }
  },
  rateLimit: async (
    pcm: PoolConfigManagerReader,
    policyWord: string,
    overrides: RecordReadOverrides = {},
  ): Promise<Records<GetMultiTokenPoolRateLimitPolicyResult>> => {
    const [tokenCount, decimals, records] = await pcm.getRateLimitPolicy(policyWord, overrides)
    const decoded = records.map((raw) => {
      const r = resultToObject(raw)
      return {
        ...decodePolicyRecordKey(r),
        localDecimals: Number(r.localDecimals),
        rateLimits: decodeRateLimits(r.rateLimitConfig),
      }
    })
    return {
      tokenCount: Number(tokenCount),
      // the policy's decimals are fixed by its first record; `0` with no record means unset
      localDecimals: decoded.length ? Number(decimals) : null,
      records: decoded,
    }
  },
  fee: async (
    pcm: PoolConfigManagerReader,
    policyWord: string,
    overrides: RecordReadOverrides = {},
  ): Promise<Records<GetMultiTokenPoolFeePolicyResult>> => {
    const [tokenCount, records] = await pcm.getFeePolicy(policyWord, overrides)
    return {
      tokenCount: Number(tokenCount),
      records: records.map((raw) => {
        const r = resultToObject(raw)
        return { ...decodePolicyRecordKey(r), feeConfig: decodeFeeConfig(r.feeConfig) }
      }),
    }
  },
  destOverhead: async (
    pcm: PoolConfigManagerReader,
    policyWord: string,
    overrides: RecordReadOverrides = {},
  ): Promise<Records<GetMultiTokenPoolDestOverheadPolicyResult>> => {
    const [tokenCount, records] = await pcm.getDestOverheadPolicy(policyWord, overrides)
    return {
      tokenCount: Number(tokenCount),
      records: records.map((raw) => {
        const r = resultToObject(raw)
        return {
          ...decodePolicyRecordKey(r),
          destOverheadConfig: decodeDestOverheadConfig(r.destOverheadConfig),
        }
      }),
    }
  },
  security: async (
    pcm: PoolConfigManagerReader,
    policyWord: string,
    overrides: RecordReadOverrides = {},
  ): Promise<Records<GetMultiTokenPoolSecurityPolicyResult>> => {
    const [tokenCount, records] = await pcm.getSecurityPolicy(policyWord, overrides)
    return {
      tokenCount: Number(tokenCount),
      records: records.map((raw) => {
        const r = resultToObject(raw)
        return {
          ...decodePolicyRecordKey(r),
          securityConfig: decodeSecurityConfig(r.securityConfig),
        }
      }),
    }
  },
} as const satisfies Record<
  LaneRecordType,
  (pcm: PoolConfigManagerReader, word: string, overrides?: RecordReadOverrides) => Promise<unknown>
>

/**
 * One token's inline records per record type, from its `getInline<Type>Configs` view.
 * @internal
 */
export const INLINE_RECORD_READERS = {
  connection: async (
    pcm: PoolConfigManagerReader,
    token: string,
    overrides: RecordReadOverrides = {},
  ) =>
    (await pcm.getInlineConnectionConfigs(token, overrides)).map((raw) => {
      const c = resultToObject(raw)
      const key = decodeInlineKey(c)
      return { ...key, remoteToken: decodeRemoteAddress(c.remoteToken, key.remoteChainSelector) }
    }),
  remotePool: async (
    pcm: PoolConfigManagerReader,
    token: string,
    overrides: RecordReadOverrides = {},
  ) =>
    (await pcm.getInlineRemotePoolConfigs(token, overrides)).map((raw) =>
      decodeInlineRemotePoolConfig(resultToObject(raw)),
    ),
  rateLimit: async (
    pcm: PoolConfigManagerReader,
    token: string,
    overrides: RecordReadOverrides = {},
  ) =>
    (await pcm.getInlineRateLimitConfigs(token, overrides)).map((raw) => {
      const c = resultToObject(raw)
      return { ...decodeInlineKey(c), rateLimits: decodeRateLimits(c.rateLimitConfig) }
    }),
  fee: async (pcm: PoolConfigManagerReader, token: string, overrides: RecordReadOverrides = {}) =>
    (await pcm.getInlineFeeConfigs(token, overrides)).map((raw) => {
      const c = resultToObject(raw)
      return { ...decodeInlineKey(c), feeConfig: decodeFeeConfig(c.feeConfig) }
    }),
  destOverhead: async (
    pcm: PoolConfigManagerReader,
    token: string,
    overrides: RecordReadOverrides = {},
  ) =>
    (await pcm.getInlineDestOverheadConfigs(token, overrides)).map((raw) => {
      const c = resultToObject(raw)
      return {
        ...decodeInlineKey(c),
        destOverheadConfig: decodeDestOverheadConfig(c.destOverheadConfig),
      }
    }),
  security: async (
    pcm: PoolConfigManagerReader,
    token: string,
    overrides: RecordReadOverrides = {},
  ) =>
    (await pcm.getInlineSecurityConfigs(token, overrides)).map((raw) => {
      const c = resultToObject(raw)
      return { ...decodeInlineKey(c), securityConfig: decodeSecurityConfig(c.securityConfig) }
    }),
} as const satisfies {
  [T in LaneRecordType]: (
    pcm: PoolConfigManagerReader,
    token: string,
    overrides?: RecordReadOverrides,
  ) => Promise<NonNullable<GetMultiTokenPoolInlineConfigsResult[T]>>
}

/**
 * A connection policy record's subset tokens for one chain, every page at one block, with the
 * record's `onlySubsetTokens`.
 * @internal
 */
export async function readSubsetTokens(
  chain: EVMChain,
  pcm: PoolConfigManagerReader,
  policyWord: string,
  remoteChainSelector: bigint,
  blockTag?: number,
): Promise<{ onlySubsetTokens: boolean; tokens: string[]; blockNumber: number }> {
  let onlySubsetTokens = false
  const { items: tokens, blockNumber } = await readPagesAtBlock(
    chain,
    async (start, count, at) => {
      const [only, page] = await pcm.getSubsetTokens(
        policyWord,
        remoteChainSelector,
        start,
        count,
        {
          blockTag: at,
        },
      )
      onlySubsetTokens = only
      return page.map((t) => getAddress(resultToObject(t)))
    },
    { blockTag },
  )
  return { onlySubsetTokens, tokens, blockNumber }
}
