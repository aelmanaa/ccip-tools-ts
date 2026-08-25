/**
 * Pool apply-chain-updates subcommand.
 * Configures remote chains on a CCIP token pool.
 */

import { AptosTokenManager } from '@chainlink/ccip-sdk/src/cct/aptos/index.ts'
import { EVMTokenManager } from '@chainlink/ccip-sdk/src/cct/evm/index.ts'
import { SolanaTokenManager } from '@chainlink/ccip-sdk/src/cct/solana/index.ts'
import {
  type ApplyChainUpdatesParams,
  type AptosChain,
  type Chain,
  type EVMChain,
  type RateLimiterConfig,
  type RemoteChainConfig,
  type SolanaChain,
  CCIPArgumentInvalidError,
  CCIPChainFamilyUnsupportedError,
  ChainFamily,
  networkInfo,
} from '@chainlink/ccip-sdk/src/index.ts'
import type { Argv } from 'yargs'

import type { GlobalOpts } from '../../index.ts'
import { fetchChainsFromRpcs, loadChainWallet } from '../../providers/index.ts'
import { type Ctx, Format } from '../types.ts'
import { getCtx, logParsedError, prettyTable } from '../utils.ts'

export const command = 'apply-chain-updates'
export const describe = 'Configure remote chains on a CCIP token pool'

// ── Config file schema ──

interface ConfigFile {
  chainsToRemove?: string[]
  chainsToAdd?: Array<{
    remoteChainSelector: string
    remotePoolAddresses: string[]
    remoteTokenAddress: string
    remoteTokenDecimals?: number
    outboundRateLimiterConfig?: RateLimiterConfig
    inboundRateLimiterConfig?: RateLimiterConfig
  }>
}

// ── Generate config template ──

const CONFIG_TEMPLATE: ConfigFile = {
  chainsToRemove: [],
  chainsToAdd: [
    {
      remoteChainSelector:
        '<CHAIN_NAME_OR_SELECTOR e.g. ethereum-testnet-sepolia or 16015286601757825753>',
      remotePoolAddresses: ['<REMOTE_POOL_ADDRESS>'],
      remoteTokenAddress: '<REMOTE_TOKEN_ADDRESS>',
      remoteTokenDecimals: 18,
      outboundRateLimiterConfig: { isEnabled: false, capacity: '0', rate: '0' },
      inboundRateLimiterConfig: { isEnabled: false, capacity: '0', rate: '0' },
    },
  ],
}

/**
 * Yargs builder for the pool apply-chain-updates subcommand.
 */
export const builder = (yargs: Argv) =>
  yargs
    .option('network', {
      alias: 'n',
      type: 'string',
      describe: 'Network: chainId or name (e.g., ethereum-testnet-sepolia)',
    })
    .option('wallet', {
      alias: 'w',
      type: 'string',
      describe: 'Wallet: ledger[:index] or private key (must be pool owner)',
    })
    .option('pool-address', {
      type: 'string',
      describe: 'Local pool address (EVM / Aptos)',
    })
    .option('token-address', {
      type: 'string',
      describe: 'Local token mint address (Solana only; the state PDA is derived from it)',
    })
    .option('pool-type', {
      type: 'string',
      choices: ['burn-mint', 'lock-release'] as const,
      describe:
        'Canonical Solana pool program to target (Solana only; or use --pool-program-address)',
    })
    .option('pool-program-address', {
      type: 'string',
      describe: 'Custom Solana token-pool program id (Solana only; alternative to --pool-type)',
    })
    .option('config', {
      type: 'string',
      describe: 'Path to JSON config file with remote chain configurations',
    })
    .option('generate-config', {
      type: 'boolean',
      describe: 'Output a sample JSON config template to stdout',
    })
    .check((argv) => {
      if (!argv.generateConfig) {
        if (!argv.network)
          throw new CCIPArgumentInvalidError('network', 'required argument missing')
        // EVM/Aptos identify the pool by address; Solana identifies it by token mint + pool program.
        if (!argv.poolAddress && !argv.tokenAddress)
          throw new CCIPArgumentInvalidError(
            'pool-address',
            'required argument missing (use --pool-address for EVM/Aptos, or --token-address + --pool-type/--pool-program-address for Solana)',
          )
      }
      return true
    })
    .example([
      [
        'ccip-cli pool apply-chain-updates -n sepolia --pool-address 0x... --config config.json',
        'Apply chain updates from a config file',
      ],
      [
        'ccip-cli pool apply-chain-updates --generate-config > config.json',
        'Generate a template config file',
      ],
      [
        'cat config.json | ccip-cli pool apply-chain-updates -n sepolia --pool-address 0x...',
        'Read config from stdin',
      ],
    ])

