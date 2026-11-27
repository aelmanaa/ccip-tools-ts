/**
 * The shared multi-token pool reads on Solana: `getMultiTokenPoolLane`, `checkMultiTokenPoolLane`
 * and `getMultiTokenPoolTransferQuote`, with the params and results of `cct/multi-token-pool.ts`, and
 * `checkPoolGroupSnapshot`.
 *
 * @packageDocumentation
 */

import type { PublicKey } from '@solana/web3.js'

import { encodeFinality } from '../../../../extra-args.ts'
import type { SolanaChain } from '../../../../solana/index.ts'
import type { UnsignedSolanaTx } from '../../../../solana/types.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import {
  type CheckMultiTokenPoolLaneParams,
  type GetMultiTokenPoolTransferQuoteParams,
  type MultiTokenPoolLane,
  type MultiTokenPoolLaneCheckResult,
  type MultiTokenPoolLaneParams,
  type MultiTokenPoolSnapshot,
  type MultiTokenPoolSnapshotCheck,
  type MultiTokenPoolTransferQuote,
  parseMultiTokenPoolSnapshot,
  serializeMultiTokenPoolSnapshot,
} from '../../../multi-token-pool.ts'
import { SolanaQuery } from '../../query.ts'
import {
  U32_MAX,
  U64_MAX,
  parseOptionalPublicKey,
  parsePublicKey,
  resolveExistingPoolProgram,
  validateBigInt,
  validateInteger,
} from '../../validate.ts'
import { checkSolanaMultiTokenPoolLane } from '../multi-token-pool-check.ts'
import {
  type ParsedSolanaLaneKey,
  quoteSolanaMultiTokenPoolTransfer,
  readSolanaMultiTokenPoolLane,
} from '../multi-token-pool-lane.ts'
import { poolGroupTransactionsHash } from '../snapshot.ts'
import type { CheckPoolGroupSnapshotParams } from '../types.ts'
import { type ParsedPoolGroupRef, parsePoolGroupRef, validateSelector } from './common.ts'

const DIRECTIONS: readonly unknown[] = ['outbound', 'inbound']

/**
 * Parses the shared lane params on Solana: the mint, the selector and the optional pool program
 * (`poolAddress`). `registryAddress` is EVM-only.
 * @throws {@link CCTParamsInvalidError} if a param is invalid
 */
function parseLaneKey(operation: string, params: MultiTokenPoolLaneParams): ParsedSolanaLaneKey {
  if (params.registryAddress !== undefined)
    throw new CCTParamsInvalidError(
      operation,
      'registryAddress',
      "is EVM-only: on Solana pass poolAddress (the pool program), or omit it to use the program of the mint's pool",
    )
  const program = parseOptionalPublicKey(operation, 'poolAddress', params.poolAddress)
  return {
    ...(program && { program }),
    mint: parsePublicKey(operation, 'tokenAddress', params.tokenAddress),
    selector: validateSelector(operation, 'remoteChainSelector', params.remoteChainSelector),
  }
}

/** The pool program of a lane: `poolAddress`, or the program of the mint's existing pool. */
const programOf = (operation: string, chain: SolanaChain, key: ParsedSolanaLaneKey) =>
  resolveExistingPoolProgram(operation, chain, key.mint, key.program)

/** Reads the family-neutral view of one lane (same params and result as on EVM). */
export class GetMultiTokenPoolLane extends SolanaQuery<
  MultiTokenPoolLaneParams,
  MultiTokenPoolLane,
  ParsedSolanaLaneKey
> {
  readonly name = 'getMultiTokenPoolLane'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected prepare(params: MultiTokenPoolLaneParams): ParsedSolanaLaneKey {
    return parseLaneKey(this.name, params)
  }

  /** Reads the lane as its transfer paths resolve it, on the pool program of the mint. */
  protected async read(chain: SolanaChain, key: ParsedSolanaLaneKey): Promise<MultiTokenPoolLane> {
    const program = await programOf(this.name, chain, key)
    return (await readSolanaMultiTokenPoolLane(this.name, chain, program, key.mint, key.selector))
      .lane
  }
}

type ParsedCheck = { key: ParsedSolanaLaneKey; params: CheckMultiTokenPoolLaneParams }

/** Runs the lane check on one Solana lane, locally and on the remote side. */
export class CheckMultiTokenPoolLane extends SolanaQuery<
  CheckMultiTokenPoolLaneParams,
  MultiTokenPoolLaneCheckResult,
  ParsedCheck
