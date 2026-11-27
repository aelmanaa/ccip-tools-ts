/**
 * The PoolConfigManager's role writes: grant, revoke and renounce a role, and the
 * `AccessControlDefaultAdminRules` admin lifecycle (begin, accept and cancel a transfer, change and
 * roll back the delay, renounce the default admin for good). None changes a stored record: each is
 * gated, simulated and sealed (its snapshot holds the role or admin state it replaces).
 *
 * @packageDocumentation
 */

import { type Result, ZeroAddress, getAddress } from 'ethers'

import type { EVMChain } from '../../../../evm/index.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import {
  assertDefaultAdminTransferAcceptable,
  assertDefaultAdminTransferPending,
} from '../../default-admin.ts'
import {
  type MultiTokenPoolSingleFunctionOperation,
  type PoolConfigManagerGrantableRole,
  type PoolConfigManagerRole,
  POOL_CONFIG_MANAGER_ROLES,
  POOL_CONFIG_MANAGER_TYPE,
  getMultiTokenPoolInterface,
  multiTokenPoolFunctionOf,
  poolConfigManagerContract,
  poolConfigManagerRoleId,
  readPoolConfigManagerRolesHeld,
} from '../../multi-token-pool/contracts.ts'
import { validateAddress, validateOneOf, validateUint48 } from '../../validate.ts'
import {
  type PoolConfigManagerAdminState,
  type PoolConfigManagerTarget,
  readPoolConfigManagerAdmin,
} from '../contracts.ts'
import {
  type PoolConfigManagerFacts,
  type PoolConfigManagerWrite,
  type PoolConfigManagerWriteContext,
  type PoolConfigManagerWriteParams,
  PoolConfigManagerWriteOperation,
} from '../write-operation.ts'

/** The roles `grantRole` / `revokeRole` / `renounceRole` take: every role but the default admin. */
const GRANTABLE_ROLES = POOL_CONFIG_MANAGER_ROLES.filter(
  (r): r is PoolConfigManagerGrantableRole => r !== 'DEFAULT_ADMIN_ROLE',
)

/** Parameters of `grantMultiTokenPoolRole` (and `revokeMultiTokenPoolRole`). */
export type GrantMultiTokenPoolRoleParams = PoolConfigManagerWriteParams & {
  /** The role; `DEFAULT_ADMIN_ROLE` moves only by the two-step admin transfer. */
  role: PoolConfigManagerGrantableRole
  /** The account. */
  account: string
}
/** Parameters of `revokeMultiTokenPoolRole`. */
export type RevokeMultiTokenPoolRoleParams = GrantMultiTokenPoolRoleParams
/** Parameters of `renounceMultiTokenPoolRole`: OZ checks `callerConfirmation == msg.sender`. */
export type RenounceMultiTokenPoolRoleParams = PoolConfigManagerTarget & {
  /** The role `sender` gives up. */
  role: PoolConfigManagerGrantableRole
  /** The holder, who sends it. */
  sender: string
}
/**
 * Parameters of `renounceMultiTokenPoolDefaultAdmin`: the second step of giving up the default
 * admin for good (`beginMultiTokenPoolDefaultAdminTransfer({ newAdmin: ZeroAddress })`, wait for the
 * delay, then this). Role management, pauses and unpauses freeze forever.
 */
export type RenounceMultiTokenPoolDefaultAdminParams = PoolConfigManagerTarget & {
  /** The default admin, who sends it. */
  sender: string
  /** Must be `true`: the result cannot be undone. */
  confirmPermanentFreeze: true
}
/** Parameters of `beginMultiTokenPoolDefaultAdminTransfer`. `ZeroAddress` schedules a renounce. */
export type BeginMultiTokenPoolDefaultAdminTransferParams = PoolConfigManagerWriteParams & {
  /** The proposed admin, or `ZeroAddress` to schedule a renounce. */
  newAdmin: string
}
/** Parameters of `acceptMultiTokenPoolDefaultAdminTransfer`, sent by the pending admin after the delay. */
export type AcceptMultiTokenPoolDefaultAdminTransferParams = PoolConfigManagerWriteParams
/** Parameters of `cancelMultiTokenPoolDefaultAdminTransfer`. */
export type CancelMultiTokenPoolDefaultAdminTransferParams = PoolConfigManagerWriteParams
/** Parameters of `changeMultiTokenPoolDefaultAdminDelay`. It governs the admin transfer only, not `grantRole`. */
export type ChangeMultiTokenPoolDefaultAdminDelayParams = PoolConfigManagerWriteParams & {
  /** The new delay, in seconds. */
  newDelay: number
}
/** Parameters of `rollbackMultiTokenPoolDefaultAdminDelay`. */
export type RollbackMultiTokenPoolDefaultAdminDelayParams = PoolConfigManagerWriteParams

