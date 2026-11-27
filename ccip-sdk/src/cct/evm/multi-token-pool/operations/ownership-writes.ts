/**
 * Two-step (`Ownable2Step`) ownership of the contracts of a multi-token stack: the pool, a policy
 * store, a hook contract. One transfer and one accept, shared by the three targets.
 *
 * @remarks Validation follows main's `transferPoolOwnership` / `acceptPoolOwnership`: the zero
 * address is a valid `newOwner` (it parks the pending transfer on an address nobody signs as, which
 * is how a mistaken proposal is retracted), and the current owner is refused (`CannotTransferToSelf`).
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

import type { EVMChain } from '../../../../evm/index.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { validateAddress } from '../../validate.ts'
import { multiTokenPoolFunctionOf } from '../contracts.ts'
import {
  type MultiTokenPoolOwnedTargetKind,
  type MultiTokenPoolOwnedTargetParam,
  type MultiTokenPoolOwnedWriteContext,
  MultiTokenPoolOwnedWriteOperation,
  ownedTargetInterface,
  ownedTargetLabel,
} from '../owned-write-operation.ts'

/** `transferMultiTokenPoolOwnership` (Ownable2Step). */
export type TransferMultiTokenPoolOwnershipParams = {
  /** The multi-token pool. */
  poolAddress: string
  /** The proposed owner; it gains nothing until it accepts. `ZeroAddress` retracts a pending transfer. */
  newOwner: string
  /** The current owner; optional when generating an unsigned transaction. */
  sender?: string
}
/** `acceptMultiTokenPoolOwnership`. */
export type AcceptMultiTokenPoolOwnershipParams = {
  /** The multi-token pool. */
  poolAddress: string
  /** The pending owner; optional when generating an unsigned transaction. */
  sender?: string
}
/** `transferPolicyStoreOwnership` (Ownable2Step). */
export type TransferPolicyStoreOwnershipParams = {
  /** The policy store (connection, fee or security). */
  policyStore: string
  /** The proposed owner; it gains nothing until it accepts. `ZeroAddress` retracts a pending transfer. */
  newOwner: string
  /** The current owner; optional when generating an unsigned transaction. */
  sender?: string
}
/** `acceptPolicyStoreOwnership`. */
export type AcceptPolicyStoreOwnershipParams = {
  /** The policy store. */
  policyStore: string
  /** The pending owner; optional when generating an unsigned transaction. */
  sender?: string
}
/** `transferMultiTokenPoolHooksOwnership` (Ownable2Step). */
export type TransferMultiTokenPoolHooksOwnershipParams = {
  /** The hook contract. */
  hooks: string
  /** The proposed owner; it gains nothing until it accepts. `ZeroAddress` retracts a pending transfer. */
  newOwner: string
  /** The current owner; optional when generating an unsigned transaction. */
  sender?: string
}
/** `acceptMultiTokenPoolHooksOwnership`. */
export type AcceptMultiTokenPoolHooksOwnershipParams = {
  /** The hook contract. */
  hooks: string
  /** The pending owner; optional when generating an unsigned transaction. */
  sender?: string
}

/** Proposes a new owner of an owned target. Owner-only. */
abstract class TransferOwnedTargetOwnership<
  K extends MultiTokenPoolOwnedTargetKind,
  P extends { [k in MultiTokenPoolOwnedTargetParam<K>]: string } & {
    newOwner: string
    sender?: string
  },
