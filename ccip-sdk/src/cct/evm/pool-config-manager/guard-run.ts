/**
 * The post-state guard of a lane-affecting PCM write: read the records at one block,
 * project the exact calldata, read the facts, evaluate the rules, simulate the write from `sender`,
 * cross-check the projection with `eth_simulateV1` where the RPC has it, and seal a snapshot.
 *
 * Every lane-affecting op runs it in `buildUnsigned`, and `checkMultiTokenPoolSnapshot` re-runs it on
 * a proposal's calldata, so both paths judge exactly what will execute.
 *
 * @packageDocumentation
 */

import { getAddress, keccak256, toBeHex } from 'ethers'

import type { ChainGetter } from '../../../chain.ts'
import type { EVMChain } from '../../../evm/index.ts'
import { decodeLaneConnection, decodeTokenProfileFields } from '../../../evm/multi-token-pool.ts'
import { resultToObject } from '../../../evm/types.ts'
import { ChainFamily } from '../../../networks.ts'
import { canonicalHash, sealMultiTokenPoolSnapshot } from '../../canonical.ts'
import {
  type CCTStateChange,
  CCTDataDecodeError,
  CCTParamsInvalidError,
  CCTStateChangedError,
} from '../../errors.ts'
import type {
  MultiTokenPoolLaneFinding,
  MultiTokenPoolRemoteAttestation,
  MultiTokenPoolSnapshot,
} from '../../multi-token-pool.ts'
import { decodeRemoteAddress } from '../../remote-address.ts'
import {
  type MultiTokenPoolVersion,
  ANY_FINALITY_CONFIG,
  POOL_CONFIG_MANAGER_TYPE,
  getMultiTokenPoolInterface,
  poolConfigManagerContract,
} from '../multi-token-pool/contracts.ts'
import { simulateEVMTx } from '../simulate.ts'
import { toTokenTransferFeeConfig } from '../token-pool/contracts.ts'
import { type DecodedMultiTokenPoolWrite, decodeMultiTokenPoolWrite } from './calldata.ts'
import { type MultiTokenPoolLaneKey, toAbiLaneKey } from './contracts.ts'
import { type AbiRateLimits, decodeRateLimits } from './decode.ts'
import { readMultiTokenPoolGuardFacts } from './guard-facts.ts'
import {
  type MultiTokenPoolGuardFacts,
  type MultiTokenPoolGuardOptions,
  type MultiTokenPoolLaneDirections,
  evaluateMultiTokenPoolGuards,
  guardLaneKey,
  multiTokenPoolAffectedLanes,
  multiTokenPoolCandidateLanes,
  multiTokenPoolChainLanes,
  multiTokenPoolLaneTransitions,
  requiredMultiTokenPoolGuardFacts,
} from './guards.ts'
import { decodeLaneRecordLevels } from './operations/get-multi-token-pool-lane-record-levels.ts'
import { decodeLaneVerification } from './operations/get-multi-token-pool-lane-verifications.ts'
import {
  type MultiTokenPoolRecordState,
  type ProjectedMultiTokenPoolLane,
  applyMultiTokenPoolRecordChanges,
  multiTokenPoolChangeChains,
  multiTokenPoolSupportedChains,
  requiredMultiTokenPoolProviderAnswers,
  resolveMultiTokenPoolLanes,
} from './projection.ts'
import { readMultiTokenPoolRecordState, readProviderAnswers } from './record-state.ts'

/** Inputs of {@link runMultiTokenPoolGuards}. @internal */
export type RunMultiTokenPoolGuardsInput = MultiTokenPoolGuardOptions & {
  /** The chain. */
  chain: EVMChain
  /** The SDK op building the write, for errors and the snapshot. */
  operation: string
  /** The PCM. */
  poolConfigManager: string
  /** Its version. */
  version: MultiTokenPoolVersion
  /** The pool the write targets, when known (a serving pool for the hook rule). */
  poolAddress?: string
  /** The exact PCM calldata. */
  data: string
  /** The account that will execute (Safe, timelock or EOA); the write is simulated from it. */
  sender?: string
  /** Values the write keeps, merges or replaces, by dotted path (the op's part of the snapshot). */
  expected?: Record<string, unknown>
  /** The snapshot a previous build returned; refused when anything moved. */
  expectedSnapshot?: MultiTokenPoolSnapshot
  /** Resolves remote chains. */
  getChain?: ChainGetter
  /** Long-data facts for remote families the SDK cannot read. */
  remoteAttestations?: MultiTokenPoolRemoteAttestation[]
  /** `true` for checks that make lanes live (unpauses): attestations are never used. */
  makesLive?: boolean
  /** Block to read at; defaults to the latest block, read once. */
  blockTag?: number
  /** Return error findings in `findings` instead of refusing (the snapshot check reports them). */
  reportFindings?: boolean
  /** The op named in errors, when it is not `operation` (the snapshot check re-runs another op's guard). */
  errorOperation?: string
  /** Extra context every refusal carries (e.g. the `recordType` of a merged op). */
  errorContext?: Record<string, unknown>
}

