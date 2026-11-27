/**
 * The pool-group packer (design §6.3, §6.4, §6.5): turns per-lane (or per-member) instruction
 * chunks into transactions whose size, account locks, heap and instruction trace are computed from
 * the real v0 message, then sized by simulation, never by fixed caps. And the signed runner that
 * never resends a transaction that may have landed: it rebuilds from chain state instead.
 *
 * @packageDocumentation
 */

import {
  type AccountInfo,
  type Connection,
  type MessageV0,
  type TransactionInstruction,
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PACKET_DATA_SIZE,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import bs58 from 'bs58'

import { ChainFamily } from '../../../networks.ts'
import {
  SET_COMPUTE_UNIT_LIMIT_TAG,
  SET_COMPUTE_UNIT_PRICE_TAG,
  isComputeBudgetInstruction,
} from '../../../solana/compute-budget.ts'
import type { Wallet } from '../../../solana/types.ts'
import {
  MAX_COMPUTE_UNIT_LIMIT,
  getInstructionError,
  getMultipleAccountsInfoPaged,
  isComputeBudgetError,
  isSimulationFailure,
  simulateTransaction,
} from '../../../solana/utils.ts'
import type { WithLogger } from '../../../types.ts'
import { CCTParamsInvalidError, CCTTxFailedError, CCTTxNotConfirmedError } from '../../errors.ts'
import type { SolanaDurableNonce } from '../serialize.ts'
import { createCCTSubmitError } from '../submit.ts'
import type {
  PoolGroupExecuteResult,
  PoolGroupRequiredSigner,
  PoolGroupUnsignedResult,
  PoolGroupUnsignedTx,
  SolanaTxBudget,
} from './write-types.ts'

/** The account locks a Solana transaction may take. */
export const SOLANA_MAX_ACCOUNT_LOCKS = 64
/** Bytes a wallet that prepends its own limit and price adds (`walletMayAddComputeBudget`). */
export const WALLET_COMPUTE_BUDGET_RESERVE_BYTES = 52
/**
 * Bytes the worst proposer transaction adds around a Squads-encoded vault message: a
 * `batchAddTransaction` with a compute-unit limit and price and a rent payer other than the member
 * (two signatures). Measured on the Squads v4 fork test (T1c): the outer transaction is this
 * constant plus the Squads message, for any message over 114 B. `vaultTransactionCreate` adds 64 B
 * less, so both fit.
 */
export const SQUADS_OUTER_BYTES = 500
/**
 * Locks the Squads execute transaction adds: multisig, proposal, (batch,) transaction, member,
 * Squads program, ComputeBudget. The batch execute needs one more than `vaultTransactionExecute`;
 * the packer reserves the batch figure, so every Squads transaction fits either.
 */
export const SQUADS_EXECUTE_LOCKS = 7
/** CU Squads' execute adds: a base, and per inner instruction. */
export const SQUADS_EXECUTE_CU = { base: 25_000, perInstruction: 5_000 } as const
/** Default static priority-fee floor, in micro-lamports per CU (the value that landed on Phantom). */
export const DEFAULT_COMPUTE_UNIT_PRICE_FLOOR = 10_000
/** The bump allocator's heap: never freed, and the program requests no larger frame. */
export const SOLANA_HEAP_BYTES = 32 * 1024
/** Instruction trace entries a transaction may take (top-level instructions and CPIs). */
export const SOLANA_MAX_TRACE_ENTRIES = 64
/**
 * Trace entries the Squads execute transaction takes itself, ahead of the inner instructions (which
 * run as its CPIs): `SetComputeUnitLimit`, `SetComputeUnitPrice` and the execute instruction.
 */
export const SQUADS_EXECUTE_TRACE_ENTRIES = 3

/**
 * One item the packer places: the instructions of one lane or member, kept together and in order.
 * @internal
 */
export type PoolGroupPackItem = {
  /** Mints the item covers. */
  tokenAddresses: string[]
  /** Its instructions, in order. */
  instructions: TransactionInstruction[]
  /** The roles of the item's signers other than the payer, by address. */
  signerRoles?: Record<string, PoolGroupRequiredSigner['role']>
  /** Heap bytes the item allocates (encoded member sizes); the bump allocator never frees. */
  heapBytes?: number
  /** CPIs the item makes besides creating `createdPdas`. */
  cpis?: number
  /** PDAs the item creates: `create_pda_account` takes 1 CPI, or 3 when the PDA is pre-funded. */
  createdPdas?: PublicKey[]
}

/** Input of {@link packPoolGroupTransactions}. @internal */
export type PackPoolGroupInput = {
  /** The op, for errors. */
  operation: string
  /** The chain (connection and logger). */
  chain: { connection: Connection } & WithLogger
  /** The fee payer; with `'squads-v4'`, the vault. */
  payer: PublicKey
  /** The items, in order. */
  items: PoolGroupPackItem[]
  /** The limits to pack under. */
  budget?: SolanaTxBudget
  /** One nonce per transaction (wallet executor, unsigned path only). */
  durableNonces?: SolanaDurableNonce[]
  /** A measured upper bound of items per transaction, for the op's instruction. */
  maxItemsPerTransaction?: number
}

/** The limits a budget resolves to. */
type Limits = {
  squads: boolean
  /** Wallet: the transaction's bytes. Squads: the proposer transaction's (message + outer). */
  maxBytes: number
  maxLocks: number
  tables: AddressLookupTableAccount[]
}

/**
 * Reads lookup tables and drops the entries extended in the current slot, which a transaction of
 * that slot cannot load.
 * @throws {@link CCTParamsInvalidError} if a table does not exist or is deactivated
 */
async function readLookupTables(
  operation: string,
  connection: Connection,
  addresses: readonly string[],
): Promise<AddressLookupTableAccount[]> {
  if (!addresses.length) return []
  const [slot, tables] = await Promise.all([
    connection.getSlot('confirmed'),
    Promise.all(addresses.map((a) => connection.getAddressLookupTable(new PublicKey(a)))),
  ])
  return tables.map(({ value }, i) => {
    if (!value)
      throw new CCTParamsInvalidError(
        operation,
        `budget.lookupTableAddresses[${i}]`,
        `no lookup table at ${addresses[i]}`,
      )
    if (!value.isActive())
      throw new CCTParamsInvalidError(
        operation,
        `budget.lookupTableAddresses[${i}]`,
        `the lookup table ${addresses[i]} is deactivated`,
      )
    const { lastExtendedSlot, lastExtendedSlotStartIndex } = value.state
    if (lastExtendedSlot < slot) return value
    return new AddressLookupTableAccount({
      key: value.key,
      state: {
        ...value.state,
        addresses: value.state.addresses.slice(0, lastExtendedSlotStartIndex),
      },
    })
  })
}

/**
 * The limits of a budget: `'wallet'` packs into the packet (less the wallet reserve) and 64 locks;
 * `'squads-v4'` keeps the `vaultTransactionCreate` margin and the execute transaction's locks.
 * @throws {@link CCTParamsInvalidError} if a limit is invalid or nonces go with `'squads-v4'`
 */
async function resolveLimits(input: PackPoolGroupInput): Promise<Limits> {
  const { operation, budget = {} } = input
  const executor: unknown = budget.executor ?? 'wallet'
  if (!(['wallet', 'squads-v4'] as unknown[]).includes(executor))
    throw new CCTParamsInvalidError(operation, 'budget.executor', "must be 'wallet' or 'squads-v4'")
  const squads = executor === 'squads-v4'
  if (squads && input.durableNonces?.length)
    throw new CCTParamsInvalidError(
      operation,
      'durableNonces',
      'a Squads vault message cannot carry a nonce: AdvanceNonceAccount would not run as an inner instruction',
    )
  if (budget.walletMayAddComputeBudget && input.durableNonces?.length)
    throw new CCTParamsInvalidError(
      operation,
      'budget.walletMayAddComputeBudget',
      'cannot go with durable nonces: a wallet that prepends its own compute budget moves AdvanceNonceAccount off instruction 0, and the transaction is then judged against a blockhash and fails',
    )
  for (const name of ['maxBytes', 'maxAccountLocks'] as const) {
    const v = budget[name]
    if (v !== undefined && (!Number.isInteger(v) || v <= 0))
      throw new CCTParamsInvalidError(operation, `budget.${name}`, 'must be a positive integer')
  }
  const tables = await readLookupTables(
    operation,
    input.chain.connection,
    budget.lookupTableAddresses ?? [],
  )
  const packet =
    (budget.maxBytes ?? PACKET_DATA_SIZE) -
    (!squads && budget.walletMayAddComputeBudget ? WALLET_COMPUTE_BUDGET_RESERVE_BYTES : 0)
  const locks =
    (budget.maxAccountLocks ?? SOLANA_MAX_ACCOUNT_LOCKS) -
    (squads ? SQUADS_EXECUTE_LOCKS + tables.length : 0)
  return { squads, maxBytes: packet, maxLocks: locks, tables }
}

/** The compute-budget and nonce instructions a wallet transaction carries ahead of the items. */
function prefix(limits: Limits, limit: number, price: number, nonce?: SolanaDurableNonce) {
  if (limits.squads) return []
  return [
    ...(nonce
      ? [
          SystemProgram.nonceAdvance({
            noncePubkey: new PublicKey(nonce.nonceAccount),
            authorizedPubkey: new PublicKey(nonce.nonceAuthority),
          }),
        ]
      : []),
    ComputeBudgetProgram.setComputeUnitLimit({ units: limit }),
    ...(price > 0 ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price })] : []),
  ]
}

