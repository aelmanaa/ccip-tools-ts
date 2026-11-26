/**
 * getMultiTokenPoolConnectionPolicy — a connection policy and its records.
 *
 * @packageDocumentation
 */

import type { PoolConfigManagerReader } from '../contracts.ts'
import { POLICY_RECORD_READERS } from '../record-reads.ts'
import type { ConnectionPolicyRecord } from '../records.ts'
import {
  type GetMultiTokenPoolPolicyParams,
  type MultiTokenPoolPolicyIdentity,
  type ParsedPolicyParams,
  type PolicyReadContext,
  type PolicyRecords,
  PolicyQuery,
} from './policy-query.ts'

/** Result of `getMultiTokenPoolConnectionPolicy`. */
export type GetMultiTokenPoolConnectionPolicyResult = MultiTokenPoolPolicyIdentity & {
  /** Number of tokens assigned to the policy: the blast radius of a write to it. */
  tokenCount: number
  /** Provider that answers each token's remote token, or `null` (each token needs an inline connection record). */
  remoteTokenAddressProvider: string | null
  /** The policy's records, one per chain. */
  records: ConnectionPolicyRecord[]
}

/**
 * Reads a connection policy and its records.
 * @remarks `tokenCount` is the blast radius of a write to it. An unknown policy reads `exists: false` and no record.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC)
 * @throws {@link CCTContractTypeInvalidError} if the target is not a PCM, or `poolAddress` is not
 * a multi-token pool
 */
export class GetMultiTokenPoolConnectionPolicy extends PolicyQuery<
  GetMultiTokenPoolPolicyParams,
  PolicyRecords<GetMultiTokenPoolConnectionPolicyResult>
> {
  readonly name = 'getMultiTokenPoolConnectionPolicy'
  protected readonly recordType = 'connection'

  protected async readPolicy(
    pcm: PoolConfigManagerReader,
    { policyWord }: ParsedPolicyParams<GetMultiTokenPoolPolicyParams>,
    { blockTag }: PolicyReadContext,
  ): Promise<PolicyRecords<GetMultiTokenPoolConnectionPolicyResult>> {
    return POLICY_RECORD_READERS.connection(pcm, policyWord, { blockTag })
  }
}