/** What a guarded write reports (the fields of `MultiTokenPoolUnsignedTx`). @internal */
export type MultiTokenPoolGuardResult = {
  /** The decoded write. */
  decoded: DecodedMultiTokenPoolWrite
  /** Lanes the write changes. */
  affectedLanes: MultiTokenPoolLaneKey[]
  /** Lanes live in a direction after the write that were not live in it before, with those directions. */
  goingLive: MultiTokenPoolLaneDirections[]
  /** Warning findings (errors refuse). */
  warnings: MultiTokenPoolLaneFinding[]
  /** Every finding, errors included (only with `reportFindings`; errors refuse otherwise). */
  findings: MultiTokenPoolLaneFinding[]
  /** `true` when `eth_simulateV1` confirmed the projection; `false` when the RPC lacks it. */
  projectionVerified: boolean
  /** The state the write was judged on. */
  snapshot: MultiTokenPoolSnapshot
  /** The block every read was pinned to. */
  blockNumber: number
}

/**
 * Runs the post-state guard of one PCM write.
 *
 * @throws {@link CCTParamsInvalidError} on an error finding, a remote fact that is missing or
 *   unreadable (param `getChain`), or a write that reverts when simulated from `sender`
 * @throws {@link CCTStateChangedError} if `expectedSnapshot` no longer holds
 * @throws {@link CCTDataDecodeError} if `eth_simulateV1` disagrees with the projection (an SDK bug)
 * @internal
 */
