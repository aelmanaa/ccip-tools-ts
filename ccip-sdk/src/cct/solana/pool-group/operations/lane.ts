import { Buffer } from 'buffer'

import { type IdlTypes, BN } from '@coral-xyz/anchor'
import {
  type AccountInfo,
  type AddressLookupTableAccount,
  type PublicKey,
  type TransactionInstruction,
  SYSVAR_CLOCK_PUBKEY,
} from '@solana/web3.js'

import type { BurnmintTokenPoolGroups } from '../../../../solana/idl/pool-groups-7558722/BURN_MINT_TOKEN_POOL.ts'
import type { SolanaChain } from '../../../../solana/index.ts'
import {
  deriveTokenPoolChainConfigOverridePda,
  deriveTokenPoolChainConfigV2Pda,
} from '../../../../solana/token-pool.ts'
import { getMultipleAccountsInfoPaged, simulateTransaction } from '../../../../solana/utils.ts'
import { CCTDataDecodeError, CCTParamsInvalidError } from '../../../errors.ts'
import { decodeRemoteAddress } from '../../../remote-address.ts'
import { deriveTokenPoolChainConfigPda } from '../../programs/token-pool.ts'
import { decodePoolGroupIdlAccount } from '../accounts.ts'
import { toBigInt } from '../decode.ts'
import {
  type PoolGroupLaneState,
  type Unread,
  attachPoolGroupLaneRecords,
  clockUnixTimestamp,
  decodePoolGroupLaneBase,
  isUnread,
  laneCcvSync,
  laneFormat,
  lanePauses,
  poolGroupLaneRecordKeys,
} from '../lane.ts'
import { createPoolGroupProgram } from '../program.ts'
import {
  type GetPoolGroupLaneResult,
  type PoolGroupClassSource,
  type PoolGroupPolicyClass,
  POOL_GROUP_POLICY_CLASSES,
} from '../types.ts'
import { isViewRefusal, orThrow, simulationRefused } from './common.ts'

const deriveV2 = (state: PoolGroupLaneState): PublicKey =>
  deriveTokenPoolChainConfigV2Pda(state.program, state.selector, state.mint)

/** Simulations of a lane listing in flight at once. */
const SIMULATION_CONCURRENCY = 4

/**
 * The policy id of each named record's `Policy`, read in one paged call (none when no lane names
 * one).
 * @throws {@link CCTDataDecodeError} if a lane names a `Policy` that does not exist or is not the
 *   program's: inconsistent on-chain state
 * @internal
 */
export async function readPolicyIds(
  chain: SolanaChain,
  states: readonly PoolGroupLaneState[],
): Promise<Map<string, number>> {
  const policies = new Map<string, { policy: PublicKey; program: PublicKey }>()
  for (const state of states)
    for (const { policy } of state.named.values())
      policies.set(policy.toBase58(), { policy, program: state.program })
  const ids = new Map<string, number>()
  if (!policies.size) return ids
  const entries = [...policies.values()]
  const accounts = await getMultipleAccountsInfoPaged(
    chain.connection,
    entries.map((e) => e.policy),
  )
  accounts.forEach((account, i) => {
    const { policy, program } = entries[i]!
    const decoded =
      account?.owner.equals(program) &&
      decodePoolGroupIdlAccount('policy', account.data, policy.toBase58())
    if (!decoded)
      throw new CCTDataDecodeError(policy.toBase58(), {
        context: { reason: "a lane's policy slot names this Policy, which does not exist" },
      })
    ids.set(policy.toBase58(), decoded.policyId)
  })
  return ids
}

