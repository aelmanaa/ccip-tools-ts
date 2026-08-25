/**
 * Propose admin subcommand.
 * Proposes an administrator for a token in the TokenAdminRegistry.
 */

import { AptosTokenManager } from '@chainlink/ccip-sdk/src/cct/aptos/index.ts'
import { type RegisterAdminMethod, EVMTokenManager } from '@chainlink/ccip-sdk/src/cct/evm/index.ts'
import { SolanaTokenManager } from '@chainlink/ccip-sdk/src/cct/solana/index.ts'
import {
  type AptosChain,
  type Chain,
  type EVMChain,
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

export const command = 'propose-admin'
export const describe = 'Propose an administrator for a token in the TokenAdminRegistry'

/**
 * Yargs builder for the propose-admin subcommand.
 * @param yargs - Yargs instance.
 * @returns Configured yargs instance with command options.
 */
export const builder = (yargs: Argv) =>
  yargs
    .option('network', {
      alias: 'n',
      type: 'string',
      demandOption: true,
      describe: 'Network: chainId or name (e.g., ethereum-testnet-sepolia)',
    })
    .option('wallet', {
      alias: 'w',
      type: 'string',
      describe: 'Wallet: ledger[:index] or private key (must be token owner)',
    })
    .option('token-address', {
      type: 'string',
      demandOption: true,
      describe: 'Token address to propose admin for',
    })
    // Solana & Aptos only — on EVM the admin is always the caller
    .option('administrator', {
      type: 'string',
      describe: 'Address of the proposed administrator (Solana, Aptos only)',
    })
    // EVM-specific
    .option('registry-module-address', {
      type: 'string',
      describe: 'RegistryModuleOwnerCustom address (EVM only, from CCIP API registryModule field)',
    })
    .option('registration-method', {
      type: 'string',
      choices: ['owner', 'get-ccip-admin', 'access-control-default-admin'] as const,
      default: 'owner',
      describe: 'EVM registration method (EVM only)',
    })
    // Solana & Aptos
    .option('router-address', {
      type: 'string',
      describe: 'CCIP Router address (Solana, Aptos)',
    })
    .example([
      [
        'ccip-cli token-admin propose-admin -n ethereum-testnet-sepolia --token-address 0xa42B... --registry-module-address 0xa3c7...',
        'Propose admin on Sepolia (owner method, default)',
      ],
      [
        'ccip-cli token-admin propose-admin -n ethereum-testnet-sepolia --token-address 0xa42B... --registry-module-address 0xa3c7... --registration-method get-ccip-admin',
        'Propose admin via getCCIPAdmin method',
      ],
      [
        'ccip-cli token-admin propose-admin -n solana-devnet --wallet ~/.config/solana/id.json --token-address J6fE... --administrator 5YNm... --router-address Ccip...',
        'Propose admin on Solana devnet',
      ],
      [
        'ccip-cli token-admin propose-admin -n aptos-testnet --token-address 0x89fd... --administrator 0x0650... --router-address 0xc748...',
        'Propose admin on Aptos testnet',
      ],
    ])

/**
 * Handler for the propose-admin subcommand.
 * @param argv - Command line arguments.
 */
export async function handler(argv: Awaited<ReturnType<typeof builder>['argv']> & GlobalOpts) {
  const [ctx, destroy] = getCtx(argv)
  return doProposeAdmin(ctx, argv)
    .catch((err) => {
      process.exitCode = 1
      if (!logParsedError.call(ctx, err)) ctx.logger.error(err)
    })
    .finally(destroy)
}

type ProposeArgv = Awaited<ReturnType<typeof builder>['argv']> & GlobalOpts

/** Proposes an admin using the appropriate chain-family facade, normalizing to `{ hash }`. */
async function proposeAdminForChain(
  chain: Chain,
  wallet: unknown,
  argv: ProposeArgv,
): Promise<{ hash: string }> {
  switch (chain.network.family) {
    case ChainFamily.EVM: {
      const evmChain = chain as EVMChain
      const mgr = EVMTokenManager.fromChain(evmChain)
      // Map CLI kebab-case choices to cct-sdk's RegisterAdminMethod values.
      const cliToSdk: Record<string, RegisterAdminMethod> = {
        owner: 'owner',
        'get-ccip-admin': 'ccip-admin',
        'access-control-default-admin': 'access-control-default-admin',
      }
      // cct-sdk's registerAdmin resolves the TAR from `address` (router/registry/pool) and takes
      // the RegistryModuleOwnerCustom as `registryModule`.
      // MESH-TODO: cct-sdk's EVM registerAdmin needs a TAR source in `address`; the EVM path now
      // relies on --router-address (previously EVM-optional). Make it demanded for EVM, or add a
      // dedicated --registry-address option.
      return mgr.registerAdmin({
        tokenAddress: argv.tokenAddress,
        registryModule: argv.registryModuleAddress!,
        address: argv.routerAddress!,
        registrationMethod: cliToSdk[argv.registrationMethod],
        wallet,
      })
    }
    case ChainFamily.Solana: {
      const solanaChain = chain as unknown as SolanaChain
      const mgr = SolanaTokenManager.fromChain(solanaChain)
      // cct-sdk's Solana registerAdmin resolves the TAR from `address` (the router).
      return mgr.registerAdmin({
        tokenAddress: argv.tokenAddress,
        administrator: argv.administrator!,
        address: argv.routerAddress!,
        wallet,
      })
    }
    case ChainFamily.Aptos: {
      const aptosChain = chain as AptosChain
      const mgr = AptosTokenManager.fromChain(aptosChain)
      const { hash } = await mgr.proposeAdminRole({
        tokenAddress: argv.tokenAddress,
        administrator: argv.administrator!,
        routerAddress: argv.routerAddress!,
        wallet,
      })
      return { hash }
    }
    default:
      throw new CCIPChainFamilyUnsupportedError(chain.network.family)
  }
}

async function doProposeAdmin(ctx: Ctx, argv: ProposeArgv) {
  const networkName = networkInfo(argv.network).name
  const getChain = fetchChainsFromRpcs(ctx, argv)
  const chain = await getChain(networkName)

  const [, wallet] = await loadChainWallet(chain, argv)
  const result = await proposeAdminForChain(chain, wallet, argv)

  const output: Record<string, string> = {
    network: networkName,
    txHash: result.hash,
  }

  switch (argv.format) {
    case Format.json:
      ctx.output.write(JSON.stringify(output, null, 2))
      return
    case Format.log:
      ctx.output.write('Admin proposed, tx:', result.hash)
      return
    case Format.pretty:
    default:
      prettyTable.call(ctx, output)
      return
  }
}
