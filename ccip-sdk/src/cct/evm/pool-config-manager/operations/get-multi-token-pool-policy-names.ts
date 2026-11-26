/**
 * getMultiTokenPoolPolicyNames — every policy name per record type, including unused ones.
 *
 * @packageDocumentation
 */

import type { LaneRecordType } from '../../../../chain.ts'
import type { EVMChain } from '../../../../evm/index.ts'
import { LANE_RECORD_TYPES } from '../../../../evm/multi-token-pool.ts'
import { poolConfigManagerContract } from '../../multi-token-pool/contracts.ts'
import { EVMQuery } from '../../query.ts'
import {
  type PolicyName,
  type PoolConfigManagerTarget,
  decodePolicyName,
  resolvePoolConfigManagerTarget,
  validatePoolConfigManagerTarget,
} from '../contracts.ts'

/** Result of `getMultiTokenPoolPolicyNames`: every policy per record type, including unused ones. */
export type GetMultiTokenPoolPolicyNamesResult = Record<LaneRecordType, PolicyName[]>

/**
 * Reads every policy name per record type.
 * @throws {@link CCTParamsInvalidError} if the target is invalid (before any RPC)
 * @throws {@link CCTContractTypeInvalidError} if the target is not a PCM, or `poolAddress` is not
 * a multi-token pool
 */
export class GetMultiTokenPoolPolicyNames extends EVMQuery<
  PoolConfigManagerTarget,
  GetMultiTokenPoolPolicyNamesResult
> {
  readonly name = 'getMultiTokenPoolPolicyNames'

  protected prepare(params: PoolConfigManagerTarget): PoolConfigManagerTarget {
    validatePoolConfigManagerTarget(this.name, params)
    return params
  }

  protected async read(
    chain: EVMChain,
    target: PoolConfigManagerTarget,
  ): Promise<GetMultiTokenPoolPolicyNamesResult> {
    const { address, version } = await resolvePoolConfigManagerTarget(chain, target)
    // one list per record type, in LANE_RECORD_TYPES order
    const lists = await poolConfigManagerContract(chain, address, version).getPolicyNames()
    return Object.fromEntries(
      LANE_RECORD_TYPES.map((type, i) => [
        type,
        (lists[i] ?? []).map((w) => decodePolicyName(w)).filter((n): n is string => n !== null),
      ]),
    ) as GetMultiTokenPoolPolicyNamesResult
  }
}