/** Each class's source, with the named records' policy accounts and ids. @internal */
export function classSources(
  state: PoolGroupLaneState,
  policyIds: ReadonlyMap<string, number>,
): Record<PoolGroupPolicyClass, PoolGroupClassSource> | null {
  const ext = state.ext
  if (!ext) return null
  const out = {} as Record<PoolGroupPolicyClass, PoolGroupClassSource>
  for (const cls of POOL_GROUP_POLICY_CLASSES) {
    const source = ext.classSource[cls]
    if (source.kind !== 'policy') {
      out[cls] = source
      continue
    }
    const named = state.named.get(source.slot)!
    out[cls] = {
      kind: 'policy',
      slot: source.slot,
      policyAddress: named.policy.toBase58(),
      policyId: policyIds.get(named.policy.toBase58())!,
    }
  }
  return out
}

/** What `observe_lane_group` returns: what a lane applies per class, as the program resolves it. @internal */
export type LaneGroupObservation = IdlTypes<BurnmintTokenPoolGroups>['LaneGroupObservation']

/**
 * A write's simulated post-state, to read a lane as the write leaves it: the accounts it changes
 * (read in place of the chain's) and the write itself (run before a view in one simulation).
 * @internal
 */
export type PoolGroupPostState = {
  /** Accounts as the simulated write leaves them, by address. */
  overlay: ReadonlyMap<string, AccountInfo<Buffer> | null>
  /** The write's instructions, in order. */
  instructions: readonly TransactionInstruction[]
  /** The write's fee payer. */
  payer: PublicKey
  /** Lookup tables the write compiles with. */
  lookupTables?: AddressLookupTableAccount[]
}

/**
 * Room for the trailing zero bytes the runtime drops from return data: the observation is decoded
 * from its prefix, so zeros past its end are never read.
 */
const RETURN_DATA_PADDING = 2048

/**
 * Simulates `observe_lane_group` with the lane's group and named records: the effective fee config,
 * pauses and buckets as of now under the configs the lane applies.
 * @returns The observation; `undefined` when the program refuses the view on a standard lane (a
 *   program without pool groups).
 * @throws {@link CCTOperationUnsupportedError} if the program refuses it on a linked or driven lane,
 *   which only a pool-groups program writes: a real failure, never an absent value
 * @throws the RPC's errors, unchanged
 * @internal
 */
export async function observeLane(
  operation: string,
  chain: SolanaChain,
  state: PoolGroupLaneState,
  post?: PoolGroupPostState,
): Promise<LaneGroupObservation | undefined> {
  const program = createPoolGroupProgram(chain, state.program)
  const remaining = [
    ...(state.groupChain ? [state.groupChain.address] : []),
    ...[...state.named.values()].map((n) => n.address),
  ].map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }))
  const view = program.methods
    .observeLaneGroup({
      remoteChainSelector: new BN(state.selector.toString()),
      mint: state.mint,
    })
    .accountsStrict({
      chainConfig: state.chainConfig.address,
      chainConfigV2: state.v2?.address ?? deriveV2(state),
      chainConfigOverride: deriveTokenPoolChainConfigOverridePda(
        state.program,
        state.selector,
        state.mint,
      ),
    })
    .remainingAccounts(remaining)
  try {
    if (!post) return await view.view()
    // after the write: the write's instructions, then the view, in one simulation; the return
    // data is the last instruction's (the view)
    const result = await simulateTransaction(chain, {
      payerKey: post.payer,
      instructions: [...post.instructions, await view.instruction()],
      ...(post.lookupTables && { addressLookupTableAccounts: post.lookupTables }),
    })
    const ret = result.returnData
    if (ret?.programId !== state.program.toBase58())
      throw new CCTDataDecodeError(state.program.toBase58(), {
        context: {
          reason: `observe_lane_group after the write returned ${ret ? `data from ${ret.programId}` : 'no data'}`,
        },
      })
    const raw = Buffer.from(ret.data[0], 'base64')
    return program.coder.types.decode<LaneGroupObservation>(
      'LaneGroupObservation',
      Buffer.concat([raw, Buffer.alloc(RETURN_DATA_PADDING)]),
    )
  } catch (err) {
    if (err instanceof CCTDataDecodeError) throw err
    if (state.kind === 'standard' && isViewRefusal(err)) return undefined
    return simulationRefused(operation, err, 'observe_lane_group')
  }
}

