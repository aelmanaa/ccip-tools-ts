/**
 * The pending-transfer rules of OpenZeppelin `AccessControlDefaultAdminRules`, shared by every
 * contract the SDK drives through it (a v2 `CrossChainToken`, a `PoolConfigManager`).
 *
 * @packageDocumentation
 */

import { ZeroAddress, getAddress } from 'ethers'

import { CCTParamsInvalidError } from '../errors.ts'

/** A scheduled default admin transfer; `schedule` `0n` means none. A zero `newAdmin` is a renounce. */
export type DefaultAdminTransferSchedule = {
  /** The proposed admin, or `ZeroAddress` for a scheduled renounce. */
  newAdmin: string
  /** Unix seconds from which it can be completed, or `0n` when none is scheduled. */
  schedule: bigint
}

/**
 * Refuses accepting a transfer that cannot be accepted: none is scheduled, it is a renounce (which
 * the admin completes with `renounceWith`), or `sender` is not the proposed admin. The schedule's
 * time is left to the chain, so an unsigned transaction may be signed after the delay.
 * @throws {@link CCTParamsInvalidError} at `param` (or `sender`)
 * @internal
 */
export function assertDefaultAdminTransferAcceptable(
  operation: string,
  param: string,
  { newAdmin, schedule }: DefaultAdminTransferSchedule,
  sender: string | undefined,
  renounceWith = 'renounceRole',
): void {
  if (schedule === 0n)
    throw new CCTParamsInvalidError(operation, param, `has no pending default-admin transfer`)
  // a zero pending admin is the separate, deliberate renunciation path and cannot accept
  if (getAddress(newAdmin) === ZeroAddress)
    throw new CCTParamsInvalidError(
      operation,
      param,
      `has a pending default-admin renunciation, which must be completed with ${renounceWith}`,
    )
  if (sender !== undefined && getAddress(sender) !== getAddress(newAdmin))
    throw new CCTParamsInvalidError(
      operation,
      'sender',
      `must be the pending default admin (${getAddress(newAdmin)})`,
    )
}

/**
 * Refuses cancelling when no transfer is scheduled.
 * @throws {@link CCTParamsInvalidError} at `param`
 * @internal
 */
export function assertDefaultAdminTransferPending(
  operation: string,
  param: string,
  { schedule }: DefaultAdminTransferSchedule,
): void {
  if (schedule === 0n)
    throw new CCTParamsInvalidError(
      operation,
      param,
      'has no pending default-admin transfer to cancel',
    )
}
