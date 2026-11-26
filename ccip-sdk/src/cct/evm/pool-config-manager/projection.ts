/**
 * Lane projection: what the PCM's resolved views would return after a write, computed from its
 * stored records without sending anything.
 *
 * The post-state guards project every affected lane after a write and evaluate their
 * rules on the result. This module is the pure core of that: a {@link MultiTokenPoolRecordState} (the
 * stored records, in the shapes the reads return), {@link applyMultiTokenPoolRecordChanges} (a write,
 * as store-level record changes) and {@link resolveMultiTokenPoolLanes} (the stores' resolution, view
 * for view). It reads nothing and sends nothing.
 *
 * @remarks Mirrors `ConnectionPolicyStore`, `FeePolicyStore` and `SecurityPolicyStore` at
 * chainlink-ccip c950d9bc (`2.1.0-dev`), including the PCM's zeroing of lanes without a connection:
 * - connection: inline record, else the connection policy's chain record when the token passes its
 *   subset (`onlySubsetTokens`); no default record;
 * - remote pools: the inline record, plus the policy's pools (never legacy) when it has
 *   `trustPolicyRemotePools`; the policy's pools alone without an inline record; no default record;
 * - rate limit, fee, destination overhead and security: inline, else policy chain record, else the
 *   policy's chain-0 default;
 * - chain selector 0 resolves to `'none'` for every type.
 *
 * It does not model reverts: a change the stores would refuse (an inline record on an unregistered
 * token, a subset token not assigned to the policy) projects as if it applied. The ops `eth_call` the
 * write itself, which catches those.
 *
 * @packageDocumentation
 */

import { ZeroAddress, getAddress } from 'ethers'

import type { LaneRecordType, TokenTransferFeeConfig } from '../../../chain.ts'
import { LANE_RECORD_TYPES } from '../../../evm/multi-token-pool.ts'
import { CCTParamsInvalidError } from '../../errors.ts'
import type { RateLimitConfig } from '../token-pool/rate-limit.ts'
import { type MultiTokenPoolLaneKey, type PolicyName, encodePolicyName } from './contracts.ts'
import type { GetMultiTokenPoolInlineConfigsResult } from './operations/get-multi-token-pool-inline-configs.ts'
import type { MultiTokenPoolLaneConnection } from './operations/get-multi-token-pool-lane-connections.ts'
import type { MultiTokenPoolRecordLevel } from './operations/get-multi-token-pool-lane-record-levels.ts'
import type { MultiTokenPoolLaneVerification } from './operations/get-multi-token-pool-lane-verifications.ts'
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
  MultiTokenPoolRateLimits,
  PolicyRecordKey,
  RateLimitPolicyRecord,
  RemotePoolPolicyRecord,
  SecurityPolicyRecord,
} from './records.ts'

const OPERATION = 'projectMultiTokenPoolLanes'

// ─── State ──────────────────────────────────────────────────────────────────────────────────

/**
 * One token's stored records.
 * @internal
 */
export type MultiTokenPoolTokenRecords = {
  /** The token. */
  tokenAddress: string
  /** The token's own outbound pause (kept across re-registration). */
  isOutboundPaused: boolean
  /** The token's own inbound pause. */
  isInboundPaused: boolean
  /** The policy assigned for each record type, or `null`. */
  policies: Record<LaneRecordType, PolicyName | null>
  /** The token's inline records, as `getMultiTokenPoolInlineConfigs` reads them. */
  inline: Required<GetMultiTokenPoolInlineConfigsResult>
}

/**
 * A connection policy's chain record with its subset list (kept while `onlySubsetTokens` is `false`).
 * @internal
 */
export type MultiTokenPoolConnectionPolicyRecordState = ConnectionPolicyRecord & {
  /** The subset tokens of the record. */
  subsetTokens: string[]
}

/**
 * Every policy's stored records, flat per record type.
 * @internal
 */