/** The lane's buckets as of now, from {@link observeLane}; only linked and driven lanes. */
async function observeBuckets(
  operation: string,
  chain: SolanaChain,
  state: PoolGroupLaneState,
): Promise<GetPoolGroupLaneResult['rateLimits']> {
  if (state.kind === 'standard') return undefined
  const view = (await observeLane(operation, chain, state))!
  return {
    inbound: toBigInt(view.inboundRateLimit.tokens),
    outbound: toBigInt(view.outboundRateLimit.tokens),
    ...(view.ftfInboundRateLimit && {
      fastFinalityInbound: toBigInt(view.ftfInboundRateLimit.tokens),
    }),
    ...(view.ftfOutboundRateLimit && {
      fastFinalityOutbound: toBigInt(view.ftfOutboundRateLimit.tokens),
    }),
  }
}

/** One lane in public form, from its state, policy ids and observed buckets. */
function toLaneResult(
  state: PoolGroupLaneState,
  policyIds: ReadonlyMap<string, number>,
  rateLimits: GetPoolGroupLaneResult['rateLimits'],
): GetPoolGroupLaneResult {
  const where = `the lane of ${state.mint.toBase58()} toward ${state.selector}`
  const { remote } = state.chainConfig.base
  const ext = state.ext
  const ccvCopy = orThrow(laneCcvSync(state), where)
  const decode = (bytes: Uint8Array) => decodeRemoteAddress(Buffer.from(bytes), state.selector)
  const { admitted, ...pauses } = lanePauses(state)
  return {
    tokenAddress: state.mint.toBase58(),
    remoteChainSelector: state.selector,
    kind: state.kind,
    poolGroupAddress: ext?.poolGroupAddress ?? null,
    classSource: classSources(state, policyIds),
    ...pauses,
    poolDataFormat: orThrow(laneFormat(state), where),
    uid: ext?.uid ?? null,
    ...(state.kind === 'driven' && ext && { memberIndex: ext.memberIndex, admitted }),
    ccvCopy,
    remoteToken: decode(remote.tokenAddress.address),
    remoteTokenDecimals: remote.decimals,
    ownRemotePools: remote.poolAddresses.map((p) => decode(p.address)),
    ...(rateLimits && { rateLimits }),
  }
}

/** A lane to read: its mint and remote chain, with its `ChainConfigV2` when already in hand. */
export type PoolGroupLaneRequest = {
  mint: PublicKey
  selector: bigint
  /** The lane's `ChainConfigV2`, when a listing already returned it. */
  v2?: AccountInfo<Buffer> | null
}

/**
 * Reads the states of many lanes of `program` in a few paged calls, all at one point: their
 * `ChainConfig`s (and `ChainConfigV2`s not in hand), then every group chain record and named record
 * they link to, each once, with the cluster clock.
 * @returns Each lane's state, `null` when it has no `ChainConfig`, or why it cannot be read.
 * @internal
 */
