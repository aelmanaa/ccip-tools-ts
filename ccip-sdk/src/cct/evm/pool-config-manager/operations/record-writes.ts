/**
 * What every inline and policy record write shares: param validation before any RPC, and the stores'
 * own bookkeeping refusals named before the `eth_call` would (chainlink-ccip c950d9bc `PolicyConfig`
 * `_setPolicyRecord`, `_removePolicyRecord`, `_removePolicy`, `_setInlineRecord`, `_removeInlineRecord`).
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

import type { LaneRecordType } from '../../../../chain.ts'
import type { EVMChain } from '../../../../evm/index.ts'
import { LANE_RECORD_TYPES } from '../../../../evm/multi-token-pool.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import {
  type MultiTokenPoolSingleFunctionOperation,
  type PoolConfigManagerRole,
  POOL_CONFIG_MANAGER_TYPE,
  TOKEN_POLICY_ROLES,
  getMultiTokenPoolInterface,
  multiTokenPoolFunctionOf,
} from '../../multi-token-pool/contracts.ts'
import { assertUnique, validateArray, validateUint64 } from '../../validate.ts'
import {
  type MultiTokenPoolLaneKey,
  type PolicyName,
  encodePolicyName,
  toAbiLaneKey,
  validateLaneKeys,
} from '../contracts.ts'
import { type MultiTokenPoolRecordState, laneKey, policyKey, recordKey } from '../projection.ts'
import type { PolicyRecordKey, PolicyRemovalOptions } from '../records.ts'
import {
  type MultiTokenPoolWriteGuards,
  type PoolConfigManagerWrite,
  type PoolConfigManagerWriteContext,
  type PoolConfigManagerWriteParams,
  PoolConfigManagerWriteOperation,
} from '../write-operation.ts'

/**
 * The policy names of one record type from a `getPolicyNames` result (one list per type, in
 * `LANE_RECORD_TYPES` order), as lower-case words.
 * @internal
 */
export function policyNamesOf(lists: readonly unknown[], type: LaneRecordType): Set<string> {
  return new Set(
    ((lists[LANE_RECORD_TYPES.indexOf(type)] ?? []) as string[]).map((w) => w.toLowerCase()),
  )
}

/** The removal and set lists of a policy record write. @internal */
export type PolicyRecordWrite = {
  /** Records to remove (first, as on chain). */
  recordsToRemove?: PolicyRecordKey[]
  /** Whole policies to remove (after the records; each needs no token and no record left). */
  policiesToRemove?: PolicyName[]
  /** Records to set (last). */
  recordsToSet?: PolicyRecordKey[]
}

/**
 * Validates a policy record write's lists before any RPC: names, selectors (no default record where
 * the type has none), duplicates within a list, and at least one entry overall.
 * @internal
 */
export function validatePolicyRecordWrite(
  operation: string,
  { recordsToRemove, policiesToRemove, recordsToSet }: PolicyRecordWrite,
  { allowDefault }: { allowDefault: boolean },
): void {
  const keys = (list: unknown, param: string) => {
    validateArray(operation, param, list)
    const words = Array.from(list, (k, i) => {
      const { policyName, remoteChainSelector } = (k ?? {}) as Record<string, unknown>
      const word = encodePolicyName(operation, `${param}[${i}].policyName`, policyName)
      validateUint64(operation, `${param}[${i}].remoteChainSelector`, remoteChainSelector)
      if (!allowDefault && remoteChainSelector === 0n)
        throw new CCTParamsInvalidError(
          operation,
          `${param}[${i}].remoteChainSelector`,
          'is 0: this record type has no default record; give a remote chain (ZeroChainSelectorNotAllowed)',
        )
      return `${word.toLowerCase()}:${String(remoteChainSelector)}`
    })
    assertUnique(operation, param, words, (w) => w, 'record')
  }
  if (recordsToRemove !== undefined) keys(recordsToRemove, 'recordsToRemove')
  if (recordsToSet !== undefined) keys(recordsToSet, 'recordsToSet')
  if (policiesToRemove !== undefined) {
    validateArray(operation, 'policiesToRemove', policiesToRemove)
    const words = Array.from(policiesToRemove, (n, i) =>
      encodePolicyName(operation, `policiesToRemove[${i}]`, n).toLowerCase(),
    )
    assertUnique(operation, 'policiesToRemove', words, (w) => w, 'policy')
  }
  if (!recordsToRemove?.length && !policiesToRemove?.length && !recordsToSet?.length)
    throw new CCTParamsInvalidError(
      operation,
      'recordsToSet',
      'nothing to do: give recordsToRemove, policiesToRemove or recordsToSet',
    )
}

