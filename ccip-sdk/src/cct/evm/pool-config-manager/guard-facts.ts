/**
 * Reads the facts the post-state rules need beyond the projection: hook callers, serving pools,
 * provider data lengths, and the remote side of each lane.
 *
 * @packageDocumentation
 */

import { type Result, dataLength, getAddress } from 'ethers'

import type { Chain, ChainGetter } from '../../../chain.ts'
import {
  CCIPContractNotRouterError,
  CCIPTokenPoolChainConfigNotFoundError,
} from '../../../errors/index.ts'
import { EVMChain } from '../../../evm/index.ts'
import { decodeLaneConnection, decodeTokenProfileFields } from '../../../evm/multi-token-pool.ts'
import { resultToObject } from '../../../evm/types.ts'
import { ChainFamily } from '../../../networks.ts'
import { CCTContractTypeInvalidError, CCTContractVersionUnsupportedError } from '../../errors.ts'
import { type MultiTokenPoolRemoteAttestation, abiWord } from '../../multi-token-pool.ts'
import { laneFamilyOf } from '../../remote-address.ts'
import { readAllAuthorizedCallers } from '../advanced-pool-hooks/contracts.ts'
import {
  type MultiTokenPoolVersion,
  ANY_FINALITY_CONFIG,
  nullableAddress,
  poolConfigManagerContract,
  readProviderPoolData,
  reportsMultiTokenPool,
  resolveMultiTokenPool,
  uidProviderContract,
} from '../multi-token-pool/contracts.ts'
import { isMissingFunction, isNotCcipContract, readContractTypeOrNull } from '../query.ts'
import { toTokenTransferFeeConfig } from '../token-pool/contracts.ts'
import { toAbiLaneKey } from './contracts.ts'
import {
  type MultiTokenPoolGuardFactRequests,
  type MultiTokenPoolGuardFacts,
  type MultiTokenPoolRemoteLaneFacts,
  type MultiTokenPoolRemotePoolFacts,
  guardLaneKey,
  guardPoolKey,
} from './guards.ts'
import type { ProjectedMultiTokenPoolLane } from './projection.ts'
import {
  readPoolConfigManagerAddress,
  readPoolsServingPoolConfigManager,
  readRegistryPool,
} from './serving-pools.ts'

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
  /**
   * The additional pool data provider each token has after the write, for tokens a profile write
   * changes (`null`: none); others read the provider stored now.
   */
  providerOverrides?: ReadonlyMap<string, string | null>
  /** The provider each token stores now, from the state already read (others are read). */
  storedProviders?: ReadonlyMap<string, string | null>
}

/** A remote family the SDK reads the remote side of (attestations are refused for it). */
const READABLE_FAMILIES: ReadonlySet<string> = new Set([ChainFamily.EVM, ChainFamily.Solana])
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
  const [hookCallers, servingPools, provided] = await Promise.all([
    readHookCallers(chain, requests.hooks, blockTag),
    readServingPools(input),
    readProviderData(input),
  ])
  const { lengths: additionalPoolDataBytes, bytes: additionalPoolData } = provided
  const remoteLanes = new Map<string, MultiTokenPoolRemoteLaneFacts>()
  const remotePools = new Map<string, MultiTokenPoolRemotePoolFacts>()
  const localSelector = chain.network.chainSelector
  await Promise.all([
    ...requests.remoteLanes.map(async (lane) =>
      remoteLanes.set(
        guardLaneKey(lane),
        await readRemoteLane(
          input,
          lane,
          localSelector,
          servingPools,
          outboundData(lane, provided),
        ),
      ),
    ),
    ...requests.remotePools.map(async ({ remoteChainSelector, address }) =>
      remotePools.set(
        guardPoolKey(remoteChainSelector, address),
        await readRemotePool(input, remoteChainSelector, address),
      ),
    ),
  ])
  const { localAcceptsInbound, localAcceptsLegacy } = await readLocalAcceptance(
    input,
    provided.providers,
    remoteLanes,
  )
  return {
    remoteLanes,
    remotePools,
    hookCallers,
    servingPools,
    additionalPoolDataBytes,
    additionalPoolData,
    providerDataRefused: provided.refused,
    localAcceptsInbound,
    localAcceptsLegacy,
  }
}

