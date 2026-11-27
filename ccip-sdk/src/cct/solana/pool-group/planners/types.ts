/**
 * Public types of the three shared planners on Solana (`onboardMultiTokenPoolTokens`,
 * `enableMultiTokenPoolChain`, `removeMultiTokenPoolToken`): the flat per-family params (design
 * addendum §2.4), the step tuples (§3.4), the results, and the internal family bindings (§2.3).
 *
 * @packageDocumentation
 */

import type { TokenTransferFeeConfig } from '../../../../chain.ts'
import type { FinalityAllowed } from '../../../../extra-args.ts'
import type {
  MultiTokenPoolLaneFinding,
  MultiTokenPoolLaneKey,
  MultiTokenPoolPlan,
  MultiTokenPoolPlanOptions,
  MultiTokenPoolPlanStep,
  MultiTokenPoolRateLimits,
  MultiTokenPoolRemotePool,
  MultiTokenPoolSnapshot,
  PoolDataFormat,
} from '../../../multi-token-pool.ts'
import type { PoolGroupProgramRef, PoolGroupRef, PoolGroupRoles } from '../types.ts'
import type {
  PoolGroupBatchOptions,
  PoolGroupFollowUp,
  PoolGroupSectionUpdate,
  PoolGroupUnsignedTx,
  SolanaTxBudget,
} from '../write-types.ts'

// ─── Step tuples ─────────────────────────────────────────────────────────────────────────────

/**
 * Onboarding steps of N tokens into a pool group, in order. The `token*` steps are `onboardToken`'s,
 * expanded per mint (a chain per mint); `pausePoolGroupChainLanes` runs only for a chain record this
 * plan moves out of `'off'` (`solana.create` chains with a `laneMode`). On a chain that is already
 * live, a token joins without listing it, then `admitPausedLanes` lists it, creates the lane and
 * pauses it in one owner-signed transaction (no one can create the lane unpaused in between), and
 * `unpausePoolGroupLanes` lifts that lane pause after the lane check. The `token*` transactions
 * are not pool-group transactions: `toPoolGroupSquadsBatch` refuses them, so a Squads vault proposes
 * each as its own vault transaction (the batched counts hold for mints already registered).
 */
export const POOL_GROUP_ONBOARDING_STEPS = [
  'createPoolGroup',
  'setPoolGroupDefaults',
  'tokenDeployPool',
  'tokenRegisterAdmin',
  'tokenAcceptAdmin',
  'tokenCreateLookupTable',
  'tokenSetPool',
  'tokenSetPoolInterface',
  'tokenCreateMintMultisig',
  'tokenSetMintAuthority',
  'pausePoolGroupChainLanes',
  'joinPoolGroup',
  'initPoolGroupLanes',
  'materializePoolGroupLanes',
  'admitPausedLanes',
  'assignPoolGroupLanePolicies',
  'checkLanes',
  'unpausePoolGroupChainLanes',
  'unpausePoolGroupLanes',
] as const
/** One onboarding step name. */
export type PoolGroupOnboardingStepName = (typeof POOL_GROUP_ONBOARDING_STEPS)[number]

/**
 * Remote chain enablement steps, in order. `pausePoolGroupChainLanes` runs only on a chain record in
 * `'off'`: it moves the record into its lane mode with the driven lanes paused (the program requires
 * the flag there); a live chain is never paused. On a live chain, `addMemberRemoteTokens` and
 * `admitPoolGroupMembers` create each lane they open, paused, in their own transaction, and
 * `unpausePoolGroupLanes` lifts those lane pauses after the lane check.
 */
export const POOL_GROUP_CHAIN_ENABLEMENT_STEPS = [
  'addPoolGroupChain',
  'setPoolGroupChainPolicy',
  'initPoolGroupPolicyChainRecord',
  'editPoolGroupPolicyChainRecord',
  'appendToChainRecordLookupTable',
  'addMemberRemoteTokens',
  'pausePoolGroupChainLanes',
  'admitPoolGroupMembers',
  'materializePoolGroupLanes',
  'assignPoolGroupLanePolicies',
  'syncPoolGroupCCVs',
  'checkLanes',
  'unpausePoolGroupChainLanes',
  'unpausePoolGroupLanes',
] as const
/** One chain enablement step name. */
export type PoolGroupChainEnablementStepName = (typeof POOL_GROUP_CHAIN_ENABLEMENT_STEPS)[number]

