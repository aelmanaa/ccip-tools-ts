/**
 * getMultiTokenPoolSubsetTokens — a connection policy's subset tokens for one chain, every page at
 * one block.
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

import { resultToObject } from '../../../../evm/types.ts'
import { validateUint32, validateUint64 } from '../../validate.ts'
import { type PoolConfigManagerReader, readPagesAtBlock } from '../contracts.ts'
import {
  type GetMultiTokenPoolPolicyParams,
  type MultiTokenPoolPolicyIdentity,
  type ParsedPolicyParams,
  type PolicyReadContext,
  type PolicyRecords,
  PolicyQuery,
} from './policy-query.ts'

/** Parameters for `getMultiTokenPoolSubsetTokens`. */
export type GetMultiTokenPoolSubsetTokensParams = GetMultiTokenPoolPolicyParams & {
  /** The remote chain. */
  remoteChainSelector: bigint
  /** Block to read at; defaults to the latest block. */
  blockTag?: number
}
/** Result of `getMultiTokenPoolSubsetTokens`. */
export type GetMultiTokenPoolSubsetTokensResult = MultiTokenPoolPolicyIdentity & {
  /** Whether only the subset tokens get a lane (`false` opens the chain to every policy token). */
  onlySubsetTokens: boolean
  /** The subset, checksummed; kept even while `onlySubsetTokens` is `false`. */
  tokens: string[]
  /** The block every page was read at. */
  blockNumber: number
}

/**
 * Reads a connection policy's subset tokens for one chain.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC)
 * @throws {@link CCTContractTypeInvalidError} if the target is not a PCM, or `poolAddress` is not
 * a multi-token pool
 */
export class GetMultiTokenPoolSubsetTokens extends PolicyQuery<
  GetMultiTokenPoolSubsetTokensParams,
  PolicyRecords<GetMultiTokenPoolSubsetTokensResult>
> {
  readonly name = 'getMultiTokenPoolSubsetTokens'
  protected readonly recordType = 'connection'

  protected override prepare(params: GetMultiTokenPoolSubsetTokensParams) {
    const parsed = super.prepare(params)
    validateUint64(this.name, 'remoteChainSelector', params.remoteChainSelector)
    if (params.blockTag !== undefined) validateUint32(this.name, 'blockTag', params.blockTag)
    return parsed
  }

  protected override blockTagOf(params: GetMultiTokenPoolSubsetTokensParams): number | undefined {
    return params.blockTag
  }

  protected async readPolicy(
    pcm: PoolConfigManagerReader,
    { policyWord, remoteChainSelector }: ParsedPolicyParams<GetMultiTokenPoolSubsetTokensParams>,
    { chain, blockTag }: PolicyReadContext,
  ): Promise<PolicyRecords<GetMultiTokenPoolSubsetTokensResult>> {
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
}