/**
 * The length of Squads v4's `TransactionMessage` encoding of a compiled vault message (what
 * `vaultTransactionCreate` and `batchAddTransaction` carry): the 3 header counts, the keys (u8
 * count), each instruction (program index, u8 account count and indexes, u16 data length and data)
 * and each lookup (table, u8 counts and indexes). No signatures, version or blockhash.
 * @internal
 */
export function squadsMessageBytes(message: MessageV0): number {
  return (
    3 +
    1 +
    32 * message.staticAccountKeys.length +
    1 +
    message.compiledInstructions.reduce(
      (n, ix) => n + 1 + 1 + ix.accountKeyIndexes.length + 2 + ix.data.length,
      0,
    ) +
    1 +
    message.addressTableLookups.reduce(
      (n, l) => n + 32 + 1 + l.writableIndexes.length + 1 + l.readonlyIndexes.length,
      0,
    )
  )
}

/**
 * Compiles the v0 message and measures it: account locks, and the serialized bytes, or with
 * `squads` the bytes of the worst proposer transaction carrying it ({@link squadsMessageBytes} plus
 * {@link SQUADS_OUTER_BYTES}).
 * @internal
 */
export function measureTransaction(
  payer: PublicKey,
  instructions: TransactionInstruction[],
  tables: AddressLookupTableAccount[],
  squads = false,
): { bytes: number; locks: number } {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions,
  }).compileToV0Message(tables)
  // Squads: the proposer transaction around the vault message; else the transaction itself
  const bytes = squads
    ? squadsMessageBytes(message) + SQUADS_OUTER_BYTES
    : new VersionedTransaction(message).serialize().length
  const locks =
    message.staticAccountKeys.length +
    message.addressTableLookups.reduce(
      (n, l) => n + l.writableIndexes.length + l.readonlyIndexes.length,
      0,
    )
  return { bytes, locks }
}

