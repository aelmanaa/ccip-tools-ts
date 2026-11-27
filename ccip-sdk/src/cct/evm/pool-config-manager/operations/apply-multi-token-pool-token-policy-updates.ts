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
import { type PolicyName, decodeTokenProfile, encodePolicyName } from '../contracts.ts'
import { decodeTokenPolicies } from '../decode.ts'
import { policyKey } from '../projection.ts'
import { readMultiTokenPoolRecordState } from '../record-state.ts'
import {
  type MultiTokenPoolWriteGuards,
  type PoolConfigManagerWrite,
  type PoolConfigManagerWriteContext,
  type PoolConfigManagerWriteParams,
  PoolConfigManagerWriteOperation,
} from '../write-operation.ts'

/** One policy assignment. */
export type MultiTokenPoolTokenPolicyAssignment = {
  /** The token. */
  tokenAddress: string
  /** The policy to assign, or `null` to clear the token's assignment of this type. */
  policyName: PolicyName | null
}

/** Parameters of `applyMultiTokenPoolTokenPolicyUpdates`. */
export type ApplyMultiTokenPoolTokenPolicyUpdatesParams = PoolConfigManagerWriteParams &
  MultiTokenPoolWriteGuards & {
    /** The record type whose policy the assignments set (a `LaneRecordType`). */
    recordType: LaneRecordType
    /** The assignments, at least one; each token at most once. */
    assignments: MultiTokenPoolTokenPolicyAssignment[]
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
        (a as MultiTokenPoolTokenPolicyAssignment | undefined)?.tokenAddress,
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
    const pcm = poolConfigManagerContract(chain, address, version)
    const [configs, lists, { state }] = await Promise.all([
      pcm.getTokenConfigBatch(tokens, { blockTag }),
      pcm.getPolicyNames({ blockTag }),
      readMultiTokenPoolRecordState(chain, address, version, { tokenAddresses: tokens, blockTag }),
    ])
    const names = new Set(
      ((lists[LANE_RECORD_TYPES.indexOf(recordType)] ?? []) as string[]).map((w) =>
        w.toLowerCase(),
      ),
    )
    const context = { recordType }
    const current = await Promise.all(
      assignments.map(async (a, i) => {
        const at = `assignments[${i}]`
        const token = tokens[i]!
        const raw = resultToObject(configs[i]!)
        const profile = decodeTokenProfile(token, raw, address)
        const old = decodeTokenPolicies(raw)[recordType]
        // the stores' own refusals, named before the eth_call would
        if (!profile.isRegistered)
          throw new CCTParamsInvalidError(
            this.name,
            `${at}.tokenAddress`,
            `${token} is not registered (LocalTokenNotRegistered): register it with applyMultiTokenPoolTokenProfileUpdates first`,
            { context },
          )
        if (a.policyName !== null) {
          const word = encodePolicyName(this.name, `${at}.policyName`, a.policyName).toLowerCase()
          if (!names.has(word))
            throw new CCTParamsInvalidError(
              this.name,
              `${at}.policyName`,
              `no ${recordType} policy ${a.policyName} exists (PolicyNotFound): create it with its records first`,
              { context },
            )
          if (recordType === 'rateLimit') {
            // a policy's rate limits are raw amounts in token units: its decimals must be the token's
            const [, decimals] = await pcm.getRateLimitPolicy(word, { blockTag })
            if (Number(decimals) !== profile.localDecimals)
              throw new CCTParamsInvalidError(
                this.name,
                `${at}.policyName`,
                `rate limit policy ${a.policyName} has ${Number(decimals)} decimals, but ${token} has ${profile.localDecimals} (InvalidRateLimitPolicyDecimals): use a policy made for ${profile.localDecimals}-decimal tokens`,
                { context },
              )
          }
        }
        if (recordType === 'connection' && old !== null) {
          const next = a.policyName === null ? null : policyKey(a.policyName, 'policyName')
          const oldKey = policyKey(old, 'policyName')
          const subsets = state.policies.connection
            .filter(
              (r) =>
                policyKey(r.policyName, 'policyName') === oldKey &&
                r.subsetTokens.some((t) => getAddress(t) === token),
            )
            .map((r) => r.remoteChainSelector)
          if (next !== oldKey && subsets.length)
            throw new CCTParamsInvalidError(
              this.name,
              `${at}.policyName`,
              `${token} is still in the subset list of connection policy ${old} on ${subsets.join(', ')} (TokenHasConfig): remove it from those subsets first`,
              { context: { ...context, subsets } },
            )
        }
        return [`policies.${recordType}.${token}`, old] as const
      }),
    )
    // the values the write replaces: each token's current assignment of this type
    const expected = Object.fromEntries(current)
    return { data, expected }
  }
}