/**
 * Handler for the pool apply-chain-updates subcommand.
 */
export async function handler(argv: Awaited<ReturnType<typeof builder>['argv']> & GlobalOpts) {
  const [ctx, destroy] = getCtx(argv)
  // Handle --generate-config
  if (argv.generateConfig) {
    ctx.output.write(JSON.stringify(CONFIG_TEMPLATE, null, 2))
    destroy()
    return
  }

  return doApplyChainUpdates(ctx, argv)
    .catch((err) => {
      process.exitCode = 1
      if (!logParsedError.call(ctx, err)) ctx.logger.error(err)
    })
    .finally(destroy)
}

type ApplyArgv = Awaited<ReturnType<typeof builder>['argv']> & GlobalOpts

/** Reads and parses config from file path or stdin. */
async function readConfig(argv: ApplyArgv): Promise<ConfigFile> {
  const { readFileSync } = await import('node:fs')

  if (argv.config) {
    // Read from file
    const raw = readFileSync(argv.config, 'utf8')
    return JSON.parse(raw) as ConfigFile
  }

  // Try stdin (piped input)
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer)
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    return JSON.parse(raw) as ConfigFile
  }

  throw new CCIPArgumentInvalidError(
    'config',
    'No config provided. Use --config <path> or pipe JSON via stdin. Use --generate-config to see the expected format.',
  )
}

/**
 * Resolves a chain identifier (name, chainId, or selector) to a numeric selector string.
 * Uses `networkInfo()` which accepts all three formats.
 */
function resolveChainSelector(input: string): bigint {
  return networkInfo(input).chainSelector
}

/** Converts a config file to ApplyChainUpdatesParams. */
function configToParams(poolAddress: string, config: ConfigFile): ApplyChainUpdatesParams {
  const defaultRateLimit: RateLimiterConfig = { isEnabled: false, capacity: '0', rate: '0' }

  const chainsToAdd: RemoteChainConfig[] = (config.chainsToAdd ?? []).map((c) => ({
    remoteChainSelector: resolveChainSelector(c.remoteChainSelector),
    remotePoolAddresses: c.remotePoolAddresses,
    remoteTokenAddress: c.remoteTokenAddress,
    remoteTokenDecimals: c.remoteTokenDecimals,
    outboundRateLimiterConfig: c.outboundRateLimiterConfig ?? defaultRateLimit,
    inboundRateLimiterConfig: c.inboundRateLimiterConfig ?? defaultRateLimit,
  }))

  return {
    poolAddress,
    remoteChainSelectorsToRemove: (config.chainsToRemove ?? []).map(resolveChainSelector),
    chainsToAdd,
  }
}

/** Maps an EVM/CLI `RateLimiterConfig` to Solana's `RateLimitConfig` (isEnabled becomes enabled). */
function toSolanaRateLimit(rl?: RateLimiterConfig) {
  return (rl?.isEnabled ?? false)
    ? { enabled: true as const, capacity: BigInt(rl!.capacity), rate: BigInt(rl!.rate) }
    : {
        enabled: false as const,
        capacity: BigInt(rl?.capacity ?? '0'),
        rate: BigInt(rl?.rate ?? '0'),
      }
}

/**
 * Builds cct-sdk's Solana `applyChainUpdates` params from the config + CLI args. The Solana op
 * derives the pool state PDA from the pool program + token mint, so it needs `tokenAddress` (mint)
 * and a pool-program ref (canonical `poolType` or a custom `poolProgramAddress`) rather than a
 * pool address. Each `chainsToAdd` entry must carry `remoteTokenDecimals` (required by the account).
 */
