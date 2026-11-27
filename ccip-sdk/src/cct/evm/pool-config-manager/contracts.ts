/**
 * PoolConfigManager (PCM) domain: the "pool or PCM" target every PCM op takes, its validation and
 * resolution, and the typed PCM handle reads decode through.
 *
 * @packageDocumentation
 */

import {
  type Interface,
  type LogDescription,
  ZeroAddress,
  ZeroHash,
  decodeBytes32String,
  encodeBytes32String,
  getAddress,
  hexlify,
  isBytesLike,
  isHexString,
} from 'ethers'

import type { TransferDirection } from '../../../chain.ts'
import type { EVMChain } from '../../../evm/index.ts'
import {
  type PoolConfigManagerStores,
  decodeLaneConnection,
  decodePoolConfigManagerStaticConfig,
  decodeTokenProfileFields,
} from '../../../evm/multi-token-pool.ts'
import { resultToObject } from '../../../evm/types.ts'
import type { FinalityAllowed } from '../../../extra-args.ts'
import { CCTDataDecodeError, CCTParamsInvalidError } from '../../errors.ts'
import type {
  MultiTokenPoolInlineRemotePoolDrop,
  MultiTokenPoolLaneKey,
} from '../../multi-token-pool.ts'
import {
  type LockOrBurnFlavor,
  type MultiTokenPoolVersion,
  LOCK_OR_BURN_FLAVORS,
  POOL_CONFIG_MANAGER_TYPE,
  findDeploymentBlock,
  multiTokenPoolContract,
  poolConfigManagerContract,
  resolveMultiTokenPool,
  resolveMultiTokenPoolContract,
} from '../multi-token-pool/contracts.ts'
import {
  validateAddress,
  validateArray,
  validateExactlyOneTarget,
  validateUint32,
  validateUint64,
} from '../validate.ts'

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
  validateExactlyOneTarget(operation, target, 'poolAddress', 'poolConfigManager')
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

/** Pages a paged read follows before it gives up (2,000,000 items at the default size). */
const MAX_PAGES = 10_000

/** Default page size of the paged PCM views (`getAllConfiguredTokens`, `getSubsetTokens`). */
export const PAGE_SIZE = 200

/**
 * Reads every page of a paged view at one block, until a page comes back short: the paged sets are
 * swap-removed, so pages read at different blocks can skip or repeat items.
 * @param fetch - Reads one page: `start` offset, `count` items, at `blockTag`.
 * @internal
 */
export async function readPagesAtBlock<T>(
  chain: EVMChain,
  fetch: (start: bigint, count: bigint, blockTag: number) => Promise<T[]>,
  { blockTag, pageSize = PAGE_SIZE }: { blockTag?: number; pageSize?: number } = {},
): Promise<{ items: T[]; blockNumber: number }> {
  if (!Number.isInteger(pageSize) || pageSize < 1)
    throw new CCTParamsInvalidError(
      'readPagesAtBlock',
      'pageSize',
      'must be an integer of at least 1',
    )
  const blockNumber = blockTag ?? (await chain.provider.getBlockNumber())
  const items: T[] = []
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    const page = await fetch(BigInt(items.length), BigInt(pageSize), blockNumber)
    items.push(...page)
    if (page.length < pageSize) return { items, blockNumber }
  }
  // a contract that ignores the offset returns full pages forever
  throw new CCTDataDecodeError(String(blockNumber), {
    context: {
      reason: `a paged view returned ${MAX_PAGES} full pages of ${pageSize}; it ignores the offset`,
    },
  })
}

/**
 * Every token the PCM registers, every page at one block.
 * @internal
 */
