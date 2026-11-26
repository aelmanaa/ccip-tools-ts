/**
 * Family-neutral multi-token pool (MTTP) types shared by the EVM and Solana CCT surfaces.
 *
 * Target location: `ccip-sdk/src/cct/multi-token-pool.ts`, next to `cct/remote-address.ts`. It holds
 * types, two runtime constant tuples (`MULTI_TOKEN_POOL_LANE_CHECKS`,
 * `MULTI_TOKEN_POOL_STEP_SIGNER_KINDS`) and two pure snapshot (de)serializers. Both
 * `@chainlink/ccip-sdk/cct/evm` and `@chainlink/ccip-sdk/cct/solana` re-export the types with
 * `export type` and the runtime values as values; the module has no side effects, imports no family
 * code and no value from core (the new error class lives in `cct/errors.ts`, see `errors.ts` here).
 *
 * "Multi-token pool" names the feature: on EVM a `BurnMintMultiTokenPool` with its `PoolConfigManager`
 * and three policy stores; on Solana the burn/mint pool program with pool groups. The word "group"
 * alone never appears in a public name, because "token group" means the CCIP API `TokenGroup`.
 *
 * @packageDocumentation
 */

import { Buffer } from 'buffer'

import { id as keccak256Utf8 } from 'ethers'

import type {
  ChainGetter,
  LaneRecordType,
  LaneStatus,
  RateLimiterState,
  TokenTransferFeeConfig,
} from '../chain.ts'
import type { FinalityRequested } from '../extra-args.ts'
import type { ChainFamily } from '../networks.ts'
import { jsonParse, jsonStringify } from '../utils.ts'
import { CCTParamsInvalidError } from './errors.ts'

/** A transfer direction. Structurally identical to the EVM `CCVMessageDirection`. */
export type MultiTokenPoolDirection = 'outbound' | 'inbound'

/**
 * The pool data a lane sends.
 * - `'legacy'`: `abi.encode(uint256 decimals)`, 32 bytes, which every 2.0 pool accepts.
 * - `'long'`: `abi.encode(uint256 decimals, bytes sourceToken, bytes additionalData)`, at least
 *   192 bytes (224 with a 32-byte factory UID). Only a remote EVM multi-token pool, or a Solana
 *   pool-group lane whose format is `'long'`, reads it; any other remote pool burns on the source and
 *   never mints (F14). A canonical Solana pool on interface 1 counts as "does not read long data":
 *   it ignores the data now and strands it after a later move to interface 2.
 */
export type PoolDataFormat = 'legacy' | 'long'

/** A reference to a shared policy: an EVM policy name, or a Solana policy id. */
export type MultiTokenPoolPolicyRef = { name: string } | { id: number }

/**
 * Where a lane's record of one type comes from.
 * - `'inline'`: the token's own record for this lane (EVM inline record; Solana class source 0).
 * - `'policy'`: a named, shared policy's record for this chain.
 * - `'default'`: a shared default (EVM policy chain-0 record; Solana pool-group default or chain record).
 * - `'none'`: no record resolves; a transfer that reads this type reverts.
 */
export type MultiTokenPoolConfigSource =
  | { kind: 'inline' }
  | { kind: 'policy'; policy: MultiTokenPoolPolicyRef }
  | { kind: 'default'; policy?: MultiTokenPoolPolicyRef }
  | { kind: 'none' }

/** The four rate-limit buckets of one lane, as core `RateLimiterState` (`null` = disabled). */
export type MultiTokenPoolLaneRateLimits = {
  outbound: RateLimiterState
  inbound: RateLimiterState
  /** `undefined` when the lane has no faster-than-finality bucket and the default bucket applies. */
  fastFinalityOutbound?: RateLimiterState
  fastFinalityInbound?: RateLimiterState
}

/** One remote pool a lane trusts, in the remote chain's canonical address format. */
export type MultiTokenPoolRemotePool = {
  /** Canonical remote pool address, the spelling `parseRemoteAddress` returns. */
  address: string
  /** Whether this pool may send 32-byte legacy pool data (F3: trusted by address). */
  allowLegacyPoolData: boolean
}

