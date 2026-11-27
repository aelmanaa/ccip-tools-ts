/**
 * Pool-group pauses (S4): `set_group_pause`, `set_group_chain_pause`, `set_lane_pause`. Program of
 * record: chainlink-ccip-solana 7558722, `burnmint-token-pool/src/instructions/groups/pause.rs`.
 *
 * A pause is the emergency action: it is simulated but never judged, so it never needs
 * `getProgramAccounts` and never refuses on what is wrong with the lanes it stops (as on EVM). A
 * write that clears a flag makes lanes live, so it runs the shared write guard, whose make-live
 * check runs the lane check on every lane it makes live as the write leaves it. An omitted direction
 * keeps its current flag, which the snapshot records, so a stale proposal never lifts a pause set by
 * someone else meanwhile without the snapshot check reporting it.
 *
 * @packageDocumentation
 */

import { BN } from '@coral-xyz/anchor'
import {
  type AccountMeta,
  type TransactionInstruction,
  PublicKey,
  SystemProgram,
} from '@solana/web3.js'

import type { SolanaChain } from '../../../../solana/index.ts'
import { deriveTokenPoolChainConfigV2Pda } from '../../../../solana/token-pool.ts'
import { getMultipleAccountsInfoPaged } from '../../../../solana/utils.ts'
import { CCTParamsInvalidError, CCTStateChangedError } from '../../../errors.ts'
import type { SolanaGenerateParams } from '../../operation.ts'
import { deriveTokenPoolConfigPda } from '../../programs/token-pool.ts'
import { parsePublicKey } from '../../validate.ts'
import { poolGroupPdas } from '../accounts.ts'
import { decodeRoles, toBigInt } from '../decode.ts'
import { isUnread } from '../lane.ts'
import { readPoolState } from '../multi-token-pool-lane.ts'
import { createPoolGroupProgram } from '../program.ts'
import { type PoolGroupWritePlan, PoolGroupWriteOperation } from '../write-operation.ts'
import type {
  PoolGroupGuardOptions,
  SetPoolGroupChainPauseParams,
  SetPoolGroupLanePauseParams,
  SetPoolGroupPauseParams,
} from '../write-types.ts'
import { type ParsedPoolGroupRef, decodeOwned, readPoolGroup, validateSelector } from './common.ts'
import { readPoolGroupLaneStates } from './lane.ts'
import {
  type ParsedGroupWrite,
  bigField,
  chainRecordMetas,
  decodeOne,
  eventAccounts,
  field,
  laneItems,
  parseGroupWrite,
  proposalBase,
  signerRole,
} from './write-common.ts'

/** The pause roles of a decoded group. */
type PauseGate = { owner: PublicKey; roles: Parameters<typeof decodeRoles>[0] }

/** A pause direction pair: outbound, inbound. */
type Flags = readonly [boolean, boolean]

/**
 * `Group::can_set_pause`: setting a flag needs the owner or the pauser, clearing one the owner or the
 * unpauser; an unchanged flag needs neither.
 * @throws {@link CCTParamsInvalidError} (param `authority`) otherwise
 */
function requirePauseGate(
  operation: string,
  group: PauseGate,
  authority: PublicKey,
  current: readonly boolean[],
  requested: readonly boolean[],
  ix: string,
): void {
  const roles = decodeRoles(group.roles)
  const is = (holder: string | null) => holder !== null && holder === authority.toBase58()
  const owner = group.owner.equals(authority)
  const pausing = current.some((c, i) => !c && requested[i])
  const unpausing = current.some((c, i) => c && !requested[i])
  if (pausing && !owner && !is(roles.pauser))
    throw new CCTParamsInvalidError(
      operation,
      'authority',
      `${authority.toBase58()} is neither the pool group owner (${group.owner.toBase58()}) nor its pauser (${roles.pauser ?? 'unset'}), who set a pause with ${ix}`,
    )
  if (unpausing && !owner && !is(roles.unpauser))
    throw new CCTParamsInvalidError(
      operation,
      'authority',
      `${authority.toBase58()} is neither the pool group owner (${group.owner.toBase58()}) nor its unpauser (${roles.unpauser ?? 'unset'}), who clear a pause with ${ix}`,
    )
}

