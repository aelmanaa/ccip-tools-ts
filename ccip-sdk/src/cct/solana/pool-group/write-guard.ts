/**
 * The post-state guard of a pool-group write: simulate the exact instructions, read back every
 * account they write, find the lanes whose state those accounts carry, and judge each lane before
 * and after (trusted remote pools dropped, lanes going live, lanes left failing closed).
 *
 * Every pool-group write runs it while building, and `checkPoolGroupSnapshot` re-runs it on a
 * proposal's transactions, so both paths judge exactly what will execute. Lane effects are never
 * projected by hand: the program computes the post-state in the simulation.
 *
 * @packageDocumentation
 */

import { Buffer } from 'buffer'

import { BorshAccountsCoder } from '@coral-xyz/anchor'
import {
  type AccountInfo,
  type AddressLookupTableAccount,
  type TransactionInstruction,
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import { keccak256 } from 'ethers'

import { CCIPError } from '../../../errors/index.ts'
import type { SolanaChain } from '../../../solana/index.ts'
import { deriveTokenPoolChainConfigV2Pda } from '../../../solana/token-pool.ts'
import { MAX_COMPUTE_UNIT_LIMIT } from '../../../solana/utils.ts'
import { jsonStringify } from '../../../utils.ts'
import { canonicalHash, sealMultiTokenPoolSnapshot } from '../../canonical.ts'
import { CCTParamsInvalidError, CCTStateChangedError } from '../../errors.ts'
import {
  assertDropsConfirmed,
  droppedRemotePools,
  sealConfirmDropped,
} from '../../multi-token-pool-drops.ts'
import type {
  MultiTokenPoolInlineRemotePoolDrop,
  MultiTokenPoolLaneCheckResult,
  MultiTokenPoolLaneFinding,
  MultiTokenPoolSnapshot,
} from '../../multi-token-pool.ts'
import { deriveTokenPoolChainConfigPda } from '../programs/token-pool.ts'
import { parsePublicKey } from '../validate.ts'
import { decodePoolGroupIdlAccount, poolGroupPdas } from './accounts.ts'
import {
  type LaneFailsClosed,
  type PoolGroupLaneState,
  type Unread,
  decodeLaneChainConfig,
  isUnread,
  laneCcvSync,
  laneFailsClosed,
  laneFailsClosedFinding,
  laneFormat,
  lanePauses,
  laneSectionsFor,
} from './lane.ts'
import { checkSolanaMultiTokenPoolLane } from './multi-token-pool-check.ts'
import { listPoolGroupLaneRequests } from './operations/get-pool-group-lane.ts'
import { type PoolGroupPostState, readPoolGroupLaneStates } from './operations/lane.ts'
import { POOL_GROUPS_PROGRAM_IDL } from './program.ts'
import { laneRemotePools } from './remote-lane.ts'
import { rateLimitsOf as sectionRateLimits, sectionValue } from './sections.ts'
import type { PoolGroupLaneKey } from './types.ts'
import type { PoolGroupGuardOptions, PoolGroupLiveCheckOptions } from './write-types.ts'

/** The accounts whose state a lane's transfers read: a change to one of them affects lanes. */
const LANE_ACCOUNTS = ['ChainConfig', 'ChainConfigV2', 'GroupChainPolicy', 'PolicyChainRecord'].map(
  (name) => BorshAccountsCoder.accountDiscriminator(name),
)

/** The `expected` path the guard options are sealed under (as on EVM). @internal */
export const POOL_GROUP_GUARD_OPTIONS_PATH = 'guard.options'

/** A placeholder blockhash; the simulation replaces it. */
const PLACEHOLDER_BLOCKHASH = PublicKey.default.toBase58()

/** The name and message of a pool-program error code, from the vendored IDL. */
function programErrorName(code: number): string {
  const e = POOL_GROUPS_PROGRAM_IDL.errors.find((x) => x.code === code)
  return e ? `${e.name} (${e.msg})` : `Custom(${code})`
}

/** The `Custom` code of a simulation's `InstructionError`, if any. */
function customErrorCode(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null || !('InstructionError' in err)) return
  const pair = err.InstructionError
  const failed: unknown = Array.isArray(pair) ? pair[1] : undefined
  if (typeof failed !== 'object' || failed === null || !('Custom' in failed)) return
  return typeof failed.Custom === 'number' ? failed.Custom : undefined
}

/** What one lane looks like to transfers. */
type LaneView = {
  pools: { address: string; allowLegacyPoolData: boolean }[]
  outbound: boolean
  inbound: boolean
  failsClosed?: LaneFailsClosed
  /** When transfers start failing closed although they do not now (a CCV set the lane lacks). */
  failsClosedAt?: bigint
}

