/**
 * What the membership and driven-lane writes share (S5): member remote tokens in the IDL form and
 * per chain, admission and liveness of a chain record, the drain gate of a close, and the accounts of
 * `close_group_lanes`. Program of record: chainlink-ccip-solana 7558722,
 * `burnmint-token-pool/src/instructions/groups/members.rs` and `base-token-pool/src/groups.rs`
 * (`validate_member_remote_tokens`, `apply_subset_updates`).
 *
 * @packageDocumentation
 */

import type { Buffer } from 'buffer'

import { BN } from '@coral-xyz/anchor'
import { type AccountInfo, type AccountMeta, PublicKey } from '@solana/web3.js'

import { encodeAddressToAny } from '../../../../shared/codec.ts'
import type { SolanaChain } from '../../../../solana/index.ts'
import {
  deriveTokenPoolChainConfigOverridePda,
  deriveTokenPoolChainConfigV2Pda,
} from '../../../../solana/token-pool.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { decodeRemoteAddress, laneFamilyOf, parseRemoteAddress } from '../../../remote-address.ts'
import { deriveTokenPoolChainConfigPda } from '../../programs/token-pool.ts'
import {
  type GroupChainPolicyAccount,
  type PoolGroupMemberAccount,
  poolGroupChainAdmits,
  poolGroupPdas,
} from '../accounts.ts'
import type { PoolGroupLaneState } from '../lane.ts'
import type { PoolGroupLaneKey, PoolGroupMemberRemoteToken } from '../types.ts'
import { type ParsedPoolGroupRef, listPoolGroupMembers, validateSelector } from './common.ts'
import { meta } from './lanes.ts'
import { laneId } from './write-common.ts'

/** `MAX_MEMBER_REMOTE_CHAINS` (groups.rs:1015). */
const MAX_MEMBER_REMOTE_CHAINS = 32
/** `MAX_REMOTE_ADDRESS_LEN` (groups.rs:1017). */
const MAX_REMOTE_ADDRESS_LEN = 64

/** One chain of a member: the remote token as stored (bytes) and its decimals. @internal */
export type MemberChainToken = { token: Buffer; decimals: number }

/** A member's remote tokens by chain. @internal */
export type MemberChains = Map<bigint, MemberChainToken>

/**
 * Parses a member's remote-token entries into per-chain tokens: each entry names chains of one
 * family, each chain once across the entries, at most 32 chains; the token is parsed for each chain
 * and stored as the lane stores it (`encodeAddressToAny`, so an EVM token is 32 bytes padded).
 * @throws {@link CCTParamsInvalidError} if an entry is malformed (`InvalidMemberRemoteTokens`)
 * @internal
 */
export function parseMemberChains(operation: string, param: string, value: unknown): MemberChains {
  if (!Array.isArray(value)) throw new CCTParamsInvalidError(operation, param, 'must be an array')
  const out: MemberChains = new Map()
  value.forEach((e: unknown, i) => {
    const at = `${param}[${i}]`
    const selectors: unknown = Reflect.get(Object(e), 'remoteChainSelectors')
    if (!Array.isArray(selectors) || !selectors.length)
      throw new CCTParamsInvalidError(
        operation,
        `${at}.remoteChainSelectors`,
        'must be a non-empty array',
      )
    const decimals: unknown = Reflect.get(Object(e), 'decimals')
    if (
      typeof decimals !== 'number' ||
      !Number.isInteger(decimals) ||
      decimals < 0 ||
      decimals > 255
    )
      throw new CCTParamsInvalidError(operation, `${at}.decimals`, 'must be an integer 0-255')
    const families = new Set<string | undefined>()
    selectors.forEach((raw: unknown, j) => {
      const selector = validateSelector(operation, `${at}.remoteChainSelectors[${j}]`, raw)
      families.add(laneFamilyOf(selector))
      const token = parseRemoteAddress(
        operation,
        `${at}.token`,
        Reflect.get(Object(e), 'token'),
        selector,
      )
      if (encodeAddressToAny(token).every((b) => b === 0))
        throw new CCTParamsInvalidError(
          operation,
          `${at}.token`,
          'must not be the zero address (InvalidMemberRemoteTokens)',
        )
      if (out.has(selector))
        throw new CCTParamsInvalidError(
          operation,
          `${at}.remoteChainSelectors[${j}]`,
          `chain ${selector} is listed twice (InvalidMemberRemoteTokens)`,
        )
      out.set(selector, { token: encodeAddressToAny(token), decimals })
    })
    if (families.size > 1)
      throw new CCTParamsInvalidError(
        operation,
        `${at}.remoteChainSelectors`,
        'an entry names chains of one family (one token spelling): split it',
      )
  })
  if (out.size > MAX_MEMBER_REMOTE_CHAINS)
    throw new CCTParamsInvalidError(
      operation,
      param,
      `a member lists at most ${MAX_MEMBER_REMOTE_CHAINS} chains (InvalidMemberRemoteTokens)`,
    )
  for (const [selector, t] of out)
    if (t.token.length > MAX_REMOTE_ADDRESS_LEN)
      throw new CCTParamsInvalidError(
        operation,
        param,
        `the token of chain ${selector} is too long`,
      )
  return out
}

