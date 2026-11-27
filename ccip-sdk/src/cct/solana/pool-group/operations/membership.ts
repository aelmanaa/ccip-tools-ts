/**
 * Membership (S5): `join_group`, `set_member_remote_tokens`, `close_group_members`. Program of
 * record: chainlink-ccip-solana 7558722, `burnmint-token-pool/src/instructions/groups/members.rs`.
 *
 * A join hands the pool group's owner and admins its tokens' driven-lane CONNECTION, so the group's
 * owner must be `expectedOwner` (defaults to `authority`) and the result echoes who can change what
 * the lanes trust. A join or a member's new chain on a running chain that admits it makes its lane
 * materializable by anyone at once: refused unless acknowledged (live admission). A member's remote
 * token another member already lists on that chain is refused (`REMOTE_TOKEN_SHARED`).
 *
 * @packageDocumentation
 */

import { BN } from '@coral-xyz/anchor'
import { type TransactionInstruction, PublicKey, SystemProgram } from '@solana/web3.js'

import type { SolanaChain } from '../../../../solana/index.ts'
import { getMultipleAccountsInfoPaged } from '../../../../solana/utils.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import type { SolanaGenerateParams } from '../../operation.ts'
import { deriveTokenAdminRegistryPda } from '../../programs/router.ts'
import { parsePublicKey } from '../../validate.ts'
import {
  type GroupChainPolicyAccount,
  type PoolGroupMemberAccount,
  GROUP_CHAIN_POLICY_FIXED_LEN,
  decodePoolGroupMember,
  decodePoolGroupRegistry,
  poolGroupPdas,
} from '../accounts.ts'
import { decodeSections } from '../decode.ts'
import { type PoolGroupLaneState, isUnread } from '../lane.ts'
import { createPoolGroupProgram } from '../program.ts'
import type { PoolGroupLaneKey } from '../types.ts'
import { type PoolGroupWritePlan, PoolGroupWriteOperation } from '../write-operation.ts'
import type {
  ClosePoolGroupMembersParams,
  JoinPoolGroupParams,
  JoinPoolGroupResult,
  PoolGroupFollowUp,
  PoolGroupGuardOptions,
  PoolGroupUnsignedResult,
  SetPoolGroupMemberRemoteTokensParams,
  SetPoolGroupMemberRemoteTokensResult,
} from '../write-types.ts'
import {
  type ParsedPoolGroupRef,
  decodeOwned,
  decodeOwnedData,
  listPoolGroupMembers,
  parseTokenAddresses,
  readPoolGroup,
} from './common.ts'
import { readPoolGroupLaneStates } from './lane.ts'
import { feeVaultTokenAccount, laneBatchItems, meta, missingFeeVaults } from './lanes.ts'
import {
  type CloseLaneEntry,
  type MemberChains,
  admitsLive,
  closeLaneEntry,
  memberChainsOf,
  memberEntriesOf,
  parseMemberChains,
  pausedBothWays,
  publicRemoteTokens,
  requireAdmissionAcknowledged,
  requireDrained,
  requireOwnRemoteTokens,
  requireRentReceiver,
} from './members-common.ts'
import {
  type ParsedGroupWrite,
  decodeOne,
  eventAccounts,
  everyLane,
  field,
  fittedItems,
  keyField,
  laneId,
  membershipCoSigner,
  optionalSigner,
  parseGroupWrite,
  parseLaneKeys,
  poolGroupTrustOf,
  proposalBase,
  readPoolStates,
  requireExpectedGroupOwner,
} from './write-common.ts'

/** The members of the group (`getProgramAccounts`, fails closed), with their chains. */
async function groupMembers(
  operation: string,
  chain: SolanaChain,
  ref: ParsedPoolGroupRef,
): Promise<{ mint: string; member: PoolGroupMemberAccount; chains: MemberChains }[]> {
  const members = await listPoolGroupMembers(operation, chain, ref.program, ref.group, {
    param: 'connection',
    fix: 'checking that no other member lists the same remote token needs it; use an RPC that serves getProgramAccounts',
  })
  return members.map(({ member }) => ({
    mint: member.mint,
    member,
    chains: memberChainsOf(member),
  }))
}

