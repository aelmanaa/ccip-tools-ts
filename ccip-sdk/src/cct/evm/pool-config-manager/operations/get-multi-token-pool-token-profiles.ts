/**
 * getMultiTokenPoolTokenProfiles — token profiles from the connection store, with pause flags and
 * deregistered profiles.
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

import type { EVMChain } from '../../../../evm/index.ts'
import { resultToObject } from '../../../../evm/types.ts'
import { connectionPolicyStoreContract } from '../../multi-token-pool/contracts.ts'
import { EVMQuery } from '../../query.ts'
import { validateAddressArray } from '../../validate.ts'
import {
  type MultiTokenPoolTokenProfileFields,
  type PoolConfigManagerTarget,
  LANE_BATCH_SIZE,
  decodeTokenProfile,
  readInBatches,
  readPoolConfigManagerStaticConfig,
  resolvePoolConfigManagerTarget,
  validatePoolConfigManagerTarget,
} from '../contracts.ts'

/** Parameters for `getMultiTokenPoolTokenProfiles`. */
export type GetMultiTokenPoolTokenProfilesParams = PoolConfigManagerTarget & {
  /** Tokens to read, at least one. */
  tokenAddresses: string[]
}
/** One token's profile as the connection store keeps it, deregistered profiles included. */
export type MultiTokenPoolTokenProfileState = MultiTokenPoolTokenProfileFields & {
  /** The token's own outbound pause (kept across re-registration). */
  isOutboundPaused: boolean
  /** The token's own inbound pause. */
  isInboundPaused: boolean
}
/** Result of `getMultiTokenPoolTokenProfiles`, in input order. */
export type GetMultiTokenPoolTokenProfilesResult = MultiTokenPoolTokenProfileState[]

/**
 * Reads token profiles from the PCM's ConnectionPolicyStore.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC)
 * @throws {@link CCTContractTypeInvalidError} if the target is not a PCM, or `poolAddress` is not
 * a multi-token pool
 */
export class GetMultiTokenPoolTokenProfiles extends EVMQuery<
  GetMultiTokenPoolTokenProfilesParams,
  GetMultiTokenPoolTokenProfilesResult
> {
  readonly name = 'getMultiTokenPoolTokenProfiles'

  protected prepare(
    params: GetMultiTokenPoolTokenProfilesParams,
  ): GetMultiTokenPoolTokenProfilesParams {
    validatePoolConfigManagerTarget(this.name, params)
    validateAddressArray(this.name, 'tokenAddresses', params.tokenAddresses, 1)
    return params
  }

  protected async read(
    chain: EVMChain,
    params: GetMultiTokenPoolTokenProfilesParams,
  ): Promise<GetMultiTokenPoolTokenProfilesResult> {
    const { address, version } = await resolvePoolConfigManagerTarget(chain, params)
    const { connectionPolicyStore } = await readPoolConfigManagerStaticConfig(
      chain,
      address,
      version,
    )
    const store = connectionPolicyStoreContract(chain, connectionPolicyStore, version)
    const tokens = params.tokenAddresses.map((t) => getAddress(t))
    return readInBatches(
      tokens,
      async (batch) =>
        (await store.getTokenProfiles(batch)).map((raw, i) => {
          const p = resultToObject(raw)
          return {
            ...decodeTokenProfile(batch[i]!, p, connectionPolicyStore),
            isOutboundPaused: p.isOutboundPaused,
            isInboundPaused: p.isInboundPaused,
          }
        }),
      { batchSize: LANE_BATCH_SIZE },
    )
  }
}
