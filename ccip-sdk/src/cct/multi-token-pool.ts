/**
 * Family-neutral multi-token pool (MTTP) types shared by the EVM and Solana CCT surfaces.
 *
 * It holds types, three runtime constant tuples (`MULTI_TOKEN_POOL_LANE_CHECKS`,
 * `MULTI_TOKEN_POOL_STEP_SIGNER_KINDS`, `DROPPABLE_REMOTE_POOL_FLAGS`), the two snapshot (de)serializers, and small lane helpers
 * both families' lane checks use (`abiWord`, `isStop`, internal). Both
 * `@chainlink/ccip-sdk/cct/evm` and `@chainlink/ccip-sdk/cct/solana` re-export the types with
 * `export type` and the runtime values as values. The module has no side effects and imports no
 * family code; the canonical JSON it hashes with lives in the internal `canonical.ts`.
 *
 * "Multi-token pool" names the feature: on EVM a `BurnMintMultiTokenPool` with its `PoolConfigManager`
 * and three policy stores; on Solana the burn/mint pool program with pool groups. The word "group"
 * alone never appears in a public name, because "token group" means the CCIP API `TokenGroup`.
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

import type {
  ChainGetter,
  LaneRecordType,
  LaneStatus,
  RateLimiterState,
  TokenTransferFeeConfig,
  TransferDirection,
} from '../chain.ts'
import type { FinalityRequested } from '../extra-args.ts'
import type { ChainFamily } from '../networks.ts'
import { jsonParse } from '../utils.ts'
import { canonicalHash, canonicalJson } from './canonical.ts'
import { type CCTStateChange, CCTParamsInvalidError } from './errors.ts'
import type { RateLimitConfig } from './rate-limit.ts'
import { encodeRemoteAddress } from './remote-address.ts'

/** A transfer direction: core {@link TransferDirection}, the one direction type of the SDK. */
export type MultiTokenPoolDirection = TransferDirection

/**
 * The pool data a lane sends.
 * - `'legacy'`: `abi.encode(uint256 decimals)`, 32 bytes, which every 2.0 pool accepts.
 * - `'long'`: `abi.encode(uint256 decimals, bytes sourceToken, bytes additionalData)`, at least
 *   192 bytes (224 with a 32-byte factory UID). Only a remote EVM multi-token pool, or a Solana
 *   pool-group lane whose format is `'long'`, reads it; any other remote pool burns on the source and
 *   never mints. A canonical Solana pool on interface 1 counts as "does not read long data":
 *   it ignores the data now and strands it after a later move to interface 2.
 */
export type PoolDataFormat = (typeof POOL_DATA_FORMATS)[number]
/** Every {@link PoolDataFormat}, for validation. @internal */
export const POOL_DATA_FORMATS = ['legacy', 'long'] as const

/** A reference to a shared policy: an EVM policy name, or a Solana policy id. */
export type MultiTokenPoolPolicyRef =
  | {
      /** EVM policy name (see `PolicyName`). */
      name: string
    }
  | {
      /** Solana policy id within the pool group. */
      id: number
    }

/**
 * Where a lane's record of one type comes from.
 * - `'inline'`: the token's own record for this lane (EVM inline record; Solana class source 0).
 * - `'policy'`: a named, shared policy's record for this chain.
 * - `'default'`: a shared default (EVM policy chain-0 record; Solana pool-group default or chain record).
 * - `'none'`: no record resolves; a transfer that reads this type reverts.
 */
export type MultiTokenPoolConfigSource =
  | {
      /** The token's own record for this lane. */
      kind: 'inline'
    }
  | {
      /** A named, shared policy's record for this chain. */
      kind: 'policy'
      /** The policy the record belongs to. */
      policy: MultiTokenPoolPolicyRef
    }
  | {
      /** A shared default record. */
      kind: 'default'
      /** The policy whose default applies (EVM); absent for the Solana pool-group default. */
      policy?: MultiTokenPoolPolicyRef
    }
  | {
      /** No record resolves. */
      kind: 'none'
    }