export type MultiTokenPoolPolicyRecords = {
  /** Connection policy chain records with their subsets. */
  connection: MultiTokenPoolConnectionPolicyRecordState[]
  /** The remote token address provider of each connection policy that has one. */
  remoteTokenAddressProviders: {
    /** The connection policy. */
    policyName: PolicyName
    /** Its provider. */
    provider: string
  }[]
  /** Remote pool policy chain records. */
  remotePool: RemotePoolPolicyRecord[]
  /** Rate limit policy records (chain `0n` = default). */
  rateLimit: RateLimitPolicyRecord[]
  /** Fee policy records (chain `0n` = default). */
  fee: FeePolicyRecord[]
  /** Destination overhead policy records (chain `0n` = default). */
  destOverhead: DestOverheadPolicyRecord[]
  /** Security policy records (chain `0n` = default). */
  security: SecurityPolicyRecord[]
}

/**
 * What a remote token address provider answers for one (token, chain), as the connection view reads
 * it: `null` when the provider has no code, reverts, or returns an empty or all-zero address.
 * @internal
 */
export type MultiTokenPoolProviderAnswer = MultiTokenPoolLaneKey & {
  /** The provider. */
  provider: string
  /** Its answer in the remote chain's canonical format, or `null`. */
  remoteToken: string | null
}

/**
 * A PCM's stored records: the input of the projection.
 * @internal
 */
export type MultiTokenPoolRecordState = {
  /** The PCM-wide pause. */
  isGloballyPaused: boolean
  /** Chains with a pause flag set; a chain not listed is unpaused. */
  chainPauses: {
    /** The remote chain. */
    remoteChainSelector: bigint
    /** Outbound transfers to it are paused for every token. */
    outbound: boolean
    /** Inbound transfers from it are paused for every token. */
    inbound: boolean
  }[]
  /** Tokens with any record or pause; a token not listed has none. */
  tokens: MultiTokenPoolTokenRecords[]
  /** Every policy record. */
  policies: MultiTokenPoolPolicyRecords
  /** Provider answers for every policy-resolved lane the projection resolves. */
  providerAnswers: MultiTokenPoolProviderAnswer[]
}

/** One of a rate limit record's four buckets. @internal */
export type MultiTokenPoolRateLimitBucket = keyof MultiTokenPoolRateLimits

// ─── Changes ────────────────────────────────────────────────────────────────────────────────

/** The inline record of each type, as reads return and writes take it. @internal */
export type MultiTokenPoolInlineRecord = {
  connection: InlineConnectionConfig
  remotePool: InlineRemotePoolConfig
  rateLimit: InlineRateLimitConfig
  fee: InlineFeeConfig
  destOverhead: InlineDestOverheadConfig
  security: InlineSecurityConfig
}

/** The policy record of each type. @internal */
export type MultiTokenPoolPolicyRecord = {
  connection: ConnectionPolicyRecord
  remotePool: RemotePoolPolicyRecord
  rateLimit: RateLimitPolicyRecord
  fee: FeePolicyRecord
  destOverhead: DestOverheadPolicyRecord
  security: SecurityPolicyRecord
}

/**
 * One store-level change, the unit a write is projected as. A set replaces the whole record (a
 * connection policy record keeps its subset list); a remove of a missing record is a no-op.
 * @internal
 */