/** Parameters shared by the cross-family lane reads, identical on both managers. */
export type MultiTokenPoolLaneParams = {
  /** Local token (EVM address; Solana mint). */
  tokenAddress: string
  /** CCIP selector of the remote chain (`uint64`). */
  remoteChainSelector: bigint
  /**
   * EVM: the multi-token pool; when omitted, resolved as `TAR.getPool(token)` through
   * `registryAddress`. Solana: the pool program; defaults to the canonical burn-mint program.
   */
  poolAddress?: string
  /** EVM only: TAR, or a Router/OnRamp/OffRamp to resolve it from, when `poolAddress` is omitted. */
  registryAddress?: string
}

/**
 * The F14 fact for one lane (does the remote pool read long pool data?) that the SDK cannot read,
 * supplied by the caller. Keyed by `(remoteChainSelector, remoteToken, remotePoolAddress)`: it applies
 * only to a lane whose resolved remote token and trusted remote pool are exactly these.
 *
 * @remarks Rules, enforced by every op and planner:
 * - accepted only for a remote family the SDK has no reader for. EVM and Solana remotes always need
 *   `getChain`: omitting `getChain` does not unlock attestations for them;
 * - refused when `getChain` can read `remoteChainSelector`: an attestation never overrides a live fact;
 * - refused when `now > validUntil` or `validUntil - attestedAt` exceeds 24 hours;
 * - never used by a check that makes lanes live (EVM unpauses, `setPool` to an MTTP, a Router change,
 *   Solana pause clears and `drivenLanesPaused: false`), which always read the remote side. So a lane
 *   to a family with no SDK reader cannot be made live through the SDK: the operator builds that one
 *   call from the vendored ABI (`MULTI_TOKEN_POOL_OPERATIONS` names the function) and owns the check;
 * - planners never copy attestations into step `inputs` or reuse them across runs: a resumed plan
 *   must be given them again, with `attestedAt` after the run started;
 * - supplies only the F14 fact; the F3 reverse-mapping and UID pairing checks still need `getChain`;
 * - every attestation used is reported in the op's `warnings`.
 */
export type MultiTokenPoolRemoteAttestation = {
  remoteChainSelector: bigint
  /** The lane's remote token, in the remote chain's format. */
  remoteToken: string
  /** The remote pool the attestation is about; it must be one of the lane's trusted remote pools. */
  remotePoolAddress: string
  acceptsLongPoolData: boolean
  /** Unix seconds when the fact was checked. */
  attestedAt: bigint
  /** Unix seconds after which the attestation is refused (at most 24 hours after `attestedAt`). */
  validUntil: bigint
  /** Who checked and how, e.g. "pool-groups lane format 'long', read by ops on 2026-11-26". */
  reason: string
}

/**
 * Options of every op and planner whose guards read the remote side of a lane.
 *
 * @remarks Remote facts are tri-state: `known`, `missing`, `unknown`. A `missing` fact fails the guard
 * with `CCTParamsInvalidError`; an RPC or transport failure is rethrown as the core transient error it
 * is (with `context.operation`); a chain the SDK cannot read needs a `remoteAttestations` entry for
 * each affected lane, else the guard fails closed with `CCTParamsInvalidError(param: 'getChain')`.
 * There is no switch that skips a guard.
 */
export type MultiTokenPoolRemoteCheckOptions = {
  /** Resolves a remote chain (core `ChainGetter`). Only core `Chain` reads are used on it. */
  getChain?: ChainGetter
  /** F14 facts for lanes whose remote chain the SDK cannot read; see {@link MultiTokenPoolRemoteAttestation}. */
  remoteAttestations?: MultiTokenPoolRemoteAttestation[]
}

