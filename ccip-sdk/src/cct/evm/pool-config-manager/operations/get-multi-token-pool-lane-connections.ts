/**
 * getMultiTokenPoolLaneConnections — `getLaneConnectionBatch`, decoded: connection, pauses, pool data
 * format, remote token and trusted remote pools per lane.
 *
 * @packageDocumentation
 */

import { decodeLaneConnection } from '../../../../evm/multi-token-pool.ts'
import { resultToObject } from '../../../../evm/types.ts'
import type { MultiTokenPoolRemotePool, PoolDataFormat } from '../../../multi-token-pool.ts'
import { decodeRemoteAddress } from '../../../remote-address.ts'
import {
  type MultiTokenPoolLaneKey,
  type PoolConfigManagerReader,
  toAbiLaneKey,
} from '../contracts.ts'
import {
  type GetMultiTokenPoolLaneBatchParams,
  type LaneChunkContext,
  LaneBatchQuery,
} from './lane-batch.ts'

/** One decoded `LaneConnection`, the only lane view with pause state. */
export type MultiTokenPoolLaneConnection = {
  /** Whether a connection (remote token) resolves; without one the lane is closed. */
  hasConnection: boolean
  /** Whether outbound transfers are paused by any pause (global, chain or token). */
  isOutboundPaused: boolean
  /** Whether inbound transfers are paused by any pause. */
  isInboundPaused: boolean
  /** The PCM-wide pause. */
  isGloballyPaused: boolean
  /** The token's own outbound pause. */
  isTokenOutboundPaused: boolean
  /** The token's own inbound pause. */
  isTokenInboundPaused: boolean
  /** The remote chain's outbound pause. */
  isChainOutboundPaused: boolean
  /** The remote chain's inbound pause. */
  isChainInboundPaused: boolean
  /** Pool data the lane sends: `'legacy'` (32 bytes) or `'long'`. */
  poolDataFormat: PoolDataFormat
  /** Remote token in the remote chain's canonical format, or `null` without a connection. */
  remoteToken: string | null
  /** Remote pools the lane trusts for inbound messages. */
  remotePools: MultiTokenPoolRemotePool[]
}

/** Result of `multiTokenPoolLaneConnections`: one entry per lane, in input order, with its key. */
export type GetMultiTokenPoolLaneConnectionsResult = (MultiTokenPoolLaneKey &
  MultiTokenPoolLaneConnection)[]

/**
 * Reads `getLaneConnectionBatch`.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC)
 * @throws {@link CCTContractTypeInvalidError} if the target is not a PCM, or `poolAddress` is not
 * a multi-token pool
 */
export class GetMultiTokenPoolLaneConnections extends LaneBatchQuery<
  GetMultiTokenPoolLaneBatchParams,
  MultiTokenPoolLaneConnection
> {
  readonly name = 'getMultiTokenPoolLaneConnections'

  protected async readChunk(
    pcm: PoolConfigManagerReader,
    lanes: GetMultiTokenPoolLaneBatchParams['lanes'],
    _params: GetMultiTokenPoolLaneBatchParams,
    { blockTag }: LaneChunkContext,
  ): Promise<MultiTokenPoolLaneConnection[]> {
    const connections = await pcm.getLaneConnectionBatch(lanes.map(toAbiLaneKey), { blockTag })
    return connections.map((raw, i) => {
      const selector = lanes[i]!.remoteChainSelector
      return decodeLaneConnection(resultToObject(raw), (bytes) =>
        decodeRemoteAddress(bytes, selector),
      )
    })
  }
}