> {
  readonly name = 'checkMultiTokenPoolLane'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected prepare(params: CheckMultiTokenPoolLaneParams): ParsedCheck {
    const key = parseLaneKey(this.name, params)
    if (params.expectOpen !== undefined) {
      if (!Array.isArray(params.expectOpen))
        throw new CCTParamsInvalidError(this.name, 'expectOpen', 'must be an array')
      params.expectOpen.forEach((d, i) => {
        if (!DIRECTIONS.includes(d))
          throw new CCTParamsInvalidError(
            this.name,
            `expectOpen[${i}]`,
            "must be 'outbound' or 'inbound'",
          )
      })
    }
    for (const name of ['minDestGasOverhead', 'maxTransferFeeBps'] as const)
      if (params[name] !== undefined) validateInteger(this.name, name, params[name], 0, U32_MAX)
    if (params.getChain !== undefined && typeof params.getChain !== 'function')
      throw new CCTParamsInvalidError(this.name, 'getChain', 'must be a function')
    if (params.remoteAttestations !== undefined && !Array.isArray(params.remoteAttestations))
      throw new CCTParamsInvalidError(this.name, 'remoteAttestations', 'must be an array')
    const budget = params.lockBudget
    if (budget?.extraAccounts !== undefined)
      validateInteger(this.name, 'lockBudget.extraAccounts', budget.extraAccounts, 0, 256)
    if (budget?.feeToken !== undefined)
      parsePublicKey(this.name, 'lockBudget.feeToken', budget.feeToken)
    return { key, params }
  }

  /** Reads the lane, its pool and the remote side, and evaluates every rule. */
  protected async read(
    chain: SolanaChain,
    { key, params }: ParsedCheck,
  ): Promise<MultiTokenPoolLaneCheckResult> {
    const program = await programOf(this.name, chain, key)
    return checkSolanaMultiTokenPoolLane(this.name, chain, params, { ...key, program })
  }
}

type ParsedQuote = {
  key: ParsedSolanaLaneKey & { feeToken?: PublicKey }
  params: GetMultiTokenPoolTransferQuoteParams
}

/** Quotes a transfer by simulating `get_pool_fee` with the lane's pool group records. */
export class GetMultiTokenPoolTransferQuote extends SolanaQuery<
  GetMultiTokenPoolTransferQuoteParams,
  MultiTokenPoolTransferQuote,
  ParsedQuote
> {
  readonly name = 'getMultiTokenPoolTransferQuote'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected prepare(params: GetMultiTokenPoolTransferQuoteParams): ParsedQuote {
    const key = parseLaneKey(this.name, params)
    validateBigInt(this.name, 'amount', params.amount, 0n, U64_MAX)
    if (params.finality !== undefined) {
      try {
        encodeFinality(params.finality)
      } catch {
        throw new CCTParamsInvalidError(
          this.name,
          'finality',
          "must be 'finalized', 'safe' or a block depth",
        )
      }
    }
    const feeToken = parseOptionalPublicKey(this.name, 'feeToken', params.feeToken)
    return { key: { ...key, ...(feeToken && { feeToken }) }, params }
  }

  /** Simulates `get_pool_fee` on the lane's accounts. */
  protected async read(
    chain: SolanaChain,
    { key, params }: ParsedQuote,
  ): Promise<MultiTokenPoolTransferQuote> {
    const program = await programOf(this.name, chain, key)
    return quoteSolanaMultiTokenPoolTransfer(this.name, chain, params, { ...key, program })
  }
}

/** The instructions of one proposal transaction, as the snapshot check takes them. @internal */
export type PoolGroupProposalTx = Pick<UnsignedSolanaTx, 'instructions'>

/**
 * The re-checks of the Solana ops that build snapshots, by operation name: each re-reads what its
 * snapshot recorded and re-runs its guard on the exact transactions, in order.
 * @internal
 */
export const POOL_GROUP_SNAPSHOT_RECHECKS: ReadonlyMap<
  string,
  (
    chain: SolanaChain,
    ref: ParsedPoolGroupRef,
    snapshot: MultiTokenPoolSnapshot,
    transactions: readonly PoolGroupProposalTx[],
  ) => Promise<MultiTokenPoolSnapshotCheck>
