/**
 * The shared shape of the six PCM lane batch views: validate the lane list, resolve the PCM, then
 * read in chunks of 100 lanes and return one entry per lane, in input order.
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

import type { EVMChain } from '../../../../evm/index.ts'
import { CCTDataDecodeError } from '../../../errors.ts'
import {
  type MultiTokenPoolVersion,
  poolConfigManagerContract,
} from '../../multi-token-pool/contracts.ts'
import { EVMQuery } from '../../query.ts'
import { validateUint32 } from '../../validate.ts'
import {
  type MultiTokenPoolLaneKey,
  type PoolConfigManagerReader,
  type PoolConfigManagerTarget,
  readLaneBatches,
  resolvePoolConfigManagerTarget,
  validateLaneKeys,
  validatePoolConfigManagerTarget,
} from '../contracts.ts'

/** What a chunk read gets: the chain, the PCM, and the block every chunk is read at. @internal */
export type LaneChunkContext = {
  chain: EVMChain
  address: string
  version: MultiTokenPoolVersion
  blockTag: number
}

/** Parameters for the PCM lane batch views; chunked into calls of 100 lanes. */
export type GetMultiTokenPoolLaneBatchParams = PoolConfigManagerTarget & {
  /** Lanes to read, at least one. */
  lanes: MultiTokenPoolLaneKey[]
  /** Block to read every chunk at; defaults to the latest block, read once. */
  blockTag?: number
}

/**
 * Base of the lane batch reads. Subclasses supply {@link LaneBatchQuery.readChunk}, which reads
 * at most 100 lanes and returns one result per lane, in order.
 * @internal
 */
export abstract class LaneBatchQuery<
  P extends GetMultiTokenPoolLaneBatchParams,
  R,
> extends EVMQuery<P, (MultiTokenPoolLaneKey & R)[]> {
  /** Reads one chunk of lanes; `lanes` hold checksummed tokens. */
  protected abstract readChunk(
    pcm: PoolConfigManagerReader,
    lanes: MultiTokenPoolLaneKey[],
    params: P,
    ctx: LaneChunkContext,
  ): Promise<R[]>

  /** Validates the target and the lanes; subclasses add their own checks after calling it. */
  protected prepare(params: P): P {
    validatePoolConfigManagerTarget(this.name, params)
    validateLaneKeys(this.name, 'lanes', params.lanes)
    if (params.blockTag !== undefined) validateUint32(this.name, 'blockTag', params.blockTag)
    return params
  }

  protected async read(chain: EVMChain, params: P): Promise<(MultiTokenPoolLaneKey & R)[]> {
    const { address, version } = await resolvePoolConfigManagerTarget(chain, params)
    const pcm = poolConfigManagerContract(chain, address, version)
    // one block for every chunk, so a large read does not mix states
    const blockTag = params.blockTag ?? (await chain.provider.getBlockNumber())
    const lanes = params.lanes.map((l) => ({
      tokenAddress: getAddress(l.tokenAddress),
      remoteChainSelector: l.remoteChainSelector,
    }))
    return readLaneBatches(lanes, async (chunk) => {
      const results = await this.readChunk(pcm, chunk, params, {
        chain,
        address,
        version,
        blockTag,
      })
      if (results.length !== chunk.length)
        throw new CCTDataDecodeError(address, {
          context: {
            reason: `${this.name} read ${results.length} results for ${chunk.length} lanes`,
          },
        })
      return chunk.map((lane, i) => ({ ...lane, ...results[i]! }))
    })
  }
}