/**
 * Token removal steps (the token leaves the pool group), in order. The two await steps never build a
 * transaction: they return `blockedBy` until their condition holds.
 */
export const POOL_GROUP_LEAVE_STEPS = [
  'pauseLaneOutbound',
  'awaitRemoteOutboundStop',
  'awaitDrain',
  'raiseOwnFee',
  'unlinkPoolGroupLanes',
  'dropChainsAndCloseLanes',
  'closePoolGroupMembers',
] as const
/** One token removal step name. */
export type PoolGroupLeaveStepName = (typeof POOL_GROUP_LEAVE_STEPS)[number]

// ─── Results ─────────────────────────────────────────────────────────────────────────────────

/** Ids of a pool group a planner run created or used. */
export type PoolGroupRunIds = {
  /** The pool group id (base58). */
  poolGroupId?: string
  /** The `Group` PDA. */
  poolGroupAddress?: string
}

/** A planner's plan on Solana: the remaining steps from chain state, and the pool group. */
export type PoolGroupPlan<Name extends string> = MultiTokenPoolPlan<Name> &
  PoolGroupRunIds & {
    /** Warnings the plan found (for example SECURITY copied at once by a policy assignment). */
    findings: MultiTokenPoolLaneFinding[]
    /**
     * This run's id: pass it back on every later call of the run (with `landedStepIds`), across
     * flows (enable, then onboard). Every pause step id carries it.
     */
    runId: string
    /**
     * Ids in `pendingStepHashes` that are no longer in the plan: they landed (or the state no longer
     * needs them). Drop them from the pending set, and add the executed ones to `landedStepIds`.
     */
    vanishedPendingSteps: string[]
  }

/** One built ready step of an unsigned planner call. */
export type PoolGroupReadyStep<Name extends string> = {
  /** The step. */
  step: MultiTokenPoolPlanStep<Name>
  /** Its transactions, to land in order. */
  transactions: PoolGroupUnsignedTx[]
  /** The op's snapshot: store it with the proposal, run `checkPoolGroupSnapshot` before executing. */
  snapshot?: MultiTokenPoolSnapshot
  /** The op's warnings. */
  findings: MultiTokenPoolLaneFinding[]
  /** The op's follow-ups. */
  followUps?: PoolGroupFollowUp[]
}

/**
 * Unsigned planner result on Solana: every ready step (up to `maxReadySteps`), each built by its own
 * op on current chain state with every guard. Map `ready` to `toPoolGroupSquadsBatch` as
 * `{ id: step.id, transactions }` (snapshots by step id) for one approval round per batch.
 */
export type GeneratePoolGroupPlanResult<Name extends string> = PoolGroupPlan<Name> & {
  /** The ready steps, built. */
  ready: PoolGroupReadyStep<Name>[]
  /** The fee payer the transactions were built with (to serialize them). */
  payer: string
}

/** A step a signed planner run landed. */
export type PoolGroupExecutedPlanStep<Name extends string> = MultiTokenPoolPlanStep<Name> & {
  /** The signatures, in order. */
  hashes: string[]
  /** Accounts the step created, by name. */
  created?: Record<string, string>
}

/** Signed planner result on Solana. */
export type ExecutePoolGroupPlanResult<Name extends string> = PoolGroupRunIds & {
  /** This run's id (pass it, with the landed step ids, to a later unsigned call of the same run). */
  runId: string
  /** The steps this run landed, in order. */
  steps: PoolGroupExecutedPlanStep<Name>[]
  /** Why the run stopped before the plan was empty, if it did. */
  blockedBy?: MultiTokenPoolPlan<Name>['blockedBy']
  /** Warnings of the plan and of the landed ops. */
  findings: MultiTokenPoolLaneFinding[]
  /** Follow-ups of the landed ops. */
  followUps?: PoolGroupFollowUp[]
}

