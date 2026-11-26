/**
 * PoolConfigManager (PCM) domain: the "pool or PCM" target every PCM op takes, its validation and
 * resolution, and the typed PCM handle reads decode through.
 *
 * @packageDocumentation
 */

import { type Interface, type LogDescription, getAddress, hexlify, isBytesLike } from 'ethers'

import type { EVMChain } from '../../../evm/index.ts'
import { resultToObject } from '../../../evm/types.ts'
import { CCTParamsInvalidError } from '../../errors.ts'
import {
  type MultiTokenPoolVersion,
  POOL_CONFIG_MANAGER_TYPE,
  findDeploymentBlock,
  multiTokenPoolContract,
  poolConfigManagerContract,
  resolveMultiTokenPool,
  resolveMultiTokenPoolContract,
} from '../multi-token-pool/contracts.ts'
import { validateNonZeroAddress, validateUint32 } from '../validate.ts'

/**
 * The PCM an op writes or reads: the PCM itself, or a multi-token pool whose
 * `getPoolConfigManager()` is used. Same `never`-union as `AdvancedPoolHooksTarget`, validated as
 * "exactly one" before any RPC.
 */
export type PoolConfigManagerTarget =
  | {
      /** The PoolConfigManager. */
      poolConfigManager: string
      /** Not with `poolConfigManager`. */
      poolAddress?: never
    }
  | {
      /** A multi-token pool; its `getPoolConfigManager()` is the target. */
      poolAddress: string
      /** Not with `poolAddress`. */
      poolConfigManager?: never
    }

/**
 * Validates a {@link PoolConfigManagerTarget}: exactly one of the two, a non-zero address.
 * @throws {@link CCTParamsInvalidError} if neither or both are given, or the address is invalid
 * @internal
 */
export function validatePoolConfigManagerTarget(
  operation: string,
  target: PoolConfigManagerTarget,
): void {
  // Value semantics: an explicit `undefined` does not count as provided.
  const hasPcm = target.poolConfigManager !== undefined
  if (hasPcm === (target.poolAddress !== undefined))
    throw new CCTParamsInvalidError(
      operation,
      'poolAddress',
      'provide exactly one of poolAddress or poolConfigManager',
    )
  if (hasPcm) validateNonZeroAddress(operation, 'poolConfigManager', target.poolConfigManager)
  else validateNonZeroAddress(operation, 'poolAddress', target.poolAddress)
}

/**
 * Resolves a {@link PoolConfigManagerTarget} to the PCM's address and version: the PCM itself, or
 * the one the pool names. The PCM is resolved by its own `typeAndVersion`, not the pool's.
 * @throws {@link CCTContractTypeInvalidError} if `poolAddress` is not a multi-token pool, or the PCM
 * is not a PoolConfigManager
 * @throws {@link CCTContractVersionUnsupportedError} if either version is unknown
 * @internal
 */
export async function resolvePoolConfigManagerTarget(
  chain: EVMChain,
  target: PoolConfigManagerTarget,
): Promise<{ address: string; version: MultiTokenPoolVersion }> {
  let address: string
  if (target.poolConfigManager !== undefined) address = target.poolConfigManager
  else {
    const pool = await resolveMultiTokenPool(chain, target.poolAddress)
    address = getAddress(
      resultToObject(
        await multiTokenPoolContract(
          chain,
          target.poolAddress,
          pool.version,
        ).getPoolConfigManager(),
      ),
    )
  }
  const { version } = await resolveMultiTokenPoolContract(chain, address, [
    POOL_CONFIG_MANAGER_TYPE,
  ])
  return { address, version }
}

/** Default page size for `getAllConfiguredTokens`. */
const CONFIGURED_TOKENS_PAGE = 200

/**
 * Every token the PCM registers, paging `getAllConfiguredTokens` at one block: deregistration
 * reorders the set, so pages read at different blocks can skip or repeat tokens.
 * @param chain - Chain to read on.
 * @param address - The PCM.
 * @param version - Its version.
 * @param opts - `blockTag` (defaults to the latest block) and `pageSize`.
 * @returns The tokens (checksummed) and the block they were read at.
 * @internal
 */
export async function readConfiguredTokens(
  chain: EVMChain,
  address: string,
  version: MultiTokenPoolVersion,
  { blockTag, pageSize = CONFIGURED_TOKENS_PAGE }: { blockTag?: number; pageSize?: number } = {},
): Promise<{ tokens: string[]; blockNumber: number }> {
  const blockNumber = blockTag ?? (await chain.provider.getBlockNumber())
  const pcm = poolConfigManagerContract(chain, address, version)
  const tokens: string[] = []
  for (;;) {
    const page = resultToObject(
      await pcm.getAllConfiguredTokens(BigInt(tokens.length), BigInt(pageSize), {
        blockTag: blockNumber,
      }),
    ).map((t: string) => getAddress(t))
    tokens.push(...page)
    if (page.length < pageSize) return { tokens, blockNumber }
  }
}

