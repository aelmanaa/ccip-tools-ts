/**
 * getMultiTokenPoolStack — reads and audits a whole multi-token stack: pool, PCM, three stores,
 * owners, pending owners, authorized callers, and the pools sharing the PCM.
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

import { CCIPTokenNotConfiguredError } from '../../../../errors/index.ts'
import type { EVMChain } from '../../../../evm/index.ts'
import { CCTContractTypeInvalidError, CCTContractVersionUnsupportedError } from '../../../errors.ts'
import {
  type GetPolicyStoreStateResult,
  GetPolicyStoreState,
} from '../../policy-store/operations/get-policy-store-state.ts'
import { readConfiguredTokens, readInBatches } from '../../pool-config-manager/contracts.ts'
import {
  type GetPoolConfigManagerStateResult,
  GetPoolConfigManagerState,
} from '../../pool-config-manager/operations/get-pool-config-manager-state.ts'
import { EVMQuery, isNotCcipContract } from '../../query.ts'
import { validateNonZeroAddress } from '../../validate.ts'
import { type PolicyStoreType, POOL_CONFIG_MANAGER_TYPE } from '../contracts.ts'
import {
  type GetMultiTokenPoolStateResult,
  GetMultiTokenPoolState,
} from './get-multi-token-pool-state.ts'
import type { MultiTokenPoolReadParams } from './is-multi-token-pool.ts'

/** Registry reads in flight at once during the sharing-pool sweep. */
const REGISTRY_SWEEP_BATCH = 16

/** One finding of the stack audit. */
export type MultiTokenPoolStackFinding = {
  /**
   * - `PCM_NOT_ON_STORE`: a store does not authorize the PCM; every write through it reverts.
   * - `STALE_PCM_AUTHORIZED`: a store still authorizes another PoolConfigManager, which can write it (F4).
   * - `EXTRA_STORE_CALLER`: a store authorizes a contract that is not a PoolConfigManager.
   * - `OWNER_MISMATCH`: the pool owner, the store owners and the PCM default admin differ (F5).
   * - `PENDING_OWNERSHIP`: an ownership or default-admin transfer is pending.
   * - `TAR_MISMATCH`: the PCM's TokenAdminRegistry is not the one the pool's Router uses.
   * - `REGISTRATION_DIVERGED`: a token the PCM registers is served by a pool that does not use this PCM.
   * - `ZERO_ADMIN_DELAY`: PCM governance changes are instant (F8).
   */
  check:
    | 'PCM_NOT_ON_STORE'
    | 'STALE_PCM_AUTHORIZED'
    | 'EXTRA_STORE_CALLER'
    | 'OWNER_MISMATCH'
    | 'PENDING_OWNERSHIP'
    | 'TAR_MISMATCH'
    | 'REGISTRATION_DIVERGED'
    | 'ZERO_ADMIN_DELAY'
  /** `'error'`: the stack cannot work as configured; `'warning'`: a risk to review. */
  severity: 'error' | 'warning'
  /** What is wrong and how to fix it. */
  reason: string
}

/** Result of `getMultiTokenPoolStack`. */
export type GetMultiTokenPoolStackResult = {
  /** The pool's state. */
  pool: GetMultiTokenPoolStateResult
  /** The PCM's state. */
  poolConfigManager: GetPoolConfigManagerStateResult
  /** Each store's state, with its address. */
  policyStores: Record<
    PolicyStoreType,
    GetPolicyStoreStateResult & {
      /** The store's address, from the PCM's static config. */
      address: string
    }
  >
  /**
   * Other pools that use this PCM, found through `TAR.getPool(token)` for each registered token. A pool
   * that names the PCM but serves no registered token is not found (harmless for transfers).
   */
  poolsSharingPoolConfigManager: string[]
  /** How {@link GetMultiTokenPoolStackResult.poolsSharingPoolConfigManager} was found. */
  poolsSharingPoolConfigManagerSource: 'registered-tokens'
  /** Every finding, errors first, then by check and reason (stable across runs). */
  findings: MultiTokenPoolStackFinding[]
}

