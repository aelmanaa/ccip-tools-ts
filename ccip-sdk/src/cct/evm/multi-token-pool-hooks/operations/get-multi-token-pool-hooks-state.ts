/**
 * getMultiTokenPoolHooksState — a multi-token pool hook contract: allowlist, policy engine,
 * blocklist, authorized callers, owner and pending owner.
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

import type { EVMChain } from '../../../../evm/index.ts'
import { resultToObject } from '../../../../evm/types.ts'
import { readAllAuthorizedCallers } from '../../advanced-pool-hooks/contracts.ts'
import {
  type MultiTokenPoolHooksType,
  type PendingOwner,
  MULTI_TOKEN_POOL_HOOKS_TYPES,
  assertMultiTokenPoolAuxContract,
  multiTokenPoolHooksContract,
  nullableAddress,
  readOwnership,
} from '../../multi-token-pool/contracts.ts'
import { EVMQuery } from '../../query.ts'
import { validateNonZeroAddress } from '../../validate.ts'

/** Parameters for `getMultiTokenPoolHooksState`. */
export type GetMultiTokenPoolHooksStateParams = {
  /** A `MultiTokenPoolHooks` or `MultiTokenPoolHooksExternalBlocklist`. */
  hooks: string
}
/** Result of `getMultiTokenPoolHooksState`. */
export type GetMultiTokenPoolHooksStateResult = PendingOwner & {
  /** Hook contract type. */
  type: MultiTokenPoolHooksType
  /** Owner (allowlist, engine, blocklist, callers, ownership). */
  owner: string
  /** Whether senders are checked against the allowlist. */
  allowlistEnabled: boolean
  /** Allowed senders (kept while disabled). */
  allowlist: string[]
  /** Policy engine called on every transfer, or `null`. */
  policyEngine: string | null
  /** External blocklist (`MultiTokenPoolHooksExternalBlocklist` only), or `null` when off. */
  blocklist?: string | null
  /** Pools allowed to call the hooks; a serving pool missing here makes its transfers revert. */
  authorizedCallers: string[]
}

/**
 * Reads a hook contract's state.
 * @remarks Gated on type only, so a later version keeps reading. `authorizedCallers` comes from the
 * shared `AuthorizedCallers.getAllAuthorizedCallers()`, read through the advanced pool hooks helper.
 * @throws {@link CCTParamsInvalidError} if `hooks` is invalid (before any RPC)
 * @throws {@link CCTContractTypeInvalidError} if the address is not a hook contract
 * @throws {@link CCTDataDecodeError} if its storage is not the `Ownable2Step` layout
 */
export class GetMultiTokenPoolHooksState extends EVMQuery<
  GetMultiTokenPoolHooksStateParams,
  GetMultiTokenPoolHooksStateResult
> {
  readonly name = 'getMultiTokenPoolHooksState'

  protected prepare(params: GetMultiTokenPoolHooksStateParams): GetMultiTokenPoolHooksStateParams {
    validateNonZeroAddress(this.name, 'hooks', params.hooks)
    return params
  }

  protected async read(
    chain: EVMChain,
    { hooks }: GetMultiTokenPoolHooksStateParams,
  ): Promise<GetMultiTokenPoolHooksStateResult> {
    const type = await assertMultiTokenPoolAuxContract(chain, hooks, MULTI_TOKEN_POOL_HOOKS_TYPES)
    const contract = multiTokenPoolHooksContract(chain, hooks)
    // every read pinned to one block, so the owner and its pending transfer agree
    const blockTag = await chain.provider.getBlockNumber()
    const [ownership, allowlistEnabled, allowlist, policyEngine, authorizedCallers, blocklist] =
      await Promise.all([
        readOwnership(chain, hooks, blockTag),
        contract.getAllowListEnabled({ blockTag }),
        contract
          .getAllowList({ blockTag })
          .then((l) => l.map((a) => getAddress(resultToObject(a)))),
        contract.getPolicyEngine({ blockTag }).then((e) => nullableAddress(resultToObject(e))),
        readAllAuthorizedCallers(chain, hooks),
        type === 'MultiTokenPoolHooksExternalBlocklist'
          ? contract.getBlocklist({ blockTag }).then((b) => nullableAddress(resultToObject(b)))
          : undefined,
      ])
    return {
      type,
      ...ownership,
      allowlistEnabled,
      allowlist,
      policyEngine,
      ...(type === 'MultiTokenPoolHooksExternalBlocklist' && { blocklist }),
      authorizedCallers,
    }
  }
}