/**
 * The four buckets of one lane or record, as callers write them: each the family-neutral
 * `RateLimitConfig`, range-checked per family when parsed (EVM `uint128`, Solana `u64`).
 */
export type MultiTokenPoolRateLimits = {
  /** Outbound bucket (finality transfers, or every transfer without a fast-finality bucket). */
  outbound: RateLimitConfig
  /** Inbound bucket. */
  inbound: RateLimitConfig
  /** Outbound faster-than-finality bucket. */
  fastFinalityOutbound: RateLimitConfig
  /** Inbound faster-than-finality bucket. */
  fastFinalityInbound: RateLimitConfig
}

/** The four rate-limit buckets of one lane, as core `RateLimiterState` (`null` = disabled). */
export type MultiTokenPoolLaneRateLimits = {
  /** Outbound bucket (finality transfers, or every transfer without a fast-finality bucket). */
  outbound: RateLimiterState
  /** Inbound bucket. */
  inbound: RateLimiterState
  /** `undefined` when the lane has no faster-than-finality bucket and the default bucket applies. */
  fastFinalityOutbound?: RateLimiterState
  /** Inbound faster-than-finality bucket, as `fastFinalityOutbound`. */
  fastFinalityInbound?: RateLimiterState
}

/** One remote pool a lane trusts, in the remote chain's canonical address format. */
export type MultiTokenPoolRemotePool = {
  /** Canonical remote pool address, the spelling `parseRemoteAddress` returns. */
  address: string
  /**
   * Whether this pool may send 32-byte legacy pool data, which names no source token, so the pool is
   * trusted by its address alone (the EVM contract field is `allowLegacyPoolDataOnReceive`).
   */
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
 * Whether the remote pool of one lane reads long pool data, for a remote chain the SDK cannot read,
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
 * - supplies only the long-data fact; the remote lane's reverse mapping and the UID pairing checks
 *   still need `getChain`;
 * - every attestation used is reported in the op's `warnings`.
 */
export type MultiTokenPoolRemoteAttestation = {
  /** CCIP selector of the remote chain. */
  remoteChainSelector: bigint
  /** The lane's remote token, in the remote chain's format. */
  remoteToken: string
  /** The remote pool the attestation is about; it must be one of the lane's trusted remote pools. */
  remotePoolAddress: string
  /** Whether the remote pool reads long pool data. */
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
  /** Long-data facts for lanes whose remote chain the SDK cannot read; see {@link MultiTokenPoolRemoteAttestation}. */
  remoteAttestations?: MultiTokenPoolRemoteAttestation[]
}

/** A family-neutral view of one token's lane. */
export type MultiTokenPoolLane = {
  /** Chain family of the local pool. */
  family: typeof ChainFamily.EVM | typeof ChainFamily.Solana
  /** Local token (EVM address; Solana mint). */
  tokenAddress: string
  /** CCIP selector of the remote chain. */
  remoteChainSelector: bigint
  /** Whether the lane has any configuration at all. */
  exists: boolean
  /** Remote token in the remote chain's format, or `null` when no connection resolves. */
  remoteToken: string | null
  /** Remote pools the lane trusts for inbound messages. */
  remotePools: MultiTokenPoolRemotePool[]
  /** Pool data the lane sends. */
  poolDataFormat: PoolDataFormat
  /** Where each record type resolves from. */
  sources: Record<LaneRecordType, MultiTokenPoolConfigSource>
  /** Resolved rate-limit buckets. */
  rateLimits: MultiTokenPoolLaneRateLimits
  /** Directions held by a stop: an enabled 0/0 bucket (e.g. written by `stopMultiTokenPoolLanes`). */
  stopped: {
    /** Outbound is held by a stop. */
    outbound: boolean
    /** Inbound is held by a stop. */
    inbound: boolean
  }
  /** Resolved fee and destination overheads, when an outbound fee record resolves. */
  tokenTransferFeeConfig?: TokenTransferFeeConfig
  /** Resolved CCV lists per direction (`address(0)` = the default CCVs). */
  ccvs: {
    /** CCVs an outbound transfer needs. */
    outbound: string[]
    /** CCVs an inbound transfer needs. */
    inbound: string[]
  }
  /** Whether a hook contract resolves for the lane. */
  hasHooks: boolean
  /**
   * Core `LaneStatus`. Scope mapping on Solana: pool-group pause → `'global'`; chain record pause or
   * `drivenLanesPaused` → `'chain'`; a (mint, chain) lane pause → `'token'`, which on Solana means
   * this token on this chain only; `getPoolGroupLane` gives the exact source.
   */
  outboundStatus: LaneStatus
  /** Core `LaneStatus` inbound; scopes as `outboundStatus`. */
  inboundStatus: LaneStatus
}

/**
 * Codes of the lane check and of the post-state guards: a closed runtime tuple.
 *
 * @remarks What each code means:
 * - `TOKEN_NOT_REGISTERED`: the pool's PoolConfigManager does not register the token.
 * - `RECORD_MISSING`: a lane with a connection lacks a record a transfer reads; transfers revert.
 * - `NO_CONNECTION`: the lane has no usable connection: none resolves for the token and chain, or one
 *   resolves but its remote token does not (a policy provider without an answer). It describes a
 *   lane's state, whatever made it so.
 * - `LANE_CLOSED`: a write removes the connection of a lane that has one, so in-flight inbound
 *   messages can no longer execute. It describes what a write does; confirm it with `confirmClosing`.
 * - `REMOTE_TOKEN_ENCODING`: the remote token is not a valid address of the remote chain's family.
 * - `REMOTE_TOKEN_SHARED`: another local token resolves the same remote token on that chain.
 * - `NO_REMOTE_POOL`: the remote registry names no pool for the remote token (or the lane trusts no
 *   remote pool): a send burns here and nothing releases it there.
 * - `POOL_DATA_FORMAT_MISMATCH`: the lane sends long pool data to a remote pool that reads only legacy,
 *   or a remote pool sends legacy data this lane does not accept from it.
 * - `LEGACY_RECEIVE_FROM_MULTI_TOKEN_POOL`: the lane accepts legacy pool data, which names no source
 *   token, from a remote multi-token pool.
 * - `DEST_BYTES_OVERHEAD_TOO_LOW` / `DEST_GAS_OVERHEAD_TOO_LOW`: the destination overheads cannot carry
 *   the pool data, or the release.
 * - `NO_FEE_RECORD`: no fee record resolves; a send reverts.
 * - `TRANSFER_FEE_ABOVE_CAP`: the resolved basis-point fee is above the caller's cap.
 * - `INBOUND_BELOW_REMOTE_OUTBOUND`: the inbound rate limit is below the remote outbound one.
 * - `DEFAULT_CCVS_DROPPED`: a CCV list without the default placeholder drops the ramps' default CCVs.
 * - `HOOK_CALLER_MISSING`: the lane's hook does not authorize a serving pool.
 * - `UID_MISMATCH`: the additional pool data does not pair: a provider on one side refuses what the
 *   other sends (legacy receive sends none), or a provider refuses to produce data for its token.
 * - `POOL_CANNOT_MINT_BURN`: the pool lacks mint or burn on the token.
 * - `REMOTE_LANE_MISMATCH`: the remote side does not point back at this lane, or its registry's pool
 *   is not among the trusted ones.
 * - `LANE_PAUSED`: a global, chain or token pause holds the lane in a direction; lift it with the
 *   matching unpause.
 * - `LANE_STOPPED`: an EVM lane stop holds a direction: its rate limit bucket is enabled with no
 *   capacity and no rate. Not a pause: lift it by writing a non-zero bucket (`liftMultiTokenPoolLaneStops`).
 * - `REMOTE_UNREADABLE`: a remote fact the check needs could not be read (no `getChain`, or a remote
 *   family the SDK cannot read yet), so the check fails closed; pass `getChain`, or a
 *   `remoteAttestations` entry where one applies.
 * - `CCVS_NOT_SYNCED`, `LANE_NOT_ADMITTED`, `ACCOUNT_LOCKS_EXCEEDED`: Solana pool-group lane states.
 * - `REMOTE_ATTESTED`: a remote fact came from an attestation, not a read (a warning).
 * - `UID_MIGRATION_UNCHECKED`: a factory UID provider is set on a token whose registry shows a pool
 *   history (another pool serves it, or an admin transfer is pending) that the SDK cannot check yet;
 *   the write is refused. It is about the token: its `remoteChainSelector` is `0n`.
 * - `LANE_UNREADABLE`: a local fact of the lane could not be read (e.g. a hook's authorized callers,
 *   or a pool-group account), so the check fails closed. `REMOTE_UNREADABLE` is the remote side.
 */
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
  'LANE_STOPPED',
  'REMOTE_UNREADABLE',
  'CCVS_NOT_SYNCED',
  'LANE_NOT_ADMITTED',
  'ACCOUNT_LOCKS_EXCEEDED',
  'REMOTE_ATTESTED',
  'UID_MIGRATION_UNCHECKED',
  'LANE_UNREADABLE',
] as const

