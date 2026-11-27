/**
 * applyMultiTokenPoolSubsetTokenUpdates — adds tokens to, and removes them from, the subset lists of
 * connection policy records with `onlySubsetTokens`.
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

import type { EVMChain } from '../../../../evm/index.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import {
  type PoolConfigManagerRole,
  POOL_CONFIG_MANAGER_TYPE,
  getMultiTokenPoolInterface,
  multiTokenPoolFunctionOf,
  policyRolesGate,
} from '../../multi-token-pool/contracts.ts'
import { assertUnique, validateAddress, validateArray } from '../../validate.ts'
import type { DecodedMultiTokenPoolWrite } from '../calldata.ts'
import { encodePolicyName, validatePolicyRecordKey } from '../contracts.ts'
import {
  type MultiTokenPoolRecordState,
  policyKey,
  recordKey,
  subsetKey,
  tokenRecordsOf,
} from '../projection.ts'
import type { PolicyRecordKey } from '../records.ts'
import {
  type MultiTokenPoolWriteGuards,
  type PoolConfigManagerWrite,
  type PoolConfigManagerWriteContext,
  type PoolConfigManagerWriteParams,
  PoolConfigManagerWriteOperation,
} from '../write-operation.ts'

/** One subset membership: a token in a connection policy record's subset list. */
export type MultiTokenPoolSubsetToken = PolicyRecordKey & {
  /** The token. */
  tokenAddress: string
}

/** Parameters of `applyMultiTokenPoolSubsetTokenUpdates`. Removals run first, as on chain. */
export type ApplyMultiTokenPoolSubsetTokenUpdatesParams = PoolConfigManagerWriteParams &
  MultiTokenPoolWriteGuards & {
    /** Memberships to remove. */
    remove?: MultiTokenPoolSubsetToken[]
    /** Memberships to add: the record must exist and the token be assigned to the policy. */
    add?: MultiTokenPoolSubsetToken[]
  }

/**
 * Writes subset memberships. An add opens the token's lane on that chain, so it runs every lane
 * guard (and `confirmOpening`).
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), the store would refuse
 *   (no such record, a token not in the policy, a membership missing or already there), `sender`
 *   lacks the gate, or a lane guard refuses; `context.recordType` is `'connection'`
 */
export class ApplyMultiTokenPoolSubsetTokenUpdates extends PoolConfigManagerWriteOperation<ApplyMultiTokenPoolSubsetTokenUpdatesParams> {
  readonly name = 'applyMultiTokenPoolSubsetTokenUpdates'

  protected override prepare(
    params: ApplyMultiTokenPoolSubsetTokenUpdatesParams,
  ): ApplyMultiTokenPoolSubsetTokenUpdatesParams {
    super.prepare(params)
    for (const list of ['remove', 'add'] as const) {
      const entries = params[list]
      if (entries === undefined) continue
      validateArray(this.name, list, entries)
      const keys = Array.from(entries as readonly unknown[], (e, i) => {
        const at = `${list}[${i}]`
        const record = validatePolicyRecordKey(this.name, at, e)
        const { tokenAddress } = (e ?? {}) as Record<string, unknown>
        validateAddress(this.name, `${at}.tokenAddress`, tokenAddress)
        return `${record}:${getAddress(String(tokenAddress))}`
      })
      assertUnique(this.name, list, keys, (k) => k, 'membership')
    }
    if (!params.remove?.length && !params.add?.length)
      throw new CCTParamsInvalidError(this.name, 'add', 'nothing to do: give remove or add')
    return params
  }

  protected gate(): readonly PoolConfigManagerRole[] {
    return policyRolesGate('connection')
  }

  protected override errorContext(): Record<string, unknown> {
    return { recordType: 'connection' }
  }

