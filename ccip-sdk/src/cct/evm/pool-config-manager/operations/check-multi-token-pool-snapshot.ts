/**
 * checkMultiTokenPoolSnapshot — re-runs the post-state guard of a pending proposal on its exact
 * calldata, from the account that will execute it, and reports what moved.
 *
 * @packageDocumentation
 */

import { isAddress, keccak256 } from 'ethers'

import type { EVMChain } from '../../../../evm/index.ts'
import type { UnsignedEVMTx } from '../../../../evm/types.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import {
  type MultiTokenPoolRemoteCheckOptions,
  type MultiTokenPoolSnapshot,
  type MultiTokenPoolSnapshotCheck,
  parseMultiTokenPoolSnapshot,
  serializeMultiTokenPoolSnapshot,
} from '../../../multi-token-pool.ts'
import { latestBlock } from '../../mined-block.ts'
import {
  type MultiTokenPoolOperationTarget,
  MULTI_TOKEN_POOL_OPERATIONS,
} from '../../multi-token-pool/contracts.ts'
import { EVMQuery } from '../../query.ts'
import { validateNonZeroAddress } from '../../validate.ts'
import { decodeMultiTokenPoolWrite } from '../calldata.ts'
import { resolvePoolConfigManagerTarget } from '../contracts.ts'
import {
  GUARD_OPTIONS_PATH,
  GUARD_POOL_PATH,
  runMultiTokenPoolGuards,
  snapshotChanges,
} from '../guard-run.ts'
import { type MultiTokenPoolGuardOptions, validateMultiTokenPoolGuardOptions } from '../guards.ts'
import type { PoolConfigManagerWriteOperation } from '../write-operation.ts'
import { ApplyMultiTokenPoolConnectionPolicyConfigUpdates } from './apply-multi-token-pool-connection-policy-config-updates.ts'
import { ApplyMultiTokenPoolDestOverheadPolicyConfigUpdates } from './apply-multi-token-pool-dest-overhead-policy-config-updates.ts'
import { ApplyMultiTokenPoolFeePolicyConfigUpdates } from './apply-multi-token-pool-fee-policy-config-updates.ts'
import { ApplyMultiTokenPoolInlineConnectionConfigUpdates } from './apply-multi-token-pool-inline-connection-config-updates.ts'
import { ApplyMultiTokenPoolInlineDestOverheadConfigUpdates } from './apply-multi-token-pool-inline-dest-overhead-config-updates.ts'
import { ApplyMultiTokenPoolInlineFeeConfigUpdates } from './apply-multi-token-pool-inline-fee-config-updates.ts'
import { ApplyMultiTokenPoolInlineRateLimitBucketUpdates } from './apply-multi-token-pool-inline-rate-limit-bucket-updates.ts'
import { ApplyMultiTokenPoolInlineRateLimitConfigUpdates } from './apply-multi-token-pool-inline-rate-limit-config-updates.ts'
import { ApplyMultiTokenPoolInlineRemotePoolConfigUpdates } from './apply-multi-token-pool-inline-remote-pool-config-updates.ts'
import { ApplyMultiTokenPoolInlineSecurityConfigUpdates } from './apply-multi-token-pool-inline-security-config-updates.ts'
import { ApplyMultiTokenPoolRateLimitPolicyBucketUpdates } from './apply-multi-token-pool-rate-limit-policy-bucket-updates.ts'
import { ApplyMultiTokenPoolRateLimitPolicyConfigUpdates } from './apply-multi-token-pool-rate-limit-policy-config-updates.ts'
import { ApplyMultiTokenPoolRemotePoolPolicyConfigUpdates } from './apply-multi-token-pool-remote-pool-policy-config-updates.ts'
import { ApplyMultiTokenPoolRemoteTokenAddressProviderUpdates } from './apply-multi-token-pool-remote-token-address-provider-updates.ts'
import { ApplyMultiTokenPoolSecurityPolicyConfigUpdates } from './apply-multi-token-pool-security-policy-config-updates.ts'
import { ApplyMultiTokenPoolSubsetTokenUpdates } from './apply-multi-token-pool-subset-token-updates.ts'
import { ApplyMultiTokenPoolTokenPolicyUpdates } from './apply-multi-token-pool-token-policy-updates.ts'
import { ApplyMultiTokenPoolTokenProfileUpdates } from './apply-multi-token-pool-token-profile-updates.ts'
import {
  PauseMultiTokenPoolChains,
  PauseMultiTokenPoolGlobally,
  PauseMultiTokenPoolTokens,
  UnpauseMultiTokenPoolChains,
  UnpauseMultiTokenPoolGlobally,
  UnpauseMultiTokenPoolTokens,
} from './pause-multi-token-pool.ts'
import {
  LiftMultiTokenPoolLaneStops,
  StopMultiTokenPoolLanes,
} from './stop-multi-token-pool-lanes.ts'

