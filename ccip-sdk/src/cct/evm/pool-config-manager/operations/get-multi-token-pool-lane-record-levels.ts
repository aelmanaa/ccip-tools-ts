/**
 * getMultiTokenPoolLaneRecordLevels — `getLaneRecordLevelBatch`: where each record type resolves
 * from, per lane; works before a lane exists.
 *
 * @packageDocumentation
 */

import type { LaneRecordType } from '../../../../chain.ts'
import { LANE_RECORD_TYPES } from '../../../../evm/multi-token-pool.ts'
import {
  type MultiTokenPoolLaneKey,
  type PoolConfigManagerReader,
  decodeEnum,
  toAbiLaneKey,
} from '../contracts.ts'
import {
  type GetMultiTokenPoolLaneBatchParams,
  type LaneChunkContext,
  LaneBatchQuery,
} from './lane-batch.ts'

/** The PCM `RecordLevel` enum, in order (index = on-chain value). */
/** The PCM `RecordLevel` enum, in on-chain order. @internal */
export const RECORD_LEVELS = ['none', 'inline', 'policy-chain', 'policy-default'] as const
/** The PCM `RecordLevel` enum. */
export type MultiTokenPoolRecordLevel = (typeof RECORD_LEVELS)[number]
/** One lane's record levels. */
export type MultiTokenPoolLaneRecordLevels = {
  /** Where each record type resolves from; `'none'` means a transfer that reads it reverts. */
  levels: Record<LaneRecordType, MultiTokenPoolRecordLevel>
}

/** Result of `multiTokenPoolLaneRecordLevels`: one entry per lane, in input order, with its key. */
export type GetMultiTokenPoolLaneRecordLevelsResult = (MultiTokenPoolLaneKey &
  MultiTokenPoolLaneRecordLevels)[]

/**
 * Reads `getLaneRecordLevelBatch`.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC)
 * @throws {@link CCTContractTypeInvalidError} if the target is not a PCM, or `poolAddress` is not
 * a multi-token pool
 */
export class GetMultiTokenPoolLaneRecordLevels extends LaneBatchQuery<
  GetMultiTokenPoolLaneBatchParams,
  MultiTokenPoolLaneRecordLevels
> {
  readonly name = 'getMultiTokenPoolLaneRecordLevels'

  protected async readChunk(
    pcm: PoolConfigManagerReader,
    lanes: MultiTokenPoolLaneKey[],
    _params: GetMultiTokenPoolLaneBatchParams,
    { address, blockTag }: LaneChunkContext,
  ): Promise<MultiTokenPoolLaneRecordLevels[]> {
    // one array per record type, in LANE_RECORD_TYPES order, each with one level per lane
    const byType = await pcm.getLaneRecordLevelBatch(lanes.map(toAbiLaneKey), { blockTag })
    return lanes.map((_, i) => ({
      levels: Object.fromEntries(
        LANE_RECORD_TYPES.map((type, t) => [
          type,
          decodeEnum(RECORD_LEVELS, byType[t]?.[i] ?? NaN, `${type} record level`, address),
        ]),
      ) as Record<LaneRecordType, MultiTokenPoolRecordLevel>,
    }))
  }
}
