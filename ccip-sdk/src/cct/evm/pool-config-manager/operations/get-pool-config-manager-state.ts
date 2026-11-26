/**
 * getPoolConfigManagerState — a PCM's static config and default-admin state.
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

import type { EVMChain } from '../../../../evm/index.ts'
import { resultToObject } from '../../../../evm/types.ts'
import {
  type MultiTokenPoolVersion,
  poolConfigManagerContract,
} from '../../multi-token-pool/contracts.ts'
import { EVMQuery } from '../../query.ts'
import {
  type PoolConfigManagerTarget,
  resolvePoolConfigManagerTarget,
  validatePoolConfigManagerTarget,
} from '../contracts.ts'

/** Result of `getPoolConfigManagerState`. */
export type GetPoolConfigManagerStateResult = {
  /** The PoolConfigManager. */
  poolConfigManager: string
  /** Its version, with its pre-release suffix. */
  version: MultiTokenPoolVersion
  /** The raw `typeAndVersion()` string. */
  typeAndVersion: string
  /** The TokenAdminRegistry the PCM checks token admins against. */
  tokenAdminRegistry: string
  /** Store of connection and remote-pool policies. */
  connectionPolicyStore: string
  /** Store of fee and destination-overhead policies. */
  feePolicyStore: string
  /** Store of rate-limit and security policies. */
  securityPolicyStore: string
  /** Holder of `DEFAULT_ADMIN_ROLE`. */
  defaultAdmin: string
  /** A scheduled default-admin transfer, or `null`. */
  pendingDefaultAdmin: {
    /** The new admin. */
    newAdmin: string
    /** Unix seconds from which it can accept. */
    schedule: bigint
  } | null
  /** Seconds a default-admin transfer waits; `0` makes PCM governance changes instant (F8). */
  defaultAdminDelay: number
  /** A scheduled delay change, or `null`. */
  pendingDefaultAdminDelay: {
    /** The new delay, in seconds. */
    newDelay: number
    /** Unix seconds from which it applies. */
    schedule: bigint
  } | null
  /** Seconds a delay increase waits before it applies. */
  defaultAdminDelayIncreaseWait: number
}

/**
 * Reads a PCM's state.
 * @throws {@link CCTParamsInvalidError} if the target is invalid (before any RPC)
 * @throws {@link CCTContractTypeInvalidError} if the target is not a PCM, or `poolAddress` is not
 * a multi-token pool
 * @throws {@link CCTContractVersionUnsupportedError} if a version is unknown
 */
export class GetPoolConfigManagerState extends EVMQuery<
  PoolConfigManagerTarget,
  GetPoolConfigManagerStateResult
> {
  readonly name = 'getPoolConfigManagerState'

  protected prepare(params: PoolConfigManagerTarget): PoolConfigManagerTarget {
    validatePoolConfigManagerTarget(this.name, params)
    return params
  }

  protected async read(
    chain: EVMChain,
    target: PoolConfigManagerTarget,
  ): Promise<GetPoolConfigManagerStateResult> {
    const { address, version } = await resolvePoolConfigManagerTarget(chain, target)
    const pcm = poolConfigManagerContract(chain, address, version)
    const [[, , typeAndVersion], staticConfig, admin, pending, delay, pendingDelay, wait] =
      await Promise.all([
        chain.typeAndVersion(address),
        pcm.getStaticConfig(),
        pcm.defaultAdmin(),
        pcm.pendingDefaultAdmin(),
        pcm.defaultAdminDelay(),
        pcm.pendingDefaultAdminDelay(),
        pcm.defaultAdminDelayIncreaseWait(),
      ])
    // positional: `getStaticConfig` and the two pending getters return several outputs each
    const [tokenAdminRegistry, connectionStore, feeStore, securityStore] = staticConfig.map((a) =>
      getAddress(resultToObject(a)),
    )
    const [newAdmin, adminSchedule] = pending
    const [newDelay, delaySchedule] = pendingDelay
    return {
      poolConfigManager: getAddress(address),
      version,
      typeAndVersion,
      tokenAdminRegistry: tokenAdminRegistry!,
      connectionPolicyStore: connectionStore!,
      feePolicyStore: feeStore!,
      securityPolicyStore: securityStore!,
      defaultAdmin: getAddress(resultToObject(admin)),
      // OpenZeppelin AccessControlDefaultAdminRules: schedule 0 means nothing is pending
      pendingDefaultAdmin: BigInt(adminSchedule)
        ? { newAdmin: getAddress(resultToObject(newAdmin)), schedule: BigInt(adminSchedule) }
        : null,
      defaultAdminDelay: Number(delay),
      pendingDefaultAdminDelay: BigInt(delaySchedule)
        ? { newDelay: Number(newDelay), schedule: BigInt(delaySchedule) }
        : null,
      defaultAdminDelayIncreaseWait: Number(wait),
    }
  }
}