async function readHookCallers(chain: EVMChain, hooks: readonly string[], blockTag: number) {
  const entries = await Promise.all(
    hooks.map(
      async (hook) =>
        [getAddress(hook), await readAllAuthorizedCallers(chain, hook, { blockTag })] as const,
    ),
  )
  return new Map(entries)
}

/**
 * The pools that call the PCM for the affected tokens: the target pool, and the pool the registry
 * names for each affected token when that pool uses this PCM (the stack audit's same reader).
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
  const { serving } = await readPoolsServingPoolConfigManager(chain, {
    poolConfigManager,
    version,
    tokenAdminRegistry,
    tokens: requests.remoteLanes.map((l) => l.tokenAddress),
    ...(poolAddress !== undefined && { targetPool: poolAddress }),
    blockTag,
  })
  return [...new Set([...(poolAddress ? [getAddress(poolAddress)] : []), ...serving])].sort()
}

/** What each lane's token provider adds to a send, after the write. */
type ProvidedData = {
  /** The provider of each token read, after the write (`null`: none). */
  providers: Map<string, string | null>
  /** Bytes of the data, per lane key, for lanes whose token has a provider. */
  lengths: Map<string, number>
  /** The data (`0x` hex), per lane key. */
  bytes: Map<string, string>
  /** Why the provider refuses to produce data for the lane's token, per lane key. */
  refused: Map<string, string>
}

/** The data each open lane's provider adds to a send, with the providers the write leaves. */
async function readProviderData({
  chain,
  poolConfigManager,
  version,
  blockTag,
  requests,
  providerOverrides,
  storedProviders,
}: ReadMultiTokenPoolGuardFactsInput): Promise<ProvidedData> {
  const out: ProvidedData = {
    providers: new Map(),
    lengths: new Map(),
    bytes: new Map(),
    refused: new Map(),
  }
  const tokens = [...new Set(requests.providerLanes.map((l) => getAddress(l.tokenAddress)))]
  if (!tokens.length) return out
  const stored = tokens.filter((t) => !providerOverrides?.has(t) && !storedProviders?.has(t))
  for (const t of tokens)
    if (!providerOverrides?.has(t) && storedProviders?.has(t))
      out.providers.set(t, storedProviders.get(t) ?? null)
  const configs = stored.length
    ? await poolConfigManagerContract(chain, poolConfigManager, version).getTokenConfigBatch(
        stored,
        { blockTag },
      )
    : []
  stored.forEach((t, i) =>
    out.providers.set(
      t,
      decodeTokenProfileFields(resultToObject(configs[i]!)).additionalPoolDataProvider,
    ),
  )
  for (const t of tokens)
    if (providerOverrides?.has(t)) out.providers.set(t, providerOverrides.get(t) ?? null)
  await Promise.all(
    requests.providerLanes.map(async (lane) => {
      const provider = out.providers.get(getAddress(lane.tokenAddress))
      if (!provider) return
      const key = guardLaneKey(lane)
      // the data a send adds; a provider that refuses the token reverts every send, which the eth_call
      // of the write does not show: a finding, while transport errors propagate
      const read = await readProviderPoolData(
        chain,
        provider,
        lane.tokenAddress,
        lane.remoteChainSelector,
        blockTag,
      )
      if ('refused' in read) {
        out.refused.set(key, read.refused)
        return
      }
      out.lengths.set(key, dataLength(read.data))
      out.bytes.set(key, read.data)
    }),
  )
  return out
}

/** The additional data a lane sends: none on a legacy lane, else its provider's. */
function outboundData(lane: ProjectedMultiTokenPoolLane, provided: ProvidedData): string {
  if (lane.connection.poolDataFormat === 'legacy') return '0x'
  return provided.bytes.get(guardLaneKey(lane)) ?? '0x'
}

/**
 * Whether this token's provider, after the write, accepts what arrives: the data the remote side
 * sends, and the empty data of legacy receive. The destination store runs the same
 * `isAdditionalPoolDataValid` on every receive, empty data included (chainlink-ccip c950d9bc
 * `ConnectionPolicyStore._checkPoolData`). Only for lanes whose token has a provider.
 */