// ─── Flat params (public) ────────────────────────────────────────────────────────────────────

/**
 * Run options of the Solana planners. X1 moves `runId` into the shared `MultiTokenPoolPlanOptions`.
 */
export type SolanaMultiTokenPoolPlannerRunOptions = {
  /**
   * The run this call belongs to: the `runId` a plan of this run returned. Omitted: a new run. Pause
   * step ids carry it, so `landedStepIds` only lifts pauses this run set; pass both on every call of
   * one run (also from enable to onboard), and discard both once the run completes.
   */
  runId?: string
}

/** Solana execution options of the shared planners. */
export type SolanaMultiTokenPoolPlannerExecutionOptions = {
  /**
   * The limits every op packs under; `executor: 'squads-v4'` sizes each transaction for a Squads
   * vault message (its encoding plus 500 B within 1,232 B, 7 locks plus 1 per table, 3 trace entries).
   */
  budget?: SolanaTxBudget
  /** Pays and signs slot-bound steps (lookup table creation) alone, as `onboardToken` does. */
  lookupTablePayer?: string
  /** Pays the permissionless cranks (materialize, CCV sync), refunded at close. Defaults to the actor. */
  crankPayer?: string
}

/** A token's counterpart on one remote chain. */
export type SolanaMultiTokenPoolRemoteToken = {
  /** CCIP selector of the remote chain. */
  remoteChainSelector: bigint
  /** The counterpart token, in the remote chain's own format (`0x…` for EVM, base58 for Solana). */
  remoteTokenAddress: string
  /** Decimals of the token on the remote chain, not on this chain. */
  remoteTokenDecimals: number
}

/** A local token's counterpart on the chain being enabled. */
export type SolanaMultiTokenPoolChainRemoteToken = {
  /** The local mint; it must be admitted by `tokenAddresses`. */
  tokenAddress: string
  /** The counterpart token, in the remote chain's own format. */
  remoteTokenAddress: string
  /** Decimals of the token on the remote chain. */
  remoteTokenDecimals: number
}

/** One chain `solana.create` adds, with its sections and the lane mode it starts in. */
export type PoolGroupOnboardingCreateChain = {
  /** The remote chain. */
  remoteChainSelector: bigint
  /**
   * Sections written into the chain record (`set_group_chain_policy`, detached from the group
   * default) in the `setPoolGroupDefaults` step. CONNECTION needs remote pools before the record can
   * leave `'off'`.
   */
  sections?: PoolGroupSectionUpdate[]
  /**
   * The lane mode it starts in, behind the driven-lanes pause; omitted: `'off'`. Only
   * `'all-members'`: a subset needs member indices, which exist only after the joins (add them with
   * `enableMultiTokenPoolChain`).
   */
  laneMode?: 'all-members'
}

/** `solana.create`: create the pool group when absent (refused when present and not the actor's). */
export type PoolGroupOnboardingCreate = {
  /** Cap on every BPS fee of the group, at most 10,000; defaults to 1,000. */
  maxBpsFee?: number
  /** Defaults to `false`. */
  openMembership?: boolean
  /** Minimum notice of a scheduled CCV change, in seconds; defaults to 86,400. */
  minCCVActivationDelay?: number | bigint
  /** Unset roles default to the actor; `null` leaves one unset. */
  initialRoles?: Partial<PoolGroupRoles>
  /** Chains to add; at most 24. */
  chains?: PoolGroupOnboardingCreateChain[]
}