/**
 * Trace entries and heap of a chunk: top-level instructions, CPIs, PDA creations. Each program
 * invocation gets its own heap, and every item is its own instructions, so the heap that must fit is
 * the largest item's, not the sum.
 */
function traceAndHeap(
  items: readonly PoolGroupPackItem[],
  prefunded: ReadonlySet<string>,
  prefixCount: number,
): { trace: number; heap: number } {
  let trace = prefixCount
  let heap = 0
  for (const item of items) {
    trace += item.instructions.length + (item.cpis ?? 0)
    for (const pda of item.createdPdas ?? []) trace += prefunded.has(pda.toBase58()) ? 3 : 1
    heap = Math.max(heap, item.heapBytes ?? 0)
  }
  return { trace, heap }
}

/**
 * The nonce a chunk is measured with: a nonce account and an authority that are neither the payer
 * nor any other key, the worst case of every nonce in the pool (one more signer, two more keys), so
 * whichever nonce a transaction gets it still fits.
 */
const WORST_NONCE: SolanaDurableNonce = {
  nonceAccount: Keypair.generate().publicKey.toBase58(),
  nonceAuthority: Keypair.generate().publicKey.toBase58(),
}

/** Why an exact instruction list does not fit the bytes and locks, or `undefined`. */
function sizeMisfit(
  payer: PublicKey,
  limits: Limits,
  instructions: TransactionInstruction[],
): string | undefined {
  let measured
  try {
    measured = measureTransaction(payer, instructions, limits.tables, limits.squads)
  } catch (err) {
    // compileToV0Message refuses more than 256 accounts; serialize refuses an oversized message
    return `the message does not compile (${err instanceof Error ? err.message : String(err)})`
  }
  if (measured.bytes > limits.maxBytes) return `${measured.bytes} bytes, above ${limits.maxBytes}`
  if (measured.locks > limits.maxLocks)
    return `${measured.locks} account locks, above ${limits.maxLocks}`
  return undefined
}

