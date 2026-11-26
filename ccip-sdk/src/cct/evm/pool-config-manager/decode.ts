/**
 * Decoders from the PCM view outputs to the record shapes of `./records.ts`. Internal: the shapes are
 * public, the ABI structs they decode from are not.
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

import { decodeRemoteAddress } from '../../remote-address.ts'
import { nullableAddress } from '../multi-token-pool/contracts.ts'
import { fromAbiRateLimitConfig } from '../token-pool/rate-limit.ts'
import { type MultiTokenPoolLaneKey, decodePolicyName } from './contracts.ts'
import type {
  InlineRemotePoolConfig,
  MultiTokenPoolDestOverheadConfig,
  MultiTokenPoolFeeConfig,
  MultiTokenPoolRateLimits,
  MultiTokenPoolSecurityConfig,
  PolicyRecordKey,
} from './records.ts'
type AbiBucket = { isEnabled: boolean; capacity: bigint; rate: bigint }
type AbiRateLimits = {
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
    remotePools: c.remotePoolConfig.remotePools.map((p) => ({
      address: decodeRemoteAddress(p.remotePoolAddress, key.remoteChainSelector),
      allowLegacyPoolData: p.allowLegacyPoolDataOnReceive,
    })),
  }
}