/** One token to onboard into a pool group. */
export type SolanaMultiTokenPoolOnboardingToken = {
  /** The mint. */
  tokenAddress: string
  /**
   * The exact lane set: a driven lane exists only on chains listed here and admitted
   * (members.rs:6-9); every chain must already have a chain record that is not `'off'` (enable it
   * first), or be one `solana.create` adds with a `laneMode`.
   */
  remoteTokens: SolanaMultiTokenPoolRemoteToken[]
  /**
   * A named policy id: the lanes take every class the policy carries from it
   * (`assign_lane_policies`); the other classes keep their current source. A policy carrying
   * SECURITY copies its CCVs to the lane at once, with no notice (a warning finding): use
   * `rollOutPoolGroupCCVs` for a delayed change.
   */
  policy?: number
  /** Solana-only per-token fields. */
  solana?: {
    /** The pool type to deploy when the mint has no pool; only `'burn-mint'` joins a group. */
    poolType?: 'burn-mint'
    /** Allowlist seeded at deployment. */
    allowlist?: string[]
    /** A lookup table for the pool (see `onboardToken`). */
    poolLookupTableAddress?: string
    /** Linked lanes: the lane's own remote pools, in the format of the token's one remote chain. */
    remotePoolAddresses?: string[]
  }
  /** Not on Solana. */
  evm?: never
}

/** Parameters of `onboardMultiTokenPoolTokens` (Solana pool group). */
export type SolanaOnboardMultiTokenPoolTokensParams = MultiTokenPoolPlanOptions &
  SolanaMultiTokenPoolPlannerRunOptions &
  PoolGroupProgramRef & {
    /**
     * The pool group. With `solana.create`, required on the plan and unsigned forms (any fresh
     * base58 key, passed on every call of the run); the signed form draws one and returns it.
     */
    poolGroupId?: string
    /** The `Group` PDA, instead of the id. */
    poolGroupAddress?: string
    /** Refuse a group whose owner is someone else. */
    expectedOwner?: string
    /** The tokens, in the order their steps run. */
    tokens: SolanaMultiTokenPoolOnboardingToken[]
    /** Defaults to `false`. Lifts the driven-lanes pause only when this run's pause step landed. */
    unpause?: boolean
    /** Lowest acceptable `destGasOverhead` of the lane check; defaults to 200,000. */
    minDestGasOverhead?: number
    /** Highest acceptable transfer fee in bps of the lane check; defaults to 1,000. */
    maxTransferFeeBps?: number
    /** Solana execution options and flow fields. */
    solana?: SolanaMultiTokenPoolPlannerExecutionOptions & {
      /** Create the pool group when absent. */
      create?: PoolGroupOnboardingCreate
      /** Defaults to `'driven'`. */
      laneKind?: 'driven' | 'linked'
      /**
       * Admit the planned lanes on a chain that is already live: each is lane-checked on `goingLive`
       * before it lands. Without it a live chain gives `blockedBy`.
       */
      acknowledgeLiveAdmission?: boolean
    }
    /** Not on Solana. */
    evm?: never
  }
/** Unsigned params of `onboardMultiTokenPoolTokens`. */
export type GenerateOnboardMultiTokenPoolTokensParams = SolanaOnboardMultiTokenPoolTokensParams & {
  /** Fee payer of every transaction. */
  payer: string
  /** The default actor of every step (a Squads vault); defaults to `payer`. */
  authority?: string
}
/** Signed params of `onboardMultiTokenPoolTokens`. */
export type ExecuteOnboardMultiTokenPoolTokensParams = SolanaOnboardMultiTokenPoolTokensParams & {
  /** Signs and pays for every step it is the actor of. */
  wallet: unknown
  /** Compute unit limit for each transaction of the `token*` steps; simulated by default. */
  computeUnits?: number
  /** The default actor; defaults to the wallet (a step for another actor ends the run in `blockedBy`). */
  authority?: string
}

/** `remoteChain` on Solana. */
export type SolanaMultiTokenPoolRemoteChainConfig = {
  /** The remote chain. */
  remoteChainSelector: bigint
  /** Trusted remote pools (CONNECTION). */
  remotePools: MultiTokenPoolRemotePool[]
  /** The format the record sends; omitted, the record keeps its own. */
  poolDataFormat?: PoolDataFormat
  /** The four buckets (RATE_LIMIT), in local token units. */
  rateLimits: MultiTokenPoolRateLimits
  /** Fee and overheads (FEE). */
  tokenTransferFeeConfig: TokenTransferFeeConfig
}