/**
 * Runs `read` over `items` in batches of `batchSize` and joins the results in input order: in
 * parallel by default, or one batch at a time with `sequential` (to bound concurrent RPCs).
 * @internal
 */
export async function readInBatches<T, R>(
  items: readonly T[],
  read: (batch: T[]) => Promise<R[]>,
  { batchSize, sequential = false }: { batchSize: number; sequential?: boolean },
): Promise<R[]> {
  const batches: T[][] = []
  for (let i = 0; i < items.length; i += batchSize) batches.push(items.slice(i, i + batchSize))
  if (!sequential) return (await Promise.all(batches.map(read))).flat()
  const out: R[] = []
  for (const batch of batches) out.push(...(await read(batch)))
  return out
}

/** The block range of a log scan, as the scanning reads take it. */
export type LogScanParams = {
  /** First block to scan; defaults to the contract's deployment block when the RPC can find it. */
  fromBlock?: number
  /** Last block; defaults to the latest block. */
  toBlock?: number
  /** Max blocks per `eth_getLogs`; defaults to the chain's log paging, which shrinks on a range error. */
  maxBlockRange?: number
}

/**
 * Validates a {@link LogScanParams} range before any RPC.
 * @throws {@link CCTParamsInvalidError} naming the bad field
 * @internal
 */
export function validateLogScanParams(operation: string, params: LogScanParams): void {
  for (const key of ['fromBlock', 'toBlock', 'maxBlockRange'] as const)
    if (params[key] !== undefined) validateUint32(operation, key, params[key])
  if (params.maxBlockRange === 0)
    throw new CCTParamsInvalidError(operation, 'maxBlockRange', 'must be at least 1')
  if (
    params.fromBlock !== undefined &&
    params.toBlock !== undefined &&
    params.fromBlock > params.toBlock
  )
    throw new CCTParamsInvalidError(operation, 'fromBlock', 'must not be after toBlock')
}

/**
 * Scans `address` for `events` (decoded with `iface`) over a {@link LogScanParams} range, through the
 * chain's own log paging, and reports whether the scan is complete.
 * @remarks `complete` is `true` when `fromBlock` is `0`, or when the deployment block is found and the
 * scan starts at or before it. Without `fromBlock`, the deployment block is searched from historical
 * code, which needs an archive RPC.
 * @throws {@link CCTParamsInvalidError} if `fromBlock` is omitted and the RPC cannot serve historical
 * code
 * @internal
 */
export async function scanLogs(
  chain: EVMChain,
  {
    operation,
    contract,
    address,
    iface,
    events,
    range,
  }: {
    operation: string
    /** The scanned contract's name, for the error. */
    contract: string
    address: string
    iface: Interface
    events: string[]
    range: LogScanParams
  },
): Promise<{
  logs: LogDescription[]
  scanned: { fromBlock: number; toBlock: number }
  complete: boolean
}> {
  const toBlock = range.toBlock ?? (await chain.provider.getBlockNumber())
  // a scan from block 0 is complete by definition, so it needs no deployment search
  const deployed = range.fromBlock === 0 ? 0 : await findDeploymentBlock(chain, address, toBlock)
  const fromBlock = range.fromBlock ?? deployed
  if (fromBlock === undefined)
    throw new CCTParamsInvalidError(
      operation,
      'fromBlock',
      `the RPC cannot serve historical code to find the ${contract} deployment block: pass fromBlock (the block of its creation transaction, from an explorer, or 0), or use an archive RPC. The scan is complete only when it starts at or before deployment`,
    )
  const topics = events.map((e) => iface.getEvent(e)!.topicHash)
  const logs: LogDescription[] = []
  for await (const log of chain.getLogs({
    address,
    topics: [topics],
    startBlock: fromBlock,
    endBlock: toBlock,
    ...(range.maxBlockRange !== undefined && { page: range.maxBlockRange }),
  })) {
    // EVM logs carry raw bytes; a parsed-object log is not from this contract's ABI
    if (!isBytesLike(log.data)) continue
    const parsed = iface.parseLog({ topics: [...log.topics], data: hexlify(log.data) })
    if (parsed) logs.push(parsed)
  }
  return {
    logs,
    scanned: { fromBlock, toBlock },
    complete: deployed !== undefined && fromBlock <= deployed,
  }
}