/** The param naming the PCM target, for refusals about its state. */
const targetParam = (t: PoolConfigManagerTarget) =>
  t.poolConfigManager !== undefined ? 'poolConfigManager' : 'poolAddress'

/** The admin state a write seals (what it replaces), as plain values. */
const adminExpected = (a: PoolConfigManagerAdminState): PoolConfigManagerFacts => ({
  'admin.defaultAdmin': a.defaultAdmin,
  'admin.pending': a.pending,
  'admin.delay': a.delay,
  'admin.pendingDelay': a.pendingDelay,
})

/** The admin state back from the facts {@link adminExpected} sealed. */
const adminOf = (facts: PoolConfigManagerFacts) =>
  ({
    defaultAdmin: facts['admin.defaultAdmin'],
    pending: facts['admin.pending'],
    delay: facts['admin.delay'],
    pendingDelay: facts['admin.pendingDelay'],
  }) as Omit<PoolConfigManagerAdminState, 'delayIncreaseWait'>

/** The path a role-membership fact is sealed at. */
const rolePath = (role: PoolConfigManagerRole, account: string) => `roles.${role}.${account}`

/** The grantable role a calldata role id names. */
function roleOfId(operation: string, id: unknown): PoolConfigManagerGrantableRole {
  const role = GRANTABLE_ROLES.find((r) => poolConfigManagerRoleId(r) === String(id).toLowerCase())
  if (!role)
    throw new CCTParamsInvalidError(
      operation,
      'transaction',
      `names role id ${String(id)}, which is not a grantable PoolConfigManager role`,
    )
  return role
}

/** A renounce's account must be the executing account (OZ checks `callerConfirmation == msg.sender`). */
function renouncedBy(operation: string, account: unknown, sender: string): string {
  if (getAddress(String(account)) !== getAddress(sender))
    throw new CCTParamsInvalidError(
      operation,
      'sender',
      `must be ${getAddress(String(account))}, the account the renounce names (OZ requires the caller to confirm itself)`,
    )
  return getAddress(sender)
}

/** The shared base: record-free, its function from the op map. */
abstract class RoleWriteOperation<
  P extends PoolConfigManagerWriteParams,
> extends PoolConfigManagerWriteOperation<P> {
  /** The op; its PCM function comes from the op map. */
  abstract override readonly name: MultiTokenPoolSingleFunctionOperation

  // a role or admin write changes no stored record
  protected override changesRecords(): boolean {
    return false
  }

  /** The calldata. */
  protected calldata(version: PoolConfigManagerWriteContext['version'], args: unknown[]): string {
    return getMultiTokenPoolInterface(POOL_CONFIG_MANAGER_TYPE, version).encodeFunctionData(
      multiTokenPoolFunctionOf(this.name),
      args,
    )
  }

  /** The PCM's admin state at the build block, as the facts it seals. */
  protected async adminFacts(
    chain: EVMChain,
    {
      address,
      version,
      blockTag,
    }: Pick<PoolConfigManagerWriteContext, 'address' | 'version' | 'blockTag'>,
  ): Promise<PoolConfigManagerFacts> {
    return adminExpected(
      await readPoolConfigManagerAdmin(
        poolConfigManagerContract(chain, address, version),
        blockTag,
      ),
    )
  }

  /** Whether `account` holds `role` at the build block, as the fact it seals. */
  protected async roleFact(
    chain: EVMChain,
    role: PoolConfigManagerRole,
    account: string,
    {
      address,
      version,
      blockTag,
    }: Pick<PoolConfigManagerWriteContext, 'address' | 'version' | 'blockTag'>,
  ): Promise<PoolConfigManagerFacts> {
    const pcm = poolConfigManagerContract(chain, address, version)
    const held = (await readPoolConfigManagerRolesHeld(pcm, account, [role], blockTag)).length > 0
    return { [rolePath(role, getAddress(account))]: held }
  }
}

