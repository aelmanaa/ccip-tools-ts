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
import type { PoolDataFormat } from '../../multi-token-pool.ts'
import type { RateLimitConfig } from '../token-pool/rate-limit.ts'
import type { MultiTokenPoolLaneKey, PolicyName } from './contracts.ts'

/** One policy record: a policy and a remote chain (`0n` = the policy's default record). */
export type PolicyRecordKey = {
  /** The policy. */
  policyName: PolicyName
  /** `0n` addresses a fee, overhead, rate limit or security default; connection and remote pool policies have none. */
  remoteChainSelector: bigint
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

/** One remote pool of an inline remote pool record. */
export type InlineRemotePool = {
  /** Remote pool in the remote chain's own format; an EVM pool is encoded as `abi.encode(pool)`. */
  address: string
  /**
   * Accept 32-byte legacy pool data from it (F3; see `migrationWindowChains`). The contract field is
   * `allowLegacyPoolDataOnReceive`; the SDK name matches the Solana pool group's.
   */
  allowLegacyPoolData: boolean
}

/** An inline remote pool record. A set replaces the whole record. */
export type InlineRemotePoolConfig = MultiTokenPoolLaneKey & {
  /** Whether the lane also trusts the remote pools of the token's remote pool policy. */
  trustPolicyRemotePools: boolean
  /** Pool data the lane sends (the contract's `useLegacyPoolDataOnSend` is `poolDataFormat === 'legacy'`). */
  poolDataFormat: PoolDataFormat
  /** Unique; may be empty (outbound only). */
  remotePools: InlineRemotePool[]
}

/** A remote pool policy record. Always sends long data, so EVM multi-token pool remotes only. */
export type RemotePoolPolicyRecord = PolicyRecordKey & {
  /** Trusted remote pools, in the remote chain's own format. */
  remotePoolAddresses: string[]
}

/** The four buckets of one lane or policy record, each the shared `RateLimitConfig`. */
export type MultiTokenPoolRateLimits = {
  /** Outbound bucket. */
  outbound: RateLimitConfig
  /** Inbound bucket. */
  inbound: RateLimitConfig
  /** Outbound faster-than-finality bucket. */
  fastFinalityOutbound: RateLimitConfig
  /** Inbound faster-than-finality bucket. */
  fastFinalityInbound: RateLimitConfig
}

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
 * An empty list also means "defaults"; only a non-empty list without `ZeroAddress` drops them (F2).
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
