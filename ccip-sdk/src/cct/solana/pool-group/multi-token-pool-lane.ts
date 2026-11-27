/**
 * The family-neutral multi-token pool lane reads on Solana (`getMultiTokenPoolLane`,
 * `checkMultiTokenPoolLane`, `getMultiTokenPoolTransferQuote`): the shared shapes of
 * `cct/multi-token-pool.ts`, from a pool-groups lane as its transfer paths resolve it.
 *
 * The lane check is in `multi-token-pool-check.ts`.
 *
 * @packageDocumentation
 */

import { Buffer } from 'buffer'

import { AnchorError, BN, ProgramError } from '@coral-xyz/anchor'
import { PublicKey, TransactionInstruction } from '@solana/web3.js'
import { getBytes, sha256, toUtf8Bytes } from 'ethers'

import type {
  LaneRecordType,
  LaneStatus,
  RateLimiterState,
  TokenTransferFeeConfig,
} from '../../../chain.ts'
import { bpsFeeDeducted } from '../../../evm/multi-token-pool.ts'
import { encodeFinality } from '../../../extra-args.ts'
import { ChainFamily, networkInfo } from '../../../networks.ts'
import type { SolanaChain } from '../../../solana/index.ts'
import { deriveTokenPoolChainConfigV2Pda } from '../../../solana/token-pool.ts'
import {
  SIMULATION_PAYER,
  customInstructionErrorCode,
  simulateTransaction,
} from '../../../solana/utils.ts'
import { toLeArray } from '../../../utils.ts'
import { CCTDataDecodeError, CCTParamsInvalidError } from '../../errors.ts'
import {
  type GetMultiTokenPoolTransferQuoteParams,
  type MultiTokenPoolConfigSource,
  type MultiTokenPoolLane,
  type MultiTokenPoolTransferQuote,
  type PoolDataFormat,
  isStop,
  longPoolDataBytes,
} from '../../multi-token-pool.ts'
import { decodeRemoteAddress } from '../../remote-address.ts'
import { deriveTokenPoolChainConfigPda, deriveTokenPoolConfigPda } from '../programs/token-pool.ts'
import type { PoolGroupClass } from './accounts.ts'
import { decodeFeeConfig } from './decode.ts'
import {
  type PoolGroupLaneState,
  isUnread,
  laneFormat,
  lanePauses,
  laneSectionsFor,
  readPoolGroupLaneState,
} from './lane.ts'
import { orThrow, simulationRefused } from './operations/common.ts'
import { type LaneGroupObservation, observeLane, readPolicyIds } from './operations/lane.ts'
import { createPoolGroupProgram } from './program.ts'
import {
  type PoolState,
  type SolanaRemoteLanePool,
  laneRemotePools,
  poolState,
  registryOf,
} from './remote-lane.ts'

/** A lane read for the shared views: the lane, its accounts, and what the program applies. */
export type SolanaMultiTokenPoolLaneRead = {
  /** The family-neutral view. */
  lane: MultiTokenPoolLane
  /** The pool program. */
  program: PublicKey
  /** The mint's pool `State`. */
  pool: PoolState
  /** The lane's accounts, `null` when it has no `ChainConfig`. */
  state: PoolGroupLaneState | null
  /** The lane's remote pools with their stored bytes. */
  remotePools: SolanaRemoteLanePool[]
}

/** A parsed lane key of the shared reads. */
export type ParsedSolanaLaneKey = { program?: PublicKey; mint: PublicKey; selector: bigint }

/** `RateLimiterObservation` → core state (`null` when disabled). */
function observedBucket(b: LaneGroupObservation['outboundRateLimit']): RateLimiterState {
  if (!b.isEnabled) return null
  return {
    tokens: BigInt(b.tokens.toString()),
    capacity: BigInt(b.capacity.toString()),
    rate: BigInt(b.rate.toString()),
  }
}

/** A bucket as the shared stop rule reads it (`null`: disabled). */
const stopped = (b: RateLimiterState | undefined) =>
  isStop({ isEnabled: !!b, capacity: b?.capacity ?? 0n, rate: b?.rate ?? 0n })