/**
 * Reads and audits the stack of a multi-token pool.
 * @remarks Composes `getMultiTokenPoolState`, `getPoolConfigManagerState` and
 * `getPolicyStoreState`, then reads the PCM's registered tokens at one block and each token's pool
 * from the TokenAdminRegistry.
 * @throws {@link CCTParamsInvalidError} if `poolAddress` is invalid (before any RPC)
 * @throws {@link CCTContractTypeInvalidError} if a contract of the stack has the wrong type
 * @throws {@link CCTContractVersionUnsupportedError} if a version is unknown
 */
export class GetMultiTokenPoolStack extends EVMQuery<
  MultiTokenPoolReadParams,
  GetMultiTokenPoolStackResult
> {
  readonly name = 'getMultiTokenPoolStack'
  readonly #poolState = new GetMultiTokenPoolState()
  readonly #pcmState = new GetPoolConfigManagerState()
  readonly #storeState = new GetPolicyStoreState()

  protected prepare(params: MultiTokenPoolReadParams): MultiTokenPoolReadParams {
    validateNonZeroAddress(this.name, 'poolAddress', params.poolAddress)
    return params
  }

  protected async read(
    chain: EVMChain,
    { poolAddress }: MultiTokenPoolReadParams,
  ): Promise<GetMultiTokenPoolStackResult> {
    const pool = await this.#poolState.query(chain, { poolAddress })
    const pcm = await this.#pcmState.query(chain, { poolConfigManager: pool.poolConfigManager })
    const storeAddresses = {
      ConnectionPolicyStore: pcm.connectionPolicyStore,
      FeePolicyStore: pcm.feePolicyStore,
      SecurityPolicyStore: pcm.securityPolicyStore,
    } satisfies Record<PolicyStoreType, string>
    const [stores, routerRegistry, configured] = await Promise.all([
      Promise.all(
        Object.entries(storeAddresses).map(
          async ([key, address]) =>
            [
              key,
              { ...(await this.#storeState.query(chain, { policyStore: address })), address },
            ] as const,
        ),
      ).then((e) => Object.fromEntries(e) as GetMultiTokenPoolStackResult['policyStores']),
      chain.getTokenAdminRegistryFor(pool.router),
      readConfiguredTokens(chain, pcm.poolConfigManager, pcm.version),
    ])

    const findings: MultiTokenPoolStackFinding[] = []
    // stores: the PCM must be an authorized caller; other callers are stale PCMs or extras
    await Promise.all(
      Object.values(stores).map(async (store) => {
        if (!store.authorizedCallers.includes(pcm.poolConfigManager))
          findings.push({
            check: 'PCM_NOT_ON_STORE',
            severity: 'error',
            reason: `${store.type} ${store.address} does not authorize the PoolConfigManager ${pcm.poolConfigManager}; every write through the PCM to it reverts. Add it with updatePolicyStoreAuthorizedCallers`,
          })
        for (const caller of store.authorizedCallers) {
          if (caller === pcm.poolConfigManager) continue
          const type = await chain.typeAndVersion(caller).then(
            ([t]) => t,
            (err: unknown) => {
              // no (parseable) typeAndVersion: not a CCIP contract; transport errors propagate
              if (isNotCcipContract(err)) return undefined
              throw err
            },
          )
          findings.push(
            type === POOL_CONFIG_MANAGER_TYPE
              ? {
                  check: 'STALE_PCM_AUTHORIZED',
                  severity: 'warning',
                  reason: `${store.type} ${store.address} still authorizes PoolConfigManager ${caller}, which can rewrite its policies; if no pool uses it, remove it with updatePolicyStoreAuthorizedCallers`,
                }
              : {
                  check: 'EXTRA_STORE_CALLER',
                  severity: 'warning',
                  reason: `${store.type} ${store.address} authorizes ${caller}, which is not a PoolConfigManager and can write its policies; remove it with updatePolicyStoreAuthorizedCallers unless it is intended`,
                },
          )
        }
      }),
    )
    // one owner for every contract of the stack
    const owners = new Map<string, string[]>()
    const addOwner = (who: string, what: string) =>
      owners.set(who, [...(owners.get(who) ?? []), what])
    addOwner(pool.owner, 'pool owner')
    addOwner(pcm.defaultAdmin, 'PCM default admin')
    for (const s of Object.values(stores)) addOwner(s.owner, `${s.type} owner`)
    if (owners.size > 1)
      findings.push({
        check: 'OWNER_MISMATCH',
        severity: 'warning',
        reason: `the stack has ${owners.size} different owners (${[...owners].map(([o, w]) => `${o}: ${w.join(', ')}`).join('; ')}); any of them can change trust, remote tokens or fees, so move them to one owner (a Safe or a timelock) with the ownership ops`,
      })
    for (const [what, pending] of [
      ['pool', pool.pendingOwner],
      ['PCM default admin', pcm.pendingDefaultAdmin?.newAdmin ?? null],
      ...Object.values(stores).map((s) => [s.type, s.pendingOwner] as const),
    ] as const)
      if (pending)
        findings.push({
          check: 'PENDING_OWNERSHIP',
          severity: 'warning',
          reason: `${what} transfer to ${pending} is pending; until it is accepted the current owner keeps every privilege`,
        })
    if (getAddress(routerRegistry) !== pcm.tokenAdminRegistry)
      findings.push({
        check: 'TAR_MISMATCH',
        severity: 'error',
        reason: `the PoolConfigManager checks token admins against ${pcm.tokenAdminRegistry}, but the pool's Router uses ${getAddress(routerRegistry)}; token registration and setPool disagree`,
      })
    if (pcm.defaultAdminDelay === 0)
      findings.push({
        check: 'ZERO_ADMIN_DELAY',
        severity: 'warning',
        reason:
          'the PCM default-admin delay is 0, so a default-admin transfer is instant; use a delay, a Safe or a timelock',
      })

    // other pools serving the PCM's tokens: either they share this PCM, or the registration diverged
    const sharing = new Set<string>()
    // one registry read per registered token, in batches so a large stack does not flood the RPC
    await readInBatches(
      configured.tokens,
      async (batch) => {
        await Promise.all(
          batch.map(async (token) => {
            const tokenPool = await chain
              .getRegistryTokenConfig(pcm.tokenAdminRegistry, token)
              .then(
                ({ tokenPool }) => tokenPool,
                (err: unknown) => {
                  if (err instanceof CCIPTokenNotConfiguredError) return undefined
                  throw err
                },
              )
            if (!tokenPool || getAddress(tokenPool) === getAddress(poolAddress)) return
            const other = await this.#poolState.query(chain, { poolAddress: tokenPool }).then(
              (s) => s.poolConfigManager,
              (err: unknown) => {
                // not a multi-token pool (a single-token pool, or a variant the SDK does not know)
                if (
                  err instanceof CCTContractTypeInvalidError ||
                  err instanceof CCTContractVersionUnsupportedError
                )
                  return undefined
                throw err
              },
            )
            if (other === pcm.poolConfigManager) sharing.add(getAddress(tokenPool))
            else
              findings.push({
                check: 'REGISTRATION_DIVERGED',
                severity: 'warning',
                reason: `token ${token} is registered in this PoolConfigManager but the TokenAdminRegistry serves it from ${tokenPool}, which does not use it; point the registry at this pool with setPool, or deregister the token here`,
              })
          }),
        )
        return []
      },
      { batchSize: REGISTRY_SWEEP_BATCH, sequential: true },
    )

    // deterministic order: severity, then check, then reason (the reads above run concurrently)
    findings.sort(
      (a, b) =>
        (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1) ||
        a.check.localeCompare(b.check) ||
        a.reason.localeCompare(b.reason),
    )

    return {
      pool,
      poolConfigManager: pcm,
      policyStores: stores,
      poolsSharingPoolConfigManager: [...sharing].sort(),
      poolsSharingPoolConfigManagerSource: 'registered-tokens',
      findings,
    }
  }
}
