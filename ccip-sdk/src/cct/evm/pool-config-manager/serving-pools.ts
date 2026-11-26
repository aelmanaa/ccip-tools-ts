/**
 * Which pools serve a PoolConfigManager: the one answer the stack audit reports and the guard's
 * hook-caller rule reads, with one error policy.
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

import type { Chain } from '../../../chain.ts'
import { CCIPTokenNotConfiguredError, CCIPTokenNotInRegistryError } from '../../../errors/index.ts'
import type { EVMChain } from '../../../evm/index.ts'
import { resultToObject } from '../../../evm/types.ts'
import {
  type MultiTokenPoolVersion,
  multiTokenPoolContract,
  reportsMultiTokenPool,
} from '../multi-token-pool/contracts.ts'
import { isMissingFunction, isNotCcipContract } from '../query.ts'
import { readInBatches } from './contracts.ts'

/** Registry reads per batch: a large stack must not flood the RPC. */
const REGISTRY_BATCH_SIZE = 16

/**
 * The pool the registry names for a token, or `null` when it names none: a token the registry does
 * not list and one with no pool set read the same. Any other failure propagates.
 * @internal
 */
export async function readRegistryPool(
  chain: Pick<Chain, 'getRegistryTokenConfig'>,
  tokenAdminRegistry: string,
  token: string,
): Promise<string | null> {
  return chain.getRegistryTokenConfig(tokenAdminRegistry, token).then(
    ({ tokenPool }) => (tokenPool ? getAddress(tokenPool) : null),
    (err: unknown) => {
      if (err instanceof CCIPTokenNotConfiguredError || err instanceof CCIPTokenNotInRegistryError)
        return null
      throw err
    },
  )
}

/**
 * The PoolConfigManager a pool calls, or `undefined` when it is not a multi-token pool: it reports
 * no `typeAndVersion`, another type, or no `getPoolConfigManager`. Transport errors propagate.
 */
async function poolConfigManagerOf(
  chain: EVMChain,
  pool: string,
  version: MultiTokenPoolVersion,
  blockTag: number | undefined,
): Promise<string | undefined> {
  const type = await chain.typeAndVersion(pool).then(
    ([t]) => t,
    (err: unknown) => {
      if (isNotCcipContract(err)) return undefined
      throw err
    },
  )
  if (type === undefined || !reportsMultiTokenPool(type)) return undefined
  // any multi-token pool version answers `getPoolConfigManager`; a pool of an unknown version that
  // calls this PCM still serves it, so it is counted rather than refused
  return multiTokenPoolContract(chain, pool, version)
    .getPoolConfigManager(blockTag === undefined ? {} : { blockTag })
    .then(
      (a) => getAddress(resultToObject(a)),
      (err: unknown) => {
        if (isMissingFunction(err)) return undefined
        throw err
      },
    )
}

/** Pools serving a PoolConfigManager, from its tokens' registry entries. @internal */
export type PoolConfigManagerServingPools = {
  /** Registry-named pools, other than `targetPool`, that call this PCM; sorted. */
  serving: string[]
  /** Tokens whose registry pool does not call this PCM (another PCM, or not a multi-token pool). */
  diverged: { token: string; pool: string }[]
}

/**
 * Reads the pool the registry names for each token, and which of them call `poolConfigManager`.
 * @internal
 */
export async function readPoolsServingPoolConfigManager(
  chain: EVMChain,
  {
    poolConfigManager,
    version,
    tokenAdminRegistry,
    tokens,
    targetPool,
    blockTag,
  }: {
    poolConfigManager: string
    version: MultiTokenPoolVersion
    tokenAdminRegistry: string
    tokens: readonly string[]
    /** The pool being read or written: never listed, it serves by definition. */
    targetPool?: string
    blockTag?: number
  },
): Promise<PoolConfigManagerServingPools> {
  const pcm = getAddress(poolConfigManager)
  const target = targetPool === undefined ? undefined : getAddress(targetPool)
  const named = await readInBatches(
    [...new Set(tokens.map((t) => getAddress(t)))],
    (batch) =>
      Promise.all(
        batch.map(async (token) => ({
          token,
          pool: await readRegistryPool(chain, tokenAdminRegistry, token),
        })),
      ),
    { batchSize: REGISTRY_BATCH_SIZE, sequential: true },
  )
  const others = named.filter(
    (n): n is { token: string; pool: string } => n.pool !== null && n.pool !== target,
  )
  const callers = new Map(
    await Promise.all(
      [...new Set(others.map((n) => n.pool))].map(
        async (pool) => [pool, await poolConfigManagerOf(chain, pool, version, blockTag)] as const,
      ),
    ),
  )
  const serving = new Set<string>()
  const diverged: { token: string; pool: string }[] = []
  for (const n of others)
    if (callers.get(n.pool) === pcm) serving.add(n.pool)
    else diverged.push(n)
  return { serving: [...serving].sort(), diverged }
}
