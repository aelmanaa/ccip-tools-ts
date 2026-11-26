/**
 * Reads the facts the post-state rules need beyond the projection: hook callers, serving pools,
 * provider data lengths, and the remote side of each lane.
 *
 * @packageDocumentation
 */

import { getAddress, hexlify, isError } from 'ethers'

import type { Chain, ChainGetter } from '../../../chain.ts'
import {
  CCIPTokenNotConfiguredError,
  CCIPTokenNotInRegistryError,
  CCIPTokenPoolChainConfigNotFoundError,
} from '../../../errors/index.ts'
import { EVMChain } from '../../../evm/index.ts'
import { decodeTokenProfileFields } from '../../../evm/multi-token-pool.ts'
import { resultToObject } from '../../../evm/types.ts'
import { ChainFamily, networkInfo } from '../../../networks.ts'
import type { MultiTokenPoolRemoteAttestation } from '../../multi-token-pool.ts'
import {
  type MultiTokenPoolVersion,
  ANY_FINALITY_CONFIG,
  multiTokenPoolContract,
  multiTokenPoolHooksContract,
  poolConfigManagerContract,
  reportsMultiTokenPool,
  uidProviderContract,
} from '../multi-token-pool/contracts.ts'
import { LANE_BATCH_SIZE, readInBatches } from './contracts.ts'
import {
  type MultiTokenPoolGuardFactRequests,
  type MultiTokenPoolGuardFacts,
  type MultiTokenPoolRemoteLaneFacts,
  type MultiTokenPoolRemotePoolFacts,
  guardLaneKey,
  guardPoolKey,
} from './guards.ts'
import type { ProjectedMultiTokenPoolLane } from './projection.ts'

/** Longest an attestation may be valid for. @internal */
export const MAX_ATTESTATION_SECONDS = 24n * 60n * 60n

/** Inputs of {@link readMultiTokenPoolGuardFacts}. @internal */
export type ReadMultiTokenPoolGuardFactsInput = {
  /** The local chain. */
  chain: EVMChain
  /** The PCM. */
  poolConfigManager: string
  /** Its version. */
  version: MultiTokenPoolVersion
  /** The registry the PCM names. */
  tokenAdminRegistry: string
  /** The block the guard reads at. */
  blockTag: number
  /** The pool the write targets, when known; always a serving pool. */
  poolAddress?: string
  /** What to read. */
  requests: MultiTokenPoolGuardFactRequests
  /** Resolves remote chains (core `ChainGetter`). */
  getChain?: ChainGetter
  /** Long-data facts for remote families the SDK cannot read. */
  remoteAttestations?: readonly MultiTokenPoolRemoteAttestation[]
  /** Unix seconds now, for attestation validity. */
  now: bigint
  /** `true` for checks that make lanes live: they never use attestations. */
  makesLive?: boolean
  /** Also read each remote pool's outbound bucket toward this chain (the lane check). */
  readRemoteRateLimits?: boolean
}

/** A remote family the SDK reads the remote side of (attestations are refused for it). */
const READABLE_FAMILIES: ReadonlySet<string> = new Set([ChainFamily.EVM])
/** Families that always need `getChain`, readable or not yet: attestations never stand in for them. */
const GET_CHAIN_FAMILIES: ReadonlySet<string> = new Set([ChainFamily.EVM, ChainFamily.Solana])

/**
 * Reads every fact `requests` lists, at `blockTag` on the local chain (remote chains at their latest
 * block). Transport errors propagate; a fact the remote side lacks is `missing`, one the SDK cannot
 * read is `unknown`, and the rules never pass on either.
 * @internal
 */
export async function readMultiTokenPoolGuardFacts(
  input: ReadMultiTokenPoolGuardFactsInput,
): Promise<MultiTokenPoolGuardFacts> {
  const { chain, requests, blockTag } = input
  const [hookCallers, servingPools, additionalPoolDataBytes] = await Promise.all([
    readHookCallers(chain, requests.hooks, blockTag),
    readServingPools(input),
    readProviderDataLengths(input),
  ])
  const remoteLanes = new Map<string, MultiTokenPoolRemoteLaneFacts>()
  const remotePools = new Map<string, MultiTokenPoolRemotePoolFacts>()
  const localSelector = chain.network.chainSelector
  await Promise.all([
    ...requests.remoteLanes.map(async (lane) =>
      remoteLanes.set(
        guardLaneKey(lane),
        await readRemoteLane(input, lane, localSelector, servingPools),
      ),
    ),
    ...requests.remotePools.map(async ({ remoteChainSelector, address }) =>
      remotePools.set(
        guardPoolKey(remoteChainSelector, address),
        await readRemotePool(input, remoteChainSelector, address),
      ),
    ),
  ])
  return { remoteLanes, remotePools, hookCallers, servingPools, additionalPoolDataBytes }
}

