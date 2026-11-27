/**
 * Which pools serve a PoolConfigManager: the one answer the stack audit reports and the guard's
 * hook-caller rule reads, with one error policy.
 *
 * @packageDocumentation
 */

import { ZeroAddress, getAddress } from 'ethers'

import type { Chain } from '../../../chain.ts'
import { CCIPTokenNotConfiguredError, CCIPTokenNotInRegistryError } from '../../../errors/index.ts'
import type { EVMChain } from '../../../evm/index.ts'
import { resultToObject } from '../../../evm/types.ts'
import {
  type MultiTokenPoolVersion,
  multiTokenPoolContract,
  reportsMultiTokenPool,
} from '../multi-token-pool/contracts.ts'
import { isMissingFunction, readContractTypeOrNull } from '../query.ts'
import { readTokenAdminRegistryConfig } from '../token-admin-registry/contracts.ts'
import { readInBatches } from './contracts.ts'

/** Registry reads per batch: a large stack must not flood the RPC. */
const REGISTRY_BATCH_SIZE = 16

/**
 * The pool the registry names for a token, or `null` when it names none (or lists no entry). Any
 * other failure propagates.
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
 * The PoolConfigManager a pool calls (checksummed), or `undefined` when it is not a multi-token pool: it reports
 * no `typeAndVersion`, another type, or no `getPoolConfigManager`. Transport errors propagate.
 */
export async function poolConfigManagerOf(
  chain: EVMChain,
  pool: string,
  version: MultiTokenPoolVersion,
  blockTag: number | undefined,
): Promise<string | undefined> {
  const type = await readContractTypeOrNull(chain, pool)
  if (type === null || !reportsMultiTokenPool(type)) return undefined
  // any multi-token pool version answers `getPoolConfigManager`; a pool of an unknown version that
  // calls this PCM still serves it, so it is counted rather than refused
  return readPoolConfigManagerAddress(chain, pool, version, blockTag)
}

/**
 * The PoolConfigManager a pool already known to be a multi-token pool calls (checksummed), or
 * `undefined` when it has no `getPoolConfigManager`. Transport errors propagate.
 * @internal
 */
export async function readPoolConfigManagerAddress(
  chain: EVMChain,
  pool: string,
  version: MultiTokenPoolVersion,
  blockTag?: number,
): Promise<string | undefined> {
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
  /**
   * Each token's registry entry, read from the TokenAdminRegistry directly so every admin state is
   * visible (a proposed admin not yet accepted too); `null` fields are unset.
   */
  entries: Map<
    string,
    { pool: string | null; administrator: string | null; pendingAdministrator: string | null }
  >
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
        batch.map(async (token) => {
          const entry = await readTokenAdminRegistryConfig(chain, tokenAdminRegistry, token, {
            ...(blockTag !== undefined && { blockTag }),
          })
          const set = (a: string) => (a === ZeroAddress ? null : a)
          return {
            token,
            pool: set(entry.tokenPool),
            administrator: set(entry.administrator),
            pendingAdministrator: set(entry.pendingAdministrator),
          }
        }),
      ),
    { batchSize: REGISTRY_BATCH_SIZE, sequential: true },
  )
  const others = named
    .filter((n) => n.pool !== null && n.pool !== target)
    .map((n) => ({ token: n.token, pool: n.pool! }))
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
  const entries = new Map(named.map(({ token, ...entry }) => [token, entry] as const))
  return { serving: [...serving].sort(), diverged, entries }
}
