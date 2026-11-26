/**
 * getMultiTokenPoolInlineConfigs — a token's inline records of each type, including chains with no
 * lane.
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

import type { LaneRecordType } from '../../../../chain.ts'
import type { EVMChain } from '../../../../evm/index.ts'
import { LANE_RECORD_TYPES } from '../../../../evm/multi-token-pool.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { poolConfigManagerContract } from '../../multi-token-pool/contracts.ts'
import { EVMQuery } from '../../query.ts'
import { validateAddress, validateArray } from '../../validate.ts'
import {
  type PoolConfigManagerTarget,
  resolvePoolConfigManagerTarget,
  validatePoolConfigManagerTarget,
} from '../contracts.ts'
import { INLINE_RECORD_READERS } from '../record-reads.ts'
import type {
  InlineConnectionConfig,
  InlineDestOverheadConfig,
  InlineFeeConfig,
  InlineRateLimitConfig,
  InlineRemotePoolConfig,
  InlineSecurityConfig,
} from '../records.ts'

/** Parameters for `getMultiTokenPoolInlineConfigs`. */
export type GetMultiTokenPoolInlineConfigsParams = PoolConfigManagerTarget & {
  /** The token. */
  tokenAddress: string
  /** Record types to read; defaults to all six. */
  types?: LaneRecordType[]
}
/** Result of `getMultiTokenPoolInlineConfigs`, including chains with no lane; one key per type read. */
export type GetMultiTokenPoolInlineConfigsResult = {
  /** Inline connection records. */
  connection?: InlineConnectionConfig[]
  /** Inline remote pool records. */
  remotePool?: InlineRemotePoolConfig[]
  /** Inline rate limit records. */
  rateLimit?: InlineRateLimitConfig[]
  /** Inline fee records. */
  fee?: InlineFeeConfig[]
  /** Inline destination overhead records. */
  destOverhead?: InlineDestOverheadConfig[]
  /** Inline security records. */
  security?: InlineSecurityConfig[]
}

/**
 * Reads a token's inline records.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC)
 * @throws {@link CCTContractTypeInvalidError} if the target is not a PCM, or `poolAddress` is not
 * a multi-token pool
 */
export class GetMultiTokenPoolInlineConfigs extends EVMQuery<
  GetMultiTokenPoolInlineConfigsParams,
  GetMultiTokenPoolInlineConfigsResult
> {
  readonly name = 'getMultiTokenPoolInlineConfigs'

  protected prepare(
    params: GetMultiTokenPoolInlineConfigsParams,
  ): GetMultiTokenPoolInlineConfigsParams {
    validatePoolConfigManagerTarget(this.name, params)
    validateAddress(this.name, 'tokenAddress', params.tokenAddress)
    if (params.types !== undefined) {
      validateArray(this.name, 'types', params.types, 1)
      Array.from(params.types, (t, i) => {
        if (!LANE_RECORD_TYPES.some((k) => k === t))
          throw new CCTParamsInvalidError(
            this.name,
            `types[${i}]`,
            `must be one of ${LANE_RECORD_TYPES.join(', ')}`,
          )
      })
    }
    return params
  }

  protected async read(
    chain: EVMChain,
    params: GetMultiTokenPoolInlineConfigsParams,
  ): Promise<GetMultiTokenPoolInlineConfigsResult> {
    const { address, version } = await resolvePoolConfigManagerTarget(chain, params)
    const pcm = poolConfigManagerContract(chain, address, version)
    const token = getAddress(params.tokenAddress)
    const types = new Set(params.types ?? LANE_RECORD_TYPES)
    const entries = await Promise.all(
      LANE_RECORD_TYPES.filter((t) => types.has(t)).map(
        async (t) => [t, await INLINE_RECORD_READERS[t](pcm, token)] as const,
      ),
    )
    return Object.fromEntries(entries) as GetMultiTokenPoolInlineConfigsResult
  }
}