export async function runMultiTokenPoolGuards(
  input: RunMultiTokenPoolGuardsInput,
): Promise<MultiTokenPoolGuardResult> {
  const { chain, operation, poolConfigManager, version, data, sender } = input
  const errorOperation = input.errorOperation ?? operation
  const decoded = decodeMultiTokenPoolWrite(data, version)
  const blockNumber = input.blockTag ?? (await chain.provider.getBlockNumber())
  const {
    state: before,
    staticConfig: { tokenAdminRegistry },
  } = await readMultiTokenPoolRecordState(chain, poolConfigManager, version, {
    blockTag: blockNumber,
    // chains the write names may have no record yet, and can already be paused
    extraChains: multiTokenPoolChangeChains(decoded.changes),
  })
  const after = applyMultiTokenPoolRecordChanges(before, decoded.changes)
  // both sides need provider answers for every lane they resolve from a policy
  const candidates = multiTokenPoolCandidateLanes(before, after)
  await fillProviderAnswers(chain, before, candidates, blockNumber)
  await fillProviderAnswers(chain, after, candidates, blockNumber)

  // a profile write changes no record, but what a token's lanes send and accept: its open lanes are
  // judged again, with the provider the write leaves
  const profiles = await profileChanges(input, decoded, blockNumber)
  const lanes = [
    ...multiTokenPoolAffectedLanes(before, after),
    ...profileLanes(before, after, profiles.changedTokens),
  ].filter(
    (l, i, all) => all.findIndex((o) => guardLaneKey(o.after) === guardLaneKey(l.after)) === i,
  )
  const afterLanes = lanes.map((l) => l.after)
  const facts = await readMultiTokenPoolGuardFacts({
    chain,
    poolConfigManager,
    version,
    tokenAdminRegistry,
    blockTag: blockNumber,
    ...(input.poolAddress && { poolAddress: input.poolAddress }),
    requests: requiredMultiTokenPoolGuardFacts(afterLanes),
    ...(input.getChain && { getChain: input.getChain }),
    ...(input.remoteAttestations && { remoteAttestations: input.remoteAttestations }),
    now: BigInt(Math.floor(Date.now() / 1000)),
    ...(input.makesLive && { makesLive: true }),
    ...(profiles.providers.size && { providerOverrides: profiles.providers }),
  })
  const chainLanes = multiTokenPoolChainLanes(after, [
    ...new Set(afterLanes.map((l) => l.remoteChainSelector)),
  ])
  const { findings, factFailures } = evaluateMultiTokenPoolGuards({
    after,
    lanes,
    chainLanes,
    facts,
    options: input,
  })

  if (factFailures.length) {
    const unknown = factFailures.some((f) => f.status === 'unknown')
    const cause = factFailures.find((f) => f.cause !== undefined)?.cause
    throw new CCTParamsInvalidError(
      errorOperation,
      unknown ? 'getChain' : 'remoteSide',
      `cannot check ${factFailures.length} affected lane(s), and a guard never passes on a fact it could not read: ${factFailures
        .map((f) => `${f.tokenAddress} → ${f.remoteChainSelector}: ${f.reason}`)
        .join('; ')}`,
      {
        context: { ...input.errorContext, factFailures },
        // the first underlying error, so `err.cause` tells a missing RPC from a transient failure
        ...(cause instanceof Error && { cause }),
      },
    )
  }
  // a lane the write opens beyond the caller's planned set is refused (when the caller gives one)
  const { opened, goingLive } = multiTokenPoolLaneTransitions(lanes)
  if (input.confirmOpening) {
    const allowed = new Map(
      input.confirmOpening.map((l) => [guardLaneKey(l), new Set(l.directions)]),
    )
    const extra = opened
      .map((l) => ({
        ...l,
        directions: l.directions.filter((d) => !allowed.get(guardLaneKey(l))?.has(d)),
      }))
      .filter((l) => l.directions.length)
    if (extra.length)
      throw new CCTParamsInvalidError(
        errorOperation,
        'confirmOpening',
        `the write opens ${extra.length} lane(s) in directions not listed: ${extra
          .map((l) => `${l.tokenAddress} → ${l.remoteChainSelector} (${l.directions.join(', ')})`)
          .join(
            '; ',
          )}; a record another operator wrote can make it open more than planned. List them, or rebuild after checking`,
        { context: { ...input.errorContext, extra } },
      )
  }
  const errors = findings.filter((f) => f.severity === 'error')
  if (errors.length && !input.reportFindings)
    throw new CCTParamsInvalidError(
      errorOperation,
      'guards',
      `the write would leave ${errors.length} problem(s) on the lanes it changes: ${errors
        .map((f) => `${f.check} on ${f.tokenAddress} → ${f.remoteChainSelector}: ${f.reason}`)
        .join('; ')}`,
      { context: { ...input.errorContext, findings: errors } },
    )

  // the write itself, from the account that will execute it
  if (sender) {
    const sim = await simulateEVMTx(
      chain,
      { family: ChainFamily.EVM, transactions: [{ to: poolConfigManager, data, from: sender }] },
      { from: sender, blockTag: blockNumber },
    )
    if (!sim.success)
      throw new CCTParamsInvalidError(
        errorOperation,
        'sender',
        `the write reverts when ${sender} executes it: ${sim.errorName ?? sim.revertData}`,
        {
          context: {
            ...input.errorContext,
            errorName: sim.errorName,
            errorArgs: sim.errorArgs,
            revertData: sim.revertData,
          },
        },
      )
  }
  const projectionVerified = sender
    ? await crossCheckWithSimulateV1(chain, { ...input, sender }, afterLanes, blockNumber)
    : false

  const guardInputsHash = hashGuardInputs(lanes, chainLanes, facts)
  // the thresholds and confirmations the write was judged with travel in the snapshot, under its
  // hash, so a re-check of the proposal applies the same ones
  const expected = {
    ...input.expected,
    [GUARD_OPTIONS_PATH]: guardOptionsOf(input),
    // the target pool is a serving pool the guard counted; a re-check of the proposal, which sees only
    // the PCM, needs the same one
    ...(input.poolAddress !== undefined && { [GUARD_POOL_PATH]: getAddress(input.poolAddress) }),
  }
  if (input.expectedSnapshot)
    assertSnapshotHolds(operation, input.expectedSnapshot, {
      calldataHash: keccak256(data),
      guardInputsHash,
      expected,
    })
  const snapshot = sealMultiTokenPoolSnapshot({
    observedAt: BigInt(blockNumber),
    operation,
    expected,
    guardInputsHash,
    calldataHash: keccak256(data),
  })
  return {
    decoded,
    affectedLanes: afterLanes.map(({ tokenAddress, remoteChainSelector }) => ({
      tokenAddress,
      remoteChainSelector,
    })),
    goingLive,
    warnings: findings.filter((f) => f.severity === 'warning'),
    findings,
    projectionVerified,
    snapshot,
    blockNumber,
  }
}

