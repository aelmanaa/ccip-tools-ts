import type { PublicKey } from '@solana/web3.js'

import type { TokenPoolRemote } from '../../../../chain.ts'
import { networkInfo } from '../../../../networks.ts'
import type { SolanaChain } from '../../../../solana/index.ts'
import {
  decodeTokenPoolChainConfig,
  deriveTokenPoolChainConfigV2Pda,
} from '../../../../solana/token-pool.ts'
import {
  decodePoolGroupChainConfigV2,
  decodePoolGroupLaneMarker,
} from '../../pool-group/accounts.ts'
import {
  type PoolProgramRef,
  deriveTokenPoolChainConfigPda,
  deriveTokenPoolConfigPda,
} from '../../programs/token-pool.ts'
import { SolanaQuery } from '../../query.ts'
import {
  U64_MAX,
  parseOptionalPublicKey,
  parsePublicKey,
  resolveExistingPoolProgram,
  validateBigInt,
} from '../../validate.ts'

/** Parameters for reading Solana token pool remote-chain configurations. */
export type GetTokenPoolRemotesParams = PoolProgramRef & {
  /** Token mint address managed by the local pool. */
  tokenAddress: string
  /** Optional CCIP selector of the destination chain to read (`u64`). */
  remoteChainSelector?: bigint
}

/** Remote-chain configurations keyed by network name. */
export type GetTokenPoolRemotesResult = Record<
  string,
  TokenPoolRemote & {
    /**
     * On a pool-groups program: a lane whose `ChainConfig` carries a marker is `'linked'` or
     * `'driven'`, with the group its tail names (`null` for a lane with only its own pool-data
     * settings). Absent on a standard lane, and on pools of other programs.
     */
    poolGroup?: {
      /** The lane kind its marker declares. */
      kind: 'linked' | 'driven'
      /** The group the tail names. */
      poolGroupAddress: string | null
    }
  }
>

/** {@link GetTokenPoolRemotesParams} with its mint and optional pool program parsed to public keys. */
type ParsedGetTokenPoolRemotesParams = {
  mint: PublicKey
  poolProgramAddress?: PublicKey
  remoteChainSelector?: bigint
}

/** Reads all, or one selected, remote-chain configurations of a Solana token pool. */
export class GetTokenPoolRemotes extends SolanaQuery<
  GetTokenPoolRemotesParams,
  GetTokenPoolRemotesResult,
  ParsedGetTokenPoolRemotesParams
> {
  readonly name = 'getTokenPoolRemotes'

  /**
   * Converts the mint and pool program, and validates the optional remote-chain selector.
   * @throws {@link CCTParamsInvalidError} if a pool parameter or selector is invalid.
   */
  protected prepare(params: GetTokenPoolRemotesParams): ParsedGetTokenPoolRemotesParams {
    if (params.remoteChainSelector !== undefined) {
      validateBigInt(this.name, 'remoteChainSelector', params.remoteChainSelector, 0n, U64_MAX)
    }
    return {
      mint: parsePublicKey(this.name, 'tokenAddress', params.tokenAddress),
      poolProgramAddress: parseOptionalPublicKey(
        this.name,
        'poolProgramAddress',
        params.poolProgramAddress,
      ),
      remoteChainSelector: params.remoteChainSelector,
    }
  }

  /** Derives the pool state PDA and delegates remote config decoding to the shared chain reader. */
  protected async read(
    chain: SolanaChain,
    { mint, poolProgramAddress, remoteChainSelector }: ParsedGetTokenPoolRemotesParams,
  ): Promise<GetTokenPoolRemotesResult> {
    const poolProgram = await resolveExistingPoolProgram(this.name, chain, mint, poolProgramAddress)
    const state = deriveTokenPoolConfigPda(poolProgram, mint).toBase58()
    const remotes: GetTokenPoolRemotesResult = await chain.getTokenPoolRemotes(
      state,
      remoteChainSelector,
    )
    // pool-group lanes: the marker after the standard `ChainConfig`, and the tail's group
    const names = Object.keys(remotes)
    const selectors = names.map((name) => networkInfo(name).chainSelector)
    const accounts = await chain.connection.getMultipleAccountsInfo(
      selectors.flatMap((selector) => [
        deriveTokenPoolChainConfigPda(poolProgram, selector, mint),
        deriveTokenPoolChainConfigV2Pda(poolProgram, selector, mint),
      ]),
    )
    for (const [i, name] of names.entries()) {
      const [cc, v2] = [accounts[2 * i], accounts[2 * i + 1]]
      if (!cc?.owner.equals(poolProgram)) continue
      try {
        const kind = decodePoolGroupLaneMarker(cc.data, decodeTokenPoolChainConfig(cc.data))
        if (kind === 'standard') continue
        const ext = v2 && decodePoolGroupChainConfigV2(v2.data, name).ext
        remotes[name] = {
          ...remotes[name]!,
          poolGroup: { kind, poolGroupAddress: ext?.poolGroupAddress ?? null },
        }
      } catch {
        // as the shared reader: a lane whose accounts do not decode keeps its base config only
      }
    }
    return remotes
  }
}