/**
 * The lane's status in one direction, with the shared scope mapping: pool-group pause → `'global'`;
 * chain record pause, `drivenLanesPaused` or a chain record that does not admit a driven member →
 * `'chain'`; the lane's own pause → `'token'` (this token on this chain). An unlinked lane has no
 * pause. `'incomplete'` when a transfer reverts for a missing record: a long lane sends only with an
 * enabled fee record, and a lane trusting no remote pool receives nothing.
 */
function laneStatus(
  state: PoolGroupLaneState,
  direction: 'outbound' | 'inbound',
  format: PoolDataFormat,
  fee: TokenTransferFeeConfig | undefined,
  remotePools: number,
): LaneStatus {
  const { ext, groupChain } = state
  if (ext?.poolGroupAddress && groupChain) {
    const gcp = groupChain.record
    const out = direction === 'outbound'
    if (gcp.groupPaused) return { status: 'paused', scope: 'global', direction }
    const { admitted } = lanePauses(state)
    if (
      (out ? gcp.pausedOutbound : gcp.pausedInbound) ||
      (state.kind === 'driven' && (gcp.drivenLanesPaused || admitted === false))
    )
      return { status: 'paused', scope: 'chain', direction }
    if (out ? ext.pausedOutbound : ext.pausedInbound)
      return { status: 'paused', scope: 'token', direction }
  }
  const missing: LaneRecordType[] =
    direction === 'outbound'
      ? format === 'long' && !fee?.isEnabled
        ? ['destOverhead']
        : []
      : remotePools
        ? []
        : ['remotePool']
  return missing.length ? { status: 'incomplete', missing } : { status: 'ok' }
}

/** Where each lane record type resolves from, in the family-neutral terms. */
function laneSources(
  state: PoolGroupLaneState,
  policyIds: ReadonlyMap<string, number>,
): Record<LaneRecordType, MultiTokenPoolConfigSource> {
  const of = (cls: PoolGroupClass): MultiTokenPoolConfigSource => {
    const source = state.ext?.poolGroupAddress ? state.ext.classSource[cls] : undefined
    if (!source || source.kind === 'inline') return { kind: 'inline' }
    if (source.kind === 'default') return { kind: 'default' }
    const named = state.named.get(source.slot)!
    return { kind: 'policy', policy: { id: policyIds.get(named.policy.toBase58())! } }
  }
  return bySourceClass(of)
}

/** The lane record types from their pool-group class (CONNECTION holds the remote pools, FEE the overheads). */
function bySourceClass(
  of: (cls: PoolGroupClass) => MultiTokenPoolConfigSource,
): Record<LaneRecordType, MultiTokenPoolConfigSource> {
  return {
    connection: of('connection'),
    remotePool: of('connection'),
    rateLimit: of('rateLimit'),
    fee: of('fee'),
    destOverhead: of('fee'),
    security: of('security'),
  }
}

/** The CCV lists transfers apply now: the lane's copy, or its activated pending copy. */
function laneCcvs(state: PoolGroupLaneState): { outbound: string[]; inbound: string[] } {
  const pending = state.ext?.ccvPending
  if (pending && state.now !== undefined && state.now >= pending.activatesAt)
    return { outbound: pending.outbound, inbound: pending.inbound }
  return state.v2?.lane.ccvs ?? { outbound: [], inbound: [] }
}

/**
 * Reads the mint's pool `State` under `program`, at its PDA.
 * @throws {@link CCTParamsInvalidError} if the mint has no pool there
 * @throws {@link CCTDataDecodeError} if the account is not a pool `State` at its PDA
 * @internal
 */
export async function readPoolState(
  operation: string,
  chain: SolanaChain,
  program: PublicKey,
  mint: PublicKey,
): Promise<PoolState> {
  const address = deriveTokenPoolConfigPda(program, mint)
  const account = await chain.connection.getAccountInfo(address)
  if (!account?.owner.equals(program))
    throw new CCTParamsInvalidError(
      operation,
      'tokenAddress',
      `${mint.toBase58()} has no pool State under ${program.toBase58()}`,
    )
  return orThrow(
    poolState(address, account, `the pool State ${address.toBase58()}`),
    address.toBase58(),
  )
}