export type MultiTokenPoolRecordChange =
  | {
      [T in LaneRecordType]: {
        /** Set (create or replace) a token's inline record. */
        kind: 'setInline'
        /** The record type. */
        type: T
        /** The record. */
        record: MultiTokenPoolInlineRecord[T]
      }
    }[LaneRecordType]
  | (MultiTokenPoolLaneKey & {
      /** Remove a token's inline record. */
      kind: 'removeInline'
      /** The record type. */
      type: LaneRecordType
    })
  | {
      [T in LaneRecordType]: {
        /** Set (create or replace) a policy's chain or default record. */
        kind: 'setPolicyRecord'
        /** The record type. */
        type: T
        /** The record. */
        record: MultiTokenPoolPolicyRecord[T]
      }
    }[LaneRecordType]
  | (PolicyRecordKey & {
      /** Remove one policy record (a connection record's subset list goes with it). */
      kind: 'removePolicyRecord'
      /** The record type. */
      type: LaneRecordType
    })
  | {
      /** Remove a policy: its records and, for a connection policy, its provider. */
      kind: 'removePolicy'
      /** The record type. */
      type: LaneRecordType
      /** The policy. */
      policyName: PolicyName
    }
  | {
      /** Assign a token's policy of one type (`null` unassigns). */
      kind: 'assignPolicy'
      /** The record type. */
      type: LaneRecordType
      /** The token. */
      tokenAddress: string
      /** The policy, or `null`. */
      policyName: PolicyName | null
    }
  | (PolicyRecordKey & {
      /** Edit a connection policy record's subset list (removals first). */
      kind: 'updateSubsetTokens'
      /** Tokens to add. */
      add?: string[]
      /** Tokens to remove. */
      remove?: string[]
    })
  | {
      /** Set or clear a connection policy's remote token address provider. */
      kind: 'setRemoteTokenAddressProvider'
      /** The connection policy. */
      policyName: PolicyName
      /** The provider, or `null`. */
      provider: string | null
    }
  | (MultiTokenPoolLaneKey & {
      /** Set one bucket of a token's inline rate limit record (a missing record: no-op, the store reverts). */
      kind: 'setInlineRateLimitBucket'
      /** The bucket. */
      bucket: MultiTokenPoolRateLimitBucket
      /** Its config. */
      config: RateLimitConfig
    })
  | (PolicyRecordKey & {
      /** Set one bucket of a rate limit policy record (a missing record: no-op, the store reverts). */
      kind: 'setPolicyRateLimitBucket'
      /** The bucket. */
      bucket: MultiTokenPoolRateLimitBucket
      /** Its config. */
      config: RateLimitConfig
    })
  | {
      /** Set the PCM-wide pause. */
      kind: 'setGlobalPause'
      /** Whether paused. */
      paused: boolean
    }
  | {
      /** Set a chain's pause flags (an omitted direction keeps its flag). */
      kind: 'setChainPause'
      /** The remote chain. */
      remoteChainSelector: bigint
      /** Outbound flag. */
      outbound?: boolean
      /** Inbound flag. */
      inbound?: boolean
    }
  | {
      /** Set a token's pause flags (an omitted direction keeps its flag). */
      kind: 'setTokenPause'
      /** The token. */
      tokenAddress: string
      /** Outbound flag. */
      outbound?: boolean
      /** Inbound flag. */
      inbound?: boolean
    }

// ─── Projected lane ─────────────────────────────────────────────────────────────────────────

/**
 * One lane as the PCM's resolved views return it: `getLaneConnectionBatch`,
 * `getLaneRecordLevelBatch`, `getTokenTransferFeeConfigBatch`, the bucket configs of
 * `getCurrentRateLimiterStateBatch` and `getLaneVerificationBatch`.
 * @internal
 */
export type ProjectedMultiTokenPoolLane = MultiTokenPoolLaneKey & {
  /** `getLaneConnectionBatch`. */
  connection: MultiTokenPoolLaneConnection
  /** `getLaneRecordLevelBatch`: resolved even without a connection. */
  levels: Record<LaneRecordType, MultiTokenPoolRecordLevel>
  /** `getTokenTransferFeeConfigBatch`: all zero and disabled without a connection or a fee record. */
  tokenTransferFeeConfig: TokenTransferFeeConfig
  /** The bucket configs, or `null` without a connection or a rate limit record. */
  rateLimits: MultiTokenPoolRateLimits | null
  /** `getLaneVerificationBatch`: no hook and empty lists without a connection or a security record. */
  verification: MultiTokenPoolLaneVerification
}

