/**
 * Decodes a PoolConfigManager write (its exact calldata) into the projection's record changes, so
 * the post-state guards judge what will execute, whichever op or tool built it.
 *
 * @packageDocumentation
 */

import { type Result, getAddress } from 'ethers'

import type { LaneRecordType } from '../../../chain.ts'
import {
  type DecodedTokenProfile,
  decodeTokenProfileFields,
} from '../../../evm/multi-token-pool.ts'
import { resultToObject } from '../../../evm/types.ts'
import { CCTParamsInvalidError } from '../../errors.ts'
import {
  type MultiTokenPoolVersion,
  MULTI_TOKEN_POOL_OPERATIONS,
  POOL_CONFIG_MANAGER_TYPE,
  getMultiTokenPoolInterface,
  nullableAddress,
} from '../multi-token-pool/contracts.ts'
import { fromAbiRateLimitConfig } from '../token-pool/rate-limit.ts'
import { decodePolicyName, policyNameOf } from './contracts.ts'
import {
  INLINE_RECORD_DECODERS,
  POLICY_RECORD_DECODERS,
  decodeInlineKey,
  decodePolicyRecordKey,
} from './decode.ts'
import {
  type MultiTokenPoolRateLimitBucket,
  type MultiTokenPoolRecordChange,
  MESSAGE_DIRECTIONS,
  rateLimitBucketOf,
} from './projection.ts'

const OPERATION = 'decodeMultiTokenPoolWrite'

/** A token profile a `applyTokenProfileUpdates` call sets: the shared profile decode, keyed by token. @internal */
export type DecodedTokenProfileUpdate = DecodedTokenProfile & {
  /** The token. */
  tokenAddress: string
}

/** A decoded PCM write. @internal */
export type DecodedMultiTokenPoolWrite = {
  /** The PCM function called. */
  functionName: string
  /** Its effect on the stored records, in the order the stores apply it (removals first). */
  changes: MultiTokenPoolRecordChange[]
  /** `applyTokenProfileUpdates`: the tokens removed, then the profiles set. */
  profiles?: { remove: string[]; set: DecodedTokenProfileUpdate[] }
}

const policy = (word: unknown) => policyNameOf(String(word))
const keys = (list: Result) => list.map((r) => resultToObject(r) as Record<string, unknown>)

/** `PauseDirection` (Outbound, Inbound, Both) to the directions it sets. */
function pauseFlags(
  direction: unknown,
  paused: boolean,
): { outbound?: boolean; inbound?: boolean } {
  const d = Number(direction)
  return {
    ...(d !== 1 && { outbound: paused }),
    ...(d !== 0 && { inbound: paused }),
  }
}

/** `MessageDirection` (Outbound, Inbound) and `fastFinality` to a bucket name. */
function bucketOf(direction: unknown, fastFinality: unknown): MultiTokenPoolRateLimitBucket {
  return rateLimitBucketOf(MESSAGE_DIRECTIONS[Number(direction)] ?? 'outbound', !!fastFinality)
}

/** `apply<Type>PolicyConfigUpdates(toRemove, policiesToRemove, toSet)`: removals, then sets. */
function policyConfigChanges(type: LaneRecordType, args: Result): MultiTokenPoolRecordChange[] {
  const decodeSet = (raw: Record<string, unknown>) =>
    ({
      kind: 'setPolicyRecord',
      type,
      // the PCM takes the same structs its policy views return
      record: POLICY_RECORD_DECODERS[type](raw as never),
    }) as MultiTokenPoolRecordChange
  return [
    ...keys(args[0] as Result).map((r): MultiTokenPoolRecordChange => ({
      kind: 'removePolicyRecord',
      type,
      ...decodePolicyRecordKey(r as never),
    })),
    ...(args[1] as Result).map((word): MultiTokenPoolRecordChange => ({
      kind: 'removePolicy',
      type,
      policyName: policy(word),
    })),
    ...keys(args[2] as Result).map(decodeSet),
  ]
}

