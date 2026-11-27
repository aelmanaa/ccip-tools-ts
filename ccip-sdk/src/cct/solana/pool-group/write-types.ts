/**
 * Public types of the pool-group writes: the transaction budget, the unsigned and signed results,
 * and the Squads v4 export.
 *
 * @packageDocumentation
 */

import type { AddressLookupTableAccount, TransactionInstruction } from '@solana/web3.js'

import type { UnsignedSolanaTx } from '../../../solana/types.ts'
import type { MultiTokenPoolInlineRemotePoolDrop } from '../../evm/pool-config-manager/contracts.ts'
import type {
  MultiTokenPoolExpectedSnapshot,
  MultiTokenPoolLaneFinding,
  MultiTokenPoolSnapshot,
} from '../../multi-token-pool.ts'
import type { SolanaExecuteParams, SolanaGenerateParams } from '../operation.ts'
import type { SolanaDurableNonce } from '../serialize.ts'
import type {
  PoolGroupLaneKey,
  PoolGroupProgramRef,
  PoolGroupRef,
  PoolGroupRoles,
} from './types.ts'

/** Who executes the transactions; sets byte, lock and instruction-placement defaults. */
export type SolanaExecutor = 'wallet' | 'squads-v4'

/**
 * Limits a batched op packs under. The packer compiles the real v0 message (nonce, compute budget,
 * wallet reserve, tables) and checks bytes and locks; reads the batch's PDAs to count pre-funded
 * ones (3 CPIs each, not 1); estimates heap from each member's encoded size; simulates, and on
 * `ComputationalBudgetExceeded`, out-of-memory or `MaxInstructionTraceLengthExceeded` halves the
 * batch and retries. Measured caps (8/10 materialize, 6 close, 3 join) are only upper bounds.
 */
export type SolanaTxBudget = {
  /**
   * `'wallet'` (default): 1,232 B, 64 locks, compute-budget instructions inside the transaction.
   * `'squads-v4'`: the vault message must fit the worst proposer transaction and its execute: the
   * Squads encoding of the message plus 500 B must fit 1,232 B (a `batchAddTransaction` with a
   * compute-unit limit and price and a separate rent payer, measured by the Squads fork test), and 7
   * locks (multisig, proposal, batch, transaction, member, Squads program, ComputeBudget) plus 1 per
   * lookup table are reserved, as are the execute's own 3 trace entries; no compute-budget or nonce
   * instruction goes inside (they would not run as inner instructions); the CU estimate adds
   * Squads' execute overhead (25,000 + 5,000 per inner instruction). Read-then-write ops merge
   * exactly as on the wallet path and return the snapshot.
   */
  executor?: SolanaExecutor
  /** Byte limit before the executor's margins; defaults to 1,232. */
  maxBytes?: number
  /** Account-lock limit before the executor's reserve; defaults to 64. */
  maxAccountLocks?: number
  /** Reserve 52 B for a wallet that prepends its own compute budget. Defaults to `false` (the SDK emits limit and price). */
  walletMayAddComputeBudget?: boolean
  /** Lookup tables to compile with (bytes only, never locks). Entries extended in the current slot are not used. */
  lookupTableAddresses?: string[]
  /**
   * Priority fee in micro-lamports per CU. Default: the highest of `computeUnitPriceFloor`, the
   * median of the recent per-slot fees over the transaction's writable accounts
   * (`getRecentPrioritizationFees`), and `priorityFeeEstimator` when given. `0` disables.
   * Simulation runs with price 0.
   */
  computeUnitPrice?: number
  /** Static floor in micro-lamports per CU; defaults to 10,000. */
  computeUnitPriceFloor?: number
  /** Provider hook (e.g. a `getPriorityFeeEstimate`-style RPC); its answer joins the default's maximum. */
  priorityFeeEstimator?: (writableAccounts: string[]) => Promise<number>
}

/** Options of every op that may emit several transactions. */
export type PoolGroupBatchOptions = {
  /** The limits to pack under. */
  budget?: SolanaTxBudget
}

