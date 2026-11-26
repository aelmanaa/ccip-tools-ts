/**
 * getMultiTokenPoolProvider — a remote token address provider or additional pool data provider:
 * its type and, for a token, its answer.
 *
 * @packageDocumentation
 */

import { getAddress, hexlify } from 'ethers'

import type { EVMChain } from '../../../../evm/index.ts'
import { resultToObject } from '../../../../evm/types.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { decodeRemoteAddress } from '../../../remote-address.ts'
import {
  type MultiTokenPoolProviderType,
  ANY_FINALITY_CONFIG,
  MULTI_TOKEN_POOL_PROVIDER_TYPES,
  MultiTokenPoolVersion,
  assertMultiTokenPoolAuxContract,
  getMultiTokenPoolInterface,
  sameAddressProviderContract,
  uidProviderContract,
} from '../../multi-token-pool/contracts.ts'
import { EVMQuery, isRevertWith } from '../../query.ts'
import { validateAddress, validateNonZeroAddress, validateUint64 } from '../../validate.ts'

/** Parameters for `getMultiTokenPoolProvider`. */
export type GetMultiTokenPoolProviderParams = {
  /** The provider contract. */
  provider: string
  /** A token to ask the provider about. */
  tokenAddress?: string
  /** The remote chain to ask about; required with `tokenAddress` for a SameAddress provider. */
  remoteChainSelector?: bigint
}
/**
 * Result of `getMultiTokenPoolProvider`. For a UID provider with `tokenAddress`, `additionalPoolData`
 * is the token's `abi.encode(uid)`, or `null` when the factory does not map the token (sends would
 * revert `TokenNotFromFactory`). For a SameAddress provider, `remoteToken` is its answer.
 */
export type GetMultiTokenPoolProviderResult = {
  /** Provider type. */
  type: MultiTokenPoolProviderType
  /** UID provider: the token factory it resolves UIDs from. */
  tokenFactory?: string
  /** UID provider with `tokenAddress`: the pool data it adds, or `null` when the token is not from the factory. */
  additionalPoolData?: string | null
  /** SameAddress provider with `tokenAddress` and `remoteChainSelector`: the remote token it answers. */
  remoteToken?: string
}

const UID_PROVIDER_INTERFACE = getMultiTokenPoolInterface(
  'FactoryTokenWithUIDPoolDataProvider',
  MultiTokenPoolVersion.V2_1_0_DEV,
)

/**
 * Reads a provider.
 * @remarks The UID read is the pre-flight token profile updates run, and the value a Solana lane's
 * pool data must equal. Gated on type only.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC)
 * @throws {@link CCTContractTypeInvalidError} if the address is not a provider
 */
export class GetMultiTokenPoolProvider extends EVMQuery<
  GetMultiTokenPoolProviderParams,
  GetMultiTokenPoolProviderResult
> {
  readonly name = 'getMultiTokenPoolProvider'

  protected prepare(params: GetMultiTokenPoolProviderParams): GetMultiTokenPoolProviderParams {
    validateNonZeroAddress(this.name, 'provider', params.provider)
    if (params.tokenAddress !== undefined)
      validateAddress(this.name, 'tokenAddress', params.tokenAddress)
    if (params.remoteChainSelector !== undefined)
      validateUint64(this.name, 'remoteChainSelector', params.remoteChainSelector)
    return params
  }

  protected async read(
    chain: EVMChain,
    { provider, tokenAddress, remoteChainSelector }: GetMultiTokenPoolProviderParams,
  ): Promise<GetMultiTokenPoolProviderResult> {
    const type = await assertMultiTokenPoolAuxContract(
      chain,
      provider,
      MULTI_TOKEN_POOL_PROVIDER_TYPES,
    )
    if (type === 'SameAddressRemoteTokenAddressProvider') {
      if (tokenAddress === undefined) return { type }
      if (remoteChainSelector === undefined)
        throw new CCTParamsInvalidError(
          this.name,
          'remoteChainSelector',
          'a SameAddress provider answers per remote chain; pass the chain to ask about',
        )
      const c = sameAddressProviderContract(chain, provider)
      const answer = await c.getRemoteTokenAddress(getAddress(tokenAddress), remoteChainSelector)
      return { type, remoteToken: decodeRemoteAddress(answer, remoteChainSelector) }
    }
    const c = uidProviderContract(chain, provider)
    const tokenFactory = getAddress(resultToObject(await c.getTokenFactory()))
    if (tokenAddress === undefined) return { type, tokenFactory }
    let additionalPoolData: string | null
    try {
      additionalPoolData = hexlify(
        await c.getAdditionalPoolData(
          getAddress(tokenAddress),
          remoteChainSelector ?? 0n,
          ANY_FINALITY_CONFIG,
          '0x',
        ),
      )
    } catch (err) {
      // only `TokenNotFromFactory` means "no UID": other reverts and transport errors propagate
      if (!isRevertWith(err, UID_PROVIDER_INTERFACE, 'TokenNotFromFactory')) throw err
      additionalPoolData = null
    }
    return { type, tokenFactory, additionalPoolData }
  }
}