async function readHookCallers(chain: EVMChain, hooks: readonly string[], blockTag: number) {
  const entries = await Promise.all(
    hooks.map(async (hook) => {
      const callers = await multiTokenPoolHooksContract(chain, hook).getAllAuthorizedCallers({
        blockTag,
      })
      return [getAddress(hook), callers.map((a) => getAddress(resultToObject(a)))] as const
    }),
  )
  return new Map(entries)
}

/**
 * The pools that call the PCM for the affected tokens: the target pool, and the pool the registry
 * names for each affected token when that pool uses this PCM.
 */
async function readServingPools({
  chain,
  poolConfigManager,
  version,
  tokenAdminRegistry,
  blockTag,
  poolAddress,
  requests,
}: ReadMultiTokenPoolGuardFactsInput): Promise<string[]> {
  const pools = new Set<string>(poolAddress ? [getAddress(poolAddress)] : [])
  const tokens = [...new Set(requests.remoteLanes.map((l) => getAddress(l.tokenAddress)))]
  const named = await readInBatches(
    tokens,
    (batch) =>
      Promise.all(
        batch.map((token) =>
          chain.getRegistryTokenConfig(tokenAdminRegistry, token).then(
            ({ tokenPool }) => tokenPool,
            (err: unknown) => {
              if (
                err instanceof CCIPTokenNotConfiguredError ||
                err instanceof CCIPTokenNotInRegistryError
              )
                return undefined
              throw err
            },
          ),
        ),
      ),
    { batchSize: LANE_BATCH_SIZE },
  )
  await Promise.all(
    [...new Set(named.filter((p): p is string => !!p).map((p) => getAddress(p)))].map(
      async (pool) => {
        if (pools.has(pool)) return
        const pcm = await multiTokenPoolContract(chain, pool, version)
          .getPoolConfigManager({ blockTag })
          .then(
            (a) => getAddress(resultToObject(a)),
            (err: unknown) => {
              // a registry pool that is not a multi-token pool does not call this PCM
              if (isError(err, 'CALL_EXCEPTION') || isError(err, 'BAD_DATA')) return undefined
              throw err
            },
          )
        if (pcm === getAddress(poolConfigManager)) pools.add(pool)
      },
    ),
  )
  return [...pools].sort()
}

/** Bytes of additional pool data per lane whose token has a provider. */
async function readProviderDataLengths({
  chain,
  poolConfigManager,
  version,
  blockTag,
  requests,
}: ReadMultiTokenPoolGuardFactsInput): Promise<Map<string, number>> {
  const lengths = new Map<string, number>()
  const tokens = [...new Set(requests.providerLanes.map((l) => getAddress(l.tokenAddress)))]
  if (!tokens.length) return lengths
  const pcm = poolConfigManagerContract(chain, poolConfigManager, version)
  const configs = await pcm.getTokenConfigBatch(tokens, { blockTag })
  const providers = new Map(
    tokens.map((t, i) => [
      t,
      decodeTokenProfileFields(resultToObject(configs[i]!)).additionalPoolDataProvider,
    ]),
  )
  await Promise.all(
    requests.providerLanes.map(async (lane) => {
      const provider = providers.get(getAddress(lane.tokenAddress))
      if (!provider) return
      // the data the send would add; a revert here reverts every send, which the eth_call of the write
      // does not show, so it propagates as the read error it is
      const data = await uidProviderContract(chain, provider).getAdditionalPoolData(
        lane.tokenAddress,
        lane.remoteChainSelector,
        ANY_FINALITY_CONFIG,
        '0x',
        { blockTag },
      )
      lengths.set(guardLaneKey(lane), (hexlify(data).length - 2) / 2)
    }),
  )
  return lengths
}

/** The family of a remote selector, or `undefined` for an unknown one. */
function familyOf(remoteChainSelector: bigint): string | undefined {
  try {
    const info = networkInfo(remoteChainSelector)
    return info.chainSelector === remoteChainSelector ? info.family : undefined
  } catch {
    return undefined
  }
}

/** Resolves the remote chain, or explains why it cannot be read. */
async function remoteChainOf(
  { getChain }: ReadMultiTokenPoolGuardFactsInput,
  remoteChainSelector: bigint,
): Promise<Chain | { status: 'unknown'; reason: string }> {
  const family = familyOf(remoteChainSelector)
  if (family === undefined)
    return {
      status: 'unknown',
      reason: `remote chain selector ${remoteChainSelector} is not a known CCIP chain`,
    }
  if (!READABLE_FAMILIES.has(family))
    return {
      status: 'unknown',
      reason: `the SDK cannot read the remote side of a ${family} lane yet${GET_CHAIN_FAMILIES.has(family) ? '' : '; supply a remoteAttestations entry'}`,
    }
  if (!getChain)
    return {
      status: 'unknown',
      reason: `pass getChain to read the remote ${family} side of the lane`,
    }
  return getChain(remoteChainSelector)
}

