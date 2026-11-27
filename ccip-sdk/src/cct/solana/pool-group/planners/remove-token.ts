/**
 * `removeMultiTokenPoolToken` on Solana: the token leaves the pool group (design §8.3 `leave`). Its
 * lanes' outbound is paused first; each lane then waits until the remote side stopped sending and
 * the inbound messages in flight drained (`blockedBy` until then); a linked lane sending long data
 * gets its own fee raised before it is unlinked (it then serves on its own fields); a driven lane's
 * chain is dropped from the member and the lane closed in the same transaction; with no chain
 * filter the membership closes last. No delist (design addendum §4).
 *
 * @packageDocumentation
 */

import { PublicKey } from '@solana/web3.js'

import { CCTParamsInvalidError } from '../../../errors.ts'
import {
  LONG_POOL_DATA_BYTES,
  type MultiTokenPoolLaneKey,
  type MultiTokenPoolPlanBlock,
  longPoolDataBytes,
} from '../../../multi-token-pool.ts'
import { decodeRemoteAddress } from '../../../remote-address.ts'
import { EditChainConfigV2 } from '../../token-pool/operations/edit-chain-config-v2.ts'
import { readTokenPoolChainConfigV2 } from '../../token-pool/operations/chain-config-v2.ts'
import { U64_MAX, parsePublicKey, validateBigInt } from '../../validate.ts'
import { isUnread } from '../lane.ts'
import { parsePoolGroupRef } from '../operations/common.ts'
import { GetPoolGroup } from '../operations/get-pool-group.ts'
import { GetPoolGroupChain } from '../operations/get-pool-group-chain.ts'
import { GetPoolGroupMembers } from '../operations/get-pool-group-members.ts'
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
import { opBase, opStep, poolOwnerSigner } from './flow-common.ts'
import type {
  GenerateRemoveMultiTokenPoolTokenParams,
  PoolGroupLeaveStepName,
} from './types.ts'

const NAME = 'removeMultiTokenPoolToken'
type Name = PoolGroupLeaveStepName

/** Parsed removal params. @internal */
export type ParsedRemoval = {
  mint: string
  /** Only these chains; `undefined`: every lane, and the membership closes. */
  selectors?: bigint[]
  confirmed: Set<string>
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
  const mint = parsePublicKey(NAME, 'tokenAddress', params.tokenAddress).toBase58()
  const solana = params.solana ?? {}
  let selectors: bigint[] | undefined
  if (solana.remoteChainSelectors !== undefined) {
    if (!Array.isArray(solana.remoteChainSelectors) || !solana.remoteChainSelectors.length)
      throw new CCTParamsInvalidError(NAME, 'solana.remoteChainSelectors', 'must be a non-empty array')
    selectors = solana.remoteChainSelectors.map((s, i) => {
      validateBigInt(NAME, `solana.remoteChainSelectors[${i}]`, s, 1n, U64_MAX)
      return s
    })
    if (new Set(selectors).size !== selectors.length)
      throw new CCTParamsInvalidError(NAME, 'solana.remoteChainSelectors', 'must list each chain once')
  }
  const confirmed = new Set<string>()
  for (const [i, l] of (solana.confirmInFlightDrained ?? []).entries()) {
    const m = parsePublicKey(NAME, `solana.confirmInFlightDrained[${i}].tokenAddress`, l.tokenAddress).toBase58()
    validateBigInt(NAME, `solana.confirmInFlightDrained[${i}].remoteChainSelector`, l.remoteChainSelector, 1n, U64_MAX)
    confirmed.add(laneKeyOf({ tokenAddress: m, remoteChainSelector: l.remoteChainSelector }))
  }
  return { ref, parsed: { mint, ...(selectors && { selectors }), confirmed } }
}

/** One lane that leaves. */
type LeavingLane = {
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
  remoteToken: string
  remotePools: string[]
}

/**
 * Whether the remote side of a lane stopped sending toward this chain: the remote multi-token pool's
 * lane is paused or stopped outbound, or has no connection. `null` when it cannot be read.
 */
