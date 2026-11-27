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

import type { SolanaChain } from '../../../solana/index.ts'
import { deriveTokenPoolChainConfigV2Pda } from '../../../solana/token-pool.ts'
import { MAX_COMPUTE_UNIT_LIMIT } from '../../../solana/utils.ts'
import { canonicalHash, sealMultiTokenPoolSnapshot } from '../../canonical.ts'
import { CCTParamsInvalidError, CCTStateChangedError } from '../../errors.ts'
import type { MultiTokenPoolInlineRemotePoolDrop } from '../../evm/pool-config-manager/contracts.ts'
import type { MultiTokenPoolLaneFinding, MultiTokenPoolSnapshot } from '../../multi-token-pool.ts'
import { parseUniqueRemoteAddresses } from '../../remote-address.ts'
import { deriveTokenPoolChainConfigPda } from '../programs/token-pool.ts'
import { parsePublicKey } from '../validate.ts'
import { poolGroupPdas } from './accounts.ts'
import {
  type LaneFailsClosed,
  type PoolGroupLaneState,
  type Unread,
  isUnread,
  laneCcvSync,
  laneFailsClosed,
  laneFailsClosedFinding,
  laneFormat,
  lanePauses,
} from './lane.ts'
import { listPoolGroupLaneRequests } from './operations/get-pool-group-lane.ts'
import { readPoolGroupLaneStates } from './operations/lane.ts'
import { POOL_GROUPS_PROGRAM_IDL } from './program.ts'
import { laneRemotePools } from './remote-lane.ts'
import type { PoolGroupLaneKey } from './types.ts'
import type { PoolGroupGuardOptions } from './write-types.ts'

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
   * Lanes the write makes live: refused by default (`'error'`), or only reported in `goingLive`
   * (`'warning'`, an ownership accept, which must never be blocked).
   */
  goingLiveSeverity?: 'error' | 'warning'
  /** Report error findings instead of refusing (the snapshot check). */
  reportFindings?: boolean
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
 * Runs the post-state guard of one pool-group write: simulates it, reads back the accounts it
 * writes, and judges every lane whose state one of them carries (its `ChainConfig`, `ChainConfigV2`,
 * group chain record or named policy records): A21 dropped trusted remote pools (refused unless in
 * `confirmDropped`), lanes going live (refused unless `goingLiveSeverity: 'warning'`: no S3 write
 * checks lanes it opens), lanes left failing closed now or from a later time (refused, or a warning
 * with `failsClosedSeverity: 'warning'`), and affected lanes that cannot be read (always an error,
 * `REMOTE_UNREADABLE`: the guard never passes a lane it cannot read). Lanes are listed only when
 * the write changes a lane account; that listing needs `getProgramAccounts` and fails closed
 * without it. Fails closed compares the program error, not its text.
 * @throws {@link CCTParamsInvalidError} if the simulation refuses the write, a drop is unconfirmed,
 *   a lane would go live, or an error finding remains (unless `reportFindings`)
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
  const changedInputs = [...changed.keys()].sort().map((k) => {
    const b = before[writable.findIndex((w) => w.toBase58() === k)]
    return [k, b ? keccak256(b.data) : null]
  })
  if (!changed.size)
    return {
      affectedLanes: [],
      goingLive: [],
      findings: [],
      failingClosed: [],
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
  const findings: MultiTokenPoolLaneFinding[] = []
  const affectedLanes: PoolGroupLaneKey[] = []
  const goingLive: PoolGroupLaneKey[] = []
  const failingClosed: PoolGroupJudgement['failingClosed'] = []
  const dropped: MultiTokenPoolInlineRemotePoolDrop[] = []
  const inputs: unknown[] = []
  const nothing: LaneView = { pools: [], outbound: false, inbound: false }
  requests.forEach(({ mint, selector }, i) => {
    const key = { tokenAddress: mint.toBase58(), remoteChainSelector: selector }
    const s0 = statesBefore[i] ?? null
    const s1 = statesAfter[i] ?? null
    // a listed lane is linked to this group: its PDAs and chain record are known even when its
    // state cannot be read, so an unreadable lane is never skipped (it fails closed below)
    const touches = laneAddresses(program, group, mint, selector, [s0, s1]).some((a) =>
      changed.has(a),
    )
    if (!touches) return
    affectedLanes.push(key)
    const v0 = viewOf(s0)
    const v1 = viewOf(s1)
    inputs.push({ lane: laneKey(key), before: isUnread(v0) ? { unread: v0.reason } : v0 })
    if (isUnread(v1)) {
      findings.push({
        check: 'REMOTE_UNREADABLE',
        severity: 'error',
        ...key,
        reason: `the lane this write changes cannot be read after it (${v1.reason}): it is not judged, so the write is refused`,
      })
      return
    }
    // a lane unreadable before the write is judged as nothing trusted and nothing live
    const before0 = v0 && !isUnread(v0) ? v0 : nothing
    const after1 = v1 ?? nothing
    if ((after1.outbound && !before0.outbound) || (after1.inbound && !before0.inbound))
      goingLive.push(key)
    const kept = new Map(after1.pools.map((p) => [p.address, p]))
    const lost = before0.pools.filter((p) => !kept.has(p.address)).map((p) => p.address)
    const legacyLost = before0.pools.some(
      (p) => p.allowLegacyPoolData && kept.get(p.address)?.allowLegacyPoolData === false,
    )
    if (lost.length || legacyLost)
      dropped.push({
        lane: key,
        ...(lost.length && { remotePools: lost }),
        ...(legacyLost && { flags: ['allowLegacyPoolData'] }),
      })
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

  // TODO(M6): the drop confirmation, its sealing and the drop computation move to the family-neutral
  // guard module (mttp/tools/m6-s3a-dropped-pools.diff); call it from here once it lands
  assertDropsConfirmed(operation, dropped, input.confirmDropped ?? [])
  if (goingLive.length) {
    const message = `the write makes ${goingLive.length} lane(s) live (${goingLive.map(laneKey).join(', ')}), which this op does not check`
    if ((input.goingLiveSeverity ?? 'error') === 'error')
      throw new CCTParamsInvalidError(
        operation,
        'guards',
        `${message}: make lanes live with the pause ops, which run the lane check`,
        { context: { goingLive } },
      )
    chain.logger.warn(`${operation}: ${message}; check them with checkMultiTokenPoolLane`)
  }
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
    guardInputsHash: canonicalHash({ lanes: inputs, changed: changedInputs }),
    slot,
  }
}

/**
 * A21: refuses a write that drops trusted remote pools (or `allowLegacyPoolData` on a kept one) on
 * a lane, unless `confirmDropped` lists the drop for that lane. Addresses compare canonically.
 * @throws {@link CCTParamsInvalidError} (param `confirmDropped`, `context.dropped`) if any drop is
 *   unconfirmed
 * @internal
 */
export function assertDropsConfirmed(
  operation: string,
  dropped: readonly MultiTokenPoolInlineRemotePoolDrop[],
  confirmDropped: readonly MultiTokenPoolInlineRemotePoolDrop[],
): void {
  if (!dropped.length) return
  const confirmed = new Map(confirmDropped.map((d) => [laneKey(d.lane), d]))
  const unconfirmed = dropped
    .map((d) => {
      const ok = confirmed.get(laneKey(d.lane))
      const okPools = new Set(
        ok?.remotePools
          ? parseUniqueRemoteAddresses(
              operation,
              'confirmDropped',
              ok.remotePools,
              d.lane.remoteChainSelector,
            )
          : [],
      )
      return {
        lane: d.lane,
        remotePools: (d.remotePools ?? []).filter((p) => !okPools.has(p)),
        flags: (d.flags ?? []).filter((f) => !ok?.flags?.includes(f)),
      }
    })
    .filter((d) => d.remotePools.length || d.flags.length)
  if (unconfirmed.length)
    throw new CCTParamsInvalidError(
      operation,
      'confirmDropped',
      `the write drops trusted remote pools, so in-flight inbound messages from them would revert: ${unconfirmed
        .map(
          (d) =>
            `${laneKey(d.lane)} drops ${[
              ...(d.remotePools.length ? [`pools ${d.remotePools.join(', ')}`] : []),
              ...(d.flags.length ? [`flags ${d.flags.join(', ')}`] : []),
            ].join(' and ')}`,
        )
        .join(
          '; ',
        )}. To proceed, add confirmDropped: context.dropped (same shape), or keep them trusted`,
      { context: { dropped: unconfirmed } },
    )
}

/**
 * The guard options in a stable shape (defaults dropped, lanes and pools sorted, mints canonical),
 * sealed into the snapshot so a re-check judges with the same confirmations.
 * @throws {@link CCTParamsInvalidError} if `confirmDropped` is malformed
 * @internal
 */
export function poolGroupGuardOptionsOf(
  operation: string,
  o: PoolGroupGuardOptions,
): PoolGroupGuardOptions {
  if (o.confirmDropped === undefined) return {}
  if (!Array.isArray(o.confirmDropped))
    throw new CCTParamsInvalidError(operation, 'confirmDropped', 'must be an array')
  if (!o.confirmDropped.length) return {}
  return {
    confirmDropped: o.confirmDropped
      .map(({ lane, remotePools, flags }, i) => {
        const tokenAddress = parsePublicKey(
          operation,
          `confirmDropped[${i}].lane.tokenAddress`,
          Reflect.get(Object(lane), 'tokenAddress'),
        ).toBase58()
        return {
          lane: { tokenAddress, remoteChainSelector: lane.remoteChainSelector },
          ...(remotePools?.length && {
            remotePools: parseUniqueRemoteAddresses(
              operation,
              `confirmDropped[${i}].remotePools`,
              remotePools,
              lane.remoteChainSelector,
            ).sort(),
          }),
          ...(flags?.length && { flags: [...new Set(flags)].sort() }),
        }
      })
      .sort((a, b) => laneKey(a.lane).localeCompare(laneKey(b.lane))),
  }
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
