/**
 * applyMultiTokenPoolRemoteTokenAddressProviderUpdates — sets or clears the remote token address
 * provider of connection policies.
 *
 * @packageDocumentation
 */

import { ZeroAddress, getAddress } from 'ethers'

import type { EVMChain } from '../../../../evm/index.ts'
import { ChainFamily } from '../../../../networks.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { laneFamilyOf } from '../../../remote-address.ts'
import {
  type PoolConfigManagerRole,
  POOL_CONFIG_MANAGER_TYPE,
  TOKEN_POLICY_ROLES,
  getMultiTokenPoolInterface,
  multiTokenPoolFunctionOf,
} from '../../multi-token-pool/contracts.ts'
import { readContractTypeOrNull } from '../../query.ts'
import { assertUnique, validateAddress, validateArray } from '../../validate.ts'
import { type PolicyName, assertProviderHasCode, encodePolicyName } from '../contracts.ts'
import { policyKey } from '../projection.ts'
import {
  type MultiTokenPoolWriteGuards,
  type PoolConfigManagerWrite,
  type PoolConfigManagerWriteContext,
  type PoolConfigManagerWriteParams,
  PoolConfigManagerWriteOperation,
} from '../write-operation.ts'

/** A remote token address provider assignment. */
export type MultiTokenPoolRemoteTokenAddressProviderUpdate = {
  /** The connection policy. */
  policyName: PolicyName
  /** The provider, or `null` to clear it (each policy lane then needs an inline remote token). */
  remoteTokenAddressProvider: string | null
}

/** Parameters of `applyMultiTokenPoolRemoteTokenAddressProviderUpdates`. */
export type ApplyMultiTokenPoolRemoteTokenAddressProviderUpdatesParams =
  PoolConfigManagerWriteParams &
    MultiTokenPoolWriteGuards & {
      /** The updates, at least one; each policy at most once. */
      updates: MultiTokenPoolRemoteTokenAddressProviderUpdate[]
    }

/** The provider that answers the local token's own address (chainlink-ccip c950d9bc). @internal */
export const SAME_ADDRESS_PROVIDER_TYPE = 'SameAddressRemoteTokenAddressProvider'

/**
 * Sets connection policies' remote token address providers. A provider answers the remote token of
 * every policy lane at once, so every lane of the policy is judged again.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), the policy does not
 *   exist, the provider has no code, a same-address provider serves a non-EVM chain, `sender` lacks
 *   the gate, or a lane guard refuses; `context.recordType` is `'connection'`
 */
export class ApplyMultiTokenPoolRemoteTokenAddressProviderUpdates extends PoolConfigManagerWriteOperation<ApplyMultiTokenPoolRemoteTokenAddressProviderUpdatesParams> {
  readonly name = 'applyMultiTokenPoolRemoteTokenAddressProviderUpdates'

  protected override prepare(
    params: ApplyMultiTokenPoolRemoteTokenAddressProviderUpdatesParams,
  ): ApplyMultiTokenPoolRemoteTokenAddressProviderUpdatesParams {
    super.prepare(params)
    validateArray(this.name, 'updates', params.updates, 1)
    const words = Array.from(params.updates as readonly unknown[], (u, i) => {
      const at = `updates[${i}]`
      const { policyName, remoteTokenAddressProvider } = (u ?? {}) as Record<string, unknown>
      const word = encodePolicyName(this.name, `${at}.policyName`, policyName).toLowerCase()
      if (remoteTokenAddressProvider !== null) {
        validateAddress(this.name, `${at}.remoteTokenAddressProvider`, remoteTokenAddressProvider)
        if (getAddress(remoteTokenAddressProvider as string) === ZeroAddress)
          throw new CCTParamsInvalidError(
            this.name,
            `${at}.remoteTokenAddressProvider`,
            'is the zero address: pass remoteTokenAddressProvider: null to clear the provider',
          )
      }
      return word
    })
    assertUnique(this.name, 'updates', words, (w) => w, 'policy')
    return params
  }

  protected gate(): readonly PoolConfigManagerRole[] {
    return ['CONFIG_ROLE', 'POLICY_ROLE', TOKEN_POLICY_ROLES.connection]
  }

  protected override errorContext(): Record<string, unknown> {
    return { recordType: 'connection' }
  }

  protected async encode(
    chain: EVMChain,
    { updates }: ApplyMultiTokenPoolRemoteTokenAddressProviderUpdatesParams,
    { version, blockTag, state, policyNames }: PoolConfigManagerWriteContext,
  ): Promise<PoolConfigManagerWrite> {
    const names = policyNames.connection
    const context = { recordType: 'connection' }
    for (const [i, u] of updates.entries()) {
      const at = `updates[${i}]`
      const word = policyKey(u.policyName, `${at}.policyName`)
      if (!names.has(word))
        throw new CCTParamsInvalidError(
          this.name,
          `${at}.policyName`,
          `no connection policy ${u.policyName} exists (PolicyNotFound): check the name (getMultiTokenPoolPolicyNames)`,
          { context },
        )
      const provider = u.remoteTokenAddressProvider
      if (provider === null) continue
      await assertProviderHasCode(
        this.name,
        chain,
        `${at}.remoteTokenAddressProvider`,
        provider,
        blockTag,
        'deploy the provider first, or pass null to clear it',
        context,
      )
      const type = await readContractTypeOrNull(chain, provider)
      // the local token's own address is a remote token only where addresses are EVM's
      const nonEvm = state.policies.connection
        .filter((r) => policyKey(r.policyName, 'policyName') === word)
        .map((r) => r.remoteChainSelector)
        .filter((c) => laneFamilyOf(c) !== ChainFamily.EVM)
      if (type === SAME_ADDRESS_PROVIDER_TYPE && nonEvm.length)
        throw new CCTParamsInvalidError(
          this.name,
          `${at}.remoteTokenAddressProvider`,
          `is a same-address provider, but connection policy ${u.policyName} has records for non-EVM chains ${nonEvm.join(', ')}, where the local token's address is not a remote token: give those lanes inline remote tokens, or use another provider`,
          { context: { ...context, chains: nonEvm } },
        )
    }
    const data = getMultiTokenPoolInterface(POOL_CONFIG_MANAGER_TYPE, version).encodeFunctionData(
      multiTokenPoolFunctionOf(this.name),
      [
        updates.map((u, i) => [
          encodePolicyName(this.name, `updates[${i}].policyName`, u.policyName),
          u.remoteTokenAddressProvider === null
            ? ZeroAddress
            : getAddress(u.remoteTokenAddressProvider),
        ]),
      ],
    )
    // the values the write replaces: each policy's provider as it was
    const expected = Object.fromEntries(
      updates.map((u) => {
        const word = policyKey(u.policyName, 'policyName')
        const current = state.policies.remoteTokenAddressProviders.find(
          (p) => policyKey(p.policyName, 'policyName') === word,
        )
        return [`providers.${word}`, current?.provider ?? null]
      }),
    )
    return { data, expected }
  }
}
