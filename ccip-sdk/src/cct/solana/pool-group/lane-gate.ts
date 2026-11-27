/**
 * The existing Solana lane ops, pool-group aware (S5, DESIGN §6.6 "extended existing ops"). On a
 * standard lane nothing changes. On a lane whose `ChainConfig` carries a pool-group marker:
 * - a group-governed field is refused with the pool-group op that writes it;
 * - the accounts the program needs are passed (`set_chain_rate_limit` finds the lane's
 *   `ChainConfigV2`; `edit_chain_config_v2` with inline FEE the group chain record and a named
 *   CONNECTION record);
 * - the write runs the shared write guard on that one lane (A21 drops, the make-live check, A23),
 *   as every pool-group write does.
 *
 * Program of record: chainlink-ccip-solana 7558722, `burnmint-token-pool/src/instructions/`
 * `token_pool_chain_config/*.rs` (`LaneGroupDriven`, `LaneLinked`, `RateLimitFromGroup`).
 *
 * @packageDocumentation
 */

import { type AccountMeta, PublicKey, TransactionInstruction } from '@solana/web3.js'

import type { SolanaChain } from '../../../solana/index.ts'
import { CCTParamsInvalidError } from '../../errors.ts'
import { deriveTokenPoolChainConfigPda } from '../programs/token-pool.ts'
import { decodePoolGroupLaneMarker, poolGroupPdas } from './accounts.ts'
import type { ParsedLaneOpOptions, PoolGroupLaneOpReport } from './lane-op-options.ts'
import { type PoolGroupLaneState, decodeLaneChainConfig, isUnread } from './lane.ts'
import { listPoolGroupLaneRequests } from './operations/get-pool-group-lane.ts'
import { readPoolGroupLaneStates } from './operations/lane.ts'
import { poolGroupTransactionsHash } from './snapshot.ts'
import {
  judgePoolGroupWrite,
  poolGroupGuardOptionsOf,
  sealPoolGroupSnapshot,
} from './write-guard.ts'

/** What an extended lane op writes, for its rules. @internal */
export type LaneOpKind =
  | 'editRemoteConfig'
  | 'appendRemotePools'
  | 'setRateLimit'
  | 'deleteChainConfig'
  | 'editChainConfigV2'
  | 'fastFinalityRateLimit'

/**
 * The lane's state when its `ChainConfig` carries a pool-group marker; `null` for a standard lane
 * (or no `ChainConfig`), which the op handles as today. One `getAccountInfo` for a standard lane.
 * @internal
 */
export async function markedLaneState(
  chain: SolanaChain,
  program: PublicKey,
  mint: PublicKey,
  selector: bigint,
): Promise<PoolGroupLaneState | null> {
  const address = deriveTokenPoolChainConfigPda(program, selector, mint)
  const info = await chain.connection.getAccountInfo(address)
  // a stub or a foreign account is no pool-group lane
  const owner: unknown = info?.owner
  if (!info || !(owner instanceof PublicKey) || !owner.equals(program)) return null
  const base = decodeLaneChainConfig(info.data, address)
  // a ChainConfig no pool layout writes fails closed with its own reason (S5 review m10)
  if (isUnread(base))
    throw new CCTParamsInvalidError(
      'lane',
      'tokenAddress',
      `the ChainConfig of ${mint.toBase58()} toward ${selector} cannot be decoded (${base.reason})`,
    )
  if (decodePoolGroupLaneMarker(info.data, base) === 'standard') return null
  const [state] = await readPoolGroupLaneStates(chain, program, [{ mint, selector }])
  if (!state) return null
  if (isUnread(state))
    throw new CCTParamsInvalidError(
      'lane',
      'tokenAddress',
      `the pool-group lane of ${mint.toBase58()} toward ${selector} cannot be read (${state.reason})`,
    )
  return state
}

const governedBy = {
  rateLimit:
    'setPoolGroupDefault or setPoolGroupChainPolicy (RATE_LIMIT), or editPoolGroupPolicyChainRecord for a named policy',
} as const

/**
 * Applies the pool-group rules of an extended lane op to `instruction` on the lane `state`
 * (already known marked): refuses a governed field, adds the accounts the program needs, and runs
 * the shared write guard on the lanes it affects (every lane of the group on the chain for a
 * remote-token edit, so `REMOTE_TOKEN_SHARED` sees the others). The guard's warnings, the lanes it
 * makes live and, unsigned, the snapshot come back in `poolGroup` (S5 review M5).
 * @returns The instruction to send (with the added remaining accounts) and the guard's report.
 * @throws {@link CCTParamsInvalidError} if the pool group governs the field (the reason names the
 *   pool-group op), CCV lists are given for a lane that takes SECURITY from its group, or the guard
 *   refuses the write
 * @internal
 */