async function fillProviderAnswers(
  chain: EVMChain,
  state: MultiTokenPoolRecordState,
  lanes: readonly MultiTokenPoolLaneKey[],
  blockTag: number,
): Promise<void> {
  const queries = requiredMultiTokenPoolProviderAnswers(state, lanes)
  if (queries.length)
    state.providerAnswers.push(...(await readProviderAnswers(chain, queries, blockTag)))
}

/** The `expected` path the guard options are sealed under. @internal */
export const GUARD_OPTIONS_PATH = 'guard.options'
/** The `expected` path the target pool is sealed under. @internal */
export const GUARD_POOL_PATH = 'guard.poolAddress'

/** The guard options a write was judged with, defaults dropped, in a stable shape. @internal */
export function guardOptionsOf(o: MultiTokenPoolGuardOptions): MultiTokenPoolGuardOptions {
  return {
    ...(o.allowDroppingDefaultCCVs && { allowDroppingDefaultCCVs: true }),
    ...(o.maxTransferFeeBps !== undefined && { maxTransferFeeBps: o.maxTransferFeeBps }),
    ...(o.minDestGasOverhead !== undefined && { minDestGasOverhead: o.minDestGasOverhead }),
    ...(o.confirmClosing?.length && {
      confirmClosing: [...o.confirmClosing]
        .map(({ tokenAddress, remoteChainSelector }) => ({
          tokenAddress: getAddress(tokenAddress),
          remoteChainSelector,
        }))
        .sort((a, b) => guardLaneKey(a).localeCompare(guardLaneKey(b))),
    }),
    ...(o.confirmOpening && {
      confirmOpening: [...o.confirmOpening]
        .map(({ tokenAddress, remoteChainSelector, directions }) => ({
          tokenAddress: getAddress(tokenAddress),
          remoteChainSelector,
          directions: [...new Set(directions)].sort(),
        }))
        .sort((a, b) => guardLaneKey(a).localeCompare(guardLaneKey(b))),
    }),
    ...(o.migrationWindowChains?.length && {
      migrationWindowChains: [...o.migrationWindowChains].sort((a, b) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    }),
  }
}

/**
 * The tokens a profile write changes (a field other than the pauses differs from the stored profile),
 * and the provider each set profile leaves.
 */
async function profileChanges(
  { chain, poolConfigManager, version }: RunMultiTokenPoolGuardsInput,
  decoded: DecodedMultiTokenPoolWrite,
  blockTag: number,
): Promise<{ changedTokens: Set<string>; providers: Map<string, string | null> }> {
  const set = decoded.profiles?.set ?? []
  const providers = new Map(set.map((p) => [p.tokenAddress, p.additionalPoolDataProvider]))
  if (!set.length) return { changedTokens: new Set(), providers }
  const configs = await poolConfigManagerContract(
    chain,
    poolConfigManager,
    version,
  ).getTokenConfigBatch(
    set.map((p) => p.tokenAddress),
    { blockTag },
  )
  const changedTokens = new Set(
    set
      .filter((p, i) => {
        const raw = resultToObject(configs[i]!)
        if (!raw.isRegistered) return true
        const { tokenAddress: _, ...next } = p
        return canonicalHash([next]) !== canonicalHash([decodeTokenProfileFields(raw)])
      })
      .map((p) => p.tokenAddress),
  )
  return { changedTokens, providers }
}

/** The open lanes of `tokens`, unchanged in their records, for a re-check after a profile write. */
function profileLanes(
  before: MultiTokenPoolRecordState,
  after: MultiTokenPoolRecordState,
  tokens: ReadonlySet<string>,
): { before: ProjectedMultiTokenPoolLane; after: ProjectedMultiTokenPoolLane }[] {
  const keys = [...tokens].flatMap((tokenAddress) =>
    multiTokenPoolSupportedChains(after, tokenAddress).map((remoteChainSelector) => ({
      tokenAddress,
      remoteChainSelector,
    })),
  )
  const was = resolveMultiTokenPoolLanes(before, keys)
  return resolveMultiTokenPoolLanes(after, keys)
    .map((l, i) => ({ before: was[i]!, after: l }))
    .filter((l) => l.after.connection.hasConnection)
}

/** Every input the rules read, canonically hashed: equal when nothing they read has moved. */
function hashGuardInputs(
  lanes: readonly { before: ProjectedMultiTokenPoolLane; after: ProjectedMultiTokenPoolLane }[],
  chainLanes: readonly ProjectedMultiTokenPoolLane[],
  facts: MultiTokenPoolGuardFacts,
): string {
  const sorted = <T>(m: ReadonlyMap<string, T>) => [...m].sort(([a], [b]) => a.localeCompare(b))
  return canonicalHash({
    lanes,
    chainLanes,
    facts: {
      remoteLanes: sorted(facts.remoteLanes),
      remotePools: sorted(facts.remotePools),
      hookCallers: sorted(facts.hookCallers),
      servingPools: [...facts.servingPools].sort(),
      additionalPoolDataBytes: sorted(facts.additionalPoolDataBytes),
      additionalPoolData: sorted(facts.additionalPoolData ?? new Map()),
      providerDataRefused: sorted(facts.providerDataRefused ?? new Map()),
      localAcceptsInbound: sorted(facts.localAcceptsInbound ?? new Map()),
      localAcceptsLegacy: sorted(facts.localAcceptsLegacy ?? new Map()),
    },
  })
}

/**
 * What moved between a snapshot and the state now: each kept value whose canonical form differs, and
 * the guard inputs. Non-throwing; the snapshot check reports it, {@link assertSnapshotHolds} throws.
 * @internal
 */
export function snapshotChanges(
  snapshot: MultiTokenPoolSnapshot,
  current: { guardInputsHash: string; expected: Record<string, unknown> },
): CCTStateChange[] {
  const changed: CCTStateChange[] = []
  const paths = new Set([...Object.keys(snapshot.expected), ...Object.keys(current.expected)])
  for (const path of [...paths].sort())
    if (canonicalHash([snapshot.expected[path]]) !== canonicalHash([current.expected[path]]))
      changed.push({ path, expected: snapshot.expected[path], actual: current.expected[path] })
  if (snapshot.guardInputsHash !== current.guardInputsHash)
    changed.push({
      path: 'guardInputsHash',
      expected: snapshot.guardInputsHash,
      actual: current.guardInputsHash,
    })
  return changed
}

/**
 * Refuses a snapshot that another op built, that covers other calldata, or whose guard inputs or
 * kept values have moved.
 * @throws {@link CCTStateChangedError} listing what moved
 * @internal
 */
export function assertSnapshotHolds(
  operation: string,
  snapshot: MultiTokenPoolSnapshot,
  current: { calldataHash: string; guardInputsHash: string; expected: Record<string, unknown> },
): void {
  if (snapshot.operation !== operation)
    throw new CCTParamsInvalidError(
      operation,
      'expectedSnapshot',
      `was built by ${snapshot.operation}, not ${operation}: pass the snapshot this op returned`,
    )
  if (snapshot.calldataHash !== current.calldataHash)
    throw new CCTParamsInvalidError(
      operation,
      'expectedSnapshot',
      'covers other calldata: pass the snapshot built with these exact params',
    )
  const changed = snapshotChanges(snapshot, current)
  if (changed.length)
    throw new CCTStateChangedError(
      operation,
      `${changed.map((c) => c.path).join(', ')} moved since block ${snapshot.observedAt}`,
      { context: { changed } },
    )
}

/** RPC errors that mean "this node has no `eth_simulateV1`". */
const UNSUPPORTED =
  /method.*(not found|not supported|does not exist|unsupported)|unknown method|not available/i

/**
 * Simulates the write and the lane views after it in one `eth_simulateV1` call from `sender`, and
 * compares the views with the projection.
 * @returns `true` when they agree; `false` when the RPC lacks `eth_simulateV1`
 * @throws {@link CCTDataDecodeError} if they disagree: a projection bug, never accepted
 */
async function crossCheckWithSimulateV1(
  chain: EVMChain,
  {
    poolConfigManager,
    version,
    data,
    sender,
    operation,
  }: RunMultiTokenPoolGuardsInput & { sender: string },
  lanes: readonly ProjectedMultiTokenPoolLane[],
  blockTag: number,
): Promise<boolean> {
  if (!lanes.length) return true
  const pcm = getMultiTokenPoolInterface(POOL_CONFIG_MANAGER_TYPE, version)
  const keys = lanes.map(toAbiLaneKey)
  const views = [
    pcm.encodeFunctionData('getLaneConnectionBatch', [keys]),
    pcm.encodeFunctionData('getTokenTransferFeeConfigBatch', [keys]),
    pcm.encodeFunctionData('getLaneVerificationBatch', [keys, ANY_FINALITY_CONFIG]),
    pcm.encodeFunctionData('getCurrentRateLimiterStateBatch', [keys]),
    pcm.encodeFunctionData('getLaneRecordLevelBatch', [keys]),
  ]
  let result: unknown
  try {
    result = await chain.provider.send('eth_simulateV1', [
      {
        blockStateCalls: [
          {
            calls: [
              { from: sender, to: poolConfigManager, data },
              ...views.map((v) => ({ from: sender, to: poolConfigManager, data: v })),
            ],
          },
        ],
        validation: false,
      },
      toBeHex(blockTag),
    ])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (UNSUPPORTED.test(message)) return false
    throw err
  }
  const calls = (result as { calls?: { status: string; returnData: string }[] }[] | undefined)?.[0]
    ?.calls
  if (!calls || calls.length !== views.length + 1 || calls.some((c) => c.status !== '0x1'))
    // a simulation that ran the write but not the views (or reverted where eth_call did not) is
    // not a confirmation
    return false
  const [connRaw] = pcm.decodeFunctionResult('getLaneConnectionBatch', calls[1]!.returnData)
  const [feeRaw] = pcm.decodeFunctionResult('getTokenTransferFeeConfigBatch', calls[2]!.returnData)
  const [hooks, outbound, inbound] = pcm.decodeFunctionResult(
    'getLaneVerificationBatch',
    calls[3]!.returnData,
  )
  const [bucketsRaw] = pcm.decodeFunctionResult(
    'getCurrentRateLimiterStateBatch',
    calls[4]!.returnData,
  )
  const levelsRaw = pcm.decodeFunctionResult('getLaneRecordLevelBatch', calls[5]!.returnData)
  const byAddress = <T extends { address: string }>(xs: readonly T[]) =>
    [...xs].sort((a, b) => a.address.localeCompare(b.address))
  lanes.forEach((lane, i) => {
    const conn = decodeLaneConnection(resultToObject(connRaw[i]), (b) =>
      decodeRemoteAddress(b, lane.remoteChainSelector),
    )
    const levels = decodeLaneRecordLevels(
      levelsRaw as unknown as readonly (readonly bigint[])[],
      i,
      poolConfigManager,
    )
    const simulated = {
      levels,
      // the store zeroes the buckets of a lane without a connection or a rate limit record
      rateLimits:
        conn.hasConnection && levels.rateLimit !== 'none'
          ? decodeRateLimits(resultToObject(bucketsRaw[i]) as AbiRateLimits)
          : null,
      connection: { ...conn, remotePools: byAddress(conn.remotePools) },
      tokenTransferFeeConfig: toTokenTransferFeeConfig(resultToObject(feeRaw[i])),
      verification: decodeLaneVerification(
        String(hooks[i]),
        resultToObject(outbound[i]) as string[],
        resultToObject(inbound[i]) as string[],
      ),
    }
    const projected = {
      levels: lane.levels,
      rateLimits: lane.rateLimits,
      connection: { ...lane.connection, remotePools: byAddress(lane.connection.remotePools) },
      tokenTransferFeeConfig: lane.tokenTransferFeeConfig,
      verification: lane.verification,
    }
    if (canonicalHash(simulated) !== canonicalHash(projected))
      throw new CCTDataDecodeError(poolConfigManager, {
        context: {
          operation,
          reason: `the projection of ${lane.tokenAddress} → ${lane.remoteChainSelector} disagrees with eth_simulateV1 (an SDK bug; please report it)`,
          projected,
          simulated,
        },
      })
  })
  return true
}