/**
 * Parameters for `checkMultiTokenPoolSnapshot`: re-reads the state, and re-runs the full post-state
 * guard for the exact calldata (re-projection, `eth_simulateV1` where available) from `sender`.
 */
export type CheckMultiTokenPoolSnapshotParams = MultiTokenPoolRemoteCheckOptions & {
  /** The snapshot the op returned with the proposal's transaction. */
  snapshot: MultiTokenPoolSnapshot
  /** The proposal's unsigned transaction: one PoolConfigManager call. */
  transaction: UnsignedEVMTx
  /** The account that will execute (the Safe or timelock). */
  sender: string
}

/**
 * Every PCM record write, by op name. What each sealed (the values its calldata replaces) is read
 * again through the op's own `sealedFrom`, on the proposal's calldata and a fresh read: the check
 * never takes a sealed value as the current one. A unit test keeps this list equal to the op map's
 * record-changing PCM ops.
 * @internal
 */
export const RECORD_WRITE_OPS: ReadonlyMap<
  string,
  PoolConfigManagerWriteOperation<never>
> = new Map(
  [
    new ApplyMultiTokenPoolConnectionPolicyConfigUpdates(),
    new ApplyMultiTokenPoolDestOverheadPolicyConfigUpdates(),
    new ApplyMultiTokenPoolFeePolicyConfigUpdates(),
    new ApplyMultiTokenPoolInlineConnectionConfigUpdates(),
    new ApplyMultiTokenPoolInlineDestOverheadConfigUpdates(),
    new ApplyMultiTokenPoolInlineFeeConfigUpdates(),
    new ApplyMultiTokenPoolInlineRateLimitBucketUpdates(),
    new ApplyMultiTokenPoolInlineRateLimitConfigUpdates(),
    new ApplyMultiTokenPoolInlineRemotePoolConfigUpdates(),
    new ApplyMultiTokenPoolInlineSecurityConfigUpdates(),
    new ApplyMultiTokenPoolRateLimitPolicyBucketUpdates(),
    new ApplyMultiTokenPoolRateLimitPolicyConfigUpdates(),
    new ApplyMultiTokenPoolRemotePoolPolicyConfigUpdates(),
    new ApplyMultiTokenPoolRemoteTokenAddressProviderUpdates(),
    new ApplyMultiTokenPoolSecurityPolicyConfigUpdates(),
    new ApplyMultiTokenPoolSubsetTokenUpdates(),
    new ApplyMultiTokenPoolTokenPolicyUpdates(),
    new ApplyMultiTokenPoolTokenProfileUpdates(),
    new PauseMultiTokenPoolGlobally(),
    new UnpauseMultiTokenPoolGlobally(),
    new PauseMultiTokenPoolTokens(),
    new UnpauseMultiTokenPoolTokens(),
    new PauseMultiTokenPoolChains(),
    new UnpauseMultiTokenPoolChains(),
    new StopMultiTokenPoolLanes(),
    new LiftMultiTokenPoolLaneStops(),
  ].map((op) => [op.name, op as unknown as PoolConfigManagerWriteOperation<never>]),
)

/**
 * Re-checks a pending multi-token pool proposal.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), the snapshot does not
 *   match the transaction, a remote fact cannot be read (pass `getChain`), or the write reverts when
 *   `sender` executes it
 */
export class CheckMultiTokenPoolSnapshot extends EVMQuery<
  CheckMultiTokenPoolSnapshotParams,
  MultiTokenPoolSnapshotCheck
