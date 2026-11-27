import type { Buffer } from 'buffer'

import { BorshAccountsCoder } from '@coral-xyz/anchor'
import type { AccountInfo, PublicKey } from '@solana/web3.js'

import type { TokenPoolRemote } from '../../../../chain.ts'
import { networkInfo } from '../../../../networks.ts'
import type { SolanaChain } from '../../../../solana/index.ts'
import { decodeTokenPoolChainConfig } from '../../../../solana/token-pool.ts'
import { CCTDataDecodeError } from '../../../errors.ts'
import { chainConfigStandardLen } from '../../pool-group/accounts.ts'
import { decodePoolGroupLaneBase, isUnread } from '../../pool-group/lane.ts'
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
    // core's read, with the lane accounts it fetched: the marker and tail need no second read
    const { remotes: base, laneAccounts } = await chain._getTokenPoolRemotesWithAccounts(
      state,
      remoteChainSelector,
    )
    const remotes: GetTokenPoolRemotesResult = base
    for (const [name, { chainConfig, chainConfigV2 }] of Object.entries(laneAccounts)) {
      if (!claimsPoolGroupLane(chainConfig, chainConfigV2)) continue
      // the S1a lane decoder: marker and tail must agree, else the lane is not as the program writes it
      const lane = decodePoolGroupLaneBase(
        poolProgram,
        mint,
        networkInfo(name).chainSelector,
        chainConfig,
        chainConfigV2 ?? null,
      )
      if (lane === null) continue
      if (isUnread(lane))
        throw new CCTDataDecodeError(
          deriveTokenPoolChainConfigPda(
            poolProgram,
            networkInfo(name).chainSelector,
            mint,
          ).toBase58(),
          {
            context: { reason: lane.reason },
          },
        )
      if (lane.kind === 'standard') continue
      remotes[name] = {
        ...remotes[name]!,
        poolGroup: { kind: lane.kind, poolGroupAddress: lane.ext?.poolGroupAddress ?? null },
      }
    }
    return remotes
  }
}

const CHAIN_CONFIG_V2_DISCRIMINATOR = BorshAccountsCoder.accountDiscriminator('ChainConfigV2')

/**
 * Whether a lane's accounts claim the pool-groups layout: a `ChainConfig` with the 8-byte marker
 * after its standard length, or a version-2 `ChainConfigV2` (the version a tail needs). A lane of
 * any other pool (standard, CCTP, Lombard) claims neither and keeps its base config as core reads it.
 */
function claimsPoolGroupLane(
  chainConfig: AccountInfo<Buffer>,
  chainConfigV2: AccountInfo<Buffer> | null | undefined,
): boolean {
  if (
    chainConfigV2 &&
    chainConfigV2.data.length > 9 &&
    chainConfigV2.data.subarray(0, 8).equals(CHAIN_CONFIG_V2_DISCRIMINATOR) &&
    chainConfigV2.data[9] === 2
  )
    return true
  try {
    const standard = chainConfigStandardLen(decodeTokenPoolChainConfig(chainConfig.data))
    return chainConfig.data.length === standard + 8
  } catch {
    // core decodes the lane with the pool's own layout; one this decoder cannot read claims nothing
    return false
  }
}