  protected async encode(
    chain: EVMChain,
    params: ApplyMultiTokenPoolSubsetTokenUpdatesParams,
    { version, state }: PoolConfigManagerWriteContext,
  ): Promise<PoolConfigManagerWrite> {
    const context = { recordType: 'connection' }
    const recordOf = (e: MultiTokenPoolSubsetToken) => subsetRecordOf(state, e)
    const isMember = (e: MultiTokenPoolSubsetToken) => subsetMember(state, e, e.tokenAddress)
    // the store's refusals, named before the eth_call would
    ;(params.remove ?? []).forEach((e, i) => {
      if (!isMember(e))
        throw new CCTParamsInvalidError(
          this.name,
          `remove[${i}]`,
          `${getAddress(e.tokenAddress)} is not in the subset of connection policy ${e.policyName} for chain ${e.remoteChainSelector} (SubsetTokenNotFound): drop it from remove (getMultiTokenPoolSubsetTokens lists the subset)`,
          { context },
        )
    })
    const removed = new Set(
      (params.remove ?? []).map((e) =>
        subsetKey(e.policyName, e.remoteChainSelector, e.tokenAddress),
      ),
    )
    ;(params.add ?? []).forEach((e, i) => {
      const at = `add[${i}]`
      const token = getAddress(e.tokenAddress)
      if (!recordOf(e))
        throw new CCTParamsInvalidError(
          this.name,
          at,
          `connection policy ${e.policyName} has no record for chain ${e.remoteChainSelector} (PolicyRecordNotFound): set it with applyMultiTokenPoolConnectionPolicyConfigUpdates first`,
          { context },
        )
      const assigned = tokenRecordsOf(state, token)?.policies.connection
      if (!assigned || policyKey(assigned, 'policyName') !== policyKey(e.policyName, 'policyName'))
        throw new CCTParamsInvalidError(
          this.name,
          `${at}.tokenAddress`,
          `${token} is not assigned connection policy ${e.policyName} (TokenNotInPolicy): assign it with applyMultiTokenPoolTokenPolicyUpdates({ recordType: 'connection', ... }) first`,
          { context },
        )
      const key = subsetKey(e.policyName, e.remoteChainSelector, token)
      if (isMember(e) && !removed.has(key))
        throw new CCTParamsInvalidError(
          this.name,
          at,
          `${token} is already in the subset of connection policy ${e.policyName} for chain ${e.remoteChainSelector} (SubsetTokenAlreadyAdded): it is already a member; drop it from add`,
          { context },
        )
    })
    const args = (list: MultiTokenPoolSubsetToken[] = [], name: string) =>
      list.map((e, i) => [
        encodePolicyName(this.name, `${name}[${i}].policyName`, e.policyName),
        e.remoteChainSelector,
        getAddress(e.tokenAddress),
      ])
    const data = getMultiTokenPoolInterface(POOL_CONFIG_MANAGER_TYPE, version).encodeFunctionData(
      multiTokenPoolFunctionOf(this.name),
      [args(params.remove, 'remove'), args(params.add, 'add')],
    )
    return { data }
  }

  /** Each subset membership the calldata adds or removes, as it was. */
  protected sealedFrom(
    _chain: EVMChain,
    { changes }: DecodedMultiTokenPoolWrite,
    { state }: PoolConfigManagerWriteContext,
  ): Record<string, unknown> {
    return Object.fromEntries(
      changes.flatMap((c) =>
        c.kind === 'updateSubsetTokens'
          ? [...(c.remove ?? []), ...(c.add ?? [])].map((t) => [
              `subsets.${recordKey(c.policyName, c.remoteChainSelector)}.${getAddress(t)}`,
              subsetMember(state, c, t),
            ])
          : [],
      ),
    )
  }
}

/** The connection policy record `key` names, as stored. */
function subsetRecordOf(state: MultiTokenPoolRecordState, key: PolicyRecordKey) {
  return state.policies.connection.find(
    (r) =>
      policyKey(r.policyName, 'policyName') === policyKey(key.policyName, 'policyName') &&
      r.remoteChainSelector === key.remoteChainSelector,
  )
}

/** Whether `token` is in the subset of the connection policy record `key`. */
function subsetMember(
  state: MultiTokenPoolRecordState,
  key: PolicyRecordKey,
  token: string,
): boolean {
  return !!subsetRecordOf(state, key)?.subsetTokens.some((t) => getAddress(t) === getAddress(token))
}