/** A lane's view; an unreadable lane is a reason, never a pass. */
function viewOf(state: PoolGroupLaneState | null | Unread): LaneView | null | Unread {
  if (state === null) return null
  if (isUnread(state)) return state
  const format = laneFormat(state)
  if (isUnread(format)) return format
  const pools = laneRemotePools(state, format)
  if (isUnread(pools)) return pools
  const fails = laneFailsClosed(state)
  if (isUnread(fails)) return fails
  const sync = laneCcvSync(state)
  if (isUnread(sync)) return sync
  const trusted = pools.map(({ address, allowLegacyPoolData }) => ({
    address,
    allowLegacyPoolData,
  }))
  const { pausedOutbound, pausedInbound } = lanePauses(state)
  const blocks = (d: 'outbound' | 'inbound') => !!fails?.directions.includes(d)
  return {
    pools: trusted,
    outbound: !pausedOutbound && !blocks('outbound'),
    inbound: !pausedInbound && !blocks('inbound') && trusted.length > 0,
    ...(fails !== undefined && { failsClosed: fails }),
    ...(sync?.failsClosedAt !== undefined && { failsClosedAt: sync.failsClosedAt }),
  }
}

/** The directions a lane view is open in. */
const openOf = (v: LaneView): ('outbound' | 'inbound')[] => [
  ...(v.outbound ? (['outbound'] as const) : []),
  ...(v.inbound ? (['inbound'] as const) : []),
]

/**
 * The lane's effective configuration of one class, as a stable hash: the record section it resolves
 * (decoded), or its own inline fields; `'unread'` when the record cannot be read.
 */
function classFingerprint(state: PoolGroupLaneState, cls: 'connection' | 'fee'): string {
  const sections = laneSectionsFor(state, cls)
  if (isUnread(sections)) return 'unread'
  if (sections) return canonicalHash({ [cls]: sectionValue(sections, cls, state.selector) })
  if (cls === 'fee') return 'inline'
  const { remote } = state.chainConfig.base
  return canonicalHash({
    token: Buffer.from(remote.tokenAddress.address).toString('hex'),
    decimals: remote.decimals,
    pools: remote.poolAddresses.map((p) => Buffer.from(p.address).toString('hex')),
    format: state.ext?.poolDataFormat ?? 'legacy',
    uid: state.ext?.uid ?? null,
  })
}

/** The named records a lane references, as a stable string. */
const namedRecords = (state: PoolGroupLaneState) =>
  [...state.named.values()]
    .map((n) => n.address.toBase58())
    .sort()
    .join()

/** Where a lane takes SECURITY from (kind, and the named record). */
function securitySource(state: PoolGroupLaneState): string {
  const source = state.ext?.poolGroupAddress ? state.ext.classSource.security : undefined
  if (!source || source.kind !== 'policy') return source?.kind ?? 'inline'
  return `policy:${state.named.get(source.slot)?.address.toBase58() ?? source.slot}`
}

/**
 * The CCV configuration a lane applies: its body's base lists, its threshold amount and threshold
 * lists (a source change clears them, S3b N1), and a pending copy.
 */
const effectiveCcvs = (state: PoolGroupLaneState) => ({
  current: state.v2?.lane.ccvs ?? null,
  thresholds: state.v2?.lane.thresholds ?? null,
  pending: state.ext?.ccvPending ?? null,
})

/**
 * The remote chain of a changed group or named record: `undefined` when the account is not one,
 * `null` when it is one whose chain cannot be decoded.
 */
function recordSelector(
  program: PublicKey,
  account: AccountInfo<Buffer>,
): bigint | null | undefined {
  if (!account.owner.equals(program)) return
  const disc = account.data.subarray(0, 8)
  const name = disc.equals(LANE_ACCOUNTS[2]!)
    ? 'groupChainPolicy'
    : disc.equals(LANE_ACCOUNTS[3]!)
      ? 'policyChainRecord'
      : undefined
  if (!name) return
  try {
    return BigInt(
      decodePoolGroupIdlAccount(
        name,
        account.data,
        'a changed record',
      ).remoteChainSelector.toString(),
    )
  } catch {
    // a record that does not decode names no chain
    return null
  }
}

/**
 * A lane account's configuration hash: a `ChainConfig` without its bucket state (`tokens`,
 * `lastUpdated`), which transfers rewrite; any other account (or one that does not decode) by its
 * bytes.
 */
function laneAccountConfigHash(account: AccountInfo<Buffer>, address: PublicKey): string {
  if (!account.data.subarray(0, 8).equals(LANE_ACCOUNTS[0]!)) return keccak256(account.data)
  const base = decodeLaneChainConfig(account.data, address)
  if (isUnread(base)) return keccak256(account.data)
  const strip = (b: { cfg: unknown }) => ({ cfg: b.cfg })
  return canonicalHash({
    base: {
      ...base,
      inboundRateLimit: strip(base.inboundRateLimit),
      outboundRateLimit: strip(base.outboundRateLimit),
    },
    length: account.data.length,
    tail: keccak256(account.data.subarray(Math.max(0, account.data.length - 8))),
  })
}