/** A family-neutral view of one token's lane. */
export type MultiTokenPoolLane = {
  family: typeof ChainFamily.EVM | typeof ChainFamily.Solana
  tokenAddress: string
  remoteChainSelector: bigint
  exists: boolean
  remoteToken: string | null
  remotePools: MultiTokenPoolRemotePool[]
  poolDataFormat: PoolDataFormat
  sources: Record<LaneRecordType, MultiTokenPoolConfigSource>
  rateLimits: MultiTokenPoolLaneRateLimits
  /** Directions held by a stop: an enabled 0/0 bucket (e.g. written by `pauseMultiTokenPoolLanes`). */
  stopped: { outbound: boolean; inbound: boolean }
  tokenTransferFeeConfig?: TokenTransferFeeConfig
  ccvs: { outbound: string[]; inbound: string[] }
  hasHooks: boolean
  /**
   * Core `LaneStatus`. Scope mapping on Solana: pool-group pause → `'global'`; chain record pause or
   * `drivenLanesPaused` → `'chain'`; a (mint, chain) lane pause → `'token'`, which on Solana means
   * this token on this chain only; `getPoolGroupLane` gives the exact source.
   */
  outboundStatus: LaneStatus
  inboundStatus: LaneStatus
}

/** Codes of the lane check and of the post-state guards: a closed runtime tuple. */
export const MULTI_TOKEN_POOL_LANE_CHECKS = [
  'TOKEN_NOT_REGISTERED',
  'RECORD_MISSING',
  'NO_CONNECTION',
  'LANE_CLOSED',
  'REMOTE_TOKEN_ENCODING',
  'REMOTE_TOKEN_SHARED',
  'NO_REMOTE_POOL',
  'POOL_DATA_FORMAT_MISMATCH',
  'LEGACY_RECEIVE_FROM_MULTI_TOKEN_POOL',
  'DEST_BYTES_OVERHEAD_TOO_LOW',
  'DEST_GAS_OVERHEAD_TOO_LOW',
  'NO_FEE_RECORD',
  'TRANSFER_FEE_ABOVE_CAP',
  'INBOUND_BELOW_REMOTE_OUTBOUND',
  'DEFAULT_CCVS_DROPPED',
  'HOOK_CALLER_MISSING',
  'UID_MISMATCH',
  'POOL_CANNOT_MINT_BURN',
  'REMOTE_LANE_MISMATCH',
  'LANE_PAUSED',
  'CCVS_NOT_SYNCED',
  'LANE_NOT_ADMITTED',
  'ACCOUNT_LOCKS_EXCEEDED',
  'REMOTE_ATTESTED',
] as const

/** One lane check code. */
export type MultiTokenPoolLaneCheck = (typeof MULTI_TOKEN_POOL_LANE_CHECKS)[number]

/** One finding of `checkMultiTokenPoolLane` and of the post-state guards of a write. */
export type MultiTokenPoolLaneFinding = {
  check: MultiTokenPoolLaneCheck
  /** `'error'`: a transfer fails or loses funds; the write is refused. `'warning'`: reported only. */
  severity: 'error' | 'warning'
  tokenAddress: string
  remoteChainSelector: bigint
  recordType?: LaneRecordType
  reason: string
}

/** Tri-state fact: `'unknown'` is never treated as `'missing'`. */
export type MultiTokenPoolFact = 'known' | 'missing' | 'unknown'

/** Params of `checkMultiTokenPoolLane` on both families. */
export type CheckMultiTokenPoolLaneParams = MultiTokenPoolLaneParams &
  MultiTokenPoolRemoteCheckOptions & {
    expectOpen?: MultiTokenPoolDirection[]
    minDestGasOverhead?: number
    maxTransferFeeBps?: number
    lockBudget?: { extraAccounts?: number; feeToken?: string }
  }

/** Result of `checkMultiTokenPoolLane`. */
export type MultiTokenPoolLaneCheckResult = {
  lane: MultiTokenPoolLane
  findings: MultiTokenPoolLaneFinding[]
  remote: MultiTokenPoolFact
  ok: boolean
}

/** Params of `getMultiTokenPoolTransferQuote` on both families. */
export type GetMultiTokenPoolTransferQuoteParams = MultiTokenPoolLaneParams & {
  amount: bigint
  finality?: FinalityRequested
  feeToken?: string
}