/** A decoded member's chains. @internal */
export function memberChainsOf(member: PoolGroupMemberAccount): MemberChains {
  const out: MemberChains = new Map()
  for (const t of member.remoteTokens)
    for (const s of t.remoteChainSelectors) out.set(s, { token: t.token, decimals: t.decimals })
  return out
}

/** Per-chain tokens back to entries (chains with the same token and decimals share one). @internal */
export function memberEntriesOf(chains: MemberChains) {
  const groups = new Map<string, { selectors: bigint[]; token: Buffer; decimals: number }>()
  for (const [selector, t] of chains) {
    const k = `${t.token.toString('hex')}:${t.decimals}`
    const g = groups.get(k) ?? { selectors: [], token: t.token, decimals: t.decimals }
    g.selectors.push(selector)
    groups.set(k, g)
  }
  return [...groups.values()].map((g) => ({
    remoteChainSelectors: g.selectors.map((s) => new BN(s.toString())),
    token: { address: g.token },
    decimals: g.decimals,
  }))
}

/** A member's chains in public form (first chain's spelling per entry). @internal */
export function publicRemoteTokens(chains: MemberChains): PoolGroupMemberRemoteToken[] {
  return memberEntriesOf(chains).map((e) => {
    const selectors = e.remoteChainSelectors.map((s) => BigInt(s.toString()))
    return {
      remoteChainSelectors: selectors,
      token: decodeRemoteAddress(e.token.address, selectors[0]!),
      decimals: e.decimals,
    }
  })
}

/** Two stored tokens of one chain are the same token. */
const sameToken = (a: Buffer, b: Buffer) => a.equals(b)

/**
 * `REMOTE_TOKEN_SHARED` for member writes (as the lane check on EVM, `guards.ts`): a chain's remote
 * token listed by two members of the group, whose driven lanes the destination could not tell
 * apart.
 * @throws {@link CCTParamsInvalidError} (param `poolGroupMembers`) on a shared token
 * @internal
 */
export function requireOwnRemoteTokens(
  operation: string,
  param: string,
  writes: readonly { mint: string; chains: MemberChains }[],
  others: readonly { mint: string; chains: MemberChains }[],
): void {
  const all = [...others.filter((o) => !writes.some((w) => w.mint === o.mint)), ...writes]
  for (const w of writes)
    for (const [selector, t] of w.chains) {
      const shared = all.filter(
        (o) =>
          o.mint !== w.mint &&
          o.chains.has(selector) &&
          sameToken(o.chains.get(selector)!.token, t.token),
      )
      if (shared.length)
        throw new CCTParamsInvalidError(
          operation,
          param,
          `REMOTE_TOKEN_SHARED: ${w.mint} would list remote token ${decodeRemoteAddress(t.token, selector)} on chain ${selector}, which ${shared.map((s) => s.mint).join(', ')} already lists in the pool group: the destination could not tell their lanes apart; give each token its own remote token`,
        )
    }
}

/**
 * Whether a chain record lets driven lanes transfer (not paused for the group, the chain's driven
 * lanes, or both directions of the chain). @internal
 */
export const chainRunsDriven = (
  gcp: Pick<
    GroupChainPolicyAccount,
    'groupPaused' | 'drivenLanesPaused' | 'pausedOutbound' | 'pausedInbound'
  >,
) => !gcp.groupPaused && !gcp.drivenLanesPaused && !(gcp.pausedOutbound && gcp.pausedInbound)