/** The chain records of `selectors` that exist, by chain, with their raw data. */
async function chainRecords(
  chain: SolanaChain,
  ref: ParsedPoolGroupRef,
  selectors: readonly bigint[],
): Promise<Map<bigint, { record: GroupChainPolicyAccount; data: Buffer }>> {
  const addresses = selectors.map((s) => poolGroupPdas.groupChain(ref.program, ref.group, s))
  const infos = await getMultipleAccountsInfoPaged(chain.connection, addresses)
  const out = new Map<bigint, { record: GroupChainPolicyAccount; data: Buffer }>()
  selectors.forEach((s, i) => {
    const info = infos[i]
    if (info)
      out.set(s, {
        record: decodeOwned('groupChainPolicy', info, addresses[i]!, ref.program),
        data: info.data,
      })
  })
  return out
}

/** The admission state a snapshot keeps: each named chain record's mode and pauses. */
const admissionExpected = (
  records: Map<bigint, { record: GroupChainPolicyAccount; data: Buffer }>,
) =>
  [...records].map(([s, { record, data }]) => [
    s,
    Object.keys(record.laneMode)[0],
    record.drivenLanesPaused,
    record.groupPaused,
    record.pausedOutbound && record.pausedInbound,
    data.subarray(GROUP_CHAIN_POLICY_FIXED_LEN).toString('hex'),
  ])

/** The CONNECTION pools of each chain record, for the trust echo. */
const trustedPools = (records: Map<bigint, { record: GroupChainPolicyAccount }>) =>
  [...records].map(([remoteChainSelector, { record }]) => ({
    remoteChainSelector,
    addresses: decodeSections(record.policy, 0n, remoteChainSelector).connection.remotePools.map(
      (p) => p.address,
    ),
  }))

// ─── join_group ──────────────────────────────────────────────────────────────────────────────

type JoinEntry = { mint: PublicKey; chains: MemberChains }

/** The result fields a join adds: the predicted indices and the trust echo. */
type JoinExtra = JoinPoolGroupResult & Pick<PoolGroupUnsignedResult, 'poolGroupTrust'>

type ParsedJoin = ParsedGroupWrite & {
  rentReceiver?: PublicKey
  entries: JoinEntry[]
  poolGroupOwner?: PublicKey
  acknowledged: PoolGroupLaneKey[] | 'all'
}

/** Tokens join a pool group (batched): the pool owner signs, with the group owner unless open. */
export class JoinPoolGroup extends PoolGroupWriteOperation<
  JoinPoolGroupParams,
  ParsedJoin,
  JoinExtra
