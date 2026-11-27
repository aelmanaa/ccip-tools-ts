/**
 * applyMultiTokenPoolConnectionPolicyConfigUpdates — sets and removes connection policy records, and
 * removes whole connection policies.
 *
 * @packageDocumentation
 */

import type { EVMChain } from '../../../../evm/index.ts'
import { ChainFamily } from '../../../../networks.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { laneFamilyOf } from '../../../remote-address.ts'
import { SAME_ADDRESS_PROVIDER_TYPE } from '../../multi-token-pool/contracts.ts'
import { readContractTypeOrNull } from '../../query.ts'
import { validateBoolean } from '../../validate.ts'
import { policyKey } from '../projection.ts'
import type { ConnectionPolicyRecord, PolicyRecordKey, PolicyRemovalOptions } from '../records.ts'
import type { MultiTokenPoolWriteGuards, PoolConfigManagerWriteParams } from '../write-operation.ts'
import { type RecordWriteContext, PolicyRecordWriteOperation } from './record-writes.ts'

/** Parameters of `applyMultiTokenPoolConnectionPolicyConfigUpdates`. */
export type ApplyMultiTokenPoolConnectionPolicyConfigUpdatesParams = PoolConfigManagerWriteParams &
  MultiTokenPoolWriteGuards &
  PolicyRemovalOptions & {
    /** Records to remove (first, as on chain). */
    recordsToRemove?: PolicyRecordKey[]
    /** Records to set; a set replaces the record. */
    recordsToSet?: ConnectionPolicyRecord[]
    /**
     * Accept a record with `onlySubsetTokens: false`, which opens its chain to every current and
     * future token of the policy. Defaults to `false`.
     */
    openToAllPolicyTokens?: boolean
  }

/**
 * Writes connection policy records.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), the store would refuse
 *   (a missing record or policy, a policy in use or with records left), `sender` lacks the gate, or a
 *   lane guard refuses; `context.recordType` is `'connection'`
 */
export class ApplyMultiTokenPoolConnectionPolicyConfigUpdates extends PolicyRecordWriteOperation<
  ConnectionPolicyRecord,
  ApplyMultiTokenPoolConnectionPolicyConfigUpdatesParams
> {
  readonly name = 'applyMultiTokenPoolConnectionPolicyConfigUpdates'
  protected readonly recordType = 'connection'
  protected readonly allowDefault = false

  protected parseRecord(
    params: ApplyMultiTokenPoolConnectionPolicyConfigUpdatesParams,
    record: ConnectionPolicyRecord,
    at: string,
  ): ConnectionPolicyRecord {
    validateBoolean(this.name, `${at}.onlySubsetTokens`, record.onlySubsetTokens)
    if (!record.onlySubsetTokens && params.openToAllPolicyTokens !== true)
      throw new CCTParamsInvalidError(
        this.name,
        `${at}.onlySubsetTokens`,
        `is false, which opens chain ${record.remoteChainSelector} to every current and future token of policy ${record.policyName}: pass openToAllPolicyTokens: true to confirm, or list the tokens with applyMultiTokenPoolSubsetTokenUpdates`,
        { context: { recordType: 'connection' } },
      )
    return record
  }

  /** Validates `openToAllPolicyTokens` once, then the record lists. */
  protected override prepare(
    params: ApplyMultiTokenPoolConnectionPolicyConfigUpdatesParams,
  ): ApplyMultiTokenPoolConnectionPolicyConfigUpdatesParams {
    if (params.openToAllPolicyTokens !== undefined)
      validateBoolean(this.name, 'openToAllPolicyTokens', params.openToAllPolicyTokens)
    return super.prepare(params)
  }

  /**
   * A record for a non-EVM chain on a policy whose provider answers the local token's own address: the
   * provider's answer is not an address of that chain.
   */
  protected override async checkState(
    chain: EVMChain,
    { recordsToSet = [] }: ApplyMultiTokenPoolConnectionPolicyConfigUpdatesParams,
    { state }: RecordWriteContext,
  ): Promise<void> {
    for (const [i, r] of recordsToSet.entries()) {
      if (laneFamilyOf(r.remoteChainSelector) === ChainFamily.EVM) continue
      const word = policyKey(r.policyName, 'policyName')
      const provider = state.policies.remoteTokenAddressProviders.find(
        (p) => policyKey(p.policyName, 'policyName') === word,
      )?.provider
      if (!provider) continue
      const type = await readContractTypeOrNull(chain, provider)
      if (type === SAME_ADDRESS_PROVIDER_TYPE)
        throw new CCTParamsInvalidError(
          this.name,
          `recordsToSet[${i}].remoteChainSelector`,
          `connection policy ${r.policyName} answers remote tokens with a same-address provider, which is no address of non-EVM chain ${r.remoteChainSelector}: give that chain's lanes inline remote tokens, or set another provider first`,
          { context: { recordType: 'connection' } },
        )
    }
  }

  protected encodeRecord(record: ConnectionPolicyRecord, word: string): unknown {
    return [word, record.remoteChainSelector, record.onlySubsetTokens]
  }
}