/** One lane check code. */
export type MultiTokenPoolLaneCheck = (typeof MULTI_TOKEN_POOL_LANE_CHECKS)[number]

/**
 * One finding of a multi-token pool check: the shape every MTTP read, check and guard reports.
 * @typeParam C - The closed set of check codes of that report.
 */
export type MultiTokenPoolFinding<C extends string> = {
  /** The check that produced the finding. */
  check: C
  /** `'error'`: it fails, loses funds, or the write is refused. `'warning'`: reported only. */
  severity: 'error' | 'warning'
  /** What is wrong and how to fix it. */
  reason: string
}

/** One finding of `checkMultiTokenPoolLane` and of the post-state guards of a write. */
export type MultiTokenPoolLaneFinding = MultiTokenPoolFinding<MultiTokenPoolLaneCheck> & {
  /** Local token of the lane. */
  tokenAddress: string
  /** Remote chain of the lane; `0n` when the finding is about the token, not one lane. */
  remoteChainSelector: bigint
  /** The record type involved, when one is. */
  recordType?: LaneRecordType
}

/**
 * Sorts findings in place, deterministically: errors first, then by check code, then by reason.
 * Every finding list the MTTP reads and guards return goes through it.
 * @internal
 */
export function sortFindings<F extends MultiTokenPoolFinding<string>>(findings: F[]): F[] {
  return findings.sort(
    (a, b) =>
      (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1) ||
      a.check.localeCompare(b.check) ||
      a.reason.localeCompare(b.reason),
  )
}