/**
 * Refuses what the store refuses for a policy record write of `type`, from the state at the build
 * block: a removed record that does not exist, a removed policy that does not exist, still has tokens
 * (`PolicyInUse`) or keeps records after the removals (`PolicyHasRecords`).
 * @internal
 */
export function checkPolicyRecordWrite(
  operation: string,
  { state, policyNames }: Pick<RecordWriteContext, 'state' | 'policyNames'>,
  type: LaneRecordType,
  { recordsToRemove = [], policiesToRemove = [] }: PolicyRecordWrite,
): void {
  const records = state.policies[type] as readonly PolicyRecordKey[]
  const key = (k: PolicyRecordKey) => recordKey(k.policyName, k.remoteChainSelector)
  const stored = new Set(records.map(key))
  recordsToRemove.forEach((k, i) => {
    if (!stored.has(key(k)))
      throw new CCTParamsInvalidError(
        operation,
        `recordsToRemove[${i}]`,
        `${type} policy ${k.policyName} has no record for chain ${k.remoteChainSelector} (PolicyRecordNotFound): drop it from recordsToRemove (getMultiTokenPool${type[0]!.toUpperCase()}${type.slice(1)}Policy lists the records)`,
        { context: { recordType: type } },
      )
  })
  if (!policiesToRemove.length) return
  const names = policyNames[type]
  const removed = new Set(recordsToRemove.map(key))
  policiesToRemove.forEach((name, i) => {
    const word = policyKey(name, `policiesToRemove[${i}]`)
    const param = `policiesToRemove[${i}]`
    if (!names.has(word))
      throw new CCTParamsInvalidError(
        operation,
        param,
        `no ${type} policy ${name} exists (PolicyNotFound): check the name (getMultiTokenPoolPolicyNames)`,
        {
          context: { recordType: type },
        },
      )
    const tokens = state.tokens.filter((t) => {
      const p = t.policies[type]
      return p !== null && policyKey(p, 'policyName') === word
    })
    if (tokens.length)
      throw new CCTParamsInvalidError(
        operation,
        param,
        `${type} policy ${name} still has ${tokens.length} token(s) (PolicyInUse): clear their assignments with applyMultiTokenPoolTokenPolicyUpdates({ recordType: '${type}', assignments: [{ tokenAddress, policyName: null }] }) first`,
        { context: { recordType: type, tokens: tokens.map((t) => t.tokenAddress) } },
      )
    const left = records.filter(
      (r) => policyKey(r.policyName, 'policyName') === word && !removed.has(key(r)),
    )
    if (left.length)
      throw new CCTParamsInvalidError(
        operation,
        param,
        `${type} policy ${name} keeps records for ${left.map((r) => r.remoteChainSelector).join(', ')} (PolicyHasRecords): remove them in recordsToRemove of the same call`,
        { context: { recordType: type } },
      )
  })
}

/** The removal and set lists of an inline record write. @internal */
export type InlineRecordWrite = {
  /** Lanes whose inline record to remove (first, as on chain). */
  remove?: MultiTokenPoolLaneKey[]
  /** Records to set (after the removals). */
  set?: MultiTokenPoolLaneKey[]
}

/**
 * Validates an inline record write's lanes before any RPC: valid keys, no lane twice in one list, a
 * non-zero chain for a set, and at least one entry.
 * @internal
 */
export function validateInlineRecordWrite(
  operation: string,
  { remove, set }: InlineRecordWrite,
): void {
  for (const [param, list] of [
    ['remove', remove],
    ['set', set],
  ] as const) {
    if (list === undefined) continue
    validateLaneKeys(operation, param, list, 0)
    list.forEach((l, i) => {
      if (param === 'set' && l.remoteChainSelector === 0n)
        throw new CCTParamsInvalidError(
          operation,
          `set[${i}].remoteChainSelector`,
          'is 0: an inline record is for one remote chain (ZeroChainSelectorNotAllowed)',
        )
    })
    assertUnique(
      operation,
      param,
      list,
      (l) => laneKey(l.tokenAddress, l.remoteChainSelector),
      'lane',
    )
  }
  if (!remove?.length && !set?.length)
    throw new CCTParamsInvalidError(operation, 'set', 'nothing to do: give remove or set')
}

/**
 * Refuses what the store refuses for an inline record write of `type`: removing a record that does
 * not exist, or setting one on an unregistered token (`LocalTokenNotRegistered`).
 * @internal
 */
