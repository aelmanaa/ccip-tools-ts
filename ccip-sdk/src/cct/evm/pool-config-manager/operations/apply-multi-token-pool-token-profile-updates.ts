/**
 * applyMultiTokenPoolTokenProfileUpdates — registers, updates and deregisters tokens on a
 * PoolConfigManager (`applyTokenProfileUpdates`), with the per-op profile guards.
 *
 * @packageDocumentation
 */

import { ZeroAddress, getAddress, toBeHex } from 'ethers'

import type { EVMChain } from '../../../../evm/index.ts'
import {
  type LockOrBurnFlavor,
  LANE_RECORD_TYPES,
  LOCK_OR_BURN_FLAVORS,
} from '../../../../evm/multi-token-pool.ts'
import { resultToObject } from '../../../../evm/types.ts'
import { type FinalityAllowed, encodeFinality } from '../../../../extra-args.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import type { MultiTokenPoolLaneFinding } from '../../../multi-token-pool.ts'
import {
  type MultiTokenPoolContractType,
  type PoolConfigManagerRole,
  POOL_CONFIG_MANAGER_TYPE,
  getMultiTokenPoolInterface,
  poolConfigManagerContract,
} from '../../multi-token-pool/contracts.ts'
import { validateAllowedFinality } from '../../token-pool/operations/set-allowed-finality-config.ts'
import {
  validateAddress,
  validateAddressArray,
  validateArray,
  validateBoolean,
  validateOneOf,
  validateUint8,
} from '../../validate.ts'
import { type MultiTokenPoolTokenProfileFields, decodeTokenProfile } from '../contracts.ts'
import { multiTokenPoolSupportedChains } from '../projection.ts'
import { readMultiTokenPoolRecordState } from '../record-state.ts'
import { readPoolsServingPoolConfigManager, readRegistryEntry } from '../serving-pools.ts'
import {
  type MultiTokenPoolWriteGuards,
  type PoolConfigManagerWrite,
  type PoolConfigManagerWriteContext,
  type PoolConfigManagerWriteParams,
  PoolConfigManagerWriteOperation,
} from '../write-operation.ts'

/** A full token profile, for a new registration. */
export type MultiTokenPoolTokenProfile = {
  /** The token. */
  tokenAddress: string
  /** Decimals the pool uses for the token; defaults to the token's `decimals()`. */
  localDecimals?: number
  /** How the pool takes the token on send. */
  lockOrBurnFlavor: LockOrBurnFlavor
  /** Faster-than-finality the token allows. Required, so registration never turns it off by omission. */
  allowedFinality: FinalityAllowed
  /**
   * The burn sink (`'burn-to-address'`, see `confirmBurnAddress`) or lockbox (`'lock'`); `null` for
   * every other flavor.
   */
  lockOrBurnAddress: string | null
  /** Additional pool data provider (e.g. a factory UID provider), or `null`. */
  additionalPoolDataProvider: string | null
}

/**
 * A partial profile, for a registered token: omitted fields keep their on-chain value (the op reads
 * and merges); `null` clears a nullable field. `localDecimals` cannot change.
 */
export type MultiTokenPoolTokenProfileUpdate = {
  /** The registered token to update. */
  tokenAddress: string
} & Partial<
  Pick<
    MultiTokenPoolTokenProfile,
    'lockOrBurnFlavor' | 'allowedFinality' | 'lockOrBurnAddress' | 'additionalPoolDataProvider'
  >
>