/** A transfer quote with the pool's basis-point token fee, which the Router's `getFee` leaves out (F6). */
export type MultiTokenPoolTransferQuote = {
  feeUSDCents: bigint
  destGasOverhead: number
  destBytesOverhead: number
  tokenFeeBps: number
  tokenFeeAmount: bigint
  netAmount: bigint
  hasFeeRecord: boolean
}

// ─── Snapshots (read-then-write concurrency) ──────────────────────────────────────────────────

/**
 * The state a write was built against. Every lane-affecting and read-then-write op returns one on
 * both paths and takes it back as `expectedSnapshot`.
 *
 * @remarks
 * - `expected`: the decoded values the write keeps, merges or replaces, by dotted path.
 * - `guardInputsHash`: hash of every input the post-state guards read for the affected lanes at
 *   `observedAt` (resolved records, policy and default records, providers' answers, remote facts).
 * - `calldataHash`: keccak256 of the exact transaction data (EVM) or serialized instructions (Solana).
 * - Hashing: keccak256 over the UTF-8 bytes of a canonical JSON encoding: the SDK's `jsonStringify`
 *   (bigints as bare JSON integers, other numbers with a `.0` suffix) with object keys sorted, no
 *   whitespace, `Uint8Array` as `0x` hex and addresses in canonical spelling.
 * - In memory every amount is a `bigint`; `serializeMultiTokenPoolSnapshot` writes the canonical JSON
 *   and `parseMultiTokenPoolSnapshot` reads it back with the same types, so a snapshot can be
 *   stored next to a Safe or Squads proposal.
 * - On `<op>`, the op re-reads right before sending and throws `CCTStateChangedError` if anything
 *   moved. A delayed proposal is protected only when its executor runs `check…Snapshot` (which
 *   re-runs the full guard on the exact calldata) or when the planner reports it in
 *   `stalePendingSteps`; the contracts cannot compare on chain (program-team ask, design §15).
 */
export type MultiTokenPoolSnapshot = {
  observedAt: bigint
  expected: Record<string, unknown>
  guardInputsHash: string
  calldataHash: string
  /** keccak256 of the canonical JSON of the other fields. */
  hash: string
}

/** Optional input of every lane-affecting or read-then-write op. */
export type MultiTokenPoolExpectedSnapshot = {
  /** The snapshot a previous build returned; the op refuses when the chain moved since. */
  expectedSnapshot?: MultiTokenPoolSnapshot
}

/** Result of the snapshot checks. */
export type MultiTokenPoolSnapshotCheck = {
  ok: boolean
  /** Paths whose value moved. */
  changed: { path: string; expected: unknown; actual: unknown }[]
  /** The guard re-run on the exact calldata against current state: error findings make `ok` false. */
  findings: MultiTokenPoolLaneFinding[]
}

/**
 * A deep copy of `value` with object keys sorted and byte arrays as `0x` hex, so that
 * {@link jsonStringify} of it is canonical: equal values always give equal text.
 */
function canonicalize(value: unknown): unknown {
  if (value instanceof Uint8Array) return '0x' + Buffer.from(value).toString('hex')
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonicalize(v)]),
    )
  return value
}

/**
 * The canonical JSON of `value`: the SDK's {@link jsonStringify} (bigints as bare integers, other
 * numbers with a `.0` suffix, so {@link jsonParse} reads them back as the same types) over a copy
 * with sorted keys and byte arrays as `0x` hex. Snapshots, `step.inputsHash` and `planHash` hash it.
 * @internal
 */
export function canonicalJson(value: unknown): string {
  return jsonStringify(canonicalize(value))
}

/** keccak256 of {@link canonicalJson}. @internal */
export function canonicalHash(value: unknown): string {
  return keccak256Utf8(canonicalJson(value))
}

/** The hash a snapshot carries: over every field but `hash` itself. */
function snapshotHash({ hash: _, ...fields }: MultiTokenPoolSnapshot): string {
  return canonicalHash(fields)
}

/**
 * Seals a snapshot by computing its `hash`. @internal
 * @param fields - Every snapshot field but `hash`.
 */
export function sealMultiTokenPoolSnapshot(
  fields: Omit<MultiTokenPoolSnapshot, 'hash'>,
): MultiTokenPoolSnapshot {
  return { ...fields, hash: canonicalHash(fields) }
}

