/**
 * updatePolicyStoreAuthorizedCallers — `applyAuthorizedCallerUpdates` on a policy store: adds or
 * removes the callers that write it with no PCM role.
 *
 * @remarks An authorized caller writes the store directly and can consume its rate limit buckets
 * (F5), so only a PoolConfigManager whose static config names this store is ever added. Removing a
 * PCM that a pool still names stops every transfer of that pool and fails its in-flight inbound
 * messages, so it needs `confirmRemovingServingCallers`. Validation of the lists is main's
 * (`parseAuthorizedCallerUpdates`). The callers, and the pools each removed PCM serves, are sealed:
 * the snapshot check re-reads them.
 *
 * @packageDocumentation
 */

import { type Result, getAddress } from 'ethers'

import type { EVMChain } from '../../../../evm/index.ts'
import { CCTContractTypeInvalidError } from '../../../errors.ts'
import {
  parseAuthorizedCallerUpdates,
  readAllAuthorizedCallers,
} from '../../advanced-pool-hooks/contracts.ts'
import {
  type PolicyStoreType,
  POOL_CONFIG_MANAGER_TYPE,
  multiTokenPoolFunctionOf,
  policyStoresOf,
  resolveMultiTokenPoolContract,
} from '../../multi-token-pool/contracts.ts'
import {
  type MultiTokenPoolOwnedWriteContext,
  MultiTokenPoolOwnedWriteOperation,
  ownedTargetInterface,
} from '../../multi-token-pool/owned-write-operation.ts'
import type { MultiTokenPoolUnsignedTx } from '../../multi-token-pool/write-operation.ts'
import {
  readConfiguredTokens,
  readPoolConfigManagerStaticConfig,
} from '../../pool-config-manager/contracts.ts'
import { readPoolsServingPoolConfigManager } from '../../pool-config-manager/serving-pools.ts'
import { assertUnique, validateArray, validateNonZeroAddress } from '../../validate.ts'

/** `updatePolicyStoreAuthorizedCallers`. Store owner. */
export type UpdatePolicyStoreAuthorizedCallersParams = {
  /** The policy store (connection, fee or security). */
  policyStore: string
  /** Callers to authorize: each a PoolConfigManager whose static config names this store. */
  addedCallers?: string[]
  /** Callers to deauthorize (removed before the additions, as on chain). */
  removedCallers?: string[]
  /**
   * Removing a PCM that a pool still names stops every transfer of that pool and fails its
   * in-flight inbound messages; refused unless this lists it.
   */
  confirmRemovingServingCallers?: string[]
  /** The store owner; optional when generating an unsigned transaction. */
  sender?: string
}

type Parsed = UpdatePolicyStoreAuthorizedCallersParams & {
  addedCallers: string[]
  removedCallers: string[]
  confirmRemovingServingCallers: string[]
}

/** Where the facts are sealed. */
const CALLERS_PATH = 'store.authorizedCallers'
const addedPath = (caller: string) => `added.${caller}.poolConfigManagerOfStore`
const servingPath = (caller: string) => `removed.${caller}.servingPools`

/**
 * Whether `caller` is a PoolConfigManager whose static config names `store` as its `type` store, and
 * if so its address, version and registry.
 */
async function storePoolConfigManager(
  chain: EVMChain,
  caller: string,
  store: { address: string; type: PolicyStoreType },
  blockTag: number,
) {
  try {
    const { version } = await resolveMultiTokenPoolContract(chain, caller, [
      POOL_CONFIG_MANAGER_TYPE,
    ])
    const config = await readPoolConfigManagerStaticConfig(chain, caller, version, { blockTag })
    const names = policyStoresOf(config).some(
      ([type, address]) => type === store.type && getAddress(address) === store.address,
    )
    return names ? { version, tokenAdminRegistry: config.tokenAdminRegistry } : undefined
  } catch (err) {
    // not a PCM (no typeAndVersion, or another contract): it serves no store
    if (err instanceof CCTContractTypeInvalidError) return undefined
    throw err
  }
}

/** Adds or removes a policy store's authorized callers. Store owner. */
export class UpdatePolicyStoreAuthorizedCallers extends MultiTokenPoolOwnedWriteOperation<
  'policyStore',
  UpdatePolicyStoreAuthorizedCallersParams,
  Parsed,
  MultiTokenPoolUnsignedTx