function configToSolanaOpts(argv: ApplyArgv, config: ConfigFile, wallet: unknown) {
  if (!argv.tokenAddress)
    throw new CCIPArgumentInvalidError('token-address', 'required for Solana apply-chain-updates')
  if (!argv.poolProgramAddress && !argv.poolType)
    throw new CCIPArgumentInvalidError(
      'pool-type',
      'Solana requires --pool-type (burn-mint|lock-release) or --pool-program-address',
    )
  const poolRef = argv.poolProgramAddress
    ? { poolProgramAddress: argv.poolProgramAddress }
    : { poolType: argv.poolType as 'burn-mint' | 'lock-release' }

  const chainsToAdd = (config.chainsToAdd ?? []).map((c, i) => {
    if (c.remoteTokenDecimals == null)
      throw new CCIPArgumentInvalidError(
        `chainsToAdd[${i}].remoteTokenDecimals`,
        'required for Solana (the pool account stores remote token decimals)',
      )
    return {
      remoteChainSelector: resolveChainSelector(c.remoteChainSelector),
      remoteTokenAddress: c.remoteTokenAddress,
      remotePoolAddresses: c.remotePoolAddresses,
      remoteTokenDecimals: c.remoteTokenDecimals,
      inboundRateLimiterConfig: toSolanaRateLimit(c.inboundRateLimiterConfig),
      outboundRateLimiterConfig: toSolanaRateLimit(c.outboundRateLimiterConfig),
    }
  })

  return {
    ...poolRef,
    tokenAddress: argv.tokenAddress,
    chainsToAdd,
    remoteChainSelectorsToRemove: (config.chainsToRemove ?? []).map(resolveChainSelector),
    wallet,
  }
}

/**
 * Calls applyChainUpdates on the appropriate chain-family facade, normalizing to `{ hash }`.
 * Solana batches into multiple transactions, so `hashes` carries every signature.
 */
async function applyForChain(
  chain: Chain,
  wallet: unknown,
  argv: ApplyArgv,
  config: ConfigFile,
): Promise<{ hash: string; hashes?: string[] }> {
  switch (chain.network.family) {
    case ChainFamily.EVM: {
      const evmChain = chain as EVMChain
      const mgr = EVMTokenManager.fromChain(evmChain)
      const params = configToParams(argv.poolAddress!, config)
      return mgr.applyChainUpdates({ ...params, wallet })
    }
    case ChainFamily.Solana: {
      const mgr = SolanaTokenManager.fromChain(chain as unknown as SolanaChain)
      const { hashes } = await mgr.applyChainUpdates(configToSolanaOpts(argv, config, wallet))
      // Solana splits chain updates across several transactions; report the last as the shared
      // `hash` while surfacing every signature via `hashes`.
      return { hash: hashes[hashes.length - 1] ?? '', hashes }
    }
    case ChainFamily.Aptos: {
      const aptosChain = chain as AptosChain
      const mgr = AptosTokenManager.fromChain(aptosChain)
      const params = configToParams(argv.poolAddress!, config)
      const { hash } = await mgr.applyChainUpdates({ ...params, wallet })
      return { hash }
    }
    default:
      throw new CCIPChainFamilyUnsupportedError(chain.network.family)
  }
}

async function doApplyChainUpdates(ctx: Ctx, argv: ApplyArgv) {
  const { logger } = ctx
  const networkName = networkInfo(argv.network!).name
  const getChain = fetchChainsFromRpcs(ctx, argv)
  const chain = await getChain(networkName)

  const config = await readConfig(argv)
  const addCount = (config.chainsToAdd ?? []).length
  const removeCount = (config.chainsToRemove ?? []).length

  logger.debug(`Applying chain updates: ${addCount} add(s), ${removeCount} remove(s)`)

  const [, wallet] = await loadChainWallet(chain, argv)
  const result = await applyForChain(chain, wallet, argv, config)

  // Log every signature so a batched Solana run can be fully captured.
  if (result.hashes) result.hashes.forEach((h, i) => logger.info(`tx[${i}]: ${h}`))

  const output: Record<string, string> = {
    network: networkName,
    poolAddress: argv.poolAddress ?? argv.tokenAddress ?? '',
    txHash: result.hash,
    ...(result.hashes ? { txHashes: result.hashes.join(',') } : {}),
    chainsAdded: String(addCount),
    chainsRemoved: String(removeCount),
  }

  switch (argv.format) {
    case Format.json:
      ctx.output.write(JSON.stringify(output, null, 2))
      return
    case Format.log:
      ctx.output.write('Chain updates applied, tx:', result.hash)
      return
    case Format.pretty:
    default:
      prettyTable.call(ctx, output)
      return
  }
}
