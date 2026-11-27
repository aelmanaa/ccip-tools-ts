/**
 * `removeMultiTokenPoolToken` on Solana: one or more tokens leave the pool group (design §8.3
 * `leave`), batched across tokens (`solana.tokenAddresses`): every token joins the same waves. Their
 * lanes' outbound is paused first; each lane then waits until the remote side stopped sending (read
 * from the remote registry's pool, or attested where the SDK cannot read it) and the inbound
 * messages in flight drained (`blockedBy` until then); a linked lane sending long data gets its own
 * fee raised before it is unlinked (it then serves on its own fields); a driven lane's chain is
 * dropped from the member and the lane closed in the same transaction; with no chain filter the
 * memberships close last. No delist (design addendum §4).
 *
 * @packageDocumentation
 */

import { PublicKey } from '@solana/web3.js'

import type { RateLimiterState } from '../../../../chain.ts'
import { ChainFamily } from '../../../../networks.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { stableChunks } from '../../../multi-token-pool-plan-engine.ts'
import {
  type MultiTokenPoolLane,
  type MultiTokenPoolLaneKey,
  type MultiTokenPoolPlanBlock,
  type MultiTokenPoolRateLimits,
  LONG_POOL_DATA_BYTES,
  isLaneStopped,
  longPoolDataBytes,
} from '../../../multi-token-pool.ts'
import type { RateLimitConfig } from '../../../rate-limit.ts'
import { decodeRemoteAddress, laneFamilyOf } from '../../../remote-address.ts'
import { readTokenPoolChainConfigV2 } from '../../token-pool/operations/chain-config-v2.ts'
import { EditChainConfigV2 } from '../../token-pool/operations/edit-chain-config-v2.ts'
import { U64_MAX, parsePublicKey, validateBigInt } from '../../validate.ts'
import { isUnread } from '../lane.ts'
import type { SolanaLaneRemoteSide } from '../multi-token-pool-check.ts'
import { readSolanaMultiTokenPoolLane } from '../multi-token-pool-lane.ts'
import { parsePoolGroupRef } from '../operations/common.ts'
import { GetPoolGroupChain } from '../operations/get-pool-group-chain.ts'
import { GetPoolGroup } from '../operations/get-pool-group.ts'
import { readPoolGroupLaneStates } from '../operations/lane.ts'
import { POOL_GROUP_LANE_OPERATIONS } from '../operations/lanes.ts'
import { POOL_GROUP_MEMBERSHIP_OPERATIONS } from '../operations/membership.ts'
import { POOL_GROUP_PAUSE_OPERATIONS } from '../operations/pauses.ts'
import { readPoolStates } from '../operations/write-common.ts'
import type { PoolGroupLaneKey } from '../types.ts'
import {
  type Expansion,
  type PlannerContext,
  type StepSpec,
  keys,
  laneKeyOf,
  specOf,
  stepId,
  toPlannerTx,
} from './context.ts'
import { membersAmong, opBase, opStep, poolOwnerSigner } from './flow-common.ts'
import { MEMBERS_PER_STEP } from './onboard.ts'
import type { GenerateRemoveMultiTokenPoolTokenParams, PoolGroupLeaveStepName } from './types.ts'

const NAME = 'removeMultiTokenPoolToken'
type Name = PoolGroupLeaveStepName

/**
 * Tokens per drop-and-close step: the op keeps each token's drop and its lanes' close in one
 * transaction and packs the tokens apart (as many as fit), so a step may hold many.
 * @internal
 */
export const DROPS_PER_STEP = 12

/** Parsed removal params. @internal */
export type ParsedRemoval = {
  /** The mints that leave, in the caller's order. */
  mints: string[]
  /** Only these chains; `undefined`: every lane, and the memberships close. */
  selectors?: bigint[]
  /** Lanes whose remote stop the caller attests (unreadable remotes only). */
  remoteStopped: Set<string>
  /** Lanes whose inbound drain the caller attests. */
  confirmed: Set<string>
}