const DISABLED_FEE: TokenTransferFeeConfig = {
  destGasOverhead: 0,
  destBytesOverhead: 0,
  finalityFeeUSDCents: 0,
  fastFinalityFeeUSDCents: 0,
  finalityTransferFeeBps: 0,
  fastFinalityTransferFeeBps: 0,
  isEnabled: false,
}

// ─── Keys ───────────────────────────────────────────────────────────────────────────────────

const policyKey = (name: PolicyName, param: string) =>
  encodePolicyName(OPERATION, param, name).toLowerCase()
const laneKey = (token: string, chain: bigint) => `${getAddress(token)}:${chain}`
const recordKey = (policy: PolicyName, chain: bigint, param: string) =>
  `${policyKey(policy, param)}:${chain}`
const answerKey = (provider: string, token: string, chain: bigint) =>
  `${getAddress(provider)}:${laneKey(token, chain)}`

/** Policy-record types that resolve a chain-0 default (connection and remote pool have none). */
const HAS_DEFAULT: ReadonlySet<LaneRecordType> = new Set([
  'rateLimit',
  'fee',
  'destOverhead',
  'security',
])

function emptyToken(tokenAddress: string): MultiTokenPoolTokenRecords {
  return {
    tokenAddress: getAddress(tokenAddress),
    isOutboundPaused: false,
    isInboundPaused: false,
    policies: Object.fromEntries(LANE_RECORD_TYPES.map((t) => [t, null])) as Record<
      LaneRecordType,
      null
    >,
    inline: {
      connection: [],
      remotePool: [],
      rateLimit: [],
      fee: [],
      destOverhead: [],
      security: [],
    },
  }
}

// ─── Apply ──────────────────────────────────────────────────────────────────────────────────

/**
 * Applies store-level changes, in order, to a copy of `state`.
 *
 * @param state - The records before the write; not modified.
 * @param changes - The write, as record changes.
 * @returns The records after the write.
 * @throws {@link CCTParamsInvalidError} if a change names a malformed policy name
 * @internal
 */
