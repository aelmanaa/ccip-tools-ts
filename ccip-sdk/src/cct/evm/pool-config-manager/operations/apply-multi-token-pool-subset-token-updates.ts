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
} from '../../multi-token-pool/contracts.ts'
import { validateAddress, validateArray, validateUint64 } from '../../validate.ts'
import { type PolicyName, encodePolicyName } from '../contracts.ts'
import { policyKey } from '../projection.ts'
import { readMultiTokenPoolRecordState } from '../record-state.ts'
import {
  type MultiTokenPoolWriteGuards,
  type PoolConfigManagerWrite,
  type PoolConfigManagerWriteContext,
  type PoolConfigManagerWriteParams,
  PoolConfigManagerWriteOperation,
} from '../write-operation.ts'

/** One subset membership: a token in a connection policy record's subset list. */
export type MultiTokenPoolSubsetToken = {
  /** The connection policy. */
  policyName: PolicyName
  /** The record's remote chain. */
  remoteChainSelector: bigint
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
      const seen = new Map<string, string>()
      Array.from(entries as readonly unknown[], (e, i) => {
        const at = `${list}[${i}]`
        const { policyName, remoteChainSelector, tokenAddress } = (e ?? {}) as Record<
          string,
          unknown
        >
        const word = encodePolicyName(this.name, `${at}.policyName`, policyName)
        validateUint64(this.name, `${at}.remoteChainSelector`, remoteChainSelector)
        validateAddress(this.name, `${at}.tokenAddress`, tokenAddress)
        const key = `${word.toLowerCase()}:${String(remoteChainSelector)}:${getAddress(String(tokenAddress))}`
        const first = seen.get(key)
        if (first !== undefined)
          throw new CCTParamsInvalidError(
            this.name,
            at,
            `repeats ${first}: give each membership once`,
          )
        seen.set(key, at)
      })
    }
    if (!params.remove?.length && !params.add?.length)
      throw new CCTParamsInvalidError(this.name, 'add', 'nothing to do: give remove or add')
    return params
  }

  protected gate(): readonly PoolConfigManagerRole[] {
    return ['CONFIG_ROLE', 'POLICY_ROLE', 'CONNECTION_ROLE']
  }

  protected override errorContext(): Record<string, unknown> {
    return { recordType: 'connection' }
  }

  protected async encode(
    chain: EVMChain,
    params: ApplyMultiTokenPoolSubsetTokenUpdatesParams,
    { address, version, blockTag }: PoolConfigManagerWriteContext,
  ): Promise<PoolConfigManagerWrite> {
    const { state } = await readMultiTokenPoolRecordState(chain, address, version, { blockTag })
    const context = { recordType: 'connection' }
    const recordOf = (e: MultiTokenPoolSubsetToken) =>
      state.policies.connection.find(
        (r) =>
          policyKey(r.policyName, 'policyName') === policyKey(e.policyName, 'policyName') &&
          r.remoteChainSelector === e.remoteChainSelector,
      )
    const isMember = (e: MultiTokenPoolSubsetToken) =>
      !!recordOf(e)?.subsetTokens.some((t) => getAddress(t) === getAddress(e.tokenAddress))
    // the store's refusals, named before the eth_call would
    ;(params.remove ?? []).forEach((e, i) => {
      if (!isMember(e))
        throw new CCTParamsInvalidError(
          this.name,
          `remove[${i}]`,
          `${getAddress(e.tokenAddress)} is not in the subset of connection policy ${e.policyName} for chain ${e.remoteChainSelector} (SubsetTokenNotFound)`,
          { context },
        )
    })
    const removed = new Set(
      (params.remove ?? []).map(
        (e) =>
          `${policyKey(e.policyName, 'policyName')}:${e.remoteChainSelector}:${getAddress(e.tokenAddress)}`,
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
      const assigned = state.tokens.find((t) => getAddress(t.tokenAddress) === token)?.policies
        .connection
      if (!assigned || policyKey(assigned, 'policyName') !== policyKey(e.policyName, 'policyName'))
        throw new CCTParamsInvalidError(
          this.name,
          `${at}.tokenAddress`,
          `${token} is not assigned connection policy ${e.policyName} (TokenNotInPolicy): assign it with applyMultiTokenPoolTokenPolicyUpdates({ recordType: 'connection', ... }) first`,
          { context },
        )
      const key = `${policyKey(e.policyName, 'policyName')}:${e.remoteChainSelector}:${token}`
      if (isMember(e) && !removed.has(key))
        throw new CCTParamsInvalidError(
          this.name,
          at,
          `${token} is already in the subset of connection policy ${e.policyName} for chain ${e.remoteChainSelector} (SubsetTokenAlreadyAdded)`,
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
      'applySubsetTokenUpdates',
      [args(params.remove, 'remove'), args(params.add, 'add')],
    )
    // the values the write replaces: each touched membership as it was
    const expected = Object.fromEntries(
      [...(params.remove ?? []), ...(params.add ?? [])].map((e) => [
        `subsets.${policyKey(e.policyName, 'policyName')}:${e.remoteChainSelector}.${getAddress(e.tokenAddress)}`,
        isMember(e),
      ]),
    )
    return { data, expected }
  }
}