/** Parses a list of lane keys at `param` into `<mint>:<selector>` keys. */
function laneKeys(param: string, value: unknown): Set<string> {
  const out = new Set<string>()
  if (value === undefined) return out
  if (!Array.isArray(value)) throw new CCTParamsInvalidError(NAME, param, 'must be an array')
  for (const [i, l] of value.entries()) {
    const m = parsePublicKey(
      NAME,
      `${param}[${i}].tokenAddress`,
      Reflect.get(Object(l), 'tokenAddress'),
    ).toBase58()
    const selector: unknown = Reflect.get(Object(l), 'remoteChainSelector')
    validateBigInt(NAME, `${param}[${i}].remoteChainSelector`, selector, 1n, U64_MAX)
    out.add(laneKeyOf({ tokenAddress: m, remoteChainSelector: BigInt(String(selector)) }))
  }
  return out
}

/**
 * Parses the removal params before any RPC.
 * @throws {@link CCTParamsInvalidError} with the dotted path of the bad field
 * @internal
 */
export function parseRemoval(params: GenerateRemoveMultiTokenPoolTokenParams): {
  ref: ReturnType<typeof parsePoolGroupRef>
  parsed: ParsedRemoval
} {
  const ref = parsePoolGroupRef(NAME, params)
  const first = parsePublicKey(NAME, 'tokenAddress', params.tokenAddress).toBase58()
  const solana = params.solana ?? {}
  const more: unknown = solana.tokenAddresses
  if (more !== undefined && !Array.isArray(more))
    throw new CCTParamsInvalidError(NAME, 'solana.tokenAddresses', 'must be an array')
  const mints = [
    first,
    ...(solana.tokenAddresses ?? []).map((t, i) =>
      parsePublicKey(NAME, `solana.tokenAddresses[${i}]`, t).toBase58(),
    ),
  ]
  if (new Set(mints).size !== mints.length)
    throw new CCTParamsInvalidError(
      NAME,
      'solana.tokenAddresses',
      'must name each token once (tokenAddress included)',
    )
  let selectors: bigint[] | undefined
  if (solana.remoteChainSelectors !== undefined) {
    if (!Array.isArray(solana.remoteChainSelectors) || !solana.remoteChainSelectors.length)
      throw new CCTParamsInvalidError(
        NAME,
        'solana.remoteChainSelectors',
        'must be a non-empty array',
      )
    selectors = solana.remoteChainSelectors.map((s, i) => {
      validateBigInt(NAME, `solana.remoteChainSelectors[${i}]`, s, 1n, U64_MAX)
      return s
    })
    if (new Set(selectors).size !== selectors.length)
      throw new CCTParamsInvalidError(
        NAME,
        'solana.remoteChainSelectors',
        'must list each chain once',
      )
  }
  return {
    ref,
    parsed: {
      mints,
      ...(selectors && { selectors }),
      remoteStopped: laneKeys(
        'solana.confirmRemoteOutboundStopped',
        solana.confirmRemoteOutboundStopped,
      ),
      confirmed: laneKeys('solana.confirmInFlightDrained', solana.confirmInFlightDrained),
    },
  }
}

/** One lane that leaves. @internal */
export type LeavingLane = {
  key: PoolGroupLaneKey
  /** The lane's own remote pools. */
  ownPools: string[]
  /** The group chain record's CONNECTION pools. */
  groupPools: string[]
  driven: boolean
  ownOutboundPaused: boolean
  ownInboundPaused: boolean
  ownFormat: 'legacy' | 'long'
  uid: string | null
  /** A linked long lane's own fee, when it must be raised before it leaves (absent: enough). */
  raiseFee?: {
    destGasOverhead: number
    destBytesOverhead: number
    finalityFeeUSDCents: number
    fastFinalityFeeUSDCents: number
    finalityTransferFeeBps: number
    fastFinalityTransferFeeBps: number
    isEnabled: true
  }
}

/** One token that leaves, as read. @internal */
export type LeavingToken = {
  mint: string
  /** Its pool owner. */
  owner: string
  /** Present when it is a member of the pool group: the chains it lists (in scope). */
  member?: { chains: bigint[] }
  lanes: LeavingLane[]
}

