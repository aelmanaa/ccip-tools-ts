/**
 * applyMultiTokenPoolTokenPolicyUpdates — assigns tokens to a policy of one record type, or clears
 * the assignment, through the matching `applyToken<Type>PolicyUpdates`.
 *
 * @packageDocumentation
 */

import { ZeroHash, getAddress } from 'ethers'

import type { LaneRecordType } from '../../../../chain.ts'
import type { EVMChain } from '../../../../evm/index.ts'
import { LANE_RECORD_TYPES } from '../../../../evm/multi-token-pool.ts'
import { resultToObject } from '../../../../evm/types.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import {
  type PoolConfigManagerRole,
  MULTI_TOKEN_POOL_OPERATIONS,
  POOL_CONFIG_MANAGER_TYPE,
  TOKEN_POLICY_ROLES,
  getMultiTokenPoolInterface,
  poolConfigManagerContract,
} from '../../multi-token-pool/contracts.ts'
import { validateAddress, validateArray, validateOneOf } from '../../validate.ts'
import { type PolicyName, encodePolicyName } from '../contracts.ts'
import { decodeTokenPolicies } from '../decode.ts'
import {
  type MultiTokenPoolWriteGuards,
  type PoolConfigManagerWrite,
  type PoolConfigManagerWriteContext,
  type PoolConfigManagerWriteParams,
  PoolConfigManagerWriteOperation,
} from '../write-operation.ts'

/** One policy assignment. */
export type TokenPolicyAssignment = {
  /** The token. */
  tokenAddress: string
  /** The policy to assign, or `null` to clear the token's assignment of this type. */
  policyName: PolicyName | null
}

/** Parameters of `applyMultiTokenPoolTokenPolicyUpdates`. */
export type ApplyMultiTokenPoolTokenPolicyUpdatesParams = PoolConfigManagerWriteParams &
  MultiTokenPoolWriteGuards & {
    /** The record type whose policy the assignments set: one of `LANE_RECORD_TYPES`. */
    recordType: LaneRecordType
    /** The assignments, at least one; each token at most once. */
    assignments: TokenPolicyAssignment[]
  }

/**
 * Assigns tokens to a policy of one record type.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), `sender` lacks the
 *   gate, or a guard refuses the state after the write (`context.recordType` set)
 * @throws {@link CCTContractTypeInvalidError} if the target is not a PoolConfigManager or a
 *   multi-token pool
 * @throws {@link CCTContractVersionUnsupportedError} if a version is unknown
 * @throws {@link CCTStateChangedError} if `expectedSnapshot` was given and the state moved
 */
export class ApplyMultiTokenPoolTokenPolicyUpdates extends PoolConfigManagerWriteOperation<ApplyMultiTokenPoolTokenPolicyUpdatesParams> {
  readonly name = 'applyMultiTokenPoolTokenPolicyUpdates'

  protected override prepare(
    params: ApplyMultiTokenPoolTokenPolicyUpdatesParams,
  ): ApplyMultiTokenPoolTokenPolicyUpdatesParams {
    super.prepare(params)
    // a closed union: JS callers get the same refusal the types give
    validateOneOf(this.name, 'recordType', params.recordType, LANE_RECORD_TYPES)
    validateArray(this.name, 'assignments', params.assignments, 1)
    const seen = new Set<string>()
    Array.from(params.assignments, (a, i) => {
      validateAddress(
        this.name,
        `assignments[${i}].tokenAddress`,
        (a as TokenPolicyAssignment | undefined)?.tokenAddress,
      )
      if (a.policyName !== null)
        encodePolicyName(this.name, `assignments[${i}].policyName`, a.policyName)
      const token = getAddress(a.tokenAddress)
      if (seen.has(token))
        throw new CCTParamsInvalidError(
          this.name,
          `assignments[${i}].tokenAddress`,
          `assigns ${token} twice: the result would depend on order; give each token once`,
          { context: { recordType: params.recordType } },
        )
      seen.add(token)
    })
    return params
  }

  protected gate({
    recordType,
  }: ApplyMultiTokenPoolTokenPolicyUpdatesParams): readonly PoolConfigManagerRole[] {
    return ['CONFIG_ROLE', 'TOKEN_MANAGER_ROLE', TOKEN_POLICY_ROLES[recordType]]
  }

  /** Every refusal names the record type. */
  protected override errorContext({
    recordType,
  }: ApplyMultiTokenPoolTokenPolicyUpdatesParams): Record<string, unknown> {
    return { recordType }
  }

  protected async encode(
    chain: EVMChain,
    { recordType, assignments }: ApplyMultiTokenPoolTokenPolicyUpdatesParams,
    { address, version, blockTag }: PoolConfigManagerWriteContext,
  ): Promise<PoolConfigManagerWrite> {
    const iface = getMultiTokenPoolInterface(POOL_CONFIG_MANAGER_TYPE, version)
    const fn =
      MULTI_TOKEN_POOL_OPERATIONS.applyMultiTokenPoolTokenPolicyUpdates.functions[recordType]
    const tokens = assignments.map((a) => getAddress(a.tokenAddress))
    const data = iface.encodeFunctionData(fn, [
      assignments.map((a, i) => [
        tokens[i],
        a.policyName === null
          ? ZeroHash
          : encodePolicyName(this.name, `assignments[${i}].policyName`, a.policyName),
      ]),
    ])
    // the values the write replaces: each token's current assignment of this type
    const configs = await poolConfigManagerContract(chain, address, version).getTokenConfigBatch(
      tokens,
      {
        blockTag,
      },
    )
    const expected = Object.fromEntries(
      tokens.map((t, i) => [
        `policies.${recordType}.${t}`,
        decodeTokenPolicies(resultToObject(configs[i]!))[recordType],
      ]),
    )
    return { data, expected }
  }
}
