import type { PublicKey } from '@solana/web3.js'
import BN from 'bn.js'

import { ChainFamily } from '../../../../networks.ts'
import type { SolanaChain } from '../../../../solana/index.ts'
import type { UnsignedSolanaTx } from '../../../../solana/types.ts'
import type { TransactionResult } from '../../../operation.ts'
import {
  type SolanaExecuteParams,
  type SolanaGenerateParams,
  SolanaOperation,
} from '../../operation.ts'
import {
  type ParsedLaneOpOptions,
  type PoolGroupLaneOpOptions,
  type PoolGroupLaneOpResult,
  parseLaneOpOptions,
} from '../../pool-group/lane-op-options.ts'
import {
  type PoolProgramRef,
  createTokenPoolProgram,
  deriveTokenPoolChainConfigPda,
  deriveTokenPoolConfigPda,
} from '../../programs/token-pool.ts'
import { submit } from '../../submit.ts'
import {
  U64_MAX,
  parseOptionalPublicKey,
  parsePublicKey,
  resolveExistingPoolProgram,
  validateAuthorityMatchesWallet,
  validateBigInt,
} from '../../validate.ts'

type DeleteChainRemoteConfigParams = PoolProgramRef &
  PoolGroupLaneOpOptions & {
    /** Token mint address managed by the local pool. */
    tokenAddress: string
    /** CCIP selector of the remote chain (`u64`). */
    remoteChainSelector: bigint
    /** Pool owner. Defaults to `payer` for single-signer transactions. */
    authority?: string
  }

type ParsedDeleteChainRemoteConfigParams = {
  tokenAddress: PublicKey
  poolProgramAddress?: PublicKey
  payer: PublicKey
  authority: PublicKey
  remoteChainSelector: bigint
  laneOptions: ParsedLaneOpOptions
}

/** Parameters for unsigned Solana token pool remote configuration deletion. */
export type GenerateDeleteChainRemoteConfigParams =
  SolanaGenerateParams<DeleteChainRemoteConfigParams>

/** Unsigned Solana token pool remote configuration deletion result. */
export type GenerateDeleteChainRemoteConfigResult = UnsignedSolanaTx & PoolGroupLaneOpResult

/** Parameters for executing Solana token pool remote configuration deletion. */
export type ExecuteDeleteChainRemoteConfigParams =
  SolanaExecuteParams<DeleteChainRemoteConfigParams>

/** Result of executing Solana token pool remote configuration deletion. */
export type ExecuteDeleteChainRemoteConfigResult = TransactionResult & PoolGroupLaneOpResult

/** Deletes an initialized remote-chain config. */
export class DeleteChainRemoteConfig extends SolanaOperation<
  DeleteChainRemoteConfigParams,
  UnsignedSolanaTx & PoolGroupLaneOpResult,
  ParsedDeleteChainRemoteConfigParams
> {
  readonly name = 'deleteChainRemoteConfig'

  /** Parses addresses and defaults authority to payer without mutating caller params. */
  protected override prepare(
    params: GenerateDeleteChainRemoteConfigParams,
  ): ParsedDeleteChainRemoteConfigParams {
    validateBigInt(this.name, 'remoteChainSelector', params.remoteChainSelector, 0n, U64_MAX)

    const payer = parsePublicKey(this.name, 'payer', params.payer)
    return {
      tokenAddress: parsePublicKey(this.name, 'tokenAddress', params.tokenAddress),
      poolProgramAddress: parseOptionalPublicKey(
        this.name,
        'poolProgramAddress',
        params.poolProgramAddress,
      ),
      payer,
      authority:
        params.authority === undefined
          ? payer
          : parsePublicKey(this.name, 'authority', params.authority),
      laneOptions: parseLaneOpOptions(this.name, params),
      remoteChainSelector: params.remoteChainSelector,
    }
  }

  /** Builds the unsigned Solana `deleteChainConfig` instruction. */
  protected async buildUnsigned(
    chain: SolanaChain,
    opts: ParsedDeleteChainRemoteConfigParams,
  ): Promise<UnsignedSolanaTx> {
    const poolProgram = await resolveExistingPoolProgram(
      this.name,
      chain,
      opts.tokenAddress,
      opts.poolProgramAddress,
    )
    const program = createTokenPoolProgram(chain, poolProgram, opts.payer)
    const instruction = await program.methods
      .deleteChainConfig(new BN(opts.remoteChainSelector.toString()), opts.tokenAddress)
      .accountsStrict({
        state: deriveTokenPoolConfigPda(poolProgram, opts.tokenAddress),
        chainConfig: deriveTokenPoolChainConfigPda(
          poolProgram,
          opts.remoteChainSelector,
          opts.tokenAddress,
        ),
        authority: opts.authority,
      })
      .instruction()

    chain.logger.debug(
      `${this.name}: token = ${opts.tokenAddress.toBase58()}, poolProgram = ${poolProgram.toBase58()}, remoteChainSelector = ${opts.remoteChainSelector}`,
    )
    // a pool-group lane: governed fields refused, the accounts the program needs, the guard
    // loaded on first use: the pool-group guard is never needed on a standard lane
    const { guardPoolGroupLaneOp, markedLaneState } = await import('../../pool-group/lane-gate.ts')
    const marked = opts.laneOptions.skip
      ? null
      : await markedLaneState(chain, poolProgram, opts.tokenAddress, opts.remoteChainSelector)
    const sent = marked
      ? await guardPoolGroupLaneOp({
          operation: this.name,
          chain,
          state: marked,
          kind: 'deleteChainConfig',
          payer: opts.payer,
          instruction,
          options: opts.laneOptions,
        })
      : { instruction }
    return {
      family: ChainFamily.Solana,
      instructions: [sent.instruction],
      mainIndex: 0,
      ...(sent.poolGroup && { poolGroup: sent.poolGroup }),
    }
  }

  /** Generate, sign, simulate, send, and confirm with the pool owner wallet. */
  override async execute(
    chain: SolanaChain,
    params: ExecuteDeleteChainRemoteConfigParams,
  ): Promise<ExecuteDeleteChainRemoteConfigResult> {
    const { wallet, computeUnits, parsed } = this.prepareWalletExecution(chain, params)

    if (params.authority !== undefined) {
      validateAuthorityMatchesWallet(
        this.name,
        parsed.authority,
        wallet.publicKey,
        'deleteChainRemoteConfig requires authority to be the executing wallet. Use generateUnsignedDeleteChainRemoteConfig for externally signed transactions.',
      )
    }

    return submit(chain, wallet, await this.buildUnsigned(chain, parsed), this.name, computeUnits)
  }
}
