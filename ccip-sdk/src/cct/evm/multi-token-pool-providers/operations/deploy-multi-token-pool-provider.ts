/**
 * deployMultiTokenPoolProvider — deploys a remote token address or pool data provider: one op for
 * both, `type` selects it, as `deployTokenPool` does. Deploys `2.1.0-dev` bytecode, pinned to chainlink-ccip `c950d9bc` until contracts-ccip ships multi-token pools.
 *
 * @packageDocumentation
 */

import { type Interface, getAddress } from 'ethers'

import { CCTParamsInvalidError } from '../../../errors.ts'
import { SAME_ADDRESS_PROVIDER_TYPE, UID_PROVIDER_TYPE } from '../../multi-token-pool/contracts.ts'
import { getMultiTokenPoolArtifact } from '../../multi-token-pool/deploy-artifacts.ts'
import { MultiTokenPoolDeployOperation } from '../../multi-token-pool/deploy-operation.ts'
import type { DeployArtifact } from '../../operation.ts'
import { validateNonZeroAddress } from '../../validate.ts'

/** Parameters for `deployMultiTokenPoolProvider`. */
export type DeployMultiTokenPoolProviderParams =
  | {
      /** Answers each local token's own address as its remote token, on every chain (EVM remotes only). */
      type: 'SameAddressRemoteTokenAddressProvider'
      /** The deployer; optional when generating an unsigned transaction. */
      sender?: string
    }
  | {
      /** Supplies the factory UID of factory-native tokens as additional pool data. */
      type: 'FactoryTokenWithUIDPoolDataProvider'
      /** The token factory whose tokens it serves. */
      tokenFactory: string
      /** The deployer; optional when generating an unsigned transaction. */
      sender?: string
    }

/** Deploys a provider; `execute` resolves to `{ hash, contractAddress, verification }`. */
export class DeployMultiTokenPoolProvider extends MultiTokenPoolDeployOperation<DeployMultiTokenPoolProviderParams> {
  readonly name = 'deployMultiTokenPoolProvider'

  protected override prepare(
    params: DeployMultiTokenPoolProviderParams,
  ): DeployMultiTokenPoolProviderParams {
    if (params.type === UID_PROVIDER_TYPE)
      validateNonZeroAddress(this.name, 'tokenFactory', params.tokenFactory)
    else if ((params.type as string) !== SAME_ADDRESS_PROVIDER_TYPE)
      throw new CCTParamsInvalidError(
        this.name,
        'type',
        `must be ${SAME_ADDRESS_PROVIDER_TYPE} or ${UID_PROVIDER_TYPE}`,
      )
    return params
  }

  protected artifact(p: DeployMultiTokenPoolProviderParams): DeployArtifact {
    return getMultiTokenPoolArtifact(p.type)
  }

  /** SameAddress: `constructor()`; UID: `constructor(address tokenFactory)`. */
  protected encode(iface: Interface, p: DeployMultiTokenPoolProviderParams): string {
    return p.type === UID_PROVIDER_TYPE
      ? iface.encodeDeploy([getAddress(p.tokenFactory)])
      : iface.encodeDeploy([])
  }
}