async function readLocalAcceptance(
  { chain, blockTag, requests }: ReadMultiTokenPoolGuardFactsInput,
  providers: ReadonlyMap<string, string | null>,
  remoteLanes: ReadonlyMap<string, MultiTokenPoolRemoteLaneFacts>,
): Promise<{
  localAcceptsInbound: Map<string, boolean>
  localAcceptsLegacy: Map<string, boolean>
}> {
  const localAcceptsInbound = new Map<string, boolean>()
  const localAcceptsLegacy = new Map<string, boolean>()
  const valid = (provider: string, lane: ProjectedMultiTokenPoolLane, data: string) =>
    isDataValid(
      uidProviderContract(chain, provider),
      lane.tokenAddress,
      lane.remoteChainSelector,
      data,
      {
        blockTag,
      },
    )
  await Promise.all(
    requests.remoteLanes.map(async (lane) => {
      const provider = providers.get(getAddress(lane.tokenAddress))
      if (!provider) return
      const key = guardLaneKey(lane)
      const remote = remoteLanes.get(key)
      if (remote?.status === 'known' && remote.remoteSendsData !== undefined)
        localAcceptsInbound.set(key, await valid(provider, lane, remote.remoteSendsData))
      if (lane.connection.remotePools.some((p) => p.allowLegacyPoolData))
        localAcceptsLegacy.set(key, await valid(provider, lane, '0x'))
    }),
  )
  return { localAcceptsInbound, localAcceptsLegacy }
}

/**
 * Resolves the remote chain, or explains why it cannot be read; a `getChain` rejection is kept as the
 * fact's `cause`.
 * @internal
 */
export async function remoteChainOf(
  { getChain }: Pick<ReadMultiTokenPoolGuardFactsInput, 'getChain'>,
  remoteChainSelector: bigint,
): Promise<Chain | { status: 'unknown'; reason: string; cause?: unknown }> {
  const family = laneFamilyOf(remoteChainSelector)
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
  // a getter that cannot serve the chain leaves the side unread: fail closed, as with no getter
  return getChain(remoteChainSelector).catch((err: unknown) => ({
    status: 'unknown' as const,
    reason: `getChain could not serve ${family} chain ${remoteChainSelector}: ${err instanceof Error ? err.message : String(err)}`,
    cause: err,
  }))
}

/**
 * The remote facts an accepted attestation stands for. The reverse mapping needs a read: a legacy lane
 * relies on it and fails closed without one, while a long lane names its source token in the data.
 * @internal
 */
export function attestedRemoteFacts(
  lane: Pick<ProjectedMultiTokenPoolLane, 'connection'>,
  attestation: MultiTokenPoolRemoteAttestation,
): MultiTokenPoolRemoteLaneFacts {
  return {
    status: 'known',
    readsLongData: attestation.acceptsLongPoolData,
    registryPool: attestation.remotePoolAddress,
    mapsBack: lane.connection.poolDataFormat !== 'legacy',
    attestation,
  }
}

/** Checks an attestation against the attestation rules; returns why it is refused, or `undefined`. */
export function attestationRefusal(
  a: MultiTokenPoolRemoteAttestation,
  { now, makesLive }: { now: bigint; makesLive?: boolean },
): string | undefined {
  const family = laneFamilyOf(a.remoteChainSelector)
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
  sends: string,
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
    return attestedRemoteFacts(lane, attestation)
  }
  if (!trusted.length)
    return {
      status: 'missing',
      reason: 'the lane trusts no remote pool, so its remote registry cannot be found',
    }
  if (laneFamilyOf(lane.remoteChainSelector) === ChainFamily.Solana)
    return readSolanaRemoteLane(input, lane, localSelector, servingPools, remote)
  const registry = await locateRemoteRegistry(remote, trusted[0]!)
  if (typeof registry !== 'string') return registry
  const registryPool = await readRegistryPool(remote, registry, remoteToken)
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
  // a remote multi-token pool runs its token's provider on what arrives, and adds its own on a send
  // a remote multi-token pool runs its token's provider on what arrives, and adds its own on a send;
  // any other pool sends legacy data and adds nothing
  const provider =
    readsLongData && remote instanceof EVMChain
      ? await readRemoteMultiTokenPoolSide(remote, registryPool, remoteToken, localSelector, sends)
      : { remoteSendsData: '0x', remoteSendsLegacy: true }
  if (!legacy && !input.readRemoteRateLimits)
    return { status: 'known', readsLongData, registryPool, mapsBack: true, ...provider }
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
    ...provider,
    ...(input.readRemoteRateLimits &&
      back && {
        remoteOutbound: back.outboundRateLimiterState,
        remoteDecimals: (await remote.getTokenInfo(remoteToken)).decimals,
      }),
  }
}