/** What the removal expansion reads (a plain value: the goldens fake it). @internal */
export type RemovalInputs = {
  slot: bigint
  poolGroupId: string
  tokens: LeavingToken[]
}

/**
 * The remote stop of one lane: `stopped` from the remote registry's pool, or `unread` (with whether
 * the caller may attest it instead).
 * @internal
 */
export type RemoteStop =
  | { stopped: true }
  | { stopped: false; reason: string }
  | { unread: string; attestable: boolean }

/**
 * Whether the remote side of a lane stopped sending toward this chain (S6 review M3): the pool the
 * remote registry names (the one the remote Router sends through, read with `readEvmRemote`, the
 * lane check's reader) has its lane paused or stopped outbound. A delisted token (no registry pool)
 * is stopped; a multi-token pool with no lane toward this chain (`exists: false`) is not (fail
 * closed); a standard pool is stopped when it has no chain config toward this chain or a 0/0
 * outbound limiter (core's token-pool reads); a custom pool, or a remote the SDK cannot read, is
 * unread.
 * Unread is attestable only where the SDK cannot read it: a remote family it does not read, or a
 * `getChain` that was given and failed (M4); an EVM remote without `getChain` is not.
 * @internal
 */
export async function readRemoteStop(
  ctx: PlannerContext,
  key: PoolGroupLaneKey,
): Promise<RemoteStop> {
  const { remoteChainOf } = await import('../../../evm/pool-config-manager/guard-facts.ts')
  const selector = key.remoteChainSelector
  const remote = await remoteChainOf({ ...(ctx.getChain && { getChain: ctx.getChain }) }, selector)
  if ('status' in remote)
    return {
      unread: remote.reason,
      attestable: !!ctx.getChain || laneFamilyOf(selector) !== ChainFamily.EVM,
    }
  const read = await readSolanaMultiTokenPoolLane(
    NAME,
    ctx.chain,
    ctx.ref.program,
    new PublicKey(key.tokenAddress),
    selector,
  )
  if (!read.lane.remotePools.length || !read.lane.remoteToken)
    return {
      unread: 'the lane trusts no remote pool, so the remote registry cannot be found',
      attestable: true,
    }
  const { loadEvmRemoteReads, readEvmRemote } = await import('../multi-token-pool-check.ts')
  const base = await loadEvmRemoteReads()
  let view: MultiTokenPoolLane | undefined
  const side = await readEvmRemote(remote, read, ctx.chain.network.chainSelector, {
    ...base,
    getMultiTokenPoolLane: async (r, p) => (view = await base.getMultiTokenPoolLane(r, p)),
  })
  // a standard pool with no FTF bucket in core's read: none only below 2.0 (no FTF there)
  let ftfVersion: 'pre-2.0' | 'unread' | undefined
  if (
    side.status === 'known' &&
    side.registryPool !== null &&
    !side.readsLongData &&
    side.back &&
    !side.back.fastOutbound
  ) {
    const version = await remote
      .typeAndVersion(side.registryPool)
      .then(([, v]) => v)
      .catch(() => undefined)
    ftfVersion = version !== undefined && Number(version.split('.')[0]) < 2 ? 'pre-2.0' : 'unread'
  }
  return remoteStopOf(side, view, ftfVersion)
}

/** A core rate limiter state as a bucket config (`null`: disabled). */
const bucketOf = (state: RateLimiterState): RateLimitConfig =>
  state ? { enabled: true, capacity: state.capacity, rate: state.rate } : { enabled: false }

/**
 * The remote stop a read of the remote side shows (pure): see {@link readRemoteStop}.
 * @param view - The registry's multi-token pool lane, when `readEvmRemote` read one.
 * @param ftfVersion - For a standard pool whose read shows no FTF bucket: `'pre-2.0'` (none
 *   exists), else unread.
 * @internal
 */