> {
  readonly name = 'joinPoolGroup'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(params: SolanaGenerateParams<JoinPoolGroupParams>): ParsedJoin {
    const members: unknown = params.poolGroupMembers
    if (!Array.isArray(members) || !members.length)
      throw new CCTParamsInvalidError(this.name, 'poolGroupMembers', 'must be a non-empty array')
    const entries = members.map((m: unknown, i): JoinEntry => ({
      mint: parsePublicKey(
        this.name,
        `poolGroupMembers[${i}].tokenAddress`,
        Reflect.get(Object(m), 'tokenAddress'),
      ),
      chains: parseMemberChains(
        this.name,
        `poolGroupMembers[${i}].remoteTokens`,
        Reflect.get(Object(m), 'remoteTokens'),
      ),
    }))
    if (new Set(entries.map((e) => e.mint.toBase58())).size !== entries.length)
      throw new CCTParamsInvalidError(this.name, 'poolGroupMembers', 'must name each token once')
    return {
      ...parseGroupWrite(this.name, params),
      entries,
      ...(params.rentReceiver !== undefined && {
        rentReceiver: parsePublicKey(this.name, 'rentReceiver', params.rentReceiver),
      }),
      ...(params.poolGroupOwner !== undefined && {
        poolGroupOwner: parsePublicKey(this.name, 'poolGroupOwner', params.poolGroupOwner),
      }),
      acknowledged: parseLaneKeys(
        this.name,
        'acknowledgeLiveAdmission',
        params.acknowledgeLiveAdmission,
      ),
    }
  }

  /**
   * `join_group`, as many members per instruction as one transaction fits (a member's missing fee
   * vault token account created first). Indices are predicted from the registry in this order.
   * @throws {@link CCTParamsInvalidError} if the group's owner is not `expectedOwner`, `authority`
   *   does not own a pool, a token is a member already, the rent receiver cannot be credited, a
   *   remote token is another member's, or a running chain admits a member unacknowledged
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedJoin,
  ): Promise<PoolGroupWritePlan<JoinExtra>> {
    const { ref, authority, entries } = parsed
    const rentReceiver = parsed.rentReceiver ?? authority
    const registryAddress = poolGroupPdas.groupRegistry(ref.program, ref.group)
    const memberAddresses = entries.map((e) => poolGroupPdas.groupMember(ref.program, e.mint))
    const {
      group,
      extras: [registryInfo, receiverInfo, ...memberInfos],
    } = await readPoolGroup(this.name, chain, { program: ref.program, group: ref.group }, [
      registryAddress,
      rentReceiver,
      ...memberAddresses,
    ])
    requireExpectedGroupOwner(this.name, group.owner, ref.expectedOwner ?? authority)
    requireRentReceiver(this.name, rentReceiver, receiverInfo)
    const owner = membershipCoSigner(
      this.name,
      group,
      parsed.poolGroupOwner,
      authority,
      parsed.budget,
    )
    entries.forEach((e, i) => {
      const info = memberInfos[i]
      if (info?.owner.equals(ref.program))
        throw new CCTParamsInvalidError(
          this.name,
          `poolGroupMembers[${i}].tokenAddress`,
          `${e.mint.toBase58()} is a member of ${decodePoolGroupMember(info.data, memberAddresses[i]!.toBase58()).poolGroupAddress} already: a mint is a member of one group at a time`,
        )
    })
    const pools = await readPoolStates(
      this.name,
      chain,
      ref.program,
      entries.map((e) => e.mint),
      authority,
    )
    const next = registryInfo
      ? decodePoolGroupRegistry(
          decodeOwnedData(registryInfo, registryAddress, ref.program),
          registryAddress.toBase58(),
        ).nextMemberIndex
      : 0
    const memberIndices = Object.fromEntries(entries.map((e, i) => [e.mint.toBase58(), next + i]))
    requireOwnRemoteTokens(
      this.name,
      'poolGroupMembers',
      entries.map((e) => ({ mint: e.mint.toBase58(), chains: e.chains })),
      await groupMembers(this.name, chain, ref),
    )
    const records = await chainRecords(chain, ref, [
      ...new Set(entries.flatMap((e) => [...e.chains.keys()])),
    ])
    const admitted = entries.flatMap((e) =>
      [...e.chains.keys()].flatMap((s) => {
        const r = records.get(s)
        return r && admitsLive(r.record, r.data, memberIndices[e.mint.toBase58()]!)
          ? [{ tokenAddress: e.mint.toBase58(), remoteChainSelector: s }]
          : []
      }),
    )
    requireAdmissionAcknowledged(this.name, admitted, parsed.acknowledged)
    const client = createPoolGroupProgram(chain, ref.program, parsed.payer)
    const lanes = entries.map((e, i) => {
      const pool = pools[i]!
      return {
        mint: e.mint,
        entry: { mint: e.mint, remoteTokens: memberEntriesOf(e.chains) },
        metas: [
          meta(pool.address, false),
          meta(memberAddresses[i]!, true),
          meta(deriveTokenAdminRegistryPda(pool.state.router, e.mint), false),
          meta(feeVaultTokenAccount(ref.program, pool), false),
        ],
      }
    })
    const items = await laneBatchItems(
      this.name,
      chain,
      parsed,
      lanes,
      (chunk) =>
        client.methods
          .joinGroup({ rentReceiver, members: chunk.map((l) => l.entry) })
          .accountsStrict({
            group: ref.group,
            groupRegistry: registryAddress,
            groupOwner: owner,
            authority,
            systemProgram: SystemProgram.programId,
            ...eventAccounts(ref.program),
          })
          .remainingAccounts([meta(rentReceiver, true), ...chunk.flatMap((l) => l.metas)])
          .instruction(),
      {
        [authority.toBase58()]: 'pool-owner',
        ...(owner && !owner.equals(authority) && { [owner.toBase58()]: 'pool-group-owner' }),
      },
      await missingFeeVaults(chain, ref.program, parsed.payer, pools),
    )
    return {
      group: ref.group,
      items: items.map((item, i) => ({
        ...item,
        createdPdas: [
          ...(i === 0 && !registryInfo ? [registryAddress] : []),
          ...item.tokenAddresses.map((m) =>
            poolGroupPdas.groupMember(ref.program, new PublicKey(m)),
          ),
        ],
      })),
      judge: { failsClosedSeverity: 'error' },
      expected: {
        'group.owner': group.owner.toBase58(),
        'group.openMembership': group.openMembership,
        'registry.nextMemberIndex': next,
        'chains.admission': admissionExpected(records),
      },
      goingLive: admitted,
      extra: {
        memberIndices,
        poolGroupTrust: poolGroupTrustOf(group, trustedPools(records)),
      },
    }
  }

  /** The members a proposal joins (their remote tokens from the instruction data). */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedJoin {
    const ixs = decodeOne(this.name, instructions, ['joinGroup'], false)
    const first = ixs[0]!
    const owner = optionalSigner(first.ix.keys[2]?.pubkey, ref.program)
    const entries = ixs.flatMap((d) => {
      const members = field(d.data, 'params', 'members')
      return (Array.isArray(members) ? members : []).map((m: unknown): JoinEntry => ({
        mint: keyField(this.name, m, 'mint'),
        chains: chainsOfData(field(m, 'remoteTokens')),
      }))
    })
    return {
      ...proposalBase(ref, first.ix.keys[3]!.pubkey, guardOptions),
      rentReceiver: keyField(this.name, first.data, 'params', 'rentReceiver'),
      entries,
      ...(owner && { poolGroupOwner: owner }),
      // the proposal admits what it admits: a move of the chain records shows in the snapshot
      acknowledged: 'all',
    }
  }
}