/**
 * A remote fact, family-neutral: read, absent on the remote chain, or unreadable. Each family's
 * remote reader returns it.
 * @internal
 */
export type MultiTokenPoolRemoteFact<T> =
  | ({ status: 'known' } & T)
  | {
      /** `'missing'`: the remote side lacks it; `'unknown'`: the SDK cannot read that chain. */
      status: 'missing' | 'unknown'
      /** What is missing or why it cannot be read. */
      reason: string
      /**
       * The error that left it unread, when one did (e.g. `getChain` rejecting): tells "no RPC for
       * that chain" from a transient transport failure worth a retry.
       */
      cause?: unknown
    }

/** Tri-state fact: `'unknown'` is never treated as `'missing'`. */
export type MultiTokenPoolFact = 'known' | 'missing' | 'unknown'

/** Params of `checkMultiTokenPoolLane` on both families. */
export type CheckMultiTokenPoolLaneParams = MultiTokenPoolLaneParams &
  MultiTokenPoolRemoteCheckOptions & {
    /** Directions that must be open for `ok`; defaults to both. */
    expectOpen?: MultiTokenPoolDirection[]
    /** Lowest acceptable `destGasOverhead`; defaults to 200,000 (plus 100,000 when a hook resolves). */
    minDestGasOverhead?: number
    /** Highest acceptable transfer fee in bps, both tiers; defaults to 1,000. */
    maxTransferFeeBps?: number
    /** Solana only: extra accounts a program caller adds, for the send lock budget. */
    lockBudget?: {
      /** Accounts the calling program adds to the send. */
      extraAccounts?: number
      /** Fee token of the send (WSOL adds one account). */
      feeToken?: string
    }
  }

