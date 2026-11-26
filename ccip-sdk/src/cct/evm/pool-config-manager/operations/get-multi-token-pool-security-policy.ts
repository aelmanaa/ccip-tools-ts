/**
 * getMultiTokenPoolSecurityPolicy — a security policy and its records.
 *
 * @packageDocumentation
 */

import { resultToObject } from '../../../../evm/types.ts'
import type { PoolConfigManagerReader } from '../contracts.ts'
import { decodePolicyRecordKey, decodeSecurityConfig } from '../decode.ts'
import type { SecurityPolicyRecord } from '../records.ts'
import {
  type GetMultiTokenPoolPolicyParams,
  type MultiTokenPoolPolicyIdentity,
  type ParsedPolicyParams,
  type PolicyReadContext,
  type PolicyRecords,
  PolicyQuery,
} from './policy-query.ts'

/** Result of `getMultiTokenPoolSecurityPolicy`. */
export type GetMultiTokenPoolSecurityPolicyResult = MultiTokenPoolPolicyIdentity & {
  /** Number of tokens assigned to the policy: the blast radius of a write to it. */
  tokenCount: number
  /** The policy's records; chain `0n` is the default. */
  records: SecurityPolicyRecord[]
}

/**
 * Reads a security policy and its records.
 * @remarks `tokenCount` is the blast radius of a write to it. An unknown policy reads `exists: false` and no record.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC)
 * @throws {@link CCTContractTypeInvalidError} if the target is not a PCM, or `poolAddress` is not
 * a multi-token pool
 */
export class GetMultiTokenPoolSecurityPolicy extends PolicyQuery<
  GetMultiTokenPoolPolicyParams,
  PolicyRecords<GetMultiTokenPoolSecurityPolicyResult>
> {
  readonly name = 'getMultiTokenPoolSecurityPolicy'
  protected readonly recordType = 'security'

  protected async readPolicy(
    pcm: PoolConfigManagerReader,
    { policyWord }: ParsedPolicyParams<GetMultiTokenPoolPolicyParams>,
    { blockTag }: PolicyReadContext,
  ): Promise<PolicyRecords<GetMultiTokenPoolSecurityPolicyResult>> {
    const [tokenCount, records] = await pcm.getSecurityPolicy(policyWord, { blockTag })
    return {
      tokenCount: Number(tokenCount),
      records: records.map((raw) => {
        const r = resultToObject(raw)
        return {
          ...decodePolicyRecordKey(r),
          securityConfig: decodeSecurityConfig(r.securityConfig),
        }
      }),
    }
  }
}
