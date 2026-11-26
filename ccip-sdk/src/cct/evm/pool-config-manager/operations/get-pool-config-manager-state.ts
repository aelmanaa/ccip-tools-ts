/**
 * getPoolConfigManagerState — a PCM's static config and default-admin state.
 *
 * @packageDocumentation
 */

import { ZeroAddress, getAddress } from 'ethers'

import type { EVMChain } from '../../../../evm/index.ts'
import { resultToObject } from '../../../../evm/types.ts'
import {
  type MultiTokenPoolVersion,
  poolConfigManagerContract,
} from '../../multi-token-pool/contracts.ts'
import { EVMQuery } from '../../query.ts'
import type { PendingTokenDefaultAdmin } from '../../token/operations/get-token-default-admin.ts'
import {
  type PoolConfigManagerTarget,
  readPoolConfigManagerStaticConfig,
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
  /**
   * A scheduled default-admin transfer, present only when one is pending (as
   * `getTokenDefaultAdmin`): test with `'pendingDefaultAdmin' in result`.
   */
  pendingDefaultAdmin?: PendingTokenDefaultAdmin
  /** Seconds a default-admin transfer waits; `0` makes PCM governance changes instant (F8). */
  defaultAdminDelay: number
  /** A scheduled delay change, present only when one is pending. */
  pendingDefaultAdminDelay?: {
    /** The new delay, in seconds. */
    newDelay: number
    /** Unix seconds from which it applies. */
    schedule: bigint
  }
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
        readPoolConfigManagerStaticConfig(chain, address, version),
        pcm.defaultAdmin(),
        pcm.pendingDefaultAdmin(),
        pcm.defaultAdminDelay(),
        pcm.pendingDefaultAdminDelay(),
        pcm.defaultAdminDelayIncreaseWait(),
      ])
    // positional: the two pending getters return two outputs each
    const [newAdmin, adminSchedule] = pending
    const [newDelay, delaySchedule] = pendingDelay
    return {
      poolConfigManager: getAddress(address),
      version,
      typeAndVersion,
      ...staticConfig,
      defaultAdmin: getAddress(resultToObject(admin)),
      // OpenZeppelin AccessControlDefaultAdminRules resets both fields together; the token read
      // (`getTokenDefaultAdmin`) tests `newAdmin`, so this does too
      ...(getAddress(resultToObject(newAdmin)) !== ZeroAddress && {
        pendingDefaultAdmin: {
          newAdmin: getAddress(resultToObject(newAdmin)),
          schedule: BigInt(adminSchedule),
        },
      }),
      defaultAdminDelay: Number(delay),
      ...(BigInt(delaySchedule) !== 0n && {
        pendingDefaultAdminDelay: { newDelay: Number(newDelay), schedule: BigInt(delaySchedule) },
      }),
      defaultAdminDelayIncreaseWait: Number(wait),
    }
  }
}