/**
 * Writes the canonical JSON of a snapshot, to store next to a Safe or Squads proposal.
 *
 * @remarks Pure. Uses the SDK's JSON convention: `bigint`s are bare JSON integers, so read the text
 * back with {@link parseMultiTokenPoolSnapshot} (or the SDK's `jsonParse`), never `JSON.parse`, which
 * loses precision above 2^53.
 * @param snapshot - A snapshot an op returned.
 * @returns Canonical JSON (sorted keys, no whitespace).
 * @example
 * ```ts
 * const json = serializeMultiTokenPoolSnapshot(unsigned.snapshot!)
 * const again = parseMultiTokenPoolSnapshot(json) // deep-equals unsigned.snapshot
 * ```
 */
export function serializeMultiTokenPoolSnapshot(snapshot: MultiTokenPoolSnapshot): string {
  return canonicalJson(snapshot)
}

/**
 * Parses {@link serializeMultiTokenPoolSnapshot} output and verifies its `hash`.
 *
 * @remarks Integers come back as `bigint`, non-integer numbers as `number`, exactly as they were
 * written, so a parsed snapshot can be passed back as `expectedSnapshot`.
 * @param json - Text written by {@link serializeMultiTokenPoolSnapshot}.
 * @returns The snapshot.
 * @throws {@link CCTParamsInvalidError} if the text is not a snapshot, or its `hash` does not match
 * its fields (it was edited or truncated)
 * @example
 * ```ts
 * const snapshot = parseMultiTokenPoolSnapshot(storedJson)
 * ```
 */
export function parseMultiTokenPoolSnapshot(json: string): MultiTokenPoolSnapshot {
  let parsed: unknown
  try {
    parsed = jsonParse(json)
  } catch (error) {
    throw new CCTParamsInvalidError(OPERATION, 'json', 'is not valid JSON', {
      cause: error instanceof Error ? error : undefined,
    })
  }
  if (!isSnapshotShape(parsed))
    throw new CCTParamsInvalidError(
      OPERATION,
      'json',
      'is not a snapshot: needs bigint observedAt, object expected, and string guardInputsHash, calldataHash and hash',
    )
  if (snapshotHash(parsed) !== parsed.hash)
    throw new CCTParamsInvalidError(
      OPERATION,
      'json.hash',
      'does not match the snapshot fields: the snapshot was edited or truncated',
    )
  return parsed
}

const OPERATION = 'parseMultiTokenPoolSnapshot'

function isSnapshotShape(value: unknown): value is MultiTokenPoolSnapshot {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.observedAt === 'bigint' &&
    v.expected !== null &&
    typeof v.expected === 'object' &&
    !Array.isArray(v.expected) &&
    typeof v.guardInputsHash === 'string' &&
    typeof v.calldataHash === 'string' &&
    typeof v.hash === 'string'
  )
}

// ─── Planners (shared shapes) ─────────────────────────────────────────────────────────────────

/** Kinds of actor a planned step can need. */
export const MULTI_TOKEN_POOL_STEP_SIGNER_KINDS = [
  'deployer',
  'pcm-role',
  'contract-owner',
  'token-admin',
  'token-owner',
  'token-role-admin',
  'pool-group-owner',
  'pool-group-role',
  'pool-owner',
  'mint-authority',
  'list-admin',
  'anyone',
] as const
/** One actor kind. */
export type MultiTokenPoolStepSignerKind = (typeof MULTI_TOKEN_POOL_STEP_SIGNER_KINDS)[number]

/** Who must sign a step, the same shape on both families. */
export type MultiTokenPoolStepSigner = {
  kind: MultiTokenPoolStepSignerKind
  /** Contract, PCM, pool group or list the gate is on. */
  on?: string
  /** Roles that pass the gate (EVM PCM role names, Solana pool-group role names). */
  anyOf?: string[]
  /** The token the gate is about, for per-token actors (token admin, role admin, pool owner). */
  tokenAddress?: string
  /** The resolved signer. */
  address?: string
}