/** Why a chunk does not fit, or `undefined` when it does. */
function misfit(
  input: PackPoolGroupInput,
  limits: Limits,
  items: readonly PoolGroupPackItem[],
  prefunded: ReadonlySet<string>,
): string | undefined {
  if (input.maxItemsPerTransaction !== undefined && items.length > input.maxItemsPerTransaction)
    return `more than ${input.maxItemsPerTransaction} items`
  const head = prefix(
    limits,
    MAX_COMPUTE_UNIT_LIMIT,
    1,
    input.durableNonces?.length ? WORST_NONCE : undefined,
  )
  const size = sizeMisfit(input.payer, limits, [...head, ...items.flatMap((i) => i.instructions)])
  if (size) return size
  // with Squads the items run as CPIs of the execute, which takes its own entries first
  const own = limits.squads ? SQUADS_EXECUTE_TRACE_ENTRIES : head.length
  const { trace, heap } = traceAndHeap(items, prefunded, own)
  if (trace > SOLANA_MAX_TRACE_ENTRIES)
    return `${trace} instruction trace entries, above ${SOLANA_MAX_TRACE_ENTRIES}`
  if (heap > SOLANA_HEAP_BYTES) return `${heap} heap bytes, above ${SOLANA_HEAP_BYTES}`
  return undefined
}

/**
 * Whether a simulation failed for the batch's weight (compute, heap or instruction trace), which
 * halving the batch fixes, rather than for its content.
 * @internal
 */
export function isBatchTooHeavy(err: unknown): boolean {
  if (!isSimulationFailure(err)) return false
  if (isComputeBudgetError(err)) return true
  if (getInstructionError(err)?.error === 'MaxInstructionTraceLengthExceeded') return true
  const logs = (err instanceof SendTransactionError ? err.logs : undefined) ?? []
  return logs.some((l) => /out of memory|memory allocation failed/i.test(l))
}

/**
 * The priority fee: `budget.computeUnitPrice` when given (`0` disables), else the highest of the
 * static floor, the median of the recent per-slot fees over the transaction's writable accounts, and
 * the estimator hook.
 */
async function priceFor(
  connection: Connection,
  budget: SolanaTxBudget,
  writable: string[],
): Promise<number> {
  if (budget.computeUnitPrice !== undefined) return budget.computeUnitPrice
  const floor = budget.computeUnitPriceFloor ?? DEFAULT_COMPUTE_UNIT_PRICE_FLOOR
  const [recent, estimated] = await Promise.all([
    connection
      .getRecentPrioritizationFees({
        lockedWritableAccounts: writable.slice(0, 128).map((a) => new PublicKey(a)),
      })
      .then((fees) => {
        const sorted = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b)
        return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0
      }),
    budget.priorityFeeEstimator?.(writable) ?? 0,
  ])
  return Math.max(floor, recent, estimated)
}

/** The signers a transaction needs, with their roles. */
function requiredSigners(
  payer: PublicKey,
  instructions: TransactionInstruction[],
  items: readonly PoolGroupPackItem[],
  nonce?: SolanaDurableNonce,
): PoolGroupRequiredSigner[] {
  const roles = new Map<string, PoolGroupRequiredSigner['role']>()
  for (const item of items)
    for (const [address, role] of Object.entries(item.signerRoles ?? {})) roles.set(address, role)
  const out = new Map<string, PoolGroupRequiredSigner['role']>([[payer.toBase58(), 'payer']])
  for (const ix of instructions)
    for (const k of ix.keys)
      if (k.isSigner && !out.has(k.pubkey.toBase58()))
        out.set(
          k.pubkey.toBase58(),
          nonce && k.pubkey.toBase58() === nonce.nonceAuthority
            ? 'nonce-authority'
            : (roles.get(k.pubkey.toBase58()) ?? 'pool-group-role'),
        )
  return [...out].map(([address, role]) => ({ address, role }))
}

