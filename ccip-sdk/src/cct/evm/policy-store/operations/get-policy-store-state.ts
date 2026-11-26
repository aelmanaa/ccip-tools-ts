/**
 * getPolicyStoreState — type, version, owner, pending owner and authorized callers of a policy store.
 *
 * @packageDocumentation
 */

import type { EVMChain } from '../../../../evm/index.ts'
import { readAllAuthorizedCallers } from '../../advanced-pool-hooks/contracts.ts'
import {
  type MultiTokenPoolVersion,
  type PendingOwner,
  type PolicyStoreType,
  POLICY_STORE_TYPES,
  readOwnership,
  resolveMultiTokenPoolContract,
} from '../../multi-token-pool/contracts.ts'
import { EVMQuery } from '../../query.ts'
import { validateNonZeroAddress } from '../../validate.ts'

/** Parameters for `getPolicyStoreState`. */
export type GetPolicyStoreStateParams = {
  /** A ConnectionPolicyStore, FeePolicyStore or SecurityPolicyStore. */
  policyStore: string
}
/** Result of `getPolicyStoreState`. */
export type GetPolicyStoreStateResult = PendingOwner & {
  /** Store type. */
  type: PolicyStoreType
  /** Version, with its pre-release suffix. */
  version: MultiTokenPoolVersion
  /** Store owner (authorized callers and ownership). */
  owner: string
  /** Contracts allowed to write the store: the serving PoolConfigManager(s). */
  authorizedCallers: string[]
}

/**
 * Reads a policy store's state.
 * @remarks `authorizedCallers` comes from the shared `AuthorizedCallers.getAllAuthorizedCallers()`,
 * read through the same helper as the advanced pool hooks.
 * @throws {@link CCTParamsInvalidError} if `policyStore` is invalid (before any RPC)
 * @throws {@link CCTContractTypeInvalidError} if the address is not a policy store
 * @throws {@link CCTContractVersionUnsupportedError} if its version is unknown
 * @throws {@link CCTDataDecodeError} if its storage is not the `Ownable2Step` layout
 */
export class GetPolicyStoreState extends EVMQuery<
  GetPolicyStoreStateParams,
  GetPolicyStoreStateResult
> {
  readonly name = 'getPolicyStoreState'

  protected prepare(params: GetPolicyStoreStateParams): GetPolicyStoreStateParams {
    validateNonZeroAddress(this.name, 'policyStore', params.policyStore)
    return params
  }

  protected async read(
    chain: EVMChain,
    { policyStore }: GetPolicyStoreStateParams,
  ): Promise<GetPolicyStoreStateResult> {
    const { type, version } = await resolveMultiTokenPoolContract(
      chain,
      policyStore,
      POLICY_STORE_TYPES,
    )
    const [{ owner, pendingOwner }, authorizedCallers] = await Promise.all([
      readOwnership(chain, policyStore),
      readAllAuthorizedCallers(chain, policyStore),
    ])
    return {
      type,
      version,
      owner,
      pendingOwner,
      authorizedCallers,
    }
  }
}