/**
 * The instruction writes both direction flags, so an omitted direction is merged from chain state
 * when the proposal is built. Under Squads the proposal executes later, and could rewrite a flag
 * someone set meanwhile: both directions must be given explicitly there (the program cannot keep a
 * flag it is not told; the snapshot check reports a moved flag before execution). S4 review M3.
 * @throws {@link CCTParamsInvalidError} (param of the omitted direction) under `squads-v4`
 */
function requireBothUnderSquads(
  operation: string,
  budget: { executor?: string } | undefined,
  outbound: boolean | undefined,
  inbound: boolean | undefined,
): void {
  if (budget?.executor !== 'squads-v4' || (outbound !== undefined && inbound !== undefined)) return
  throw new CCTParamsInvalidError(
    operation,
    outbound === undefined ? 'pausedOutbound' : 'pausedInbound',
    'the instruction writes both directions, and a Squads proposal executes later: give both pausedOutbound and pausedInbound, so it never rewrites a flag set after it was built (run checkPoolGroupSnapshot before executing)',
  )
}

/** Whether a write clears any flag (so it may make lanes live and is judged). */
const clears = (current: readonly boolean[], requested: readonly boolean[]) =>
  current.some((c, i) => c && !requested[i])

/**
 * The judge of a pause write: a pure pause is never judged (an emergency stop must never wait on
 * lane listings or remote reads); clearing a flag runs the guard and its make-live check.
 */
const pauseJudge = (current: readonly boolean[], requested: readonly boolean[]) =>
  clears(current, requested) ? ({ failsClosedSeverity: 'error' } as const) : null

/** Parses an optional pause flag. */
function optionalFlag(operation: string, param: string, value: unknown): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean')
    throw new CCTParamsInvalidError(operation, param, 'must be a boolean')
  return value
}

/** A proposal's chain selector (`params.remoteChainSelector`). */
const selectorOf = (data: unknown) => bigField(field(data, 'params', 'remoteChainSelector')) ?? 0n

/** A proposal's flag (`params.<name>`), as a boolean. */
const flagOf = (data: unknown, name: string) => field(data, 'params', name) === true

// ─── the group pause ─────────────────────────────────────────────────────────────────────────

type ParsedGroupPause = ParsedGroupWrite & { paused: boolean }

/** Sets or clears the pool group pause (every chain record's `group_paused`). */
export class SetPoolGroupPause extends PoolGroupWriteOperation<
  SetPoolGroupPauseParams,
  ParsedGroupPause
