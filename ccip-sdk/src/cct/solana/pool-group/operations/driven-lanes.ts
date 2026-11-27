/**
 * Driven lanes (S5): `set_group_chain_lanes`, `materialize_group_lanes`, `close_group_lanes`.
 * Program of record: chainlink-ccip-solana 7558722, `burnmint-token-pool/src/instructions/groups/`
 * `members.rs`, and `base-token-pool/src/groups.rs` (`apply_subset_updates`).
 *
 * A chain record's mode, subset and driven-lane pause decide which members' driven lanes transfer:
 * a write that admits members or lifts the pause on a running chain makes their lanes live (the
 * judge runs the lane check on each materialized one) or materializable by anyone (refused unless
 * acknowledged). Materialize and close are permissionless cranks: a lane the guard refuses is left
 * out and reported, the others are built. A close strands inbound in-flight messages, so each lane
 * must be paused outbound and confirmed drained, design §7.6 (the SDK gates only its own calls: a third
 * party can still crank a close once the record stops admitting a lane).
 *
 * @packageDocumentation
 */

import { BN } from '@coral-xyz/anchor'
import { type TransactionInstruction, PublicKey, SystemProgram } from '@solana/web3.js'

import type { SolanaChain } from '../../../../solana/index.ts'
import { deriveTokenPoolChainConfigV2Pda } from '../../../../solana/token-pool.ts'
import { getMultipleAccountsInfoPaged } from '../../../../solana/utils.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import type { SolanaGenerateParams } from '../../operation.ts'
import { deriveTokenPoolChainConfigPda } from '../../programs/token-pool.ts'
import {
  type GroupChainPolicyAccount,
  type PoolGroupMemberAccount,
  GROUP_CHAIN_POLICY_FIXED_LEN,
  decodePoolGroupMember,
  decodePoolGroupRegistry,
  poolGroupChainAdmits,
  poolGroupPdas,
} from '../accounts.ts'
import { decodeSections } from '../decode.ts'
import { type PoolGroupLaneState, isUnread } from '../lane.ts'
import { type PackPoolGroupInput, type PoolGroupPackItem, oneTransactionChecks } from '../packer.ts'
import { createPoolGroupProgram } from '../program.ts'
import type { PoolGroupLaneKey, PoolGroupLaneMode } from '../types.ts'
import { type PoolGroupWritePlan, PoolGroupWriteOperation } from '../write-operation.ts'
import type {
  ClosePoolGroupLanesParams,
  MaterializePoolGroupLanesParams,
  PoolGroupGuardOptions,
  SetPoolGroupChainLanesParams,
} from '../write-types.ts'
import {
  type ParsedPoolGroupRef,
  decodeOwned,
  decodeOwnedData,
  listPoolGroupMembers,
  parseTokenAddresses,
  readPoolGroup,
  validateSelector,
} from './common.ts'
import { listPoolGroupLaneRequests } from './get-pool-group-lane.ts'
import { readPoolGroupLaneStates } from './lane.ts'
import { meta } from './lanes.ts'
import {
  type CloseLaneEntry,
  chainRunsDriven,
  closeLaneEntry,
  memberChainsOf,
  requireAdmissionAcknowledged,
  requireDrained,
} from './members-common.ts'
import { closeLanesInstructions } from './membership.ts'
import {
  groupOfPausedLaneIx,
  pausedLaneInstructions,
  pausedLanePdas,
  pausedLanesOf,
} from './paused-lanes.ts'
import { requirePauseGate } from './pauses.ts'
import {
  type ParsedGroupWrite,
  bigField,
  byteArrayField,
  decodeOne,
  eventAccounts,
  everyLane,
  field,
  fittedItems,
  laneId,
  parseGroupWrite,
  parseLaneKeys,
  proposalBase,
  requireClassWriter,
  sealLanes,
  signerRole,
  unsealLanes,
} from './write-common.ts'

/**
 * Splits a bitmap write into the largest chunks one transaction carries, measured by the packer for
 * the real payer, budget and executor (binary search on the byte count; the probe instruction
 * carries the final mode, pause and index changes, the largest a chunk's instruction gets).
 * @throws {@link CCTParamsInvalidError} if not even one byte fits
 * @internal
 */
export async function bitmapChunks(
  operation: string,
  parsed: Pick<ParsedGroupWrite, 'payer' | 'budget' | 'durableNonces'>,
  bitmap: { byteOffset: number; bytes: Buffer },
  itemsOf: (write: { byteOffset: number; bytes: Buffer }) => Promise<PoolGroupPackItem[]>,
  chain: PackPoolGroupInput['chain'],
): Promise<{ byteOffset: number; bytes: Buffer }[]> {
  const { fits } = await oneTransactionChecks({
    operation,
    chain,
    payer: parsed.payer,
    items: [],
    ...(parsed.budget && { budget: parsed.budget }),
    ...(parsed.durableNonces && { durableNonces: parsed.durableNonces }),
  })
  const probe = async (n: number) =>
    fits(await itemsOf({ byteOffset: bitmap.byteOffset, bytes: bitmap.bytes.subarray(0, n) }))
  let lo = 0
  let hi = bitmap.bytes.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (await probe(mid)) lo = mid
    else hi = mid - 1
  }
  if (!lo)
    throw new CCTParamsInvalidError(
      operation,
      'bitmapWrite',
      'not even one bitmap byte fits a transaction with this payer and budget',
    )
  return Array.from({ length: Math.ceil(bitmap.bytes.length / lo) }, (_, i) => ({
    byteOffset: bitmap.byteOffset + i * lo,
    bytes: bitmap.bytes.subarray(i * lo, (i + 1) * lo),
  }))
}

