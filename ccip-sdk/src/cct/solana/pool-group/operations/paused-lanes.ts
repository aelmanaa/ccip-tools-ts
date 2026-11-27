/**
 * Driven lanes created paused, in the transaction that admits them (S6 review M6). On a running
 * chain, the write that lists a chain for a member (`set_member_remote_tokens`) or admits a member
 * (`set_group_chain_lanes`) makes its lane materializable by anyone, and `materialize_group_lanes`
 * creates it with both lane pause flags clear (members.rs:664-680). Appending
 * `materialize_group_lanes` and `set_lane_pause(true, true)` to that write's transaction leaves no
 * slot in which a third party can create the lane unpaused: the lane exists, paused both ways, from
 * the moment it is admitted. The lane check then runs on its real accounts and
 * `setPoolGroupLanePause` lifts the pause (an op that makes lanes live).
 *
 * Program of record: chainlink-ccip-solana 7558722, `members.rs:596-733` (materialize: anyone
 * signs), `pause.rs:158-203` (`set_lane_pause`: the lane owner, or the group owner or pauser to set a
 * flag; the lane must exist).
 *
 * @packageDocumentation
 */

import { BN } from '@coral-xyz/anchor'
import { type TransactionInstruction, PublicKey, SystemProgram } from '@solana/web3.js'

import type { SolanaChain } from '../../../../solana/index.ts'
import { deriveTokenPoolChainConfigV2Pda } from '../../../../solana/token-pool.ts'
import {
  deriveTokenPoolChainConfigPda,
  deriveTokenPoolConfigPda,
} from '../../programs/token-pool.ts'
import { poolGroupPdas, poolGroupsCoder } from '../accounts.ts'
import { createPoolGroupProgram } from '../program.ts'
import type { PoolGroupLaneKey } from '../types.ts'
import type { ParsedPoolGroupRef } from './common.ts'
import { meta } from './lanes.ts'
import { eventAccounts } from './write-common.ts'

/**
 * Per mint, in first-seen order: `materialize_group_lanes` for each of its lanes' chains, then one
 * `set_lane_pause` that pauses every one of those lanes both ways. `authority` signs both (it pays
 * the lane rent and must be the pools' owner, or the pool group owner or pauser).
 * @internal
 */
export async function pausedLaneInstructions(
  chain: SolanaChain,
  ref: Pick<ParsedPoolGroupRef, 'program' | 'group'>,
  payer: PublicKey,
  authority: PublicKey,
  lanes: readonly PoolGroupLaneKey[],
): Promise<Map<string, TransactionInstruction[]>> {
  const client = createPoolGroupProgram(chain, ref.program, payer)
  const byMint = new Map<string, bigint[]>()
  for (const l of lanes)
    byMint.set(l.tokenAddress, [...(byMint.get(l.tokenAddress) ?? []), l.remoteChainSelector])
  const out = new Map<string, TransactionInstruction[]>()
  for (const [m, selectors] of byMint) {
    const mint = new PublicKey(m)
    const ixs: TransactionInstruction[] = []
    for (const selector of selectors)
      ixs.push(
        await client.methods
          .materializeGroupLanes(new BN(selector.toString()))
          .accountsStrict({
            group: ref.group,
            groupChainPolicy: poolGroupPdas.groupChain(ref.program, ref.group, selector),
            groupRegistry: poolGroupPdas.groupRegistry(ref.program, ref.group),
            authority,
            systemProgram: SystemProgram.programId,
            ...eventAccounts(ref.program),
          })
          .remainingAccounts([
            meta(poolGroupPdas.groupMember(ref.program, mint), true),
            meta(deriveTokenPoolChainConfigPda(ref.program, selector, mint), true),
            meta(deriveTokenPoolChainConfigV2Pda(ref.program, selector, mint), true),
          ])
          .instruction(),
      )
    ixs.push(
      await client.methods
        .setLanePause({ mint, pausedOutbound: true, pausedInbound: true })
        .accountsStrict({
          state: deriveTokenPoolConfigPda(ref.program, mint),
          group: ref.group,
          authority,
          systemProgram: SystemProgram.programId,
          ...eventAccounts(ref.program),
        })
        .remainingAccounts(
          selectors.map((s) => meta(deriveTokenPoolChainConfigV2Pda(ref.program, s, mint), true)),
        )
        .instruction(),
    )
    out.set(m, ixs)
  }
  return out
}

/** The lane PDAs `pausedLaneInstructions` creates (for the packer's `createdPdas`). @internal */
export function pausedLanePdas(
  program: PublicKey,
  lanes: readonly PoolGroupLaneKey[],
): PublicKey[] {
  return lanes.flatMap((l) => {
    const mint = new PublicKey(l.tokenAddress)
    return [
      deriveTokenPoolChainConfigPda(program, l.remoteChainSelector, mint),
      deriveTokenPoolChainConfigV2Pda(program, l.remoteChainSelector, mint),
    ]
  })
}

/**
 * The lanes a proposal creates paused: the lanes of its `materialize_group_lanes` instructions that
 * a `set_lane_pause(true, true)` of the same proposal pauses. Instruction names are the IDL's.
 * @internal
 */
export function pausedLanesOf(
  program: PublicKey,
  decoded: readonly { name: string; data: unknown; ix: TransactionInstruction }[],
): PoolGroupLaneKey[] {
  const paused = new Set<string>()
  for (const d of decoded) {
    if (d.name !== 'setLanePause') continue
    const params: unknown = Reflect.get(Object(d.data), 'params')
    if (Reflect.get(Object(params), 'pausedOutbound') !== true) continue
    if (Reflect.get(Object(params), 'pausedInbound') !== true) continue
    for (const k of d.ix.keys.slice(6)) paused.add(k.pubkey.toBase58())
  }
  const out: PoolGroupLaneKey[] = []
  for (const d of decoded) {
    if (d.name !== 'materializeGroupLanes') continue
    const selector = BigInt(String(Reflect.get(Object(d.data), 'remoteChainSelector')))
    // after the 7 fixed accounts: GroupMember, ChainConfig, ChainConfigV2 per lane
    const lanes = d.ix.keys.slice(7)
    for (let i = 0; i + 2 < lanes.length; i += 3) {
      const v2 = lanes[i + 2]!.pubkey
      if (!paused.has(v2.toBase58())) continue
      const member = lanes[i]!.pubkey
      // the mint is the one whose ChainConfigV2 PDA this is: the proposal names it via set_lane_pause
      const pause = decoded.find(
        (p) => p.name === 'setLanePause' && p.ix.keys.slice(6).some((k) => k.pubkey.equals(v2)),
      )
      const mint: unknown = Reflect.get(Object(Reflect.get(Object(pause?.data), 'params')), 'mint')
      if (mint instanceof PublicKey && poolGroupPdas.groupMember(program, mint).equals(member))
        out.push({ tokenAddress: mint.toBase58(), remoteChainSelector: selector })
    }
  }
  return out
}

/** The pool group an instruction of these ops names: `set_lane_pause` names it second. @internal */
export function groupOfPausedLaneIx(ix: TransactionInstruction): PublicKey | undefined {
  const decoded = poolGroupsCoder.instruction.decode(Buffer.from(ix.data))
  return decoded?.name === 'setLanePause' ? ix.keys[1]?.pubkey : ix.keys[0]?.pubkey
}