/** Parameters of `applyMultiTokenPoolTokenProfileUpdates`. Removals run first, as on chain. */
export type ApplyMultiTokenPoolTokenProfileUpdatesParams = PoolConfigManagerWriteParams &
  MultiTokenPoolWriteGuards & {
    /** Tokens to deregister; each must have no policy and no inline record left. */
    tokensToRemove?: string[]
    /**
     * New registrations: full profiles, refused for a token still registered after `tokensToRemove`
     * (so deregistering and re-registering in one call is valid). A re-registered token keeps its old
     * pause flags.
     */
    profilesToSet?: MultiTokenPoolTokenProfile[]
    /** Updates of registered tokens, merged with the on-chain profile. */
    profilesToUpdate?: MultiTokenPoolTokenProfileUpdate[]
    /**
     * Allow changing the flavor, `lockOrBurnAddress` or `additionalPoolDataProvider` of a token that
     * has lanes (F1). Defaults to `false`. The lanes are judged again with the new profile either way.
     */
    allowLiveProfileChange?: boolean
    /**
     * Burn-to-address targets the caller confirms by repeating them: required for any target but
     * `0x000000000000000000000000000000000000dEaD`, code or no code (an EOA target turns every burn
     * into a transfer while the destination still mints, F1).
     */
    confirmBurnAddress?: string[]
    /**
     * The pool whose served flavors are checked (F13); defaults to `poolAddress`. Required with a
     * `poolConfigManager` target and a `'lock'` profile.
     */
    servingPool?: string
  }

/** The conventional burn sink, exempt from `confirmBurnAddress`. */
const DEAD = getAddress('0x000000000000000000000000000000000000dead')

/**
 * Flavors each multi-token pool type refuses (`_isSupportedFlavor`): `BurnMintMultiTokenPool`
 * serves every flavor but `'lock'` (chainlink-ccip c950d9bc `BurnMintMultiTokenPool.sol:33-36`).
 */
const UNSERVED_FLAVORS: Partial<Record<MultiTokenPoolContractType, readonly LockOrBurnFlavor[]>> = {
  BurnMintMultiTokenPool: ['lock'],
}

/** The profile a write leaves for one token, with what it replaces. */
type ProfileChange = {
  /** Where it came from, for errors. */
  param: string
  /** The profile after the write. */
  next: Omit<MultiTokenPoolTokenProfileFields, 'isRegistered'>
  /** The stored profile, when the token is registered now. */
  current?: MultiTokenPoolTokenProfileFields
}

/**
 * Registers, updates and deregisters tokens.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), a profile guard
 *   refuses (F1, F13, decimals, burn target, removal with config left, a set of a registered token or
 *   an update of an unregistered one), `sender` lacks the gate, or a lane guard refuses
 * @throws {@link CCTContractTypeInvalidError} if the target is not a PoolConfigManager or a
 *   multi-token pool
 * @throws {@link CCTStateChangedError} if `expectedSnapshot` was given and the state moved
 */
export class ApplyMultiTokenPoolTokenProfileUpdates extends PoolConfigManagerWriteOperation<ApplyMultiTokenPoolTokenProfileUpdatesParams> {
  readonly name = 'applyMultiTokenPoolTokenProfileUpdates'

  protected override prepare(
    params: ApplyMultiTokenPoolTokenProfileUpdatesParams,
  ): ApplyMultiTokenPoolTokenProfileUpdatesParams {
    super.prepare(params)
    const { tokensToRemove = [], profilesToSet = [], profilesToUpdate = [] } = params
    if (params.tokensToRemove !== undefined)
      validateAddressArray(this.name, 'tokensToRemove', params.tokensToRemove)
    if (params.profilesToSet !== undefined)
      validateArray(this.name, 'profilesToSet', params.profilesToSet)
    if (params.profilesToUpdate !== undefined)
      validateArray(this.name, 'profilesToUpdate', params.profilesToUpdate)
    if (!tokensToRemove.length && !profilesToSet.length && !profilesToUpdate.length)
      throw new CCTParamsInvalidError(
        this.name,
        'profilesToSet',
        'nothing to do: give tokensToRemove, profilesToSet or profilesToUpdate',
      )
    if (params.allowLiveProfileChange !== undefined)
      validateBoolean(this.name, 'allowLiveProfileChange', params.allowLiveProfileChange)
    if (params.confirmBurnAddress !== undefined)
      validateAddressArray(this.name, 'confirmBurnAddress', params.confirmBurnAddress)
    if (params.servingPool !== undefined)
      validateAddress(this.name, 'servingPool', params.servingPool)

    const once = (list: { tokenAddress: string }[], name: string, seen = new Set<string>()) =>
      list.forEach((p, i) => {
        const token = getAddress(p.tokenAddress)
        if (seen.has(token))
          throw new CCTParamsInvalidError(
            this.name,
            `${name}[${i}].tokenAddress`,
            `${token} appears twice in profilesToSet and profilesToUpdate: the result would depend on order; give each token once`,
          )
        seen.add(token)
      })
    Array.from(profilesToSet, (p, i) =>
      this.#validateProfile(params, p, `profilesToSet[${i}]`, true),
    )
    Array.from(profilesToUpdate, (p, i) =>
      this.#validateProfile(params, p, `profilesToUpdate[${i}]`, false),
    )
    const seen = new Set<string>()
    once(profilesToSet, 'profilesToSet', seen)
    once(profilesToUpdate, 'profilesToUpdate', seen)
    const removed = new Set(tokensToRemove.map((t) => getAddress(t)))
    profilesToUpdate.forEach((p, i) => {
      if (removed.has(getAddress(p.tokenAddress)))
        throw new CCTParamsInvalidError(
          this.name,
          `profilesToUpdate[${i}].tokenAddress`,
          'is also in tokensToRemove: an update needs a registered token; re-register it with profilesToSet instead',
        )
    })
    return params
  }