/** Splits items into chunks that fit, in order, greedily. */
function chunk(
  input: PackPoolGroupInput,
  limits: Limits,
  items: readonly PoolGroupPackItem[],
  prefunded: ReadonlySet<string>,
): PoolGroupPackItem[][] {
  const chunks: PoolGroupPackItem[][] = []
  let current: PoolGroupPackItem[] = []
  for (const [i, item] of items.entries()) {
    if (!misfit(input, limits, [...current, item], prefunded)) {
      current.push(item)
      continue
    }
    const alone = misfit(input, limits, [item], prefunded)
    if (alone)
      throw new CCTParamsInvalidError(
        input.operation,
        'budget',
        `item ${i} (${item.tokenAddresses.join(', ') || 'no mint'}) does not fit a transaction alone: ${alone}`,
      )
    chunks.push(current)
    current = [item]
  }
  if (current.length) chunks.push(current)
  return chunks
}

/** Simulates a chunk; halves it on a weight failure, recursively. Returns sized chunks with CU. */
async function sizeBySimulation(
  input: PackPoolGroupInput,
  limits: Limits,
  items: PoolGroupPackItem[],
): Promise<{ items: PoolGroupPackItem[]; unitsConsumed: number }[]> {
  // simulation runs at price 0: the raised 1.4M limit is never charged
  const instructions = [
    ...prefix(limits, MAX_COMPUTE_UNIT_LIMIT, 0, input.durableNonces?.[0]),
    ...items.flatMap((i) => i.instructions),
  ]
  try {
    const result = await simulateTransaction(input.chain, {
      payerKey: input.payer,
      instructions,
      addressLookupTableAccounts: limits.tables,
      allowV1: false,
    })
    return [{ items, unitsConsumed: result.unitsConsumed ?? MAX_COMPUTE_UNIT_LIMIT }]
  } catch (err) {
    if (!isBatchTooHeavy(err)) throw err
    if (items.length === 1)
      throw new CCTParamsInvalidError(
        input.operation,
        'budget',
        `the item for ${items[0]!.tokenAddresses.join(', ') || 'no mint'} exceeds the compute, heap or instruction-trace limit alone`,
        { cause: err instanceof Error ? err : undefined },
      )
    // halving after a simulation failure is safe: nothing landed
    const half = Math.ceil(items.length / 2)
    return [
      ...(await sizeBySimulation(input, limits, items.slice(0, half))),
      ...(await sizeBySimulation(input, limits, items.slice(half))),
    ]
  }
}

/** The items' PDAs that already hold lamports (their creation costs 3 trace entries, not 1). */
async function prefundedPdas(input: PackPoolGroupInput): Promise<Set<string>> {
  const pdas = input.items.flatMap((i) => i.createdPdas ?? [])
  const accounts: (AccountInfo<Buffer> | null)[] = pdas.length
    ? await getMultipleAccountsInfoPaged(input.chain.connection, pdas)
    : []
  return new Set(pdas.filter((_, i) => (accounts[i]?.lamports ?? 0) > 0).map((p) => p.toBase58()))
}

/**
 * How many leading items fit the first transaction by bytes, locks, trace and heap (no
 * simulation): for a write whose later items need the first transaction landed (they cannot be
 * simulated before it).
 * @throws {@link CCTParamsInvalidError} if a limit is invalid or the first item does not fit alone
 * @internal
 */
export async function firstTransactionItemCount(input: PackPoolGroupInput): Promise<number> {
  if (!input.items.length) return 0
  const limits = await resolveLimits(input)
  return chunk(input, limits, input.items, await prefundedPdas(input))[0]!.length
}

/**
 * Packs items into pool-group transactions: greedy chunks under the compiled message's bytes and
 * locks, the trace (pre-funded PDAs read in one paged call) and the heap; then each chunk simulated,
 * halved on a compute, heap or trace failure, and given a limit of 1.1 × the simulated CU and a price.
 * With `'squads-v4'` the compute budget goes to `outerInstructions` (with Squads' execute overhead)
 * and nothing but the items goes inside.
 * @throws {@link CCTParamsInvalidError} if a limit is invalid, an item cannot fit alone, or there
 *   are fewer durable nonces than transactions
 * @throws the simulation's error when it fails for any other reason (the write would fail)
 * @internal
 */
