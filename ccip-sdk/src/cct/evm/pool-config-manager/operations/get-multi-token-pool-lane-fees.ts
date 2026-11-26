/**
 * getMultiTokenPoolLaneFees — `getFeeBatch` for one finality, marking the lanes whose finality the
 * token does not allow instead of failing the batch.
 *
 * @packageDocumentation
 */

import { toBeHex } from 'ethers'

import { resultToObject } from '../../../../evm/types.ts'
import { type FinalityRequested, encodeFinality } from '../../../../extra-args.ts'
import { getMultiTokenPoolInterface } from '../../multi-token-pool/contracts.ts'
import { isRevertWith } from '../../query.ts'
import { type TokenPoolFee, toTokenPoolFee } from '../../token-pool/contracts.ts'
import { validateFinalityRequested } from '../../validate.ts'
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

/** Parameters for `getMultiTokenPoolLaneFees`. */
export type GetMultiTokenPoolLaneFeesParams = GetMultiTokenPoolLaneBatchParams & {
  /** Requested finality; picks the fee tier. Defaults to waiting for finality. */
  finality?: FinalityRequested
}
/**
 * One lane's fee. `getFeeBatch` reverts for the whole batch on a disallowed finality, so the op
 * reads per lane on that revert and marks the lanes.
 */
export type MultiTokenPoolLaneFee =
  | ({
      /** The token allows the finality; the fee follows. */
      finalityNotAllowed: false
    } & TokenPoolFee)
  | {
      /** The token does not allow the requested finality on this lane; a send would revert. */
      finalityNotAllowed: true
    }

/** One raw `LaneFee` of `getFeeBatch`. */
type LaneFeeResult = Awaited<ReturnType<PoolConfigManagerReader['getFeeBatch']>>[number]

/** Result of `multiTokenPoolLaneFees`: one entry per lane, in input order, with its key. */
export type GetMultiTokenPoolLaneFeesResult = (MultiTokenPoolLaneKey & MultiTokenPoolLaneFee)[]

/**
 * Reads `getFeeBatch`.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC)
 * @throws {@link CCTContractTypeInvalidError} if the target is not a PCM, or `poolAddress` is not
 * a multi-token pool
 */
export class GetMultiTokenPoolLaneFees extends LaneBatchQuery<
  GetMultiTokenPoolLaneFeesParams,
  MultiTokenPoolLaneFee
> {
  readonly name = 'getMultiTokenPoolLaneFees'

  protected override prepare(
    params: GetMultiTokenPoolLaneFeesParams,
  ): GetMultiTokenPoolLaneFeesParams {
    const parsed = super.prepare(params)
    if (params.finality !== undefined)
      validateFinalityRequested(this.name, 'finality', params.finality)
    return parsed
  }

  protected async readChunk(
    pcm: PoolConfigManagerReader,
    lanes: MultiTokenPoolLaneKey[],
    { finality = 'finalized' }: GetMultiTokenPoolLaneFeesParams,
    { address, version, blockTag }: LaneChunkContext,
  ): Promise<MultiTokenPoolLaneFee[]> {
    const requested = toBeHex(encodeFinality(finality), 4)
    const toFee = (raw: LaneFeeResult): MultiTokenPoolLaneFee => ({
      finalityNotAllowed: false,
      ...toTokenPoolFee(resultToObject(raw)),
    })
    // the connection store reverts the whole batch when one lane's token disallows the finality
    const store = getMultiTokenPoolInterface('ConnectionPolicyStore', version)
    const disallowsFinality = (err: unknown) => isRevertWith(err, store, 'InvalidRequestedFinality')
    try {
      const fees = await pcm.getFeeBatch(lanes.map(toAbiLaneKey), requested, { blockTag })
      assertResultCount(address, 'getFeeBatch', fees, lanes.length)
      return fees.map(toFee)
    } catch (err) {
      if (!disallowsFinality(err)) throw err
    }
    // read each lane on its own and mark the ones whose token disallows the finality
    return Promise.all(
      lanes.map(async (lane) => {
        try {
          const fees = await pcm.getFeeBatch([toAbiLaneKey(lane)], requested, { blockTag })
          assertResultCount(address, 'getFeeBatch', fees, 1)
          return toFee(fees[0]!)
        } catch (err) {
          if (!disallowsFinality(err)) throw err
          return { finalityNotAllowed: true } as const
        }
      }),
    )
  }
}