/**
 * `isAdditionalPoolDataValid`, as the receiving store runs it: a revert, or a provider without the
 * function, refuses the receive (`false`); transport errors propagate.
 */
async function isDataValid(
  provider: ReturnType<typeof uidProviderContract>,
  token: string,
  remoteChainSelector: bigint,
  data: string,
  overrides: { blockTag?: number } = {},
): Promise<boolean> {
  return provider
    .isAdditionalPoolDataValid(token, remoteChainSelector, ANY_FINALITY_CONFIG, data, overrides)
    .catch((err: unknown) => {
      if (isMissingFunction(err)) return false
      throw err
    })
}

/**
 * What a remote multi-token pool sends toward this chain and accepts from it: its lane's format, and
 * its token's provider's verdict on the data this lane sends and the data it adds. No provider
 * accepts anything and adds nothing. A remote the SDK cannot resolve (another variant, an unknown
 * version) leaves it unread. Shared with the Solana lane check (UID pairing toward an EVM MTTP).
 * @internal
 */
export async function readRemoteMultiTokenPoolSide(
  remote: EVMChain,
  remotePool: string,
  remoteToken: string,
  localSelector: bigint,
  sends: string,
): Promise<
  Pick<
    Extract<MultiTokenPoolRemoteLaneFacts, { status: 'known' }>,
    | 'remoteAcceptsOutbound'
    | 'remoteSendsData'
    | 'remoteProviderRefused'
    | 'remoteSendsLegacy'
    | 'remoteSideUnread'
    | 'remoteHasHook'
    | 'remoteDestGasOverhead'
  >
> {
  const resolved = await resolveMultiTokenPool(remote, remotePool).catch((err: unknown) => {
    if (
      err instanceof CCTContractTypeInvalidError ||
      err instanceof CCTContractVersionUnsupportedError
    )
      return err
    throw err
  })
  if (resolved instanceof Error)
    return {
      remoteSideUnread: `the SDK cannot read remote pool ${remotePool}: ${resolved.message}`,
    }
  const { version } = resolved
  const pcmAddress = await readPoolConfigManagerAddress(remote, remotePool, version)
  if (pcmAddress === undefined)
    return { remoteSideUnread: `remote pool ${remotePool} reports no PoolConfigManager` }
  const pcm = poolConfigManagerContract(remote, pcmAddress, version)
  const back = toAbiLaneKey({ tokenAddress: remoteToken, remoteChainSelector: localSelector })
  const [[config], [connection], [hooks], [fee]] = await Promise.all([
    pcm.getTokenConfigBatch([remoteToken]),
    pcm.getLaneConnectionBatch([back]),
    pcm.getLaneVerificationBatch([back], ANY_FINALITY_CONFIG).then((r) => r[0] as Result),
    pcm.getTokenTransferFeeConfigBatch([back]),
  ])
  // the remote lane back's hook runs in the remote release, under this lane's destGasOverhead; its
  // destGasOverhead carries the local hook in the local release (A26)
  const remoteHasHook = nullableAddress(String(resultToObject(hooks!))) !== null
  const backFee = toTokenTransferFeeConfig(resultToObject(fee!))
  const gas = {
    remoteHasHook,
    ...(backFee.isEnabled && { remoteDestGasOverhead: backFee.destGasOverhead }),
  }
  const remoteSendsLegacy =
    decodeLaneConnection(resultToObject(connection!), String).poolDataFormat === 'legacy'
  const provider = decodeTokenProfileFields(resultToObject(config!)).additionalPoolDataProvider
  if (!provider) return { remoteSendsData: '0x', remoteSendsLegacy, ...gas }
  const [remoteAcceptsOutbound, adds] = await Promise.all([
    isDataValid(uidProviderContract(remote, provider), remoteToken, localSelector, sends),
    readProviderPoolData(remote, provider, remoteToken, localSelector),
  ])
  return {
    remoteAcceptsOutbound,
    remoteSendsLegacy,
    ...gas,
    ...('refused' in adds
      ? {
          remoteProviderRefused: `the remote provider refuses to produce data for its token (${adds.refused})`,
        }
      : { remoteSendsData: remoteSendsLegacy ? '0x' : adds.data }),
  }
}

