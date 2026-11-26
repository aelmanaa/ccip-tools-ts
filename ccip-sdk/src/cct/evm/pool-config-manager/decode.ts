/**
 * Decoders from the PCM view outputs to the record shapes of `./records.ts`. Internal: the shapes are
 * public, the ABI structs they decode from are not.
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

import type { LaneRecordType } from '../../../chain.ts'
import { decodeRemotePools } from '../../../evm/multi-token-pool.ts'
import { decodeRemoteAddress } from '../../remote-address.ts'
import { nullableAddress } from '../multi-token-pool/contracts.ts'
import { fromAbiRateLimitConfig } from '../token-pool/rate-limit.ts'
import { type MultiTokenPoolLaneKey, type PolicyName, decodePolicyName } from './contracts.ts'
import type {
  ConnectionPolicyRecord,
  DestOverheadPolicyRecord,
  FeePolicyRecord,
  InlineConnectionConfig,
  InlineDestOverheadConfig,
  InlineFeeConfig,
  InlineRateLimitConfig,
  InlineRemotePoolConfig,
  InlineSecurityConfig,
  MultiTokenPoolDestOverheadConfig,
  MultiTokenPoolFeeConfig,
  MultiTokenPoolRateLimits,
  MultiTokenPoolSecurityConfig,
  PolicyRecordKey,
  RateLimitPolicyRecord,
  RemotePoolPolicyRecord,
  SecurityPolicyRecord,
} from './records.ts'
type AbiBucket = { isEnabled: boolean; capacity: bigint; rate: bigint }
/** An ABI four-bucket rate limit config. @internal */
export type AbiRateLimits = {
  outbound: AbiBucket
  inbound: AbiBucket
  fastFinalityOutbound: AbiBucket
  fastFinalityInbound: AbiBucket
}

/** @internal */
export function decodeRateLimits(c: AbiRateLimits): MultiTokenPoolRateLimits {
  return {
    outbound: fromAbiRateLimitConfig(c.outbound),
    inbound: fromAbiRateLimitConfig(c.inbound),
    fastFinalityOutbound: fromAbiRateLimitConfig(c.fastFinalityOutbound),
    fastFinalityInbound: fromAbiRateLimitConfig(c.fastFinalityInbound),
  }
}

/** @internal */
export function decodeFeeConfig(c: {
  finalityFeeUSDCents: bigint | number
  fastFinalityFeeUSDCents: bigint | number
  finalityTransferFeeBps: bigint | number
  fastFinalityTransferFeeBps: bigint | number
}): MultiTokenPoolFeeConfig {
  return {
    finalityFeeUSDCents: Number(c.finalityFeeUSDCents),
    fastFinalityFeeUSDCents: Number(c.fastFinalityFeeUSDCents),
    finalityTransferFeeBps: Number(c.finalityTransferFeeBps),
    fastFinalityTransferFeeBps: Number(c.fastFinalityTransferFeeBps),
  }
}

/** @internal */
export function decodeDestOverheadConfig(c: {
  destGasOverhead: bigint | number
  destBytesOverhead: bigint | number
}): MultiTokenPoolDestOverheadConfig {
  return {
    destGasOverhead: Number(c.destGasOverhead),
    destBytesOverhead: Number(c.destBytesOverhead),
  }
}

/** @internal */
export function decodeSecurityConfig(c: {
  outboundCCVs: readonly string[]
  inboundCCVs: readonly string[]
  hook: string
}): MultiTokenPoolSecurityConfig {
  return {
    outboundCCVs: c.outboundCCVs.map((a) => getAddress(a)),
    inboundCCVs: c.inboundCCVs.map((a) => getAddress(a)),
    hook: nullableAddress(c.hook),
  }
}

/** The policy record key of a decoded record. @internal */
export function decodePolicyRecordKey(c: {
  policyName: string
  remoteChainSelector: bigint
}): PolicyRecordKey {
  return {
    // a record always belongs to a named policy, so the zero word never appears here
    policyName: decodePolicyName(c.policyName) ?? c.policyName,
    remoteChainSelector: BigInt(c.remoteChainSelector),
  }
}

/** The lane key of a decoded inline record. @internal */
export function decodeInlineKey(c: {
  localToken: string
  remoteChainSelector: bigint
}): MultiTokenPoolLaneKey {
  return {
    tokenAddress: getAddress(c.localToken),
    remoteChainSelector: BigInt(c.remoteChainSelector),
  }
}

/** Decodes an inline remote pool record. @internal */
export function decodeInlineRemotePoolConfig(c: {
  localToken: string
  remoteChainSelector: bigint
  trustPolicyRemotePools: boolean
  remotePoolConfig: {
    useLegacyPoolDataOnSend: boolean
    remotePools: readonly { remotePoolAddress: string; allowLegacyPoolDataOnReceive: boolean }[]
  }
}): InlineRemotePoolConfig {
  const key = decodeInlineKey(c)
  return {
    ...key,
    trustPolicyRemotePools: c.trustPolicyRemotePools,
    poolDataFormat: c.remotePoolConfig.useLegacyPoolDataOnSend ? 'legacy' : 'long',
    remotePools: decodeRemotePools(c.remotePoolConfig.remotePools, (bytes) =>
      decodeRemoteAddress(bytes, key.remoteChainSelector),
    ),
  }
}