/** `applyInline<Type>ConfigUpdates(toRemove, toSet)`: removals, then sets. */
function inlineConfigChanges(type: LaneRecordType, args: Result): MultiTokenPoolRecordChange[] {
  const decodeSet = (raw: Record<string, unknown>) =>
    ({
      kind: 'setInline',
      type,
      // the PCM takes the same structs its inline views return
      record: INLINE_RECORD_DECODERS[type](raw as never),
    }) as MultiTokenPoolRecordChange
  return [
    ...keys(args[0] as Result).map((r): MultiTokenPoolRecordChange => ({
      kind: 'removeInline',
      type,
      ...decodeInlineKey(r as never),
    })),
    ...keys(args[1] as Result).map(decodeSet),
  ]
}

/**
 * PCM functions that change no lane record: roles, the default admin, fee withdrawal, and the
 * pool-only callbacks. Every other state-changing function is decoded, or refused.
 * @internal
 */
export const NO_RECORD_CHANGE_FUNCTIONS: ReadonlySet<string> = new Set([
  'acceptDefaultAdminTransfer',
  'beginDefaultAdminTransfer',
  'cancelDefaultAdminTransfer',
  'changeDefaultAdminDelay',
  'grantRole',
  'renounceRole',
  'revokeRole',
  'rollbackDefaultAdminDelay',
  'withdrawFeeTokens',
  // called by the pool on every transfer; they move rate limit buckets, not records
  'validateLockOrBurn',
  'validateReleaseOrMint',
])

/** The record type of each assignment function: the op map's `functions`, inverted. */
const TOKEN_POLICY_FUNCTIONS: Record<string, LaneRecordType> = Object.fromEntries(
  Object.entries(MULTI_TOKEN_POOL_OPERATIONS.applyMultiTokenPoolTokenPolicyUpdates.functions).map(
    ([type, fn]) => [fn, type as LaneRecordType],
  ),
)

/**
 * Decodes PCM calldata into record changes.
 *
 * @param data - The calldata sent to the PCM.
 * @param version - The PCM's version.
 * @returns The function and its changes; functions that change no lane record (roles, admin, fee
 *   withdrawal) decode with no changes.
 * @throws {@link CCTParamsInvalidError} if the calldata is not a PCM function call
 * @internal
 */