/** Input of {@link judgePoolGroupWrite}. @internal */
export type JudgePoolGroupWriteInput = PoolGroupGuardOptions & {
  /** The op, for errors. */
  operation: string
  /** The chain. */
  chain: SolanaChain
  /** The pool program. */
  program: PublicKey
  /** The pool group. */
  group: PublicKey
  /** The fee payer the write is simulated with. */
  payer: PublicKey
  /** The write's instructions, in order (one simulated transaction). */
  instructions: readonly TransactionInstruction[]
  /** Lookup tables the simulated transaction compiles with. */
  lookupTables?: AddressLookupTableAccount[]
  /** Severity of a lane the write leaves failing closed; defaults to `'error'` (refused). */
  failsClosedSeverity?: 'error' | 'warning'
  /**
   * Lanes the write makes live: by default (`'error'`) each runs the lane check as the write leaves
   * it and an error finding refuses the write; `'warning'` only reports them in `goingLive` (an
   * ownership accept, which must never be blocked).
   */
  goingLiveSeverity?: 'error' | 'warning'
  /** The lane check's remote reader and concurrency. */
  liveCheck?: PoolGroupLiveCheckOptions
  /** The lane check (tests inject one). */
  checkLane?: (
    ...args: Parameters<typeof checkSolanaMultiTokenPoolLane>
  ) => Promise<Pick<MultiTokenPoolLaneCheckResult, 'findings'>>
  /** Report error findings instead of refusing (the snapshot check). */
  reportFindings?: boolean
  /**
   * Which lanes the lane rules judge (the write is always simulated): `'all'` (default) every lane
   * it changes; `'loosened'` (a RATE_LIMIT write) only the lanes whose effective rate limits it
   * loosens (a bucket disabled, more capacity or rate), so clamping a broken lane is never refused;
   * `'none'` no lane is listed, for a write no lane reads by construction (a new record, or a closed
   * one whose lane count the program requires to be 0).
   */
  scope?: 'all' | 'loosened' | 'none'
}

/** What a judged write reports. @internal */
export type PoolGroupJudgement = {
  /** Lanes whose state the write changes. */
  affectedLanes: PoolGroupLaneKey[]
  /** Lanes live in a direction after the write that were not before. */
  goingLive: PoolGroupLaneKey[]
  /** Every finding, errors included (errors refuse the write unless `reportFindings`). */
  findings: MultiTokenPoolLaneFinding[]
  /** Lanes the write leaves failing closed, with why. */
  failingClosed: (PoolGroupLaneKey & { reason: string })[]
  /** Affected lanes that cannot be read after the write (findings at `failsClosedSeverity`). */
  unreadable: PoolGroupLaneKey[]
  /** keccak256 of every input the guard read for the affected lanes. */
  guardInputsHash: string
  /** The slot the simulation ran at. */
  slot: bigint
}

const laneKey = (l: PoolGroupLaneKey) => `${l.tokenAddress}:${l.remoteChainSelector}`

/**
 * Simulates a write and returns the post-state of `addresses`.
 * @throws {@link CCTParamsInvalidError} if the program refuses the write (param `authority` on
 *   `Unauthorized`, else `simulation`), with the error name and logs
 */
async function simulateWrite(
  input: JudgePoolGroupWriteInput,
  addresses: readonly PublicKey[],
  minContextSlot: number,
): Promise<{ slot: bigint; accounts: (AccountInfo<Buffer> | null)[] }> {
  const { operation, chain, payer } = input
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: PLACEHOLDER_BLOCKHASH,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNIT_LIMIT }),
      ...input.instructions,
    ],
  }).compileToV0Message(input.lookupTables ?? [])
  const { context, value } = await chain.connection.simulateTransaction(
    new VersionedTransaction(message),
    {
      sigVerify: false,
      replaceRecentBlockhash: true,
      // at least the state read as "before", so a later write is not judged on older state
      commitment: 'confirmed',
      minContextSlot,
      accounts: { encoding: 'base64', addresses: addresses.map((a) => a.toBase58()) },
    },
  )
  if (value.err) {
    const code = customErrorCode(value.err)
    const name = code !== undefined ? programErrorName(code) : JSON.stringify(value.err)
    throw new CCTParamsInvalidError(
      operation,
      name.startsWith('Unauthorized') ? 'authority' : 'simulation',
      `the write fails when simulated: ${name}`,
      { context: { transactionError: value.err, errorCode: code, logs: value.logs } },
    )
  }
  const accounts = (value.accounts ?? []).map((a) =>
    a
      ? {
          data: Buffer.from(a.data[0] ?? '', 'base64'),
          owner: new PublicKey(a.owner),
          lamports: a.lamports,
          executable: a.executable,
          rentEpoch: a.rentEpoch ?? 0,
        }
      : null,
  )
  return { slot: BigInt(context.slot), accounts }
}