/**
 * Reads the family-neutral view of one lane of a resolved pool program: the lane's accounts (marker,
 * tail, group and named records), and what the program applies (`observe_lane_group`: buckets
 * under the configs in force, the effective fee config). A standard lane of a program without pool
 * groups is read through core (`getTokenPoolRemotes`, `getTokenPoolConfig`).
 * @throws {@link CCTParamsInvalidError} if the mint has no pool State under the program
 * @throws {@link CCTDataDecodeError} if an account is not as the program writes it
 * @throws {@link CCTOperationUnsupportedError} if the program refuses the view on a marked lane
 * @internal
 */
export async function readSolanaMultiTokenPoolLane(
  operation: string,
  chain: SolanaChain,
  program: PublicKey,
  mint: PublicKey,
  selector: bigint,
): Promise<SolanaMultiTokenPoolLaneRead> {
  const [pool, read] = await Promise.all([
    readPoolState(operation, chain, program, mint),
    readPoolGroupLaneState(chain.connection, program, mint, selector),
  ])
  const where = `the lane of ${mint.toBase58()} toward ${selector}`
  const base = {
    family: ChainFamily.Solana,
    tokenAddress: mint.toBase58(),
    remoteChainSelector: selector,
  } as const
  if (read === null) {
    const none: LaneStatus = { status: 'incomplete', missing: ['connection'] }
    return {
      program,
      pool,
      state: null,
      remotePools: [],
      lane: {
        ...base,
        exists: false,
        remoteToken: null,
        remotePools: [],
        poolDataFormat: 'legacy',
        sources: bySourceClass(() => ({ kind: 'inline' })),
        rateLimits: { outbound: null, inbound: null },
        stopped: { outbound: false, inbound: false },
        ccvs: { outbound: [], inbound: [] },
        hasHooks: false,
        outboundStatus: none,
        inboundStatus: none,
      },
    }
  }
  const state = orThrow(read, where)
  const poolDataFormat = orThrow(laneFormat(state), where)
  const remotePools = orThrow(laneRemotePools(state, poolDataFormat), where)
  const [observation, policyIds] = await Promise.all([
    observeLane(operation, chain, state),
    readPolicyIds(chain, [state]),
  ])
  let rateLimits: MultiTokenPoolLane['rateLimits']
  let fee: TokenTransferFeeConfig | undefined
  if (observation) {
    const ftfOut = observation.ftfOutboundRateLimit
    const ftfIn = observation.ftfInboundRateLimit
    rateLimits = {
      outbound: observedBucket(observation.outboundRateLimit),
      inbound: observedBucket(observation.inboundRateLimit),
      ...(ftfOut?.isEnabled && { fastFinalityOutbound: observedBucket(ftfOut) }),
      ...(ftfIn?.isEnabled && { fastFinalityInbound: observedBucket(ftfIn) }),
    }
    fee = observation.feeConfig ? decodeFeeConfig(observation.feeConfig) : undefined
  } else {
    // a standard lane of a program without pool groups: core reads it
    const [remotes, config] = await Promise.all([
      chain.getTokenPoolRemotes(pool.address.toBase58(), selector),
      chain.getTokenPoolConfig(pool.address.toBase58(), { destChainSelector: selector }),
    ])
    const remote = remotes[networkInfo(selector).name]!
    const fastOut =
      'fastOutboundRateLimiterState' in remote ? remote.fastOutboundRateLimiterState : null
    const fastIn =
      'fastInboundRateLimiterState' in remote ? remote.fastInboundRateLimiterState : null
    rateLimits = {
      outbound: remote.outboundRateLimiterState,
      inbound: remote.inboundRateLimiterState,
      ...(fastOut && { fastFinalityOutbound: fastOut }),
      ...(fastIn && { fastFinalityInbound: fastIn }),
    }
    fee = 'tokenTransferFeeConfig' in config ? config.tokenTransferFeeConfig : undefined
  }
  const security = laneSectionsFor(state, 'security')
  const hasHooks = !isUnread(security) && !!security?.security.hook
  const tokenBytes = Buffer.from(state.chainConfig.base.remote.tokenAddress.address)
  return {
    program,
    pool,
    state,
    remotePools,
    lane: {
      ...base,
      exists: true,
      remoteToken: decodeRemoteAddress(tokenBytes, selector),
      remotePools: remotePools.map(({ address, allowLegacyPoolData }) => ({
        address,
        allowLegacyPoolData,
      })),
      poolDataFormat,
      sources: laneSources(state, policyIds),
      rateLimits,
      stopped: { outbound: stopped(rateLimits.outbound), inbound: stopped(rateLimits.inbound) },
      ...(fee?.isEnabled && { tokenTransferFeeConfig: fee }),
      ccvs: laneCcvs(state),
      hasHooks,
      outboundStatus: laneStatus(state, 'outbound', poolDataFormat, fee, remotePools.length),
      inboundStatus: laneStatus(state, 'inbound', poolDataFormat, fee, remotePools.length),
    },
  }
}