export async function readConfiguredTokens(
  chain: EVMChain,
  address: string,
  version: MultiTokenPoolVersion,
  opts: { blockTag?: number; pageSize?: number } = {},
): Promise<{ tokens: string[]; blockNumber: number }> {
  const pcm = poolConfigManagerContract(chain, address, version)
  const { items, blockNumber } = await readPagesAtBlock(
    chain,
    async (start, count, blockTag) =>
      (await pcm.getAllConfiguredTokens(start, count, { blockTag })).map((t) =>
        getAddress(resultToObject(t)),
      ),
    opts,
  )
  return { tokens: items, blockNumber }
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
  const topics = events.map((e) => {
    const event = iface.getEvent(e)
    if (!event)
      throw new CCTParamsInvalidError(operation, 'events', `${contract} declares no event ${e}`)
    return event.topicHash
  })
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

/**
 * A policy name: 1 to 31 printable ASCII bytes, encoded as left-aligned, NUL-padded `bytes32` (not
 * keccak), as the dcf operator scripts encode it; or a raw `bytes32` written as `0x` plus 64 hex
 * digits, so a name another tool wrote (including a full 32-byte one) can be addressed. Reads return
 * a NUL-terminated printable name as text and anything else as raw hex, and either form can be
 * passed back.
 */
export type PolicyName = string

const PRINTABLE = /^[\x20-\x7e]+$/

/**
 * Validates a policy record key (`{ policyName, remoteChainSelector }`) at `at`, before any RPC, and
 * returns its canonical key (`<policy word>:<chain>`, as the projection's `recordKey`).
 * @throws {@link CCTParamsInvalidError} if the name is invalid, the selector is not a uint64, or it
 *   is `0` for a type with no default record (`ZeroChainSelectorNotAllowed`)
 * @internal
 */
export function validatePolicyRecordKey(
  operation: string,
  at: string,
  key: unknown,
  { allowDefault = true }: { allowDefault?: boolean } = {},
): string {
  const { policyName, remoteChainSelector } = (key ?? {}) as Record<string, unknown>
  const word = encodePolicyName(operation, `${at}.policyName`, policyName)
  validateUint64(operation, `${at}.remoteChainSelector`, remoteChainSelector)
  if (!allowDefault && remoteChainSelector === 0n)
    throw new CCTParamsInvalidError(
      operation,
      `${at}.remoteChainSelector`,
      'is 0: this record type has no default record; give a remote chain (ZeroChainSelectorNotAllowed)',
    )
  return `${word.toLowerCase()}:${String(remoteChainSelector)}`
}

/**
 * Encodes a {@link PolicyName} to its `bytes32`.
 * @throws {@link CCTParamsInvalidError} if the name is empty, longer than 31 bytes, not printable
 * ASCII, or the zero `bytes32` (which means "no policy")
 * @internal
 */
export function encodePolicyName(operation: string, param: string, name: unknown): string {
  if (typeof name !== 'string' || !name.length)
    throw new CCTParamsInvalidError(operation, param, 'must be a non-empty policy name')
  if (name.length === 66 && isHexString(name, 32)) {
    if (name.toLowerCase() === ZeroHash)
      throw new CCTParamsInvalidError(
        operation,
        param,
        'the zero bytes32 means "no policy"; pass null to clear an assignment',
      )
    return name.toLowerCase()
  }
  if (!PRINTABLE.test(name) || name.length > 31)
    throw new CCTParamsInvalidError(
      operation,
      param,
      'must be 1 to 31 printable ASCII characters, or a raw bytes32 as 0x plus 64 hex digits (write a full 32-byte name as hex)',
    )
  return encodeBytes32String(name)
}

/**
 * Decodes a stored policy `bytes32`: `null` for the zero value (no policy), text for a printable
 * left-aligned name, else the raw hex.
 * @internal
 */
export function decodePolicyName(value: string): PolicyName | null {
  if (value.toLowerCase() === ZeroHash) return null
  try {
    const text = decodeBytes32String(value)
    // round-trips only when the name is the whole word (no bytes after the first NUL)
    if (PRINTABLE.test(text) && encodeBytes32String(text) === value.toLowerCase()) return text
  } catch {
    // not NUL-terminated UTF-8: a raw id
  }
  return value.toLowerCase()
}

/**
 * A policy word as a name, where the word always names a policy (a record key, a decoded write):
 * {@link decodePolicyName}, with the zero word kept as it is rather than read as "unassigned".
 * @internal
 */
export function policyNameOf(word: string): PolicyName {
  return decodePolicyName(word) ?? word
}

/** A lane key plus the directions that apply to it (`goingLive`, `confirmOpening`). */
export type MultiTokenPoolLaneDirections = MultiTokenPoolLaneKey & {
  /** The directions. */
  directions: TransferDirection[]
}

// the family-neutral lane key and drop confirmation (both families' guards); re-exported so
// importers keep their path
export type { MultiTokenPoolInlineRemotePoolDrop, MultiTokenPoolLaneKey }
export { DROPPABLE_REMOTE_POOL_FLAGS } from '../../multi-token-pool.ts'

/** Lanes or tokens per PCM batch view call (every batch view chunks by it). */
export const LANE_BATCH_SIZE = 100

/**
 * Validates a list of {@link MultiTokenPoolLaneKey}s, non-empty unless `minLength` is 0.
 * @throws {@link CCTParamsInvalidError} naming the first invalid entry
 * @internal
 */
export function validateLaneKeys(
  operation: string,
  param: string,
  lanes: unknown,
  minLength = 1,
): asserts lanes is MultiTokenPoolLaneKey[] {
  validateArray(operation, param, lanes, minLength)
  Array.from(lanes, (lane, i) => {
    const { tokenAddress, remoteChainSelector } = (lane ?? {}) as Record<string, unknown>
    validateAddress(operation, `${param}[${i}].tokenAddress`, tokenAddress)
    validateUint64(operation, `${param}[${i}].remoteChainSelector`, remoteChainSelector)
  })
}

/** A lane key in the PCM's `LaneKey` ABI shape. */
export function toAbiLaneKey({ tokenAddress, remoteChainSelector }: MultiTokenPoolLaneKey) {
  return { localToken: tokenAddress, remoteChainSelector }
}

/**
 * Asserts a view returned one result per lane.
 * @throws {@link CCTDataDecodeError} if it did not (a contract this SDK does not know)
 * @internal
 */
export function assertResultCount(
  address: string,
  view: string,
  results: { length: number },
  lanes: number,
): void {
  if (results.length !== lanes)
    throw new CCTDataDecodeError(address, {
      context: { reason: `${view} returned ${results.length} results for ${lanes} lanes` },
    })
}

/**
 * Runs a PCM batch view over `lanes` in chunks of {@link LANE_BATCH_SIZE}, in parallel, and joins
 * the per-lane results in input order.
 * @internal
 */
export function readLaneBatches<R>(
  lanes: readonly MultiTokenPoolLaneKey[],
  read: (chunk: MultiTokenPoolLaneKey[]) => Promise<R[]>,
): Promise<R[]> {
  return readInBatches(lanes, read, { batchSize: LANE_BATCH_SIZE })
}

/** The TokenAdminRegistry and the three stores a PCM was deployed with. */
export type PoolConfigManagerStaticConfig = PoolConfigManagerStores

/**
 * Reads a PCM's `getStaticConfig()`.
 * @internal
 */
export async function readPoolConfigManagerStaticConfig(
  chain: EVMChain,
  address: string,
  version: MultiTokenPoolVersion,
  { blockTag }: { blockTag?: number } = {},
): Promise<PoolConfigManagerStaticConfig> {
  // positional: abitype types the four outputs as a tuple; the runtime Result also has names
  return decodePoolConfigManagerStaticConfig(
    await poolConfigManagerContract(chain, address, version).getStaticConfig(
      blockTag === undefined ? {} : { blockTag },
    ),
  )
}

/** The PCM handle the batch and policy readers get. @internal */
export type PoolConfigManagerReader = ReturnType<typeof poolConfigManagerContract>

/**
 * The global pause flag and each chain's pause flags, from one zero-token lane read per chain (the
 * global flag rides on every lane; selector `0` answers it when no chain is given).
 * @internal
 */
export async function readChainPauseFlags(
  pcm: PoolConfigManagerReader,
  address: string,
  selectors: readonly bigint[],
  blockTag: number,
): Promise<{
  global: boolean
  chains: { remoteChainSelector: bigint; outbound: boolean; inbound: boolean }[]
}> {
  const lanes = (selectors.length ? selectors : [0n]).map((remoteChainSelector) => ({
    tokenAddress: ZeroAddress,
    remoteChainSelector,
  }))
  const flags = await readLaneBatches(lanes, async (chunk) => {
    const read = (await pcm.getLaneConnectionBatch(chunk.map(toAbiLaneKey), { blockTag })).map(
      (c) => decodeLaneConnection(resultToObject(c), String),
    )
    assertResultCount(address, 'getLaneConnectionBatch', read, chunk.length)
    return read
  })
  return {
    global: flags.some((f) => f.isGloballyPaused),
    chains: selectors.map((remoteChainSelector, i) => ({
      remoteChainSelector,
      outbound: flags[i]!.isChainOutboundPaused,
      inbound: flags[i]!.isChainInboundPaused,
    })),
  }
}

/**
 * Decodes an on-chain enum value through its SDK tuple (index = on-chain value).
 * @throws {@link CCTDataDecodeError} if the value is out of range (a contract this SDK does not know)
 * @internal
 */
export function decodeEnum<const T extends readonly string[]>(
  table: T,
  value: bigint | number,
  what: string,
  address: string,
): T[number] {
  const decoded = table[Number(value)]
  if (decoded === undefined)
    throw new CCTDataDecodeError(address, {
      context: { reason: `${what} ${String(value)} is not one of ${table.join(', ')}` },
    })
  return decoded
}

/** A token's profile fields, as the PCM and its connection store keep them. */
export type MultiTokenPoolTokenProfileFields = {
  /** The token. */
  tokenAddress: string
  /** Whether the token is registered now; a deregistered profile keeps its last values. */
  isRegistered: boolean
  /** Decimals the pool uses for amounts and remote pool data; immutable while registered. */
  localDecimals: number
  /** How the pool takes tokens on send. */
  lockOrBurnFlavor: LockOrBurnFlavor
  /** Faster-than-finality the token allows, on every chain. */
  allowedFinality: FinalityAllowed
  /** Burn sink (`'burn-to-address'`) or lockbox (`'lock'`); `null` for the other flavors. */
  lockOrBurnAddress: string | null
  /** Additional pool data provider (e.g. a factory UID provider), or `null`. */
  additionalPoolDataProvider: string | null
}

/**
 * Decodes the profile fields a `TokenConfig` and a `TokenProfile` share.
 * @internal
 */
export function decodeTokenProfile(
  tokenAddress: string,
  raw: {
    isRegistered: boolean
    localDecimals: bigint | number
    lockOrBurnFlavor: bigint | number
    allowedFinalityConfig: string
    lockOrBurnAddress: string
    additionalPoolDataProvider: string
  },
  source: string,
): MultiTokenPoolTokenProfileFields {
  const fields = decodeTokenProfileFields(raw)
  return {
    tokenAddress,
    isRegistered: raw.isRegistered,
    ...fields,
    lockOrBurnFlavor: decodeEnum(
      LOCK_OR_BURN_FLAVORS,
      fields.lockOrBurnFlavor,
      'lockOrBurnFlavor',
      source,
    ),
  }
}

/**
 * Refuses a provider address with no code at `blockTag`, as the stores do (`ProviderHasNoCode`).
 * @throws {@link CCTParamsInvalidError} at `param` if the address has no code
 * @internal
 */
export async function assertProviderHasCode(
  operation: string,
  chain: EVMChain,
  param: string,
  provider: string,
  blockTag: number,
  fix: string,
  context?: Record<string, unknown>,
): Promise<void> {
  if ((await chain.provider.getCode(provider, blockTag)) !== '0x') return
  throw new CCTParamsInvalidError(
    operation,
    param,
    `${provider} has no code, so the store refuses it (ProviderHasNoCode): ${fix}`,
    context && { context },
  )
}
