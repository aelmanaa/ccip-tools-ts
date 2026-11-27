/**
 * The PCM's record shapes, shared by the reads (decoded from the views) and the writes (encoded
 * into the `apply*` calls): connection, remote pool, rate limit, fee, destination overhead and
 * security, inline (per token and chain) and policy (per policy and chain).
 *
 * @remarks Cross-family shapes are reused: `RateLimitConfig` (with `enabled`, not the ABI's
 * `isEnabled`), and the fee and overhead halves of core `TokenTransferFeeConfig`. The decoders
 * (view outputs to these shapes) are internal, in `./decode.ts`.
 *
 * @packageDocumentation
 */

import type { TokenTransferFeeConfig } from '../../../chain.ts'
import type {
  MultiTokenPoolRateLimits,
  MultiTokenPoolRemotePool,
  PoolDataFormat,
} from '../../multi-token-pool.ts'
import type { MultiTokenPoolLaneKey, PolicyName } from './contracts.ts'

/** One policy record: a policy and a remote chain (`0n` = the policy's default record). */
export type PolicyRecordKey = {
  /** The policy. */
  policyName: PolicyName
  /** `0n` addresses a fee, overhead, rate limit or security default; connection and remote pool policies have none. */
  remoteChainSelector: bigint
}

/** Removal of whole policies, for a policy record write: each needs no token and no record left. */
export type PolicyRemovalOptions = {
  /** Policies to remove, after the records the same call removes. */
  policiesToRemove?: PolicyName[]
}

/** An inline connection record: the remote token of one lane. */
export type InlineConnectionConfig = MultiTokenPoolLaneKey & {
  /**
   * Remote token in the remote chain's own format, parsed with `parseRemoteAddress`. Encoded as
   * `abi.encode(address)` (32 bytes) for an EVM remote and as raw address bytes otherwise.
   */
  remoteToken: string
}

/** A connection policy record. */
export type ConnectionPolicyRecord = PolicyRecordKey & {
  /**
   * `true`: only the policy's subset tokens for this chain get a lane. `false` opens the chain to
   * every current and future token of the policy, so it needs `openToAllPolicyTokens`.
   */
  onlySubsetTokens: boolean
}

/** One remote pool of an inline remote pool record: the shared lane remote-pool shape. */
export type InlineRemotePool = MultiTokenPoolRemotePool

/** An inline remote pool record. A set replaces the whole record. */
export type InlineRemotePoolConfig = MultiTokenPoolLaneKey & {
  /** Whether the lane also trusts the remote pools of the token's remote pool policy. */
  trustPolicyRemotePools: boolean
  /** Pool data the lane sends (the contract's `useLegacyPoolDataOnSend` is `poolDataFormat === 'legacy'`). */
  poolDataFormat: PoolDataFormat
  /**
   * Unique. An empty list is allowed on chain, but the SDK's guards refuse a lane that then trusts no
   * remote pool (`NO_REMOTE_POOL`), unless `trustPolicyRemotePools` brings in policy pools.
   */
  remotePools: InlineRemotePool[]
}

/** A remote pool policy record. Always sends long data, so EVM multi-token pool remotes only. */
export type RemotePoolPolicyRecord = PolicyRecordKey & {
  /** Trusted remote pools, in the remote chain's own format. */
  remotePoolAddresses: string[]
}

/** The four buckets of one lane or policy record (shared by both families). */
export type { MultiTokenPoolRateLimits }

/** An inline rate limit record. */
export type InlineRateLimitConfig = MultiTokenPoolLaneKey & {
  /** The lane's four buckets. */
  rateLimits: MultiTokenPoolRateLimits
}

/** A rate limit policy record. The policy's first record fixes its decimals. */
export type RateLimitPolicyRecord = PolicyRecordKey & {
  /** Decimals the policy's amounts are in; every token assigned to it must share them. */
  localDecimals: number
  /** The record's four buckets. */
  rateLimits: MultiTokenPoolRateLimits
}

/** Fee fields: the fee half of core `TokenTransferFeeConfig`. A fee record has no disabled state. */
export type MultiTokenPoolFeeConfig = Pick<
  TokenTransferFeeConfig,
  | 'finalityFeeUSDCents'
  | 'fastFinalityFeeUSDCents'
  | 'finalityTransferFeeBps'
  | 'fastFinalityTransferFeeBps'
>

/** Overhead fields: the overhead half of core `TokenTransferFeeConfig`. */
export type MultiTokenPoolDestOverheadConfig = Pick<
  TokenTransferFeeConfig,
  'destGasOverhead' | 'destBytesOverhead'
>

/** An inline fee record. */
export type InlineFeeConfig = MultiTokenPoolLaneKey & {
  /** The lane's fees. */
  feeConfig: MultiTokenPoolFeeConfig
}
/** A fee policy record. */
export type FeePolicyRecord = PolicyRecordKey & {
  /** The record's fees. */
  feeConfig: MultiTokenPoolFeeConfig
}
/** An inline destination overhead record. `destBytesOverhead` is also the pool data size cap. */
export type InlineDestOverheadConfig = MultiTokenPoolLaneKey & {
  /** The lane's overheads. */
  destOverheadConfig: MultiTokenPoolDestOverheadConfig
}
/** A destination overhead policy record. */
export type DestOverheadPolicyRecord = PolicyRecordKey & {
  /** The record's overheads. */
  destOverheadConfig: MultiTokenPoolDestOverheadConfig
}

/**
 * CCV lists and hook of a lane or policy record. `ZeroAddress` stands for the ramps' default CCVs.
 * An empty list also means "defaults"; only a non-empty list without `ZeroAddress` drops them.
 * No threshold lists: multi-token pools ignore amount (why `CCVConfig` is not reused).
 */
export type MultiTokenPoolSecurityConfig = {
  /** CCVs an outbound transfer needs. */
  outboundCCVs: string[]
  /** CCVs an inbound transfer needs. */
  inboundCCVs: string[]
  /** Hook contract, or `null`. */
  hook: string | null
}

/** An inline security record. */
export type InlineSecurityConfig = MultiTokenPoolLaneKey & {
  /** The lane's CCVs and hook. */
  securityConfig: MultiTokenPoolSecurityConfig
}
/** A security policy record. */
export type SecurityPolicyRecord = PolicyRecordKey & {
  /** The record's CCVs and hook. */
  securityConfig: MultiTokenPoolSecurityConfig
}