export async function packPoolGroupTransactions(
  input: PackPoolGroupInput,
): Promise<{ transactions: PoolGroupUnsignedTx[]; noncesUsed?: number }> {
  const { chain, payer, items, budget = {} } = input
  if (!items.length) return { transactions: [] }
  const limits = await resolveLimits(input)
  const prefunded = await prefundedPdas(input)
  const sized = []
  for (const c of chunk(input, limits, items, prefunded))
    sized.push(...(await sizeBySimulation(input, limits, c)))
  const nonces = input.durableNonces
  if (nonces && nonces.length < sized.length)
    throw new CCTParamsInvalidError(
      input.operation,
      'durableNonces',
      `the write needs ${sized.length} transactions, one nonce each, but ${nonces.length} nonces were given`,
    )
  const transactions: PoolGroupUnsignedTx[] = []
  for (const [i, { items: group, unitsConsumed }] of sized.entries()) {
    const body = group.flatMap((g) => g.instructions)
    const writable = [
      ...new Set(
        body.flatMap((ix) => ix.keys.filter((k) => k.isWritable).map((k) => k.pubkey.toBase58())),
      ),
    ]
    const price = await priceFor(chain.connection, budget, writable)
    const nonce = nonces?.[i]
    const limit = Math.min(MAX_COMPUTE_UNIT_LIMIT, Math.ceil(unitsConsumed * 1.1))
    const instructions = limits.squads ? body : [...prefix(limits, limit, price, nonce), ...body]
    // the exact transaction, with its own nonce, limit and price: it must still fit
    const over = sizeMisfit(payer, limits, instructions)
    if (over)
      throw new CCTParamsInvalidError(
        input.operation,
        'budget',
        `transaction ${i} does not fit once its nonce and compute budget are placed: ${over}`,
      )
    const outerLimit = Math.min(
      MAX_COMPUTE_UNIT_LIMIT,
      limit + SQUADS_EXECUTE_CU.base + SQUADS_EXECUTE_CU.perInstruction * body.length,
    )
    transactions.push({
      family: ChainFamily.Solana,
      instructions,
      mainIndex: instructions.length - 1,
      lookupTables: limits.tables,
      requiredSigners: requiredSigners(payer, instructions, group, nonce),
      tokenAddresses: group.flatMap((g) => g.tokenAddresses),
      computeUnitLimit: limits.squads ? outerLimit : limit,
      computeUnitPrice: price,
      ...(limits.squads && {
        outerInstructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: outerLimit }),
          ...(price > 0
            ? [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price })]
            : []),
        ],
      }),
      ...(nonce && { durableNonce: nonce }),
    })
  }
  return { transactions, ...(nonces && { noncesUsed: transactions.length }) }
}

/** Whether a transaction carries compute-budget limit or price instructions. @internal */
export function hasComputeBudget(instructions: readonly TransactionInstruction[]): boolean {
  return instructions.some(
    (ix) =>
      isComputeBudgetInstruction(ix, SET_COMPUTE_UNIT_LIMIT_TAG) ||
      isComputeBudgetInstruction(ix, SET_COMPUTE_UNIT_PRICE_TAG),
  )
}

/** How often the runner polls a signature whose send or confirmation failed in transport. */
const SIGNATURE_POLL_MS = 2_000
/**
 * How long the runner polls one signature at most: the blockhash lifetime (150 blocks, about 60-90 s)
 * plus a margin for a lagging node. Past it the signature's fate is still unknown, so the write stops
 * with `CCTTxNotConfirmedError` instead of rebuilding.
 */
const SIGNATURE_POLL_TIMEOUT_MS = 150_000
/**
 * Consecutive "absent past expiry" reads needed before a signature counts as never landed. Behind a
 * load balancer the height and the status may come from different nodes; a lagging status node
 * could miss a landed signature once, rarely twice in a row.
 */
const ABSENT_READS_FOR_EXPIRY = 2

/** Input of {@link executePoolGroupTransactions}. @internal */
export type ExecutePoolGroupInput<R extends PoolGroupUnsignedResult = PoolGroupUnsignedResult> = {
  /** The op, for errors. */
  operation: string
  /** The chain. */
  chain: { connection: Connection } & WithLogger
  /** The signing wallet (the payer). */
  wallet: Wallet
  /**
   * Builds the remaining transactions from current chain state: items already done must not be in
   * it. Called again only after a transaction is known not to have landed (its blockhash expired).
   * It must read at `confirmed` commitment or later from an up-to-date node: a read that lags a
   * transaction the runner counted as landed would build that transaction again.
   */
  build: () => Promise<R>
  /** Rebuilds allowed after transactions that expired unlanded; defaults to 3. */
  maxRebuilds?: number
  /** Poll interval while a signature's fate is unknown; defaults to 2 s (tests set 0). */
  pollMs?: number
  /** Longest poll of one signature, in ms; defaults to 150 s (the blockhash lifetime plus a margin). */
  pollTimeoutMs?: number
}