> {
  readonly name = 'checkMultiTokenPoolSnapshot'

  protected prepare(params: CheckMultiTokenPoolSnapshotParams): CheckMultiTokenPoolSnapshotParams {
    let snapshot: MultiTokenPoolSnapshot
    try {
      // the round trip checks the shape and that `hash` matches every field
      snapshot = parseMultiTokenPoolSnapshot(serializeMultiTokenPoolSnapshot(params.snapshot))
    } catch (cause) {
      throw new CCTParamsInvalidError(
        this.name,
        'snapshot',
        cause instanceof CCTParamsInvalidError
          ? `is not the snapshot an op returned: ${cause.context.reason as string}`
          : 'is not a snapshot',
        { cause: cause instanceof Error ? cause : undefined },
      )
    }
    const txs = (params.transaction as Partial<UnsignedEVMTx> | undefined)?.transactions
    const [tx, ...rest] = Array.isArray(txs) ? txs : []
    if (!tx || rest.length || typeof tx.data !== 'string' || typeof tx.to !== 'string')
      throw new CCTParamsInvalidError(
        this.name,
        'transaction',
        'must hold exactly one PoolConfigManager call (with `to` and `data`), as every MTTP write builds it',
      )
    validateNonZeroAddress(this.name, 'transaction.transactions[0].to', tx.to)
    validateNonZeroAddress(this.name, 'sender', params.sender)
    if (keccak256(tx.data) !== snapshot.calldataHash)
      throw new CCTParamsInvalidError(
        this.name,
        'snapshot',
        'covers other calldata than the transaction: pass the snapshot returned with this transaction',
      )
    return { ...params, snapshot }
  }

  protected async read(
    chain: EVMChain,
    {
      snapshot,
      transaction,
      sender,
      getChain,
      remoteAttestations,
    }: CheckMultiTokenPoolSnapshotParams,
  ): Promise<MultiTokenPoolSnapshotCheck> {
    const tx = transaction.transactions[0]!
    const { address, version } = await resolvePoolConfigManagerTarget(chain, {
      poolConfigManager: tx.to as string,
    })
    const options = guardOptionsFrom(snapshot.expected[GUARD_OPTIONS_PATH], this.name)
    const pool = snapshot.expected[GUARD_POOL_PATH]
    if (pool !== undefined && (typeof pool !== 'string' || !isAddress(pool)))
      throw new CCTParamsInvalidError(
        this.name,
        `snapshot.expected.${GUARD_POOL_PATH}`,
        'is not an address',
      )
    const op = RECORD_WRITE_OPS.get(snapshot.operation)
    if (!op)
      throw new CCTParamsInvalidError(
        this.name,
        'snapshot.operation',
        `${snapshot.operation} is not a multi-token pool write this check can re-read`,
      )
    // the snapshot's op must be the one the calldata calls: a snapshot of another op is not a seal
    // of this proposal, whatever its hash says
    const target = (MULTI_TOKEN_POOL_OPERATIONS as Record<string, MultiTokenPoolOperationTarget>)[
      snapshot.operation
    ]!
    const functions = 'function' in target ? [target.function] : Object.values(target.functions)
    const called = decodeMultiTokenPoolWrite(tx.data as string, version).functionName
    if (!functions.includes(called))
      throw new CCTParamsInvalidError(
        this.name,
        'snapshot.operation',
        `${snapshot.operation} calls ${functions.join(' or ')}, but the transaction calls ${called}: pass the snapshot built with this transaction`,
      )
    // what the proposal replaces, read now through the op itself: never the sealed values
    const blockTag = await latestBlock(chain)
    const expected = await op.freshSealed(chain, {
      data: tx.data as string,
      address,
      version,
      blockTag,
    })
    const result = await runMultiTokenPoolGuards({
      ...options,
      chain,
      operation: snapshot.operation,
      errorOperation: this.name,
      poolConfigManager: address,
      version,
      blockTag,
      ...(typeof pool === 'string' && { poolAddress: pool }),
      data: tx.data as string,
      sender,
      expected,
      ...(getChain && { getChain }),
      ...(remoteAttestations && { remoteAttestations }),
      reportFindings: true,
    })
    const changed = snapshotChanges(snapshot, result.snapshot)
    return {
      ok: !changed.length && !result.findings.some((f) => f.severity === 'error'),
      changed,
      findings: result.findings,
    }
  }
}

/**
 * The guard options a snapshot sealed, validated as a write validates its own: the hash proves the
 * snapshot was not edited, not that a hand-built one carries valid options.
 */
function guardOptionsFrom(value: unknown, operation: string): MultiTokenPoolGuardOptions {
  if (value === undefined) return {}
  const param = `snapshot.expected.${GUARD_OPTIONS_PATH}`
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new CCTParamsInvalidError(operation, param, 'is not the guard options an op sealed')
  const o = value as Record<string, unknown>
  validateMultiTokenPoolGuardOptions(operation, `${param}.`, o)
  return o
}
