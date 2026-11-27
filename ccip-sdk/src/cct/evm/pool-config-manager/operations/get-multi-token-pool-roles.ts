/**
 * getMultiTokenPoolRoles — the PCM roles each of a set of accounts holds.
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

import type { EVMChain } from '../../../../evm/index.ts'
import { latestBlock } from '../../mined-block.ts'
import {
  type PoolConfigManagerRole,
  POOL_CONFIG_MANAGER_ROLES,
  poolConfigManagerContract,
  readPoolConfigManagerRolesHeld,
} from '../../multi-token-pool/contracts.ts'
import { EVMQuery } from '../../query.ts'
import { validateAddressArray } from '../../validate.ts'
import {
  type PoolConfigManagerTarget,
  resolvePoolConfigManagerTarget,
  validatePoolConfigManagerTarget,
} from '../contracts.ts'

/** Parameters for `getMultiTokenPoolRoles`. */
export type GetMultiTokenPoolRolesParams = PoolConfigManagerTarget & {
  /** Accounts to check, at least one. */
  accounts: string[]
}
/** Result of `getMultiTokenPoolRoles`: one entry per account, in input order. */
export type GetMultiTokenPoolRolesResult = {
  /** The account, checksummed. */
  account: string
  /** Roles it holds, in {@link POOL_CONFIG_MANAGER_ROLES} order. */
  roles: PoolConfigManagerRole[]
}[]

/**
 * Reads the PCM roles each account holds, one `hasRole` per (account, role), in parallel.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC)
 * @throws {@link CCTContractTypeInvalidError} if the target is not a PCM, or `poolAddress` is not
 * a multi-token pool
 */
export class GetMultiTokenPoolRoles extends EVMQuery<
  GetMultiTokenPoolRolesParams,
  GetMultiTokenPoolRolesResult
> {
  readonly name = 'getMultiTokenPoolRoles'

  protected prepare(params: GetMultiTokenPoolRolesParams): GetMultiTokenPoolRolesParams {
    validatePoolConfigManagerTarget(this.name, params)
    validateAddressArray(this.name, 'accounts', params.accounts, 1)
    return params
  }

  protected async read(
    chain: EVMChain,
    params: GetMultiTokenPoolRolesParams,
  ): Promise<GetMultiTokenPoolRolesResult> {
    const { address, version } = await resolvePoolConfigManagerTarget(chain, params)
    const pcm = poolConfigManagerContract(chain, address, version)
    // every account at one block, so the answers are consistent
    const blockTag = await latestBlock(chain)
    return Promise.all(
      params.accounts.map(async (raw) => ({
        account: getAddress(raw),
        roles: await readPoolConfigManagerRolesHeld(pcm, raw, POOL_CONFIG_MANAGER_ROLES, blockTag),
      })),
    )
  }
}