export function applyMultiTokenPoolRecordChanges(
  state: MultiTokenPoolRecordState,
  changes: readonly MultiTokenPoolRecordChange[],
): MultiTokenPoolRecordState {
  const next = structuredClone(state)
  const tokenOf = (address: string) => {
    const a = getAddress(address)
    let token = next.tokens.find((t) => getAddress(t.tokenAddress) === a)
    if (!token) next.tokens.push((token = emptyToken(a)))
    return token
  }
  changes.forEach((change, i) => {
    const param = `changes[${i}]`
    switch (change.kind) {
      case 'setInline': {
        const list = tokenOf(change.record.tokenAddress).inline[
          change.type
        ] as MultiTokenPoolInlineRecord[LaneRecordType][]
        const key = laneKey(change.record.tokenAddress, change.record.remoteChainSelector)
        const at = list.findIndex((r) => laneKey(r.tokenAddress, r.remoteChainSelector) === key)
        const record = structuredClone(change.record)
        if (at >= 0) list[at] = record
        else list.push(record)
        break
      }
      case 'removeInline': {
        const token = tokenOf(change.tokenAddress)
        const key = laneKey(change.tokenAddress, change.remoteChainSelector)
        const list = token.inline[change.type] as MultiTokenPoolInlineRecord[LaneRecordType][]
        token.inline[change.type] = list.filter(
          (r) => laneKey(r.tokenAddress, r.remoteChainSelector) !== key,
        ) as never
        break
      }
      case 'setPolicyRecord': {
        const key = recordKey(change.record.policyName, change.record.remoteChainSelector, param)
        const list = next.policies[change.type] as MultiTokenPoolPolicyRecord[LaneRecordType][]
        const at = list.findIndex(
          (r) => recordKey(r.policyName, r.remoteChainSelector, param) === key,
        )
        const record = structuredClone(change.record)
        if (change.type === 'connection') {
          // updating a connection record keeps its subset list
          const previous = at >= 0 ? next.policies.connection[at]!.subsetTokens : []
          ;(record as MultiTokenPoolConnectionPolicyRecordState).subsetTokens = previous
        }
        if (at >= 0) list[at] = record
        else list.push(record)
        break
      }
      case 'removePolicyRecord': {
        const key = recordKey(change.policyName, change.remoteChainSelector, param)
        next.policies[change.type] = (
          next.policies[change.type] as MultiTokenPoolPolicyRecord[LaneRecordType][]
        ).filter((r) => recordKey(r.policyName, r.remoteChainSelector, param) !== key) as never
        break
      }
      case 'removePolicy': {
        const key = policyKey(change.policyName, `${param}.policyName`)
        next.policies[change.type] = (
          next.policies[change.type] as MultiTokenPoolPolicyRecord[LaneRecordType][]
        ).filter((r) => policyKey(r.policyName, param) !== key) as never
        if (change.type === 'connection')
          next.policies.remoteTokenAddressProviders =
            next.policies.remoteTokenAddressProviders.filter(
              (p) => policyKey(p.policyName, param) !== key,
            )
        break
      }
      case 'assignPolicy':
        tokenOf(change.tokenAddress).policies[change.type] = change.policyName
        break
      case 'updateSubsetTokens': {
        const key = recordKey(change.policyName, change.remoteChainSelector, param)
        const record = next.policies.connection.find(
          (r) => recordKey(r.policyName, r.remoteChainSelector, param) === key,
        )
        if (!record) break // the store refuses additions to a missing record
        const removed = new Set((change.remove ?? []).map((t) => getAddress(t)))
        const kept = record.subsetTokens.filter((t) => !removed.has(getAddress(t)))
        for (const t of change.add ?? [])
          if (!kept.some((k) => getAddress(k) === getAddress(t))) kept.push(getAddress(t))
        record.subsetTokens = kept
        break
      }
      case 'setRemoteTokenAddressProvider': {
        const key = policyKey(change.policyName, `${param}.policyName`)
        const others = next.policies.remoteTokenAddressProviders.filter(
          (p) => policyKey(p.policyName, param) !== key,
        )
        next.policies.remoteTokenAddressProviders =
          change.provider === null || getAddress(change.provider) === ZeroAddress
            ? others
            : [...others, { policyName: change.policyName, provider: getAddress(change.provider) }]
        break
      }
      case 'setInlineRateLimitBucket': {
        const key = laneKey(change.tokenAddress, change.remoteChainSelector)
        const record = tokenOf(change.tokenAddress).inline.rateLimit.find(
          (r) => laneKey(r.tokenAddress, r.remoteChainSelector) === key,
        )
        if (record) record.rateLimits[change.bucket] = structuredClone(change.config)
        break
      }
      case 'setPolicyRateLimitBucket': {
        const key = recordKey(change.policyName, change.remoteChainSelector, param)
        const record = next.policies.rateLimit.find(
          (r) => recordKey(r.policyName, r.remoteChainSelector, param) === key,
        )
        if (record) record.rateLimits[change.bucket] = structuredClone(change.config)
        break
      }
      case 'setGlobalPause':
        next.isGloballyPaused = change.paused
        break
      case 'setChainPause': {
        let pause = next.chainPauses.find(
          (p) => p.remoteChainSelector === change.remoteChainSelector,
        )
        if (!pause)
          next.chainPauses.push(
            (pause = {
              remoteChainSelector: change.remoteChainSelector,
              outbound: false,
              inbound: false,
            }),
          )
        if (change.outbound !== undefined) pause.outbound = change.outbound
        if (change.inbound !== undefined) pause.inbound = change.inbound
        break
      }
      case 'setTokenPause': {
        const token = tokenOf(change.tokenAddress)
        if (change.outbound !== undefined) token.isOutboundPaused = change.outbound
        if (change.inbound !== undefined) token.isInboundPaused = change.inbound
        break
      }
    }
  })
  return next
}