/** Parameters of `enableMultiTokenPoolChain` (Solana pool group). */
export type SolanaEnableMultiTokenPoolChainParams = MultiTokenPoolPlanOptions &
  SolanaMultiTokenPoolPlannerRunOptions &
  PoolGroupRef & {
    /**
     * Omitted: the values go to the pool group chain record only. Given (a policy id): also to the
     * policy's chain record, for the classes the policy carries, and every admitted lane is assigned
     * to it for those classes.
     */
    policy?: number
    /** The chain's shared values. */
    remoteChain: SolanaMultiTokenPoolRemoteChainConfig
    /** `'all-members'`: every member of the pool group, now and later. A list: those members. */
    tokenAddresses: string[] | 'all-members'
    /** Counterparts on this chain, for admitted members only (an upsert of member remote tokens). */
    remoteTokens?: SolanaMultiTokenPoolChainRemoteToken[]
    /** Defaults to `false`. Lifts the driven-lanes pause only when this run's pause step landed. */
    unpause?: boolean
    /** Lowest acceptable `destGasOverhead` of the lane check; defaults to 200,000. */
    minDestGasOverhead?: number
    /** Highest acceptable transfer fee in bps of the lane check; defaults to 1,000. */
    maxTransferFeeBps?: number
    /** Solana execution options and flow fields. */
    solana?: SolanaMultiTokenPoolPlannerExecutionOptions & {
      /** CONNECTION's allowed finality; defaults to `{ finalityDepth: 0 }` on a new record. */
      allowedFinality?: FinalityAllowed
      /**
       * Required when an existing record (group chain record or policy chain record) still inherits
       * a class from its default: the write detaches it. Records this plan creates detach on their own.
       */
      detachFromPoolGroupDefault?: boolean
      /** Admit the planned lanes on a chain that is already live (each lane-checked first). */
      acknowledgeLiveAdmission?: boolean
    }
    /** Not on Solana. */
    evm?: never
  }
/** Unsigned params of `enableMultiTokenPoolChain`. */
export type GenerateEnableMultiTokenPoolChainParams = SolanaEnableMultiTokenPoolChainParams & {
  /** Fee payer of every transaction. */
  payer: string
  /** The default actor of every step; defaults to `payer`. */
  authority?: string
}
/** Signed params of `enableMultiTokenPoolChain`. */
export type ExecuteEnableMultiTokenPoolChainParams = SolanaEnableMultiTokenPoolChainParams & {
  /** Signs and pays for every step it is the actor of. */
  wallet: unknown
  /** Unused by the pool-group ops (they simulate the limit); accepted for the shared signer shape. */
  computeUnits?: number
  /** The default actor; defaults to the wallet. */
  authority?: string
}

/** Parameters of `removeMultiTokenPoolToken` (Solana: the token leaves the pool group). Destructive. */
export type SolanaRemoveMultiTokenPoolTokenParams = MultiTokenPoolPlanOptions &
  SolanaMultiTokenPoolPlannerRunOptions &
  PoolGroupRef & {
    /** The mint that leaves (with `solana.tokenAddresses`, the first of them). */
    tokenAddress: string
    /** Lowest acceptable `destGasOverhead` of the lane check; defaults to 200,000. */
    minDestGasOverhead?: number
    /** Highest acceptable transfer fee in bps of the lane check; defaults to 1,000. */
    maxTransferFeeBps?: number
    /** Solana execution options and flow fields. */
    solana?: SolanaMultiTokenPoolPlannerExecutionOptions & {
      /**
       * More mints that leave in the same plan, batched with `tokenAddress`: their pauses, drops,
       * closes and member closes share the plan's waves (one approval round per wave, not per token).
       */
      tokenAddresses?: string[]
      /** Only these chains' lanes leave; omitted, every lane leaves and the membership closes. */
      remoteChainSelectors?: bigint[]
      /**
       * Lanes whose remote side the caller confirms stopped sending toward this chain. Accepted only
       * where the SDK cannot read it: a remote family it does not read, or a `getChain` that was given
       * and could not serve the chain. An EVM remote side without `getChain` gives `blockedBy` (pass
       * `getChain`); a readable one is read, never attested.
       */
      confirmRemoteOutboundStopped?: MultiTokenPoolLaneKey[]
      /**
       * Lanes whose inbound in-flight messages the caller confirms drained. It attests the drain only,
       * never the remote stop: until each lane is listed, the plan returns `blockedBy` at
       * `awaitDrain`, because closing strands inbound messages still in flight.
       */
      confirmInFlightDrained?: MultiTokenPoolLaneKey[]
    }
    /** Not on Solana. */
    evm?: never
  }