/** Checks an attestation against the attestation rules; returns why it is refused, or `undefined`. */
export function attestationRefusal(
  a: MultiTokenPoolRemoteAttestation,
  { now, makesLive }: { now: bigint; makesLive?: boolean },
): string | undefined {
  const family = familyOf(a.remoteChainSelector)
  if (makesLive) return 'a check that makes lanes live always reads the remote side'
  if (family !== undefined && GET_CHAIN_FAMILIES.has(family))
    return `${family} remotes are read with getChain; an attestation never stands in for them`
  if (now > a.validUntil) return `it expired at ${a.validUntil}`
  if (a.validUntil - a.attestedAt > MAX_ATTESTATION_SECONDS) return 'its validity exceeds 24 hours'
  if (a.attestedAt > now) return 'it is attested in the future'
  return undefined
}

async function readRemoteLane(
  input: ReadMultiTokenPoolGuardFactsInput,
  lane: ProjectedMultiTokenPoolLane,
  localSelector: bigint,
  servingPools: readonly string[],
): Promise<MultiTokenPoolRemoteLaneFacts> {
  const remoteToken = lane.connection.remoteToken!
  const trusted = lane.connection.remotePools.map((p) => p.address)
  const remote = await remoteChainOf(input, lane.remoteChainSelector)
  if ('status' in remote) {
    // a family the SDK cannot read: an attestation for exactly this lane, if valid
    const attestation = input.remoteAttestations?.find(
      (a) =>
        a.remoteChainSelector === lane.remoteChainSelector &&
        a.remoteToken === remoteToken &&
        trusted.includes(a.remotePoolAddress),
    )
    if (!attestation) return remote
    const refused = attestationRefusal(attestation, input)
    if (refused)
      return { status: 'unknown', reason: `the attestation for this lane is refused: ${refused}` }
    return {
      status: 'known',
      readsLongData: attestation.acceptsLongPoolData,
      registryPool: attestation.remotePoolAddress,
      // the reverse mapping needs a read; legacy lanes fail closed without one
      mapsBack: false,
      attestation,
    }
  }
  if (!trusted.length)
    return {
      status: 'missing',
      reason: 'the lane trusts no remote pool, so its remote registry cannot be found',
    }
  const registry = await remote.getTokenAdminRegistryFor(trusted[0]!)
  const registryPool = await remote.getRegistryTokenConfig(registry, remoteToken).then(
    ({ tokenPool }) => (tokenPool ? getAddress(tokenPool) : null),
    (err: unknown) => {
      if (err instanceof CCIPTokenNotConfiguredError || err instanceof CCIPTokenNotInRegistryError)
        return null
      throw err
    },
  )
  if (registryPool === null)
    return {
      status: 'known',
      readsLongData: false,
      registryPool,
      mapsBack: false,
      remoteTokenHasCode: await remoteTokenHasCode(remote, remoteToken),
    }
  const [type] = await remote.typeAndVersion(registryPool)
  const readsLongData = reportsMultiTokenPool(type)
  // only a legacy lane relies on the reverse mapping
  // the remote lane back: the reverse mapping a legacy lane relies on, and the remote outbound
  // limit the lane check compares with this lane's inbound
  const legacy = lane.connection.poolDataFormat === 'legacy'
  if (!legacy && !input.readRemoteRateLimits)
    return { status: 'known', readsLongData, registryPool, mapsBack: true }
  const back = await remote
    .getTokenPoolRemotes(registryPool, localSelector, { token: remoteToken })
    .then(
      (remotes) => Object.values(remotes)[0],
      (err: unknown) => {
        if (err instanceof CCIPTokenPoolChainConfigNotFoundError) return undefined
        throw err
      },
    )
  const pointsBack =
    !!back &&
    getAddress(back.remoteToken) === getAddress(lane.tokenAddress) &&
    back.remotePools.some((p) => servingPools.includes(getAddress(p)))
  return {
    status: 'known',
    readsLongData,
    registryPool,
    mapsBack: legacy ? pointsBack : true,
    ...(input.readRemoteRateLimits &&
      back && {
        remoteOutbound: back.outboundRateLimiterState,
        remoteDecimals: (await remote.getTokenInfo(remoteToken)).decimals,
      }),
  }
}

/** Whether the remote token has code (EVM remotes; other families do not say). */
async function remoteTokenHasCode(remote: Chain, token: string): Promise<boolean | undefined> {
  if (!(remote instanceof EVMChain)) return undefined
  return (await remote.provider.getCode(token)) !== '0x'
}

async function readRemotePool(
  input: ReadMultiTokenPoolGuardFactsInput,
  remoteChainSelector: bigint,
  address: string,
): Promise<MultiTokenPoolRemotePoolFacts> {
  const remote = await remoteChainOf(input, remoteChainSelector)
  if ('status' in remote) return remote
  const [type] = await remote.typeAndVersion(address).catch((err: unknown) => {
    // a pool that reports no typeAndVersion is not a multi-token pool
    if (isError(err, 'CALL_EXCEPTION') || isError(err, 'BAD_DATA')) return ['']
    throw err
  })
  return { status: 'known', isMultiTokenPool: reportsMultiTokenPool(type) }
}