export async function readPoolGroupLaneStates(
  chain: SolanaChain,
  program: PublicKey,
  lanes: readonly PoolGroupLaneRequest[],
  { overlay }: { overlay?: ReadonlyMap<string, AccountInfo<Buffer> | null> } = {},
): Promise<(PoolGroupLaneState | null | Unread)[]> {
  // `overlay`: accounts as a simulated write leaves them, read in place of the chain's
  const read = async (keys: PublicKey[]) => {
    const infos = await getMultipleAccountsInfoPaged(chain.connection, keys)
    return keys.map((k, i) => {
      const o = overlay?.get(k.toBase58())
      return o !== undefined ? o : infos[i]
    })
  }
  const keys = lanes.flatMap(({ mint, selector, v2 }) => [
    deriveTokenPoolChainConfigPda(program, selector, mint),
    ...(v2 === undefined || overlay
      ? [deriveTokenPoolChainConfigV2Pda(program, selector, mint)]
      : []),
  ])
  const accounts = await read(keys)
  let at = 0
  const states = lanes.map(({ mint, selector, v2 }) => {
    const cc = accounts[at++]
    const v2Account = v2 === undefined || overlay ? accounts[at++] : v2
    return decodePoolGroupLaneBase(program, mint, selector, cc, v2Account)
  })
  const recordKeys = states.map((s) => (s && !isUnread(s) ? poolGroupLaneRecordKeys(s) : null))
  const addresses = new Map<string, PublicKey>()
  for (const k of recordKeys)
    if (k && !isUnread(k))
      for (const a of [k.gcpAddress, ...k.entries.map((e) => e.address)])
        addresses.set(a.toBase58(), a)
  if (!addresses.size) return states.map((s, i) => (isUnread(recordKeys[i]) ? recordKeys[i]! : s))
  const list = [...addresses.values()]
  const [clock, ...infos] = await read([SYSVAR_CLOCK_PUBKEY, ...list])
  const now = clockUnixTimestamp(clock)
  const byAddress = new Map(list.map((a, i) => [a.toBase58(), infos[i] ?? null]))
  return states.map((state, i) => {
    const k = recordKeys[i] ?? null
    if (state === null || isUnread(state)) return state
    if (isUnread(k)) return k
    if (k === null) return state
    if (isUnread(now)) return now
    return attachPoolGroupLaneRecords(state, k, byAddress, now)
  })
}

/**
 * Reads many lanes of `program` in public form (marker, tail, admission, CCV sync, buckets): the
 * accounts in a few paged calls ({@link readPoolGroupLaneStates}), the bucket simulations of linked
 * and driven lanes at most {@link SIMULATION_CONCURRENCY} at a time.
 * @param opts - `skipMissing`: leave out a lane with no `ChainConfig` instead of refusing it.
 * @throws {@link CCTParamsInvalidError} if a lane has no `ChainConfig` (without `skipMissing`)
 * @throws {@link CCTDataDecodeError} if its accounts are not as the program writes them
 * @throws {@link CCTOperationUnsupportedError} if the program refuses a lane's bucket simulation
 * @internal
 */
export async function readPoolGroupLanes(
  operation: string,
  chain: SolanaChain,
  program: PublicKey,
  lanes: readonly PoolGroupLaneRequest[],
  { skipMissing = false }: { skipMissing?: boolean } = {},
): Promise<GetPoolGroupLaneResult[]> {
  const read = await readPoolGroupLaneStates(chain, program, lanes)
  const states = read.flatMap((r, i) => {
    const { mint, selector } = lanes[i]!
    if (r === null && skipMissing) return []
    if (r === null)
      throw new CCTParamsInvalidError(
        operation,
        'remoteChainSelector',
        `${mint.toBase58()} has no lane toward ${selector} on ${program.toBase58()}`,
      )
    return [orThrow(r, `the lane of ${mint.toBase58()} toward ${selector}`)]
  })
  const policyIds = await readPolicyIds(chain, states)
  const buckets: GetPoolGroupLaneResult['rateLimits'][] = new Array(states.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(SIMULATION_CONCURRENCY, states.length) }, async () => {
      while (next < states.length) {
        const i = next++
        buckets[i] = await observeBuckets(operation, chain, states[i]!)
      }
    }),
  )
  return states.map((state, i) => toLaneResult(state, policyIds, buckets[i]))
}

/**
 * Reads one lane of `program` in public form (marker, tail, admission, CCV sync, buckets).
 * @throws {@link CCTParamsInvalidError} if the lane has no `ChainConfig`
 * @throws {@link CCTDataDecodeError} if its accounts are not as the program writes them
 * @throws {@link CCTOperationUnsupportedError} if the program refuses the bucket simulation
 * @internal
 */
export async function readPoolGroupLane(
  operation: string,
  chain: SolanaChain,
  program: PublicKey,
  mint: PublicKey,
  selector: bigint,
): Promise<GetPoolGroupLaneResult> {
  const [lane] = await readPoolGroupLanes(operation, chain, program, [{ mint, selector }])
  return lane!
}