> extends MultiTokenPoolOwnedWriteOperation<K, P> {
  abstract override readonly name:
    | 'transferMultiTokenPoolOwnership'
    | 'transferPolicyStoreOwnership'
    | 'transferMultiTokenPoolHooksOwnership'

  /**
   * Validates both addresses and, when `sender` is known, refuses a self-transfer, as main's
   * `transferPoolOwnership`.
   * @throws {@link CCTParamsInvalidError} if an address is malformed, or `newOwner` equals `sender`
   */
  protected override prepare(params: P): P {
    const parsed = super.prepare(params)
    validateAddress(this.name, 'newOwner', params.newOwner)
    if (params.sender === undefined) return parsed
    // `generate` validates `sender` only after this hook
    validateAddress(this.name, 'sender', params.sender)
    if (getAddress(params.newOwner) === getAddress(params.sender))
      throw new CCTParamsInvalidError(
        this.name,
        'newOwner',
        `must differ from sender (${params.sender}) — the ${ownedTargetLabel(this.kind)} already has that owner and would revert CannotTransferToSelf`,
      )
    return parsed
  }

  protected encode(_chain: EVMChain, params: P, ctx: MultiTokenPoolOwnedWriteContext): string {
    // bounded against the chain, so it holds with no `sender`
    if (getAddress(params.newOwner) === ctx.owner)
      throw this.refuse(
        'newOwner',
        `must differ from the current ${ownedTargetLabel(this.kind)} owner (${ctx.owner}) — the contract would revert CannotTransferToSelf`,
        params,
      )
    return ownedTargetInterface(ctx).encodeFunctionData(multiTokenPoolFunctionOf(this.name), [
      getAddress(params.newOwner),
    ])
  }
}

/** Completes a pending ownership transfer of an owned target. The pending owner only. */
abstract class AcceptOwnedTargetOwnership<
  K extends MultiTokenPoolOwnedTargetKind,
  P extends { [k in MultiTokenPoolOwnedTargetParam<K>]: string } & { sender?: string },
> extends MultiTokenPoolOwnedWriteOperation<K, P> {
  abstract override readonly name:
    | 'acceptMultiTokenPoolOwnership'
    | 'acceptPolicyStoreOwnership'
    | 'acceptMultiTokenPoolHooksOwnership'
  protected override readonly signer = 'pendingOwner'

  protected encode(_chain: EVMChain, _params: P, ctx: MultiTokenPoolOwnedWriteContext): string {
    return ownedTargetInterface(ctx).encodeFunctionData(multiTokenPoolFunctionOf(this.name), [])
  }
}

/** Proposes a new multi-token pool owner. */
export class TransferMultiTokenPoolOwnership extends TransferOwnedTargetOwnership<
  'pool',
  TransferMultiTokenPoolOwnershipParams
> {
  /** The op name. */
  readonly name = 'transferMultiTokenPoolOwnership'
  protected readonly kind = 'pool'
}
/** Accepts multi-token pool ownership. */
export class AcceptMultiTokenPoolOwnership extends AcceptOwnedTargetOwnership<
  'pool',
  AcceptMultiTokenPoolOwnershipParams
> {
  /** The op name. */
  readonly name = 'acceptMultiTokenPoolOwnership'
  protected readonly kind = 'pool'
}
/** Proposes a new policy store owner. */
export class TransferPolicyStoreOwnership extends TransferOwnedTargetOwnership<
  'policyStore',
  TransferPolicyStoreOwnershipParams
> {
  /** The op name. */
  readonly name = 'transferPolicyStoreOwnership'
  protected readonly kind = 'policyStore'
}
/** Accepts policy store ownership. */
export class AcceptPolicyStoreOwnership extends AcceptOwnedTargetOwnership<
  'policyStore',
  AcceptPolicyStoreOwnershipParams
> {
  /** The op name. */
  readonly name = 'acceptPolicyStoreOwnership'
  protected readonly kind = 'policyStore'
}
/** Proposes a new hook contract owner. */
export class TransferMultiTokenPoolHooksOwnership extends TransferOwnedTargetOwnership<
  'hooks',
  TransferMultiTokenPoolHooksOwnershipParams
> {
  /** The op name. */
  readonly name = 'transferMultiTokenPoolHooksOwnership'
  protected readonly kind = 'hooks'
}
/** Accepts hook contract ownership. */
export class AcceptMultiTokenPoolHooksOwnership extends AcceptOwnedTargetOwnership<
  'hooks',
  AcceptMultiTokenPoolHooksOwnershipParams
> {
  /** The op name. */
  readonly name = 'acceptMultiTokenPoolHooksOwnership'
  protected readonly kind = 'hooks'
}