/** Result of `checkMultiTokenPoolLane`. */
export type MultiTokenPoolLaneCheckResult = {
  /** The lane as read. */
  lane: MultiTokenPoolLane
  /** Every finding, errors and warnings. */
  findings: MultiTokenPoolLaneFinding[]
  /**
   * The remote side, tri-state:
   * - `'known'`: read and checked;
   * - `'missing'`: read, and the remote side lacks what the lane needs (e.g. no pool registered);
   * - `'unknown'`: not read: the SDK cannot read that chain, `getChain` is missing, or the lane has no
   *   connection to check.
   * `ok` already folds this in (fail closed): gate on `ok`.
   */
  remote: MultiTokenPoolFact
  /**
   * `true` when no error finding remains. It usually needs remote `'known'`, but a token-scope
   * pause or stop waives a missing remote pool, so it can be `true` with `'missing'`; remote
   * `'unknown'` is never ok.
   */
  ok: boolean
}

/** Params of `getMultiTokenPoolTransferQuote` on both families. */
export type GetMultiTokenPoolTransferQuoteParams = MultiTokenPoolLaneParams & {
  /** Amount to transfer, in local token units. */
  amount: bigint
  /** Requested finality; picks the fee tier. Defaults to waiting for finality. */
  finality?: FinalityRequested
  /** Fee token for the Router fee; defaults to native. */
  feeToken?: string
}

