/**
 * deployMultiTokenPoolHooks — deploys a multi-token pool hook contract. Deploys `2.1.0-dev` bytecode, pinned to chainlink-ccip `c950d9bc` until contracts-ccip ships multi-token pools.
 *
 * @remarks An empty `allowlist` disables the allowlist for the contract's life (it is enabled at
 * construction only, by a non-empty list). A non-zero `policyEngine` is attached at construction
 * (its `attach()` runs) and must have code, as `setMultiTokenPoolHooksPolicyEngine` requires. A
 * `blocklist` is the external-blocklist variant's only (`ZeroAddress` turns it off; otherwise it
 * must have code). `authorizedCallers` are the pools that may call the hooks.
 *
 * @packageDocumentation
 */

import { type Interface, ZeroAddress, getAddress } from 'ethers'

import type { EVMChain } from '../../../../evm/index.ts'
import type { UnsignedEVMTx } from '../../../../evm/types.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import {
  assertDeployedContract,
  assertPolicyEngineContract,
  validateCallers,
} from '../../advanced-pool-hooks/contracts.ts'
import {
  type MultiTokenPoolHooksType,
  MULTI_TOKEN_POOL_HOOKS_TYPES,
} from '../../multi-token-pool/contracts.ts'
import { getMultiTokenPoolArtifact } from '../../multi-token-pool/deploy-artifacts.ts'
import { MultiTokenPoolDeployOperation } from '../../multi-token-pool/deploy-operation.ts'
import type { DeployArtifact } from '../../operation.ts'
import { validateAddress } from '../../validate.ts'

/** Parameters for `deployMultiTokenPoolHooks`. */
export type DeployMultiTokenPoolHooksParams = {
  /** The hooks type. */
  type: MultiTokenPoolHooksType
  /** Senders allowed to transfer; an empty list disables the allowlist for the contract's life. */
  allowlist: string[]
  /** A policy engine to attach (must have code), or omitted / `ZeroAddress` for none. */
  policyEngine?: string
  /** `MultiTokenPoolHooksExternalBlocklist` only: the blocklist contract, or `ZeroAddress` for none. */
  blocklist?: string
  /** The pools that may call the hooks. */
  authorizedCallers: string[]
  /** The deployer (it becomes the hooks owner); optional when generating an unsigned transaction. */
  sender?: string
}

/** Deploys a hook contract; `execute` resolves to `{ hash, contractAddress, verification }`. */
export class DeployMultiTokenPoolHooks extends MultiTokenPoolDeployOperation<DeployMultiTokenPoolHooksParams> {
  readonly name = 'deployMultiTokenPoolHooks'

  /** Validates the type and every list and address before any RPC. */
  protected override prepare(
    params: DeployMultiTokenPoolHooksParams,
  ): DeployMultiTokenPoolHooksParams {
    if (!(MULTI_TOKEN_POOL_HOOKS_TYPES as readonly string[]).includes(params.type))
      throw new CCTParamsInvalidError(
        this.name,
        'type',
        `must be one of ${MULTI_TOKEN_POOL_HOOKS_TYPES.join(', ')}`,
      )
    const allowlist = validateCallers(this.name, 'allowlist', params.allowlist)
    const authorizedCallers = validateCallers(
      this.name,
      'authorizedCallers',
      params.authorizedCallers,
    )
    if (params.policyEngine !== undefined)
      validateAddress(this.name, 'policyEngine', params.policyEngine)
    if (params.blocklist !== undefined) {
      if (params.type !== 'MultiTokenPoolHooksExternalBlocklist')
        throw new CCTParamsInvalidError(
          this.name,
          'blocklist',
          `applies to MultiTokenPoolHooksExternalBlocklist only, not ${params.type}`,
        )
      validateAddress(this.name, 'blocklist', params.blocklist)
    }
    return { ...params, allowlist, authorizedCallers }
  }

  /** Builds, then requires a non-zero policy engine and blocklist to have code (the constructor calls them). */
  override async generate(
    chain: EVMChain,
    params: DeployMultiTokenPoolHooksParams,
  ): Promise<UnsignedEVMTx> {
    const unsigned = await super.generate(chain, params)
    const engine = getAddress(params.policyEngine ?? ZeroAddress)
    if (engine !== ZeroAddress)
      await assertPolicyEngineContract(this.name, 'policyEngine', chain, engine)
    const blocklist = getAddress(params.blocklist ?? ZeroAddress)
    if (blocklist !== ZeroAddress)
      await assertDeployedContract(this.name, 'blocklist', chain, blocklist, 'blocklist')
    return unsigned
  }

  protected artifact(p: DeployMultiTokenPoolHooksParams): DeployArtifact {
    return getMultiTokenPoolArtifact(p.type)
  }

  /** Base: `(allowlist, policyEngine, authorizedCallers)`; external blocklist adds `blocklist`. */
  protected encode(iface: Interface, p: DeployMultiTokenPoolHooksParams): string {
    const engine = getAddress(p.policyEngine ?? ZeroAddress)
    return p.type === 'MultiTokenPoolHooksExternalBlocklist'
      ? iface.encodeDeploy([
          p.allowlist,
          engine,
          getAddress(p.blocklist ?? ZeroAddress),
          p.authorizedCallers,
        ])
      : iface.encodeDeploy([p.allowlist, engine, p.authorizedCallers])
  }
}
