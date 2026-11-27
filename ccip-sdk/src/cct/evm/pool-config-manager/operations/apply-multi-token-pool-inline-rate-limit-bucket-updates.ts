/**
 * applyMultiTokenPoolInlineRateLimitBucketUpdates — writes single buckets of existing inline rate limit records.
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

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
  validateAddress,
  validateArray,
  validateBoolean,
  validateOneOf,
  validateUint64,
} from '../../validate.ts'
import { MESSAGE_DIRECTIONS, inlineRecordOf, laneKey, rateLimitBucketOf } from '../projection.ts'
import type { InlineRateLimitBucketUpdate } from '../records.ts'
import {
  type MultiTokenPoolWriteGuards,
  type PoolConfigManagerWrite,
  type PoolConfigManagerWriteContext,
  type PoolConfigManagerWriteParams,
  PoolConfigManagerWriteOperation,
} from '../write-operation.ts'

/** Parameters of `applyMultiTokenPoolInlineRateLimitBucketUpdates`. */
export type ApplyMultiTokenPoolInlineRateLimitBucketUpdatesParams = PoolConfigManagerWriteParams &
  MultiTokenPoolWriteGuards & {
    /** The buckets, at least one; each record's bucket at most once. The record must exist. */
    updates: InlineRateLimitBucketUpdate[]
  }

/**
 * Writes single buckets of existing inline rate limit records, keeping the other buckets. A bucket enabled with no
 * capacity and no rate stops its direction (see `stopMultiTokenPoolLanes`); the lane rules judge only
 * the lanes a bucket loosens (a stop lifted, a bucket disabled, more capacity or rate): a write that
 * only tightens or stops is never refused by a lane rule, so a broken lane can always be clamped.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), the record does not
 *   exist, `sender` lacks the gate, or a lane guard refuses a loosened lane; `context.recordType` is `'rateLimit'`
 */
export class ApplyMultiTokenPoolInlineRateLimitBucketUpdates extends PoolConfigManagerWriteOperation<ApplyMultiTokenPoolInlineRateLimitBucketUpdatesParams> {
  readonly name = 'applyMultiTokenPoolInlineRateLimitBucketUpdates'

  protected override prepare(
    params: ApplyMultiTokenPoolInlineRateLimitBucketUpdatesParams,
  ): ApplyMultiTokenPoolInlineRateLimitBucketUpdatesParams {
    super.prepare(params)
    validateArray(this.name, 'updates', params.updates, 1)
    const updates = Array.from(params.updates, (u, i) => {
      const at = `updates[${i}]`
      validateAddress(this.name, `${at}.tokenAddress`, u.tokenAddress)
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
        `${laneKey(u.tokenAddress, u.remoteChainSelector)}:${u.direction}:${String(u.fastFinality)}`,
      'bucket',
    )
    return { ...params, updates }
  }

  protected gate(): readonly PoolConfigManagerRole[] {
    return ['CONFIG_ROLE', 'TOKEN_MANAGER_ROLE', TOKEN_POLICY_ROLES.rateLimit]
  }

  protected override errorContext(): Record<string, unknown> {
    return { recordType: 'rateLimit' }
  }

  protected async encode(
    chain: EVMChain,
    { updates }: ApplyMultiTokenPoolInlineRateLimitBucketUpdatesParams,
    { version, state }: PoolConfigManagerWriteContext,
  ): Promise<PoolConfigManagerWrite> {
    const recordOf = (u: InlineRateLimitBucketUpdate) => inlineRecordOf(state, 'rateLimit', u)
    updates.forEach((u, i) => {
      if (!recordOf(u))
        throw new CCTParamsInvalidError(
          this.name,
          `updates[${i}]`,
          `${getAddress(u.tokenAddress)} has no inline rate limit record for chain ${u.remoteChainSelector} (InlineRecordNotFound): set the whole record with applyMultiTokenPoolInlineRateLimitConfigUpdates first`,
          {
            context: { recordType: 'rateLimit' },
          },
        )
    })
    const data = getMultiTokenPoolInterface(POOL_CONFIG_MANAGER_TYPE, version).encodeFunctionData(
      multiTokenPoolFunctionOf(this.name),
      [
        updates.map((u) => ({
          localToken: getAddress(u.tokenAddress),
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
        `inline.rateLimit.${laneKey(u.tokenAddress, u.remoteChainSelector)}.${rateLimitBucketOf(u.direction, u.fastFinality)}`,
        recordOf(u)!.rateLimits[rateLimitBucketOf(u.direction, u.fastFinality)],
      ]),
    )
    return { data, expected }
  }
}
