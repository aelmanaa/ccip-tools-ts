/**
 * getMultiTokenPoolRoleHolders — every PCM role holder, from `RoleGranted`/`RoleRevoked` logs,
 * each confirmed with `hasRole`.
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

import type { EVMChain } from '../../../../evm/index.ts'
import {
  type PoolConfigManagerRole,
  POOL_CONFIG_MANAGER_ROLES,
  POOL_CONFIG_MANAGER_TYPE,
  getMultiTokenPoolInterface,
  poolConfigManagerContract,
  poolConfigManagerRoleId,
  readPoolConfigManagerRolesHeld,
} from '../../multi-token-pool/contracts.ts'
import { EVMQuery } from '../../query.ts'
import {
  type LogScanParams,
  type PoolConfigManagerTarget,
  resolvePoolConfigManagerTarget,
  scanLogs,
  validateLogScanParams,
  validatePoolConfigManagerTarget,
} from '../contracts.ts'

/**
 * Parameters for `getMultiTokenPoolRoleHolders`: the PCM is not enumerable, so holders come from
 * `RoleGranted`/`RoleRevoked` logs in bounded ranges, each holder then confirmed with `hasRole`.
 */
export type GetMultiTokenPoolRoleHoldersParams = PoolConfigManagerTarget & LogScanParams

/** Result of `getMultiTokenPoolRoleHolders`. */
export type GetMultiTokenPoolRoleHoldersResult = {
  /** Current holders of each role, checksummed and sorted. */
  holders: Record<PoolConfigManagerRole, string[]>
  /** The block range scanned. */
  scanned: {
    /** First block. */
    fromBlock: number
    /** Last block. */
    toBlock: number
  }
  /**
   * `true` only when the scan provably starts at or before the PCM's deployment block: `fromBlock`
   * is `0`, or the deployment block was found from historical code (an archive RPC). Default-admin
   * transfers also emit `RoleRevoked`/`RoleGranted` and are included.
   */
  complete: boolean
}

/**
 * Lists every PCM role holder.
 * @remarks Every account a scanned log names is re-checked with `hasRole` at the scan's last block,
 * so the result is the current set, not the log history.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), or `fromBlock` is
 * omitted and the RPC cannot find the PCM's deployment block (pass `fromBlock`)
 * @throws {@link CCTContractTypeInvalidError} if the target is not a PCM, or `poolAddress` is not
 * a multi-token pool
 * @throws {@link CCTContractVersionUnsupportedError} if a version is unknown
 */
export class GetMultiTokenPoolRoleHolders extends EVMQuery<
  GetMultiTokenPoolRoleHoldersParams,
  GetMultiTokenPoolRoleHoldersResult
> {
  readonly name = 'getMultiTokenPoolRoleHolders'

  protected prepare(
    params: GetMultiTokenPoolRoleHoldersParams,
  ): GetMultiTokenPoolRoleHoldersParams {
    validatePoolConfigManagerTarget(this.name, params)
    validateLogScanParams(this.name, params)
    return params
  }

  protected async read(
    chain: EVMChain,
    params: GetMultiTokenPoolRoleHoldersParams,
  ): Promise<GetMultiTokenPoolRoleHoldersResult> {
    const { address, version } = await resolvePoolConfigManagerTarget(chain, params)
    const { logs, scanned, complete } = await scanLogs(chain, {
      operation: this.name,
      contract: 'PoolConfigManager',
      address,
      iface: getMultiTokenPoolInterface(POOL_CONFIG_MANAGER_TYPE, version),
      events: ['RoleGranted', 'RoleRevoked'],
      range: params,
    })

    const roleById = new Map(POOL_CONFIG_MANAGER_ROLES.map((r) => [poolConfigManagerRoleId(r), r]))
    const candidates = new Map<PoolConfigManagerRole, Set<string>>()
    for (const log of logs) {
      const role = roleById.get(String(log.args[0]))
      if (!role) continue // a role id outside the closed enum is never checked by the PCM
      const set = candidates.get(role) ?? new Set<string>()
      set.add(getAddress(String(log.args[1])))
      candidates.set(role, set)
    }

    const pcm = poolConfigManagerContract(chain, address, version)
    const holders = Object.fromEntries(
      POOL_CONFIG_MANAGER_ROLES.map((r) => [r, [] as string[]]),
    ) as Record<PoolConfigManagerRole, string[]>
    await Promise.all(
      [...candidates].flatMap(([role, accounts]) =>
        [...accounts].map(async (account) => {
          if ((await readPoolConfigManagerRolesHeld(pcm, account, [role], scanned.toBlock)).length)
            holders[role].push(account)
        }),
      ),
    )
    for (const list of Object.values(holders)) list.sort()
    return { holders, scanned, complete }
  }
}
