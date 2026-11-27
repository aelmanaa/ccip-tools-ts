import { Buffer } from 'buffer'

import { BN } from '@coral-xyz/anchor'
import type { PublicKey } from '@solana/web3.js'

import type { SolanaChain } from '../../../../solana/index.ts'
import {
  deriveTokenPoolChainConfigOverridePda,
  deriveTokenPoolChainConfigV2Pda,
} from '../../../../solana/token-pool.ts'
import { isSimulationFailure } from '../../../../solana/utils.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { decodeRemoteAddress } from '../../../remote-address.ts'
import { decodePoolGroupIdlAccount } from '../accounts.ts'
import { toBigInt } from '../decode.ts'
import {
  type PoolGroupLaneState,
  laneCcvSync,
  laneFormat,
  lanePauses,
  readPoolGroupLaneState,
} from '../lane.ts'
import { createPoolGroupProgram } from '../program.ts'
import {
  type GetPoolGroupLaneResult,
  type PoolGroupClassSource,
  type PoolGroupPolicyClass,
  POOL_GROUP_POLICY_CLASSES,
} from '../types.ts'
import { orThrow } from './common.ts'

const deriveV2 = (state: PoolGroupLaneState): PublicKey =>
  deriveTokenPoolChainConfigV2Pda(state.program, state.selector, state.mint)

/** Each class's source, with the named records' policy accounts and ids. @internal */
export async function classSources(
  operation: string,
  chain: SolanaChain,
  state: PoolGroupLaneState,
): Promise<Record<PoolGroupPolicyClass, PoolGroupClassSource> | null> {
  const ext = state.ext
  if (!ext) return null
  const policies = [...state.named.values()]
  const accounts = await chain.connection.getMultipleAccountsInfo(policies.map((n) => n.policy))
  const ids = new Map<string, number>()
  accounts.forEach((account, i) => {
    const policy = policies[i]!.policy
    const decoded =
      account?.owner.equals(state.program) &&
      decodePoolGroupIdlAccount('policy', account.data, policy.toBase58())
    if (!decoded)
      throw new CCTParamsInvalidError(
        operation,
        'tokenAddress',
        `the lane's policy ${policy.toBase58()} does not exist`,
      )
    ids.set(policy.toBase58(), decoded.policyId)
  })
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
      policyId: ids.get(named.policy.toBase58())!,
    }
  }
  return out
}

/** What `observe_lane_group` returns: what a lane applies per class, as the program resolves it. @internal */
export type LaneGroupObservation = Awaited<
  ReturnType<
    ReturnType<ReturnType<typeof createPoolGroupProgram>['methods']['observeLaneGroup']>['view']
  >
>

/**
 * Simulates `observe_lane_group` with the lane's group and named records: the effective fee config,
 * pauses and buckets as of now under the configs the lane applies. `undefined` when the program
 * refuses the view (it is not a pool-groups program).
 * @internal
 */
export async function observeLane(
  chain: SolanaChain,
  state: PoolGroupLaneState,
): Promise<LaneGroupObservation | undefined> {
  const program = createPoolGroupProgram(chain, state.program)
  const remaining = [
    ...(state.groupChain ? [state.groupChain.address] : []),
    ...[...state.named.values()].map((n) => n.address),
  ].map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }))
  try {
    return await program.methods
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
      .view()
  } catch (err) {
    if (isSimulationFailure(err)) return undefined
    throw err
  }
}

/** The lane's buckets as of now, from {@link observeLane}. */
async function observeBuckets(
  chain: SolanaChain,
  state: PoolGroupLaneState,
): Promise<GetPoolGroupLaneResult['rateLimits']> {
  const view = await observeLane(chain, state)
  if (!view) return undefined
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

/**
 * Reads one lane of `program` in public form (marker, tail, admission, CCV sync, buckets).
 * @throws {@link CCTParamsInvalidError} if the lane has no `ChainConfig`
 * @throws {@link CCTDataDecodeError} if its accounts are not as the program writes them
 * @internal
 */
export async function readPoolGroupLane(
  operation: string,
  chain: SolanaChain,
  program: PublicKey,
  mint: PublicKey,
  selector: bigint,
): Promise<GetPoolGroupLaneResult> {
  const read = await readPoolGroupLaneState(chain.connection, program, mint, selector)
  if (read === null)
    throw new CCTParamsInvalidError(
      operation,
      'remoteChainSelector',
      `${mint.toBase58()} has no lane toward ${selector} on ${program.toBase58()}`,
    )
  const where = `the lane of ${mint.toBase58()} toward ${selector}`
  const state = orThrow(read, where)
  const { remote } = state.chainConfig.base
  const ext = state.ext
  const ccvCopy = orThrow(laneCcvSync(state), where)
  const decode = (bytes: Uint8Array) => decodeRemoteAddress(Buffer.from(bytes), selector)
  const rateLimits = state.kind === 'standard' ? undefined : await observeBuckets(chain, state)
  const { admitted, ...pauses } = lanePauses(state)
  return {
    tokenAddress: mint.toBase58(),
    remoteChainSelector: selector,
    kind: state.kind,
    poolGroupAddress: ext?.poolGroupAddress ?? null,
    classSource: await classSources(operation, chain, state),
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