export function remoteStopOf(
  side: SolanaLaneRemoteSide,
  view?: MultiTokenPoolLane,
  ftfVersion?: 'pre-2.0' | 'unread',
): RemoteStop {
  if (side.status !== 'known') return { unread: side.reason, attestable: true }
  if (side.registryPool === null) return { stopped: true }
  // a standard pool, read through core's token-pool reads (S6 re-check R-minor 4): no chain config
  // toward this chain, or an enabled 0/0 outbound limiter (A17 stop), sends nothing here
  if (!side.readsLongData) {
    if (!side.back) return { stopped: true }
    // a 2.0 pool sends fast-finality transfers through its FTF bucket when enabled, even with the
    // default bucket at 0/0 (TokenPool.sol:427-434, :805-815): the shared rule judges both
    const fast = side.back.fastOutbound
    if (!fast && ftfVersion !== 'pre-2.0')
      return {
        unread: `the remote registry's standard pool ${side.registryPool} shows no fast-finality outbound bucket, so its stop is not read`,
        attestable: true,
      }
    const off: RateLimitConfig = { enabled: false }
    const limits: MultiTokenPoolRateLimits = {
      outbound: bucketOf(side.back.outbound),
      inbound: off,
      fastFinalityOutbound: fast ? bucketOf(fast.state) : off,
      fastFinalityInbound: off,
    }
    if (isLaneStopped(limits, 'outbound')) return { stopped: true }
    return {
      stopped: false,
      reason: `the remote registry's standard pool ${side.registryPool} has a chain config toward this chain whose outbound buckets (default and fast finality) are not both stopped`,
    }
  }
  if (!view)
    return {
      unread: `the remote registry's pool ${side.registryPool} answered no lane read`,
      attestable: true,
    }
  if (!view.exists)
    return {
      stopped: false,
      reason: `the remote registry's pool ${side.registryPool} shows no lane toward this chain, which is not read as stopped`,
    }
  if (view.outboundStatus.status !== 'ok' || view.stopped.outbound) return { stopped: true }
  return { stopped: false, reason: `the remote registry's pool ${side.registryPool} still sends` }
}

/**
 * Reads what {@link expandRemovalFrom} needs: per token its member, lanes of this group, the chain
 * records' pools and own fees.
 * @internal
 */