/** An admin-lifecycle write: judged on, and sealing, the PCM's admin state. */
abstract class AdminWriteOperation<
  P extends PoolConfigManagerWriteParams,
> extends RoleWriteOperation<P> {
  protected override readFacts(
    chain: EVMChain,
    _params: P,
    ctx: Pick<PoolConfigManagerWriteContext, 'address' | 'version' | 'blockTag'>,
  ): Promise<PoolConfigManagerFacts> {
    return this.adminFacts(chain, ctx)
  }

  /** A write that takes no argument but the target. */
  override paramsFromCalldata(_args: Result, target: PoolConfigManagerTarget, sender: string): P {
    return { ...target, sender } as P
  }
}

/** Grant and revoke: the default admin moves another account's role. */
abstract class RoleGrantOperation extends RoleWriteOperation<GrantMultiTokenPoolRoleParams> {
  /** Whether the write gives the role (else takes it away). */
  protected abstract readonly grants: boolean

  /** Validates the role (not the default admin) and the account, before any RPC. */
  protected override prepare(params: GrantMultiTokenPoolRoleParams): GrantMultiTokenPoolRoleParams {
    super.prepare(params)
    validateOneOf(this.name, 'role', params.role, GRANTABLE_ROLES)
    validateAddress(this.name, 'account', params.account)
    return { ...params, account: getAddress(params.account) }
  }

  protected gate(): readonly PoolConfigManagerRole[] {
    return ['DEFAULT_ADMIN_ROLE']
  }

  protected override readFacts(
    chain: EVMChain,
    { role, account }: GrantMultiTokenPoolRoleParams,
    ctx: Pick<PoolConfigManagerWriteContext, 'address' | 'version' | 'blockTag'>,
  ): Promise<PoolConfigManagerFacts> {
    return this.roleFact(chain, role, account, ctx)
  }

  override paramsFromCalldata(
    args: Result,
    target: PoolConfigManagerTarget,
    sender: string,
  ): GrantMultiTokenPoolRoleParams {
    return {
      ...target,
      sender,
      role: roleOfId(this.name, args[0]),
      account: getAddress(String(args[1])),
    }
  }

  protected encode(
    _chain: EVMChain,
    { role, account }: GrantMultiTokenPoolRoleParams,
    { address, version, facts }: PoolConfigManagerWriteContext,
  ): PoolConfigManagerWrite {
    const held = facts[rolePath(role, account)] === true
    // as main's token role ops: a write that changes nothing is refused
    if (held === this.grants)
      throw new CCTParamsInvalidError(
        this.name,
        'account',
        this.grants
          ? `already holds ${role} on PoolConfigManager ${address}; granting it again changes nothing`
          : `does not hold ${role} on PoolConfigManager ${address}; revoking it changes nothing`,
      )
    return { data: this.calldata(version, [poolConfigManagerRoleId(role), account]) }
  }
}

/**
 * Grants a PCM role (not `DEFAULT_ADMIN_ROLE`, which moves only by the two-step transfer).
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), the account already
 *   holds the role, or `sender` is not the default admin
 */
export class GrantMultiTokenPoolRole extends RoleGrantOperation {
  readonly name = 'grantMultiTokenPoolRole'
  protected readonly grants = true
}

/**
 * Revokes a PCM role.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), the account does not
 *   hold the role, or `sender` is not the default admin
 */
export class RevokeMultiTokenPoolRole extends RoleGrantOperation {
  readonly name = 'revokeMultiTokenPoolRole'
  protected readonly grants = false
}

