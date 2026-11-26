/**
 * getMultiTokenPoolTokenConfigs — PCM token configs, decoded, in one `getTokenConfigBatch` call.
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

import type { LaneRecordType } from '../../../../chain.ts'
import type { EVMChain } from '../../../../evm/index.ts'
import { resultToObject } from '../../../../evm/types.ts'
import { poolConfigManagerContract } from '../../multi-token-pool/contracts.ts'
import { EVMQuery } from '../../query.ts'
import { validateAddressArray } from '../../validate.ts'
import {
  type MultiTokenPoolTokenProfileFields,
  type PolicyName,
  type PoolConfigManagerTarget,
  LANE_BATCH_SIZE,
  decodeTokenProfile,
  readInBatches,
  resolvePoolConfigManagerTarget,
  validatePoolConfigManagerTarget,
} from '../contracts.ts'
import { decodeTokenPolicies } from '../decode.ts'

/** A decoded PCM `TokenConfig`. */
export type MultiTokenPoolTokenConfig = MultiTokenPoolTokenProfileFields & {
  /** Remote chains the token has a connection to. */
  supportedChains: bigint[]
  /** The policy assigned for each record type, or `null` (inline records only). */
  policies: Record<LaneRecordType, PolicyName | null>
}

/** Parameters for `getMultiTokenPoolTokenConfigs`. */
export type GetMultiTokenPoolTokenConfigsParams = PoolConfigManagerTarget & {
  /** Tokens to read, at least one. */
  tokenAddresses: string[]
}

/**
 * Reads PCM token configs; an unregistered token reads `isRegistered: false`.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC)
 * @throws {@link CCTContractTypeInvalidError} if the target is not a PCM, or `poolAddress` is not
 * a multi-token pool
 */
export class GetMultiTokenPoolTokenConfigs extends EVMQuery<
  GetMultiTokenPoolTokenConfigsParams,
  MultiTokenPoolTokenConfig[]
> {
  readonly name = 'getMultiTokenPoolTokenConfigs'

  protected prepare(
    params: GetMultiTokenPoolTokenConfigsParams,
  ): GetMultiTokenPoolTokenConfigsParams {
    validatePoolConfigManagerTarget(this.name, params)
    validateAddressArray(this.name, 'tokenAddresses', params.tokenAddresses, 1)
    return params
  }

  protected async read(
    chain: EVMChain,
    params: GetMultiTokenPoolTokenConfigsParams,
  ): Promise<MultiTokenPoolTokenConfig[]> {
    const { address, version } = await resolvePoolConfigManagerTarget(chain, params)
    const pcm = poolConfigManagerContract(chain, address, version)
    const tokens = params.tokenAddresses.map((t) => getAddress(t))
    return readInBatches(
      tokens,
      async (batch) =>
        (await pcm.getTokenConfigBatch(batch)).map((raw, i) => {
          const c = resultToObject(raw)
          return {
            ...decodeTokenProfile(batch[i]!, c, address),
            supportedChains: c.supportedChains.map(BigInt),
            policies: decodeTokenPolicies(c),
          }
        }),
      { batchSize: LANE_BATCH_SIZE },
    )
  }
}