const LANE_MODES: readonly PoolGroupLaneMode[] = ['off', 'all-members', 'subset']

/** A lane mode as the IDL enum value. */
const idlMode = (mode: PoolGroupLaneMode) =>
  mode === 'all-members' ? { allMembers: {} } : mode === 'subset' ? { subset: {} } : { off: {} }

const modeOf = (record: Pick<GroupChainPolicyAccount, 'laneMode'>): PoolGroupLaneMode =>
  'allMembers' in record.laneMode ? 'all-members' : 'subset' in record.laneMode ? 'subset' : 'off'

/** The record's subset bitmap. */
const bitmapOf = (data: Buffer) => Buffer.from(data.subarray(GROUP_CHAIN_POLICY_FIXED_LEN))

/** The members of the group, by mint (`getProgramAccounts`, fails closed). */
async function membersByMint(
  operation: string,
  chain: SolanaChain,
  ref: ParsedPoolGroupRef,
  fix: string,
): Promise<Map<string, PoolGroupMemberAccount>> {
  const list = await listPoolGroupMembers(operation, chain, ref.program, ref.group, {
    param: 'connection',
    fix,
  })
  return new Map(list.map(({ member }) => [member.mint, member]))
}

/** The members of `mints`, each a member of the group. */
async function namedMembers(
  operation: string,
  chain: SolanaChain,
  ref: ParsedPoolGroupRef,
  mints: readonly PublicKey[],
  param: string,
): Promise<PoolGroupMemberAccount[]> {
  const addresses = mints.map((m) => poolGroupPdas.groupMember(ref.program, m))
  const infos = await getMultipleAccountsInfoPaged(chain.connection, addresses)
  return mints.map((m, i) => {
    const info = infos[i]
    const member = info?.owner.equals(ref.program)
      ? decodePoolGroupMember(info.data, addresses[i]!.toBase58())
      : null
    if (!member || member.poolGroupAddress !== ref.group.toBase58())
      throw new CCTParamsInvalidError(
        operation,
        param,
        `${m.toBase58()} is not a member of this pool group (InvalidGroupMember)`,
      )
    return member
  })
}

/** The chain record, required. */
async function readChainRecord(
  operation: string,
  chain: SolanaChain,
  ref: ParsedPoolGroupRef,
  selector: bigint,
) {
  const address = poolGroupPdas.groupChain(ref.program, ref.group, selector)
  const registry = poolGroupPdas.groupRegistry(ref.program, ref.group)
  const { group, extras } = await readPoolGroup(operation, chain, ref, [address, registry])
  if (!extras[0])
    throw new CCTParamsInvalidError(
      operation,
      'remoteChainSelector',
      `the pool group has no chain record for ${selector}: add it with addPoolGroupChain`,
    )
  const record = decodeOwned('groupChainPolicy', extras[0], address, ref.program)
  const next = extras[1]
    ? decodePoolGroupRegistry(
        decodeOwnedData(extras[1], registry, ref.program),
        registry.toBase58(),
      ).nextMemberIndex
    : 0
  return { group, address, record, data: extras[0].data, registry, nextMemberIndex: next }
}

// ─── set_group_chain_lanes ───────────────────────────────────────────────────────────────────

type ParsedChainLanes = ParsedGroupWrite & {
  selector: bigint
  mode?: PoolGroupLaneMode
  paused?: boolean
  addTokens: PublicKey[]
  removeTokens: PublicKey[]
  addIndices: number[]
  removeIndices: number[]
  bitmap?: { byteOffset: number; bytes: Buffer }
  acknowledgeNonAtomic: boolean
  acknowledged: PoolGroupLaneKey[]
  createLanesPaused: boolean
}

/** An optional boolean param (`undefined` is false). */
function parseFlag(operation: string, param: string, value: unknown): boolean {
  if (value !== undefined && typeof value !== 'boolean')
    throw new CCTParamsInvalidError(operation, param, 'must be a boolean')
  return value === true
}

/** Parses a list of `u32` member indices. */
function parseIndices(operation: string, param: string, value: unknown): number[] {
  if (value === undefined) return []
  if (
    !Array.isArray(value) ||
    value.some((v) => typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 0xffff_ffff)
  )
    throw new CCTParamsInvalidError(operation, param, 'must be an array of u32 member indices')
  return value.filter((v): v is number => typeof v === 'number')
}

/**
 * Pre-flights indices and a bitmap write against the program's bounds (`apply_subset_updates`):
 * indices below `nextMemberIndex`; `byteOffset + length <= ceil(nextMemberIndex / 8)`; the spare bits
 * of the last member byte clear.
 * @throws {@link CCTParamsInvalidError} otherwise (`InvalidMemberIndex`)
 * @internal
 */
export function checkSubsetBounds(
  operation: string,
  nextMemberIndex: number,
  indices: { param: string; values: readonly number[] }[],
  bitmap?: { byteOffset: number; bytes: Uint8Array },
): void {
  for (const { param, values } of indices)
    for (const v of values)
      if (v >= nextMemberIndex)
        throw new CCTParamsInvalidError(
          operation,
          param,
          `member index ${v} is not below the next member index ${nextMemberIndex} (InvalidMemberIndex)`,
        )
  if (!bitmap) return
  const memberBytes = Math.ceil(nextMemberIndex / 8)
  const end = bitmap.byteOffset + bitmap.bytes.length
  if (end > memberBytes)
    throw new CCTParamsInvalidError(
      operation,
      'bitmapWrite',
      `the write ends at byte ${end}, past the ${memberBytes} byte(s) the ${nextMemberIndex} member index(es) use (InvalidMemberIndex)`,
    )
  if (end === memberBytes && nextMemberIndex % 8 !== 0) {
    const spare = ~((1 << (nextMemberIndex % 8)) - 1) & 0xff
    const last = bitmap.bytes[bitmap.bytes.length - 1]
    if (last !== undefined && (last & spare) !== 0)
      throw new CCTParamsInvalidError(
        operation,
        'bitmapWrite',
        `the last byte sets bits from index ${nextMemberIndex} on, which no member holds yet (InvalidMemberIndex)`,
      )
  }
}