export async function guardPoolGroupLaneOp(input: {
  operation: string
  chain: SolanaChain
  state: PoolGroupLaneState
  kind: LaneOpKind
  payer: PublicKey
  instruction: TransactionInstruction
  options: ParsedLaneOpOptions
  /** `editChainConfigV2`: whether the write passes CCV lists (the program ignores them on a group-SECURITY lane). */
  setsCcvs?: boolean
}): Promise<{ instruction: TransactionInstruction; poolGroup?: PoolGroupLaneOpReport }> {
  const { operation, chain, state, kind, options } = input
  const ext = state.ext
  const where = `the lane of ${state.mint.toBase58()} toward ${state.selector}`
  const group = ext?.poolGroupAddress ?? null
  if (state.kind === 'driven' && (kind === 'editRemoteConfig' || kind === 'appendRemotePools'))
    throw new CCTParamsInvalidError(
      operation,
      'tokenAddress',
      `${where} is group-driven (LaneGroupDriven): its remote token comes from its member (setPoolGroupMemberRemoteTokens, then materializePoolGroupLanes with resync) and its pools from the group (setPoolGroupChainPolicy)`,
    )
  if (kind === 'deleteChainConfig')
    throw new CCTParamsInvalidError(
      operation,
      'tokenAddress',
      `${where} carries a pool-group marker (LaneLinked): ${
        state.kind === 'driven'
          ? 'close it with closePoolGroupLanes'
          : group
            ? 'unlink it with unlinkPoolGroupLanes first'
            : "clear its pool-data settings first with setPoolGroupLanePoolData (poolDataFormat 'legacy', uid null)"
      }`,
    )
  const rateLimitSource = group ? ext!.classSource.rateLimit.kind : 'inline'
  if ((kind === 'setRateLimit' || kind === 'fastFinalityRateLimit') && rateLimitSource !== 'inline')
    throw new CCTParamsInvalidError(
      operation,
      'tokenAddress',
      `${where} takes RATE_LIMIT from its pool group (RateLimitFromGroup)${kind === 'fastFinalityRateLimit' ? ': a lane-level fast-finality override is ignored or governed while it does' : ''}: write it with ${governedBy.rateLimit}`,
    )
  const extra: AccountMeta[] = []
  if (kind === 'setRateLimit' && state.v2)
    extra.push({ pubkey: state.v2.address, isSigner: false, isWritable: false })
  if (kind === 'editChainConfigV2' && group) {
    // the program keeps the group's CCV copy (ccv_config.rs:116-129): a list here would do nothing
    if (ext!.classSource.security.kind !== 'inline' && input.setsCcvs)
      throw new CCTParamsInvalidError(
        operation,
        'ccvConfig',
        `${where} takes SECURITY from its pool group, so the program ignores the lane's CCV lists: change them on the record with schedulePoolGroupCCVs (then syncPoolGroupCCVs), or omit ccvConfig`,
      )
    if (ext!.classSource.fee.kind === 'inline') {
      extra.push({
        pubkey: poolGroupPdas.groupChain(state.program, new PublicKey(group), state.selector),
        isSigner: false,
        isWritable: false,
      })
      const src = ext!.classSource.connection
      const named = src.kind === 'policy' ? state.named.get(src.slot) : undefined
      if (named) extra.push({ pubkey: named.address, isSigner: false, isWritable: false })
    }
  }
  const instruction = extra.length
    ? new TransactionInstruction({
        programId: input.instruction.programId,
        keys: [...input.instruction.keys, ...extra],
        data: input.instruction.data,
      })
    : input.instruction
  // an override is no lane account: a fast-finality write on an inline lane is not judged
  if (!group || kind === 'fastFinalityRateLimit') return { instruction }
  const groupKey = new PublicKey(group)
  // a remote-token edit is judged against every lane of the group on the chain (REMOTE_TOKEN_SHARED,
  // S5 review M4); the other kinds change only this lane's own fields
  const lanes =
    kind === 'editRemoteConfig'
      ? await listPoolGroupLaneRequests(
          operation,
          chain,
          { program: state.program, group: groupKey, selector: state.selector },
          {
            fix: "judging the lane's remote token against the group's other lanes needs it; use an RPC that serves getProgramAccounts",
          },
        )
      : [{ mint: state.mint, selector: state.selector }]
  if (!lanes.some((l) => l.mint.equals(state.mint) && l.selector === state.selector))
    lanes.push({ mint: state.mint, selector: state.selector })
  const guardOptions = poolGroupGuardOptionsOf(operation, {
    ...(options.confirmDropped && { confirmDropped: options.confirmDropped }),
  })
  const judgement = await judgePoolGroupWrite({
    operation,
    chain,
    program: state.program,
    group: groupKey,
    payer: input.payer,
    instructions: [instruction],
    lanes,
    ...(kind === 'setRateLimit' && { scope: 'loosened' as const }),
    ...guardOptions,
    liveCheck: {
      ...(options.getChain && { getChain: options.getChain }),
      ...(options.concurrency !== undefined && { concurrency: options.concurrency }),
    },
  })
  // sealed on both paths (hashing only); the signed path does not return it
  const snapshot = await sealPoolGroupSnapshot({
    operation,
    slot: judgement.slot,
    expected: {
      'group.address': group,
      [`lanes.${state.selector}.${state.mint.toBase58()}.kind`]: state.kind,
    },
    guardOptions,
    guardInputsHash: judgement.guardInputsHash,
    calldataHash: poolGroupTransactionsHash([{ instructions: [instruction] }]),
  })
  return {
    instruction,
    poolGroup: {
      findings: judgement.findings.filter((f) => f.severity === 'warning'),
      goingLive: judgement.goingLive,
      snapshot,
    },
  }
}
