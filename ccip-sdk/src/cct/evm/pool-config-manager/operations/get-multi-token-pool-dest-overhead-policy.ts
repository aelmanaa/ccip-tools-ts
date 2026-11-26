/**
 * getMultiTokenPoolDestOverheadPolicy — a destination overhead policy and its records.
 *
 * @packageDocumentation
 */

import type { PoolConfigManagerReader } from '../contracts.ts'
import { POLICY_RECORD_READERS } from '../record-reads.ts'
import type { DestOverheadPolicyRecord } from '../records.ts'
import {
  type GetMultiTokenPoolPolicyParams,
  type MultiTokenPoolPolicyIdentity,
  type ParsedPolicyParams,
  type PolicyReadContext,
  type PolicyRecords,
  PolicyQuery,
} from './policy-query.ts'

/** Result of `getMultiTokenPoolDestOverheadPolicy`. */
export type GetMultiTokenPoolDestOverheadPolicyResult = MultiTokenPoolPolicyIdentity & {
  /** Number of tokens assigned to the policy: the blast radius of a write to it. */
  tokenCount: number
  /** The policy's records; chain `0n` is the default. */
  records: DestOverheadPolicyRecord[]
}

/**
 * Reads a destination overhead policy and its records.
 * @remarks `tokenCount` is the blast radius of a write to it. An unknown policy reads `exists: false` and no record.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC)
 * @throws {@link CCTContractTypeInvalidError} if the target is not a PCM, or `poolAddress` is not
 * a multi-token pool
 */
export class GetMultiTokenPoolDestOverheadPolicy extends PolicyQuery<
  GetMultiTokenPoolPolicyParams,
  PolicyRecords<GetMultiTokenPoolDestOverheadPolicyResult>
> {
  readonly name = 'getMultiTokenPoolDestOverheadPolicy'
  protected readonly recordType = 'destOverhead'

  protected async readPolicy(
    pcm: PoolConfigManagerReader,
    { policyWord }: ParsedPolicyParams<GetMultiTokenPoolPolicyParams>,
    { blockTag }: PolicyReadContext,
  ): Promise<PolicyRecords<GetMultiTokenPoolDestOverheadPolicyResult>> {
    return POLICY_RECORD_READERS.destOverhead(pcm, policyWord, { blockTag })
  }
}