// ─── Resolve ────────────────────────────────────────────────────────────────────────────────

/** Lookup tables over a state, built once per resolution. */
type Index = {
  token: (address: string) => MultiTokenPoolTokenRecords
  inline: <T extends LaneRecordType>(
    type: T,
    token: string,
    chain: bigint,
  ) => MultiTokenPoolInlineRecord[T] | undefined
  policy: <T extends LaneRecordType>(
    type: T,
    name: PolicyName,
    chain: bigint,
  ) =>
    | (T extends 'connection'
        ? MultiTokenPoolConnectionPolicyRecordState
        : MultiTokenPoolPolicyRecord[T])
    | undefined
  provider: (name: PolicyName) => string | undefined
  answer: (
    provider: string,
    token: string,
    chain: bigint,
  ) => MultiTokenPoolProviderAnswer | undefined
  chainPause: (chain: bigint) => { outbound: boolean; inbound: boolean }
  isGloballyPaused: boolean
}

function indexState(state: MultiTokenPoolRecordState): Index {
  const tokens = new Map(state.tokens.map((t) => [getAddress(t.tokenAddress), t]))
  const inline = new Map<string, unknown>()
  for (const t of state.tokens)
    for (const type of LANE_RECORD_TYPES)
      for (const r of t.inline[type])
        inline.set(`${type}:${laneKey(r.tokenAddress, r.remoteChainSelector)}`, r)
  const policies = new Map<string, unknown>()
  for (const type of LANE_RECORD_TYPES)
    for (const r of state.policies[type])
      policies.set(
        `${type}:${recordKey(r.policyName, r.remoteChainSelector, `state.policies.${type}`)}`,
        r,
      )
  const providers = new Map(
    state.policies.remoteTokenAddressProviders.map((p) => [
      policyKey(p.policyName, 'state.policies.remoteTokenAddressProviders'),
      getAddress(p.provider),
    ]),
  )
  const answers = new Map(
    state.providerAnswers.map((a) => [
      answerKey(a.provider, a.tokenAddress, a.remoteChainSelector),
      a,
    ]),
  )
  const pauses = new Map(state.chainPauses.map((p) => [p.remoteChainSelector, p]))
  return {
    token: (a) => tokens.get(getAddress(a)) ?? emptyToken(a),
    inline: (type, token, chain) => inline.get(`${type}:${laneKey(token, chain)}`) as never,
    policy: (type, name, chain) =>
      policies.get(`${type}:${recordKey(name, chain, `state.tokens.policies.${type}`)}`) as never,
    provider: (name) => providers.get(policyKey(name, 'state.tokens.policies.connection')),
    answer: (provider, token, chain) => answers.get(answerKey(provider, token, chain)),
    chainPause: (chain) => pauses.get(chain) ?? { outbound: false, inbound: false },
    isGloballyPaused: state.isGloballyPaused,
  }
}

/** `PolicyConfig._resolvePolicyRecordLevel` plus the inline check, for one record type. */
function resolveLevel<T extends LaneRecordType>(
  index: Index,
  type: T,
  tokenAddress: string,
  chain: bigint,
): {
  level: MultiTokenPoolRecordLevel
  record?: MultiTokenPoolInlineRecord[T] | MultiTokenPoolPolicyRecord[T]
} {
  if (chain === 0n) return { level: 'none' }
  const own = index.inline(type, tokenAddress, chain)
  if (own) return { level: 'inline', record: own }
  const name = index.token(tokenAddress).policies[type]
  if (name === null) return { level: 'none' }
  const forChain = index.policy(type, name, chain)
  if (forChain) {
    // a connection record allows only its subset tokens while `onlySubsetTokens` is set
    if (type === 'connection') {
      const c = forChain as MultiTokenPoolConnectionPolicyRecordState
      if (
        c.onlySubsetTokens &&
        !c.subsetTokens.some((t) => getAddress(t) === getAddress(tokenAddress))
      )
        return { level: 'none' }
    }
    return { level: 'policy-chain', record: forChain as MultiTokenPoolPolicyRecord[T] }
  }
  if (!HAS_DEFAULT.has(type)) return { level: 'none' }
  const fallback = index.policy(type, name, 0n)
  return fallback
    ? { level: 'policy-default', record: fallback as MultiTokenPoolPolicyRecord[T] }
    : { level: 'none' }
}

