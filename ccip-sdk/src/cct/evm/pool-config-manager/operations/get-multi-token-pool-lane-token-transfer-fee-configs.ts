/**
 * getMultiTokenPoolLaneTokenTransferFeeConfigs — `getTokenTransferFeeConfigBatch`: both fee tiers
 * and the destination overheads per lane.
 *
 * @packageDocumentation
 */

import type { TokenTransferFeeConfig } from '../../../../chain.ts'
import { resultToObject } from '../../../../evm/types.ts'
import { toTokenTransferFeeConfig } from '../../token-pool/contracts.ts'
import {
  type MultiTokenPoolLaneKey,
  type PoolConfigManagerReader,
  toAbiLaneKey,
} from '../contracts.ts'
import { type GetMultiTokenPoolLaneBatchParams, LaneBatchQuery } from './lane-batch.ts'

/** Result of `multiTokenPoolLaneTokenTransferFeeConfigs`: one entry per lane, in input order, with its key. */
export type GetMultiTokenPoolLaneTokenTransferFeeConfigsResult = (MultiTokenPoolLaneKey &
  TokenTransferFeeConfig)[]

/**
 * Reads `getTokenTransferFeeConfigBatch`; a lane with no fee record reads `isEnabled: false`.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC)
 * @throws {@link CCTContractTypeInvalidError} if the target is not a PCM, or `poolAddress` is not
 * a multi-token pool
 */
export class GetMultiTokenPoolLaneTokenTransferFeeConfigs extends LaneBatchQuery<
  GetMultiTokenPoolLaneBatchParams,
  TokenTransferFeeConfig
> {
  readonly name = 'getMultiTokenPoolLaneTokenTransferFeeConfigs'

  protected async readChunk(
    pcm: PoolConfigManagerReader,
    lanes: MultiTokenPoolLaneKey[],
  ): Promise<TokenTransferFeeConfig[]> {
    return (await pcm.getTokenTransferFeeConfigBatch(lanes.map(toAbiLaneKey))).map((raw) =>
      toTokenTransferFeeConfig(resultToObject(raw)),
    )
  }
}