/**
 * Generate-only batch options. Durable nonces exist only on `generateUnsigned*` (a signed `<op>`
 * signs at once) and only with the wallet executor: with `'squads-v4'` they are `never`.
 */
export type PoolGroupGenerateBatchOptions =
  | {
      /** The limits, for the wallet executor. */
      budget?: SolanaTxBudget & {
        /** The wallet executes. */
        executor?: 'wallet'
      }
      /** A pool of nonces, one per transaction; refused when too few; `noncesUsed` reports the count. */
      durableNonces?: {
        /** The nonce accounts. */
        accounts: SolanaDurableNonce[]
      }
    }
  | {
      /** The limits, for a Squads v4 vault. */
      budget: SolanaTxBudget & {
        /** A Squads v4 vault executes. */
        executor: 'squads-v4'
      }
      /** Never with Squads. */
      durableNonces?: never
    }

/** One signer a transaction needs. More than one non-payer signer cannot go through one Squads vault. */
export type PoolGroupRequiredSigner = {
  /** The signer. */
  address: string
  /** What it signs as. */
  role:
    | 'payer'
    | 'pool-owner'
    | 'pool-group-owner'
    | 'pool-group-role'
    | 'list-admin'
    | 'nonce-authority'
}

/** An unsigned transaction of a pool-group op. */
export type PoolGroupUnsignedTx = UnsignedSolanaTx & {
  /** Every key that must sign it, with its role. */
  requiredSigners: PoolGroupRequiredSigner[]
  /** Mints the transaction covers, in instruction order. */
  tokenAddresses: string[]
  /**
   * Simulated CU times 1.1; with the `'wallet'` executor also placed as `SetComputeUnitLimit`; with
   * `'squads-v4'`, the outer execute's limit, Squads' overhead included.
   */
  computeUnitLimit: number
  /** The priority fee, in micro-lamports per CU (`0`: none). */
  computeUnitPrice: number
  /** `'squads-v4'`: compute-budget instructions for the outer execute transaction, kept out of `instructions`. */
  outerInstructions?: TransactionInstruction[]
  /** The nonce the transaction was built for; its value is the `recentBlockhash`. */
  durableNonce?: SolanaDurableNonce
}

/** A write that must follow another one. */
export type PoolGroupFollowUp = {
  /** The op to run. */
  operation: string
  /** Why. */
  reason: string
  /** Its inputs, when known. */
  inputs?: Record<string, unknown>
}

/** The unsigned result of every pool-group write: transactions plus what a reviewer needs. */
export type PoolGroupUnsignedResult = {
  /** The transactions, in order. */
  transactions: PoolGroupUnsignedTx[]
  /** Read-then-write ops: the state encoded against; pass it back as `expectedSnapshot`. */
  snapshot?: MultiTokenPoolSnapshot
  /** Durable nonces used, in order. */
  noncesUsed?: number
  /**
   * Membership ops: who can change what a joined lane trusts (the owner, and `policyAdmin` and
   * `connectionAdmin`, who can rewrite CONNECTION) and the CONNECTION remote pools.
   */
  poolGroupTrust?: {
    /** The pool group owner. */
    owner: string
    /** Its policy admin. */
    policyAdmin: string | null
    /** Its connection admin. */
    connectionAdmin: string | null
    /** The CONNECTION remote pools by chain. */
    remotePools: {
      /** The chain. */
      remoteChainSelector: bigint
      /** The pools. */
      addresses: string[]
    }[]
  }
  /**
   * (mint, chain) lanes whose state the write changes, found by simulating it and reading back the
   * accounts it writes (the lane accounts, chain records and policy records they resolve from).
   */
  affectedLanes: PoolGroupLaneKey[]
  /** (mint, chain) lanes this write makes live or materializable on an unpaused chain. */
  goingLive: PoolGroupLaneKey[]
  /** Findings on the affected lanes and the lanes the write makes live (warnings; errors throw). */
  findings: MultiTokenPoolLaneFinding[]
  /** Follow-up writes this one makes necessary. */
  followUps?: PoolGroupFollowUp[]
}

