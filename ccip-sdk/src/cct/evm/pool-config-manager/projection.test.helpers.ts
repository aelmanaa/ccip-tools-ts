/**
 * Record-state builders for the PoolConfigManager unit tests: an empty state, and the six inline
 * records of a healthy lane (each overridable).
 */

import { ZeroAddress, getAddress } from 'ethers'

import type { LaneRecordType } from '../../../chain.ts'
import { LANE_RECORD_TYPES } from '../../../evm/multi-token-pool.ts'
import type { MultiTokenPoolRecordChange, MultiTokenPoolRecordState } from './projection.ts'

const addr = (n: number) => getAddress('0x' + n.toString(16).padStart(40, '0'))
/** The remote token every built lane names, unless overridden. */
export const REMOTE_A = addr(0xe1)
/** The remote pool every built lane trusts, unless overridden. */
export const RPOOL = addr(0xf1)
/** The remote chain every built lane is toward. */
export const C1 = 16015286601757825753n

/** An empty record state. */
export const empty = (): MultiTokenPoolRecordState => ({
  isGloballyPaused: false,
  chainPauses: [],
  tokens: [],
  policies: {
    connection: [],
    remoteTokenAddressProviders: [],
    remotePool: [],
    rateLimit: [],
    fee: [],
    destOverhead: [],
    security: [],
  },
  providerAnswers: [],
})
/** An enabled bucket (100/1), or a disabled one. */
export const on = (enabled: boolean) =>
  ({ enabled, capacity: enabled ? 100n : 0n, rate: enabled ? 1n : 0n }) as const

/** Inline records of every type for `token` on C1, overridable per type. */
/** The six inline records of a healthy lane toward {@link C1}, each overridable or skippable. */
export function inlineLane(
  token: string,
  o: {
    remoteToken?: string
    format?: 'legacy' | 'long'
    pools?: { address: string; allowLegacyPoolData: boolean }[]
    bytes?: number
    gas?: number
    bps?: number
    ccvs?: string[]
    hook?: string | null
    skip?: LaneRecordType[]
  } = {},
): MultiTokenPoolRecordChange[] {
  const key = { tokenAddress: token, remoteChainSelector: C1 }
  const all: Record<LaneRecordType, MultiTokenPoolRecordChange> = {
    connection: {
      kind: 'setInline',
      type: 'connection',
      record: { ...key, remoteToken: o.remoteToken ?? REMOTE_A },
    },
    remotePool: {
      kind: 'setInline',
      type: 'remotePool',
      record: {
        ...key,
        trustPolicyRemotePools: false,
        poolDataFormat: o.format ?? 'long',
        remotePools: o.pools ?? [{ address: RPOOL, allowLegacyPoolData: false }],
      },
    },
    rateLimit: {
      kind: 'setInline',
      type: 'rateLimit',
      record: {
        ...key,
        rateLimits: {
          outbound: on(true),
          inbound: on(true),
          fastFinalityOutbound: on(false),
          fastFinalityInbound: on(false),
        },
      },
    },
    fee: {
      kind: 'setInline',
      type: 'fee',
      record: {
        ...key,
        feeConfig: {
          finalityFeeUSDCents: 1,
          fastFinalityFeeUSDCents: 2,
          finalityTransferFeeBps: o.bps ?? 5,
          fastFinalityTransferFeeBps: o.bps ?? 5,
        },
      },
    },
    destOverhead: {
      kind: 'setInline',
      type: 'destOverhead',
      record: {
        ...key,
        destOverheadConfig: {
          destGasOverhead: o.gas ?? 350_000,
          destBytesOverhead: o.bytes ?? 224,
        },
      },
    },
    security: {
      kind: 'setInline',
      type: 'security',
      record: {
        ...key,
        securityConfig: {
          outboundCCVs: o.ccvs ?? [ZeroAddress],
          inboundCCVs: o.ccvs ?? [ZeroAddress],
          hook: o.hook ?? null,
        },
      },
    },
  }
  return LANE_RECORD_TYPES.filter((t) => !o.skip?.includes(t)).map((t) => all[t])
}