> {
  readonly name = 'setPoolGroupPause'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(
    params: SolanaGenerateParams<SetPoolGroupPauseParams>,
  ): ParsedGroupPause {
    const paused = optionalFlag(this.name, 'paused', params.paused)
    if (paused === undefined)
      throw new CCTParamsInvalidError(this.name, 'paused', 'must be a boolean')
    return { ...parseGroupWrite(this.name, params), paused }
  }

  /**
   * `set_group_pause` with every chain record (writable). Nothing is built when the group and every
   * record already hold the flag.
   * @throws {@link CCTParamsInvalidError} if `authority` may not move the flag, or a lane it makes
   *   live fails the lane check
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedGroupPause,
  ): Promise<PoolGroupWritePlan<object>> {
    const { ref, authority, paused } = parsed
    // one read: the chain list and the record flags come from the same slot (S4 review m7); a
    // record of a chain the group lists is at its PDA
    const { group: listed } = await readPoolGroup(this.name, chain, ref)
    const guess = chainRecordMetas(ref.program, ref.group, listed.chainSelectors)
    const { group, extras: read } = await readPoolGroup(
      this.name,
      chain,
      ref,
      guess.map((m) => m.pubkey),
    )
    const metas = chainRecordMetas(ref.program, ref.group, group.chainSelectors)
    if (metas.some((m, i) => !guess[i]?.pubkey.equals(m.pubkey)) || metas.length !== guess.length)
      throw new CCTStateChangedError(
        this.name,
        'the pool group chain list moved while it was read: run it again',
      )
    const extras = read
    const recordFlags = extras.map((info, i) => {
      if (!info)
        throw new CCTParamsInvalidError(
          this.name,
          'poolGroupAddress',
          `the pool group lists chain ${toBigInt(group.chainSelectors[i]!)} but has no record for it`,
        )
      return decodeOwned('groupChainPolicy', info, metas[i]!.pubkey, ref.program).groupPaused
    })
    requirePauseGate(this.name, group, authority, [group.paused], [paused], 'set_group_pause')
    const expected = {
      'group.paused': group.paused,
      'group.chainSelectors': group.chainSelectors.map(toBigInt),
      'groupChains.groupPaused': recordFlags,
    }
    if (group.paused === paused && recordFlags.every((f) => f === paused))
      return { group: ref.group, items: [], judge: null, expected, extra: {} }
    const ix = await createPoolGroupProgram(chain, ref.program, parsed.payer)
      .methods.setGroupPause({ paused })
      .accountsStrict({ group: ref.group, authority, ...eventAccounts(ref.program) })
      .remainingAccounts(metas)
      .instruction()
    const current = [group.paused, ...recordFlags]
    return {
      group: ref.group,
      items: [
        {
          tokenAddresses: [],
          instructions: [ix],
          signerRoles: { [authority.toBase58()]: signerRole(group.owner, authority) },
        },
      ],
      judge: pauseJudge(
        current,
        current.map(() => paused),
      ),
      expected,
      extra: {},
    }
  }

  /** The flag a proposal sets. */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedGroupPause {
    const [one] = decodeOne(this.name, instructions, ['setGroupPause'])
    return {
      ...proposalBase(ref, one!.ix.keys[1]!.pubkey, guardOptions),
      paused: flagOf(one!.data, 'paused'),
    }
  }
}

// ─── a chain record's pause ──────────────────────────────────────────────────────────────────

type ParsedChainPause = ParsedGroupWrite & {
  selector: bigint
  pausedOutbound?: boolean
  pausedInbound?: boolean
}

/** Sets one or both direction flags of a chain record; an omitted direction keeps its flag. */
export class SetPoolGroupChainPause extends PoolGroupWriteOperation<
  SetPoolGroupChainPauseParams,
  ParsedChainPause