/** Whether an account (before or after) is one whose state a lane's transfers read. */
const isLaneAccount = (program: PublicKey, a: AccountInfo<Buffer> | null | undefined) =>
  !!a && a.owner.equals(program) && LANE_ACCOUNTS.some((d) => a.data.subarray(0, 8).equals(d))

/** The accounts and the slot they were read at, at `confirmed`. */
async function readBefore(
  chain: SolanaChain,
  keys: readonly PublicKey[],
): Promise<{ slot: number; accounts: (AccountInfo<Buffer> | null)[] }> {
  const accounts: (AccountInfo<Buffer> | null)[] = []
  let slot = 0
  for (let i = 0; i < keys.length; i += 100) {
    const { context, value } = await chain.connection.getMultipleAccountsInfoAndContext(
      keys.slice(i, i + 100),
      'confirmed',
    )
    slot = Math.max(slot, context.slot)
    accounts.push(...value)
  }
  return { slot, accounts }
}

/** The accounts a lane's transfers read, listed or not readable: its PDAs and group chain record. */
function laneAddresses(
  program: PublicKey,
  group: PublicKey,
  mint: PublicKey,
  selector: bigint,
  states: readonly (PoolGroupLaneState | null | Unread)[],
): string[] {
  const named = states.flatMap((s) =>
    s && !isUnread(s) ? [...s.named.values()].map((n) => n.address) : [],
  )
  return [
    deriveTokenPoolChainConfigPda(program, selector, mint),
    deriveTokenPoolChainConfigV2Pda(program, selector, mint),
    poolGroupPdas.groupChain(program, group, selector),
    ...named,
  ].map((a) => a.toBase58())
}

/**
 * A lane the lane check judges as the write leaves it, with the directions open after it:
 * `'live'` (the write makes it live: any error refuses) or `'changed'` (live before and after, with
 * its effective CONNECTION or FEE changed: only errors the lane did not have before refuse, A23).
 */
type CheckedLane = {
  key: PoolGroupLaneKey
  mint: PublicKey
  selector: bigint
  open: ('outbound' | 'inbound')[]
  mode: 'live' | 'changed'
}

/** Findings that a fact could not be read: never waived as an error the lane already had. */
const UNREAD_CHECKS: readonly MultiTokenPoolLaneFinding['check'][] = [
  'REMOTE_UNREADABLE',
  'LANE_UNREADABLE',
]

/** Lane checks in flight at once, by default (as the shared planners' `concurrency`). */
const LIVE_CHECK_CONCURRENCY = 4

/**
 * The lane check after a write (the make-live check, and A23): `checkMultiTokenPoolLane` on each
 * lane as the write leaves it (`post`), with the directions open after it as `expectOpen`,
 * `getChain` and no attestations, at most `concurrency` at a time. A `'changed'` lane is checked
 * before the write too, and only its new errors stay errors. A lane the check cannot read (a non-transient SDK
 * error) fails closed as `LANE_UNREADABLE`; transport errors propagate.
 */
async function checkLanesAfter(
  input: JudgePoolGroupWriteInput,
  lanes: readonly CheckedLane[],
  post: PoolGroupPostState,
): Promise<MultiTokenPoolLaneFinding[]> {
  const { operation, chain, program } = input
  const getChain = input.liveCheck?.getChain
  const concurrency = input.liveCheck?.concurrency ?? LIVE_CHECK_CONCURRENCY
  const check = input.checkLane ?? checkSolanaMultiTokenPoolLane
  const findings: MultiTokenPoolLaneFinding[] = []
  for (let i = 0; i < lanes.length; i += concurrency) {
    const chunk = lanes.slice(i, i + concurrency)
    const results = await Promise.all(
      chunk.map(async ({ key, mint, selector, open, mode }) => {
        const params = {
          ...key,
          poolAddress: program.toBase58(),
          expectOpen: open,
          ...(getChain && { getChain }),
        }
        try {
          const { findings: found } = await check(
            operation,
            chain,
            params,
            { program, mint, selector },
            post,
          )
          if (mode === 'live' || !found.some((f) => f.severity === 'error')) return found
          // a lane live before and after: only the errors the write brings refuse (A23)
          // the same fact: the code, the record type and the reason (which names the direction,
          // the pool and the values), never the code alone (S3b N2)
          const fact = (f: MultiTokenPoolLaneFinding) =>
            `${f.check}|${f.recordType ?? ''}|${f.reason}`
          const had = new Set(
            (await check(operation, chain, params, { program, mint, selector })).findings
              .filter((f) => f.severity === 'error')
              .map(fact),
          )
          // a fact that cannot be read is never "the same as before": it fails closed
          return found.map((f) =>
            f.severity === 'error' && had.has(fact(f)) && !UNREAD_CHECKS.includes(f.check)
              ? {
                  ...f,
                  severity: 'warning' as const,
                  reason: `${f.reason} (already so before the write)`,
                }
              : f,
          )
        } catch (err) {
          if (!(err instanceof CCIPError) || err.isTransient) throw err
          return [
            {
              check: 'LANE_UNREADABLE' as const,
              severity: 'error' as const,
              ...key,
              reason: `the lane could not be checked as the write leaves it (${err.message}): the write is refused`,
            },
          ]
        }
      }),
    )
    findings.push(...results.flat())
  }
  return findings
}