/** Decoded `Vec<MemberRemoteToken>` instruction data, per chain. */
function chainsOfData(v: unknown): MemberChains {
  const out: MemberChains = new Map()
  for (const t of Array.isArray(v) ? v : []) {
    const token = field(t, 'token', 'address')
    const selectors = field(t, 'remoteChainSelectors')
    for (const s of Array.isArray(selectors) ? selectors : [])
      out.set(BigInt(String(s)), {
        token: Buffer.from(token instanceof Uint8Array ? token : []),
        decimals: Number(field(t, 'decimals') ?? 0),
      })
  }
  return out
}

// ─── set_member_remote_tokens ────────────────────────────────────────────────────────────────

type ParsedSetRemoteTokens = ParsedGroupWrite & {
  rentReceiver?: PublicKey
  /** Per mint: chains to add or replace, and chains to drop (or, from a proposal, the full list). */
  updates: Map<string, { upsert: MemberChains; remove: Set<bigint>; replace?: MemberChains }>
  /** Re-checking a proposal: its drops and closes were chosen when it was built. */
  fromProposal?: boolean
  confirmDroppedLanes: PoolGroupLaneKey[]
  closeDroppedLanes: boolean
  confirmInFlightDrained: PoolGroupLaneKey[]
  acknowledged: PoolGroupLaneKey[] | 'all'
}

/** A member's remote tokens, with add/remove semantics (the token owner). */
export class SetPoolGroupMemberRemoteTokens extends PoolGroupWriteOperation<
  SetPoolGroupMemberRemoteTokensParams,
  ParsedSetRemoteTokens,
  SetPoolGroupMemberRemoteTokensResult