/** Whether the remote token has code (EVM remotes; other families do not say). */
async function remoteTokenHasCode(remote: Chain, token: string): Promise<boolean | undefined> {
  if (!(remote instanceof EVMChain)) return undefined
  return (await remote.provider.getCode(token)) !== '0x'
}

/**
 * The remote registry, found from a lane's first trusted pool. An address that does not answer as a
 * CCIP pool leaves the remote side unlocated: a `'missing'` fact naming the fix (fail closed).
 * Transport errors propagate. Shared with the Solana lane check.
 * @internal
 */
export async function locateRemoteRegistry(
  remote: Pick<Chain, 'getTokenAdminRegistryFor'>,
  firstTrustedPool: string,
): Promise<string | { status: 'missing'; reason: string }> {
  const registry = await remote.getTokenAdminRegistryFor(firstTrustedPool).catch((err: unknown) => {
    if (isNotCcipContract(err) || err instanceof CCIPContractNotRouterError) return undefined
    throw err
  })
  return (
    registry ?? {
      status: 'missing',
      reason: `the lane's first trusted remote pool ${firstTrustedPool} does not answer as a CCIP pool on the remote chain, so the remote registry cannot be found from it: trust the remote token's pool`,
    }
  )
}

async function readRemotePool(
  input: ReadMultiTokenPoolGuardFactsInput,
  remoteChainSelector: bigint,
  address: string,
): Promise<MultiTokenPoolRemotePoolFacts> {
  const remote = await remoteChainOf(input, remoteChainSelector)
  if ('status' in remote) return remote
  if (laneFamilyOf(remoteChainSelector) === ChainFamily.Solana) {
    const { readSolanaRemotePoolFacts } = await import('../../solana/pool-group/remote-lane.ts')
    // the Solana reader keys the lane by its remote: this (EVM) chain
    return readSolanaRemotePoolFacts(remote, {
      remoteChainSelector: input.chain.network.chainSelector,
      poolAddress: address,
    })
  }
  // a pool that reports no (or an unparseable) typeAndVersion is not a multi-token pool
  const type = (await readContractTypeOrNull(remote, address)) ?? ''
  return { status: 'known', isMultiTokenPool: reportsMultiTokenPool(type) }
}

/**
 * The remote side of a lane to Solana, from the pool-groups reader (loaded on first use, so EVM-only
 * callers never load the Solana stack), mapped to the facts the rules read.
 *
 * The pool compares stored bytes exactly. The v2 OnRamp sends the source token and pool as
 * `abi.encode(address)`, 32 bytes (chainlink-ccip c950d9bc `OnRamp.sol:776`, `MessageV1Codec.sol:115`).
 * The Solana OffRamp passes the token on as sent, so the lane back stores it as those 32 bytes; it
 * trims the pool to this chain's `legacy_address_length` before the pool sees it (chainlink-ccip-solana
 * 7558722 `ccip-offramp/.../token_transfer.rs:301`, `normalized_address`), which the reader returns as
 * `sourcePoolAddressLength`: the lane back stores the pool as those trailing bytes. Either form wrong
 * refuses every transfer, though both are equal once checksummed. A length the reader could not read
 * leaves the mapping unjudged: an `'unknown'` fact, never an assumed 20.
 */