> {
  readonly name = 'setPoolGroupChainPause'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid or no direction is given */
  protected override prepare(
    params: SolanaGenerateParams<SetPoolGroupChainPauseParams>,
  ): ParsedChainPause {
    const pausedOutbound = optionalFlag(this.name, 'pausedOutbound', params.pausedOutbound)
    const pausedInbound = optionalFlag(this.name, 'pausedInbound', params.pausedInbound)
    if (pausedOutbound === undefined && pausedInbound === undefined)
      throw new CCTParamsInvalidError(
        this.name,
        'pausedOutbound',
        'give pausedOutbound, pausedInbound or both',
      )
    requireBothUnderSquads(this.name, params.budget, pausedOutbound, pausedInbound)
    return {
      ...parseGroupWrite(this.name, params),
      selector: validateSelector(this.name, 'remoteChainSelector', params.remoteChainSelector),
      ...(pausedOutbound !== undefined && { pausedOutbound }),
      ...(pausedInbound !== undefined && { pausedInbound }),
    }
  }

  /**
   * `set_group_chain_pause` with both flags (an omitted one merged from the record). Nothing is
   * built when the record already holds them.
   * @throws {@link CCTParamsInvalidError} if the chain record does not exist, `authority` may not
   *   move a flag, or a lane it makes live fails the lane check
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedChainPause,
  ): Promise<PoolGroupWritePlan<object>> {
    const { ref, authority, selector } = parsed
    const address = poolGroupPdas.groupChain(ref.program, ref.group, selector)
    const { group, extras } = await readPoolGroup(this.name, chain, ref, [address])
    if (!extras[0])
      throw new CCTParamsInvalidError(
        this.name,
        'remoteChainSelector',
        `the pool group has no chain record for ${selector}: add it with addPoolGroupChain`,
      )
    const record = decodeOwned('groupChainPolicy', extras[0], address, ref.program)
    const current: Flags = [record.pausedOutbound, record.pausedInbound]
    const requested: Flags = [
      parsed.pausedOutbound ?? record.pausedOutbound,
      parsed.pausedInbound ?? record.pausedInbound,
    ]
    requirePauseGate(this.name, group, authority, current, requested, 'set_group_chain_pause')
    const expected = {
      [`groupChain.${selector}.pausedOutbound`]: record.pausedOutbound,
      [`groupChain.${selector}.pausedInbound`]: record.pausedInbound,
    }
    if (current[0] === requested[0] && current[1] === requested[1])
      return { group: ref.group, items: [], judge: null, expected, extra: {} }
    const ix = await createPoolGroupProgram(chain, ref.program, parsed.payer)
      .methods.setGroupChainPause({
        remoteChainSelector: new BN(selector.toString()),
        pausedOutbound: requested[0],
        pausedInbound: requested[1],
      })
      .accountsStrict({
        group: ref.group,
        groupChainPolicy: address,
        authority,
        ...eventAccounts(ref.program),
      })
      .instruction()
    return {
      group: ref.group,
      items: [
        {
          tokenAddresses: [],
          instructions: [ix],
          signerRoles: { [authority.toBase58()]: signerRole(group.owner, authority) },
        },
      ],
      judge: pauseJudge(current, requested),
      expected,
      extra: {},
    }
  }

  /** The exact flags a proposal writes. */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedChainPause {
    const [one] = decodeOne(this.name, instructions, ['setGroupChainPause'])
    return {
      ...proposalBase(ref, one!.ix.keys[2]!.pubkey, guardOptions),
      selector: selectorOf(one!.data),
      pausedOutbound: flagOf(one!.data, 'pausedOutbound'),
      pausedInbound: flagOf(one!.data, 'pausedInbound'),
    }
  }
}

// ─── a mint's lane pauses ────────────────────────────────────────────────────────────────────

type ParsedLanePause = ParsedGroupWrite & {
  mint: PublicKey
  /** The lanes, by chain (or, from a proposal, by their `ChainConfigV2` accounts). */
  lanes: { selectors: bigint[] } | { v2s: PublicKey[] }
  pausedOutbound?: boolean
  pausedInbound?: boolean
}

/** The chains of lane `ChainConfigV2` accounts a proposal names (owner-checked). */
async function selectorsOfV2s(
  chain: SolanaChain,
  program: PublicKey,
  mint: PublicKey,
  v2s: readonly PublicKey[],
): Promise<bigint[]> {
  const infos = await getMultipleAccountsInfoPaged(chain.connection, [...v2s])
  return v2s.map((address, i) => {
    const info = infos[i]
    if (!info)
      throw new CCTParamsInvalidError(
        'setPoolGroupLanePause',
        'transactions',
        `no ChainConfigV2 at ${address.toBase58()}`,
      )
    const v2 = decodeOwned('chainConfigV2', info, address, program)
    if (!v2.mint.equals(mint))
      throw new CCTParamsInvalidError(
        'setPoolGroupLanePause',
        'transactions',
        `${address.toBase58()} is a lane of ${v2.mint.toBase58()}, not ${mint.toBase58()}`,
      )
    return toBigInt(v2.remoteChainSelector)
  })
}

/** Sets a mint's lane pause flags on some chains; omitted directions keep each lane's flag. */
export class SetPoolGroupLanePause extends PoolGroupWriteOperation<
  SetPoolGroupLanePauseParams,
  ParsedLanePause