> {
  readonly name = 'setPoolGroupMemberRemoteTokens'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(
    params: SolanaGenerateParams<SetPoolGroupMemberRemoteTokensParams>,
  ): ParsedSetRemoteTokens {
    const updates: ParsedSetRemoteTokens['updates'] = new Map()
    const slot = (mint: string) => {
      const u = updates.get(mint) ?? { upsert: new Map(), remove: new Set<bigint>() }
      updates.set(mint, u)
      return u
    }
    const upsert: unknown = params.upsert ?? []
    if (!Array.isArray(upsert))
      throw new CCTParamsInvalidError(this.name, 'upsert', 'must be an array')
    upsert.forEach((m: unknown, i) => {
      const mint = parsePublicKey(
        this.name,
        `upsert[${i}].tokenAddress`,
        Reflect.get(Object(m), 'tokenAddress'),
      ).toBase58()
      for (const [s, t] of parseMemberChains(
        this.name,
        `upsert[${i}].remoteTokens`,
        Reflect.get(Object(m), 'remoteTokens'),
      ))
        slot(mint).upsert.set(s, t)
    })
    for (const l of parseLaneKeys(this.name, 'removeChains', params.removeChains)) {
      if (slot(l.tokenAddress).upsert.has(l.remoteChainSelector))
        throw new CCTParamsInvalidError(
          this.name,
          'removeChains',
          `${laneId(l)} is both upserted and removed`,
        )
      slot(l.tokenAddress).remove.add(l.remoteChainSelector)
    }
    if (!updates.size && params.rentReceiver === undefined)
      throw new CCTParamsInvalidError(
        this.name,
        'upsert',
        'give upsert, removeChains or rentReceiver',
      )
    const close: unknown = params.closeDroppedLanes
    if (close !== undefined && typeof close !== 'boolean')
      throw new CCTParamsInvalidError(this.name, 'closeDroppedLanes', 'must be a boolean')
    return {
      ...parseGroupWrite(this.name, params),
      updates,
      ...(params.rentReceiver !== undefined && {
        rentReceiver: parsePublicKey(this.name, 'rentReceiver', params.rentReceiver),
      }),
      confirmDroppedLanes: parseLaneKeys(
        this.name,
        'confirmDroppedLanes',
        params.confirmDroppedLanes,
      ),
      closeDroppedLanes: close === true,
      confirmInFlightDrained: parseLaneKeys(
        this.name,
        'confirmInFlightDrained',
        params.confirmInFlightDrained,
      ),
      acknowledged: parseLaneKeys(
        this.name,
        'acknowledgeLiveAdmission',
        params.acknowledgeLiveAdmission,
      ),
    }
  }

  /**
   * `set_member_remote_tokens` with each member's merged list, then (with `closeDroppedLanes`)
   * `close_group_lanes` per chain for the lanes the write drops, in the same transaction.
   * @throws {@link CCTParamsInvalidError} if a token is not a member of the group, `authority`
   *   does not own its pool, a remote token is another member's, a dropped live lane is not in
   *   `confirmDroppedLanes`, a lane to close is neither paused both ways nor confirmed drained, or
   *   a running chain admits a new chain unacknowledged
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedSetRemoteTokens,
  ): Promise<PoolGroupWritePlan<SetPoolGroupMemberRemoteTokensResult>> {
    const { ref, authority } = parsed
    const { group } = await readPoolGroup(this.name, chain, {
      program: ref.program,
      group: ref.group,
    })
    const all = await groupMembers(this.name, chain, ref)
    const mints = [...parsed.updates.keys()]
    const members = mints.map((m) => {
      const found = all.find((a) => a.mint === m)
      if (!found)
        throw new CCTParamsInvalidError(
          this.name,
          'upsert',
          `${m} is not a member of this pool group (InvalidGroupMember)`,
        )
      return found
    })
    const pools = await readPoolStates(
      this.name,
      chain,
      ref.program,
      mints.map((m) => new PublicKey(m)),
      authority,
    )
    if (parsed.rentReceiver) {
      const [info] = await getMultipleAccountsInfoPaged(chain.connection, [parsed.rentReceiver])
      requireRentReceiver(this.name, parsed.rentReceiver, info)
    }
    // the lists after the write
    const after = members.map(({ mint, member, chains }) => {
      const u = parsed.updates.get(mint)!
      if (u.replace) return { mint, member, before: chains, chains: u.replace }
      const next: MemberChains = new Map(chains)
      for (const s of u.remove) next.delete(s)
      for (const [s, t] of u.upsert) next.set(s, t)
      return { mint, member, before: chains, chains: next }
    })
    requireOwnRemoteTokens(
      this.name,
      'upsert',
      after.map(({ mint, chains }) => ({ mint, chains })),
      all,
    )
    // the member's driven lanes (its payer entries): dropped, re-pointed, or new chains admitted
    const laneKeys = after.flatMap(({ mint, member }) =>
      member.lanePayers.map((p) => ({
        mint: new PublicKey(mint),
        selector: p.remoteChainSelector,
      })),
    )
    const states = await readPoolGroupLaneStates(chain, ref.program, laneKeys)
    const stateOf = new Map(
      laneKeys.map((k, i) => [`${k.mint.toBase58()}:${k.selector}`, states[i]]),
    )
    const records = await chainRecords(chain, ref, [
      ...new Set(after.flatMap(({ chains, before }) => [...chains.keys(), ...before.keys()])),
    ])
    const dropped: {
      key: PoolGroupLaneKey
      live: boolean
      entry?: CloseLaneEntry
      state?: PoolGroupLaneState
    }[] = []
    const repointed: PoolGroupLaneKey[] = []
    const admitted: PoolGroupLaneKey[] = []
    for (const { mint, member, before, chains } of after) {
      const lanes = new Set(member.lanePayers.map((p) => p.remoteChainSelector))
      for (const s of lanes) {
        const key = { tokenAddress: mint, remoteChainSelector: s }
        const st = stateOf.get(laneId(key))
        if (!chains.has(s)) {
          const readable = st && !isUnread(st) ? st : undefined
          const live = !readable || !pausedBothWays(readable)
          dropped.push({
            key,
            live,
            ...(readable && {
              state: readable,
              entry: closeLaneEntry(this.name, ref.program, member, readable),
            }),
          })
        } else if (
          !before.get(s)!.token.equals(chains.get(s)!.token) ||
          before.get(s)!.decimals !== chains.get(s)!.decimals
        )
          repointed.push(key)
      }
      for (const s of chains.keys()) {
        const r = records.get(s)
        if (
          !before.has(s) &&
          !lanes.has(s) &&
          r &&
          admitsLive(r.record, r.data, member.memberIndex)
        )
          admitted.push({ tokenAddress: mint, remoteChainSelector: s })
      }
    }
    requireAdmissionAcknowledged(this.name, admitted, parsed.acknowledged)
    const confirmed = new Set(parsed.confirmDroppedLanes.map(laneId))
    const unconfirmed = parsed.fromProposal
      ? []
      : dropped.filter((d) => d.live && !confirmed.has(laneId(d.key)))
    if (unconfirmed.length)
      throw new CCTParamsInvalidError(
        this.name,
        'confirmDroppedLanes',
        `the write drops ${unconfirmed.length} live driven lane(s) (${unconfirmed.map((d) => laneId(d.key)).join(', ')}): a dropped lane keeps working until anyone closes it, and closing strands inbound messages in flight. List them in confirmDroppedLanes`,
        { context: { lanes: unconfirmed.map((d) => d.key) } },
      )
    const toClose = parsed.closeDroppedLanes ? dropped : []
    if (toClose.some((d) => !d.entry))
      throw new CCTParamsInvalidError(
        this.name,
        'closeDroppedLanes',
        'a dropped lane cannot be read, so it is not closed here: close it with closePoolGroupLanes',
      )
    if (!parsed.fromProposal)
      requireDrained(
        this.name,
        toClose.map((d) => ({ key: d.key, state: d.state! })),
        parsed.confirmInFlightDrained,
      )
    const client = createPoolGroupProgram(chain, ref.program, parsed.payer)
    const registry = poolGroupPdas.groupRegistry(ref.program, ref.group)
    const setIx = await client.methods
      .setMemberRemoteTokens({
        rentReceiver: parsed.rentReceiver ?? null,
        members: after.map(({ mint, chains }) => ({
          mint: new PublicKey(mint),
          remoteTokens: memberEntriesOf(chains),
        })),
      })
      .accountsStrict({
        group: ref.group,
        groupRegistry: registry,
        groupOwner: null,
        authority,
        systemProgram: SystemProgram.programId,
        ...eventAccounts(ref.program),
      })
      .remainingAccounts(
        after.flatMap(({ member }, i) => [
          meta(pools[i]!.address, false),
          meta(poolGroupPdas.groupMember(ref.program, new PublicKey(member.mint)), true),
          meta(parsed.rentReceiver ?? new PublicKey(member.rentReceiver), true),
        ]),
      )
      .instruction()
    const closeIxs = await closeLanesInstructions(
      chain,
      ref,
      parsed.payer,
      authority,
      group.owner,
      toClose.map((d) => d.entry!),
    )
    const staleLanes = dropped.map((d) => d.key)
    const lanesToClose = toClose.map((d) => d.key)
    const followUps: PoolGroupFollowUp[] = [
      ...(repointed.length
        ? [
            {
              operation: 'materializePoolGroupLanes',
              reason: `${repointed.length} driven lane(s) keep their old remote token until re-synced, which the program applies only while the chain's driven lanes are paused: pause them, then materialize with resync`,
              inputs: { lanes: repointed, resync: true },
            },
          ]
        : []),
      ...(staleLanes.length && !lanesToClose.length
        ? [
            {
              operation: 'closePoolGroupLanes',
              reason:
                'the dropped lanes keep working until closed; anyone can close them, which strands inbound messages in flight: pause and drain first',
              inputs: { lanes: staleLanes },
            },
          ]
        : []),
    ]
    return {
      group: ref.group,
      items: [
        {
          tokenAddresses: mints,
          instructions: [setIx, ...closeIxs],
          signerRoles: { [authority.toBase58()]: 'pool-owner' },
        },
      ],
      judge: { failsClosedSeverity: 'error', drainConfirmed: lanesToClose },
      expected: {
        [`members.remoteTokens`]: after.map(({ mint, before }) => [
          mint,
          publicRemoteTokens(before),
        ]),
        [`members.lanePayers`]: after.map(({ mint, member }) => [
          mint,
          member.lanePayers.map((p) => p.remoteChainSelector),
        ]),
        'chains.admission': admissionExpected(records),
      },
      goingLive: admitted,
      followUps: () => followUps,
      extra: { staleLanes, lanesToClose },
    }
  }

  /** The full lists a proposal writes, and the lanes it closes after. */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedSetRemoteTokens {
    const ixs = decodeOne(
      this.name,
      instructions,
      ['setMemberRemoteTokens', 'closeGroupLanes'],
      false,
    )
    const set = ixs.find((d) => d.name === 'setMemberRemoteTokens')
    if (!set)
      throw new CCTParamsInvalidError(
        this.name,
        'transactions',
        'the proposal sets no remote tokens',
      )
    const updates: ParsedSetRemoteTokens['updates'] = new Map()
    const members = field(set.data, 'params', 'members')
    for (const m of Array.isArray(members) ? members : [])
      updates.set(keyField(this.name, m, 'mint').toBase58(), {
        upsert: new Map(),
        remove: new Set(),
        replace: chainsOfData(field(m, 'remoteTokens')),
      })
    const receiver = field(set.data, 'params', 'rentReceiver')
    const closes = ixs.some((d) => d.name === 'closeGroupLanes')
    return {
      ...proposalBase(ref, set.ix.keys[3]!.pubkey, guardOptions),
      updates,
      ...(receiver instanceof PublicKey && { rentReceiver: receiver }),
      // the proposal already chose: every drop it makes is confirmed, its closes drained
      confirmDroppedLanes: [],
      closeDroppedLanes: closes,
      confirmInFlightDrained: [],
      acknowledged: 'all',
      fromProposal: true,
    }
  }
}

