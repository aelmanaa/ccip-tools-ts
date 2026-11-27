/**
 * applyMultiTokenPoolRateLimitPolicyBucketUpdates — writes single buckets of existing rate limit policy records.
 *
 * @packageDocumentation
 */

import type { EVMChain } from '../../../../evm/index.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import {
  type PoolConfigManagerRole,
  POOL_CONFIG_MANAGER_TYPE,
  TOKEN_POLICY_ROLES,
  getMultiTokenPoolInterface,
  multiTokenPoolFunctionOf,
} from '../../multi-token-pool/contracts.ts'
import { parseRateLimitConfig, toAbiRateLimitConfig } from '../../token-pool/rate-limit.ts'
import {
  assertUnique,
  validateArray,
  validateBoolean,
  validateOneOf,
  validateUint64,
} from '../../validate.ts'
import { encodePolicyName } from '../contracts.ts'
import { MESSAGE_DIRECTIONS, policyKey, rateLimitBucketOf } from '../projection.ts'
import type { RateLimitPolicyBucketUpdate } from '../records.ts'
import {
  type MultiTokenPoolWriteGuards,
  type PoolConfigManagerWrite,
  type PoolConfigManagerWriteContext,
  type PoolConfigManagerWriteParams,
  PoolConfigManagerWriteOperation,
} from '../write-operation.ts'

/** Parameters of `applyMultiTokenPoolRateLimitPolicyBucketUpdates`. */
export type ApplyMultiTokenPoolRateLimitPolicyBucketUpdatesParams = PoolConfigManagerWriteParams &
  MultiTokenPoolWriteGuards & {
    /** The buckets, at least one; each record's bucket at most once. The record must exist. */
    updates: RateLimitPolicyBucketUpdate[]
  }

/**
 * Writes single buckets of existing rate limit policy records, keeping the other buckets. A bucket enabled with no
 * capacity and no rate stops its direction (see `stopMultiTokenPoolLanes`); the lane guard runs on
 * every lane the buckets change.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), the record does not
 *   exist, `sender` lacks the gate, or a lane guard refuses; `context.recordType` is `'rateLimit'`
 */
export class ApplyMultiTokenPoolRateLimitPolicyBucketUpdates extends PoolConfigManagerWriteOperation<ApplyMultiTokenPoolRateLimitPolicyBucketUpdatesParams> {
  readonly name = 'applyMultiTokenPoolRateLimitPolicyBucketUpdates'

  protected override prepare(
    params: ApplyMultiTokenPoolRateLimitPolicyBucketUpdatesParams,
  ): ApplyMultiTokenPoolRateLimitPolicyBucketUpdatesParams {
    super.prepare(params)
    validateArray(this.name, 'updates', params.updates, 1)
    const updates = Array.from(params.updates, (u, i) => {
      const at = `updates[${i}]`
      encodePolicyName(this.name, `${at}.policyName`, u.policyName)
      validateUint64(this.name, `${at}.remoteChainSelector`, u.remoteChainSelector)
      validateOneOf(this.name, `${at}.direction`, u.direction, MESSAGE_DIRECTIONS)
      validateBoolean(this.name, `${at}.fastFinality`, u.fastFinality)
      return { ...u, config: parseRateLimitConfig(this.name, `${at}.config`, u.config, null) }
    })
    assertUnique(
      this.name,
      'updates',
      updates,
      (u) =>
        `${policyKey(u.policyName, 'policyName')}:${u.remoteChainSelector}:${u.direction}:${String(u.fastFinality)}`,
      'bucket',
    )
    return { ...params, updates }
  }

  protected gate(): readonly PoolConfigManagerRole[] {
    return ['CONFIG_ROLE', 'POLICY_ROLE', TOKEN_POLICY_ROLES.rateLimit]
  }

  protected override errorContext(): Record<string, unknown> {
    return { recordType: 'rateLimit' }
  }

  protected async encode(
    chain: EVMChain,
    { updates }: ApplyMultiTokenPoolRateLimitPolicyBucketUpdatesParams,
    { version, state }: PoolConfigManagerWriteContext,
  ): Promise<PoolConfigManagerWrite> {
    const recordOf = (u: RateLimitPolicyBucketUpdate) =>
      state.policies.rateLimit.find(
        (r) =>
          policyKey(r.policyName, 'policyName') === policyKey(u.policyName, 'policyName') &&
          r.remoteChainSelector === u.remoteChainSelector,
      )
    updates.forEach((u, i) => {
      if (!recordOf(u))
        throw new CCTParamsInvalidError(
          this.name,
          `updates[${i}]`,
          `rate limit policy ${u.policyName} has no record for chain ${u.remoteChainSelector} (PolicyRecordNotFound): set the whole record with applyMultiTokenPoolRateLimitPolicyConfigUpdates first`,
          {
            context: { recordType: 'rateLimit' },
          },
        )
    })
    const data = getMultiTokenPoolInterface(POOL_CONFIG_MANAGER_TYPE, version).encodeFunctionData(
      multiTokenPoolFunctionOf(this.name),
      [
        updates.map((u) => ({
          policyName: encodePolicyName(this.name, 'policyName', u.policyName),
          remoteChainSelector: u.remoteChainSelector,
          direction: MESSAGE_DIRECTIONS.indexOf(u.direction),
          fastFinality: u.fastFinality,
          config: toAbiRateLimitConfig({
            enabled: u.config.enabled,
            capacity: u.config.capacity ?? 0n,
            rate: u.config.rate ?? 0n,
          }),
        })),
      ],
    )
    // the values the write replaces: each bucket as stored
    const expected = Object.fromEntries(
      updates.map((u) => [
        `policies.rateLimit.${policyKey(u.policyName, 'policyName')}:${u.remoteChainSelector}.${rateLimitBucketOf(u.direction, u.fastFinality)}`,
        recordOf(u)!.rateLimits[rateLimitBucketOf(u.direction, u.fastFinality)],
      ]),
    )
    return { data, expected }
  }
}