/** One actor entry: the first entry whose given fields all match a step's signer supplies its address. */
export type MultiTokenPoolActorMatcher = {
  kind: MultiTokenPoolStepSignerKind
  on?: string
  /** Matches when the step's `anyOf` contains this role. */
  role?: string
  tokenAddress?: string
  address: string
}

/**
 * Who holds what, in one of three forms: a record (one address per kind), a matcher list (several
 * addresses per kind, first match wins), or a resolver function (`undefined` = not known).
 *
 * @remarks Precedence: a matching actor entry wins; otherwise the executing wallet (`<flow>`) or
 * `sender` (`generateUnsigned<Flow>`) is the actor for every kind. A step whose actor is not the
 * wallet is never attempted on `<flow>` and comes back in `blockedBy.actor`; on the unsigned path it is
 * built with that actor as `sender`, so its role pre-flight runs for the right account.
 */
export type MultiTokenPoolActors =
  | Partial<Record<MultiTokenPoolStepSignerKind, string>>
  | MultiTokenPoolActorMatcher[]
  | ((signer: MultiTokenPoolStepSigner) => string | undefined)

/**
 * One planned step: one SDK op, its exact inputs and its effect; the fields of a CLI ADR artifact
 * operation (`id`, `source.operation`, `source.inputs`, `dependsOn`, `callerAccount = signer.address`).
 */
export type MultiTokenPoolPlanStep<Name extends string, Op extends string = string> = {
  /** Stable: `<network>/<target>/<op>[/<remote>][/<chunk>]`. */
  id: string
  /** Unique within the planner's step tuple. */
  name: Name
  /** The SDK op the step runs; typed by each family's op map. */
  operation: Op
  /** Ids of steps that must land first, possibly on another chain. */
  dependsOn: string[]
  summary: string
  /** The op params as the op takes them (`bigint`s stay `bigint`; the CLI converts to text). */
  inputs: Record<string, unknown>
  /** keccak256 of the canonical JSON of `inputs` (same encoding as snapshots). Use it as `pendingStepHashes[id]`. */
  inputsHash: string
  /** Resource keys the step writes. Key scheme and the conflict rule: {@link MultiTokenPoolPlanOptions}. */
  writeSet: string[]
  /**
   * Resource keys the step's guards read, computed from the state after the step's own write,
   * including keys of records that do not exist yet. See {@link MultiTokenPoolPlanOptions}.
   */
  guardReads: string[]
  changes?: { path: string; from: unknown; to: unknown }[]
  estimate?: { transactions: number; gas?: bigint; rentLamports?: bigint; computeUnits?: number }
  /** Tokens or lanes left for this step name; a repeated step advances when it goes down. */
  progress: number
  signer: MultiTokenPoolStepSigner
  notBefore?: bigint
}

/** Why steps cannot run now. */
export type MultiTokenPoolPlanBlock = {
  reason: string
  actor?: MultiTokenPoolStepSigner
  steps?: string[]
  remoteChainSelector?: bigint
}

/** A proposed step whose state moved since it was built. */
export type MultiTokenPoolStalePendingStep = {
  id: string
  /** What moved; reject the proposal: executing it would overwrite or skip a guard on new state. */
  changed: MultiTokenPoolSnapshotCheck['changed']
  findings: MultiTokenPoolLaneFinding[]
}

/** A plan: remaining steps from chain state. */
export type MultiTokenPoolPlan<Name extends string, Op extends string = string> = {
  steps: MultiTokenPoolPlanStep<Name, Op>[]
  blockedBy?: MultiTokenPoolPlanBlock
  /** Steps matching `pendingStepHashes` that have not landed and whose snapshot still holds. */
  pendingSteps: string[]
  /** Steps matching `pendingStepHashes` whose snapshot no longer holds (re-checked on every call). */
  stalePendingSteps: MultiTokenPoolStalePendingStep[]
  /** How many more steps were ready but not returned because of `maxReadySteps`. */
  moreReady: number
  /** Hash of the snapshot and every step's `inputsHash`. */
  planHash: string
  observedAt: bigint
}

