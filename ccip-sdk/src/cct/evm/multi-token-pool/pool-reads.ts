/**
 * The token-keyed pool views of a multi-token pool (`getFee`, `getTokenTransferFeeConfig`,
 * `isSupportedToken`), shared by the extended single-pool reads and the transfer quote.
 *
 * @packageDocumentation
 */

import { ZeroAddress, getAddress } from 'ethers'

import type { TokenTransferFeeConfig } from '../../../chain.ts'
import { CCIPLocalTokenRequiredError } from '../../../errors/index.ts'
import type { EVMChain } from '../../../evm/index.ts'
import { CCTContractTypeInvalidError, CCTParamsInvalidError } from '../../errors.ts'
import { isRevertWith } from '../query.ts'
import {
  type TokenPoolFee,
  toTokenPoolFee,
  toTokenTransferFeeConfig,
} from '../token-pool/contracts.ts'
import {
  type MultiTokenPoolVersion,
  getMultiTokenPoolInterface,
  multiTokenPoolContract,
  reportsMultiTokenPool,
  resolveMultiTokenPool,
} from './contracts.ts'

/**
 * Whether an error is `resolveTokenPool` refusing a multi-token pool: the single-token reads branch
 * on it, so every other pool keeps its unchanged path.
 * @internal
 */
export function isMultiTokenPoolRefusal(err: unknown): err is CCTContractTypeInvalidError {
  return (
    err instanceof CCTContractTypeInvalidError && reportsMultiTokenPool(String(err.context.actual))
  )
}

/**
 * The multi-token pool and its version, requiring the local token those pools key every lane by.
 * @throws {@link CCIPLocalTokenRequiredError} if `tokenAddress` is omitted
 * @internal
 */
export async function resolveMultiTokenPoolFor(
  chain: EVMChain,
  poolAddress: string,
  tokenAddress: string | undefined,
): Promise<{ version: MultiTokenPoolVersion; tokenAddress: string }> {
  const { version } = await resolveMultiTokenPool(chain, poolAddress)
  if (tokenAddress === undefined)
    throw new CCIPLocalTokenRequiredError(poolAddress, (await chain.typeAndVersion(poolAddress))[2])
  return { version, tokenAddress: getAddress(tokenAddress) }
}

/**
 * A multi-token pool's `getFee` for one token and tier.
 * @throws {@link CCTParamsInvalidError} if the lane has no fee record (`LaneFeeNotFound`: a send would
 *   revert), or the token does not allow the requested finality
 * @internal
 */
export async function readMultiTokenPoolFee(
  operation: string,
  chain: EVMChain,
  {
    poolAddress,
    version,
    tokenAddress,
    remoteChainSelector,
    finality,
    amount = 0n,
    feeToken,
  }: {
    poolAddress: string
    version: MultiTokenPoolVersion
    tokenAddress: string
    remoteChainSelector: bigint
    finality: string
    amount?: bigint
    feeToken?: string
  },
): Promise<TokenPoolFee> {
  const pool = multiTokenPoolContract(chain, poolAddress, version)
  const iface = getMultiTokenPoolInterface('BurnMintMultiTokenPool', version)
  const store = getMultiTokenPoolInterface('ConnectionPolicyStore', version)
  try {
    const fee = await pool.getFee(
      tokenAddress,
      remoteChainSelector,
      amount,
      feeToken ?? ZeroAddress,
      finality,
      '0x',
    )
    return toTokenPoolFee({
      feeUSDCents: fee[0] as bigint,
      destGasOverhead: fee[1],
      destBytesOverhead: fee[2],
      tokenFeeBps: fee[3],
      isEnabled: fee[4] as boolean,
    })
  } catch (err) {
    if (isRevertWith(err, iface, 'LaneFeeNotFound'))
      throw new CCTParamsInvalidError(
        operation,
        'remoteChainSelector',
        `the lane of ${tokenAddress} to ${remoteChainSelector} has no fee record: a send would revert`,
      )
    if (isRevertWith(err, store, 'InvalidRequestedFinality'))
      throw new CCTParamsInvalidError(
        operation,
        'finality',
        `${tokenAddress} does not allow this finality`,
      )
    throw err
  }
}

/** A multi-token pool's `getTokenTransferFeeConfig` for one token (both tiers). @internal */
export async function readMultiTokenPoolTokenTransferFeeConfig(
  chain: EVMChain,
  poolAddress: string,
  version: MultiTokenPoolVersion,
  tokenAddress: string,
  remoteChainSelector: bigint,
  finality: string,
): Promise<TokenTransferFeeConfig> {
  const pool = multiTokenPoolContract(chain, poolAddress, version)
  return toTokenTransferFeeConfig(
    await pool.getTokenTransferFeeConfig(tokenAddress, remoteChainSelector, finality, '0x'),
  )
}

/** A multi-token pool's `isSupportedToken`: registered, and its flavor served. @internal */
export async function readMultiTokenPoolIsSupportedToken(
  chain: EVMChain,
  poolAddress: string,
  version: MultiTokenPoolVersion,
  tokenAddress: string,
): Promise<boolean> {
  return multiTokenPoolContract(chain, poolAddress, version).isSupportedToken(tokenAddress)
}