/**
 * `close_group_lanes` instructions for `entries`, one per chain, each with the named records its
 * lanes reference and the group owner's wallet (the fallback refund receiver). @internal
 */
export async function closeLanesInstructions(
  chain: SolanaChain,
  ref: ParsedPoolGroupRef,
  payer: PublicKey,
  authority: PublicKey,
  groupOwner: PublicKey,
  entries: readonly CloseLaneEntry[],
): Promise<TransactionInstruction[]> {
  const bySelector = new Map<bigint, CloseLaneEntry[]>()
  for (const e of entries)
    bySelector.set(e.key.remoteChainSelector, [
      ...(bySelector.get(e.key.remoteChainSelector) ?? []),
      e,
    ])
  const client = createPoolGroupProgram(chain, ref.program, payer)
  const out: TransactionInstruction[] = []
  for (const [selector, lanes] of bySelector) {
    const records = [...new Set(lanes.flatMap((l) => l.refs))].map((r) =>
      meta(new PublicKey(r), true),
    )
    out.push(
      await client.methods
        .closeGroupLanes(new BN(selector.toString()), { recordCount: records.length })
        .accountsStrict({
          group: ref.group,
          groupChainPolicy: poolGroupPdas.groupChain(ref.program, ref.group, selector),
          groupRegistry: poolGroupPdas.groupRegistry(ref.program, ref.group),
          authority,
          systemProgram: SystemProgram.programId,
          ...eventAccounts(ref.program),
        })
        .remainingAccounts([...records, meta(groupOwner, true), ...lanes.flatMap((l) => l.metas)])
        .instruction(),
    )
  }
  return out
}