/** The subset bitmap after the program's update (`apply_subset_updates` order). @internal */
export function applySubset(
  bitmap: Buffer,
  write: { byteOffset: number; bytes: Uint8Array } | undefined,
  remove: readonly number[],
  add: readonly number[],
): Buffer {
  let out = Buffer.from(bitmap)
  if (write) {
    const end = write.byteOffset + write.bytes.length
    if (out.length < end) out = Buffer.concat([out, Buffer.alloc(end - out.length)])
    Buffer.from(write.bytes).copy(out, write.byteOffset)
  }
  for (const i of remove) if (out[i >> 3] !== undefined) out[i >> 3]! &= ~(1 << (i & 7)) & 0xff
  for (const i of add) {
    if (out.length <= i >> 3) out = Buffer.concat([out, Buffer.alloc((i >> 3) + 1 - out.length)])
    out[i >> 3]! |= 1 << (i & 7)
  }
  return out
}

/** Whether a record in `mode` with `bitmap` admits `index`. */
const admits = (mode: PoolGroupLaneMode, bitmap: Buffer, index: number) =>
  mode === 'all-members' ||
  (mode === 'subset' && ((bitmap[index >> 3] ?? 0) >> (index & 7)) & 1) === 1

/** Sets a chain record's driven lanes: mode, pause, subset (merged and snapshotted). */
export class SetPoolGroupChainLanes extends PoolGroupWriteOperation<
  SetPoolGroupChainLanesParams,
  ParsedChainLanes
