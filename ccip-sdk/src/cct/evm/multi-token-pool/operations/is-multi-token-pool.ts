/**
 * isMultiTokenPool — ERC-165 `IMultiTokenPool` detection, with a `typeAndVersion` name fallback.
 *
 * @packageDocumentation
 */

import type { EVMChain } from '../../../../evm/index.ts'
import { isMultiTokenPoolType } from '../../../../evm/multi-token-pool.ts'
import { EVMQuery, isMissingFunction, isNotCcipContract } from '../../query.ts'
import { validateNonZeroAddress } from '../../validate.ts'
import { I_MULTI_TOKEN_POOL_INTERFACE_ID, multiTokenPoolProbe } from '../contracts.ts'

/** Parameters for reads of one multi-token pool. */
export type MultiTokenPoolReadParams = {
  /** The multi-token pool. */
  poolAddress: string
}

/**
 * Whether `poolAddress` is a multi-token pool.
 * @remarks ERC-165 `IMultiTokenPool` first, since it also matches future multi-token pool
 * variants; when the address does not answer ERC-165 (`CALL_EXCEPTION`/`BAD_DATA`), a
 * `typeAndVersion` ending in `MultiTokenPool` (so the hook contracts, which share the stem, are
 * not pools). A transport error propagates.
 * @throws {@link CCTParamsInvalidError} if `poolAddress` is invalid (before any RPC)
 */
export class IsMultiTokenPool extends EVMQuery<MultiTokenPoolReadParams, boolean> {
  readonly name = 'isMultiTokenPool'

  protected prepare(params: MultiTokenPoolReadParams): MultiTokenPoolReadParams {
    validateNonZeroAddress(this.name, 'poolAddress', params.poolAddress)
    return params
  }

  protected async read(chain: EVMChain, { poolAddress }: MultiTokenPoolReadParams) {
    const erc165 = multiTokenPoolProbe(chain, poolAddress)
    try {
      if (await erc165.supportsInterface(I_MULTI_TOKEN_POOL_INTERFACE_ID)) return true
    } catch (err) {
      if (!isMissingFunction(err)) throw err
    }
    try {
      const [type] = await chain.typeAndVersion(poolAddress)
      // a pool, not its hook contracts (`MultiTokenPoolHooks…`), which share the name stem
      return isMultiTokenPoolType(type) && /MultiTokenPool$/.test(type)
    } catch (err) {
      // no (parseable) typeAndVersion either: an EOA or a non-CCIP contract; transport errors propagate
      if (isNotCcipContract(err)) return false
      throw err
    }
  }
}
