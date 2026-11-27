/**
 * getMultiTokenPoolLaneVerifications — `getLaneVerificationBatch`: the hook and the CCV lists per
 * lane.
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

import { resultToObject } from '../../../../evm/types.ts'
import { ANY_FINALITY_CONFIG, nullableAddress } from '../../multi-token-pool/contracts.ts'
import {
  type MultiTokenPoolLaneKey,
  type PoolConfigManagerReader,
  assertResultCount,
  toAbiLaneKey,
} from '../contracts.ts'
import {
  type GetMultiTokenPoolLaneBatchParams,
  type LaneChunkContext,
  LaneBatchQuery,
} from './lane-batch.ts'

/** One lane's verification. */
export type MultiTokenPoolLaneVerification = {
  /** The hook contract that resolves for the lane, or `null`. */
  hook: string | null
  /** CCVs an outbound transfer needs (`address(0)` = the default CCVs). */
  outboundCCVs: string[]
  /** CCVs an inbound transfer needs. */
  inboundCCVs: string[]
}

/** Result of `multiTokenPoolLaneVerifications`: one entry per lane, in input order, with its key. */
export type GetMultiTokenPoolLaneVerificationsResult = (MultiTokenPoolLaneKey &
  MultiTokenPoolLaneVerification)[]

/**
 * Reads `getLaneVerificationBatch`; a lane that does not exist reads no hook and no CCVs.
 * @remarks The pool ignores amount and finality for CCVs.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC)
 * @throws {@link CCTContractTypeInvalidError} if the target is not a PCM, or `poolAddress` is not
 * a multi-token pool
 */
export class GetMultiTokenPoolLaneVerifications extends LaneBatchQuery<
  GetMultiTokenPoolLaneBatchParams,
  MultiTokenPoolLaneVerification
> {
  readonly name = 'getMultiTokenPoolLaneVerifications'

  protected async readChunk(
    pcm: PoolConfigManagerReader,
    lanes: MultiTokenPoolLaneKey[],
    _params: GetMultiTokenPoolLaneBatchParams,
    { address, blockTag }: LaneChunkContext,
  ): Promise<MultiTokenPoolLaneVerification[]> {
    // positional: `resultToObject` on the whole multi-output Result would return a named object
    const [hooks, outbound, inbound] = await pcm.getLaneVerificationBatch(
      lanes.map(toAbiLaneKey),
      ANY_FINALITY_CONFIG,
      { blockTag },
    )
    for (const column of [hooks, outbound, inbound])
      assertResultCount(address, 'getLaneVerificationBatch', column, lanes.length)
    return lanes.map((_, i) =>
      decodeLaneVerification(
        resultToObject(hooks[i]!),
        resultToObject(outbound[i]!),
        resultToObject(inbound[i]!),
      ),
    )
  }
}

/**
 * One lane's verification from a `getLaneVerificationBatch` row: shared by the read and the guard's
 * `eth_simulateV1` cross-check.
 * @internal
 */
export function decodeLaneVerification(
  hook: string,
  outboundCCVs: readonly string[],
  inboundCCVs: readonly string[],
): MultiTokenPoolLaneVerification {
  return {
    hook: nullableAddress(hook),
    outboundCCVs: outboundCCVs.map((a) => getAddress(a)),
    inboundCCVs: inboundCCVs.map((a) => getAddress(a)),
  }
}