/** What became of one sent transaction. */
type SendOutcome = { landed: true; hash: string } | { landed: false; reason: string }

/**
 * Whether a signature landed, after a send or confirmation that failed in transport: polls
 * `getSignatureStatuses` (with history) until the signature is found at `confirmed` or later, or
 * the block height passes the blockhash's `lastValidBlockHeight` with the signature still absent on
 * {@link ABSENT_READS_FOR_EXPIRY} consecutive reads (then it can never land). Height and status are
 * read through the same connection; behind a load balancer they may still come from different
 * nodes, which the consecutive reads guard against. A failing read is retried until `timeoutMs`.
 * @returns the status's `err` (`null`: success) when found, `undefined` when expired unlanded,
 *   `unresolved` (with the last read error) when the fate is still unknown at `timeoutMs`
 */
async function resolveSignature(
  connection: Connection,
  signature: string,
  lastValidBlockHeight: number,
  { pollMs, timeoutMs }: { pollMs: number; timeoutMs: number },
): Promise<{ err: unknown } | { unresolved: true; lastError: unknown } | undefined> {
  const deadline = Date.now() + timeoutMs
  let absentPastExpiry = 0
  let lastError: unknown
  for (;;) {
    try {
      // read the height first: a signature absent at a height past expiry can no longer land
      const height = await connection.getBlockHeight('confirmed')
      const { value } = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      })
      const status = value[0]
      if (status && status.confirmationStatus !== 'processed') return { err: status.err ?? null }
      absentPastExpiry = !status && height > lastValidBlockHeight ? absentPastExpiry + 1 : 0
      if (absentPastExpiry >= ABSENT_READS_FOR_EXPIRY) return undefined
      lastError = undefined
    } catch (err) {
      lastError = err
    }
    if (Date.now() >= deadline) return { unresolved: true, lastError }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

/**
 * The blockhash a signed transaction carries and its expiry height. A wallet may replace the
 * runner's blockhash when it signs; its own is then at most as new as the latest one, so the latest
 * one's `lastValidBlockHeight`, read after signing, bounds the expiry from above (safe: the runner
 * waits longer, never shorter).
 */
async function signedBlockhash(
  connection: Connection,
  signed: VersionedTransaction,
  built: { blockhash: string; lastValidBlockHeight: number },
): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  const blockhash = signed.message.recentBlockhash
  if (blockhash === built.blockhash) return built
  const latest = await connection.getLatestBlockhash('confirmed')
  return { blockhash, lastValidBlockHeight: latest.lastValidBlockHeight }
}

/**
 * Simulates, signs locally (the first signature is the transaction id, known before sending),
 * sends and confirms one transaction. A transport failure of the send or the confirmation is
 * resolved by the signature's status, never by a resend.
 * @throws {@link CCTTxFailedError} if the simulation refuses it, or it landed and failed on chain
 * @throws {@link CCTTxNotConfirmedError} if its status cannot be read before the poll timeout
 *   (`context.pendingSignature`; it may still land, so the write is not rebuilt)
 */
async function sendOne(
  input: ExecutePoolGroupInput,
  tx: PoolGroupUnsignedTx,
  committedHashes: readonly string[],
): Promise<SendOutcome> {
  const {
    operation,
    chain,
    wallet,
    pollMs = SIGNATURE_POLL_MS,
    pollTimeoutMs = SIGNATURE_POLL_TIMEOUT_MS,
  } = input
  const { connection } = chain
  const context = { committedHashes: [...committedHashes] }
  try {
    await simulateTransaction(chain, {
      payerKey: wallet.publicKey,
      instructions: tx.instructions,
      addressLookupTableAccounts: tx.lookupTables ?? [],
      allowV1: false,
    })
  } catch (err) {
    // refused before sending: nothing landed, the write fails as it would on chain
    throw createCCTSubmitError(operation, err, context)
  }
  const built = await connection.getLatestBlockhash('confirmed')
  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: built.blockhash,
    instructions: tx.instructions,
  }).compileToV0Message(tx.lookupTables ?? [])
  const signed = await wallet.signTransaction(new VersionedTransaction(message))
  const signature = bs58.encode(signed.signatures[0]!)
  const blockhash = await signedBlockhash(connection, signed, built)
  let err: unknown
  try {
    // the simulation above ran the preflight; a duplicate send of these bytes is the same tx
    await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true })
    const confirmation = await connection.confirmTransaction(
      { signature, ...blockhash },
      'confirmed',
    )
    err = confirmation.value.err
  } catch (transport) {
    chain.logger?.warn(
      `${operation}: the send of ${signature} failed in transport (${transport instanceof Error ? transport.message : String(transport)}); waiting for its status`,
    )
    const found = await resolveSignature(connection, signature, blockhash.lastValidBlockHeight, {
      pollMs,
      timeoutMs: pollTimeoutMs,
    })
    // its fate is unknown: it may still land, so neither a resend nor a rebuild is safe
    if (found && 'unresolved' in found)
      throw new CCTTxNotConfirmedError(operation, signature, {
        cause: found.lastError instanceof Error ? found.lastError : undefined,
        context: { ...context, pendingSignature: signature, pollTimeoutMs },
      })
    if (!found) return { landed: false, reason: `${signature} expired without landing` }
    err = found.err
  }
  if (err)
    throw new CCTTxFailedError(operation, `transaction ${signature} failed on chain`, {
      context: { ...context, txHash: signature, transactionError: err },
    })
  return { landed: true, hash: signature }
}