// ─── close_group_members ─────────────────────────────────────────────────────────────────────

type ParsedCloseMembers = ParsedGroupWrite & {
  lanes: { mints: PublicKey[] } | { members: PublicKey[] }
}

/** Closes memberships: the token owner, or the pool group owner or policy admin. */
export class ClosePoolGroupMembers extends PoolGroupWriteOperation<
  ClosePoolGroupMembersParams,
  ParsedCloseMembers
> {
  readonly name = 'closePoolGroupMembers'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(
    params: SolanaGenerateParams<ClosePoolGroupMembersParams>,
  ): ParsedCloseMembers {
    const mints = parseTokenAddresses(this.name, params.tokenAddresses)
    if (!mints?.length)
      throw new CCTParamsInvalidError(this.name, 'tokenAddresses', 'must name at least one member')
    return { ...parseGroupWrite(this.name, params), lanes: { mints } }
  }

  /**
   * `close_group_members`: the group owner's wallet (the fallback receiver), then per member its
   * `GroupMember`, pool `State` and rent receiver.
   * @throws {@link CCTParamsInvalidError} if a token is not a member, still has driven lanes
   *   (close them with closePoolGroupLanes), or `authority` is neither its pool owner nor the group
   *   owner or policy admin
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedCloseMembers,
  ): Promise<PoolGroupWritePlan<object>> {
    const { ref, authority } = parsed
    const addresses =
      'members' in parsed.lanes
        ? parsed.lanes.members
        : parsed.lanes.mints.map((m) => poolGroupPdas.groupMember(ref.program, m))
    const { group, extras } = await readPoolGroup(
      this.name,
      chain,
      { program: ref.program, group: ref.group },
      addresses,
    )
    const members = addresses.map((a, i) => {
      const info = extras[i]
      const member = info?.owner.equals(ref.program)
        ? decodePoolGroupMember(info.data, a.toBase58())
        : null
      if (!member || member.poolGroupAddress !== ref.group.toBase58())
        throw new CCTParamsInvalidError(
          this.name,
          `tokenAddresses[${i}]`,
          `${a.toBase58()} is not a member of this pool group`,
        )
      if (member.laneCount)
        throw new CCTParamsInvalidError(
          this.name,
          `tokenAddresses[${i}]`,
          `${member.mint} still has ${member.laneCount} driven lane(s) (GroupMemberHasLanes): drop the chains and close them with closePoolGroupLanes first`,
        )
      return member
    })
    const mints = members.map((m) => new PublicKey(m.mint))
    const pools = await readPoolStates(this.name, chain, ref.program, mints)
    const roles = (await import('../decode.ts')).decodeRoles(group.roles)
    const admin = group.owner.equals(authority) || roles.policyAdmin === authority.toBase58()
    pools.forEach((p, i) => {
      if (!admin && !p.state.owner.equals(authority))
        throw new CCTParamsInvalidError(
          this.name,
          'authority',
          `${authority.toBase58()} is neither the pool owner of ${members[i]!.mint} nor the pool group owner or policy admin, who close a membership`,
        )
    })
    const client = createPoolGroupProgram(chain, ref.program, parsed.payer)
    const entries = members.map((m, i) => ({
      mint: mints[i]!,
      metas: [
        meta(addresses[i]!, true),
        meta(pools[i]!.address, false),
        meta(new PublicKey(m.rentReceiver), true),
      ],
    }))
    const items = await fittedItems(
      this.name,
      chain,
      parsed,
      entries,
      (chunk) =>
        client.methods
          .closeGroupMembers()
          .accountsStrict({
            group: ref.group,
            groupRegistry: poolGroupPdas.groupRegistry(ref.program, ref.group),
            groupOwner: null,
            authority,
            systemProgram: SystemProgram.programId,
            ...eventAccounts(ref.program),
          })
          .remainingAccounts([meta(group.owner, true), ...chunk.flatMap((e) => e.metas)])
          .instruction(),
      {
        signerRoles: { [authority.toBase58()]: admin ? 'pool-group-role' : 'pool-owner' },
        tokenAddressesOf: (chunk) => chunk.map((e) => e.mint.toBase58()),
        describe: (e) => `the member ${e.mint.toBase58()}`,
      },
    )
    return {
      group: ref.group,
      items,
      judge: { failsClosedSeverity: 'error' },
      expected: { 'members.laneCount': members.map((m) => [m.mint, m.laneCount]) },
      extra: {},
    }
  }

  /** The members a proposal closes (after 7 accounts and the owner's wallet: member first). */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedCloseMembers {
    const ixs = decodeOne(this.name, instructions, ['closeGroupMembers'], false)
    return {
      ...proposalBase(ref, ixs[0]!.ix.keys[3]!.pubkey, guardOptions),
      lanes: { members: everyLane(ixs, 8, 3) },
    }
  }
}

/** The membership ops, by name: the snapshot check runs their re-checks. @internal */
export const POOL_GROUP_MEMBERSHIP_OPERATIONS = {
  joinPoolGroup: new JoinPoolGroup(),
  setPoolGroupMemberRemoteTokens: new SetPoolGroupMemberRemoteTokens(),
  closePoolGroupMembers: new ClosePoolGroupMembers(),
} as const