export function checkInlineRecordWrite(
  operation: string,
  state: MultiTokenPoolRecordState,
  type: LaneRecordType,
  { remove = [], set = [] }: InlineRecordWrite,
): void {
  const tokenOf = (t: string) =>
    state.tokens.find((r) => getAddress(r.tokenAddress) === getAddress(t))
  remove.forEach((l, i) => {
    const records = tokenOf(l.tokenAddress)?.inline[type] ?? []
    if (!records.some((r) => r.remoteChainSelector === l.remoteChainSelector))
      throw new CCTParamsInvalidError(
        operation,
        `remove[${i}]`,
        `${getAddress(l.tokenAddress)} has no inline ${type} record for chain ${l.remoteChainSelector} (InlineRecordNotFound): drop it from remove (getMultiTokenPoolInlineConfigs lists the records)`,
        { context: { recordType: type } },
      )
  })
  set.forEach((l, i) => {
    if (!tokenOf(l.tokenAddress))
      throw new CCTParamsInvalidError(
        operation,
        `set[${i}].tokenAddress`,
        `${getAddress(l.tokenAddress)} is not registered (LocalTokenNotRegistered): register it with applyMultiTokenPoolTokenProfileUpdates first`,
        { context: { recordType: type } },
      )
  })
}

/** The record lists every policy record write takes (the shape its params extend). @internal */
export type PolicyRecordWriteParams<R extends PolicyRecordKey> = PoolConfigManagerWriteParams &
  MultiTokenPoolWriteGuards &
  PolicyRemovalOptions & {
    /** Records to remove (first, as on chain). */
    recordsToRemove?: PolicyRecordKey[]
    /** Records to set; a set replaces the record. */
    recordsToSet?: R[]
  }

/** The context a record write's own state checks get: the write context. @internal */
export type RecordWriteContext = PoolConfigManagerWriteContext

/**
 * Base of the policy record writes (`apply<Type>PolicyConfigUpdates`): the lists are validated before
 * any RPC, the stores' bookkeeping refusals are named from the state at the build block, and the
 * replaced records are sealed in the snapshot. A subclass supplies the record type, its role, and the
 * validation and encoding of one record.
 * @internal
 */
export abstract class PolicyRecordWriteOperation<
  R extends PolicyRecordKey,
  P extends PolicyRecordWriteParams<R> = PolicyRecordWriteParams<R>,
> extends PoolConfigManagerWriteOperation<P> {
  /** The record type the policies are of. */
  protected abstract readonly recordType: LaneRecordType
  /** The op; its PCM function comes from the op map. */
  abstract override readonly name: MultiTokenPoolSingleFunctionOperation
  /** Whether the type has a default record (chain `0n`). */
  protected abstract readonly allowDefault: boolean

  /** Validates one record to set before any RPC, and returns it canonical (what `encodeRecord` gets). */
  protected abstract parseRecord(params: P, record: R, at: string): R

  /** Encodes one parsed record to set as the ABI struct. */
  protected abstract encodeRecord(record: R, word: string): unknown

  /** Further refusals from the state (or other reads), for a type with its own rules. */
  protected async checkState(
    _chain: EVMChain,
    _params: P,
    _ctx: RecordWriteContext,
  ): Promise<void> {}

  protected override prepare(params: P): P {
    super.prepare(params)
    validatePolicyRecordWrite(this.name, params, { allowDefault: this.allowDefault })
    return params.recordsToSet
      ? {
          ...params,
          recordsToSet: params.recordsToSet.map((r, i) =>
            this.parseRecord(params, r, `recordsToSet[${i}]`),
          ),
        }
      : params
  }

  protected gate(): readonly PoolConfigManagerRole[] {
    return ['CONFIG_ROLE', 'POLICY_ROLE', TOKEN_POLICY_ROLES[this.recordType]]
  }

  protected override errorContext(): Record<string, unknown> {
    return { recordType: this.recordType }
  }

  protected async encode(
    chain: EVMChain,
    params: P,
    ctx: PoolConfigManagerWriteContext,
  ): Promise<PoolConfigManagerWrite> {
    const { state, version } = ctx
    checkPolicyRecordWrite(this.name, ctx, this.recordType, params)
    await this.checkState(chain, params, ctx)
    const word = (name: PolicyName, at: string) => encodePolicyName(this.name, at, name)
    const remove = (params.recordsToRemove ?? []).map((k, i) => [
      word(k.policyName, `recordsToRemove[${i}].policyName`),
      k.remoteChainSelector,
    ])
    const policies = (params.policiesToRemove ?? []).map((n, i) =>
      word(n, `policiesToRemove[${i}]`),
    )
    const set = (params.recordsToSet ?? []).map((r, i) =>
      this.encodeRecord(r, word(r.policyName, `recordsToSet[${i}].policyName`)),
    )
    const data = getMultiTokenPoolInterface(POOL_CONFIG_MANAGER_TYPE, version).encodeFunctionData(
      multiTokenPoolFunctionOf(this.name),
      [remove, policies, set],
    )
    // the values the write replaces: each touched record as stored (absent: `null`)
    const stored = state.policies[this.recordType] as readonly PolicyRecordKey[]
    const keyOf = (k: PolicyRecordKey) => recordKey(k.policyName, k.remoteChainSelector)
    const expected = Object.fromEntries(
      [...(params.recordsToRemove ?? []), ...(params.recordsToSet ?? [])].map((k) => [
        `policies.${this.recordType}.${keyOf(k)}`,
        stored.find((s) => keyOf(s) === keyOf(k)) ?? null,
      ]),
    )
    return { data, expected }
  }
}