export async function readRemovalInputs(
  ctx: PlannerContext,
  parsed: ParsedRemoval,
): Promise<RemovalInputs> {
  const g = ctx.ref.group
  const refParams = {
    poolProgramAddress: ctx.ref.program.toBase58(),
    poolGroupAddress: g.toBase58(),
  }
  const slot = BigInt(await ctx.chain.connection.getSlot('confirmed'))
  const group = await new GetPoolGroup().query(ctx.chain, refParams)
  const members = new Map((await membersAmong(ctx, parsed.mints)).map((m) => [m.tokenAddress, m]))
  const inScope = (s: bigint) => !parsed.selectors || parsed.selectors.includes(s)
  const pools = await readPoolStates(
    NAME,
    ctx.chain,
    ctx.ref.program,
    parsed.mints.map((m) => new PublicKey(m)),
  )
  const records = new Map<bigint, string[]>()
  const groupPoolsOf = async (selector: bigint) => {
    if (!records.has(selector)) {
      const record = await new GetPoolGroupChain().query(ctx.chain, {
        ...refParams,
        remoteChainSelector: selector,
      })
      records.set(
        selector,
        record.policy.connection.remotePools.map((p) => p.address),
      )
    }
    return records.get(selector)!
  }
  const tokens: LeavingToken[] = []
  for (const [i, m] of parsed.mints.entries()) {
    const member = members.get(m)
    const memberChains = member?.remoteTokens.flatMap((t) => t.remoteChainSelectors) ?? []
    const chains = [...new Set([...group.remoteChainSelectors, ...memberChains])].filter(inScope)
    const mint = new PublicKey(m)
    const states = await readPoolGroupLaneStates(
      ctx.chain,
      ctx.ref.program,
      chains.map((selector) => ({ mint, selector })),
    )
    const lanes: LeavingLane[] = []
    for (const [j, s] of states.entries()) {
      if (!s) continue
      if (isUnread(s))
        throw new CCTParamsInvalidError(
          NAME,
          i === 0 ? 'tokenAddress' : `solana.tokenAddresses[${i - 1}]`,
          `the lane of ${m} toward ${chains[j]} cannot be read: ${s.reason}`,
        )
      if (s.ext?.poolGroupAddress !== g.toBase58()) continue
      const selector = chains[j]!
      const decode = (bytes: Uint8Array) => decodeRemoteAddress(Buffer.from(bytes), selector)
      const lane: LeavingLane = {
        key: { tokenAddress: m, remoteChainSelector: selector },
        ownPools: s.chainConfig.base.remote.poolAddresses.map((p) => decode(p.address)),
        groupPools: await groupPoolsOf(selector),
        driven: s.ext.groupDriven,
        ownOutboundPaused: s.ext.pausedOutbound,
        ownInboundPaused: s.ext.pausedInbound,
        ownFormat: s.ext.poolDataFormat,
        uid: s.ext.uid,
      }
      if (!lane.driven && lane.ownFormat === 'long') {
        const own = await readTokenPoolChainConfigV2(ctx.chain, ctx.ref.program, mint, selector)
        const need = lane.uid !== null ? longPoolDataBytes(32) : LONG_POOL_DATA_BYTES
        const fee = own?.tokenTransferFeeConfig
        if (!fee?.isEnabled || fee.destBytesOverhead < need)
          lane.raiseFee = {
            destGasOverhead: fee?.destGasOverhead ?? 0,
            destBytesOverhead: Math.max(need, fee?.destBytesOverhead ?? 0),
            finalityFeeUSDCents: fee?.finalityFee ?? 0,
            fastFinalityFeeUSDCents: fee?.fastFinalityFee ?? 0,
            finalityTransferFeeBps: fee?.finalityBpsFee ?? 0,
            fastFinalityTransferFeeBps: fee?.fastFinalityBpsFee ?? 0,
            isEnabled: true,
          }
      }
      lanes.push(lane)
    }
    tokens.push({
      mint: m,
      owner: pools[i]!.state.owner.toBase58(),
      ...(member && { member: { chains: memberChains.filter(inScope) } }),
      lanes,
    })
  }
  return { slot, poolGroupId: group.poolGroupId, tokens }
}

/**
 * Expands the removal from one state read into its steps.
 * @internal
 */
export async function expandRemoval(
  ctx: PlannerContext,
  parsed: ParsedRemoval,
): Promise<Expansion<Name>> {
  return expandRemovalFrom(ctx, parsed, await readRemovalInputs(ctx, parsed))
}

/**
 * The removal steps from what {@link readRemovalInputs} read (pure; the awaits read the remote side
 * when they are evaluated, through `remoteStop`). Chunk ids are stable over the caller's token
 * order (M1). Nothing left of the tokens in the group (a finished or resumed removal): an empty plan.
 * @internal
 */