/** Unsigned params of `removeMultiTokenPoolToken`. */
export type GenerateRemoveMultiTokenPoolTokenParams = SolanaRemoveMultiTokenPoolTokenParams & {
  /** Fee payer of every transaction. */
  payer: string
  /** The default actor of every step; defaults to `payer`. */
  authority?: string
}
/** Signed params of `removeMultiTokenPoolToken`. */
export type ExecuteRemoveMultiTokenPoolTokenParams = SolanaRemoveMultiTokenPoolTokenParams & {
  /** Signs and pays for every step it is the actor of. */
  wallet: unknown
  /** Compute unit limit of the `raiseOwnFee` transaction; simulated by default. */
  computeUnits?: number
  /** The default actor; defaults to the wallet. */
  authority?: string
}

// ─── Internal bindings (design addendum §2.3) ───────────────────────────────────────────────

/** @internal */
type SolanaPlannerExecution = PoolGroupBatchOptions &
  Pick<SolanaMultiTokenPoolPlannerExecutionOptions, 'lookupTablePayer' | 'crankPayer'>

/**
 * What Solana plugs into the shared planner shapes (`cct/multi-token-pool-planners.ts`). The X1
 * family map and its mutual-assignability tests pin the flat params against these.
 * @internal
 */
export type SolanaMultiTokenPoolPlannerBindings = {
  extensionKey: 'solana'
  unsignedSigner: { payer: string; authority?: string }
  signedSigner: { wallet: unknown; computeUnits?: number; authority?: string }
  policy: number
  chainValues: {
    remotePool: MultiTokenPoolRemotePool
    poolDataFormat: PoolDataFormat
    tokenTransferFeeConfig: TokenTransferFeeConfig
    allTokens: 'all-members'
  }
  onboarding: {
    target: PoolGroupProgramRef & {
      poolGroupId?: string
      poolGroupAddress?: string
      expectedOwner?: string
    }
    policyField: object
    extension: SolanaPlannerExecution & {
      create?: PoolGroupOnboardingCreate
      laneKind?: 'driven' | 'linked'
      acknowledgeLiveAdmission?: boolean
    }
    tokenExtension: NonNullable<SolanaMultiTokenPoolOnboardingToken['solana']>
    plan: PoolGroupPlan<PoolGroupOnboardingStepName>
    generated: GeneratePoolGroupPlanResult<PoolGroupOnboardingStepName>
    executed: ExecutePoolGroupPlanResult<PoolGroupOnboardingStepName>
  }
  chainEnablement: {
    target: PoolGroupRef
    policyField: { policy?: number }
    extension: SolanaPlannerExecution & {
      allowedFinality?: FinalityAllowed
      detachFromPoolGroupDefault?: boolean
      acknowledgeLiveAdmission?: boolean
    }
    tokenExtension: object
    plan: PoolGroupPlan<PoolGroupChainEnablementStepName>
    generated: GeneratePoolGroupPlanResult<PoolGroupChainEnablementStepName>
    executed: ExecutePoolGroupPlanResult<PoolGroupChainEnablementStepName>
  }
  tokenRemoval: {
    target: PoolGroupRef
    policyField: object
    extension: SolanaPlannerExecution & {
      tokenAddresses?: string[]
      remoteChainSelectors?: bigint[]
      confirmRemoteOutboundStopped?: MultiTokenPoolLaneKey[]
      confirmInFlightDrained?: MultiTokenPoolLaneKey[]
    }
    tokenExtension: object
    plan: PoolGroupPlan<PoolGroupLeaveStepName>
    generated: GeneratePoolGroupPlanResult<PoolGroupLeaveStepName>
    executed: ExecutePoolGroupPlanResult<PoolGroupLeaveStepName>
  }
}