> {
  readonly name = 'updatePolicyStoreAuthorizedCallers'
  protected readonly kind = 'policyStore'
  protected override readonly seals = true

  /** Validates the lists as main's `updateAdvancedPoolHooksAuthorizedCallers`, before any RPC. */
  protected override prepare(params: UpdatePolicyStoreAuthorizedCallersParams): Parsed {
    super.prepare(params)
    const lists = parseAuthorizedCallerUpdates(this.name, params)
    const { confirmRemovingServingCallers = [] } = params
    validateArray(this.name, 'confirmRemovingServingCallers', confirmRemovingServingCallers)
    const confirmed = confirmRemovingServingCallers.map((c, i) => {
      validateNonZeroAddress(this.name, `confirmRemovingServingCallers[${i}]`, c)
      return getAddress(c)
    })
    assertUnique(this.name, 'confirmRemovingServingCallers', confirmed, (c) => c, 'caller')
    return { ...params, ...lists, confirmRemovingServingCallers: confirmed }
  }

  /**
   * The store's callers now; for each added caller, whether it is a PCM over this store; for each
   * removed caller that is one, the pools that still name it (through the registry of its tokens).
   */
  protected override async readFacts(
    chain: EVMChain,
    { addedCallers, removedCallers }: Parsed,
    { address, type, blockTag }: Omit<MultiTokenPoolOwnedWriteContext, 'facts'>,
  ): Promise<Record<string, unknown>> {
    const store = { address, type: type as PolicyStoreType }
    const [callers, added, removed] = await Promise.all([
      readAllAuthorizedCallers(chain, address, { blockTag }),
      Promise.all(
        addedCallers.map(async (c) => [
          addedPath(c),
          !!(await storePoolConfigManager(chain, c, store, blockTag)),
        ]),
      ),
      Promise.all(
        removedCallers.map(async (c) => {
          const pcm = await storePoolConfigManager(chain, c, store, blockTag)
          if (!pcm) return [servingPath(c), []]
          const { tokens } = await readConfiguredTokens(chain, c, pcm.version, { blockTag })
          const { serving } = await readPoolsServingPoolConfigManager(chain, {
            poolConfigManager: c,
            version: pcm.version,
            tokenAdminRegistry: pcm.tokenAdminRegistry,
            tokens,
            blockTag,
          })
          return [servingPath(c), serving]
        }),
      ),
    ])
    return {
      [CALLERS_PATH]: [...callers].sort(),
      ...Object.fromEntries(added),
      ...Object.fromEntries(removed),
    }
  }

  protected override confirmations({ confirmRemovingServingCallers }: Parsed) {
    return confirmRemovingServingCallers.length
      ? { removingServingCallers: [...confirmRemovingServingCallers].sort() }
      : {}
  }

  /** Refuses a caller that is not a PCM over this store, and an unconfirmed serving PCM's removal. */
  protected encode(
    _chain: EVMChain,
    { addedCallers, removedCallers, confirmRemovingServingCallers }: Parsed,
    ctx: MultiTokenPoolOwnedWriteContext,
  ): string {
    addedCallers.forEach((c, i) => {
      if (ctx.facts[addedPath(c)] !== true)
        throw this.refuse(
          `addedCallers[${i}]`,
          `${c} is not a PoolConfigManager whose static config names this ${ctx.type} (${ctx.address}): an authorized caller writes the store with no PCM role and can consume its rate limit buckets (F5)`,
        )
    })
    const confirmed = new Set(confirmRemovingServingCallers)
    removedCallers.forEach((c, i) => {
      const serving = ctx.facts[servingPath(c)] as string[]
      if (serving.length && !confirmed.has(c))
        throw this.refuse(
          `removedCallers[${i}]`,
          `${c} is the PoolConfigManager of pools still named by the registry (${serving.join(', ')}): removing it stops every transfer of those pools and fails their in-flight inbound messages. List it in confirmRemovingServingCallers to proceed`,
        )
    })
    return ownedTargetInterface(ctx).encodeFunctionData(multiTokenPoolFunctionOf(this.name), [
      { addedCallers, removedCallers },
    ])
  }

  /** The store, both lists, and the confirmation the proposal sealed. */
  override paramsFromCalldata(
    args: Result,
    target: string,
    sender: string,
    sealed: Record<string, unknown>,
  ): UpdatePolicyStoreAuthorizedCallersParams {
    const update = args[0] as { addedCallers: string[]; removedCallers: string[] }
    const confirmed = sealed['confirm.removingServingCallers']
    return {
      policyStore: target,
      addedCallers: [...update.addedCallers].map((c) => getAddress(c)),
      removedCallers: [...update.removedCallers].map((c) => getAddress(c)),
      ...(Array.isArray(confirmed) && { confirmRemovingServingCallers: confirmed as string[] }),
      sender,
    }
  }
}
