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
import { EVMQuery } from '../../query.ts'
import { validateNonZeroAddress } from '../../validate.ts'
import { resolvePoolConfigManagerTarget } from '../contracts.ts'
import {
  GUARD_OPTIONS_PATH,
  GUARD_POOL_PATH,
  runMultiTokenPoolGuards,
  snapshotChanges,
} from '../guard-run.ts'
import { type MultiTokenPoolGuardOptions, validateMultiTokenPoolGuardOptions } from '../guards.ts'

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
    const result = await runMultiTokenPoolGuards({
      ...options,
      chain,
      operation: snapshot.operation,
      errorOperation: this.name,
      poolConfigManager: address,
      version,
      ...(typeof pool === 'string' && { poolAddress: pool }),
      data: tx.data as string,
      sender,
      expected: Object.fromEntries(
        Object.entries(snapshot.expected).filter(
          ([path]) => path !== GUARD_OPTIONS_PATH && path !== GUARD_POOL_PATH,
        ),
      ),
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
