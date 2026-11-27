/**
 * deployPoolConfigManager — deploys the PoolConfigManager of a multi-token pool stack over its three
 * stores. Deploys `2.1.0-dev` bytecode, pinned to chainlink-ccip `c950d9bc` until contracts-ccip ships multi-token pools.
 *
 * @remarks The registry and the three stores are immutables: each store's `typeAndVersion` is
 * checked against its slot before the build (a store in the wrong slot could never be corrected).
 * `router`, when given, must resolve to `tokenAdminRegistry`. `admin` (the
 * `DEFAULT_ADMIN_ROLE`) defaults to `sender`. The stores must then authorize the PCM
 * (`updatePolicyStoreAuthorizedCallers`).
 *
 * @packageDocumentation
 */

import { type Interface, getAddress } from 'ethers'

import type { EVMChain } from '../../../../evm/index.ts'
import type { UnsignedEVMTx } from '../../../../evm/types.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import {
  type PolicyStoreType,
  resolveMultiTokenPoolContract,
} from '../../multi-token-pool/contracts.ts'
import { getMultiTokenPoolArtifact } from '../../multi-token-pool/deploy-artifacts.ts'
import { MultiTokenPoolDeployOperation } from '../../multi-token-pool/deploy-operation.ts'
import type { DeployArtifact } from '../../operation.ts'
import { validateAddress, validateNonZeroAddress } from '../../validate.ts'

/** Parameters for `deployPoolConfigManager`. */
export type DeployPoolConfigManagerParams = {
  /** The TokenAdminRegistry the ramps use (immutable). */
  tokenAdminRegistry: string
  /** The ConnectionPolicyStore (immutable). */
  connectionPolicyStore: string
  /** The FeePolicyStore (immutable). */
  feePolicyStore: string
  /** The SecurityPolicyStore (immutable). */
  securityPolicyStore: string
  /** The `DEFAULT_ADMIN_ROLE` holder; defaults to `sender`. */
  admin?: string
  /** A Router to cross-check `tokenAdminRegistry` against, when given. */
  router?: string
  /** The deployer; required when `admin` is omitted. */
  sender?: string
}

/** Each store param and the type its slot takes. */
const STORE_SLOTS = [
  ['connectionPolicyStore', 'ConnectionPolicyStore'],
  ['feePolicyStore', 'FeePolicyStore'],
  ['securityPolicyStore', 'SecurityPolicyStore'],
] as const satisfies readonly (readonly [keyof DeployPoolConfigManagerParams, PolicyStoreType])[]

/** Deploys a PoolConfigManager; `execute` resolves to `{ hash, contractAddress, verification }`. */
export class DeployPoolConfigManager extends MultiTokenPoolDeployOperation<DeployPoolConfigManagerParams> {
  readonly name = 'deployPoolConfigManager'

  /** Validates every address, and that an admin is known, before any RPC. */
  protected override prepare(params: DeployPoolConfigManagerParams): DeployPoolConfigManagerParams {
    validateNonZeroAddress(this.name, 'tokenAdminRegistry', params.tokenAdminRegistry)
    for (const [param] of STORE_SLOTS) validateNonZeroAddress(this.name, param, params[param])
    if (params.router !== undefined) validateNonZeroAddress(this.name, 'router', params.router)
    if (params.admin !== undefined) validateNonZeroAddress(this.name, 'admin', params.admin)
    else if (params.sender === undefined)
      throw new CCTParamsInvalidError(
        this.name,
        'admin',
        'is required when sender is omitted (it defaults to sender)',
      )
    else validateAddress(this.name, 'sender', params.sender)
    return params
  }

  /**
   * Builds (after validating every param), then checks each store's type against its slot and the
   * Router's registry.
   */
  override async generate(
    chain: EVMChain,
    params: DeployPoolConfigManagerParams,
  ): Promise<UnsignedEVMTx> {
    const unsigned = await super.generate(chain, params)
    await Promise.all(
      STORE_SLOTS.map(async ([param, type]) => {
        try {
          await resolveMultiTokenPoolContract(chain, params[param]!, [type])
        } catch (cause) {
          throw new CCTParamsInvalidError(this.name, param, `${params[param]} is not a ${type}`, {
            cause: cause instanceof Error ? cause : undefined,
          })
        }
      }),
    )
    if (params.router !== undefined) {
      const registry = getAddress(await chain.getTokenAdminRegistryFor(params.router))
      if (registry !== getAddress(params.tokenAdminRegistry))
        throw new CCTParamsInvalidError(
          this.name,
          'tokenAdminRegistry',
          `is not the registry ${params.router} uses (${registry}): the ramps would never find this stack's pools`,
        )
    }
    return unsigned
  }

  protected artifact(): DeployArtifact {
    return getMultiTokenPoolArtifact('PoolConfigManager')
  }

  /** `constructor(tokenAdminRegistry, connectionStore, feeStore, securityStore, admin)`. */
  protected encode(iface: Interface, p: DeployPoolConfigManagerParams): string {
    return iface.encodeDeploy([
      getAddress(p.tokenAdminRegistry),
      getAddress(p.connectionPolicyStore),
      getAddress(p.feePolicyStore),
      getAddress(p.securityPolicyStore),
      getAddress((p.admin ?? p.sender)!),
    ])
  }
}