export function decodeMultiTokenPoolWrite(
  data: string,
  version: MultiTokenPoolVersion,
): DecodedMultiTokenPoolWrite {
  const iface = getMultiTokenPoolInterface(POOL_CONFIG_MANAGER_TYPE, version)
  let parsed
  try {
    parsed = iface.parseTransaction({ data })
  } catch {
    parsed = null
  }
  if (!parsed)
    throw new CCTParamsInvalidError(OPERATION, 'data', 'is not a PoolConfigManager function call')
  const { name, args } = parsed
  const done = (changes: MultiTokenPoolRecordChange[]): DecodedMultiTokenPoolWrite => ({
    functionName: name,
    changes,
  })

  const tokenType = TOKEN_POLICY_FUNCTIONS[name]
  if (tokenType)
    return done(
      keys(args[0] as Result).map((r) => ({
        kind: 'assignPolicy',
        type: tokenType,
        tokenAddress: getAddress(String(r.localToken)),
        policyName: decodePolicyName(String(r.policyName)),
      })),
    )

  switch (name) {
    case 'applyInlineConnectionConfigUpdates':
      return done(inlineConfigChanges('connection', args))
    case 'applyInlineRemotePoolConfigUpdates':
      return done(inlineConfigChanges('remotePool', args))
    case 'applyInlineRateLimitConfigUpdates':
      return done(inlineConfigChanges('rateLimit', args))
    case 'applyInlineFeeConfigUpdates':
      return done(inlineConfigChanges('fee', args))
    case 'applyInlineDestOverheadConfigUpdates':
      return done(inlineConfigChanges('destOverhead', args))
    case 'applyInlineSecurityConfigUpdates':
      return done(inlineConfigChanges('security', args))
    case 'applyInlineRateLimitBucketUpdates':
      return done(
        keys(args[0] as Result).map((r) => ({
          kind: 'setInlineRateLimitBucket',
          ...decodeInlineKey(r as never),
          bucket: bucketOf(r.direction, r.fastFinality),
          config: fromAbiRateLimitConfig(r.config as never),
        })),
      )
    case 'applyConnectionPolicyConfigUpdates':
      return done(policyConfigChanges('connection', args))
    case 'applyRemotePoolPolicyConfigUpdates':
      return done(policyConfigChanges('remotePool', args))
    case 'applyRateLimitPolicyConfigUpdates':
      return done(policyConfigChanges('rateLimit', args))
    case 'applyFeePolicyConfigUpdates':
      return done(policyConfigChanges('fee', args))
    case 'applyDestOverheadPolicyConfigUpdates':
      return done(policyConfigChanges('destOverhead', args))
    case 'applySecurityPolicyConfigUpdates':
      return done(policyConfigChanges('security', args))
    case 'applyRateLimitPolicyBucketUpdates':
      return done(
        keys(args[0] as Result).map((r) => ({
          kind: 'setPolicyRateLimitBucket',
          ...decodePolicyRecordKey(r as never),
          bucket: bucketOf(r.direction, r.fastFinality),
          config: fromAbiRateLimitConfig(r.config as never),
        })),
      )
    case 'applySubsetTokenUpdates': {
      // the store applies every removal, then every addition
      const entries = (list: Result, side: 'add' | 'remove') =>
        keys(list).map((r): MultiTokenPoolRecordChange => ({
          kind: 'updateSubsetTokens',
          ...decodePolicyRecordKey(r as never),
          [side]: [getAddress(String(r.localToken))],
        }))
      return done([...entries(args[0] as Result, 'remove'), ...entries(args[1] as Result, 'add')])
    }
    case 'applyRemoteTokenAddressProviderUpdates':
      return done(
        keys(args[0] as Result).map((r) => ({
          kind: 'setRemoteTokenAddressProvider',
          policyName: policy(r.policyName),
          provider: nullableAddress(String(r.remoteTokenAddressProvider)),
        })),
      )
    case 'pauseGlobally':
    case 'unpauseGlobally':
      return done([{ kind: 'setGlobalPause', paused: name === 'pauseGlobally' }])
    case 'pauseChains':
    case 'unpauseChains':
      return done(
        (args[0] as Result).map((c) => ({
          kind: 'setChainPause',
          remoteChainSelector: BigInt(c),
          ...pauseFlags(args[1], name === 'pauseChains'),
        })),
      )
    case 'pauseTokens':
    case 'unpauseTokens':
      return done(
        (args[0] as Result).map((t) => ({
          kind: 'setTokenPause',
          tokenAddress: getAddress(String(t)),
          ...pauseFlags(args[1], name === 'pauseTokens'),
        })),
      )
    case 'applyTokenProfileUpdates':
      return {
        functionName: name,
        changes: [],
        profiles: {
          remove: (args[0] as Result).map((t) => getAddress(String(t))),
          set: keys(args[1] as Result).map((r) => ({
            tokenAddress: getAddress(String(r.localToken)),
            ...decodeTokenProfileFields(r as Parameters<typeof decodeTokenProfileFields>[0]),
          })),
        },
      }
    default:
      if (NO_RECORD_CHANGE_FUNCTIONS.has(name)) return done([])
      // a function this SDK does not know may change records: never judge it as a no-op
      throw new CCTParamsInvalidError(
        OPERATION,
        'data',
        `calls PoolConfigManager.${name}, which this SDK cannot project; it cannot be guarded`,
      )
  }
}