/**
 * Runs the post-state guard of one pool-group write: simulates it, reads back the accounts it
 * writes, and judges every lane whose state one of them carries (its `ChainConfig`, `ChainConfigV2`,
 * group chain record or named policy records): A21 dropped trusted remote pools (refused unless in
 * `confirmDropped`), lanes going live (the make-live check: the lane check on each as the write
 * leaves it, whose error findings refuse; only reported with `goingLiveSeverity: 'warning'`), lanes left failing closed now or from a later time (refused, or a warning
 * with `failsClosedSeverity: 'warning'`), and affected lanes that cannot be read
 * (`LANE_UNREADABLE` at the same severity: never passed silently; an accept warns and lists them). Lanes are listed only when
 * the write changes a lane account; that listing needs `getProgramAccounts` and fails closed
 * without it. Fails closed compares the program error, not its text.
 * @throws {@link CCTParamsInvalidError} if the simulation refuses the write, a drop is unconfirmed,
 *   a lane it makes live fails the lane check, or an error finding remains (unless `reportFindings`)
 * @internal
 */
export async function judgePoolGroupWrite(
  input: JudgePoolGroupWriteInput,
): Promise<PoolGroupJudgement> {
  const { operation, chain, program, group } = input
  const writable = [
    ...new Map(
      input.instructions
        .flatMap((ix) => ix.keys)
        .filter((k) => k.isWritable && !k.isSigner)
        .map((k) => [k.pubkey.toBase58(), k.pubkey] as const),
    ).values(),
  ]
  const { slot: beforeSlot, accounts: before } = await readBefore(chain, writable)
  const { slot, accounts: after } = await simulateWrite(input, writable, beforeSlot)
  const changed = new Map<string, AccountInfo<Buffer> | null>()
  writable.forEach((key, i) => {
    const [b, a] = [before[i], after[i]]
    const same = b && a ? b.data.equals(a.data) && b.owner.equals(a.owner) : !b && !a
    if (!same && (isLaneAccount(program, b) || isLaneAccount(program, a)))
      changed.set(key.toBase58(), a ?? null)
  })
  // a lane's ChainConfig carries its bucket state, which every transfer rewrites: the snapshot
  // keeps its configuration only, so a transfer never marks a proposal changed (A23)
  const changedInputs = [...changed.keys()].sort().map((k) => {
    const b = before[writable.findIndex((w) => w.toBase58() === k)]
    return [k, b ? laneAccountConfigHash(b, new PublicKey(k)) : null]
  })
  if (input.scope === 'none') {
    // a write judged as touching no lane only creates or closes lane accounts, never edits one
    // a closed account reads back without lamports (or no longer the program's)
    const edited = writable.find(
      (k, i) =>
        changed.has(k.toBase58()) &&
        isLaneAccount(program, before[i]) &&
        isLaneAccount(program, after[i]) &&
        after[i]!.lamports > 0,
    )
    if (edited)
      throw new CCTParamsInvalidError(
        operation,
        'guards',
        `the write edits the lane account ${edited.toBase58()} in place, which a write that no lane reads must not: report this as an SDK bug`,
      )
  }
  // the chains of the changed group and named records: a lane on one that cannot be read is
  // touched (its named records are unknown), so it is judged failing closed, never skipped (A23)
  const changedSelectors = new Set<bigint>()
  // a changed record whose chain cannot be decoded may be any unreadable lane's
  let changedRecordUnknown = false
  for (const [k, a] of changed) {
    const b = before[writable.findIndex((w) => w.toBase58() === k)]
    for (const acc of [b, a]) {
      const sel = acc ? recordSelector(program, acc) : undefined
      if (sel === null) changedRecordUnknown = true
      else if (sel !== undefined) changedSelectors.add(sel)
    }
  }
  if (!changed.size || input.scope === 'none')
    return {
      affectedLanes: [],
      goingLive: [],
      findings: [],
      failingClosed: [],
      unreadable: [],
      guardInputsHash: canonicalHash({ lanes: [], changed: changedInputs }),
      slot,
    }

  const requests = await listPoolGroupLaneRequests(
    operation,
    chain,
    { program, group },
    {
      fix: 'judging the lanes this write changes needs it; use an RPC that serves getProgramAccounts',
    },
  )
  const [statesBefore, statesAfter] = await Promise.all([
    readPoolGroupLaneStates(chain, program, requests),
    readPoolGroupLaneStates(chain, program, requests, { overlay: changed }),
  ])
  const severity = input.failsClosedSeverity ?? 'error'
  const loosens =
    input.scope === 'loosened'
      ? (await import('../../evm/pool-config-manager/guards.ts')).loosensRateLimits
      : undefined
  const rateLimitsOf = (s: PoolGroupLaneState | null | Unread) => {
    if (!s || isUnread(s)) return null
    const sections = laneSectionsFor(s, 'rateLimit')
    return sections && !isUnread(sections) ? sectionRateLimits(sections) : null
  }
  // a RATE_LIMIT section that cannot be read after the write is judged, never taken as a clamp
  const rateLimitUnread = (s: PoolGroupLaneState | null | Unread) =>
    !!s && !isUnread(s) && isUnread(laneSectionsFor(s, 'rateLimit'))
  const findings: MultiTokenPoolLaneFinding[] = []
  const affectedLanes: PoolGroupLaneKey[] = []
  const goingLive: PoolGroupLaneKey[] = []
  const failingClosed: PoolGroupJudgement['failingClosed'] = []
  const unreadable: PoolGroupLaneKey[] = []
  const dropped: MultiTokenPoolInlineRemotePoolDrop[] = []
  const checkedLanes: CheckedLane[] = []
  const ccvChanges: { lane: PoolGroupLaneKey; before: unknown; after: unknown }[] = []
  const inputs: unknown[] = []
  const nothing: LaneView = { pools: [], outbound: false, inbound: false }
  requests.forEach(({ mint, selector }, i) => {
    const key = { tokenAddress: mint.toBase58(), remoteChainSelector: selector }
    const s0 = statesBefore[i] ?? null
    const s1 = statesAfter[i] ?? null
    // a listed lane is linked to this group: its PDAs and chain record are known even when its
    // state cannot be read, so an unreadable lane is never skipped (it fails closed below)
    const touches =
      laneAddresses(program, group, mint, selector, [s0, s1]).some((a) => changed.has(a)) ||
      (isUnread(s1) && (changedRecordUnknown || changedSelectors.has(selector)))
    if (!touches) return
    affectedLanes.push(key)
    // a RATE_LIMIT write judges only the lanes it loosens: a clamp always builds
    if (
      loosens &&
      !isUnread(s1) &&
      !rateLimitUnread(s1) &&
      !loosens(rateLimitsOf(s0), rateLimitsOf(s1))
    ) {
      inputs.push({ lane: laneKey(key), clamped: true })
      return
    }
    const v0 = viewOf(s0)
    const v1 = viewOf(s1)
    inputs.push({ lane: laneKey(key), before: isUnread(v0) ? { unread: v0.reason } : v0 })
    // LANE_UNREADABLE (a local lane fact), at the fails-closed severity, so an accept (warning) is
    // never blocked by a lane it cannot read
    if (isUnread(v1)) {
      unreadable.push(key)
      findings.push({
        check: 'LANE_UNREADABLE',
        severity,
        ...key,
        reason: `the local lane this write changes cannot be read after it (${v1.reason}), so it is not judged${severity === 'error' ? ': the write is refused' : ': check it with checkMultiTokenPoolLane'}`,
      })
      return
    }
    // a lane unreadable before the write is judged as nothing trusted and nothing live
    const before0 = v0 && !isUnread(v0) ? v0 : nothing
    const after1 = v1 ?? nothing
    if ((after1.outbound && !before0.outbound) || (after1.inbound && !before0.inbound)) {
      goingLive.push(key)
      checkedLanes.push({ key, mint, selector, open: openOf(after1), mode: 'live' })
    } else if (
      (after1.outbound || after1.inbound) &&
      s0 &&
      !isUnread(s0) &&
      s1 &&
      !isUnread(s1) &&
      (classFingerprint(s0, 'connection') !== classFingerprint(s1, 'connection') ||
        classFingerprint(s0, 'fee') !== classFingerprint(s1, 'fee'))
    )
      checkedLanes.push({ key, mint, selector, open: openOf(after1), mode: 'changed' })
    // the send lock budget is measured on the state before the write: a write that changes the
    // records a send passes (an assignment) is reported, to re-check after it lands (S3b N3)
    if (
      s0 &&
      !isUnread(s0) &&
      s1 &&
      !isUnread(s1) &&
      (after1.outbound || after1.inbound) &&
      namedRecords(s0) !== namedRecords(s1)
    )
      findings.push({
        check: 'ACCOUNT_LOCKS_EXCEEDED',
        severity: 'warning',
        ...key,
        reason:
          'the write changes the policy records a send of this lane passes, and the send lock budget was measured before it: run checkMultiTokenPoolLane after it lands',
      })
    // a SECURITY source change swaps the lane's CCVs at once (no notice): refused on a lane live
    // before and after unless its effective CCVs are unchanged or the caller confirms it (A23)
    if (
      s0 &&
      !isUnread(s0) &&
      s1 &&
      !isUnread(s1) &&
      (before0.outbound || before0.inbound) &&
      (after1.outbound || after1.inbound) &&
      securitySource(s0) !== securitySource(s1)
    ) {
      const ccvs = { before: effectiveCcvs(s0), after: effectiveCcvs(s1) }
      if (canonicalHash(ccvs.before) !== canonicalHash(ccvs.after))
        ccvChanges.push({ lane: key, ...ccvs })
    }
    dropped.push(...droppedRemotePools([{ lane: key, before: before0.pools, after: after1.pools }]))
    const fails = v1?.failsClosed
    if (fails && fails.code !== before0.failsClosed?.code) {
      failingClosed.push({ ...key, reason: fails.reason })
      const { check, recordType, fix } = laneFailsClosedFinding(fails.code)
      const what = fails.directions.length > 1 ? 'every transfer' : 'every send'
      findings.push({
        check,
        severity,
        ...key,
        recordType,
        reason: `after the write ${what} on the lane reverts: ${fails.reason}; ${fix}`,
      })
    } else if (
      !fails &&
      v1?.failsClosedAt !== undefined &&
      v1.failsClosedAt !== before0.failsClosedAt
    ) {
      const reason = `GroupCcvsNotSynced from ${v1.failsClosedAt}: the lane's CCV copy activates a set its SECURITY record does not (a pending set cancelled or replaced), so every transfer reverts from then until the lane syncs`
      failingClosed.push({ ...key, reason })
      findings.push({
        check: 'CCVS_NOT_SYNCED',
        severity,
        ...key,
        recordType: 'security',
        reason: `after the write ${reason}; sync the lane`,
      })
    }
  })

  assertDropsConfirmed(operation, dropped, input.confirmDropped ?? [])
  const confirmedCcvs = new Set((input.confirmCCVChanges ?? []).map(laneKey))
  const unconfirmedCcvs = ccvChanges.filter((c) => !confirmedCcvs.has(laneKey(c.lane)))
  if (unconfirmedCcvs.length)
    throw new CCTParamsInvalidError(
      operation,
      'confirmCCVChanges',
      `the write changes the SECURITY source of ${unconfirmedCcvs.length} live lane(s) (${unconfirmedCcvs.map((c) => laneKey(c.lane)).join(', ')}), which swaps their CCVs at once, without the notice a schedule gives: in-flight messages may need verifiers that never attested them. Pause the lanes first, or list them in confirmCCVChanges`,
      { context: { ccvChanges: unconfirmedCcvs } },
    )
  for (const c of ccvChanges)
    chain.logger.warn(
      `${operation}: the CCVs of ${laneKey(c.lane)} change at once (confirmed): ${jsonStringify(c.before)} → ${jsonStringify(c.after)}`,
    )
  if (ccvChanges.length) inputs.push({ ccvChanges })
  const lanesToCheck =
    (input.goingLiveSeverity ?? 'error') === 'error'
      ? checkedLanes
      : checkedLanes.filter((l) => l.mode === 'changed')
  if (lanesToCheck.length) {
    const checked = await checkLanesAfter(input, lanesToCheck, {
      overlay: changed,
      instructions: input.instructions,
      payer: input.payer,
      ...(input.lookupTables && { lookupTables: input.lookupTables }),
    })
    findings.push(...checked)
    inputs.push({ live: checked.map((f) => [laneKey(f), f.check, f.severity]) })
    const failing = checked.filter((f) => f.severity === 'error')
    if (failing.length && !input.reportFindings)
      throw new CCTParamsInvalidError(
        operation,
        'guards',
        `the lane check fails on ${failing.length} problem(s) as the write leaves the lanes it makes live or whose CONNECTION or FEE it changes: ${failing
          .map((f) => `${f.check} on ${f.tokenAddress} → ${f.remoteChainSelector}: ${f.reason}`)
          .join('; ')}${
          !input.liveCheck?.getChain && failing.some((f) => f.check === 'REMOTE_UNREADABLE')
            ? '. Pass getChain: every remote chain of these lanes must be readable (writes accept no attestations)'
            : ''
        }`,
        { context: { goingLive, findings: failing } },
      )
  }
  if (goingLive.length && (input.goingLiveSeverity ?? 'error') === 'warning')
    chain.logger.warn(
      `${operation}: the write makes ${goingLive.length} lane(s) live (${goingLive.map(laneKey).join(', ')}); check them with checkMultiTokenPoolLane`,
    )
  const errors = findings.filter((f) => f.severity === 'error')
  if (errors.length && !input.reportFindings)
    throw new CCTParamsInvalidError(
      operation,
      'guards',
      `the write would leave ${errors.length} problem(s) on the lanes it changes: ${errors
        .map((f) => `${f.check} on ${f.tokenAddress} → ${f.remoteChainSelector}: ${f.reason}`)
        .join('; ')}`,
      { context: { findings: errors } },
    )
  return {
    affectedLanes,
    goingLive,
    findings,
    failingClosed,
    unreadable,
    guardInputsHash: canonicalHash({ lanes: inputs, changed: changedInputs }),
    slot,
  }
}