/**
 * Renounces one of `sender`'s own roles (`renounceRole(role, sender)`; OZ requires the caller to
 * confirm itself).
 * @throws {@link CCTParamsInvalidError} if a param is invalid or `sender` is missing (before any
 *   RPC), or `sender` does not hold the role
 */
export class RenounceMultiTokenPoolRole extends RoleWriteOperation<RenounceMultiTokenPoolRoleParams> {
  readonly name = 'renounceMultiTokenPoolRole'

  /** Validates the role and requires `sender`, before any RPC. */
  protected override prepare(
    params: RenounceMultiTokenPoolRoleParams,
  ): RenounceMultiTokenPoolRoleParams {
    super.prepare(params)
    validateOneOf(this.name, 'role', params.role, GRANTABLE_ROLES)
    validateAddress(this.name, 'sender', params.sender)
    return params
  }

  // the gate is the role itself: only its holder can renounce it
  protected gate({ role }: RenounceMultiTokenPoolRoleParams): readonly PoolConfigManagerRole[] {
    return [role]
  }

  // the holder's membership, read (the gate pre-flights it too)
  protected override readFacts(
    chain: EVMChain,
    { role, sender }: RenounceMultiTokenPoolRoleParams,
    ctx: Pick<PoolConfigManagerWriteContext, 'address' | 'version' | 'blockTag'>,
  ): Promise<PoolConfigManagerFacts> {
    return this.roleFact(chain, role, sender, ctx)
  }

  override paramsFromCalldata(
    args: Result,
    target: PoolConfigManagerTarget,
    sender: string,
  ): RenounceMultiTokenPoolRoleParams {
    return {
      ...target,
      role: roleOfId(this.name, args[0]),
      sender: renouncedBy(this.name, args[1], sender),
    }
  }

  protected encode(
    _chain: EVMChain,
    { role, sender }: RenounceMultiTokenPoolRoleParams,
    { version }: PoolConfigManagerWriteContext,
  ): PoolConfigManagerWrite {
    return { data: this.calldata(version, [poolConfigManagerRoleId(role), getAddress(sender)]) }
  }
}

/**
 * Renounces the default admin for good: refused unless `confirmPermanentFreeze`, `sender` is the
 * default admin, and a renounce (a transfer to `ZeroAddress`) is scheduled and its delay passed.
 * Role management, pauses and unpauses then freeze forever.
 * @throws {@link CCTParamsInvalidError} if a param is invalid, `sender` is missing or
 *   `confirmPermanentFreeze` is not `true` (before any RPC), `sender` is not the default admin, no
 *   renounce is scheduled, or its delay has not passed
 */
export class RenounceMultiTokenPoolDefaultAdmin extends AdminWriteOperation<RenounceMultiTokenPoolDefaultAdminParams> {
  readonly name = 'renounceMultiTokenPoolDefaultAdmin'

  /** Requires `sender` and `confirmPermanentFreeze: true`, before any RPC. */
  protected override prepare(
    params: RenounceMultiTokenPoolDefaultAdminParams,
  ): RenounceMultiTokenPoolDefaultAdminParams {
    super.prepare(params)
    validateAddress(this.name, 'sender', params.sender)
    if ((params.confirmPermanentFreeze as unknown) !== true)
      throw new CCTParamsInvalidError(
        this.name,
        'confirmPermanentFreeze',
        'must be true: renouncing the default admin freezes role management, pauses and unpauses forever, and cannot be undone',
      )
    return params
  }

  protected gate(): readonly PoolConfigManagerRole[] {
    return ['DEFAULT_ADMIN_ROLE']
  }

  /** The calldata proves the intent, so a re-check confirms the freeze. */
  override paramsFromCalldata(
    args: Result,
    target: PoolConfigManagerTarget,
    sender: string,
  ): RenounceMultiTokenPoolDefaultAdminParams {
    if (String(args[0]) !== poolConfigManagerRoleId('DEFAULT_ADMIN_ROLE'))
      throw new CCTParamsInvalidError(
        this.name,
        'transaction',
        `renounces ${roleOfId(this.name, args[0])}, not the default admin: check it as renounceMultiTokenPoolRole`,
      )
    return {
      ...target,
      sender: renouncedBy(this.name, args[1], sender),
      confirmPermanentFreeze: true,
    }
  }

