/**
 * getMultiTokenPoolRemotePoolPolicy — a remote pool policy and its records.
 *
 * @packageDocumentation
 */

import type { PoolConfigManagerReader } from '../contracts.ts'
import { POLICY_RECORD_READERS } from '../record-reads.ts'
import type { RemotePoolPolicyRecord } from '../records.ts'
import {
  type GetMultiTokenPoolPolicyParams,
  type MultiTokenPoolPolicyIdentity,
  type ParsedPolicyParams,
  type PolicyReadContext,
  type PolicyRecords,
  PolicyQuery,
} from './policy-query.ts'

/** Result of `getMultiTokenPoolRemotePoolPolicy`. */
export type GetMultiTokenPoolRemotePoolPolicyResult = MultiTokenPoolPolicyIdentity & {
  /** Number of tokens assigned to the policy: the blast radius of a write to it. */
  tokenCount: number
  /** The policy's records, one per chain. */
  records: RemotePoolPolicyRecord[]
}

/**
 * Reads a remote pool policy and its records.
 * @remarks `tokenCount` is the blast radius of a write to it. An unknown policy reads `exists: false` and no record.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC)
 * @throws {@link CCTContractTypeInvalidError} if the target is not a PCM, or `poolAddress` is not
 * a multi-token pool
 */
export class GetMultiTokenPoolRemotePoolPolicy extends PolicyQuery<
  GetMultiTokenPoolPolicyParams,
  PolicyRecords<GetMultiTokenPoolRemotePoolPolicyResult>
> {
  readonly name = 'getMultiTokenPoolRemotePoolPolicy'
  protected readonly recordType = 'remotePool'

  protected async readPolicy(
    pcm: PoolConfigManagerReader,
    { policyWord }: ParsedPolicyParams<GetMultiTokenPoolPolicyParams>,
    { blockTag }: PolicyReadContext,
  ): Promise<PolicyRecords<GetMultiTokenPoolRemotePoolPolicyResult>> {
    return POLICY_RECORD_READERS.remotePool(pcm, policyWord, { blockTag })
  }
}