> {
  readonly name = 'setPoolGroupChainLanes'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(
    params: SolanaGenerateParams<SetPoolGroupChainLanesParams>,
  ): ParsedChainLanes {
    const mode: unknown = params.laneMode
    if (mode !== undefined && !(LANE_MODES as unknown[]).includes(mode))
      throw new CCTParamsInvalidError(
        this.name,
        'laneMode',
        "must be 'off', 'all-members' or 'subset'",
      )
    const paused: unknown = params.drivenLanesPaused
    if (paused !== undefined && typeof paused !== 'boolean')
      throw new CCTParamsInvalidError(this.name, 'drivenLanesPaused', 'must be a boolean')
    const ack: unknown = params.acknowledgeNonAtomicBitmapWrite
    if (ack !== undefined && typeof ack !== 'boolean')
      throw new CCTParamsInvalidError(
        this.name,
        'acknowledgeNonAtomicBitmapWrite',
        'must be a boolean',
      )
    let bitmap: ParsedChainLanes['bitmap']
    if (params.bitmapWrite !== undefined) {
      const { byteOffset, bytes } = params.bitmapWrite
      if (
        !Number.isInteger(byteOffset) ||
        byteOffset < 0 ||
        !(bytes instanceof Uint8Array) ||
        !bytes.length
      )
        throw new CCTParamsInvalidError(
          this.name,
          'bitmapWrite',
          'must be { byteOffset: non-negative integer, bytes: non-empty Uint8Array }',
        )
      bitmap = { byteOffset, bytes: Buffer.from(bytes) }
    }
    return {
      ...parseGroupWrite(this.name, params),
      selector: validateSelector(this.name, 'remoteChainSelector', params.remoteChainSelector),
      ...(mode !== undefined && { mode: params.laneMode }),
      ...(typeof paused === 'boolean' && { paused }),
      addTokens: parseTokenAddresses(this.name, params.addTokens) ?? [],
      removeTokens: parseTokenAddresses(this.name, params.removeTokens) ?? [],
      addIndices: parseIndices(this.name, 'addMemberIndices', params.addMemberIndices),
      removeIndices: parseIndices(this.name, 'removeMemberIndices', params.removeMemberIndices),
      ...(bitmap && { bitmap }),
      acknowledgeNonAtomic: ack === true,
      acknowledged: parseLaneKeys(
        this.name,
        'acknowledgeLiveAdmission',
        params.acknowledgeLiveAdmission,
      ),
      createLanesPaused: parseFlag(this.name, 'createLanesPaused', params.createLanesPaused),
    }
  }

  /** `set_lane_pause` names the pool group second; the other instructions name it first. */
  protected override proposalGroup(ix: TransactionInstruction): PublicKey | undefined {
    return groupOfPausedLaneIx(ix)
  }

  /**
   * `set_group_chain_lanes` with every field merged from the record; a bitmap write larger than one
   * transaction is split over instructions (the earlier ones keep the record's mode and pause, the
   * last carries the final mode, pause and index changes). Lanes it makes live run the lane check
   * as the write leaves them; members it makes materializable on a running chain need
   * `acknowledgeLiveAdmission`, unless `createLanesPaused` creates them paused in the same
   * transaction (S6 review M6).
   * @throws {@link CCTParamsInvalidError} if `authority` lacks the gate (CONNECTION writer for lane
   *   changes; pauser or unpauser for the pause), a bound is broken, enabling from `'off'` is not
   *   paused (`GroupLanesMustStartPaused`), the chain trusts no remote pool, a split bitmap write on
   *   a running chain is not acknowledged, an admission is not acknowledged, or a guard refuses
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedChainLanes,
  ): Promise<PoolGroupWritePlan<object>> {
    const { ref, authority, selector } = parsed
    const { group, address, record, data, registry, nextMemberIndex } = await readChainRecord(
      this.name,
      chain,
      ref,
      selector,
    )
    const before = {
      mode: modeOf(record),
      paused: record.drivenLanesPaused,
      bitmap: bitmapOf(data),
    }
    const mode = parsed.mode ?? before.mode
    const paused = parsed.paused ?? before.paused
    const named = [...parsed.addTokens, ...parsed.removeTokens]
    const members = named.length
      ? await namedMembers(this.name, chain, ref, named, 'addTokens')
      : []
    const indexOf = (m: PublicKey) => members.find((x) => x.mint === m.toBase58())!.memberIndex
    const add = [...parsed.addIndices, ...parsed.addTokens.map(indexOf)]
    const remove = [...parsed.removeIndices, ...parsed.removeTokens.map(indexOf)]
    checkSubsetBounds(
      this.name,
      nextMemberIndex,
      [
        { param: 'addMemberIndices', values: add },
        { param: 'removeMemberIndices', values: remove },
      ],
      parsed.bitmap,
    )
    const lanesChange =
      mode !== before.mode || !!parsed.bitmap || add.length > 0 || remove.length > 0
    if (lanesChange)
      requireClassWriter(this.name, group, authority, 'connection', 'set_group_chain_lanes')
    if (paused !== before.paused)
      requirePauseGate(
        this.name,
        group,
        authority,
        [before.paused],
        [paused],
        'set_group_chain_lanes',
      )
    if (before.mode === 'off' && mode !== 'off' && !paused)
      throw new CCTParamsInvalidError(
        this.name,
        'drivenLanesPaused',
        "enabling a chain from 'off' must pause its driven lanes (GroupLanesMustStartPaused): materialize and check them, then unpause",
      )
    if (
      mode !== 'off' &&
      !decodeSections(record.policy, 0n, selector).connection.remotePools.length
    )
      throw new CCTParamsInvalidError(
        this.name,
        'laneMode',
        `the chain record trusts no remote pool (GroupChainHasNoRemotePools): set its CONNECTION pools first (setPoolGroupChainPolicy)`,
      )
    const after = applySubset(before.bitmap, parsed.bitmap, remove, add)
    const runningAfter = chainRunsDriven({ ...record, drivenLanesPaused: paused })
    // members it makes materializable (or live) on a running chain: their lanes go live with no
    // further write of theirs
    // every flag the admission gate reads, and the acknowledgement, are sealed (S5 review M1)
    const expected = {
      [`groupChain.${selector}.laneMode`]: before.mode,
      [`groupChain.${selector}.drivenLanesPaused`]: before.paused,
      [`groupChain.${selector}.pauses`]: [
        record.groupPaused,
        record.pausedOutbound,
        record.pausedInbound,
      ],
      [`groupChain.${selector}.bitmap`]: before.bitmap.toString('hex'),
      'registry.nextMemberIndex': nextMemberIndex,
      ...sealLanes('acknowledgeLiveAdmission', parsed.acknowledged),
    }
    if (!lanesChange && paused === before.paused)
      return { group: ref.group, items: [], judge: null, expected, extra: {} }
    let admitted: PoolGroupLaneKey[] = []
    let createPaused: PoolGroupLaneKey[] = []
    const opens =
      runningAfter &&
      (!chainRunsDriven(record) ||
        Array.from({ length: nextMemberIndex }, (_, i) => i).some(
          (i) => admits(mode, after, i) && !admits(before.mode, before.bitmap, i),
        ))
    if (opens) {
      const all = await membersByMint(
        this.name,
        chain,
        ref,
        'finding the members this write admits needs it; use an RPC that serves getProgramAccounts',
      )
      const opened = [...all.values()].filter(
        (m) =>
          memberChainsOf(m).has(selector) &&
          admits(mode, after, m.memberIndex) &&
          (!chainRunsDriven(record) || !admits(before.mode, before.bitmap, m.memberIndex)),
      )
      const key = (m: PoolGroupMemberAccount) => ({
        tokenAddress: m.mint,
        remoteChainSelector: selector,
      })
      const hasLane = (m: PoolGroupMemberAccount) =>
        m.lanePayers.some((p) => p.remoteChainSelector === selector)
      if (parsed.createLanesPaused) {
        createPaused = opened.filter((m) => !hasLane(m)).map(key)
        admitted = opened.filter(hasLane).map(key)
      } else admitted = opened.map(key)
      requireAdmissionAcknowledged(this.name, admitted, parsed.acknowledged)
    }
    if (createPaused.length)
      requirePauseGate(this.name, group, authority, [false, false], [true, true], 'set_lane_pause')
    const client = createPoolGroupProgram(chain, ref.program, parsed.payer)
    const ixOf = (args: {
      mode: PoolGroupLaneMode
      paused: boolean
      bitmapWrite: { byteOffset: number; bytes: Buffer } | null
      remove: number[]
      add: number[]
    }) =>
      client.methods
        .setGroupChainLanes(new BN(selector.toString()), {
          mode: idlMode(args.mode),
          drivenLanesPaused: args.paused,
          bitmapWrite: args.bitmapWrite,
          remove: args.remove,
          add: args.add,
        })
        .accountsStrict({
          group: ref.group,
          groupChainPolicy: address,
          groupRegistry: registry,
          authority,
          systemProgram: SystemProgram.programId,
          ...eventAccounts(ref.program),
        })
        .instruction()
    // chunks sized by the packer's own measurement of the real transaction (payer, budget,
    // executor, compute budget): the largest byte count whose instruction fits (S5 review M6)
    const chunks = parsed.bitmap
      ? await bitmapChunks(
          this.name,
          parsed,
          parsed.bitmap,
          async (bytes) => [
            {
              tokenAddresses: [],
              instructions: [await ixOf({ mode, paused, bitmapWrite: bytes, remove, add })],
              signerRoles: { [authority.toBase58()]: signerRole(group.owner, authority) },
            },
          ],
          chain,
        )
      : []
    if (chunks.length > 1 && createPaused.length)
      throw new CCTParamsInvalidError(
        this.name,
        'createLanesPaused',
        'the lanes are created in the transaction that admits them, which a split bitmap write is not: admit them with addTokens',
      )
    if (
      chunks.length > 1 &&
      (runningAfter || chainRunsDriven(record)) &&
      !parsed.acknowledgeNonAtomic
    )
      throw new CCTParamsInvalidError(
        this.name,
        'acknowledgeNonAtomicBitmapWrite',
        `the bitmap write takes ${chunks.length} transactions, and the chain's driven lanes run between them: pause them first, or pass acknowledgeNonAtomicBitmapWrite`,
      )
    const ixs: TransactionInstruction[] = []
    for (const [i, c] of chunks.entries())
      if (i < chunks.length - 1)
        ixs.push(
          await ixOf({
            mode: before.mode,
            paused: before.paused,
            bitmapWrite: c,
            remove: [],
            add: [],
          }),
        )
    ixs.push(
      await ixOf({ mode, paused, bitmapWrite: chunks[chunks.length - 1] ?? null, remove, add }),
    )
    // the admission and every lane it opens are one transaction: no slot to materialize unpaused
    const pausedIxs = createPaused.length
      ? [
          ...(
            await pausedLaneInstructions(chain, ref, parsed.payer, authority, createPaused)
          ).values(),
        ].flat()
      : []
    const signerRoles = { [authority.toBase58()]: signerRole(group.owner, authority) }
    return {
      group: ref.group,
      items: ixs.map((ix, i) => ({
        tokenAddresses:
          i === ixs.length - 1 ? [...new Set(createPaused.map((l) => l.tokenAddress))] : [],
        instructions: i === ixs.length - 1 ? [ix, ...pausedIxs] : [ix],
        signerRoles,
        ...(i === ixs.length - 1 &&
          createPaused.length && { createdPdas: pausedLanePdas(ref.program, createPaused) }),
      })),
      judge: { failsClosedSeverity: 'error' },
      judgeEach: ixs.length > 1,
      expected: { ...expected, ...sealLanes('createLanesPaused', createPaused) },
      goingLive: admitted,
      extra: {},
    }
  }

  /** The record a proposal writes (its last instruction's mode and pause; every index and byte). */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
    sealed: Readonly<Record<string, unknown>>,
  ): ParsedChainLanes {
    const decoded = decodeOne(
      this.name,
      instructions,
      ['setGroupChainLanes', 'materializeGroupLanes', 'setLanePause'],
      false,
    )
    const ixs = decoded.filter((d) => d.name === 'setGroupChainLanes')
    const last = ixs[ixs.length - 1]
    if (!last)
      throw new CCTParamsInvalidError(this.name, 'transactions', 'the proposal sets no chain lanes')
    const createLanesPaused = decoded.some((d) => d.name === 'materializeGroupLanes')
    if (createLanesPaused) {
      const created = pausedLanesOf(ref.program, decoded).map(laneId).sort()
      const sealedLanes = unsealLanes(sealed, 'createLanesPaused').map(laneId).sort()
      if (created.join() !== sealedLanes.join())
        throw new CCTParamsInvalidError(
          this.name,
          'transactions',
          'the proposal creates lanes it does not pause both ways, or other lanes than it sealed',
        )
    }
    const rawMode = field(last.data, 'params', 'mode')
    const mode: PoolGroupLaneMode =
      typeof rawMode === 'object' && rawMode !== null && 'allMembers' in rawMode
        ? 'all-members'
        : typeof rawMode === 'object' && rawMode !== null && 'subset' in rawMode
          ? 'subset'
          : 'off'
    const writes = ixs.flatMap((d) => {
      const w = field(d.data, 'params', 'bitmapWrite')
      return w
        ? [
            {
              byteOffset: Number(field(w, 'byteOffset') ?? 0),
              bytes: Buffer.from(byteArrayField(field(w, 'bytes'))),
            },
          ]
        : []
    })
    const bitmap = writes.length
      ? { byteOffset: writes[0]!.byteOffset, bytes: Buffer.concat(writes.map((w) => w.bytes)) }
      : undefined
    const indices = (name: 'add' | 'remove') =>
      ixs.flatMap((d) => {
        const v = field(d.data, 'params', name)
        return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : []
      })
    return {
      ...proposalBase(ref, last.ix.keys[3]!.pubkey, guardOptions),
      selector: bigField(field(last.data, 'remoteChainSelector')) ?? 0n,
      mode,
      paused: field(last.data, 'params', 'drivenLanesPaused') === true,
      addTokens: [],
      removeTokens: [],
      addIndices: indices('add'),
      removeIndices: indices('remove'),
      ...(bitmap && { bitmap }),
      acknowledgeNonAtomic: true,
      // the gate runs again with what the caller acknowledged when the proposal was built
      acknowledged: unsealLanes(sealed, 'acknowledgeLiveAdmission'),
      createLanesPaused,
    }
  }
}

