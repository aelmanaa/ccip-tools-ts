/**
 * applyMultiTokenPoolTokenProfileUpdates — registers, updates and deregisters tokens on a
 * PoolConfigManager (`applyTokenProfileUpdates`), with the per-op profile guards.
 *
 * @packageDocumentation
 */

import { ZeroAddress, getAddress, toBeHex } from 'ethers'

import { CCIPTokenDecimalsUnavailableError } from '../../../../errors/index.ts'
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
  type MultiTokenPoolType,
  type PoolConfigManagerRole,
  POOL_CONFIG_MANAGER_TYPE,
  getMultiTokenPoolInterface,
  isSupportedMultiTokenPoolType,
  poolConfigManagerContract,
} from '../../multi-token-pool/contracts.ts'
import { isNotCcipContract } from '../../query.ts'
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
import {
  type PoolConfigManagerServingPools,
  poolConfigManagerOf,
  readPoolsServingPoolConfigManager,
} from '../serving-pools.ts'
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
 * and merges); `null` clears a nullable field. `localDecimals` cannot change. One exception: changing
 * `lockOrBurnFlavor` without `lockOrBurnAddress` clears the address, since only `'burn-to-address'`
 * and `'lock'` use one.
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
     * has lanes. Defaults to `false`. The lanes are judged again with the new profile either way.
     */
    allowLiveProfileChange?: boolean
    /**
     * Burn-to-address targets the caller confirms by repeating them: required for any target but
     * `0x000000000000000000000000000000000000dEaD`, code or no code (an EOA target turns every burn
     * into a transfer while the destination still mints). The serving pool itself is refused.
     */
    confirmBurnAddress?: string[]
    /**
     * The pool whose served flavors are checked; defaults to `poolAddress`. It must call this PoolConfigManager. Required with a
     * `poolConfigManager` target and a `'lock'` profile.
     */
    servingPool?: string
  }

/** The factory UID provider's type (chainlink-ccip c950d9bc `FactoryTokenWithUIDPoolDataProvider.sol`). */
const UID_PROVIDER_TYPE = 'FactoryTokenWithUIDPoolDataProvider'

/** The conventional burn sink, exempt from `confirmBurnAddress`. */
const DEAD = getAddress('0x000000000000000000000000000000000000dead')

/**
 * Flavors each multi-token pool type refuses (`_isSupportedFlavor`): `BurnMintMultiTokenPool`
 * serves every flavor but `'lock'` (chainlink-ccip c950d9bc `BurnMintMultiTokenPool.sol:33-36`).
 */