export function expandRemovalFrom(
  ctx: PlannerContext,
  parsed: ParsedRemoval,
  inputs: RemovalInputs,
  remoteStop: (key: PoolGroupLaneKey) => Promise<RemoteStop> = (key) => readRemoteStop(ctx, key),
): Expansion<Name> {
  const g = ctx.ref.group
  const specs: StepSpec<Name>[] = []
  const drainIdOf = new Map<string, string>()
  const ownerOf = new Map(inputs.tokens.map((t) => [t.mint, t.owner]))

  for (const t of inputs.tokens) {
    // ── pause outbound, per mint (a Squads proposal writes both flags: inbound keeps its own) ──
    const toPause = t.lanes.filter((l) => !l.ownOutboundPaused)
    const pauseIdOf = new Map<string, string>()
    const groups = ctx.squads
      ? ([true, false] as const).map((inbound) => ({
          part: inbound ? 'inbound-paused' : 'inbound-open',
          list: toPause.filter((l) => l.ownInboundPaused === inbound),
        }))
      : [{ part: undefined, list: toPause }]
    for (const { part, list } of groups) {
      if (!list.length) continue
      const id = stepId(ctx, 'setPoolGroupLanePause', t.mint, part)
      for (const l of list) pauseIdOf.set(laneKeyOf(l.key), id)
      specs.push(
        opStep(
          ctx,
          {
            id,
            name: 'pauseLaneOutbound',
            operation: 'setPoolGroupLanePause',
            summary: `pause outbound on ${list.length} lane(s) of ${t.mint}`,
            writeSet: list.map((l) => keys.lane(t.mint, l.key.remoteChainSelector)),
            guardReads: [],
            signer: poolOwnerSigner(ctx, t.owner, t.mint),
            progress: list.length,
          },
          POOL_GROUP_PAUSE_OPERATIONS.setPoolGroupLanePause,
          {
            ...opBase(ctx),
            tokenAddress: t.mint,
            remoteChainSelectors: list.map((l) => l.key.remoteChainSelector),
            pausedOutbound: true,
            ...(ctx.squads && { pausedInbound: list[0]!.ownInboundPaused }),
          },
        ),
      )
    }

    // ── await the remote stop and the drain, per lane ──
    for (const l of t.lanes) {
      const k = laneKeyOf(l.key)
      const c = l.key.remoteChainSelector
      const remoteId = stepId(ctx, 'awaitRemoteOutboundStop', c, t.mint)
      const drainId = stepId(ctx, 'awaitDrain', c, t.mint)
      drainIdOf.set(k, drainId)
      const attested = parsed.remoteStopped.has(k)
      const drained = parsed.confirmed.has(k)
      specs.push(
        specOf(
          ctx,
          {
            id: remoteId,
            name: 'awaitRemoteOutboundStop',
            operation: 'getMultiTokenPoolLane',
            dependsOn: pauseIdOf.has(k) ? [pauseIdOf.get(k)!] : [],
            summary: `wait until ${c} stops sending ${t.mint}'s counterpart here`,
            inputs: { lane: [l.key.tokenAddress, c] },
            writeSet: [],
            guardReads: [`remote:${c}:${t.mint}`],
            signer: { kind: 'anyone' },
          },
          {
            evaluate: async (): Promise<MultiTokenPoolPlanBlock | null> => {
              const r = await remoteStop(l.key)
              if ('stopped' in r)
                return r.stopped
                  ? null
                  : {
                      reason: `the remote side of ${t.mint} → ${c} still sends toward this chain (${r.reason}): stop it there first (pause or stop its outbound lane), so no new message strands here`,
                      remoteChainSelector: c,
                    }
              if (!r.attestable)
                return {
                  reason: `the remote side of ${t.mint} → ${c} is not read (${r.unread}): pass getChain, so the SDK reads its outbound stop (a readable remote is never attested)`,
                  remoteChainSelector: c,
                }
              return attested
                ? null
                : {
                    reason: `the remote side of ${t.mint} → ${c} cannot be read (${r.unread}): stop it there, then list the lane in solana.confirmRemoteOutboundStopped`,
                    remoteChainSelector: c,
                  }
            },
          },
        ),
        specOf(
          ctx,
          {
            id: drainId,
            name: 'awaitDrain',
            operation: 'confirmInFlightDrained',
            dependsOn: [remoteId],
            summary: `wait until the inbound messages of ${t.mint} from ${c} drained`,
            inputs: { lane: [l.key.tokenAddress, c] },
            writeSet: [],
            guardReads: [keys.lane(t.mint, c)],
            signer: { kind: 'anyone' },
          },
          {
            evaluate: () =>
              Promise.resolve(
                drained
                  ? null
                  : {
                      reason: `inbound messages of ${t.mint} from ${c} may still be in flight: once none is (CCIP Explorer or API), list the lane in solana.confirmInFlightDrained`,
                      remoteChainSelector: c,
                    },
              ),
          },
        ),
      )
    }
  }

  // ── linked lanes: own fee first when they send long data, then unlink (per chain, batched) ──
  const leaveIdsOf = new Map<string, string[]>()
  const leaves = (mint: string, id: string) =>
    leaveIdsOf.set(mint, [...new Set([...(leaveIdsOf.get(mint) ?? []), id])])
  const linked = inputs.tokens.flatMap((t) => t.lanes.filter((l) => !l.driven))
  const feeIdOf = new Map<string, string>()
  for (const l of linked) {
    if (!l.raiseFee) continue
    const m = l.key.tokenAddress
    const c = l.key.remoteChainSelector
    const id = stepId(ctx, 'editChainConfigV2', c, m)
    feeIdOf.set(laneKeyOf(l.key), id)
    const params = {
      poolProgramAddress: ctx.ref.program.toBase58(),
      tokenAddress: m,
      remoteChainSelector: c,
      tokenTransferFeeConfig: l.raiseFee,
      authority: ownerOf.get(m)!,
      ...(ctx.getChain && { getChain: ctx.getChain }),
    }
    const edit = new EditChainConfigV2()
    specs.push(
      specOf(
        ctx,
        {
          id,
          name: 'raiseOwnFee',
          operation: 'editChainConfigV2',
          dependsOn: [drainIdOf.get(laneKeyOf(l.key))!],
          summary: `raise the own fee of ${m} → ${c} to cover long pool data before it leaves the group`,
          inputs: { ...params, getChain: undefined },
          writeSet: [keys.lane(m, c)],
          guardReads: [],
          signer: poolOwnerSigner(ctx, ownerOf.get(m), m),
        },
        {
          run: {
            generate: async (payer) => ({
              transactions: [
                toPlannerTx(
                  await edit.generate(ctx.chain, { ...params, payer }),
                  payer,
                  [m],
                  'pool-owner',
                ),
              ],
              findings: [],
            }),
            execute: async (wallet, computeUnits) => ({
              hashes: [
                (
                  await edit.execute(ctx.chain, {
                    ...params,
                    wallet,
                    ...(computeUnits !== undefined && { computeUnits }),
                  })
                ).hash,
              ],
              findings: [],
            }),
          },
        },
      ),
    )
  }
  for (const c of [...new Set(linked.map((l) => l.key.remoteChainSelector))]) {
    const onChain = new Map(
      linked.filter((l) => l.key.remoteChainSelector === c).map((l) => [l.key.tokenAddress, l]),
    )
    const linkedByOwner = new Map<string, string[]>()
    for (const m of parsed.mints)
      if (onChain.has(m))
        linkedByOwner.set(ownerOf.get(m)!, [...(linkedByOwner.get(ownerOf.get(m)!) ?? []), m])
    for (const [owner, list] of linkedByOwner)
      for (const { key, items: chunk } of stableChunks(
        list,
        MEMBERS_PER_STEP,
        () => true,
        (m) => m,
      ).chunks) {
        const id = stepId(ctx, 'unlinkPoolGroupLanes', c, key)
        const lanes = chunk.map((m) => onChain.get(m)!)
        for (const m of chunk) leaves(m, id)
        // unlinked, the lane trusts only its own pools: the group's others are dropped (A21)
        const dropped = lanes.flatMap((l) => {
          const pools = l.groupPools.filter((a) => !l.ownPools.includes(a))
          return pools.length ? [{ lane: l.key, remotePools: pools }] : []
        })
        specs.push(
          opStep(
            ctx,
            {
              id,
              name: 'unlinkPoolGroupLanes',
              operation: 'unlinkPoolGroupLanes',
              dependsOn: lanes.flatMap((l) => {
                const k = laneKeyOf(l.key)
                return [drainIdOf.get(k)!, ...(feeIdOf.has(k) ? [feeIdOf.get(k)!] : [])]
              }),
              summary: `unlink ${chunk.length} lane(s) toward ${c} from the pool group (they keep their own fields)`,
              writeSet: [...chunk.map((m) => keys.lane(m, c)), keys.chain(g, c)],
              guardReads: [],
              signer: poolOwnerSigner(ctx, owner),
              progress: chunk.length,
            },
            POOL_GROUP_LANE_OPERATIONS.unlinkPoolGroupLanes,
            {
              ...opBase(ctx),
              remoteChainSelector: c,
              tokenAddresses: chunk,
              ...(dropped.length && { confirmDropped: dropped }),
            },
          ),
        )
      }
  }

  // ── driven lanes: drop the chains and close the lanes in one transaction (tokens batched) ──
  const dropsOf = (t: LeavingToken) => {
    const driven = t.lanes.filter((l) => l.driven)
    return {
      driven,
      chains: [
        ...new Set([...driven.map((l) => l.key.remoteChainSelector), ...(t.member?.chains ?? [])]),
      ],
    }
  }
  const byOwner = new Map<string, LeavingToken[]>()
  for (const t of inputs.tokens) byOwner.set(t.owner, [...(byOwner.get(t.owner) ?? []), t])
  for (const [owner, list] of byOwner)
    for (const { key, items: chunk } of stableChunks(
      list,
      DROPS_PER_STEP,
      (t) => !!t.member && dropsOf(t).chains.length > 0,
      (t) => t.mint,
    ).chunks) {
      const id = stepId(ctx, 'setPoolGroupMemberRemoteTokens', key)
      const closing: MultiTokenPoolLaneKey[] = chunk.flatMap((t) =>
        dropsOf(t).driven.map((l) => l.key),
      )
      const removeChains = chunk.flatMap((t) =>
        dropsOf(t).chains.map((c) => ({ tokenAddress: t.mint, remoteChainSelector: c })),
      )
      for (const t of chunk) leaves(t.mint, id)
      specs.push(
        opStep(
          ctx,
          {
            id,
            name: 'dropChainsAndCloseLanes',
            operation: 'setPoolGroupMemberRemoteTokens',
            dependsOn: closing.map((l) => drainIdOf.get(laneKeyOf(l))!),
            summary: `drop ${removeChains.length} chain(s) from ${chunk.length} member(s) and close their ${closing.length} driven lane(s)`,
            writeSet: [
              ...chunk.map((t) => keys.member(t.mint)),
              ...closing.map((l) => keys.lane(l.tokenAddress, l.remoteChainSelector)),
            ],
            guardReads: [...new Set(removeChains.map((r) => keys.chain(g, r.remoteChainSelector)))],
            signer: poolOwnerSigner(ctx, owner),
            progress: removeChains.length,
          },
          POOL_GROUP_MEMBERSHIP_OPERATIONS.setPoolGroupMemberRemoteTokens,
          {
            ...opBase(ctx),
            removeChains,
            ...(closing.length && {
              confirmDroppedLanes: closing,
              closeDroppedLanes: true,
              confirmInFlightDrained: closing,
            }),
          },
        ),
      )
    }

  // ── the memberships close last (no chain filter) ──
  if (!parsed.selectors)
    for (const [owner, list] of byOwner)
      for (const { key, items: chunk } of stableChunks(
        list,
        MEMBERS_PER_STEP,
        (t) => !!t.member,
        (t) => t.mint,
      ).chunks)
        specs.push(
          opStep(
            ctx,
            {
              id: stepId(ctx, 'closePoolGroupMembers', key),
              name: 'closePoolGroupMembers',
              operation: 'closePoolGroupMembers',
              dependsOn: chunk.flatMap((t) => leaveIdsOf.get(t.mint) ?? []),
              summary: `close ${chunk.length} membership(s) (rent to their receivers)`,
              writeSet: [...chunk.map((t) => keys.member(t.mint)), keys.registry(g)],
              guardReads: [],
              signer: poolOwnerSigner(ctx, owner),
              progress: chunk.length,
            },
            POOL_GROUP_MEMBERSHIP_OPERATIONS.closePoolGroupMembers,
            { ...opBase(ctx), tokenAddresses: chunk.map((t) => t.mint) },
          ),
        )
  return {
    specs,
    findings: [],
    observedAt: inputs.slot,
    poolGroupId: inputs.poolGroupId,
    poolGroupAddress: g.toBase58(),
  }
}