// ─── The transfer quote ──────────────────────────────────────────────────────────────────────

/** `InvalidRequestedFinality` of the base token pool errors. */
const INVALID_REQUESTED_FINALITY = 6028

/** The custom program error code of a refused view, however anchor or core reported it. */
function viewErrorCode(err: unknown): number | undefined {
  if (err instanceof AnchorError) return err.error.errorCode.number
  if (err instanceof ProgramError) return err.code
  return customInstructionErrorCode(err)
}

/**
 * The FeeQuoter fallback the router charges for a token transfer when the pool has no enabled fee
 * record (`legacy_fallback_token_pool_receipt`): the FeeQuoter's own
 * `get_fallback_token_transfer_fee_v2`, simulated: the token's per-chain config when enabled, else
 * the destination chain's defaults.
 */
async function readFeeQuoterFallback(
  operation: string,
  chain: SolanaChain,
  router: PublicKey,
  selector: bigint,
  mint: PublicKey,
): Promise<{ flatFee: number; destGasOverhead: number; destBytesOverhead: number }> {
  const { feeQuoter } = await chain._getRouterConfig(router.toBase58())
  const sel = toLeArray(selector, 8)
  const pda = (...seeds: (Buffer | Uint8Array)[]) =>
    PublicKey.findProgramAddressSync(
      seeds.map((x) => Buffer.from(x)),
      feeQuoter,
    )[0]
  const keys = [
    pda(Buffer.from('config')),
    pda(Buffer.from('dest_chain_v2'), sel),
    pda(Buffer.from('per_chain_per_token_config'), sel, mint.toBuffer()),
  ].map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }))
  const data = Buffer.concat([
    GET_FALLBACK_TOKEN_TRANSFER_FEE_V2,
    Buffer.from(sel),
    mint.toBuffer(),
  ])
  let result
  try {
    result = await simulateTransaction(chain, {
      payerKey: SIMULATION_PAYER,
      instructions: [new TransactionInstruction({ programId: feeQuoter, keys, data })],
    })
  } catch (err) {
    return simulationRefused(operation, err, 'get_fallback_token_transfer_fee_v2')
  }
  const ret = result.returnData
  const bytes =
    ret?.programId === feeQuoter.toBase58() ? Buffer.from(ret.data[0], 'base64') : Buffer.alloc(0)
  if (bytes.length < 12)
    throw new CCTDataDecodeError(feeQuoter.toBase58(), {
      context: { reason: 'get_fallback_token_transfer_fee_v2 returned no fee' },
    })
  // FallbackTokenTransferFeeV2 { flat_fee: u32 cents, dest_gas_limit: u32, dest_bytes_overhead: u32 }
  return {
    flatFee: bytes.readUInt32LE(0),
    destGasOverhead: bytes.readUInt32LE(4),
    destBytesOverhead: bytes.readUInt32LE(8),
  }
}

/** Discriminator of the FeeQuoter's `get_fallback_token_transfer_fee_v2`. */
const GET_FALLBACK_TOKEN_TRANSFER_FEE_V2 = Buffer.from(
  getBytes(sha256(toUtf8Bytes('global:get_fallback_token_transfer_fee_v2'))),
).subarray(0, 8)

/**
 * Quotes a transfer by simulating `get_pool_fee` with the lane's group and named records, the way
 * the router forwards them.
 * @remarks Without an enabled pool fee record the router charges the FeeQuoter fallback: the
 *   quote then has `hasFeeRecord: false` and the fallback's fee and overheads, with no token fee.
 * @throws {@link CCTParamsInvalidError} if the lane does not exist, the lane does not allow the
 *   requested finality, or it sends long data without a fee record covering it (a send would revert)
 * @throws {@link CCTOperationUnsupportedError} if the program refuses the simulation otherwise
 * @internal
 */