  protected async encode(
    chain: EVMChain,
    params: RenounceMultiTokenPoolDefaultAdminParams,
    ctx: PoolConfigManagerWriteContext,
  ): Promise<PoolConfigManagerWrite> {
    const admin = adminOf(ctx.facts)
    const block = await chain.provider.getBlock(ctx.blockTag)
    const at = targetParam(params)
    if (admin.pending.schedule === 0n || admin.pending.newAdmin !== ZeroAddress)
      throw new CCTParamsInvalidError(
        this.name,
        at,
        `has no scheduled renounce${admin.pending.schedule === 0n ? '' : ` (a transfer to ${admin.pending.newAdmin} is pending)`}: schedule one with beginMultiTokenPoolDefaultAdminTransfer({ newAdmin: ZeroAddress }), wait ${admin.delay}s, then renounce`,
      )
    // the chain's own check, named before the eth_call: OZ `_hasSchedulePassed` is
    // `schedule < block.timestamp`, so a renounce at the schedule's own second still reverts
    const now = BigInt(block?.timestamp ?? 0)
    if (admin.pending.schedule >= now)
      throw new CCTParamsInvalidError(
        this.name,
        at,
        `the scheduled renounce matures at ${admin.pending.schedule} (unix seconds): send it in a block after that, ${admin.pending.schedule - now + 1n}s from now at the earliest (AccessControlEnforcedDefaultAdminDelay)`,
      )
    return {
      data: this.calldata(ctx.version, [
        poolConfigManagerRoleId('DEFAULT_ADMIN_ROLE'),
        getAddress(params.sender),
      ]),
    }
  }
}

/**
 * Schedules a default admin transfer; `ZeroAddress` schedules a renounce. The pending admin accepts
 * once the delay passed.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), or `sender` is not the
 *   default admin
 */
export class BeginMultiTokenPoolDefaultAdminTransfer extends AdminWriteOperation<BeginMultiTokenPoolDefaultAdminTransferParams> {
  readonly name = 'beginMultiTokenPoolDefaultAdminTransfer'

  /** Validates `newAdmin` (zero allowed: a renounce), before any RPC. */
  protected override prepare(
    params: BeginMultiTokenPoolDefaultAdminTransferParams,
  ): BeginMultiTokenPoolDefaultAdminTransferParams {
    super.prepare(params)
    validateAddress(this.name, 'newAdmin', params.newAdmin)
    return { ...params, newAdmin: getAddress(params.newAdmin) }
  }

  protected gate(): readonly PoolConfigManagerRole[] {
    return ['DEFAULT_ADMIN_ROLE']
  }

  override paramsFromCalldata(
    args: Result,
    target: PoolConfigManagerTarget,
    sender: string,
  ): BeginMultiTokenPoolDefaultAdminTransferParams {
    return { ...target, sender, newAdmin: getAddress(String(args[0])) }
  }

  protected encode(
    _chain: EVMChain,
    { newAdmin }: BeginMultiTokenPoolDefaultAdminTransferParams,
    ctx: PoolConfigManagerWriteContext,
  ): PoolConfigManagerWrite {
    return { data: this.calldata(ctx.version, [newAdmin]) }
  }
}

/**
 * Accepts a default admin transfer, sent by the pending admin. As main's token op: refused when none
 * is pending, when it is a renounce, or when `sender` is not the proposed admin; the schedule's time
 * is left to the chain, so the transaction can be signed before the delay passes.
 * @throws {@link CCTParamsInvalidError} if no transfer is pending, it is a renounce, or `sender` is
 *   not the pending admin
 */
export class AcceptMultiTokenPoolDefaultAdminTransfer extends AdminWriteOperation<AcceptMultiTokenPoolDefaultAdminTransferParams> {
  readonly name = 'acceptMultiTokenPoolDefaultAdminTransfer'

  // the gate is not a role: the pending admin, checked in `encode` (with or without a sender)
  protected gate(): readonly PoolConfigManagerRole[] {
    return []
  }

  protected override async preflight(): Promise<void> {}

