/**
 * The Squads v4 export of pool-group writes (design §6.5): pure converters from transactions built
 * with `budget.executor: 'squads-v4'` to what `vaultTransactionCreate` and Squads batches take. No
 * Squads dependency, as the existing CCT Squads path: the caller proposes with `@sqds/multisig`, or
 * serializes with `serializeUnsignedTx` (payer = the vault) for the Squads app's transaction builder.
 *
 * @packageDocumentation
 */

import { PublicKey } from '@solana/web3.js'

import { CCTParamsInvalidError } from '../../errors.ts'
import type { MultiTokenPoolSnapshot } from '../../multi-token-pool.ts'
import { hasComputeBudget } from './packer.ts'
import type {
  PoolGroupSquadsTransaction,
  PoolGroupUnsignedTx,
  ToPoolGroupSquadsBatchParams,
  ToPoolGroupSquadsBatchResult,
} from './write-types.ts'

const OPERATION = 'toPoolGroupSquadsTransaction'
/** Default inner transactions per Squads batch. */
export const DEFAULT_SQUADS_BATCH_TRANSACTIONS = 20

/** The first inner signer that is not the vault, if any. */
function otherSigner(unsigned: PoolGroupUnsignedTx, vault: string): string | undefined {
  for (const ix of unsigned.instructions)
    for (const k of ix.keys)
      if (k.isSigner && k.pubkey.toBase58() !== vault) return k.pubkey.toBase58()
  return undefined
}

/** Why a transaction cannot go into a Squads vault message, or `undefined`. */
function squadsRefusal(unsigned: PoolGroupUnsignedTx, vault: string): string | undefined {
  if (unsigned.outerInstructions === undefined || hasComputeBudget(unsigned.instructions))
    return "it was not built for Squads: build it with budget.executor 'squads-v4'"
  if (unsigned.durableNonce)
    return 'it carries a durable nonce, which a vault message cannot advance'
  const other = otherSigner(unsigned, vault)
  if (other)
    return `instruction signer ${other} is not the vault: inside a vault message only the vault signs (and pays inner rent)`
  return undefined
}

/**
 * Converts a pool-group transaction built for `'squads-v4'` into what Squads' `vaultTransactionCreate`
 * takes: the inner instructions, the resolved lookup tables, the CU estimate for the outer execute,
 * the signers (all the vault) and the snapshot to store with the proposal.
 * @param unsigned - A transaction of a pool-group op, built with `budget.executor: 'squads-v4'`.
 * @param vault - The Squads vault (the transaction's payer and only inner signer).
 * @param snapshot - The op's snapshot, to store with the proposal.
 * @returns The Squads transaction data.
 * @throws {@link CCTParamsInvalidError} if the transaction was not built for `'squads-v4'`, carries a
 *   nonce, or any inner instruction has a signer other than the vault (a crank or lookup-table payer,
 *   a second vault)
 * @example
 * ```ts
 * // `transactions` and `snapshot` from a pool-group write's generateUnsigned form, built with
 * // payer: vault and budget: { executor: 'squads-v4' }
 * const squads = toPoolGroupSquadsTransaction(transactions[0]!, vault, snapshot)
 * ```
 */
export function toPoolGroupSquadsTransaction(
  unsigned: PoolGroupUnsignedTx,
  vault: string,
  snapshot?: MultiTokenPoolSnapshot,
): PoolGroupSquadsTransaction {
  let vaultKey
  try {
    vaultKey = new PublicKey(vault).toBase58()
  } catch {
    throw new CCTParamsInvalidError(OPERATION, 'vault', 'must be a Solana address')
  }
  const refused = squadsRefusal(unsigned, vaultKey)
  if (refused) throw new CCTParamsInvalidError(OPERATION, 'unsigned', refused)
  const lookupTables = unsigned.lookupTables ?? []
  return {
    instructions: unsigned.instructions,
    lookupTables,
    lookupTableAddresses: lookupTables.map((t) => t.key.toBase58()),
    computeUnitLimit: unsigned.computeUnitLimit,
    computeUnitPrice: unsigned.computeUnitPrice,
    requiredSigners: [{ address: vaultKey, role: 'payer' }],
    tokenAddresses: unsigned.tokenAddresses,
    ...(snapshot && { snapshot }),
  }
}

/**
 * Groups the vault-signed ready steps into Squads v4 batches, so a vault-owned onboarding needs one
 * approval round per batch, not one per transaction. A step's transactions stay together and in
 * order; ready steps commute, so their order within a batch does not matter. Steps that need any
 * other signer come back in `otherActorSteps`, grouped by that signer.
 * @param params - The ready steps, the vault, the batch size and the steps' snapshots.
 * @returns The batches and the steps for other actors.
 * @throws {@link CCTParamsInvalidError} if the vault or batch size is invalid, a step was not built for
 *   `'squads-v4'`, or a step alone has more transactions than a batch takes
 * @example
 * ```ts
 * const { batches, otherActorSteps } = toPoolGroupSquadsBatch({ ready, vault })
 * for (const b of batches) await proposeSquadsBatch(b.transactions)
 * ```
 */
export function toPoolGroupSquadsBatch(
  params: ToPoolGroupSquadsBatchParams,
): ToPoolGroupSquadsBatchResult {
  const operation = 'toPoolGroupSquadsBatch'
  const max = params.maxTransactionsPerBatch ?? DEFAULT_SQUADS_BATCH_TRANSACTIONS
  if (!Number.isInteger(max) || max <= 0)
    throw new CCTParamsInvalidError(
      operation,
      'maxTransactionsPerBatch',
      'must be a positive integer',
    )
  let vault
  try {
    vault = new PublicKey(params.vault).toBase58()
  } catch {
    throw new CCTParamsInvalidError(operation, 'vault', 'must be a Solana address')
  }
  const batches: ToPoolGroupSquadsBatchResult['batches'] = []
  const others = new Map<string | undefined, string[]>()
  let current: ToPoolGroupSquadsBatchResult['batches'][number] | undefined
  for (const [i, step] of params.ready.entries()) {
    const other = step.transactions.map((tx) => otherSigner(tx, vault)).find((s) => s !== undefined)
    if (other !== undefined) {
      others.set(other, [...(others.get(other) ?? []), step.id])
      continue
    }
    for (const [j, tx] of step.transactions.entries()) {
      const refused = squadsRefusal(tx, vault)
      if (refused)
        throw new CCTParamsInvalidError(operation, `ready[${i}].transactions[${j}]`, refused)
    }
    if (step.transactions.length > max)
      throw new CCTParamsInvalidError(
        operation,
        `ready[${i}]`,
        `step ${step.id} has ${step.transactions.length} transactions, more than a batch of ${max} takes`,
      )
    if (!current || current.transactions.length + step.transactions.length > max) {
      current = { stepIds: [], transactions: [] }
      batches.push(current)
    }
    const snapshot = params.snapshots?.[step.id]
    current.stepIds.push(step.id)
    current.transactions.push(
      ...step.transactions.map((tx) => toPoolGroupSquadsTransaction(tx, vault, snapshot)),
    )
  }
  return {
    batches,
    otherActorSteps: [...others].map(([address, stepIds]) => ({ address, stepIds })),
  }
}