/** A transfer quote with the pool's basis-point token fee, which the Router's `getFee` leaves out. */
export type MultiTokenPoolTransferQuote = {
  /** Token transfer fee in USD cents the Router charges for this tier. */
  feeUSDCents: bigint
  /** Destination gas overhead of the lane. */
  destGasOverhead: number
  /** Destination bytes overhead of the lane. */
  destBytesOverhead: number
  /** Basis-point fee the pool takes from the amount, for this tier. */
  tokenFeeBps: number
  /** Amount the pool deducts from the transfer as its token fee, in local token units (as core `TokenTransferFee.feeDeducted`). */
  feeDeducted: bigint
  /** Amount the receiver gets: `amount - feeDeducted`. */
  netAmount: bigint
  /**
   * Whether a fee record resolves: `true` on EVM; on Solana `false` for a legacy lane without a fee
   * record (the send falls back to the FeeQuoter); a long lane without one throws.
   */
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
 *   `stalePendingSteps`; the contracts cannot compare on chain (an on-chain compare-and-swap is
 *   asked of the contract team).
 */
export type MultiTokenPoolSnapshot = {
  /** Block (EVM) or slot (Solana) the state was read at. */
  observedAt: bigint
  /**
   * The SDK op that built it (e.g. `applyMultiTokenPoolInlineFeeConfigUpdates`). Bound into `hash`, so
   * an op refuses a snapshot another op built, not only one with other calldata.
   */
  operation: string
  /** Decoded values the write keeps, merges or replaces, by dotted path. */
  expected: Record<string, unknown>
  /** keccak256 of every input the write's guards read for the affected lanes. */
  guardInputsHash: string
  /** keccak256 of the exact calldata (EVM) or serialized instructions (Solana). */
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
  /** `true` when nothing moved and no error finding remains. */
  ok: boolean
  /** What moved: `guardInputsHash` when any input the guard reads has moved (rebuild the proposal). */
  changed: CCTStateChange[]
  /** The guard re-run on the exact calldata against current state: error findings make `ok` false. */
  findings: MultiTokenPoolLaneFinding[]
}

/** The hash a snapshot carries: over every field but `hash` itself. */
function snapshotHash({ hash: _, ...fields }: MultiTokenPoolSnapshot): string {
  return canonicalHash(fields)
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
      'is not a snapshot: needs bigint observedAt, object expected, and string operation, guardInputsHash, calldataHash and hash',
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
    typeof v.operation === 'string' &&
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
  /** What kind of actor must sign. */
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
  /** Actor kind the entry matches. */
  kind: MultiTokenPoolStepSignerKind
  /** Matches only steps gated on this contract, PCM, pool group or list. */
  on?: string
  /** Matches when the step's `anyOf` contains this role. */
  role?: string
  /** Matches only steps about this token. */
  tokenAddress?: string
  /** The signer to use for matching steps. */
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
  /** One-line human description. */
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
  /** Values the step changes, as read before it. */
  changes?: {
    /** Dotted path of the value. */
    path: string
    /** Current value. */
    from: unknown
    /** Value after the step. */
    to: unknown
  }[]
  /** Cost estimate. */
  estimate?: {
    /** Transactions the step needs. */
    transactions: number
    /** Estimated gas (EVM). */
    gas?: bigint
    /** Rent the step pays (Solana). */
    rentLamports?: bigint
    /** Estimated compute units (Solana). */
    computeUnits?: number
  }
  /** Tokens or lanes left for this step name; a repeated step advances when it goes down. */
  progress: number
  /** Who must sign. */
  signer: MultiTokenPoolStepSigner
  /** Unix seconds before which the step cannot land (e.g. an admin-transfer delay). */
  notBefore?: bigint
}

/** Why steps cannot run now. */
export type MultiTokenPoolPlanBlock = {
  /** Why the steps cannot run now, and what unblocks them. */
  reason: string
  /** The actor the steps wait for, when it is not the caller. */
  actor?: MultiTokenPoolStepSigner
  /** Ids of the blocked steps. */
  steps?: string[]
  /** The remote chain the block is about, when it is one. */
  remoteChainSelector?: bigint
}

/** A proposed step whose state moved since it was built. */
export type MultiTokenPoolStalePendingStep = {
  /** Id of the proposed step. */
  id: string
  /** What moved; reject the proposal: executing it would overwrite or skip a guard on new state. */
  changed: MultiTokenPoolSnapshotCheck['changed']
  /** Error findings the guard re-run gives on the current state. */
  findings: MultiTokenPoolLaneFinding[]
}

/** A plan: remaining steps from chain state. */
export type MultiTokenPoolPlan<Name extends string, Op extends string = string> = {
  /** Steps ready to run now (at most `maxReadySteps` on the unsigned path). */
  steps: MultiTokenPoolPlanStep<Name, Op>[]
  /** Why the remaining steps cannot run now, if they cannot. */
  blockedBy?: MultiTokenPoolPlanBlock
  /** Steps matching `pendingStepHashes` that have not landed and whose snapshot still holds. */
  pendingSteps: string[]
  /** Steps matching `pendingStepHashes` whose snapshot no longer holds (re-checked on every call). */
  stalePendingSteps: MultiTokenPoolStalePendingStep[]
  /** How many more steps were ready but not returned because of `maxReadySteps`. */
  moreReady: number
  /** Hash of the snapshot and every step's `inputsHash`. */
  planHash: string
  /** Block (EVM) or slot (Solana) the plan was read at. */
  observedAt: bigint
}

/**
 * Options every planner takes on both families.
 *
 * @remarks **The ready-step rule** (its one definition). Two steps A and B conflict when
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
  /** Who holds which role; see `MultiTokenPoolActors`. */
  actors?: MultiTokenPoolActors
  /** Called after each landed step, before the next one is built; throwing aborts the run. */
  onStep?: (step: MultiTokenPoolExecutedStep) => void | Promise<void>
  /** Aborts the run between steps. */
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
  /**
   * Ids of this run's steps that have landed. The signed `<flow>` tracks them itself; the unsigned
   * path takes them from the caller (from `onStep`, the execute result's steps, or the multisig's
   * executed proposals). Used only to decide which pauses this run may lift: a pause this run did not
   * land is never lifted.
   */
  landedStepIds?: string[]
}

