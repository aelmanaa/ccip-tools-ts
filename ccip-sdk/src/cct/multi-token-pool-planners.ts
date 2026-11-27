/**
 * The generic shapes both families' integrator-facing planners (onboard tokens, enable a remote
 * chain, remove a token) are built from. Internal: no barrel re-exports this module; public
 * signatures use each family's flat aliases.
 *
 * @packageDocumentation
 */

import type { TokenTransferFeeConfig } from '../chain.ts'
import type {
  CheckMultiTokenPoolLaneParams,
  MultiTokenPoolPlanOptions,
  MultiTokenPoolRateLimits,
  MultiTokenPoolRemotePool,
  MultiTokenPoolRemoteToken,
  PoolDataFormat,
} from './multi-token-pool.ts'

/** The family extension keys. @internal */
export type MultiTokenPoolExtensionKey = 'evm' | 'solana'

/**
 * `{ evm?: E }` on EVM (`{ evm: E }` when E has a required field) and `solana?: never`, mirrored on
 * Solana: every family-only field of a shared input lives under its family's key, and one config
 * object cannot carry both families' blocks.
 * @internal
 */
export type MultiTokenPoolFamilyExtension<
  K extends MultiTokenPoolExtensionKey,
  E extends object,
> = ({} extends E ? { [P in K]?: E } : { [P in K]: E }) & {
  [P in Exclude<MultiTokenPoolExtensionKey, K>]?: never
}

/** The value types of chain-level fields; a family narrows a value it refuses. @internal */
export type MultiTokenPoolChainValueTypes = {
  /** One trusted remote pool. */
  remotePool: MultiTokenPoolRemotePool
  /** The pool data the chain record sends. */
  poolDataFormat: PoolDataFormat
  /** The chain's fee and destination overheads. */
  tokenTransferFeeConfig: TokenTransferFeeConfig
  /** The literal for "every token the shared record serves". */
  allTokens: string
}

/** What one flow of one family plugs into the shared shapes. @internal */
export type MultiTokenPoolFlowBindings = {
  /** Flat fields naming the pool (`poolAddress` on EVM, the pool group ref on Solana). */
  target: object
  /** The shared `policy` field: its type and whether it is required. */
  policyField: object
  /** The flow's family-only fields. */
  extension: object
  /** The flow's family-only per-token fields. */
  tokenExtension: object
  /** The plan type. */
  plan: unknown
  /** The unsigned result type. */
  generated: unknown
  /** The signed result type. */
  executed: unknown
}

/** What a family plugs in; each family module declares one, and nothing here imports family code. @internal */
export type MultiTokenPoolPlannerBindings = {
  /** The family's extension key. */
  extensionKey: MultiTokenPoolExtensionKey
  /** The unsigned path's signer fields. */
  unsignedSigner: object
  /** The signed path's signer fields. */
  signedSigner: object
  /** EVM `PolicyName` (string), Solana policy id (number). */
  policy: string | number
  /** The chain-level value types. */
  chainValues: MultiTokenPoolChainValueTypes
  /** Token onboarding. */
  onboarding: MultiTokenPoolFlowBindings
  /** Remote chain enablement. */
  chainEnablement: MultiTokenPoolFlowBindings
  /** Token removal. */
  tokenRemoval: MultiTokenPoolFlowBindings
}

/**
 * The shared values of one remote chain: what every admitted token's lane resolves to unless that
 * token has its own record. `rateLimits` amounts are in local token units.
 * @internal
 */
export type MultiTokenPoolRemoteChainConfig<B extends MultiTokenPoolPlannerBindings> = {
  /** CCIP selector of the remote chain. */
  remoteChainSelector: bigint
  /** Trusted remote pools. */
  remotePools: B['chainValues']['remotePool'][]
  /** The pool data the chain record sends. */
  poolDataFormat?: B['chainValues']['poolDataFormat']
  /** The four buckets. */
  rateLimits: MultiTokenPoolRateLimits
  /** Fee and destination overheads. */
  tokenTransferFeeConfig: B['chainValues']['tokenTransferFeeConfig']
}

/** Options of every shared planner: the plan options and the shared lane thresholds. @internal */
export type MultiTokenPoolPlannerOptions = MultiTokenPoolPlanOptions &
  Pick<CheckMultiTokenPoolLaneParams, 'minDestGasOverhead' | 'maxTransferFeeBps'>

/**
 * When a shared planner unpauses: only a pause its own pause step landed in this run (in memory on
 * the signed path, or listed in `landedStepIds`), after every lane it reaches passes the lane check.
 * @internal
 */
export type MultiTokenPoolUnpauseOption = {
  /** Lift this run's own new-chain or new-token pause at the end; defaults to `false`. */
  unpause?: boolean
}

/** One token to onboard. @internal */
export type MultiTokenPoolOnboardingTokenInput<B extends MultiTokenPoolPlannerBindings> = {
  /** The token. */
  tokenAddress: string
  /**
   * The exact set of remote chains this token has a lane to after the plan, with the counterpart on
   * each: the plan refuses an input under which the token would get a lane to a chain not listed.
   */
  remoteTokens: MultiTokenPoolRemoteToken[]
  /** Shared policy for every record type or class it carries; the others keep their source. */
  policy?: B['policy']
} & MultiTokenPoolFamilyExtension<B['extensionKey'], B['onboarding']['tokenExtension']>

/** Input of `onboardMultiTokenPoolTokens`. @internal */
export type OnboardMultiTokenPoolTokensInput<B extends MultiTokenPoolPlannerBindings> =
  MultiTokenPoolPlannerOptions &
    MultiTokenPoolUnpauseOption &
    B['onboarding']['target'] & {
      /** The tokens. */
      tokens: MultiTokenPoolOnboardingTokenInput<B>[]
    } & MultiTokenPoolFamilyExtension<B['extensionKey'], B['onboarding']['extension']>

/** Input of `enableMultiTokenPoolChain`. @internal */
export type EnableMultiTokenPoolChainInput<B extends MultiTokenPoolPlannerBindings> =
  MultiTokenPoolPlannerOptions &
    MultiTokenPoolUnpauseOption &
    B['chainEnablement']['target'] &
    B['chainEnablement']['policyField'] & {
      /** The chain's shared values. */
      remoteChain: MultiTokenPoolRemoteChainConfig<B>
      /** Admitted tokens: a list, or the family's literal for every token the shared record serves. */
      tokenAddresses: string[] | B['chainValues']['allTokens']
      /** Counterparts on this chain; each `tokenAddress` must be admitted by `tokenAddresses`. */
      remoteTokens?: (Omit<MultiTokenPoolRemoteToken, 'remoteChainSelector'> & {
        /** The local token. */
        tokenAddress: string
      })[]
    } & MultiTokenPoolFamilyExtension<B['extensionKey'], B['chainEnablement']['extension']>

/** Input of `removeMultiTokenPoolToken`. @internal */
export type RemoveMultiTokenPoolTokenInput<B extends MultiTokenPoolPlannerBindings> =
  MultiTokenPoolPlannerOptions &
    B['tokenRemoval']['target'] & {
      /** The token. */
      tokenAddress: string
    } & MultiTokenPoolFamilyExtension<B['extensionKey'], B['tokenRemoval']['extension']>