/**
 * The guard options in a stable shape (defaults dropped, lanes and pools sorted, mints canonical,
 * lanes each once),
 * sealed into the snapshot so a re-check judges with the same confirmations.
 * @throws {@link CCTParamsInvalidError} if `confirmDropped` or `confirmCCVChanges` is malformed
 * @internal
 */
export function poolGroupGuardOptionsOf(
  operation: string,
  o: PoolGroupGuardOptions,
): PoolGroupGuardOptions {
  const out: PoolGroupGuardOptions = {}
  if (o.confirmDropped !== undefined) {
    if (!Array.isArray(o.confirmDropped))
      throw new CCTParamsInvalidError(operation, 'confirmDropped', 'must be an array')
    const confirmDropped = sealConfirmDropped(operation, o.confirmDropped, (t, param) =>
      parsePublicKey(operation, param, t).toBase58(),
    )
    if (confirmDropped) out.confirmDropped = confirmDropped
  }
  if (o.confirmCCVChanges !== undefined) {
    if (!Array.isArray(o.confirmCCVChanges))
      throw new CCTParamsInvalidError(operation, 'confirmCCVChanges', 'must be an array')
    const lanes = o.confirmCCVChanges.map((l, i) => {
      const param = `confirmCCVChanges[${i}]`
      const selector: unknown = Reflect.get(Object(l), 'remoteChainSelector')
      if (typeof selector !== 'bigint' || selector < 0n)
        throw new CCTParamsInvalidError(
          operation,
          `${param}.remoteChainSelector`,
          'must be a bigint selector',
        )
      return {
        tokenAddress: parsePublicKey(
          operation,
          `${param}.tokenAddress`,
          Reflect.get(Object(l), 'tokenAddress'),
        ).toBase58(),
        remoteChainSelector: selector,
      }
    })
    const unique = [...new Map(lanes.map((l) => [laneKey(l), l])).values()].sort((a, b) =>
      laneKey(a).localeCompare(laneKey(b)),
    )
    if (unique.length) out.confirmCCVChanges = unique
  }
  return out
}