// ─── materialize_group_lanes ─────────────────────────────────────────────────────────────────

type ParsedMaterialize = ParsedGroupWrite & {
  selector: bigint
  mints?: PublicKey[] | { members: PublicKey[] }
  resync: boolean
}

/** Creates the driven lanes the group admits (permissionless), and re-syncs existing ones. */
export class MaterializePoolGroupLanes extends PoolGroupWriteOperation<
  MaterializePoolGroupLanesParams,
  ParsedMaterialize
> {
  readonly name = 'materializePoolGroupLanes'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(
    params: SolanaGenerateParams<MaterializePoolGroupLanesParams>,
  ): ParsedMaterialize {
    const resync: unknown = params.resync
    if (resync !== undefined && typeof resync !== 'boolean')
      throw new CCTParamsInvalidError(this.name, 'resync', 'must be a boolean')
    const mints = parseTokenAddresses(this.name, params.tokenAddresses)
    return {
      ...parseGroupWrite(this.name, params),
      selector: validateSelector(this.name, 'remoteChainSelector', params.remoteChainSelector),
      ...(mints && { mints }),
      resync: resync === true,
    }
  }

  /** `materialize_group_lanes` names the group first, then the chain record. */
  protected override proposalGroup(ix: TransactionInstruction): PublicKey | undefined {
    return ix.keys[0]?.pubkey
  }

  /**
   * `materialize_group_lanes`, as many lanes per instruction as fit (per lane: `GroupMember`,
   * `ChainConfig`, `ChainConfigV2`). Without `tokenAddresses`, every admitted member that lists the
   * chain and has no lane yet (with `resync`, also driven lanes whose remote token or decimals
   * differ from the member's). A lane created on a running chain is live at once: the lane check
   * runs on it; a refused lane is left out and reported.
   * @throws {@link CCTParamsInvalidError} if a member is not the group's, is not admitted
   *   (`GroupLaneNotEnabled`), does not list the chain (`MemberRemoteTokenMissing`), its payer
   *   entries disagree with its lanes, a re-sync is asked on a running chain (the program defers
   *   it), or every lane is refused
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedMaterialize,
  ): Promise<PoolGroupWritePlan<object>> {
    const { ref, selector } = parsed
    const { address, record, data, registry } = await readChainRecord(
      this.name,
      chain,
      ref,
      selector,
    )
    const excluded = new Set((parsed.excludedLanes ?? []).map((l) => l.tokenAddress))
    const named = parsed.mints
    const explicit = Array.isArray(named)
    const members = named
      ? Array.isArray(named)
        ? await namedMembers(this.name, chain, ref, named, 'tokenAddresses')
        : await namedMembers(
            this.name,
            chain,
            ref,
            await mintsOfMembers(chain, ref, named.members),
            'transactions',
          )
      : [
          ...(
            await membersByMint(
              this.name,
              chain,
              ref,
              'listing the members to materialize needs it; pass tokenAddresses, or use an RPC that serves getProgramAccounts',
            )
          ).values(),
        ]
    const states = await readPoolGroupLaneStates(
      chain,
      ref.program,
      members.map((m) => ({ mint: new PublicKey(m.mint), selector })),
    )
    // the program re-syncs only under driven_lanes_paused (members.rs:630), not under a group pause
    if (parsed.resync && !record.drivenLanesPaused)
      throw new CCTParamsInvalidError(
        this.name,
        'resync',
        "a re-sync applies only while the chain's driven lanes are paused (the program skips it silently otherwise): pause them with setPoolGroupChainLanes drivenLanesPaused, then re-sync",
      )
    const lanes: {
      mint: PublicKey
      member: PoolGroupMemberAccount
      metas: ReturnType<typeof meta>[]
    }[] = []
    const skipped: { tokenAddress: string; reason: string }[] = []
    members.forEach((m, i) => {
      if (excluded.has(m.mint)) return
      const mint = new PublicKey(m.mint)
      const where = `the driven lane of ${m.mint} toward ${selector}`
      const s = states[i]
      const listed = memberChainsOf(m).get(selector)
      const admitted = poolGroupChainAdmits(record, data, m.memberIndex)
      const paid = m.lanePayers.some((p) => p.remoteChainSelector === selector)
      if (!s) {
        // a new lane: admitted, listed, and no payer entry left behind (InvalidGroupMember)
        if (!admitted || !listed) {
          if (!explicit) return
          throw new CCTParamsInvalidError(
            this.name,
            'tokenAddresses',
            !admitted
              ? `${where} is not admitted by the chain record (GroupLaneNotEnabled): admit it with setPoolGroupChainLanes`
              : `${m.mint} does not list chain ${selector} (MemberRemoteTokenMissing): add it with setPoolGroupMemberRemoteTokens`,
          )
        }
        if (paid) {
          const reason = `${m.mint} records a payer for chain ${selector} but has no lane there: its member account disagrees with its lanes (InvalidGroupMember)`
          // a crank never aborts on one inconsistent member (S5 review m2)
          if (!explicit) {
            skipped.push({ tokenAddress: m.mint, reason })
            return
          }
          throw new CCTParamsInvalidError(this.name, 'tokenAddresses', reason)
        }
      } else {
        if (isUnread(s) || s.kind !== 'driven' || s.ext?.memberIndex !== m.memberIndex) {
          // a hand-made lane keeps precedence: the program leaves it alone
          if (explicit && !parsed.resync)
            chain.logger.warn(
              `${this.name}: ${where} exists and is not this member's driven lane: skipped`,
            )
          return
        }
        if (!parsed.resync || !listed) return
        const remote = s.chainConfig.base.remote
        if (
          Buffer.from(remote.tokenAddress.address).equals(listed.token) &&
          remote.decimals === listed.decimals
        )
          return
        if (!paid) {
          const reason = `${m.mint} has a driven lane toward ${selector} but records no payer for it (InvalidGroupMember)`
          if (!explicit) {
            skipped.push({ tokenAddress: m.mint, reason })
            return
          }
          throw new CCTParamsInvalidError(this.name, 'tokenAddresses', reason)
        }
      }
      if (!admitted) return
      lanes.push({
        mint,
        member: m,
        metas: [
          meta(poolGroupPdas.groupMember(ref.program, mint), true),
          meta(deriveTokenPoolChainConfigPda(ref.program, selector, mint), true),
          meta(deriveTokenPoolChainConfigV2Pda(ref.program, selector, mint), true),
        ],
      })
    })
    const expected = {
      [`groupChain.${selector}.admission`]: [
        modeOf(record),
        record.drivenLanesPaused,
        bitmapOf(data).toString('hex'),
      ],
    }
    const findings = skipped.map((x) => ({
      check: 'LANE_UNREADABLE' as const,
      severity: 'warning' as const,
      tokenAddress: x.tokenAddress,
      remoteChainSelector: selector,
      reason: `${x.reason}; left out of the crank`,
    }))
    if (!lanes.length)
      return { group: ref.group, items: [], judge: null, expected, extra: {}, findings }
    const client = createPoolGroupProgram(chain, ref.program, parsed.payer)
    const items = await fittedItems(
      this.name,
      chain,
      parsed,
      lanes,
      (chunk) =>
        client.methods
          .materializeGroupLanes(new BN(selector.toString()))
          .accountsStrict({
            group: ref.group,
            groupChainPolicy: address,
            groupRegistry: registry,
            authority: parsed.authority,
            systemProgram: SystemProgram.programId,
            ...eventAccounts(ref.program),
          })
          .remainingAccounts(chunk.flatMap((l) => l.metas))
          .instruction(),
      {
        signerRoles: { [parsed.authority.toBase58()]: 'payer' },
        tokenAddressesOf: (chunk) => chunk.map((l) => l.mint.toBase58()),
        describe: (l) => `the lane of ${l.mint.toBase58()}`,
      },
    )
    return {
      group: ref.group,
      items: items.map((item) => ({
        ...item,
        createdPdas: item.tokenAddresses.flatMap((m) => {
          const mint = new PublicKey(m)
          return [
            deriveTokenPoolChainConfigPda(ref.program, selector, mint),
            deriveTokenPoolChainConfigV2Pda(ref.program, selector, mint),
          ]
        }),
      })),
      judge: { failsClosedSeverity: 'error' },
      judgeEach: true,
      expected,
      extra: {},
      findings,
      partition: {
        operation: this.name,
        inputs: (left) => ({
          remoteChainSelector: selector,
          tokenAddresses: left.map((l) => l.tokenAddress),
        }),
      },
    }
  }

  /** The members a proposal materializes (per lane: `GroupMember` first, after 7 accounts). */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedMaterialize {
    const ixs = decodeOne(this.name, instructions, ['materializeGroupLanes'], false)
    const first = ixs[0]!
    return {
      ...proposalBase(ref, first.ix.keys[3]!.pubkey, guardOptions),
      selector: bigField(field(first.data, 'remoteChainSelector')) ?? 0n,
      mints: { members: everyLane(ixs, 7, 3) },
      resync: false,
    }
  }
}