/** The policy assigned per record type in a `TokenConfig`, or `null`. @internal */
export function decodeTokenPolicies(c: {
  connectionPolicyName: string
  remotePoolPolicyName: string
  rateLimitPolicyName: string
  feePolicyName: string
  destOverheadPolicyName: string
  securityPolicyName: string
}): Record<LaneRecordType, PolicyName | null> {
  return {
    connection: decodePolicyName(c.connectionPolicyName),
    remotePool: decodePolicyName(c.remotePoolPolicyName),
    rateLimit: decodePolicyName(c.rateLimitPolicyName),
    fee: decodePolicyName(c.feePolicyName),
    destOverhead: decodePolicyName(c.destOverheadPolicyName),
    security: decodePolicyName(c.securityPolicyName),
  }
}

type AbiInlineKey = { localToken: string; remoteChainSelector: bigint }
type AbiPolicyKey = { policyName: string; remoteChainSelector: bigint }

/**
 * One decoder per inline record struct, shared by the record reads (view outputs) and the calldata
 * decoder (write inputs): the PCM takes and returns the same structs.
 * @internal
 */
export const INLINE_RECORD_DECODERS = {
  connection: (c: AbiInlineKey & { remoteToken: string }): InlineConnectionConfig => {
    const key = decodeInlineKey(c)
    return { ...key, remoteToken: decodeRemoteAddress(c.remoteToken, key.remoteChainSelector) }
  },
  remotePool: decodeInlineRemotePoolConfig,
  rateLimit: (c: AbiInlineKey & { rateLimitConfig: AbiRateLimits }): InlineRateLimitConfig => ({
    ...decodeInlineKey(c),
    rateLimits: decodeRateLimits(c.rateLimitConfig),
  }),
  fee: (
    c: AbiInlineKey & { feeConfig: Parameters<typeof decodeFeeConfig>[0] },
  ): InlineFeeConfig => ({
    ...decodeInlineKey(c),
    feeConfig: decodeFeeConfig(c.feeConfig),
  }),
  destOverhead: (
    c: AbiInlineKey & { destOverheadConfig: Parameters<typeof decodeDestOverheadConfig>[0] },
  ): InlineDestOverheadConfig => ({
    ...decodeInlineKey(c),
    destOverheadConfig: decodeDestOverheadConfig(c.destOverheadConfig),
  }),
  security: (
    c: AbiInlineKey & { securityConfig: Parameters<typeof decodeSecurityConfig>[0] },
  ): InlineSecurityConfig => ({
    ...decodeInlineKey(c),
    securityConfig: decodeSecurityConfig(c.securityConfig),
  }),
} as const

/**
 * One decoder per policy record struct, shared by the policy reads and the calldata decoder.
 * @internal
 */
export const POLICY_RECORD_DECODERS = {
  connection: (r: AbiPolicyKey & { onlySubsetTokens: boolean }): ConnectionPolicyRecord => ({
    ...decodePolicyRecordKey(r),
    onlySubsetTokens: Boolean(r.onlySubsetTokens),
  }),
  remotePool: (
    r: AbiPolicyKey & { remotePoolAddresses: readonly string[] },
  ): RemotePoolPolicyRecord => {
    const key = decodePolicyRecordKey(r)
    return {
      ...key,
      remotePoolAddresses: r.remotePoolAddresses.map((a) =>
        decodeRemoteAddress(a, key.remoteChainSelector),
      ),
    }
  },
  rateLimit: (
    r: AbiPolicyKey & { localDecimals: bigint | number; rateLimitConfig: AbiRateLimits },
  ): RateLimitPolicyRecord => ({
    ...decodePolicyRecordKey(r),
    localDecimals: Number(r.localDecimals),
    rateLimits: decodeRateLimits(r.rateLimitConfig),
  }),
  fee: (
    r: AbiPolicyKey & { feeConfig: Parameters<typeof decodeFeeConfig>[0] },
  ): FeePolicyRecord => ({
    ...decodePolicyRecordKey(r),
    feeConfig: decodeFeeConfig(r.feeConfig),
  }),
  destOverhead: (
    r: AbiPolicyKey & { destOverheadConfig: Parameters<typeof decodeDestOverheadConfig>[0] },
  ): DestOverheadPolicyRecord => ({
    ...decodePolicyRecordKey(r),
    destOverheadConfig: decodeDestOverheadConfig(r.destOverheadConfig),
  }),
  security: (
    r: AbiPolicyKey & { securityConfig: Parameters<typeof decodeSecurityConfig>[0] },
  ): SecurityPolicyRecord => ({
    ...decodePolicyRecordKey(r),
    securityConfig: decodeSecurityConfig(r.securityConfig),
  }),
} as const
