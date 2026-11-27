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
import { MAX_COMPUTE_UNIT_LIMIT, getMultipleAccountsInfoPaged } from '../../../solana/utils.ts'
import { canonicalHash, sealMultiTokenPoolSnapshot } from '../../canonical.ts'
import { CCTDataDecodeError, CCTParamsInvalidError, CCTStateChangedError } from '../../errors.ts'
import type { MultiTokenPoolInlineRemotePoolDrop } from '../../evm/pool-config-manager/contracts.ts'
import type { MultiTokenPoolLaneFinding, MultiTokenPoolSnapshot } from '../../multi-token-pool.ts'
import { parseUniqueRemoteAddresses } from '../../remote-address.ts'
import { parsePublicKey } from '../validate.ts'
import {
  type PoolGroupLaneState,
  type Unread,
  isUnread,
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
  failsClosed?: string
}

/** A lane's view; an unreadable lane throws (the guard never passes on a state it cannot read). */
function viewOf(state: PoolGroupLaneState | null | Unread, where: string): LaneView | null {
  if (state === null) return null
  if (isUnread(state)) throw new CCTDataDecodeError(where, { context: { reason: state.reason } })
  const unreadable = (u: Unread) => new CCTDataDecodeError(where, { context: { reason: u.reason } })
  const format = laneFormat(state)
  if (isUnread(format)) throw unreadable(format)
  const pools = laneRemotePools(state, format)
  if (isUnread(pools)) throw unreadable(pools)
  const fails = laneFailsClosed(state)
  if (isUnread(fails)) throw unreadable(fails)
  const trusted = pools.map(({ address, allowLegacyPoolData }) => ({
    address,
    allowLegacyPoolData,
  }))
  const { pausedOutbound, pausedInbound } = lanePauses(state)
  return {
    pools: trusted,
    outbound: !pausedOutbound && fails === undefined,
    inbound: !pausedInbound && fails === undefined && trusted.length > 0,
    ...(fails !== undefined && { failsClosed: fails }),
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
  /** Report error findings instead of refusing (the snapshot check). */
  reportFindings?: boolean
}

/** What a judged write reports. @internal */
export type PoolGroupJudgement = {
  /** Lanes whose state the write changes. */
  affectedLanes: PoolGroupLaneKey[]
  /** Lanes live in a direction after the write that were not before. */
  goingLive: PoolGroupLaneKey[]
  /** Warning findings. */
  warnings: MultiTokenPoolLaneFinding[]
  /** Every finding, errors included. */
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

/**
 * Runs the post-state guard of one pool-group write: simulates it, reads back the accounts it
 * writes, and judges every lane whose state one of them carries (its `ChainConfig`, `ChainConfigV2`,
 * group chain record or named policy records): A21 dropped trusted remote pools (refused unless in
 * `confirmDropped`), lanes going live (refused: no S3 write opens lanes), and lanes left failing
 * closed (refused, or a warning with `failsClosedSeverity: 'warning'`). Lanes are listed only when
 * the write changes a lane account; that listing needs `getProgramAccounts` and fails closed without
 * it.
 * @throws {@link CCTParamsInvalidError} if the simulation refuses the write, a drop is unconfirmed,
 *   a lane would go live, or an error finding remains (unless `reportFindings`)
 * @throws {@link CCTDataDecodeError} if an affected lane cannot be read before or after
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
  const [before, { slot, accounts: after }] = await Promise.all([
    getMultipleAccountsInfoPaged(chain.connection, writable),
    simulateWrite(input, writable),
  ])
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
      warnings: [],
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
  const findings: MultiTokenPoolLaneFinding[] = []
  const affectedLanes: PoolGroupLaneKey[] = []
  const goingLive: PoolGroupLaneKey[] = []
  const failingClosed: PoolGroupJudgement['failingClosed'] = []
  const dropped: MultiTokenPoolInlineRemotePoolDrop[] = []
  const inputs: unknown[] = []
  requests.forEach(({ mint, selector }, i) => {
    const key = { tokenAddress: mint.toBase58(), remoteChainSelector: selector }
    const where = `the lane of ${key.tokenAddress} toward ${selector}`
    const s0 = statesBefore[i] ?? null
    const s1 = statesAfter[i] ?? null
    const accountsOf = (s: typeof s0) =>
      s && !isUnread(s)
        ? [
            s.chainConfig.address,
            ...(s.v2 ? [s.v2.address] : []),
            ...(s.groupChain ? [s.groupChain.address] : []),
            ...[...s.named.values()].map((n) => n.address),
          ].map((a) => a.toBase58())
        : []
    const touches = [...accountsOf(s0), ...accountsOf(s1)].some((a) => changed.has(a))
    if (!touches) return
    affectedLanes.push(key)
    // a lane unreadable before the write is judged as nothing trusted and nothing live
    const v0 = isUnread(s0) ? null : viewOf(s0, where)
    const v1 = viewOf(s1, where)
    inputs.push({ lane: laneKey(key), before: v0 })
    const after1 = v1 ?? { pools: [], outbound: false, inbound: false }
    const before0 = v0 ?? { pools: [], outbound: false, inbound: false }
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
    if (v1?.failsClosed && v1.failsClosed !== v0?.failsClosed) {
      failingClosed.push({ ...key, reason: v1.failsClosed })
      const { check, recordType, fix } = laneFailsClosedFinding(v1.failsClosed)
      findings.push({
        check,
        severity: input.failsClosedSeverity ?? 'error',
        ...key,
        recordType,
        reason: `after the write every transfer on the lane reverts: ${v1.failsClosed}; ${fix}`,
      })
    }
  })

  assertDropsConfirmed(operation, dropped, input.confirmDropped ?? [])
  if (goingLive.length)
    throw new CCTParamsInvalidError(
      operation,
      'guards',
      `the write makes ${goingLive.length} lane(s) live (${goingLive.map(laneKey).join(', ')}), which this op does not check: make lanes live with the pause ops, which run the lane check`,
      { context: { goingLive } },
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
    warnings: findings.filter((f) => f.severity === 'warning'),
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