/**
 * The signed result of every pool-group write. After a transaction that was not confirmed, the op
 * does not resend it: it re-reads chain state and rebuilds the rest of the batch without the items
 * already done (`join_group`, `close_group_lanes`, `link_lanes` and `init_group_lanes` are not
 * idempotent).
 */
export type PoolGroupExecuteResult = Omit<
  PoolGroupUnsignedResult,
  'transactions' | 'noncesUsed'
> & {
  /** One entry per landed transaction. */
  transactions: {
    /** The signature. */
    hash: string
    /** The mints it covered. */
    tokenAddresses: string[]
  }[]
}

/**
 * The data a Squads v4 `vaultTransactionCreate` (or `batchAddTransaction`) needs, from a pool-group
 * transaction built with `budget.executor: 'squads-v4'`. No Squads dependency: the caller passes it
 * to `@sqds/multisig`, or serializes it with `serializeUnsignedTx` (payer = the vault) for the
 * Squads app's transaction builder.
 */
export type PoolGroupSquadsTransaction = {
  /** Inner instructions only (no compute budget, no nonce). */
  instructions: TransactionInstruction[]
  /** The resolved lookup tables the vault message compiles with. */
  lookupTables: AddressLookupTableAccount[]
  /** Their addresses. */
  lookupTableAddresses: string[]
  /** For the outer execute transaction, Squads' execute overhead included. */
  computeUnitLimit: number
  /** The priority fee for the outer execute transaction, in micro-lamports per CU. */
  computeUnitPrice: number
  /** Every inner signer is the vault. */
  requiredSigners: PoolGroupRequiredSigner[]
  /** The mints the transaction covers. */
  tokenAddresses: string[]
  /**
   * The op's snapshot; store it next to the proposal and run `checkPoolGroupSnapshot` before
   * execution. A multi-transaction step's snapshot binds all its transactions in order: pass every
   * transaction with the same `stepId` as `transactions`.
   */
  snapshot?: MultiTokenPoolSnapshot
  /** The ready step this transaction belongs to, in a batch from `toPoolGroupSquadsBatch`. */
  stepId?: string
}

/** A ready step to batch into Squads proposals: its id and its transactions, in order. */
export type PoolGroupSquadsStep = {
  /** The step id. */
  id: string
  /** Its transactions, each built with `budget.executor: 'squads-v4'`. */
  transactions: PoolGroupUnsignedTx[]
}

/** Params of `toPoolGroupSquadsBatch`. */
export type ToPoolGroupSquadsBatchParams = {
  /** The ready steps, in order. */
  ready: PoolGroupSquadsStep[]
  /** The vault that executes; only steps whose every transaction is vault-signed go into batches. */
  vault: string
  /** Inner transactions per Squads batch; defaults to 20. */
  maxTransactionsPerBatch?: number
  /** The op snapshots to carry with each step, by step id. */
  snapshots?: Record<string, MultiTokenPoolSnapshot>
}

/** Result of `toPoolGroupSquadsBatch`. */
export type ToPoolGroupSquadsBatchResult = {
  /**
   * One entry per Squads v4 batch (`batchCreate`, one `batchAddTransaction` per inner transaction,
   * one proposal, one approval round, then `batchExecuteTransaction` once per inner transaction in
   * order). The transactions of one step stay in order and in one batch.
   */
  batches: {
    /** The steps of the batch, in order. */
    stepIds: string[]
    /** Its inner transactions, in order. */
    transactions: PoolGroupSquadsTransaction[]
  }[]
  /** Ready steps that need a signer other than the vault, grouped by that signer. */
  otherActorSteps: {
    /** The other signer. */
    address: string | undefined
    /** The steps. */
    stepIds: string[]
  }[]
}

/**
 * The guard options of every pool-group write (A21): a write that drops remote pools a lane trusts
 * (or turns off `allowLegacyPoolData` on a pool it keeps) is refused unless each drop is listed
 * here, keyed by lane. They are sealed into the snapshot.
 */
