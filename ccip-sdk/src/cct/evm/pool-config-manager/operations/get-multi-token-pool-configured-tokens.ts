/**
 * getMultiTokenPoolConfiguredTokens — every token a PCM registers, every page at one block.
 *
 * @packageDocumentation
 */

import type { EVMChain } from '../../../../evm/index.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { EVMQuery } from '../../query.ts'
import { validateUint32 } from '../../validate.ts'
import {
  type PoolConfigManagerTarget,
  readConfiguredTokens,
  resolvePoolConfigManagerTarget,
  validatePoolConfigManagerTarget,
} from '../contracts.ts'

/** Parameters for `getMultiTokenPoolConfiguredTokens`: every page at one block. */
export type GetMultiTokenPoolConfiguredTokensParams = PoolConfigManagerTarget & {
  /** Block to read at; defaults to the latest block. */
  blockTag?: number
  /** Tokens per `getAllConfiguredTokens` call; defaults to 200. */
  pageSize?: number
}
/** Result of `getMultiTokenPoolConfiguredTokens`. */
export type GetMultiTokenPoolConfiguredTokensResult = {
  /** Registered tokens, checksummed, in the store's order at `blockNumber`. */
  tokens: string[]
  /** The block every page was read at. */
  blockNumber: number
}

/**
 * Reads every registered token.
 * @remarks Deregistration swap-removes, which reorders pages between blocks, so every page is read
 * at the same block.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC)
 * @throws {@link CCTContractTypeInvalidError} if the target is not a PCM, or `poolAddress` is not
 * a multi-token pool
 */
export class GetMultiTokenPoolConfiguredTokens extends EVMQuery<
  GetMultiTokenPoolConfiguredTokensParams,
  GetMultiTokenPoolConfiguredTokensResult
> {
  readonly name = 'getMultiTokenPoolConfiguredTokens'

  protected prepare(
    params: GetMultiTokenPoolConfiguredTokensParams,
  ): GetMultiTokenPoolConfiguredTokensParams {
    validatePoolConfigManagerTarget(this.name, params)
    if (params.blockTag !== undefined) validateUint32(this.name, 'blockTag', params.blockTag)
    if (params.pageSize !== undefined) {
      validateUint32(this.name, 'pageSize', params.pageSize)
      if (params.pageSize === 0)
        throw new CCTParamsInvalidError(this.name, 'pageSize', 'must be at least 1')
    }
    return params
  }

  protected async read(
    chain: EVMChain,
    params: GetMultiTokenPoolConfiguredTokensParams,
  ): Promise<GetMultiTokenPoolConfiguredTokensResult> {
    const { address, version } = await resolvePoolConfigManagerTarget(chain, params)
    return readConfiguredTokens(chain, address, version, params)
  }
}
