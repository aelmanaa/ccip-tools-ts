/**
 * The shared core of the two single-bucket rate limit writes (an inline record's buckets, a rate
 * limit policy record's buckets): they differ only in the record they address.
 *
 * @packageDocumentation
 */

import type { TransferDirection } from '../../../../chain.ts'
import type { EVMChain } from '../../../../evm/index.ts'
import type { RateLimitConfig } from '../../../rate-limit.ts'
import {
  type MultiTokenPoolSingleFunctionOperation,
  POOL_CONFIG_MANAGER_TYPE,
  getMultiTokenPoolInterface,
  multiTokenPoolFunctionOf,
} from '../../multi-token-pool/contracts.ts'
import { parseRateLimitConfig, toAbiRateLimitConfig } from '../../token-pool/rate-limit.ts'
import { assertUnique, validateArray, validateBoolean, validateOneOf } from '../../validate.ts'
import {
  type MultiTokenPoolRecordState,
  TRANSFER_DIRECTIONS,
  rateLimitBucketOf,
} from '../projection.ts'
import type { MultiTokenPoolRateLimits } from '../records.ts'
import {
  type MultiTokenPoolWriteGuards,
  type PoolConfigManagerWrite,
  type PoolConfigManagerWriteContext,
  type PoolConfigManagerWriteParams,
  PoolConfigManagerWriteOperation,
} from '../write-operation.ts'

/** One bucket of a record: the record's key, plus which bucket and its config. @internal */
export type RateLimitBucketUpdate = {
  /** CCIP selector of the remote chain. */
  remoteChainSelector: bigint
  /** The direction. */
  direction: TransferDirection
  /** The faster-than-finality bucket (`true`) or the finality one. */
  fastFinality: boolean
  /** The bucket. */
  config: RateLimitConfig
}

/** Params of a bucket write. @internal */
export type RateLimitBucketWriteParams<U extends RateLimitBucketUpdate> =
  PoolConfigManagerWriteParams &
    MultiTokenPoolWriteGuards & {
      /** The buckets, at least one; each record's bucket at most once. The record must exist. */
      updates: U[]
    }

/**
 * A bucket write: validates and dedupes the updates, refuses a missing record, encodes them, and
 * seals each bucket it replaces. A subclass names its record side.
 * @internal
 */
export abstract class RateLimitBucketWriteOperation<
  U extends RateLimitBucketUpdate,
> extends PoolConfigManagerWriteOperation<RateLimitBucketWriteParams<U>> {
  /** The op; its PCM function comes from the op map. */
  abstract override readonly name: MultiTokenPoolSingleFunctionOperation
  /** The snapshot path prefix of the record type (`inline.rateLimit`, `policies.rateLimit`). */
  protected abstract readonly pathPrefix: string

  /** Validates the record key of one update at `at`, before any RPC. */
  protected abstract validateKey(update: U, at: string): void
  /** The record's canonical key (unique per record). */
  protected abstract keyOf(update: U): string
  /** The record's buckets in the state, or `undefined` when the record does not exist. */
  protected abstract rateLimitsOf(
    state: MultiTokenPoolRecordState,
    update: U,
  ): MultiTokenPoolRateLimits | undefined
  /** Why a missing record is refused (the store's error, and the op that sets the whole record). */
  protected abstract missingRecord(update: U): string
  /** The record key fields of the ABI struct. */
  protected abstract abiKey(update: U): Record<string, unknown>

  protected override prepare(params: RateLimitBucketWriteParams<U>): RateLimitBucketWriteParams<U> {
    super.prepare(params)
    validateArray(this.name, 'updates', params.updates, 1)
    const updates = Array.from(params.updates, (u, i) => {
      const at = `updates[${i}]`
      this.validateKey(u, at)
      validateOneOf(this.name, `${at}.direction`, u.direction, TRANSFER_DIRECTIONS)
      validateBoolean(this.name, `${at}.fastFinality`, u.fastFinality)
      return { ...u, config: parseRateLimitConfig(this.name, `${at}.config`, u.config, null) }
    })
    assertUnique(
      this.name,
      'updates',
      updates,
      (u) => `${this.keyOf(u)}:${u.direction}:${String(u.fastFinality)}`,
      'bucket',
    )
    return { ...params, updates }
  }

  protected override errorContext(): Record<string, unknown> {
    return { recordType: 'rateLimit' }
  }

  protected encode(
    _chain: EVMChain,
    { updates }: RateLimitBucketWriteParams<U>,
    { version, state }: PoolConfigManagerWriteContext,
  ): PoolConfigManagerWrite {
    const stored = updates.map((u, i) => {
      const rateLimits = this.rateLimitsOf(state, u)
      if (!rateLimits) throw this.refuse(`updates[${i}]`, this.missingRecord(u))
      return rateLimits
    })
    const data = getMultiTokenPoolInterface(POOL_CONFIG_MANAGER_TYPE, version).encodeFunctionData(
      multiTokenPoolFunctionOf(this.name),
      [
        updates.map((u) => ({
          ...this.abiKey(u),
          remoteChainSelector: u.remoteChainSelector,
          direction: TRANSFER_DIRECTIONS.indexOf(u.direction),
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
      updates.map((u, i) => {
        const bucket = rateLimitBucketOf(u.direction, u.fastFinality)
        return [`${this.pathPrefix}.${this.keyOf(u)}.${bucket}`, stored[i]![bucket]]
      }),
    )
    return { data, expected }
  }
}