export type PoolGroupGuardOptions = {
  /**
   * The drops the caller agrees to, by lane; in-flight inbound messages from a dropped pool revert.
   * The error's `context.dropped` has this shape.
   */
  confirmDropped?: MultiTokenPoolInlineRemotePoolDrop[]
}

/** Fields every write on an existing pool group takes. */
export type PoolGroupWriteParams = PoolGroupRef &
  PoolGroupBatchOptions &
  PoolGroupGuardOptions &
  MultiTokenPoolExpectedSnapshot & {
    /** The signer the instruction checks; defaults to `payer`. Pre-flighted against the decoded roles. */
    authority?: string
  }

/**
 * `create_group` (+ `set_group_roles` and `add_group_chain` for `initialChains`, packed after it).
 * Refused when the PDA exists and someone else owns it: a group at that id may be a squatter's. When
 * it exists and `authority` owns it (an earlier run landed its first transaction), the op resumes:
 * it builds the missing `initialChains`, and `set_group_roles` / `set_group_settings` for the
 * explicitly passed roles and settings that differ (roles all unset, as a bare `create_group`
 * leaves them, take the defaults). A higher `maxBpsFee` than the group's is refused (it can only go
 * down).
 */
export type CreatePoolGroupParams = PoolGroupProgramRef &
  PoolGroupBatchOptions & {
    /** Defaults to a fresh random key, returned in the result. A caller-chosen id is warned about (it can be front-run). */
    poolGroupId?: string
    /** Cap on every BPS fee of the group, at most 10,000; defaults to 1,000. It can only be lowered later. */
    maxBpsFee?: number
    /** Defaults to `false` (closed: lane owners join with the group owner's signature). */
    openMembership?: boolean
    /** Minimum notice of a scheduled CCV change, in seconds, at most 30 days; defaults to 86,400. */
    minCCVActivationDelay?: number | bigint
    /** Unset roles default to `authority`; `null` leaves one unset (then nobody holds it; FEE then has no writer). */
    initialRoles?: Partial<PoolGroupRoles>
    /** Chains to add (chain records, a copy of the default, lanes off); at most 24. */
    initialChains?: bigint[]
    /** The creator, who becomes the owner and pays the rent; defaults to `payer`. */
    authority?: string
  }

/** Result fields of `createPoolGroup`. */
export type CreatePoolGroupResult = {
  /** The `Group` PDA. */
  poolGroupAddress: string
  /** The id it was created with. */
  poolGroupId: string
  /**
   * `true` when the group already existed and `authority` owns it (an earlier run landed its first
   * transaction): the build then holds only what differs from the request (missing chains, roles
   * and settings passed explicitly, roles a bare `create_group` left unset).
   */
  resumed: boolean
}

/** `set_group_roles`. Owner. Merged: omitted roles keep their holder; `null` clears one. */
export type SetPoolGroupRolesParams = PoolGroupWriteParams & {
  /** The roles to set. */
  roles: Partial<PoolGroupRoles>
}

/** `set_group_settings`. Owner. Always writes `maxBpsFee` and `openMembership`: merged, snapshotted. */
export type SetPoolGroupSettingsParams = PoolGroupWriteParams & {
  /** The new fee cap; it can only go down, and not below a fee any chain record or the default charges. */
  maxBpsFee?: number
  /** Whether lane owners join without the owner's signature. */
  openMembership?: boolean
  /** Minimum notice of a scheduled CCV change, in seconds; a decrease applies after the current notice. */
  minCCVActivationDelay?: number | bigint
  /** `null` clears. The table must be active and frozen. */
  hookLookupTable?: string | null
}

/** `transfer_group_ownership`. Owner. */
export type TransferPoolGroupOwnershipParams = PoolGroupWriteParams & {
  /** The proposed owner; it accepts with `acceptPoolGroupOwnership`. */
  proposedOwner: string
}

