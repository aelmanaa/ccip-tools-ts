/**
 * getMultiTokenPoolRateLimitPolicy — a rate limit policy and its records.
 *
 * @packageDocumentation
 */

import { resultToObject } from '../../../../evm/types.ts'
import type { PoolConfigManagerReader } from '../contracts.ts'
import { decodePolicyRecordKey, decodeRateLimits } from '../decode.ts'
import type { RateLimitPolicyRecord } from '../records.ts'
import {
  type GetMultiTokenPoolPolicyParams,
  type MultiTokenPoolPolicyIdentity,
  type ParsedPolicyParams,
  type PolicyReadContext,
  type PolicyRecords,
  PolicyQuery,
} from './policy-query.ts'

/** Result of `getMultiTokenPoolRateLimitPolicy`. */
export type GetMultiTokenPoolRateLimitPolicyResult = MultiTokenPoolPolicyIdentity & {
  /** Number of tokens assigned to the policy: the blast radius of a write to it. */
  tokenCount: number
  /** Decimals the policy's amounts are in, or `null` before its first record. */
  localDecimals: number | null
  /** The policy's records; chain `0n` is the default. */
  records: RateLimitPolicyRecord[]
}

/**
 * Reads a rate limit policy and its records.
 * @remarks `tokenCount` is the blast radius of a write to it. An unknown policy reads `exists: false` and no record.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC)
 * @throws {@link CCTContractTypeInvalidError} if the target is not a PCM, or `poolAddress` is not
 * a multi-token pool
 */
export class GetMultiTokenPoolRateLimitPolicy extends PolicyQuery<
  GetMultiTokenPoolPolicyParams,
  PolicyRecords<GetMultiTokenPoolRateLimitPolicyResult>
> {
  readonly name = 'getMultiTokenPoolRateLimitPolicy'
  protected readonly recordType = 'rateLimit'

  protected async readPolicy(
    pcm: PoolConfigManagerReader,
    { policyWord }: ParsedPolicyParams<GetMultiTokenPoolPolicyParams>,
    { blockTag }: PolicyReadContext,
  ): Promise<PolicyRecords<GetMultiTokenPoolRateLimitPolicyResult>> {
    const [tokenCount, decimals, records] = await pcm.getRateLimitPolicy(policyWord, { blockTag })
    const decoded = records.map((raw) => {
      const r = resultToObject(raw)
      return {
        ...decodePolicyRecordKey(r),
        localDecimals: Number(r.localDecimals),
        rateLimits: decodeRateLimits(r.rateLimitConfig),
      }
    })
    return {
      tokenCount: Number(tokenCount),
      // the policy's decimals are fixed by its first record; `0` with no record means unset
      localDecimals: decoded.length ? Number(decimals) : null,
      records: decoded,
    }
  }
}