> {
  readonly name = 'setPoolGroupLanePause'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid or no direction is given */
  protected override prepare(
    params: SolanaGenerateParams<SetPoolGroupLanePauseParams>,
  ): ParsedLanePause {
    const pausedOutbound = optionalFlag(this.name, 'pausedOutbound', params.pausedOutbound)
    const pausedInbound = optionalFlag(this.name, 'pausedInbound', params.pausedInbound)
    if (pausedOutbound === undefined && pausedInbound === undefined)
      throw new CCTParamsInvalidError(
        this.name,
        'pausedOutbound',
        'give pausedOutbound, pausedInbound or both',
      )
    if (!Array.isArray(params.remoteChainSelectors) || !params.remoteChainSelectors.length)
      throw new CCTParamsInvalidError(
        this.name,
        'remoteChainSelectors',
        'must be a non-empty array',
      )
    requireBothUnderSquads(this.name, params.budget, pausedOutbound, pausedInbound)
    const selectors = params.remoteChainSelectors.map((c, i) =>
      validateSelector(this.name, `remoteChainSelectors[${i}]`, c),
    )
    if (new Set(selectors).size !== selectors.length)
      throw new CCTParamsInvalidError(
        this.name,
        'remoteChainSelectors',
        'must list each chain once',
      )
    return {
      ...parseGroupWrite(this.name, params),
      mint: parsePublicKey(this.name, 'tokenAddress', params.tokenAddress),
      lanes: { selectors },
      ...(pausedOutbound !== undefined && { pausedOutbound }),
      ...(pausedInbound !== undefined && { pausedInbound }),
    }
  }

  /** `set_lane_pause` names the mint's pool `State` first, the pool group second. */
  protected override proposalGroup(ix: TransactionInstruction): PublicKey | undefined {
    return ix.keys[1]?.pubkey
  }

  /**
   * `set_lane_pause`, one instruction per distinct (outbound, inbound) pair after the merge, each
   * with as many lanes as fit. Lanes that already hold their flags are left out.
   * @throws {@link CCTParamsInvalidError} if a lane is missing or not linked to the pool group,
   *   `authority` is neither the pool owner nor allowed to move a flag, or a lane it makes live
   *   fails the lane check
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedLanePause,
  ): Promise<PoolGroupWritePlan<object>> {
    const { ref, authority, mint } = parsed
    const selectors =
      'selectors' in parsed.lanes
        ? parsed.lanes.selectors
        : await selectorsOfV2s(chain, ref.program, mint, parsed.lanes.v2s)
    const [{ group }, pool, states] = await Promise.all([
      readPoolGroup(this.name, chain, ref),
      readPoolState(this.name, chain, ref.program, mint),
      readPoolGroupLaneStates(
        chain,
        ref.program,
        selectors.map((selector) => ({ mint, selector })),
      ),
    ])
    const laneOwner = pool.state.owner.equals(authority)
    // `holds_pause_role`: the lane owner, or the group owner, pauser or unpauser, signs at all
    const roles = decodeRoles(group.roles)
    if (
      !laneOwner &&
      !group.owner.equals(authority) &&
      ![roles.pauser, roles.unpauser].includes(authority.toBase58())
    )
      throw new CCTParamsInvalidError(
        this.name,
        'authority',
        `${authority.toBase58()} is neither the lanes' pool owner (${pool.state.owner.toBase58()}) nor the pool group owner, pauser or unpauser, who sign set_lane_pause`,
      )
    const byFlags = new Map<string, { flags: Flags; selectors: bigint[] }>()
    const current: Record<string, Flags> = {}
    const cleared: boolean[] = []
    selectors.forEach((selector, i) => {
      const state = states[i]
      const ext = state && !isUnread(state) ? state.ext : undefined
      if (!ext?.poolGroupAddress || ext.poolGroupAddress !== ref.group.toBase58())
        throw new CCTParamsInvalidError(
          this.name,
          `remoteChainSelectors[${i}]`,
          `the lane of ${mint.toBase58()} toward ${selector} is not linked to the pool group ${ref.group.toBase58()}${state && isUnread(state) ? ` (${state.reason})` : ''} (LaneNotLinkedToGroup)`,
        )
      const was: Flags = [ext.pausedOutbound, ext.pausedInbound]
      const next: Flags = [parsed.pausedOutbound ?? was[0], parsed.pausedInbound ?? was[1]]
      current[String(selector)] = was
      if (!laneOwner) requirePauseGate(this.name, group, authority, was, next, 'set_lane_pause')
      if (was[0] === next[0] && was[1] === next[1]) return
      cleared.push(clears(was, next))
      const key = next.join()
      byFlags.set(key, {
        flags: next,
        selectors: [...(byFlags.get(key)?.selectors ?? []), selector],
      })
    })
    const expected = { [`lanes.${mint.toBase58()}.paused`]: current }
    if (!byFlags.size) return { group: ref.group, items: [], judge: null, expected, extra: {} }
    const program = createPoolGroupProgram(chain, ref.program, parsed.payer)
    const state = deriveTokenPoolConfigPda(ref.program, mint)
    const items = []
    for (const { flags, selectors: chunk } of byFlags.values()) {
      const lanes = chunk.map((selector) => ({
        mint,
        metas: [
          {
            pubkey: deriveTokenPoolChainConfigV2Pda(ref.program, selector, mint),
            isSigner: false,
            isWritable: true,
          } satisfies AccountMeta,
        ],
      }))
      items.push(
        ...(await laneItems(
          this.name,
          chain,
          parsed,
          lanes,
          (metas) =>
            program.methods
              .setLanePause({ mint, pausedOutbound: flags[0], pausedInbound: flags[1] })
              .accountsStrict({
                state,
                group: ref.group,
                authority,
                systemProgram: SystemProgram.programId,
                ...eventAccounts(ref.program),
              })
              .remainingAccounts(metas)
              .instruction(),
          {
            [authority.toBase58()]: laneOwner ? 'pool-owner' : signerRole(group.owner, authority),
          },
        )),
      )
    }
    return {
      group: ref.group,
      items,
      judge: cleared.some(Boolean) ? { failsClosedSeverity: 'error' } : null,
      judgeEach: true,
      expected,
      extra: {},
    }
  }

  /** The exact flags and lanes a proposal writes (one instruction per flag pair). */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedLanePause {
    const decoded = decodeOne(this.name, instructions, ['setLanePause'], false)
    const first = decoded[0]!
    const mint = field(first.data, 'params', 'mint')
    if (!(mint instanceof PublicKey))
      throw new CCTParamsInvalidError(this.name, 'transactions', 'the instruction has no mint')
    const pairs = new Set(
      decoded.map((d) => `${flagOf(d.data, 'pausedOutbound')},${flagOf(d.data, 'pausedInbound')}`),
    )
    if (pairs.size !== 1)
      throw new CCTParamsInvalidError(
        this.name,
        'transactions',
        'the proposal sets lanes to different flags: check each transaction as its own proposal',
      )
    return {
      ...proposalBase(ref, first.ix.keys[2]!.pubkey, guardOptions),
      mint,
      // after the 6 fixed accounts: each lane's ChainConfigV2
      lanes: { v2s: decoded.flatMap((d) => d.ix.keys.slice(6).map((k) => k.pubkey)) },
      pausedOutbound: flagOf(first.data, 'pausedOutbound'),
      pausedInbound: flagOf(first.data, 'pausedInbound'),
    }
  }
}

/** The pause ops, by name: the snapshot check runs their re-checks. @internal */
export const POOL_GROUP_PAUSE_OPERATIONS = {
  setPoolGroupPause: new SetPoolGroupPause(),
  setPoolGroupChainPause: new SetPoolGroupChainPause(),
  setPoolGroupLanePause: new SetPoolGroupLanePause(),
} as const