function resolveLane(
  index: Index,
  { tokenAddress, remoteChainSelector }: MultiTokenPoolLaneKey,
): ProjectedMultiTokenPoolLane {
  const token = index.token(tokenAddress)
  const tokenAddr = getAddress(tokenAddress)
  const chainPause = index.chainPause(remoteChainSelector)
  const resolved = Object.fromEntries(
    LANE_RECORD_TYPES.map((type) => [
      type,
      resolveLevel(index, type, tokenAddr, remoteChainSelector),
    ]),
  ) as { [T in LaneRecordType]: ReturnType<typeof resolveLevel<T>> }
  const levels = Object.fromEntries(
    LANE_RECORD_TYPES.map((type) => [type, resolved[type].level]),
  ) as Record<LaneRecordType, MultiTokenPoolRecordLevel>
  // remote pool levels never use a default; an inline record reports 'inline' even when it trusts
  // policy pools
  const hasConnection = levels.connection !== 'none'

  const connection: MultiTokenPoolLaneConnection = {
    hasConnection,
    isGloballyPaused: index.isGloballyPaused,
    isTokenOutboundPaused: token.isOutboundPaused,
    isTokenInboundPaused: token.isInboundPaused,
    isChainOutboundPaused: chainPause.outbound,
    isChainInboundPaused: chainPause.inbound,
    isOutboundPaused: false,
    isInboundPaused: false,
    poolDataFormat: 'long',
    remoteToken: null,
    remotePools: [],
  }
  connection.isOutboundPaused =
    connection.isGloballyPaused ||
    connection.isTokenOutboundPaused ||
    connection.isChainOutboundPaused
  connection.isInboundPaused =
    connection.isGloballyPaused ||
    connection.isTokenInboundPaused ||
    connection.isChainInboundPaused

  if (hasConnection) {
    if (levels.connection === 'inline') {
      connection.remoteToken = (resolved.connection.record as InlineConnectionConfig).remoteToken
    } else {
      const provider = index.provider(token.policies.connection!)
      if (provider !== undefined) {
        const answer = index.answer(provider, tokenAddr, remoteChainSelector)
        if (!answer)
          throw new CCTParamsInvalidError(
            OPERATION,
            'state.providerAnswers',
            `has no answer of provider ${provider} for token ${tokenAddr} on chain ${remoteChainSelector}; read it first (requiredMultiTokenPoolProviderAnswers lists them)`,
          )
        connection.remoteToken = answer.remoteToken
      }
    }
    const own = index.inline('remotePool', tokenAddr, remoteChainSelector)
    if (own) {
      connection.poolDataFormat = own.poolDataFormat
      connection.remotePools = own.remotePools.map((p) => ({ ...p }))
    }
    if (!own || own.trustPolicyRemotePools) {
      const name = token.policies.remotePool
      const policy =
        name === null ? undefined : index.policy('remotePool', name, remoteChainSelector)
      if (policy) {
        const listed = new Set(connection.remotePools.map((p) => p.address))
        for (const address of policy.remotePoolAddresses)
          if (!listed.has(address))
            connection.remotePools.push({ address, allowLegacyPoolData: false })
      }
    }
  }

  const fee = resolved.fee.record as InlineFeeConfig | FeePolicyRecord | undefined
  const overhead = resolved.destOverhead.record as
    | InlineDestOverheadConfig
    | DestOverheadPolicyRecord
    | undefined
  const rateLimit = resolved.rateLimit.record as
    | InlineRateLimitConfig
    | RateLimitPolicyRecord
    | undefined
  const security = resolved.security.record as
    | InlineSecurityConfig
    | SecurityPolicyRecord
    | undefined
  return {
    tokenAddress: tokenAddr,
    remoteChainSelector,
    connection,
    levels,
    // the PCM zeroes the other stores' views for a lane without a connection
    tokenTransferFeeConfig:
      hasConnection && fee && overhead
        ? { ...overhead.destOverheadConfig, ...fee.feeConfig, isEnabled: true }
        : { ...DISABLED_FEE },
    rateLimits: hasConnection && rateLimit ? structuredClone(rateLimit.rateLimits) : null,
    verification:
      hasConnection && security
        ? {
            hook: security.securityConfig.hook,
            outboundCCVs: [...security.securityConfig.outboundCCVs],
            inboundCCVs: [...security.securityConfig.inboundCCVs],
          }
        : { hook: null, outboundCCVs: [], inboundCCVs: [] },
  }
}