/**
 * Seals a pool-group write's snapshot: the op's `expected` values plus the sealed guard options, the
 * guard inputs and the ordered transactions' instruction hash. With `expectedSnapshot`, refuses
 * when anything moved (the EVM helper, loaded lazily).
 * @throws {@link CCTStateChangedError} if `expectedSnapshot` no longer holds
 * @throws {@link CCTParamsInvalidError} if `expectedSnapshot` was built by another op or covers
 *   other instructions
 * @internal
 */
export async function sealPoolGroupSnapshot(input: {
  operation: string
  slot: bigint
  expected: Record<string, unknown>
  guardOptions: PoolGroupGuardOptions
  guardInputsHash: string
  calldataHash: string
  expectedSnapshot?: MultiTokenPoolSnapshot
}): Promise<MultiTokenPoolSnapshot> {
  const expected = { ...input.expected, [POOL_GROUP_GUARD_OPTIONS_PATH]: input.guardOptions }
  if (input.expectedSnapshot) {
    const { assertSnapshotHolds, snapshotChanges } =
      await import('../../evm/pool-config-manager/guard-run.ts')
    // a merged write's instructions differ once the state it merged moved: report the move, not
    // the instructions
    const changed =
      input.expectedSnapshot.operation === input.operation
        ? snapshotChanges(input.expectedSnapshot, {
            guardInputsHash: input.guardInputsHash,
            expected,
          })
        : []
    if (changed.length)
      throw new CCTStateChangedError(
        input.operation,
        `${changed.map((c) => c.path).join(', ')} moved since slot ${input.expectedSnapshot.observedAt}`,
        { context: { changed } },
      )
    assertSnapshotHolds(input.operation, input.expectedSnapshot, {
      calldataHash: input.calldataHash,
      guardInputsHash: input.guardInputsHash,
      expected,
    })
  }
  return sealMultiTokenPoolSnapshot({
    observedAt: input.slot,
    operation: input.operation,
    expected,
    guardInputsHash: input.guardInputsHash,
    calldataHash: input.calldataHash,
  })
}