  /** Validates one profile's fields, before any RPC. */
  #validateProfile(
    params: ApplyMultiTokenPoolTokenProfileUpdatesParams,
    p: Partial<MultiTokenPoolTokenProfile> | undefined,
    at: string,
    full: boolean,
  ): void {
    validateAddress(this.name, `${at}.tokenAddress`, p?.tokenAddress)
    const profile = p!
    if (full || profile.lockOrBurnFlavor !== undefined)
      validateOneOf(
        this.name,
        `${at}.lockOrBurnFlavor`,
        profile.lockOrBurnFlavor,
        LOCK_OR_BURN_FLAVORS,
      )
    if (full || profile.allowedFinality !== undefined)
      validateAllowedFinality(this.name, profile.allowedFinality, `${at}.allowedFinality`)
    if ('localDecimals' in profile && profile.localDecimals !== undefined) {
      if (!full)
        throw new CCTParamsInvalidError(
          this.name,
          `${at}.localDecimals`,
          'cannot change on a registered token: decimals are immutable while registered',
        )
      validateUint8(this.name, `${at}.localDecimals`, profile.localDecimals)
    }
    for (const field of ['lockOrBurnAddress', 'additionalPoolDataProvider'] as const) {
      const v = profile[field]
      if (full && v === undefined)
        throw new CCTParamsInvalidError(
          this.name,
          `${at}.${field}`,
          'is required: an address, or null',
        )
      if (v !== undefined && v !== null) validateAddress(this.name, `${at}.${field}`, v)
    }
    if (!full && Object.keys(profile).length === 1)
      throw new CCTParamsInvalidError(
        this.name,
        at,
        'changes no field: give at least one besides tokenAddress',
      )
    // a burn target is confirmed by repeating it; address(0) is refused (ERC-20s revert transfers to it)
    const target = profile.lockOrBurnAddress
    if (profile.lockOrBurnFlavor === 'burn-to-address' && full && !target)
      throw new CCTParamsInvalidError(
        this.name,
        `${at}.lockOrBurnAddress`,
        "is required for 'burn-to-address': the sink burnt tokens go to",
      )
    if (target && profile.lockOrBurnFlavor === 'burn-to-address')
      this.#checkBurnTarget(params, target, at)
  }

  /** F1: a burn target other than `0x…dEaD` must be repeated in `confirmBurnAddress`. */
  #checkBurnTarget(
    params: ApplyMultiTokenPoolTokenProfileUpdatesParams,
    target: string,
    at: string,
  ): void {
    const t = getAddress(target)
    if (t === ZeroAddress)
      throw new CCTParamsInvalidError(
        this.name,
        `${at}.lockOrBurnAddress`,
        'is address(0): OpenZeppelin ERC-20s revert transfers to it, so every send would revert; use 0x…dEaD',
      )
    if (t !== DEAD && !params.confirmBurnAddress?.some((c) => getAddress(c) === t))
      throw new CCTParamsInvalidError(
        this.name,
        'confirmBurnAddress',
        `burning to ${t} must be confirmed: an EOA or contract target receives every burnt token while the destination still mints. Repeat it in confirmBurnAddress, or use 0x000000000000000000000000000000000000dEaD`,
        { context: { target: t } },
      )
  }

  protected gate(): readonly PoolConfigManagerRole[] {
    return ['CONFIG_ROLE', 'TOKEN_MANAGER_ROLE']
  }

  protected async encode(
    chain: EVMChain,
    params: ApplyMultiTokenPoolTokenProfileUpdatesParams,
    { address, version, blockTag }: PoolConfigManagerWriteContext,
  ): Promise<PoolConfigManagerWrite> {
    const remove = (params.tokensToRemove ?? []).map((t) => getAddress(t))
    const set = params.profilesToSet ?? []
    const update = params.profilesToUpdate ?? []
    const tokens = [
      ...new Set([...remove, ...[...set, ...update].map((p) => getAddress(p.tokenAddress))]),
    ]
    const pcm = poolConfigManagerContract(chain, address, version)
    const [configs, { state, staticConfig }] = await Promise.all([
      pcm.getTokenConfigBatch(tokens, { blockTag }),
      readMultiTokenPoolRecordState(chain, address, version, { tokenAddresses: tokens, blockTag }),
    ])
    const stored = new Map(
      tokens.map((t, i) => [t, decodeTokenProfile(t, resultToObject(configs[i]!), address)]),
    )
    const removed = new Set(remove)

    // removals: registered, with no policy and no inline record left (the stores revert otherwise)
    remove.forEach((token, i) => {
      if (!stored.get(token)!.isRegistered)
        throw new CCTParamsInvalidError(
          this.name,
          `tokensToRemove[${i}]`,
          `${token} is not registered`,
        )
      const records = state.tokens.find((t) => getAddress(t.tokenAddress) === token)
      const left = records
        ? LANE_RECORD_TYPES.filter(
            (type) => records.policies[type] !== null || records.inline[type].length,
          )
        : []
      if (left.length)
        throw new CCTParamsInvalidError(
          this.name,
          `tokensToRemove[${i}]`,
          `${token} still has ${left.join(', ')} config (a policy or inline records): clear it first, or the stores revert (TokenHasConfig)`,
          { context: { recordTypes: left } },
        )
    })

    const changes: ProfileChange[] = []
    for (const [i, p] of set.entries()) {
      const token = getAddress(p.tokenAddress)
      const current = stored.get(token)!
      if (current.isRegistered && !removed.has(token))
        throw new CCTParamsInvalidError(
          this.name,
          `profilesToSet[${i}].tokenAddress`,
          `${token} is registered: update it with profilesToUpdate, or deregister it in tokensToRemove first`,
        )
      // decimals: the token's own, which the connection store checks on registration
      const decimals = (await chain.getTokenInfo(token)).decimals
      if (p.localDecimals !== undefined && p.localDecimals !== decimals)
        throw new CCTParamsInvalidError(
          this.name,
          `profilesToSet[${i}].localDecimals`,
          `is ${p.localDecimals}, but ${token} reports ${decimals} decimals: the store refuses it (InvalidDecimalArgs)`,
        )
      changes.push({
        param: `profilesToSet[${i}]`,
        next: {
          tokenAddress: token,
          localDecimals: decimals,
          lockOrBurnFlavor: p.lockOrBurnFlavor,
          allowedFinality: p.allowedFinality,
          lockOrBurnAddress: p.lockOrBurnAddress && getAddress(p.lockOrBurnAddress),
          additionalPoolDataProvider:
            p.additionalPoolDataProvider && getAddress(p.additionalPoolDataProvider),
        },
      })
    }
    for (const [i, p] of update.entries()) {
      const token = getAddress(p.tokenAddress)
      const current = stored.get(token)!
      if (!current.isRegistered)
        throw new CCTParamsInvalidError(
          this.name,
          `profilesToUpdate[${i}].tokenAddress`,
          `${token} is not registered: register it with profilesToSet`,
        )
      const { isRegistered: _, ...kept } = current
      const flavor = p.lockOrBurnFlavor ?? current.lockOrBurnFlavor
      const next = {
        ...kept,
        lockOrBurnFlavor: flavor,
        ...(p.allowedFinality && { allowedFinality: p.allowedFinality }),
        // a flavor change resets the address unless given: only burn-to-address and lock keep one
        lockOrBurnAddress:
          p.lockOrBurnAddress !== undefined
            ? p.lockOrBurnAddress && getAddress(p.lockOrBurnAddress)
            : flavor === current.lockOrBurnFlavor
              ? current.lockOrBurnAddress
              : null,
        additionalPoolDataProvider:
          p.additionalPoolDataProvider !== undefined
            ? p.additionalPoolDataProvider && getAddress(p.additionalPoolDataProvider)
            : current.additionalPoolDataProvider,
      }
      if (next.lockOrBurnFlavor === 'burn-to-address') {
        if (!next.lockOrBurnAddress)
          throw new CCTParamsInvalidError(
            this.name,
            `profilesToUpdate[${i}].lockOrBurnAddress`,
            "is required for 'burn-to-address': the sink burnt tokens go to",
          )
        this.#checkBurnTarget(params, next.lockOrBurnAddress, `profilesToUpdate[${i}]`)
      }
      changes.push({ param: `profilesToUpdate[${i}]`, next, current })
    }

    for (const c of changes) this.#checkProfile(c)
    this.#checkLiveChanges(params, changes, state)
    await this.#checkServedFlavors(chain, params, changes)
    const warnings = await this.#uidMigrationWarnings(chain, params, changes, {
      address,
      version,
      blockTag,
      tokenAdminRegistry: staticConfig.tokenAdminRegistry,
    })

    const iface = getMultiTokenPoolInterface(POOL_CONFIG_MANAGER_TYPE, version)
    const data = iface.encodeFunctionData('applyTokenProfileUpdates', [
      remove,
      changes.map(({ next }) => [
        next.tokenAddress,
        next.localDecimals,
        LOCK_OR_BURN_FLAVORS.indexOf(next.lockOrBurnFlavor),
        toBeHex(encodeFinality(next.allowedFinality), 4),
        next.lockOrBurnAddress ?? ZeroAddress,
        next.additionalPoolDataProvider ?? ZeroAddress,
      ]),
    ])
    // the values the write replaces: each touched token's stored profile
    const expected = Object.fromEntries(tokens.map((t) => [`profiles.${t}`, stored.get(t)]))
    return { data, expected, ...(warnings.length && { warnings }) }
  }

  /** The store's flavor and address rules, refused before the eth_call names them. */
  #checkProfile({ param, next }: ProfileChange): void {
    const needsAddress =
      next.lockOrBurnFlavor === 'lock' || next.lockOrBurnFlavor === 'burn-to-address'
    if (!needsAddress && next.lockOrBurnAddress)
      throw new CCTParamsInvalidError(
        this.name,
        `${param}.lockOrBurnAddress`,
        `must be null for '${next.lockOrBurnFlavor}': only 'burn-to-address' and 'lock' use one (InvalidLockOrBurnAddress)`,
      )
    if (next.lockOrBurnFlavor === 'lock' && !next.lockOrBurnAddress)
      throw new CCTParamsInvalidError(
        this.name,
        `${param}.lockOrBurnAddress`,
        "is required for 'lock': the lockbox that holds the token",
      )
  }

  /** F1: a flavor, address or provider change on a token with lanes needs `allowLiveProfileChange`. */
  #checkLiveChanges(
    params: ApplyMultiTokenPoolTokenProfileUpdatesParams,
    changes: readonly ProfileChange[],
    state: Awaited<ReturnType<typeof readMultiTokenPoolRecordState>>['state'],
  ): void {
    if (params.allowLiveProfileChange) return
    for (const { param, next, current } of changes) {
      if (!current) continue
      const changed = (
        ['lockOrBurnFlavor', 'lockOrBurnAddress', 'additionalPoolDataProvider'] as const
      ).filter((f) => next[f] !== current[f])
      const lanes = multiTokenPoolSupportedChains(state, next.tokenAddress)
      if (changed.length && lanes.length)
        throw new CCTParamsInvalidError(
          this.name,
          'allowLiveProfileChange',
          `${param} changes ${changed.join(', ')} of ${next.tokenAddress}, which has lanes to ${lanes.join(', ')}: in-flight transfers were sent under the old profile. Pause the token first, or pass allowLiveProfileChange: true`,
          { context: { tokenAddress: next.tokenAddress, fields: changed, chains: lanes } },
        )
    }
  }

  /** F13: a flavor the serving pool does not serve makes every send revert. */
  async #checkServedFlavors(
    chain: EVMChain,
    params: ApplyMultiTokenPoolTokenProfileUpdatesParams,
    changes: readonly ProfileChange[],
  ): Promise<void> {
    // only a flavor some multi-token pool type refuses needs the serving pool
    const refusable = new Set(Object.values(UNSERVED_FLAVORS).flat())
    const at = changes.filter((c) => refusable.has(c.next.lockOrBurnFlavor))
    if (!at.length) return
    const pool = params.servingPool ?? params.poolAddress
    if (pool === undefined)
      throw new CCTParamsInvalidError(
        this.name,
        'servingPool',
        `is required to check ${at[0]!.param}'s '${at[0]!.next.lockOrBurnFlavor}' flavor: name the pool that serves the token (not the registry's pool, which can lag during a migration)`,
      )
    const [type] = await chain.typeAndVersion(pool)
    const unserved = UNSERVED_FLAVORS[type as MultiTokenPoolContractType]
    for (const c of at)
      if (!unserved || unserved.includes(c.next.lockOrBurnFlavor))
        throw new CCTParamsInvalidError(
          this.name,
          `${c.param}.lockOrBurnFlavor`,
          unserved
            ? `'${c.next.lockOrBurnFlavor}' is not served by ${type} ${pool}: every send would revert (UnsupportedLockOrBurnFlavor)`
            : `cannot tell whether ${type} ${pool} serves '${c.next.lockOrBurnFlavor}', so it is refused`,
        )
  }

  /**
   * The UID stand-in until the SDK reads pool migration history: a token whose provider is set or changed
   * gets `UID_MIGRATION_UNCHECKED` when the registry names a pool other than the pools serving this PCM
   * for it, or an admin transfer is pending; such a history may have minted tokens a UID provider now
   * refuses. Never passes silently when the reads can tell.
   */
  async #uidMigrationWarnings(
    chain: EVMChain,
    params: ApplyMultiTokenPoolTokenProfileUpdatesParams,
    changes: readonly ProfileChange[],
    ctx: PoolConfigManagerWriteContext & { tokenAdminRegistry: string },
  ): Promise<MultiTokenPoolLaneFinding[]> {
    const providerChanged = changes.filter(
      (c) =>
        c.next.additionalPoolDataProvider !== null &&
        c.next.additionalPoolDataProvider !== (c.current?.additionalPoolDataProvider ?? null),
    )
    if (!providerChanged.length) return []
    const tokens = providerChanged.map((c) => c.next.tokenAddress)
    const { serving } = await readPoolsServingPoolConfigManager(chain, {
      poolConfigManager: ctx.address,
      version: ctx.version,
      tokenAdminRegistry: ctx.tokenAdminRegistry,
      tokens,
      blockTag: ctx.blockTag,
    })
    const ours = new Set([
      ...serving,
      ...(params.poolAddress ? [getAddress(params.poolAddress)] : []),
      ...(params.servingPool ? [getAddress(params.servingPool)] : []),
    ])
    const warnings: MultiTokenPoolLaneFinding[] = []
    for (const token of tokens) {
      const entry = await readRegistryEntry(chain, ctx.tokenAdminRegistry, token)
      const pool = entry?.tokenPool ? getAddress(entry.tokenPool) : null
      const reasons = [
        ...(pool !== null && !ours.has(pool) ? [`the registry serves it from ${pool}`] : []),
        ...(entry?.pendingAdministrator
          ? [`an admin transfer to ${entry.pendingAdministrator} is pending`]
          : []),
      ]
      if (reasons.length)
        warnings.push({
          check: 'UID_MIGRATION_UNCHECKED',
          severity: 'warning',
          tokenAddress: token,
          // about the token, not one lane
          remoteChainSelector: 0n,
          reason: `${reasons.join(', and ')}: the token may have a pool history the new provider does not account for; the SDK does not check pool migration history yet, so review it before relying on the UID`,
        })
    }
    return warnings
  }
}
