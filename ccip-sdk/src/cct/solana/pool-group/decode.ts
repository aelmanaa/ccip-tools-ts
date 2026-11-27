/**
 * Converts IDL-decoded pool-group accounts into the public read types.
 *
 * @packageDocumentation
 */

import { Buffer } from 'buffer'

import type { IdlTypes } from '@coral-xyz/anchor'
import { PublicKey } from '@solana/web3.js'

import type { TokenTransferFeeConfig } from '../../../chain.ts'
import type { BurnmintTokenPoolGroups } from '../../../solana/idl/pool-groups-7558722/BURN_MINT_TOKEN_POOL.ts'
import { decodeTokenPoolFinality } from '../../../solana/token-pool.ts'
import type { RateLimitConfig } from '../../rate-limit.ts'
import { decodeRemoteAddress } from '../../remote-address.ts'
import type { IdlPolicySections } from './lane.ts'
import {
  type PoolGroupCCVSet,
  type PoolGroupHookConfig,
  type PoolGroupLaneMode,
  type PoolGroupPolicyClass,
  type PoolGroupRoles,
  type PoolGroupSections,
  POOL_GROUP_POLICY_CLASSES,
} from './types.ts'

type Types = IdlTypes<BurnmintTokenPoolGroups>

const DEFAULT_KEY = PublicKey.default

/** `Pubkey::default()` → `null`. @internal */
export const keyOrNull = (key: PublicKey): string | null =>
  key.equals(DEFAULT_KEY) ? null : key.toBase58()

/** `INCLUDE_DEFAULT_CCVS` (the all-zero key) reads as `'default'`. */
const ccv = (key: PublicKey) => (key.equals(DEFAULT_KEY) ? 'default' : key.toBase58())

/** Converts a CCV list (`INCLUDE_DEFAULT_CCVS` as `'default'`). @internal */
export const decodeCCVs = (keys: readonly PublicKey[]): string[] => keys.map(ccv)

/** IDL `RateLimitConfig` → the shared `RateLimitConfig`. @internal */
export function decodeRateLimitConfig(cfg: Types['RateLimitConfig']): RateLimitConfig {
  return cfg.enabled
    ? {
        enabled: true,
        capacity: BigInt(cfg.capacity.toString()),
        rate: BigInt(cfg.rate.toString()),
      }
    : {
        enabled: false,
        capacity: BigInt(cfg.capacity.toString()),
        rate: BigInt(cfg.rate.toString()),
      }
}

/** IDL `TokenTransferFeeConfig` → the core `TokenTransferFeeConfig`. @internal */
export function decodeFeeConfig(fee: Types['TokenTransferFeeConfig']): TokenTransferFeeConfig {
  return {
    destGasOverhead: fee.destGasOverhead,
    destBytesOverhead: fee.destBytesOverhead,
    finalityFeeUSDCents: fee.finalityFee,
    fastFinalityFeeUSDCents: fee.fastFinalityFee,
    finalityTransferFeeBps: fee.finalityBpsFee,
    fastFinalityTransferFeeBps: fee.fastFinalityBpsFee,
    isEnabled: fee.isEnabled,
  }
}

function decodeCCVSet(set: Types['CcvSet']): PoolGroupCCVSet {
  return {
    outbound: decodeCCVs(set.outbound),
    inbound: decodeCCVs(set.inbound),
    epoch: BigInt(set.epoch.toString()),
  }
}

/** IDL `HookConfig` → {@link PoolGroupHookConfig}. @internal */
export function decodeHookConfig(hook: Types['HookConfig']): PoolGroupHookConfig {
  const engine = hook.policyEngine
  return {
    allowlist: hook.allowlist?.toBase58() ?? null,
    blocklist: hook.blocklist?.toBase58() ?? null,
    policyEngine: engine
      ? {
          program: engine.program.toBase58(),
          staticAccounts: engine.staticAccounts.map((k) => k.toBase58()),
          writableStatics: engine.staticAccounts.flatMap((_, i) =>
            (engine.writableStatics >> i) & 1 ? [i] : [],
          ),
          onSend: engine.onSend,
          onReceive: engine.onReceive,
        }
      : null,
  }
}

/**
 * IDL `PolicySections` → {@link PoolGroupSections}. Remote pools are decoded for
 * `remoteChainSelector`'s family; a record without a chain (a group or policy default) keeps them as
 * `0x` hex.
 * @internal
 */
export function decodeSections(
  sections: IdlPolicySections,
  remoteChainSelector?: bigint,
): PoolGroupSections {
  const { connection, fee, rateLimit, security } = sections
  return {
    connection: {
      remotePools: connection.remotePools.map((pool) => {
        const bytes = Buffer.from(pool.address.address)
        return {
          address:
            remoteChainSelector === undefined
              ? `0x${bytes.toString('hex')}`
              : decodeRemoteAddress(bytes, remoteChainSelector),
          allowLegacyPoolData: pool.allowLegacyPoolData,
        }
      }),
      poolDataFormat: 'long' in connection.poolDataFormat ? 'long' : 'legacy',
      allowedFinality: decodeTokenPoolFinality(connection.allowedFinalityConfig),
    },
    fee: { tokenTransferFeeConfig: decodeFeeConfig(fee.tokenTransferFeeConfig) },
    rateLimit: {
      outbound: decodeRateLimitConfig(rateLimit.outbound),
      inbound: decodeRateLimitConfig(rateLimit.inbound),
      fastFinalityOutbound: decodeRateLimitConfig(rateLimit.ftfOutbound),
      fastFinalityInbound: decodeRateLimitConfig(rateLimit.ftfInbound),
    },
    security: {
      current: decodeCCVSet(security.current),
      pending: security.pending
        ? {
            ...decodeCCVSet(security.pending),
            activatesAt: BigInt(security.pending.activatesAt.toString()),
          }
        : null,
      allowDroppingDefaultCCVs: security.allowDroppingDefaultCcvs,
      hook: security.hook ? decodeHookConfig(security.hook) : null,
    },
  }
}

/** IDL `GroupRoles` → {@link PoolGroupRoles}. @internal */
export function decodeRoles(roles: Types['GroupRoles']): PoolGroupRoles {
  return {
    policyAdmin: keyOrNull(roles.policyAdmin),
    connectionAdmin: keyOrNull(roles.connectionAdmin),
    feeAdmin: keyOrNull(roles.feeAdmin),
    rateLimitAdmin: keyOrNull(roles.rateLimitAdmin),
    securityAdmin: keyOrNull(roles.securityAdmin),
    pauser: keyOrNull(roles.pauser),
    unpauser: keyOrNull(roles.unpauser),
  }
}

/** A `PolicyClass::bit` mask → its classes. @internal */
export function decodeClassBits(bits: number): PoolGroupPolicyClass[] {
  return POOL_GROUP_POLICY_CLASSES.filter((_, i) => (bits >> i) & 1)
}

/** IDL `GroupLaneMode` → {@link PoolGroupLaneMode}. @internal */
export function decodeLaneMode(mode: Types['GroupLaneMode']): PoolGroupLaneMode {
  return 'allMembers' in mode ? 'all-members' : 'subset' in mode ? 'subset' : 'off'
}

/** BN or number → bigint. @internal */
export const toBigInt = (v: { toString(): string }): bigint => BigInt(v.toString())