/**
 * Resolves lanes as the PCM's views would, from stored records.
 *
 * @param state - The records (typically {@link applyMultiTokenPoolRecordChanges} output).
 * @param lanes - The lanes; a lane with no records resolves as closed.
 * @returns One projected lane per input lane, in order.
 * @throws {@link CCTParamsInvalidError} if a policy-resolved lane's provider answer is missing from
 * `state.providerAnswers`, or a policy name is malformed
 * @internal
 */
export function resolveMultiTokenPoolLanes(
  state: MultiTokenPoolRecordState,
  lanes: readonly MultiTokenPoolLaneKey[],
): ProjectedMultiTokenPoolLane[] {
  const index = indexState(state)
  return lanes.map((lane) => resolveLane(index, lane))
}

/**
 * The chains a token has a connection to, as `getTokenConfigBatch` lists them: inline connection
 * chains first, then the policy chains the token resolves (subset included), each once.
 * @internal
 */
export function multiTokenPoolSupportedChains(
  state: MultiTokenPoolRecordState,
  tokenAddress: string,
): bigint[] {
  const index = indexState(state)
  const token = index.token(tokenAddress)
  const inlineChains = token.inline.connection.map((r) => r.remoteChainSelector)
  const name = token.policies.connection
  const policyChains =
    name === null
      ? []
      : state.policies.connection
          .filter(
            (r) =>
              policyKey(r.policyName, 'state.policies.connection') ===
                policyKey(name, 'state.tokens.policies.connection') &&
              !inlineChains.includes(r.remoteChainSelector) &&
              resolveLevel(index, 'connection', tokenAddress, r.remoteChainSelector).level ===
                'policy-chain',
          )
          .map((r) => r.remoteChainSelector)
  return [...inlineChains, ...policyChains]
}

/**
 * The provider answers {@link resolveMultiTokenPoolLanes} needs for `lanes`: every lane whose
 * connection resolves from a policy with a provider. Read each with `getRemoteTokenAddress`.
 * @internal
 */
export function requiredMultiTokenPoolProviderAnswers(
  state: MultiTokenPoolRecordState,
  lanes: readonly MultiTokenPoolLaneKey[],
): (MultiTokenPoolLaneKey & { provider: string })[] {
  const index = indexState(state)
  const needed = new Map<string, MultiTokenPoolLaneKey & { provider: string }>()
  for (const { tokenAddress, remoteChainSelector } of lanes) {
    if (
      resolveLevel(index, 'connection', tokenAddress, remoteChainSelector).level !== 'policy-chain'
    )
      continue
    const provider = index.provider(index.token(tokenAddress).policies.connection!)
    if (provider === undefined) continue
    const key = answerKey(provider, tokenAddress, remoteChainSelector)
    if (!index.answer(provider, tokenAddress, remoteChainSelector) && !needed.has(key))
      needed.set(key, { provider, tokenAddress: getAddress(tokenAddress), remoteChainSelector })
  }
  return [...needed.values()]
}