/** A landed step, as `onStep` and the execute results report it. */
export type MultiTokenPoolExecutedStep = MultiTokenPoolPlanStep<string> & {
  /** Transaction hashes the step landed. */
  hashes: string[]
  /** EVM deploy steps. */
  contractAddress?: string
  /** Accounts the step created, by name (e.g. `poolGroupAddress`, `poolGroupId`, `lookupTableAddress`). */
  created?: Record<string, string>
}

/** Default `maxTransferFeeBps` of the post-state guards (the token fee cap, both tiers). @internal */
export const DEFAULT_MAX_TRANSFER_FEE_BPS = 1_000
/** Default `minDestGasOverhead` of the post-state guards (destination gas). @internal */
export const DEFAULT_MIN_DEST_GAS_OVERHEAD = 200_000
/** Gas a resolved hook adds to the default minimum destination gas. @internal */
export const HOOK_DEST_GAS_OVERHEAD = 100_000
/** Long pool data without additional data: decimals, source token and two offsets/lengths. @internal */
export const LONG_POOL_DATA_BYTES = 192
/** Legacy pool data: the decimals word. @internal */
export const LEGACY_POOL_DATA_BYTES = 32

/** Bytes of long pool data with `extra` bytes of additional data (ABI-padded to 32). @internal */
export function longPoolDataBytes(extra: number): number {
  return LONG_POOL_DATA_BYTES + Math.ceil(extra / 32) * 32
}

/**
 * An EVM address as the 32-byte ABI word (`abi.encode(address)`), lower-case: the form an EVM chain
 * sends and a remote lane must store for it.
 * @internal
 */
export function abiWord(address: string): string {
  return encodeRemoteAddress(getAddress(address))
}

/**
 * Whether a rate-limit bucket is a stop: enabled with zero capacity and rate, so nothing passes.
 * @internal
 */
export function isStop(bucket: { isEnabled: boolean; capacity: bigint; rate: bigint }): boolean {
  return bucket.isEnabled && bucket.capacity === 0n && bucket.rate === 0n
}

/** One token lane: a local token (each family's spelling) and a remote chain. EVM's PCM `LaneKey`. */
export type MultiTokenPoolLaneKey = {
  /** Local token. */
  tokenAddress: string
  /** CCIP selector of the remote chain. */
  remoteChainSelector: bigint
}

/** Flags a write may turn off on a lane's trusted pools, confirmed in `confirmDropped`. */
export const DROPPABLE_REMOTE_POOL_FLAGS = [
  'trustPolicyRemotePools',
  'allowLegacyPoolData',
] as const

/**
 * What a write drops from a lane's trusted remote pools, confirmed by repeating it in
 * `confirmDropped` (A21, A22). Both families' guards use it; `flags` applies to EVM inline records.
 */
export type MultiTokenPoolInlineRemotePoolDrop = {
  /** The lane. */
  lane: MultiTokenPoolLaneKey
  /** Remote pools the lane no longer trusts after the write. */
  remotePools?: string[]
  /**
   * Flags the write turns off: `allowLegacyPoolData` on any pool the lane keeps;
   * `trustPolicyRemotePools` (its dropped policy pools are listed in `remotePools` too).
   */
  flags?: (typeof DROPPABLE_REMOTE_POOL_FLAGS)[number][]
}
