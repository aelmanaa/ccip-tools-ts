/**
 * deployMultiTokenPool — deploys a multi-token pool on its PoolConfigManager. Deploys `2.1.0-dev` bytecode, pinned to chainlink-ccip `c950d9bc` until contracts-ccip ships multi-token pools.
 *
 * @remarks As main's `deployTokenPool`: `router` and `rmnProxy` are given (non-zero), with no
 * default read from the Router. The pool then serves no token until its PCM registers one and the
 * registry points the token at the pool (`setPool`).
 *
 * @packageDocumentation
 */

import { type Interface, getAddress } from 'ethers'

import { CCTParamsInvalidError } from '../../../errors.ts'
import type { DeployArtifact } from '../../operation.ts'
import { validateNonZeroAddress } from '../../validate.ts'
import { type MultiTokenPoolType, MULTI_TOKEN_POOL_TYPES } from '../contracts.ts'
import { getMultiTokenPoolArtifact } from '../deploy-artifacts.ts'
import { MultiTokenPoolDeployOperation } from '../deploy-operation.ts'

/** Parameters for `deployMultiTokenPool`. */
export type DeployMultiTokenPoolParams = {
  /** The pool type (`BurnMintMultiTokenPool`). */
  type: MultiTokenPoolType
  /** The Router the pool accepts ramps from. */
  router: string
  /** The RMN proxy the pool checks curses with. */
  rmnProxy: string
  /** The PoolConfigManager the pool calls. */
  poolConfigManager: string
  /** The deployer (it becomes the pool owner); optional when generating an unsigned transaction. */
  sender?: string
}

/** Deploys a multi-token pool; `execute` resolves to `{ hash, contractAddress, verification }`. */
export class DeployMultiTokenPool extends MultiTokenPoolDeployOperation<DeployMultiTokenPoolParams> {
  readonly name = 'deployMultiTokenPool'

  /** Validates the type and every address before building init-code, as main's `deployTokenPool`. */
  protected override prepare(params: DeployMultiTokenPoolParams): DeployMultiTokenPoolParams {
    if (!(MULTI_TOKEN_POOL_TYPES as readonly string[]).includes(params.type))
      throw new CCTParamsInvalidError(
        this.name,
        'type',
        `unsupported pool type ${String(params.type)}`,
      )
    validateNonZeroAddress(this.name, 'router', params.router)
    validateNonZeroAddress(this.name, 'rmnProxy', params.rmnProxy)
    validateNonZeroAddress(this.name, 'poolConfigManager', params.poolConfigManager)
    return params
  }

  protected artifact(p: DeployMultiTokenPoolParams): DeployArtifact {
    return getMultiTokenPoolArtifact(p.type)
  }

  /** `constructor(rmnProxy, router, poolConfigManager)`. */
  protected encode(iface: Interface, p: DeployMultiTokenPoolParams): string {
    return iface.encodeDeploy([
      getAddress(p.rmnProxy),
      getAddress(p.router),
      getAddress(p.poolConfigManager),
    ])
  }
}