/** The mints of `GroupMember` accounts a proposal names. */
async function mintsOfMembers(
  chain: SolanaChain,
  ref: ParsedPoolGroupRef,
  members: readonly PublicKey[],
): Promise<PublicKey[]> {
  const infos = await getMultipleAccountsInfoPaged(chain.connection, [...members])
  return members.map((a, i) => {
    const info = infos[i]
    if (!info?.owner.equals(ref.program))
      throw new CCTParamsInvalidError(
        'materializePoolGroupLanes',
        'transactions',
        `${a.toBase58()} is not a GroupMember`,
      )
    return new PublicKey(decodePoolGroupMember(info.data, a.toBase58()).mint)
  })
}

// ─── close_group_lanes ───────────────────────────────────────────────────────────────────────

type ParsedCloseLanes = ParsedGroupWrite & {
  selector: bigint
  mints?: PublicKey[] | { members: PublicKey[] }
  confirmInFlightDrained: PoolGroupLaneKey[]
}

/** Closes driven lanes the group no longer admits or the member no longer lists (permissionless). */
export class ClosePoolGroupLanes extends PoolGroupWriteOperation<
  ClosePoolGroupLanesParams,
  ParsedCloseLanes
> {
  readonly name = 'closePoolGroupLanes'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(
    params: SolanaGenerateParams<ClosePoolGroupLanesParams>,
  ): ParsedCloseLanes {
    const mints = parseTokenAddresses(this.name, params.tokenAddresses)
    return {
      ...parseGroupWrite(this.name, params),
      selector: validateSelector(this.name, 'remoteChainSelector', params.remoteChainSelector),
      ...(mints && { mints }),
      confirmInFlightDrained: parseLaneKeys(
        this.name,
        'confirmInFlightDrained',
        params.confirmInFlightDrained,
      ),
    }
  }

  /**
   * `close_group_lanes`, as many lanes per instruction as fit: the named records the lanes
   * reference, the group owner's wallet, then per lane its member, `ChainConfig`, `ChainConfigV2`,
   * FTF override, payer and the member's rent receiver. Without `tokenAddresses`, every closable
   * driven lane of the chain (`getProgramAccounts`).
   * @throws {@link CCTParamsInvalidError} if a lane is not a driven lane of the group, is still
   *   enabled (`GroupLaneStillEnabled`), has no payer entry, is not paused outbound and
   *   confirmed drained, or every lane is refused
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedCloseLanes,
  ): Promise<PoolGroupWritePlan<object>> {
    const { ref, selector } = parsed
    const { group, record, data } = await readChainRecord(this.name, chain, ref, selector)
    const excluded = new Set((parsed.excludedLanes ?? []).map((l) => l.tokenAddress))
    const named = parsed.mints
    const explicit = !!named
    const mints = named
      ? Array.isArray(named)
        ? named
        : await mintsOfMembers(chain, ref, named.members)
      : (
          await listPoolGroupLaneRequests(
            this.name,
            chain,
            { program: ref.program, group: ref.group, selector, kind: 'driven' },
            {
              fix: 'listing the lanes to close needs it; pass tokenAddresses, or use an RPC that serves getProgramAccounts',
            },
          )
        ).map((r) => r.mint)
    const members = await namedMembers(this.name, chain, ref, mints, 'tokenAddresses')
    const states = await readPoolGroupLaneStates(
      chain,
      ref.program,
      mints.map((mint) => ({ mint, selector })),
    )
    const lanes: { entry: CloseLaneEntry; state: PoolGroupLaneState }[] = []
    members.forEach((m, i) => {
      if (excluded.has(m.mint)) return
      const where = `the driven lane of ${m.mint} toward ${selector}`
      const s = states[i]
      if (!s || isUnread(s) || s.kind !== 'driven' || s.ext?.memberIndex !== m.memberIndex) {
        if (!explicit) return
        throw new CCTParamsInvalidError(
          this.name,
          'tokenAddresses',
          `${where} is not a driven lane of this member (NotGroupDrivenLane)${s && isUnread(s) ? `: ${s.reason}` : ''}`,
        )
      }
      const enabled =
        poolGroupChainAdmits(record, data, m.memberIndex) && memberChainsOf(m).has(selector)
      if (enabled) {
        if (!explicit) return
        throw new CCTParamsInvalidError(
          this.name,
          'tokenAddresses',
          `${where} is still enabled (GroupLaneStillEnabled): the chain record must stop admitting it, or the member drop the chain`,
        )
      }
      lanes.push({ entry: closeLaneEntry(this.name, ref.program, m, s), state: s })
    })
    requireDrained(
      this.name,
      lanes.map((l) => ({ key: l.entry.key, state: l.state })),
      parsed.confirmInFlightDrained,
    )
    // the pauses the drain gate reads, and the confirmation, are sealed (S5 review M1)
    const expected = {
      [`groupChain.${selector}.admission`]: [modeOf(record), bitmapOf(data).toString('hex')],
      [`groupChain.${selector}.pauses`]: [
        record.groupPaused,
        record.drivenLanesPaused,
        record.pausedOutbound,
        record.pausedInbound,
      ],
      [`lanes.${selector}.closing`]: lanes.map((l) => laneId(l.entry.key)),
      [`lanes.${selector}.pauses`]: lanes.map((l) => [
        laneId(l.entry.key),
        !!l.state.ext?.pausedOutbound,
        !!l.state.ext?.pausedInbound,
      ]),
      ...sealLanes('confirmInFlightDrained', parsed.confirmInFlightDrained),
    }
    if (!lanes.length) return { group: ref.group, items: [], judge: null, expected, extra: {} }
    const items = await fittedItems(
      this.name,
      chain,
      parsed,
      lanes.map((l) => l.entry),
      async (chunk) =>
        (
          await closeLanesInstructions(
            chain,
            ref,
            parsed.payer,
            parsed.authority,
            group.owner,
            chunk,
          )
        )[0]!,
      {
        signerRoles: { [parsed.authority.toBase58()]: 'payer' },
        tokenAddressesOf: (chunk) => chunk.map((l) => l.mint.toBase58()),
        describe: (l) => `the lane of ${l.mint.toBase58()}`,
      },
    )
    return {
      group: ref.group,
      items,
      judge: { failsClosedSeverity: 'error', drainConfirmed: lanes.map((l) => l.entry.key) },
      judgeEach: true,
      expected,
      extra: {},
      partition: {
        operation: this.name,
        inputs: (left) => ({
          remoteChainSelector: selector,
          tokenAddresses: left.map((l) => l.tokenAddress),
        }),
      },
    }
  }

  /** The lanes a proposal closes (after 7 accounts, the records and the owner's wallet). */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
    sealed: Readonly<Record<string, unknown>>,
  ): ParsedCloseLanes {
    const ixs = decodeOne(this.name, instructions, ['closeGroupLanes'], false)
    const first = ixs[0]!
    const members = ixs.flatMap((d) => {
      const records = Number(bigField(field(d.data, 'params', 'recordCount')) ?? 0)
      return everyLane([d], 7 + records + 1, 6)
    })
    return {
      ...proposalBase(ref, first.ix.keys[3]!.pubkey, guardOptions),
      selector: bigField(field(first.data, 'remoteChainSelector')) ?? 0n,
      mints: { members },
      confirmInFlightDrained: unsealLanes(sealed, 'confirmInFlightDrained'),
    }
  }
}

/** The driven-lane ops, by name: the snapshot check runs their re-checks. @internal */
export const POOL_GROUP_DRIVEN_LANE_OPERATIONS = {
  setPoolGroupChainLanes: new SetPoolGroupChainLanes(),
  materializePoolGroupLanes: new MaterializePoolGroupLanes(),
  closePoolGroupLanes: new ClosePoolGroupLanes(),
} as const