/** The record lists every inline record write takes (the shape its params extend). @internal */
export type InlineRecordWriteParams<R extends MultiTokenPoolLaneKey> =
  PoolConfigManagerWriteParams &
    MultiTokenPoolWriteGuards & {
      /** Lanes whose inline record to remove (first, as on chain). */
      remove?: MultiTokenPoolLaneKey[]
      /** Records to set; a set replaces the lane's record. */
      set?: R[]
    }

/**
 * Base of the inline record writes (`applyInline<Type>ConfigUpdates`): the lanes are validated before
 * any RPC, the stores' bookkeeping refusals are named from the state at the build block, and the
 * replaced records are sealed in the snapshot. A subclass supplies the record type, its role, and the
 * validation and encoding of one record.
 * @internal
 */
export abstract class InlineRecordWriteOperation<
  R extends MultiTokenPoolLaneKey,
  P extends InlineRecordWriteParams<R> = InlineRecordWriteParams<R>,
> extends PoolConfigManagerWriteOperation<P> {
  /** The record type. */
  protected abstract readonly recordType: LaneRecordType
  /** The op; its PCM function comes from the op map. */
  abstract override readonly name: MultiTokenPoolSingleFunctionOperation

  /** Validates one record to set before any RPC, and returns it canonical (what `encodeRecord` gets). */
  protected abstract parseRecord(params: P, record: R, at: string): R

  /** Encodes one parsed record to set as the ABI struct. */
  protected abstract encodeRecord(record: R): unknown

  /** Further refusals from the state (or other reads), for a type with its own rules. */
  protected async checkState(
    _chain: EVMChain,
    _params: P,
    _ctx: RecordWriteContext,
  ): Promise<void> {}

  protected override prepare(params: P): P {
    super.prepare(params)
    validateInlineRecordWrite(this.name, params)
    return params.set
      ? { ...params, set: params.set.map((r, i) => this.parseRecord(params, r, `set[${i}]`)) }
      : params
  }

  protected gate(): readonly PoolConfigManagerRole[] {
    return ['CONFIG_ROLE', 'TOKEN_MANAGER_ROLE', TOKEN_POLICY_ROLES[this.recordType]]
  }

  protected override errorContext(): Record<string, unknown> {
    return { recordType: this.recordType }
  }

  protected async encode(
    chain: EVMChain,
    params: P,
    ctx: PoolConfigManagerWriteContext,
  ): Promise<PoolConfigManagerWrite> {
    const { state, version } = ctx
    checkInlineRecordWrite(this.name, state, this.recordType, params)
    await this.checkState(chain, params, ctx)
    const data = getMultiTokenPoolInterface(POOL_CONFIG_MANAGER_TYPE, version).encodeFunctionData(
      multiTokenPoolFunctionOf(this.name),
      [
        (params.remove ?? []).map(toAbiLaneKey),
        (params.set ?? []).map((r) => this.encodeRecord(r)),
      ],
    )
    // the values the write replaces: each touched lane's inline record (absent: `null`)
    const current = (l: MultiTokenPoolLaneKey) =>
      (
        state.tokens.find((t) => getAddress(t.tokenAddress) === getAddress(l.tokenAddress))?.inline[
          this.recordType
        ] as readonly MultiTokenPoolLaneKey[] | undefined
      )?.find((r) => r.remoteChainSelector === l.remoteChainSelector) ?? null
    const expected = Object.fromEntries(
      [...(params.remove ?? []), ...(params.set ?? [])].map((l) => [
        `inline.${this.recordType}.${laneKey(l.tokenAddress, l.remoteChainSelector)}`,
        current(l),
      ]),
    )
    return { data, expected }
  }
}
