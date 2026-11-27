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
  type TransactionInstruction,
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'

import { ChainFamily } from '../../../networks.ts'
import {
  SET_COMPUTE_UNIT_LIMIT_TAG,
  SET_COMPUTE_UNIT_PRICE_TAG,
  isComputeBudgetInstruction,
} from '../../../solana/compute-budget.ts'
import type { Wallet } from '../../../solana/types.ts'
import {
  getInstructionError,
  getMultipleAccountsInfoPaged,
  isComputeBudgetError,
  isSimulationFailure,
  simulateAndSendTxs,
  simulateTransaction,
} from '../../../solana/utils.ts'
import type { WithLogger } from '../../../types.ts'
import { CCTParamsInvalidError } from '../../errors.ts'
import type { SolanaDurableNonce } from '../serialize.ts'
import type {
  PoolGroupExecuteResult,
  PoolGroupRequiredSigner,
  PoolGroupUnsignedResult,
  PoolGroupUnsignedTx,
  SolanaTxBudget,
} from './write-types.ts'

/** The packet size a Solana transaction must fit. */
export const SOLANA_PACKET_BYTES = 1_232
/** The account locks a Solana transaction may take. */
export const SOLANA_MAX_ACCOUNT_LOCKS = 64
/** Bytes a wallet that prepends its own limit and price adds (`walletMayAddComputeBudget`). */
export const WALLET_COMPUTE_BUDGET_RESERVE_BYTES = 52
/** Bytes `vaultTransactionCreate` (and `batchAddTransaction`) add around the vault message. */
export const SQUADS_MESSAGE_MARGIN_BYTES = 300
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
/** The CU a transaction may take. */
const MAX_COMPUTE_UNITS = 1_400_000

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
    (budget.maxBytes ?? SOLANA_PACKET_BYTES) -
    (squads ? SQUADS_MESSAGE_MARGIN_BYTES : 0) -
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

/** Compiles the v0 message and measures it: serialized bytes and account locks. */
export function measureTransaction(
  payer: PublicKey,
  instructions: TransactionInstruction[],
  tables: AddressLookupTableAccount[],
): { bytes: number; locks: number } {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions,
  }).compileToV0Message(tables)
  const bytes = new VersionedTransaction(message).serialize().length
  const locks =
    message.staticAccountKeys.length +
    message.addressTableLookups.reduce(
      (n, l) => n + l.writableIndexes.length + l.readonlyIndexes.length,
      0,
    )
  return { bytes, locks }
}

/** Trace entries and heap of a chunk: top-level instructions, CPIs, PDA creations. */
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
    heap += item.heapBytes ?? 0
  }
  return { trace, heap }
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
  const head = prefix(limits, MAX_COMPUTE_UNITS, 1, input.durableNonces?.[0])
  const instructions = [...head, ...items.flatMap((i) => i.instructions)]
  let measured
  try {
    measured = measureTransaction(input.payer, instructions, limits.tables)
  } catch (err) {
    // compileToV0Message refuses more than 256 accounts; serialize refuses an oversized message
    return `the message does not compile (${err instanceof Error ? err.message : String(err)})`
  }
  if (measured.bytes > limits.maxBytes) return `${measured.bytes} bytes, above ${limits.maxBytes}`
  if (measured.locks > limits.maxLocks)
    return `${measured.locks} account locks, above ${limits.maxLocks}`
  const { trace, heap } = traceAndHeap(items, prefunded, head.length)
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
    ...prefix(limits, MAX_COMPUTE_UNITS, 0, input.durableNonces?.[0]),
    ...items.flatMap((i) => i.instructions),
  ]
  try {
    const result = await simulateTransaction(input.chain, {
      payerKey: input.payer,
      instructions,
      addressLookupTableAccounts: limits.tables,
      allowV1: false,
    })
    return [{ items, unitsConsumed: result.unitsConsumed ?? MAX_COMPUTE_UNITS }]
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
  const pdas = items.flatMap((i) => i.createdPdas ?? [])
  const accounts: (AccountInfo<Buffer> | null)[] = pdas.length
    ? await getMultipleAccountsInfoPaged(chain.connection, pdas)
    : []
  const prefunded = new Set(
    pdas.filter((_, i) => (accounts[i]?.lamports ?? 0) > 0).map((p) => p.toBase58()),
  )
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
    const limit = Math.min(MAX_COMPUTE_UNITS, Math.ceil(unitsConsumed * 1.1))
    const instructions = limits.squads ? body : [...prefix(limits, limit, price, nonce), ...body]
    const outerLimit = Math.min(
      MAX_COMPUTE_UNITS,
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

/** Input of {@link executePoolGroupTransactions}. @internal */
export type ExecutePoolGroupInput = {
  /** The op, for errors. */
  operation: string
  /** The chain. */
  chain: { connection: Connection } & WithLogger
  /** The signing wallet (the payer). */
  wallet: Wallet
  /**
   * Builds the remaining transactions from current chain state: items already done must not be in
   * it. Called again after a transaction that may have landed failed to confirm.
   */
  build: () => Promise<PoolGroupUnsignedResult>
  /** Rebuilds allowed after unconfirmed transactions; defaults to 3. */
  maxRebuilds?: number
  /** The sender; defaults to core `simulateAndSendTxs` (atomic). */
  send?: typeof simulateAndSendTxs
}

/**
 * Signs and sends a pool-group write, transaction by transaction. A transaction the simulation
 * refuses was not sent: its error is thrown. A transaction that may have been sent but did not
 * confirm is never resent: the write re-reads chain state through `build` and sends what is left,
 * since `join_group`, `close_group_lanes`, `link_lanes` and `init_group_lanes` fail on a repeat.
 * @throws {@link CCTParamsInvalidError} if a transaction needs a signer other than the wallet, or
 *   carries a durable nonce (signed writes sign at once)
 * @throws the last error when the rebuilds run out
 * @internal
 */
export async function executePoolGroupTransactions(
  input: ExecutePoolGroupInput,
): Promise<PoolGroupExecuteResult> {
  const { operation, chain, wallet, maxRebuilds = 3, send = simulateAndSendTxs } = input
  const landed: PoolGroupExecuteResult['transactions'] = []
  let result: PoolGroupUnsignedResult | undefined
  let lastError: unknown
  for (let round = 0; round <= maxRebuilds; round++) {
    result = await input.build()
    let interrupted = false
    for (const tx of result.transactions) {
      if (tx.durableNonce)
        throw new CCTParamsInvalidError(
          operation,
          'durableNonces',
          'a signed write signs at once: durable nonces exist only on generateUnsigned*',
        )
      const other = tx.requiredSigners.find((s) => s.address !== wallet.publicKey.toBase58())
      if (other)
        throw new CCTParamsInvalidError(
          operation,
          'wallet',
          `the transaction also needs ${other.address} (${other.role}) to sign: use the generateUnsigned form and sign it with every signer`,
        )
      try {
        const { hash } = await send(chain, wallet, tx, { split: 'atomic' })
        landed.push({ hash, tokenAddresses: tx.tokenAddresses })
      } catch (err) {
        // refused before sending: nothing landed, the write fails as it would on chain
        if (isSimulationFailure(err)) throw err
        // it may have landed: never resend it; rebuild the rest from chain state
        lastError = err
        interrupted = true
        break
      }
    }
    if (!interrupted) {
      const { transactions: _t, noncesUsed: _n, ...rest } = result
      return { ...rest, transactions: landed }
    }
  }
  throw lastError
}