/**
 * Options every planner takes on both families.
 *
 * @remarks **The ready-step rule** (the one definition; design §8.1). Two steps A and B conflict when
 * `A.writeSet ∩ B.writeSet`, `A.writeSet ∩ B.guardReads` or `A.guardReads ∩ B.writeSet` is non-empty.
 * A step is ready when every `dependsOn` step has landed, it is not pending, and it conflicts with no
 * other step returned as ready in the same call. Ready steps therefore commute: they may land in any
 * order, or in the same slot, with the same result, and each is built by its own op on current chain
 * state with every guard (nothing is encoded against projected state).
 *
 * `guardReads` are computed from the state **after** the step's own write and include keys of records
 * that do not exist yet: for each affected lane and record type, the inline key, the post-write
 * policy's chain-record key and its chain-0 default key. Key scheme (resource, not storage slot):
 * - EVM: `pcm:<pcm>:profile:<token>`, `pcm:<pcm>:assign:<type>:<token>`,
 *   `pcm:<pcm>:members:<type>:<policy>` (written by an assignment for both the old and the new
 *   policy; read by every policy-scoped write), `pcm:<pcm>:inline:<type>:<token>:<chain>`,
 *   `pcm:<pcm>:policy:<type>:<policy>:<chain>` (chain `0` = default), `pcm:<pcm>:subset:<policy>:<chain>`,
 *   `pcm:<pcm>:provider:<policy>`, `pcm:<pcm>:pause:<global|token:<t>|chain:<c>>`, `pcm:<pcm>:role:<role>`,
 *   `tar:<tar>:<token>`, `token:<token>:roles`, `token:<token>:admin`, `pool:<pool>:<router|pcm|owner>`,
 *   `store:<store>:callers`, `hooks:<hooks>:<callers|allowlist|engine|blocklist>`, `remote:<chain>:<token>`.
 * - Solana: `mint:<mint>:authority`, `pool-state:<mint>`, `tar:<router>:<mint>`,
 *   `lookup-table:<address>` (the derived address), `pool-group:<group>` (the `Group` account:
 *   chains, `next_policy_id`, roles, settings, CCV epoch), `pool-group-chain:<group>:<chain>` (record,
 *   lane mode, bitmap), `pool-group-policy:<group>:<id>`, `pool-group-policy-chain:<group>:<id>:<chain>`,
 *   `pool-group-registry:<group>` (member indices), `pool-group-member:<mint>`, `lane:<mint>:<chain>`,
 *   `list:<list>`, `remote:<chain>:<token>`.
 * Where a key cannot be made exact, steps get a strict `dependsOn` instead: the expanded per-token
 * `onboardToken` steps of one mint form a chain (`registerAdmin` before the mint-authority hand-off, as
 * observed live in the same slot). Table-creating steps of one call get distinct `SlotHashes` entries
 * from one per-call allocator, so no two derive the same table.
 *
 * `onStep` may throw to abort (the error carries `context.executedSteps`); planners also stop on
 * `signal` and on the chain's own abort.
 */
export type MultiTokenPoolPlanOptions = MultiTokenPoolRemoteCheckOptions & {
  actors?: MultiTokenPoolActors
  /** Called after each landed step, before the next one is built; throwing aborts the run. */
  onStep?: (step: MultiTokenPoolExecutedStep) => void | Promise<void>
  signal?: AbortSignal
  /** Parallel reads for lane checks and remote facts; defaults to 4. */
  concurrency?: number
  /** Proposed, not yet executed steps: `step.id` → `step.inputsHash`. */
  pendingStepHashes?: Record<string, string>
  /**
   * Most ready steps the unsigned path returns at once; defaults to 1. A Safe or Squads caller raises
   * it; `moreReady` reports what the cap held back.
   */
  maxReadySteps?: number
}

/** A landed step, as `onStep` and the execute results report it. */
export type MultiTokenPoolExecutedStep = MultiTokenPoolPlanStep<string> & {
  hashes: string[]
  /** EVM deploy steps. */
  contractAddress?: string
  /** Accounts the step created, by name (e.g. `poolGroupAddress`, `poolGroupId`, `lookupTableAddress`). */
  created?: Record<string, string>
}