  protected encode(
    _chain: EVMChain,
    params: AcceptMultiTokenPoolDefaultAdminTransferParams,
    ctx: PoolConfigManagerWriteContext,
  ): PoolConfigManagerWrite {
    const admin = adminOf(ctx.facts)
    assertDefaultAdminTransferAcceptable(
      this.name,
      targetParam(params),
      admin.pending,
      params.sender,
      'renounceMultiTokenPoolDefaultAdmin',
    )
    return { data: this.calldata(ctx.version, []) }
  }
}

/**
 * Cancels a scheduled default admin transfer (or renounce).
 * @throws {@link CCTParamsInvalidError} if none is scheduled, or `sender` is not the default admin
 */
export class CancelMultiTokenPoolDefaultAdminTransfer extends AdminWriteOperation<CancelMultiTokenPoolDefaultAdminTransferParams> {
  readonly name = 'cancelMultiTokenPoolDefaultAdminTransfer'

  protected gate(): readonly PoolConfigManagerRole[] {
    return ['DEFAULT_ADMIN_ROLE']
  }

  protected encode(
    _chain: EVMChain,
    params: CancelMultiTokenPoolDefaultAdminTransferParams,
    ctx: PoolConfigManagerWriteContext,
  ): PoolConfigManagerWrite {
    assertDefaultAdminTransferPending(this.name, targetParam(params), adminOf(ctx.facts).pending)
    return { data: this.calldata(ctx.version, []) }
  }
}

/**
 * Schedules a default admin delay change (the transfer wait; it does not govern `grantRole`). A
 * longer delay applies after `defaultAdminDelayIncreaseWait`, a shorter one after the difference.
 * @throws {@link CCTParamsInvalidError} if `newDelay` is not a uint48 (before any RPC), or `sender` is
 *   not the default admin
 */
export class ChangeMultiTokenPoolDefaultAdminDelay extends AdminWriteOperation<ChangeMultiTokenPoolDefaultAdminDelayParams> {
  readonly name = 'changeMultiTokenPoolDefaultAdminDelay'

  /** Validates `newDelay` (seconds, a uint48), before any RPC. */
  protected override prepare(
    params: ChangeMultiTokenPoolDefaultAdminDelayParams,
  ): ChangeMultiTokenPoolDefaultAdminDelayParams {
    super.prepare(params)
    validateUint48(this.name, 'newDelay', params.newDelay)
    return params
  }

  protected gate(): readonly PoolConfigManagerRole[] {
    return ['DEFAULT_ADMIN_ROLE']
  }

  override paramsFromCalldata(
    args: Result,
    target: PoolConfigManagerTarget,
    sender: string,
  ): ChangeMultiTokenPoolDefaultAdminDelayParams {
    return { ...target, sender, newDelay: Number(args[0]) }
  }

  protected encode(
    _chain: EVMChain,
    { newDelay }: ChangeMultiTokenPoolDefaultAdminDelayParams,
    ctx: PoolConfigManagerWriteContext,
  ): PoolConfigManagerWrite {
    return { data: this.calldata(ctx.version, [newDelay]) }
  }
}

/**
 * Rolls back a scheduled default admin delay change.
 * @throws {@link CCTParamsInvalidError} if none is scheduled, or `sender` is not the default admin
 */
export class RollbackMultiTokenPoolDefaultAdminDelay extends AdminWriteOperation<RollbackMultiTokenPoolDefaultAdminDelayParams> {
  readonly name = 'rollbackMultiTokenPoolDefaultAdminDelay'

  protected gate(): readonly PoolConfigManagerRole[] {
    return ['DEFAULT_ADMIN_ROLE']
  }

  protected encode(
    _chain: EVMChain,
    params: RollbackMultiTokenPoolDefaultAdminDelayParams,
    ctx: PoolConfigManagerWriteContext,
  ): PoolConfigManagerWrite {
    if (adminOf(ctx.facts).pendingDelay.schedule === 0n)
      throw new CCTParamsInvalidError(
        this.name,
        targetParam(params),
        'has no pending default-admin delay change to roll back',
      )
    return { data: this.calldata(ctx.version, []) }
  }
}
