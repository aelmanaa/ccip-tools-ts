/**
 * deployPolicyStore — deploys one of the three policy stores of a multi-token pool stack (A15: one
 * op, `type` selects the store). Deploys `2.1.0-dev` bytecode, pinned to chainlink-ccip `c950d9bc` until contracts-ccip ships multi-token pools.
 *
 * @remarks An authorized caller writes the store with no PCM role (F5): the initial
 * `authorizedCallers` are the PoolConfigManager(s) over this store, typically added once the PCM
 * is deployed (`updatePolicyStoreAuthorizedCallers`), since the PCM takes the stores' addresses.
 *
 * @packageDocumentation
 */

import { type Interface, getAddress } from 'ethers'

import { CCTParamsInvalidError } from '../../../errors.ts'
import { validateCallers } from '../../advanced-pool-hooks/contracts.ts'
import { type PolicyStoreType, POLICY_STORE_TYPES } from '../../multi-token-pool/contracts.ts'
import { getMultiTokenPoolArtifact } from '../../multi-token-pool/deploy-artifacts.ts'
import { MultiTokenPoolDeployOperation } from '../../multi-token-pool/deploy-operation.ts'
import type { DeployArtifact } from '../../operation.ts'

/** Parameters for `deployPolicyStore`. */
export type DeployPolicyStoreParams = {
  /** Which store: `ConnectionPolicyStore`, `FeePolicyStore` or `SecurityPolicyStore`. */
  type: PolicyStoreType
  /** Callers that may write the store (its PoolConfigManager); distinct, non-zero. Defaults to none. */
  authorizedCallers?: string[]
  /** The deployer (it becomes the store owner); optional when generating an unsigned transaction. */
  sender?: string
}

/** Deploys a policy store; `execute` resolves to `{ hash, contractAddress, verification }`. */
export class DeployPolicyStore extends MultiTokenPoolDeployOperation<DeployPolicyStoreParams> {
  readonly name = 'deployPolicyStore'

  /** Validates the type and the callers before building init-code. */
  protected override prepare(params: DeployPolicyStoreParams): DeployPolicyStoreParams {
    if (!(POLICY_STORE_TYPES as readonly string[]).includes(params.type))
      throw new CCTParamsInvalidError(
        this.name,
        'type',
        `must be one of ${POLICY_STORE_TYPES.join(', ')}`,
      )
    return {
      ...params,
      authorizedCallers: validateCallers(
        this.name,
        'authorizedCallers',
        params.authorizedCallers ?? [],
      ),
    }
  }

  protected artifact(p: DeployPolicyStoreParams): DeployArtifact {
    return getMultiTokenPoolArtifact(p.type)
  }

  /** `constructor(address[] authorizedCallers)`. */
  protected encode(iface: Interface, p: DeployPolicyStoreParams): string {
    return iface.encodeDeploy([(p.authorizedCallers ?? []).map((c) => getAddress(c))])
  }
}