export async function quoteSolanaMultiTokenPoolTransfer(
  operation: string,
  chain: SolanaChain,
  params: GetMultiTokenPoolTransferQuoteParams,
  key: ParsedSolanaLaneKey & { program: PublicKey; feeToken?: PublicKey },
): Promise<MultiTokenPoolTransferQuote> {
  const { program, mint, selector } = key
  const read = await readPoolGroupLaneState(chain.connection, program, mint, selector)
  if (read === null)
    throw new CCTParamsInvalidError(
      operation,
      'remoteChainSelector',
      `${mint.toBase58()} has no lane toward ${selector} on ${program.toBase58()}`,
    )
  const where = `the lane of ${mint.toBase58()} toward ${selector}`
  const state = orThrow(read, where)
  const finality = encodeFinality(params.finality ?? 'finalized')
  const remaining = [
    ...(state.groupChain ? [state.groupChain.address] : []),
    ...[...state.named.values()].map((n) => n.address),
  ].map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }))
  let fee
  try {
    fee = await createPoolGroupProgram(chain, program)
      .methods.getPoolFee({
        remoteChainSelector: new BN(selector.toString()),
        amount: new BN(params.amount.toString()),
        localToken: mint,
        feeToken: key.feeToken ?? PublicKey.default,
        requestedFinalityConfig: { flags: finality >>> 16, blockDepth: finality & 0xffff },
        tokenArgs: Buffer.alloc(0),
      })
      .accountsStrict({
        state: deriveTokenPoolConfigPda(program, mint),
        chainConfig: deriveTokenPoolChainConfigPda(program, selector, mint),
        chainConfigV2: deriveTokenPoolChainConfigV2Pda(program, selector, mint),
      })
      .remainingAccounts(remaining)
      .view()
  } catch (err) {
    if (viewErrorCode(err) === INVALID_REQUESTED_FINALITY)
      throw new CCTParamsInvalidError(
        operation,
        'finality',
        `${mint.toBase58()} does not allow this finality on the lane`,
      )
    return simulationRefused(operation, err, 'get_pool_fee')
  }
  const format = orThrow(laneFormat(state), where)
  if (format === 'long') {
    // the program sends long data only with an enabled record covering it
    const needed = longPoolDataBytes(state.ext?.uid ? 32 : 0)
    if (!fee.isEnabled || fee.destBytesOverhead < needed)
      throw new CCTParamsInvalidError(
        operation,
        'remoteChainSelector',
        `the lane of ${mint.toBase58()} to ${selector} sends long pool data ${fee.isEnabled ? `with destBytesOverhead ${fee.destBytesOverhead}, below ${needed}` : 'without a fee record'}, so a send would revert (LongPoolDataNeedsDestBytesOverhead): set an enabled fee record covering ${needed} bytes`,
      )
  }
  if (!fee.isEnabled) {
    // the router charges the FeeQuoter fallback; the pool takes no basis-point fee
    const pool = await readPoolState(operation, chain, program, mint)
    const router = await registryOf(chain, pool.state.router)
    if (isUnread(router))
      throw new CCTDataDecodeError(pool.state.router.toBase58(), {
        context: { reason: router.reason },
      })
    const fallback = await readFeeQuoterFallback(operation, chain, router, selector, mint)
    return {
      feeUSDCents: BigInt(fallback.flatFee),
      destGasOverhead: fallback.destGasOverhead,
      destBytesOverhead: fallback.destBytesOverhead,
      tokenFeeBps: 0,
      feeDeducted: 0n,
      netAmount: params.amount,
      hasFeeRecord: false,
    }
  }
  const feeDeducted = bpsFeeDeducted(params.amount, fee.tokenFeeBps)
  return {
    feeUSDCents: BigInt(fee.fee),
    destGasOverhead: fee.destGasLimit,
    destBytesOverhead: fee.destBytesOverhead,
    tokenFeeBps: fee.tokenFeeBps,
    feeDeducted,
    netAmount: params.amount - feeDeducted,
    hasFeeRecord: true,
  }
}
