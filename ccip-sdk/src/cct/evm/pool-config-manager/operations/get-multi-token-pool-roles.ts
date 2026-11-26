/**
 * getMultiTokenPoolRoles — the PCM roles each of a set of accounts holds.
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

import type { EVMChain } from '../../../../evm/index.ts'
import {
  type PoolConfigManagerRole,
  POOL_CONFIG_MANAGER_ROLES,
  poolConfigManagerContract,
  poolConfigManagerRoleId,
} from '../../multi-token-pool/contracts.ts'
import { EVMQuery } from '../../query.ts'
import { validateAddress, validateArray } from '../../validate.ts'
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
    validateArray(this.name, 'accounts', params.accounts, 1)
    // visit sparse holes too, so a hole fails here rather than as an RPC error
    Array.from(params.accounts, (a, i) => validateAddress(this.name, `accounts[${i}]`, a))
    return params
  }

  protected async read(
    chain: EVMChain,
    params: GetMultiTokenPoolRolesParams,
  ): Promise<GetMultiTokenPoolRolesResult> {
    const { address, version } = await resolvePoolConfigManagerTarget(chain, params)
    const pcm = poolConfigManagerContract(chain, address, version)
    return Promise.all(
      params.accounts.map(async (raw) => {
        const account = getAddress(raw)
        const held = await Promise.all(
          POOL_CONFIG_MANAGER_ROLES.map((role) =>
            pcm.hasRole(poolConfigManagerRoleId(role), account),
          ),
        )
        return { account, roles: POOL_CONFIG_MANAGER_ROLES.filter((_, i) => held[i]) }
      }),
    )
  }
}