/** `accept_group_ownership`. The proposed owner. Clears all roles, resets SECURITY; the result lists the follow-ups. */
export type AcceptPoolGroupOwnershipParams = PoolGroupWriteParams

/** Unsigned params of `createPoolGroup` (no `expectedSnapshot`: the group is new). */
export type GenerateCreatePoolGroupParams = SolanaGenerateParams<
  CreatePoolGroupParams & PoolGroupGenerateBatchOptions
>
/** Unsigned result of `createPoolGroup`. */
export type GenerateCreatePoolGroupResult = PoolGroupUnsignedResult & CreatePoolGroupResult
/** Signed params of `createPoolGroup`. */
export type ExecuteCreatePoolGroupParams = SolanaExecuteParams<CreatePoolGroupParams>
/** Signed result of `createPoolGroup`. */
export type ExecuteCreatePoolGroupResult = PoolGroupExecuteResult & CreatePoolGroupResult

/** Unsigned params of `setPoolGroupRoles` (`set_group_roles`). */
export type GenerateSetPoolGroupRolesParams = SolanaGenerateParams<
  SetPoolGroupRolesParams & PoolGroupGenerateBatchOptions
>
/** Unsigned result of `setPoolGroupRoles`. */
export type GenerateSetPoolGroupRolesResult = PoolGroupUnsignedResult
/** Signed params of `setPoolGroupRoles`; durable nonces are refused here. */
export type ExecuteSetPoolGroupRolesParams = SolanaExecuteParams<SetPoolGroupRolesParams>
/** Signed result of `setPoolGroupRoles`. */
export type ExecuteSetPoolGroupRolesResult = PoolGroupExecuteResult

/** Unsigned params of `setPoolGroupSettings` (`set_group_settings`). */
export type GenerateSetPoolGroupSettingsParams = SolanaGenerateParams<
  SetPoolGroupSettingsParams & PoolGroupGenerateBatchOptions
>
/** Unsigned result of `setPoolGroupSettings`. */
export type GenerateSetPoolGroupSettingsResult = PoolGroupUnsignedResult
/** Signed params of `setPoolGroupSettings`; durable nonces are refused here. */
export type ExecuteSetPoolGroupSettingsParams = SolanaExecuteParams<SetPoolGroupSettingsParams>
/** Signed result of `setPoolGroupSettings`. */
export type ExecuteSetPoolGroupSettingsResult = PoolGroupExecuteResult

/** Unsigned params of `transferPoolGroupOwnership` (`transfer_group_ownership`). */
export type GenerateTransferPoolGroupOwnershipParams = SolanaGenerateParams<
  TransferPoolGroupOwnershipParams & PoolGroupGenerateBatchOptions
>
/** Unsigned result of `transferPoolGroupOwnership`. */
export type GenerateTransferPoolGroupOwnershipResult = PoolGroupUnsignedResult
/** Signed params of `transferPoolGroupOwnership`; durable nonces are refused here. */
export type ExecuteTransferPoolGroupOwnershipParams =
  SolanaExecuteParams<TransferPoolGroupOwnershipParams>
/** Signed result of `transferPoolGroupOwnership`. */
export type ExecuteTransferPoolGroupOwnershipResult = PoolGroupExecuteResult

/** Unsigned params of `acceptPoolGroupOwnership` (`accept_group_ownership`). */
export type GenerateAcceptPoolGroupOwnershipParams = SolanaGenerateParams<
  AcceptPoolGroupOwnershipParams & PoolGroupGenerateBatchOptions
>
/** Unsigned result of `acceptPoolGroupOwnership`. */
export type GenerateAcceptPoolGroupOwnershipResult = PoolGroupUnsignedResult
/** Signed params of `acceptPoolGroupOwnership`; durable nonces are refused here. */
export type ExecuteAcceptPoolGroupOwnershipParams =
  SolanaExecuteParams<AcceptPoolGroupOwnershipParams>
/** Signed result of `acceptPoolGroupOwnership`. */
export type ExecuteAcceptPoolGroupOwnershipResult = PoolGroupExecuteResult