async function readSolanaRemoteLane(
  input: ReadMultiTokenPoolGuardFactsInput,
  lane: ProjectedMultiTokenPoolLane,
  localSelector: bigint,
  servingPools: readonly string[],
  remote: Chain,
): Promise<MultiTokenPoolRemoteLaneFacts> {
  const { readSolanaRemoteLaneFacts } = await import('../../solana/pool-group/remote-lane.ts')
  const facts = await readSolanaRemoteLaneFacts(remote, {
    // the Solana lane's remote is this chain: never the Solana selector
    remoteChainSelector: localSelector,
    mint: lane.connection.remoteToken!,
    trustedPools: lane.connection.remotePools.map((p) => p.address),
    ...(input.readRemoteRateLimits && { readRateLimits: true }),
  })
  if (facts.status !== 'known') return facts
  const { back } = facts
  const legacy = lane.connection.poolDataFormat === 'legacy'
  const length = facts.sourcePoolAddressLength
  if (back && (length === null || length === undefined || length < 20 || length > 32))
    return {
      status: 'unknown',
      reason: `the Solana OffRamp's address length for this chain could not be read (${String(length)}), so the bytes the remote lane back must store for the serving pool are unknown`,
    }
  // the trailing `length` bytes of the 32-byte word the OnRamp sends (read; unused without a lane back)
  const kept = typeof length === 'number' ? length : 32
  const trimmed = (address: string) => `0x${abiWord(address).slice(2 + (32 - kept) * 2)}`
  let mapsBackReason: string | undefined
  if (!back)
    mapsBackReason = `the remote pool ${facts.registryPool} has no lane back toward this chain: inbound transfers revert there`
  else if (back.remoteTokenRaw.toLowerCase() !== abiWord(lane.tokenAddress))
    mapsBackReason = `the remote lane back stores the token as ${back.remoteTokenRaw}, but this chain sends ${abiWord(lane.tokenAddress)} (abi.encode of ${getAddress(lane.tokenAddress)}): the program compares the bytes, so every transfer reverts (SourceTokenMismatch); store the 32-byte form`
  else {
    const serving = back.remotePools.filter((p) => servingPools.includes(getAddress(p.address)))
    const exact = serving.filter((p) => p.raw.toLowerCase() === trimmed(p.address))
    if (!serving.length)
      mapsBackReason = `the remote lane back trusts none of the pools serving this token here (${servingPools.join(', ')}): inbound transfers revert there`
    else if (!exact.length)
      mapsBackReason = `the remote lane back stores the serving pool as ${serving.map((p) => p.raw).join(', ')}, but the OffRamp hands the pool the trailing ${length} bytes of the 32-byte form this chain sends: the pool compares the bytes, so every transfer reverts; store the ${length}-byte form`
    else if (legacy && !exact.some((p) => p.allowLegacyPoolData))
      mapsBackReason =
        'the lane sends legacy pool data, but the remote lane back accepts legacy data from none of the serving pools (a long or UID lane, or a policy pool without allow_legacy_pool_data): every transfer reverts there'
  }
  return {
    status: 'known',
    readsLongData: facts.readsLongData,
    registryPool: facts.registryPool,
    mapsBack: mapsBackReason === undefined,
    ...(mapsBackReason !== undefined && { mapsBackReason }),
    ...(back?.failsClosed !== undefined && { failsClosed: back.failsClosed }),
    // the lane back sends legacy data, or long data with its UID as the additional data
    // (chainlink-ccip-solana 7558722 base-token-pool/src/pool_data.rs:121 encode_long_for_mint)
    remoteSendsLegacy: facts.poolDataFormat !== 'long',
    remoteSendsData: facts.poolDataFormat === 'long' ? (facts.uid ?? '0x') : '0x',
    ...(back?.admitted !== undefined && { admitted: back.admitted }),
    ...(facts.uid !== undefined && { uid: facts.uid }),
    ...(input.readRemoteRateLimits &&
      back &&
      (back.outboundRateLimiterState !== undefined
        ? { remoteOutbound: back.outboundRateLimiterState, remoteDecimals: back.remoteDecimals }
        : { remoteOutboundUnknownReason: 'the remote reader returned no outbound bucket' })),
  }
}
