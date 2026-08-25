/**
 * Token create-pool-token-account subcommand (Solana only).
 * Creates the pool signer PDA's associated token account (the pool "vault") for a token mint.
 */

import { SolanaTokenManager } from '@chainlink/ccip-sdk/src/cct/solana/index.ts'
import {
  type SolanaChain,
  CCIPChainFamilyUnsupportedError,
  ChainFamily,
  networkInfo,
} from '@chainlink/ccip-sdk/src/index.ts'
import type { Argv } from 'yargs'

import type { GlobalOpts } from '../../index.ts'
import { fetchChainsFromRpcs, loadChainWallet } from '../../providers/index.ts'
import { type Ctx, Format } from '../types.ts'
import { getCtx, logParsedError, prettyTable } from '../utils.ts'

export const command = 'create-pool-token-account'
export const describe = "Create the pool signer PDA's associated token account (Solana only)"

/**
 * Yargs builder for the token create-pool-token-account subcommand.
 * @param yargs - Yargs instance.
 * @returns Configured yargs instance with command options.
 */
export const builder = (yargs: Argv) =>
  yargs
    .option('network', {
      alias: 'n',
      type: 'string',
      demandOption: true,
      describe: 'Network: chainId or name (e.g., solana-devnet)',
    })
    .option('wallet', {
      alias: 'w',
      type: 'string',
      describe: 'Wallet: ledger[:index] or private key',
    })
    .option('token-address', {
      type: 'string',
      demandOption: true,
      describe: 'SPL token mint address (base58)',
    })
    .option('pool-address', {
      type: 'string',
      demandOption: true,
      describe: 'Pool state PDA (base58); the pool program is derived from its on-chain owner',
    })
    .example([
      [
        'ccip-cli token create-pool-token-account -n solana-devnet --token-address J6fE... --pool-address 2pGY...',
        "Create the pool signer PDA's token account (run once after deploying the pool, before the first send)",
      ],
    ])

/**
 * Handler for the token create-pool-token-account subcommand.
 * @param argv - Command line arguments.
 */
export async function handler(argv: Awaited<ReturnType<typeof builder>['argv']> & GlobalOpts) {
  const [ctx, destroy] = getCtx(argv)
  return doCreatePoolTokenAccount(ctx, argv)
    .catch((err) => {
      process.exitCode = 1
      if (!logParsedError.call(ctx, err)) ctx.logger.error(err)
    })
    .finally(destroy)
}

type CreatePoolTokenAccountArgv = Awaited<ReturnType<typeof builder>['argv']> & GlobalOpts

async function doCreatePoolTokenAccount(ctx: Ctx, argv: CreatePoolTokenAccountArgv) {
  const networkName = networkInfo(argv.network).name
  const getChain = fetchChainsFromRpcs(ctx, argv)
  const chain = await getChain(networkName)

  if (chain.network.family !== ChainFamily.Solana) {
    throw new CCIPChainFamilyUnsupportedError(chain.network.family, {
      context: { reason: 'create-pool-token-account is only supported on Solana' },
    })
  }

  const solanaChain = chain as SolanaChain
  const mgr = SolanaTokenManager.fromChain(solanaChain)

  const [, wallet] = await loadChainWallet(chain, argv)
  const result = await mgr.createPoolTokenAccount({
    tokenAddress: argv.tokenAddress,
    poolAddress: argv.poolAddress,
    wallet,
  })

  const output: Record<string, string> = {
    network: networkName,
    poolTokenAccount: result.poolTokenAccount,
    poolSignerPda: result.poolSignerPda,
    txHash: result.hash,
  }

  switch (argv.format) {
    case Format.json:
      ctx.output.write(JSON.stringify(output, null, 2))
      return
    case Format.log:
      ctx.output.write('Pool token account created:', result.poolTokenAccount, 'tx:', result.hash)
      return
    case Format.pretty:
    default:
      prettyTable.call(ctx, output)
      return
  }
}