> = new Map(
  (
    [
      'createPoolGroup',
      'setPoolGroupRoles',
      'setPoolGroupSettings',
      'transferPoolGroupOwnership',
      'acceptPoolGroupOwnership',
    ] as const
  ).map((name) => [
    name,
    async (chain, ref, snapshot, transactions) => {
      // loaded on first use: the write ops import this module's neighbours
      const { POOL_GROUP_LIFECYCLE_OPERATIONS } = await import('./lifecycle.ts')
      return POOL_GROUP_LIFECYCLE_OPERATIONS[name].recheck(chain, ref, snapshot, transactions)
    },
  ]),
)

/**
 * The proposal's transactions: `transaction`, or `transactions` (every transaction of the write, in
 * order); each must carry instructions.
 * @throws {@link CCTParamsInvalidError} if neither or both are given, or one has no instructions
 */
function proposalTransactions(
  operation: string,
  params: CheckPoolGroupSnapshotParams,
): PoolGroupProposalTx[] {
  const one = params.transaction !== undefined
  if (one === (params.transactions !== undefined))
    throw new CCTParamsInvalidError(
      operation,
      'transaction',
      "pass exactly one of transaction and transactions (the proposal's transactions, in order)",
    )
  const list: unknown[] = one
    ? [params.transaction]
    : Array.isArray(params.transactions)
      ? params.transactions
      : []
  if (!list.length)
    throw new CCTParamsInvalidError(operation, 'transactions', 'must be a non-empty array')
  return list.map((tx, i) => {
    const instructions = (tx as Partial<PoolGroupProposalTx> | undefined)?.instructions
    if (!Array.isArray(instructions) || !instructions.length)
      throw new CCTParamsInvalidError(
        operation,
        one ? 'transaction' : `transactions[${i}]`,
        "must be a proposal's unsigned transaction, with its instructions",
      )
    return { instructions }
  })
}

type ParsedSnapshot = ParsedPoolGroupRef & {
  snapshot: MultiTokenPoolSnapshot
  transactions: PoolGroupProposalTx[]
}

/** Re-reads the values a snapshot recorded and reports which moved. */
export class CheckPoolGroupSnapshot extends SolanaQuery<
  CheckPoolGroupSnapshotParams,
  MultiTokenPoolSnapshotCheck,
  ParsedSnapshot
> {
  readonly name = 'checkPoolGroupSnapshot'

  /**
   * Checks the snapshot's shape and hash (the canonical round trip, as on EVM) and that a Solana
   * pool-group op built it.
   * @throws {@link CCTParamsInvalidError} if the ref or the snapshot is invalid
   */
  protected prepare(params: CheckPoolGroupSnapshotParams): ParsedSnapshot {
    let snapshot: MultiTokenPoolSnapshot
    try {
      snapshot = parseMultiTokenPoolSnapshot(serializeMultiTokenPoolSnapshot(params.snapshot))
    } catch (cause) {
      throw new CCTParamsInvalidError(
        this.name,
        'snapshot',
        cause instanceof CCTParamsInvalidError
          ? `is not the snapshot an op returned: ${String(cause.context.reason)}`
          : 'is not a snapshot',
        { cause: cause instanceof Error ? cause : undefined },
      )
    }
    const transactions = proposalTransactions(this.name, params)
    if (poolGroupTransactionsHash(transactions) !== snapshot.calldataHash)
      throw new CCTParamsInvalidError(
        this.name,
        params.transactions !== undefined ? 'transactions' : 'transaction',
        "covers other instructions than the snapshot: pass the snapshot returned with these transactions, and a multi-transaction write's transactions all, in order",
      )
    if (!POOL_GROUP_SNAPSHOT_RECHECKS.has(snapshot.operation))
      throw new CCTParamsInvalidError(
        this.name,
        'snapshot',
        `was built by ${snapshot.operation}, which is not a Solana pool-group op that builds snapshots, so the state it recorded cannot be re-read`,
      )
    return { ...parsePoolGroupRef(this.name, params), snapshot, transactions }
  }

  /** Reads the pool group, then runs the building op's re-check. */
  protected async read(
    chain: SolanaChain,
    ref: ParsedSnapshot,
  ): Promise<MultiTokenPoolSnapshotCheck> {
    // each re-check reads the group itself (a create proposal's group does not exist yet)
    return POOL_GROUP_SNAPSHOT_RECHECKS.get(ref.snapshot.operation)!(
      chain,
      ref,
      ref.snapshot,
      ref.transactions,
    )
  }
}
