/**
 * getMultiTokenPoolTransferQuote — a transfer quote from the pool's own `getFee`, with the
 * basis-point token fee the Router's quote leaves out.
 *
 * @packageDocumentation
 */

import { toBeHex } from 'ethers'

import type { EVMChain } from '../../../../evm/index.ts'
import { encodeFinality } from '../../../../extra-args.ts'
import type {
  GetMultiTokenPoolTransferQuoteParams,
  MultiTokenPoolTransferQuote,
} from '../../../multi-token-pool.ts'
import {
  resolveLanePool,
  validateLaneParams,
} from '../../pool-config-manager/operations/get-multi-token-pool-lane.ts'
import { EVMQuery } from '../../query.ts'
import { validateAddress, validateFinalityRequested, validateUint256 } from '../../validate.ts'
import { readMultiTokenPoolFee, resolveMultiTokenPoolFor } from '../pool-reads.ts'

/** The store's divisor for basis-point fees. */
const BPS_DIVIDER = 10_000n

/**
 * Quotes a multi-token pool transfer.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), the lane has no fee
 *   record (a send would revert), or the token does not allow the requested finality
 * @throws {@link CCTContractTypeInvalidError} if the pool is not a multi-token pool
 */
export class GetMultiTokenPoolTransferQuote extends EVMQuery<
  GetMultiTokenPoolTransferQuoteParams,
  MultiTokenPoolTransferQuote
> {
  readonly name = 'getMultiTokenPoolTransferQuote'

  protected prepare(
    params: GetMultiTokenPoolTransferQuoteParams,
  ): GetMultiTokenPoolTransferQuoteParams {
    validateLaneParams(this.name, params)
    validateUint256(this.name, 'amount', params.amount)
    if (params.finality !== undefined)
      validateFinalityRequested(this.name, 'finality', params.finality)
    if (params.feeToken !== undefined) validateAddress(this.name, 'feeToken', params.feeToken)
    return params
  }

  protected async read(
    chain: EVMChain,
    params: GetMultiTokenPoolTransferQuoteParams,
  ): Promise<MultiTokenPoolTransferQuote> {
    const poolAddress = await resolveLanePool(this.name, chain, params)
    const pool = await resolveMultiTokenPoolFor(chain, poolAddress, params.tokenAddress)
    // the pool picks the tier as the store does: any finality but "wait for finality" is fast
    const fee = await readMultiTokenPoolFee(this.name, chain, {
      poolAddress,
      ...pool,
      remoteChainSelector: params.remoteChainSelector,
      finality: toBeHex(encodeFinality(params.finality ?? 'finalized'), 4),
      amount: params.amount,
      ...(params.feeToken && { feeToken: params.feeToken }),
    })
    // the store rounds the token fee down
    const feeDeducted = (params.amount * BigInt(fee.tokenFeeBps)) / BPS_DIVIDER
    return {
      feeUSDCents: fee.feeUSDCents,
      destGasOverhead: fee.destGasOverhead,
      destBytesOverhead: fee.destBytesOverhead,
      tokenFeeBps: fee.tokenFeeBps,
      feeDeducted,
      netAmount: params.amount - feeDeducted,
      hasFeeRecord: fee.isEnabled,
    }
  }
}