/** Whether a record admits `memberIndex` and runs its driven lanes. @internal */
export const admitsLive = (
  gcp: GroupChainPolicyAccount,
  data: Buffer,
  memberIndex: number,
): boolean => chainRunsDriven(gcp) && poolGroupChainAdmits(gcp, data, memberIndex)

/**
 * The (member, chain) pairs a write re-opens: on each chain record whose driven lanes go from held
 * (group pause, driven-lanes pause, both directions paused) to running, every member the record
 * admits that lists the chain. Their lanes become live, or materializable live by anyone, with no
 * further write of theirs (design §7.6 live admission; S5 review M3). Reads the members with
 * `getProgramAccounts` only when a record re-opens, and fails closed when it is refused.
 * @internal
 */
export async function reopenedAdmissions(
  operation: string,
  chain: SolanaChain,
  ref: Pick<ParsedPoolGroupRef, 'program' | 'group'>,
  records: readonly {
    selector: bigint
    record: GroupChainPolicyAccount
    data: Buffer
    after: Pick<
      GroupChainPolicyAccount,
      'groupPaused' | 'drivenLanesPaused' | 'pausedOutbound' | 'pausedInbound'
    >
  }[],
): Promise<PoolGroupLaneKey[]> {
  const reopened = records.filter((r) => !chainRunsDriven(r.record) && chainRunsDriven(r.after))
  if (!reopened.length) return []
  const members = await listPoolGroupMembers(operation, chain, ref.program, ref.group, {
    param: 'acknowledgeLiveAdmission',
    fix: 'finding the members a lift re-opens needs it; use an RPC that serves getProgramAccounts',
  })
  return reopened.flatMap(({ selector, record, data }) =>
    members
      .filter(
        ({ member }) =>
          memberChainsOf(member).has(selector) &&
          poolGroupChainAdmits(record, data, member.memberIndex),
      )
      .map(({ member }) => ({ tokenAddress: member.mint, remoteChainSelector: selector })),
  )
}

/**
 * Refuses pairs the write makes materializable or live on a running chain unless acknowledged
 * (§7.6, live admission).
 * @throws {@link CCTParamsInvalidError} (param `acknowledgeLiveAdmission`) otherwise
 * @internal
 */
export function requireAdmissionAcknowledged(
  operation: string,
  admitted: readonly PoolGroupLaneKey[],
  acknowledged: readonly PoolGroupLaneKey[] | 'all',
): void {
  if (acknowledged === 'all') return
  const ok = new Set(acknowledged.map(laneId))
  const missing = admitted.filter((l) => !ok.has(laneId(l)))
  if (missing.length)
    throw new CCTParamsInvalidError(
      operation,
      'acknowledgeLiveAdmission',
      `the write admits ${missing.length} lane(s) on a running chain (${missing.map(laneId).join(', ')}): anyone can then materialize them live. List them in acknowledgeLiveAdmission, or pause the chain's driven lanes first (setPoolGroupChainLanes drivenLanesPaused)`,
      { context: { admitted: missing } },
    )
}

/**
 * Whether a lane's driven transfers are paused in both directions (its own flags, the chain's, the
 * group's or the chain's driven lanes): such a lane is not live. Not a drain: an inbound pause makes
 * in-flight messages fail on arrival (design §7.6). @internal
 */
export function pausedBothWays(state: PoolGroupLaneState): boolean {
  const gcp = state.groupChain?.record
  const ext = state.ext
  return (
    !!(ext?.pausedOutbound && ext.pausedInbound) ||
    !!gcp?.groupPaused ||
    !!gcp?.drivenLanesPaused ||
    !!(gcp?.pausedOutbound && gcp.pausedInbound)
  )
}

/**
 * Whether no new outbound transfer can start on a lane: its own outbound flag, the chain's outbound
 * pause, the group pause or the chain's driven-lanes pause. @internal
 */
export function pausedOutbound(state: PoolGroupLaneState): boolean {
  const gcp = state.groupChain?.record
  return (
    !!state.ext?.pausedOutbound ||
    !!gcp?.groupPaused ||
    !!gcp?.drivenLanesPaused ||
    !!gcp?.pausedOutbound
  )
}