async function remoteOutboundStopped(
  ctx: PlannerContext,
  lane: LeavingLane,
): Promise<{ stopped: boolean } | { unread: string }> {
  const { remoteChainOf } = await import('../../../evm/pool-config-manager/guard-facts.ts')
  const remote = await remoteChainOf({ ...(ctx.getChain && { getChain: ctx.getChain }) }, lane.key.remoteChainSelector)
  if ('status' in remote) return { unread: remote.reason }
  const { EVMChain } = await import('../../../../evm/index.ts')
  if (!(remote instanceof EVMChain)) return { unread: 'only an EVM remote side is read' }
  const { EVMTokenManager } = await import('../../../evm/index.ts')
  const evm = EVMTokenManager.fromChain(remote)
  const reasons: string[] = []
  for (const pool of lane.remotePools) {
    try {
      const view = await evm.getMultiTokenPoolLane({
        poolAddress: pool,
        tokenAddress: lane.remoteToken,
        remoteChainSelector: ctx.chain.network.chainSelector,
      })
      return { stopped: !view.exists || view.outboundStatus.status !== 'ok' || view.stopped.outbound }
    } catch (err) {
      reasons.push(`${pool}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { unread: reasons.join('; ') || 'the lane trusts no remote pool' }
}

/**
 * Expands the removal from one state read into its steps.
 * @internal
 */
export async function expandRemoval(
  ctx: PlannerContext,
  parsed: ParsedRemoval,
): Promise<Expansion<Name>> {
  const g = ctx.ref.group
  const refParams = { poolProgramAddress: ctx.ref.program.toBase58(), poolGroupAddress: g.toBase58() }
  const slot = BigInt(await ctx.chain.connection.getSlot('confirmed'))
  const group = await new GetPoolGroup().query(ctx.chain, refParams)
  const { poolGroupMembers } = await new GetPoolGroupMembers().query(ctx.chain, {
    ...refParams,
    tokenAddresses: [parsed.mint],
  })
  const member = poolGroupMembers.find((m) => m.poolGroupAddress === g.toBase58())
  const memberChains = member?.remoteTokens.flatMap((t) => t.remoteChainSelectors) ?? []
  const inScope = (s: bigint) => !parsed.selectors || parsed.selectors.includes(s)
  const chains = [...new Set([...group.remoteChainSelectors, ...memberChains])].filter(inScope)
  const mint = new PublicKey(parsed.mint)
  const states = await readPoolGroupLaneStates(
    ctx.chain,
    ctx.ref.program,
    chains.map((selector) => ({ mint, selector })),
  )
  const [pool] = await readPoolStates(NAME, ctx.chain, ctx.ref.program, [mint])
  const owner = pool!.state.owner.toBase58()
  const lanes: LeavingLane[] = []
  for (const [i, s] of states.entries()) {
    if (!s) continue
    if (isUnread(s))
      throw new CCTParamsInvalidError(NAME, 'tokenAddress', `the lane of ${parsed.mint} toward ${chains[i]} cannot be read: ${s.reason}`)
    if (s.ext?.poolGroupAddress !== g.toBase58()) continue
    const selector = chains[i]!
    const record = await new GetPoolGroupChain().query(ctx.chain, { ...refParams, remoteChainSelector: selector, tokenAddresses: [parsed.mint] })
    const decode = (bytes: Uint8Array) => decodeRemoteAddress(Buffer.from(bytes), selector)
    const ownPools = s.chainConfig.base.remote.poolAddresses.map((p) => decode(p.address))
    const groupPools = record.policy.connection.remotePools.map((p) => p.address)
    lanes.push({
      key: { tokenAddress: parsed.mint, remoteChainSelector: selector },
      ownPools,
      groupPools,
      driven: s.ext.groupDriven,
      ownOutboundPaused: s.ext.pausedOutbound,
      ownInboundPaused: s.ext.pausedInbound,
      ownFormat: s.ext.poolDataFormat,
      uid: s.ext.uid,
      remoteToken: decode(s.chainConfig.base.remote.tokenAddress.address),
      remotePools: [...new Set([...groupPools, ...ownPools])],
    })
  }
  if (!lanes.length && !member)
    throw new CCTParamsInvalidError(NAME, 'tokenAddress', `${parsed.mint} has no lane and no membership in this pool group`)

  const specs: StepSpec<Name>[] = []
  // ── pause outbound (a Squads proposal writes both flags: inbound keeps its own) ──
  const toPause = lanes.filter((l) => !l.ownOutboundPaused)
  const pauseIdOf = new Map<string, string>()
  const groups = ctx.squads
    ? [true, false].map((inbound) => toPause.filter((l) => l.ownInboundPaused === inbound))
    : [toPause]
  for (const [i, list] of groups.entries()) {
    if (!list.length) continue
    const id = stepId(ctx, 'setPoolGroupLanePause', parsed.mint, groups.length > 1 ? i : undefined)
    for (const l of list) pauseIdOf.set(laneKeyOf(l.key), id)
    specs.push(
      opStep(
        ctx,
        {
          id,
          name: 'pauseLaneOutbound',
          operation: 'setPoolGroupLanePause',
          summary: `pause outbound on ${list.length} lane(s) of ${parsed.mint}`,
          writeSet: list.map((l) => keys.lane(parsed.mint, l.key.remoteChainSelector)),
          guardReads: [],
          signer: poolOwnerSigner(ctx, owner, parsed.mint),
          progress: list.length,
        },
        POOL_GROUP_PAUSE_OPERATIONS.setPoolGroupLanePause,
        {
          ...opBase(ctx),
          tokenAddress: parsed.mint,
          remoteChainSelectors: list.map((l) => l.key.remoteChainSelector),
          pausedOutbound: true,
          ...(ctx.squads && { pausedInbound: list[0]!.ownInboundPaused }),
        },
      ),
    )
  }

  // ── await the remote stop and the drain, per lane ──
  const drainIdOf = new Map<string, string>()
  for (const l of lanes) {
    const k = laneKeyOf(l.key)
    const remoteId = stepId(ctx, 'awaitRemoteOutboundStop', l.key.remoteChainSelector, parsed.mint)
    const drainId = stepId(ctx, 'awaitDrain', l.key.remoteChainSelector, parsed.mint)
    drainIdOf.set(k, drainId)
    const confirmed = parsed.confirmed.has(k)
    specs.push(
      specOf(
        ctx,
        {
          id: remoteId,
          name: 'awaitRemoteOutboundStop',
          operation: 'getMultiTokenPoolLane',
          dependsOn: pauseIdOf.has(k) ? [pauseIdOf.get(k)!] : [],
          summary: `wait until ${l.key.remoteChainSelector} stops sending ${parsed.mint}'s counterpart here`,
          inputs: { lane: [l.key.tokenAddress, l.key.remoteChainSelector] },
          writeSet: [],
          guardReads: [`remote:${l.key.remoteChainSelector}:${l.remoteToken}`],
          signer: { kind: 'anyone' },
        },
        {
          evaluate: async (): Promise<MultiTokenPoolPlanBlock | null> => {
            const r = await remoteOutboundStopped(ctx, l)
            if ('stopped' in r)
              return r.stopped
                ? null
                : {
                    reason: `the remote side of ${parsed.mint} → ${l.key.remoteChainSelector} still sends toward this chain: stop it there first (pause or stop its outbound lane), so no new message strands here`,
                    remoteChainSelector: l.key.remoteChainSelector,
                  }
            return confirmed
              ? null
              : {
                  reason: `the remote side of ${parsed.mint} → ${l.key.remoteChainSelector} cannot be read (${r.unread}): stop it there, then list the lane in solana.confirmInFlightDrained`,
                  remoteChainSelector: l.key.remoteChainSelector,
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
          summary: `wait until the inbound messages of ${parsed.mint} from ${l.key.remoteChainSelector} drained`,
          inputs: { lane: [l.key.tokenAddress, l.key.remoteChainSelector] },
          writeSet: [],
          guardReads: [keys.lane(parsed.mint, l.key.remoteChainSelector)],
          signer: { kind: 'anyone' },
        },
        {
          evaluate: () =>
            Promise.resolve(
              confirmed
                ? null
                : {
                    reason: `inbound messages of ${parsed.mint} from ${l.key.remoteChainSelector} may still be in flight: once none is (CCIP Explorer or API), list the lane in solana.confirmInFlightDrained`,
                    remoteChainSelector: l.key.remoteChainSelector,
                  },
            ),
        },
      ),
    )
  }

  // ── linked lanes: own fee first when they send long data, then unlink ──
  const leaveIds: string[] = []
  for (const l of lanes.filter((x) => !x.driven)) {
    const k = laneKeyOf(l.key)
    const after = [drainIdOf.get(k)!]
    if (l.ownFormat === 'long') {
      const own = await readTokenPoolChainConfigV2(ctx.chain, ctx.ref.program, mint, l.key.remoteChainSelector)
      const need = l.uid !== null ? longPoolDataBytes(32) : LONG_POOL_DATA_BYTES
      const fee = own?.tokenTransferFeeConfig
      if (!fee?.isEnabled || fee.destBytesOverhead < need) {
        const id = stepId(ctx, 'editChainConfigV2', l.key.remoteChainSelector, parsed.mint)
        after.push(id)
        const config = {
          destGasOverhead: fee?.destGasOverhead ?? 0,
          destBytesOverhead: Math.max(need, fee?.destBytesOverhead ?? 0),
          finalityFeeUSDCents: fee?.finalityFee ?? 0,
          fastFinalityFeeUSDCents: fee?.fastFinalityFee ?? 0,
          finalityTransferFeeBps: fee?.finalityBpsFee ?? 0,
          fastFinalityTransferFeeBps: fee?.fastFinalityBpsFee ?? 0,
          isEnabled: true,
        }
        const params = {
          poolProgramAddress: ctx.ref.program.toBase58(),
          tokenAddress: parsed.mint,
          remoteChainSelector: l.key.remoteChainSelector,
          tokenTransferFeeConfig: config,
          authority: owner,
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
              dependsOn: [drainIdOf.get(k)!],
              summary: `raise the own fee of ${parsed.mint} → ${l.key.remoteChainSelector} to cover long pool data before it leaves the group`,
              inputs: { ...params, getChain: undefined },
              writeSet: [keys.lane(parsed.mint, l.key.remoteChainSelector)],
              guardReads: [],
              signer: poolOwnerSigner(ctx, owner, parsed.mint),
            },
            {
              run: {
                generate: async (payer) => ({
                  transactions: [toPlannerTx(await edit.generate(ctx.chain, { ...params, payer }), payer, [parsed.mint])],
                  findings: [],
                }),
                execute: async (wallet, computeUnits) => ({
                  hashes: [(await edit.execute(ctx.chain, { ...params, wallet, ...(computeUnits !== undefined && { computeUnits }) })).hash],
                  findings: [],
                }),
              },
            },
          ),
        )
      }
    }
    // unlinked, the lane trusts only its own pools: the group's others are dropped (A21)
    const dropped = l.groupPools.filter((a) => !l.ownPools.includes(a))
    const id = stepId(ctx, 'unlinkPoolGroupLanes', l.key.remoteChainSelector, parsed.mint)
    leaveIds.push(id)
    specs.push(
      opStep(
        ctx,
        {
          id,
          name: 'unlinkPoolGroupLanes',
          operation: 'unlinkPoolGroupLanes',
          dependsOn: after,
          summary: `unlink ${parsed.mint} → ${l.key.remoteChainSelector} from the pool group (it keeps its own fields)`,
          writeSet: [keys.lane(parsed.mint, l.key.remoteChainSelector), keys.chain(g, l.key.remoteChainSelector)],
          guardReads: [],
          signer: poolOwnerSigner(ctx, owner, parsed.mint),
        },
        POOL_GROUP_LANE_OPERATIONS.unlinkPoolGroupLanes,
        {
          ...opBase(ctx),
          remoteChainSelector: l.key.remoteChainSelector,
          tokenAddresses: [parsed.mint],
          ...(dropped.length && { confirmDropped: [{ lane: l.key, remotePools: dropped }] }),
        },
      ),
    )
  }

  // ── driven lanes: drop the chains and close the lanes in one transaction ──
  const driven = lanes.filter((l) => l.driven)
  const dropChains = [
    ...new Set([...driven.map((l) => l.key.remoteChainSelector), ...memberChains.filter(inScope)]),
  ]
  if (member && dropChains.length) {
    const closing: MultiTokenPoolLaneKey[] = driven.map((l) => l.key)
    const id = stepId(ctx, 'setPoolGroupMemberRemoteTokens', parsed.mint)
    leaveIds.push(id)
    specs.push(
      opStep(
        ctx,
        {
          id,
          name: 'dropChainsAndCloseLanes',
          operation: 'setPoolGroupMemberRemoteTokens',
          dependsOn: driven.map((l) => drainIdOf.get(laneKeyOf(l.key))!),
          summary: `drop ${dropChains.length} chain(s) from ${parsed.mint}'s member and close its ${closing.length} driven lane(s)`,
          writeSet: [keys.member(parsed.mint), ...closing.map((l) => keys.lane(l.tokenAddress, l.remoteChainSelector))],
          guardReads: dropChains.map((c) => keys.chain(g, c)),
          signer: poolOwnerSigner(ctx, owner, parsed.mint),
          progress: dropChains.length,
        },
        POOL_GROUP_MEMBERSHIP_OPERATIONS.setPoolGroupMemberRemoteTokens,
        {
          ...opBase(ctx),
          removeChains: dropChains.map((c) => ({ tokenAddress: parsed.mint, remoteChainSelector: c })),
          ...(closing.length && {
            confirmDroppedLanes: closing,
            closeDroppedLanes: true,
            confirmInFlightDrained: closing,
          }),
        },
      ),
    )
  }

  // ── the membership closes last (no chain filter) ──
  if (member && !parsed.selectors)
    specs.push(
      opStep(
        ctx,
        {
          id: stepId(ctx, 'closePoolGroupMembers', parsed.mint),
          name: 'closePoolGroupMembers',
          operation: 'closePoolGroupMembers',
          dependsOn: leaveIds,
          summary: `close ${parsed.mint}'s membership (rent to its receiver)`,
          writeSet: [keys.member(parsed.mint), keys.registry(g)],
          guardReads: [],
          signer: poolOwnerSigner(ctx, owner, parsed.mint),
        },
        POOL_GROUP_MEMBERSHIP_OPERATIONS.closePoolGroupMembers,
        { ...opBase(ctx), tokenAddresses: [parsed.mint] },
      ),
    )
  return { specs, findings: [], observedAt: slot, poolGroupId: group.poolGroupId, poolGroupAddress: g.toBase58() }
}
