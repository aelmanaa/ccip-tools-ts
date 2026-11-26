/**
 * getMultiTokenPoolState — type, version, owner, pending owner, Router, RMN proxy and PCM of a
 * multi-token pool.
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

import type { EVMChain } from '../../../../evm/index.ts'
import { resultToObject } from '../../../../evm/types.ts'
import { EVMQuery } from '../../query.ts'
import { validateNonZeroAddress } from '../../validate.ts'
import {
  type MultiTokenPoolType,
  type MultiTokenPoolVersion,
  type PendingOwner,
  multiTokenPoolContract,
  readOwnership,
  resolveMultiTokenPool,
} from '../contracts.ts'
import type { MultiTokenPoolReadParams } from './is-multi-token-pool.ts'

/** Result of `getMultiTokenPoolState`. */
export type GetMultiTokenPoolStateResult = PendingOwner & {
  /** Contract type. */
  type: MultiTokenPoolType
  /** Version, with its pre-release suffix. */
  version: MultiTokenPoolVersion
  /** The raw `typeAndVersion()` string. */
  typeAndVersion: string
  /** Pool owner (router, PCM pointer and ownership). */
  owner: string
  /** The Router the pool accepts calls from. */
  router: string
  /** The RMN proxy the pool checks curses with. */
  rmnProxy: string
  /** The PoolConfigManager that holds every token's configuration. */
  poolConfigManager: string
}

/**
 * Reads a multi-token pool's state.
 * @throws {@link CCTParamsInvalidError} if `poolAddress` is invalid (before any RPC)
 * @throws {@link CCTContractTypeInvalidError} if the address is not a multi-token pool
 * @throws {@link CCTContractVersionUnsupportedError} if its version is unknown
 * @throws {@link CCTDataDecodeError} if its storage is not the `Ownable2Step` layout the pending
 * owner is read from
 */
export class GetMultiTokenPoolState extends EVMQuery<
  MultiTokenPoolReadParams,
  GetMultiTokenPoolStateResult
> {
  readonly name = 'getMultiTokenPoolState'

  protected prepare(params: MultiTokenPoolReadParams): MultiTokenPoolReadParams {
    validateNonZeroAddress(this.name, 'poolAddress', params.poolAddress)
    return params
  }

  protected async read(
    chain: EVMChain,
    { poolAddress }: MultiTokenPoolReadParams,
  ): Promise<GetMultiTokenPoolStateResult> {
    const [{ type, version }, [, , typeAndVersion]] = await Promise.all([
      resolveMultiTokenPool(chain, poolAddress),
      chain.typeAndVersion(poolAddress),
    ])
    const pool = multiTokenPoolContract(chain, poolAddress, version)
    const [{ owner, pendingOwner }, router, rmnProxy, poolConfigManager] = await Promise.all([
      readOwnership(chain, poolAddress),
      pool.getRouter().then((a) => getAddress(resultToObject(a))),
      pool.getRmnProxy().then((a) => getAddress(resultToObject(a))),
      pool.getPoolConfigManager().then((a) => getAddress(resultToObject(a))),
    ])
    return {
      type,
      version,
      typeAndVersion,
      owner,
      pendingOwner,
      router,
      rmnProxy,
      poolConfigManager,
    }
  }
}