/**
 * Refuses a build the wallet cannot send alone: a durable nonce, or a signer other than the wallet.
 * Checked on the whole build before the first send.
 * @throws {@link CCTParamsInvalidError} naming the transaction and the signer
 */
function assertWalletSendable(
  operation: string,
  wallet: Wallet,
  transactions: readonly PoolGroupUnsignedTx[],
  committedHashes: readonly string[],
): void {
  for (const [i, tx] of transactions.entries()) {
    if (tx.durableNonce)
      throw new CCTParamsInvalidError(
        operation,
        'durableNonces',
        'a signed write signs at once: durable nonces exist only on generateUnsigned*',
        { context: { committedHashes: [...committedHashes] } },
      )
    const other = tx.requiredSigners.find((s) => s.address !== wallet.publicKey.toBase58())
    if (other)
      throw new CCTParamsInvalidError(
        operation,
        'wallet',
        `transaction ${i} also needs ${other.address} (${other.role}) to sign: use the generateUnsigned form and sign it with every signer`,
        { context: { committedHashes: [...committedHashes] } },
      )
  }
}

/**
 * Signs and sends a pool-group write, transaction by transaction. Each transaction is signed
 * locally first, so its signature is known before it is sent. When a send or its confirmation fails
 * in transport, the runner polls that signature until it is found (landed: counted, or thrown if it
 * failed on chain) or its blockhash expires unlanded; only then does it re-read chain state through
 * `build` and send what is left. A transaction that may still land is never followed by a rebuild,
 * so no write is applied twice.
 * @throws {@link CCTParamsInvalidError} if any transaction of a build needs a signer other than the
 *   wallet, or carries a durable nonce (checked before the first send of that build)
 * @throws {@link CCTTxFailedError} if a simulation refuses a transaction, a transaction failed on
 *   chain, or the rebuilds run out; `context.committedHashes` lists the transactions that landed
 * @throws {@link CCTTxNotConfirmedError} if a transaction's status cannot be read before the poll
 *   timeout: `context.pendingSignature` may still land, `context.committedHashes` landed; re-run the
 *   op (it re-reads chain state) only once that signature is known to have landed or expired
 * @internal
 */
export async function executePoolGroupTransactions<R extends PoolGroupUnsignedResult>(
  input: ExecutePoolGroupInput<R>,
): Promise<Omit<R, 'transactions' | 'noncesUsed'> & PoolGroupExecuteResult> {
  const { operation, wallet, maxRebuilds = 3 } = input
  const landed: PoolGroupExecuteResult['transactions'] = []
  const hashes = () => landed.map((t) => t.hash)
  let lastReason = ''
  for (let round = 0; round <= maxRebuilds; round++) {
    const result = await input.build()
    assertWalletSendable(operation, wallet, result.transactions, hashes())
    let expired = false
    for (const tx of result.transactions) {
      const outcome = await sendOne(input, tx, hashes())
      if (!outcome.landed) {
        lastReason = outcome.reason
        expired = true
        break
      }
      landed.push({ hash: outcome.hash, tokenAddresses: tx.tokenAddresses })
    }
    if (!expired) {
      const { transactions: _t, noncesUsed: _n, ...rest } = result
      return { ...rest, transactions: landed }
    }
  }
  throw new CCTTxFailedError(
    operation,
    `transactions kept expiring without landing (${lastReason}) after ${maxRebuilds} rebuilds`,
    { isTransient: true, context: { committedHashes: hashes() } },
  )
}