const UNSERVED_FLAVORS: Partial<Record<MultiTokenPoolType, readonly LockOrBurnFlavor[]>> = {
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
 *   refuses (live change, served flavor, decimals, burn target, removal with config left, a set of a registered token or
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

    const once = (tokens: string[], name: string, seen: Map<string, string>, field = '') =>
      tokens.forEach((t, i) => {
        const token = getAddress(t)
        const first = seen.get(token)
        if (first !== undefined)
          throw new CCTParamsInvalidError(
            this.name,
            `${name}[${i}]${field}`,
            `${token} is also at ${first}: the result would depend on order; give each token once`,
          )
        seen.set(token, `${name}[${i}]`)
      })
    Array.from(profilesToSet, (p, i) =>
      this.#validateProfile(params, p, `profilesToSet[${i}]`, true),
    )
    Array.from(profilesToUpdate, (p, i) =>
      this.#validateProfile(params, p, `profilesToUpdate[${i}]`, false),
    )
    // removal runs first, so a token may be removed and set again; within each side, once
    once(tokensToRemove, 'tokensToRemove', new Map())
    const seen = new Map<string, string>()
    once(
      profilesToSet.map((p) => p.tokenAddress),
      'profilesToSet',
      seen,
      '.tokenAddress',
    )
    once(
      profilesToUpdate.map((p) => p.tokenAddress),
      'profilesToUpdate',
      seen,
      '.tokenAddress',
    )
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
    if (p === undefined) throw new CCTParamsInvalidError(this.name, at, 'must be a profile object')
    validateAddress(this.name, `${at}.tokenAddress`, p.tokenAddress)
    const profile = p
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
    if (!full && Object.values(profile).filter((v: unknown) => v !== undefined).length === 1)
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

  /** A burn target other than `0x…dEaD` must be repeated in `confirmBurnAddress`. */
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
        'is address(0): OpenZeppelin ERC-20s revert transfers to it, so every send would revert; use 0x000000000000000000000000000000000000dEaD',
      )
    if (t !== DEAD && !params.confirmBurnAddress?.some((c) => getAddress(c) === t))
      throw new CCTParamsInvalidError(
        this.name,
        'confirmBurnAddress',
        `${at}.lockOrBurnAddress burns to ${t}, which must be confirmed: an EOA or contract target receives every burnt token while the destination still mints. Repeat it in confirmBurnAddress, or use 0x000000000000000000000000000000000000dEaD`,
        { context: { target: t, profile: at } },
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
      const policies = records
        ? LANE_RECORD_TYPES.filter((type) => records.policies[type] !== null)
        : []
      const inline = records ? LANE_RECORD_TYPES.filter((type) => records.inline[type].length) : []
      if (policies.length || inline.length)
        throw new CCTParamsInvalidError(
          this.name,
          `tokensToRemove[${i}]`,
          `${token} still has config, so the stores revert (TokenHasConfig): ${[
            ...(policies.length
              ? [
                  `clear its ${policies.join(', ')} policies with applyMultiTokenPoolTokenPolicyUpdates({ recordType, assignments: [{ tokenAddress, policyName: null }] })`,
                ]
              : []),
            ...(inline.length ? [`remove its inline ${inline.join(', ')} records`] : []),
          ].join(', and ')}, then deregister it`,
          { context: { policies, inline } },
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
      // decimals: the token's own, which the connection store checks on registration; a token
      // without decimals() takes the given ones, as the store's try/catch does
      const read = await chain.getTokenInfo(token).then(
        (info) => info.decimals,
        (err: unknown) => {
          if (!(err instanceof CCIPTokenDecimalsUnavailableError)) throw err
          return undefined
        },
      )
      if (read === undefined && p.localDecimals === undefined)
        throw new CCTParamsInvalidError(
          this.name,
          `profilesToSet[${i}].localDecimals`,
          `is required: ${token} has no decimals() to default from`,
        )
      const decimals = read ?? p.localDecimals!
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
    await this.#checkServingPool(chain, params, { address, version, blockTag })
    await this.#checkServedFlavors(chain, params, changes)
    // the pools serving this PCM for the changed tokens, and their registry entries
    const serving = await readPoolsServingPoolConfigManager(chain, {
      poolConfigManager: address,
      version,
      tokenAdminRegistry: staticConfig.tokenAdminRegistry,
      tokens: changes.map((c) => c.next.tokenAddress),
      ...((params.poolAddress ?? params.servingPool) !== undefined && {
        targetPool: (params.poolAddress ?? params.servingPool)!,
      }),
      blockTag,
    })
    this.#checkBurnTargetsNotServing(params, changes, serving.serving)
    await this.#checkProviders(chain, changes, serving, blockTag)

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
    return { data, expected }
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

  /** A flavor, address or provider change on a token with lanes needs `allowLiveProfileChange`. */
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
          `${param} changes ${changed.join(', ')} of ${next.tokenAddress}, which has lanes to ${lanes.join(', ')}: in-flight transfers were sent under the old profile. Pause the token and let in-flight transfers settle, then pass allowLiveProfileChange: true`,
          { context: { tokenAddress: next.tokenAddress, fields: changed, chains: lanes } },
        )
    }
  }

  /** A flavor the serving pool does not serve makes every send revert. */
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
    const unserved = isSupportedMultiTokenPoolType(type) ? UNSERVED_FLAVORS[type] : undefined
    for (const c of at)
      if (!unserved || unserved.includes(c.next.lockOrBurnFlavor))
        throw new CCTParamsInvalidError(
          this.name,
          `${c.param}.lockOrBurnFlavor`,
          unserved
            ? `'${c.next.lockOrBurnFlavor}' is not served by ${type} ${pool}: every send would revert (UnsupportedLockOrBurnFlavor)`
            : `cannot tell whether ${type} ${pool} serves '${c.next.lockOrBurnFlavor}', so it is refused: servingPool must be the multi-token pool that serves the token (one of MULTI_TOKEN_POOL_TYPES)`,
        )
  }

  /** A `servingPool` must call this PoolConfigManager: another pool proves nothing about it. */
  async #checkServingPool(
    chain: EVMChain,
    { servingPool }: ApplyMultiTokenPoolTokenProfileUpdatesParams,
    { address, version, blockTag }: PoolConfigManagerWriteContext,
  ): Promise<void> {
    if (servingPool === undefined) return
    const pcm = await poolConfigManagerOf(chain, servingPool, version, blockTag)
    if (pcm !== getAddress(address))
      throw new CCTParamsInvalidError(
        this.name,
        'servingPool',
        `${servingPool} ${pcm ? `calls PoolConfigManager ${pcm}` : 'is not a multi-token pool'}, not ${getAddress(address)}: name the multi-token pool that serves these tokens`,
      )
  }

  /** A pool refuses to burn to itself (`InvalidBurnAddress`), which the stores cannot see. */
  #checkBurnTargetsNotServing(
    params: ApplyMultiTokenPoolTokenProfileUpdatesParams,
    changes: readonly ProfileChange[],
    serving: readonly string[],
  ): void {
    const pools = new Set(
      [...serving, params.poolAddress, params.servingPool]
        .filter((p): p is string => p !== undefined)
        .map((p) => getAddress(p)),
    )
    for (const { param, next } of changes)
      if (
        next.lockOrBurnFlavor === 'burn-to-address' &&
        next.lockOrBurnAddress &&
        pools.has(next.lockOrBurnAddress)
      )
        throw new CCTParamsInvalidError(
          this.name,
          `${param}.lockOrBurnAddress`,
          `is ${next.lockOrBurnAddress}, a pool serving this PoolConfigManager: a pool refuses to burn to itself (InvalidBurnAddress), so every send would revert; use 0x000000000000000000000000000000000000dEaD`,
        )
  }

  /**
   * A provider set or changed by the write: it must have code (the store reverts `ProviderHasNoCode`),
   * and a factory UID provider is refused while the token's registry shows a pool history the SDK
   * cannot yet check: the registry serves it from a pool not serving this PCM, or an admin transfer is
   * pending. Such a history may have released tokens the UID provider now refuses. It passes when the
   * registry shows none.
   */
  async #checkProviders(
    chain: EVMChain,
    changes: readonly ProfileChange[],
    serving: PoolConfigManagerServingPools,
    blockTag: number,
  ): Promise<void> {
    const set = changes.filter(
      (c) =>
        c.next.additionalPoolDataProvider !== null &&
        c.next.additionalPoolDataProvider !== (c.current?.additionalPoolDataProvider ?? null),
    )
    for (const { param, next } of set) {
      const provider = next.additionalPoolDataProvider!
      if ((await chain.provider.getCode(provider, blockTag)) === '0x')
        throw new CCTParamsInvalidError(
          this.name,
          `${param}.additionalPoolDataProvider`,
          `${provider} has no code: the store refuses it (ProviderHasNoCode)`,
        )
      const [type] = await chain.typeAndVersion(provider).catch((err: unknown) => {
        if (isNotCcipContract(err)) return ['']
        throw err
      })
      if (type !== UID_PROVIDER_TYPE) continue
      const entry = serving.entries.get(next.tokenAddress)
      const diverged = serving.diverged.find((d) => d.token === next.tokenAddress)
      const history = [
        ...(diverged
          ? [
              `the registry serves it from ${diverged.pool}, which does not use this PoolConfigManager`,
            ]
          : []),
        ...(entry?.pendingAdministrator
          ? [`an admin transfer to ${entry.pendingAdministrator} is pending`]
          : []),
      ]
      if (!history.length) continue
      const finding: MultiTokenPoolLaneFinding = {
        check: 'UID_MIGRATION_UNCHECKED',
        severity: 'error',
        tokenAddress: next.tokenAddress,
        remoteChainSelector: 0n,
        reason: `${history.join(', and ')}: another pool may have released this token without the unique-ID (UID) data the provider requires, which the SDK cannot check yet. Finish the migration (point the registry at a pool serving this PoolConfigManager, settle the admin transfer) before setting a UID provider`,
      }
      throw new CCTParamsInvalidError(
        this.name,
        'guards',
        `${param} sets a UID provider on ${next.tokenAddress}: ${finding.reason}`,
        { context: { findings: [finding] } },
      )
    }
  }
}