/**
 * The drain gate of a close (design §7.6, "drain before close"): each lane must be paused outbound
 * here and listed in `confirmInFlightDrained`, the caller's statement that the remote side stopped
 * sending and no inbound message is still in flight. A pause is never a drain: pausing inbound is
 * exactly what makes in-flight messages fail on arrival, and after the close they can never execute.
 * Until the SDK can check in-flight messages itself (design §17 Q8), the confirmation is required.
 * @throws {@link CCTParamsInvalidError} (param `confirmInFlightDrained`) otherwise
 * @internal
 */
export function requireDrained(
  operation: string,
  lanes: readonly { key: PoolGroupLaneKey; state: PoolGroupLaneState }[],
  confirmed: readonly PoolGroupLaneKey[],
): void {
  const ok = new Set(confirmed.map(laneId))
  const sending = lanes.filter((l) => !pausedOutbound(l.state))
  if (sending.length)
    throw new CCTParamsInvalidError(
      operation,
      'confirmInFlightDrained',
      `closing ${sending.map((l) => laneId(l.key)).join(', ')} while outbound runs: pause each lane's outbound first (setPoolGroupLanePause pausedOutbound), wait for the remote side to stop and the inbound messages in flight to drain, then list it in confirmInFlightDrained`,
      { context: { lanes: sending.map((l) => l.key) } },
    )
  const open = lanes.filter((l) => !ok.has(laneId(l.key)))
  if (open.length)
    throw new CCTParamsInvalidError(
      operation,
      'confirmInFlightDrained',
      `closing ${open.map((l) => laneId(l.key)).join(', ')} strands inbound messages still in flight: a pause is not a drain (an inbound pause makes them fail on arrival). Once the remote side stopped and none is in flight, list each lane in confirmInFlightDrained`,
      { context: { lanes: open.map((l) => l.key) } },
    )
}

/** A driven lane to close and the accounts `close_group_lanes` takes for it. @internal */
export type CloseLaneEntry = {
  mint: PublicKey
  key: PoolGroupLaneKey
  /** The named records it references (released first). */
  refs: string[]
  /** Member, ChainConfig, ChainConfigV2, FTF override, lane payer, rent receiver (all writable). */
  metas: AccountMeta[]
}

/**
 * The close entry of a driven lane of `member`, from the member's payer entry for the chain.
 * @throws {@link CCTParamsInvalidError} if the member has no payer entry for the chain (the
 *   program refuses the close, `InvalidGroupMember`)
 * @internal
 */
export function closeLaneEntry(
  operation: string,
  program: PublicKey,
  member: PoolGroupMemberAccount,
  state: PoolGroupLaneState,
): CloseLaneEntry {
  const mint = new PublicKey(member.mint)
  const selector = state.selector
  const payer = member.lanePayers.find((p) => p.remoteChainSelector === selector)
  if (!payer)
    throw new CCTParamsInvalidError(
      operation,
      'tokenAddresses',
      `the member ${member.mint} records no payer for its lane toward ${selector}, so the lane cannot be closed (InvalidGroupMember)`,
    )
  return {
    mint,
    key: { tokenAddress: member.mint, remoteChainSelector: selector },
    refs: (state.ext?.policySlots ?? []).flatMap((p) =>
      p ? [poolGroupPdas.policyChain(program, new PublicKey(p), selector).toBase58()] : [],
    ),
    metas: [
      meta(poolGroupPdas.groupMember(program, mint), true),
      meta(deriveTokenPoolChainConfigPda(program, selector, mint), true),
      meta(deriveTokenPoolChainConfigV2Pda(program, selector, mint), true),
      meta(deriveTokenPoolChainConfigOverridePda(program, selector, mint), true),
      meta(new PublicKey(payer.payer), true),
      meta(new PublicKey(member.rentReceiver), true),
    ],
  }
}

/**
 * A rent receiver must be able to take lamports later (`require_rent_receiver`): absent, or a
 * non-executable system account.
 * @throws {@link CCTParamsInvalidError} (param `rentReceiver`) otherwise
 * @internal
 */
export function requireRentReceiver(
  operation: string,
  receiver: PublicKey,
  info: AccountInfo<Buffer> | null | undefined,
): void {
  if (!info) return
  if (info.executable || !info.owner.equals(PublicKey.default))
    throw new CCTParamsInvalidError(
      operation,
      'rentReceiver',
      `${receiver.toBase58()} is not a system account (InvalidRentReceiver): pass a wallet`,
    )
}
