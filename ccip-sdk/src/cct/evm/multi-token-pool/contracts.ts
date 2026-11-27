/**
 * Multi-token pool (MTTP) taxonomy for the CCT layer: the contract types of the stack, the known
 * versions, the PCM roles, and the exact, version-gated resolver every MTTP op runs first.
 *
 * @remarks Core detects multi-token pools by name (`evm/multi-token-pool.ts`, synchronous, no RPC);
 * this module adds the exact allowlists the admin ops need. The ABI tables stay unexported (an
 * exported ABI literal is inlined into the published `.d.ts`).
 *
 * @packageDocumentation
 */

import { Interface, ZeroAddress, getAddress, id as keccak256Utf8, toBeHex } from 'ethers'
import type { TypedContract } from 'ethers-abitype'

import type { LaneRecordType } from '../../../chain.ts'
import type { EVMChain } from '../../../evm/index.ts'
import { isMultiTokenPoolType } from '../../../evm/multi-token-pool.ts'
import { resultToObject } from '../../../evm/types.ts'
import { encodeFinality } from '../../../extra-args.ts'
import {
  CCTContractTypeInvalidError,
  CCTContractVersionUnsupportedError,
  CCTDataDecodeError,
} from '../../errors.ts'
import BURN_MINT_MULTI_TOKEN_POOL_V2_1_0_DEV_ABI from '../artifacts/abi/V2_1_0_DEV/burn-mint-multi-token-pool.ts'
import CONNECTION_POLICY_STORE_V2_1_0_DEV_ABI from '../artifacts/abi/V2_1_0_DEV/connection-policy-store.ts'
import FACTORY_TOKEN_WITH_UID_POOL_DATA_PROVIDER_V2_1_0_DEV_ABI from '../artifacts/abi/V2_1_0_DEV/factory-token-with-uid-pool-data-provider.ts'
import FEE_POLICY_STORE_V2_1_0_DEV_ABI from '../artifacts/abi/V2_1_0_DEV/fee-policy-store.ts'
import MULTI_TOKEN_POOL_HOOKS_EXTERNAL_BLOCKLIST_V2_1_0_DEV_ABI from '../artifacts/abi/V2_1_0_DEV/multi-token-pool-hooks-external-blocklist.ts'
import MULTI_TOKEN_POOL_HOOKS_V2_1_0_DEV_ABI from '../artifacts/abi/V2_1_0_DEV/multi-token-pool-hooks.ts'
import POOL_CONFIG_MANAGER_V2_1_0_DEV_ABI from '../artifacts/abi/V2_1_0_DEV/pool-config-manager.ts'
import SAME_ADDRESS_REMOTE_TOKEN_ADDRESS_PROVIDER_V2_1_0_DEV_ABI from '../artifacts/abi/V2_1_0_DEV/same-address-remote-token-address-provider.ts'
import SECURITY_POLICY_STORE_V2_1_0_DEV_ABI from '../artifacts/abi/V2_1_0_DEV/security-policy-store.ts'
import { getTypedContract, readContractType } from '../query.ts'

/**
 * Multi-token pool contract types the CCT layer accepts. Kept apart from `TOKEN_POOL_TYPES`, so no
 * single-token op resolves an MTTP: those ops throw `CCTContractTypeInvalidError` whose `reason`
 * names the MTTP op to use.
 */
export const MULTI_TOKEN_POOL_TYPES = ['BurnMintMultiTokenPool'] as const

/** A supported multi-token pool contract type. */
export type MultiTokenPoolType = (typeof MULTI_TOKEN_POOL_TYPES)[number]

/**
 * Exact-match guard for {@link MULTI_TOKEN_POOL_TYPES}. Named after its set so it cannot be confused
 * with core's internal name test (`type.includes('MultiTokenPool')`), which matches any variant.
 * @param v - A contract type from `typeAndVersion`.
 */
export function isSupportedMultiTokenPoolType(v: string): v is MultiTokenPoolType {
  return isMultiTokenPoolType(v) && MULTI_TOKEN_POOL_TYPES.some((t) => t === v)
}

/**
 * Known multi-token stack versions, matched against `version + (suffix ?? '')` from
 * `chain.typeAndVersion()`: `"BurnMintMultiTokenPool 2.1.0-dev"` parses to version `'2.1.0'` and
 * suffix `'-dev'`, so the join is `'2.1.0-dev'`. Exact match only: a released `2.1.0` resolves only
 * once its own entry and ABI folder exist, and never floor-matches the `-dev` encoders.
 *
 * @remarks This deliberately differs from single-token pools, where a `-dev` suffix is ignored: the
 * `-dev` MTTP contracts are pre-release and may change before the tag. Retiring `2.1.0-dev` means
 * removing it here.
 */
export const MultiTokenPoolVersion = {
  /** The pre-release stack at chainlink-ccip `c950d9bc`. */
  V2_1_0_DEV: '2.1.0-dev',
} as const

/** A known multi-token stack version. */
export type MultiTokenPoolVersion =
  (typeof MultiTokenPoolVersion)[keyof typeof MultiTokenPoolVersion]

/** Type guard for {@link MultiTokenPoolVersion}. */
function isMultiTokenPoolVersion(v: string): v is MultiTokenPoolVersion {
  return Object.values(MultiTokenPoolVersion).some((known) => known === v)
}

/** The three policy store contract types behind a PCM. */
export const POLICY_STORE_TYPES = [
  'ConnectionPolicyStore',
  'FeePolicyStore',
  'SecurityPolicyStore',
] as const
/** A policy store contract type. */
export type PolicyStoreType = (typeof POLICY_STORE_TYPES)[number]

/** The two hook contract types a security record can name. */
export const MULTI_TOKEN_POOL_HOOKS_TYPES = [
  'MultiTokenPoolHooks',
  'MultiTokenPoolHooksExternalBlocklist',
] as const
/** A multi-token pool hook contract type. */
export type MultiTokenPoolHooksType = (typeof MULTI_TOKEN_POOL_HOOKS_TYPES)[number]

/** The two provider contract types. */
export const MULTI_TOKEN_POOL_PROVIDER_TYPES = [
  'SameAddressRemoteTokenAddressProvider',
  'FactoryTokenWithUIDPoolDataProvider',
] as const
/** A provider contract type. */
export type MultiTokenPoolProviderType = (typeof MULTI_TOKEN_POOL_PROVIDER_TYPES)[number]

/** The PoolConfigManager contract type. */
export const POOL_CONFIG_MANAGER_TYPE = 'PoolConfigManager'

/** Every contract type of a multi-token stack. */
export type MultiTokenPoolContractType =
  | MultiTokenPoolType
  | typeof POOL_CONFIG_MANAGER_TYPE
  | PolicyStoreType
  | MultiTokenPoolHooksType
  | MultiTokenPoolProviderType

/**
 * The 13 PCM roles, by their Solidity constant names. IDs are `keccak256(name)` except
 * `DEFAULT_ADMIN_ROLE` (`0x00`). A closed enum: a misspelt role hashes to an ID no function checks.
 */
export const POOL_CONFIG_MANAGER_ROLES = [
  'DEFAULT_ADMIN_ROLE',
  'CONFIG_ROLE',
  'POLICY_ROLE',
  'TOKEN_MANAGER_ROLE',
  'CONNECTION_ROLE',
  'REMOTE_POOL_ROLE',
  'RATE_LIMIT_ROLE',
  'FEE_ROLE',
  'DEST_OVERHEAD_ROLE',
  'SECURITY_ROLE',
  'PAUSER_ROLE',
  'UNPAUSER_ROLE',
  'FEE_COLLECTOR_ROLE',
] as const
/** One PCM role. */
export type PoolConfigManagerRole = (typeof POOL_CONFIG_MANAGER_ROLES)[number]
/** A PCM role other than `DEFAULT_ADMIN_ROLE`, which only the two-step admin transfer moves. */
export type PoolConfigManagerGrantableRole = Exclude<PoolConfigManagerRole, 'DEFAULT_ADMIN_ROLE'>

/**
 * Type guard for {@link POOL_CONFIG_MANAGER_ROLES}.
 * @param v - A role name.
 */
export function isPoolConfigManagerRole(v: string): v is PoolConfigManagerRole {
  return POOL_CONFIG_MANAGER_ROLES.some((r) => r === v)
}

/**
 * The on-chain ID of a PCM role: `0x00…00` for `DEFAULT_ADMIN_ROLE` (OpenZeppelin), else
 * `keccak256(name)`, as the PCM's `bytes32 public constant X_ROLE = keccak256("X_ROLE")`.
 * @internal
 */
export function poolConfigManagerRoleId(role: PoolConfigManagerRole): string {
  return role === 'DEFAULT_ADMIN_ROLE' ? '0x' + '00'.repeat(32) : keccak256Utf8(role)
}

export {
  type LockOrBurnFlavor,
  LOCK_OR_BURN_FLAVORS,
  nullableAddress,
} from '../../../evm/multi-token-pool.ts'

/**
 * The finality `bytes4` the MTTP views take where finality does not change the answer (CCVs, a
 * provider's pool data): the finalized flag, `encodeFinality('finalized')`.
 * @internal
 */
export const ANY_FINALITY_CONFIG = toBeHex(encodeFinality('finalized'), 4)

/**
 * Whether a `typeAndVersion` type names a multi-token *pool*, not one of its auxiliary contracts
 * (`MultiTokenPoolHooks…` shares the name stem).
 * @internal
 */
export function reportsMultiTokenPool(type: string): boolean {
  return isMultiTokenPoolType(type) && /MultiTokenPool$/.test(type)
}

/** The op map's literal; exported as {@link MULTI_TOKEN_POOL_OPERATIONS}. */
const OPERATIONS = {
  deployConnectionPolicyStore: { contracts: ['ConnectionPolicyStore'], function: 'constructor' },
  deployFeePolicyStore: { contracts: ['FeePolicyStore'], function: 'constructor' },
  deploySecurityPolicyStore: { contracts: ['SecurityPolicyStore'], function: 'constructor' },
  deployPoolConfigManager: { contracts: ['PoolConfigManager'], function: 'constructor' },
  deployMultiTokenPool: { contracts: ['BurnMintMultiTokenPool'], function: 'constructor' },
  deployMultiTokenPoolProvider: {
    contracts: ['SameAddressRemoteTokenAddressProvider', 'FactoryTokenWithUIDPoolDataProvider'],
    function: 'constructor',
  },
  deployMultiTokenPoolHooks: {
    contracts: ['MultiTokenPoolHooks', 'MultiTokenPoolHooksExternalBlocklist'],
    function: 'constructor',
  },
  applyMultiTokenPoolTokenProfileUpdates: {
    contracts: ['PoolConfigManager'],
    function: 'applyTokenProfileUpdates',
  },
  applyMultiTokenPoolTokenPolicyUpdates: {
    contracts: ['PoolConfigManager'],
    functions: {
      connection: 'applyTokenConnectionPolicyUpdates',
      remotePool: 'applyTokenRemotePoolPolicyUpdates',
      rateLimit: 'applyTokenRateLimitPolicyUpdates',
      fee: 'applyTokenFeePolicyUpdates',
      destOverhead: 'applyTokenDestOverheadPolicyUpdates',
      security: 'applyTokenSecurityPolicyUpdates',
    } satisfies Record<LaneRecordType, string>,
  },
  applyMultiTokenPoolInlineConnectionConfigUpdates: {
    contracts: ['PoolConfigManager'],
    function: 'applyInlineConnectionConfigUpdates',
  },
  applyMultiTokenPoolConnectionPolicyConfigUpdates: {
    contracts: ['PoolConfigManager'],
    function: 'applyConnectionPolicyConfigUpdates',
  },
  applyMultiTokenPoolSubsetTokenUpdates: {
    contracts: ['PoolConfigManager'],
    function: 'applySubsetTokenUpdates',
  },
  applyMultiTokenPoolRemoteTokenAddressProviderUpdates: {
    contracts: ['PoolConfigManager'],
    function: 'applyRemoteTokenAddressProviderUpdates',
  },
  applyMultiTokenPoolInlineRemotePoolConfigUpdates: {
    contracts: ['PoolConfigManager'],
    function: 'applyInlineRemotePoolConfigUpdates',
  },
  applyMultiTokenPoolRemotePoolPolicyConfigUpdates: {
    contracts: ['PoolConfigManager'],
    function: 'applyRemotePoolPolicyConfigUpdates',
  },
  applyMultiTokenPoolInlineRateLimitConfigUpdates: {
    contracts: ['PoolConfigManager'],
    function: 'applyInlineRateLimitConfigUpdates',
  },
  applyMultiTokenPoolInlineRateLimitBucketUpdates: {
    contracts: ['PoolConfigManager'],
    function: 'applyInlineRateLimitBucketUpdates',
  },
  applyMultiTokenPoolRateLimitPolicyConfigUpdates: {
    contracts: ['PoolConfigManager'],
    function: 'applyRateLimitPolicyConfigUpdates',
  },
  applyMultiTokenPoolRateLimitPolicyBucketUpdates: {
    contracts: ['PoolConfigManager'],
    function: 'applyRateLimitPolicyBucketUpdates',
  },
  applyMultiTokenPoolInlineFeeConfigUpdates: {
    contracts: ['PoolConfigManager'],
    function: 'applyInlineFeeConfigUpdates',
  },
  applyMultiTokenPoolFeePolicyConfigUpdates: {
    contracts: ['PoolConfigManager'],
    function: 'applyFeePolicyConfigUpdates',
  },
  applyMultiTokenPoolInlineDestOverheadConfigUpdates: {
    contracts: ['PoolConfigManager'],
    function: 'applyInlineDestOverheadConfigUpdates',
  },
  applyMultiTokenPoolDestOverheadPolicyConfigUpdates: {
    contracts: ['PoolConfigManager'],
    function: 'applyDestOverheadPolicyConfigUpdates',
  },
  applyMultiTokenPoolInlineSecurityConfigUpdates: {
    contracts: ['PoolConfigManager'],
    function: 'applyInlineSecurityConfigUpdates',
  },
  applyMultiTokenPoolSecurityPolicyConfigUpdates: {
    contracts: ['PoolConfigManager'],
    function: 'applySecurityPolicyConfigUpdates',
  },
  pauseMultiTokenPoolGlobally: { contracts: ['PoolConfigManager'], function: 'pauseGlobally' },
  unpauseMultiTokenPoolGlobally: { contracts: ['PoolConfigManager'], function: 'unpauseGlobally' },
  pauseMultiTokenPoolTokens: { contracts: ['PoolConfigManager'], function: 'pauseTokens' },
  unpauseMultiTokenPoolTokens: { contracts: ['PoolConfigManager'], function: 'unpauseTokens' },
  pauseMultiTokenPoolChains: { contracts: ['PoolConfigManager'], function: 'pauseChains' },
  unpauseMultiTokenPoolChains: { contracts: ['PoolConfigManager'], function: 'unpauseChains' },
  stopMultiTokenPoolLanes: {
    contracts: ['PoolConfigManager'],
    function: 'applyInlineRateLimitConfigUpdates',
  },
  liftMultiTokenPoolLaneStops: {
    contracts: ['PoolConfigManager'],
    function: 'applyInlineRateLimitConfigUpdates',
  },
  withdrawMultiTokenPoolFeeTokens: {
    contracts: ['PoolConfigManager'],
    function: 'withdrawFeeTokens',
  },
  grantMultiTokenPoolRole: { contracts: ['PoolConfigManager'], function: 'grantRole' },
  revokeMultiTokenPoolRole: { contracts: ['PoolConfigManager'], function: 'revokeRole' },
  renounceMultiTokenPoolRole: { contracts: ['PoolConfigManager'], function: 'renounceRole' },
  renounceMultiTokenPoolDefaultAdmin: {
    contracts: ['PoolConfigManager'],
    function: 'renounceRole',
  },
  beginMultiTokenPoolDefaultAdminTransfer: {
    contracts: ['PoolConfigManager'],
    function: 'beginDefaultAdminTransfer',
  },
  acceptMultiTokenPoolDefaultAdminTransfer: {
    contracts: ['PoolConfigManager'],
    function: 'acceptDefaultAdminTransfer',
  },
  cancelMultiTokenPoolDefaultAdminTransfer: {
    contracts: ['PoolConfigManager'],
    function: 'cancelDefaultAdminTransfer',
  },
  changeMultiTokenPoolDefaultAdminDelay: {
    contracts: ['PoolConfigManager'],
    function: 'changeDefaultAdminDelay',
  },
  rollbackMultiTokenPoolDefaultAdminDelay: {
    contracts: ['PoolConfigManager'],
    function: 'rollbackDefaultAdminDelay',
  },
  setMultiTokenPoolRouter: { contracts: ['BurnMintMultiTokenPool'], function: 'setRouter' },
  setPoolConfigManager: { contracts: ['BurnMintMultiTokenPool'], function: 'setPoolConfigManager' },
  transferMultiTokenPoolOwnership: {
    contracts: ['BurnMintMultiTokenPool'],
    function: 'transferOwnership',
  },
  acceptMultiTokenPoolOwnership: {
    contracts: ['BurnMintMultiTokenPool'],
    function: 'acceptOwnership',
  },
  updatePolicyStoreAuthorizedCallers: {
    contracts: ['ConnectionPolicyStore', 'FeePolicyStore', 'SecurityPolicyStore'],
    function: 'applyAuthorizedCallerUpdates',
  },
  transferPolicyStoreOwnership: {
    contracts: ['ConnectionPolicyStore', 'FeePolicyStore', 'SecurityPolicyStore'],
    function: 'transferOwnership',
  },
  acceptPolicyStoreOwnership: {
    contracts: ['ConnectionPolicyStore', 'FeePolicyStore', 'SecurityPolicyStore'],
    function: 'acceptOwnership',
  },
  updateMultiTokenPoolHooksAuthorizedCallers: {
    contracts: ['MultiTokenPoolHooks'],
    function: 'applyAuthorizedCallerUpdates',
  },
  applyMultiTokenPoolHooksAllowlistUpdates: {
    contracts: ['MultiTokenPoolHooks'],
    function: 'applyAllowListUpdates',
  },
  setMultiTokenPoolHooksPolicyEngine: {
    contracts: ['MultiTokenPoolHooks'],
    function: 'setPolicyEngine',
  },
  setMultiTokenPoolHooksBlocklist: {
    contracts: ['MultiTokenPoolHooksExternalBlocklist'],
    function: 'setBlocklist',
  },
  transferMultiTokenPoolHooksOwnership: {
    contracts: ['MultiTokenPoolHooks'],
    function: 'transferOwnership',
  },
  acceptMultiTokenPoolHooksOwnership: {
    contracts: ['MultiTokenPoolHooks'],
    function: 'acceptOwnership',
  },
} as const satisfies Record<string, MultiTokenPoolOperationTarget>

/**
 * Every MTTP op, mapped to the contract(s) it targets and the function it calls (`constructor` for
 * deploys). Ops whose target is one of several contracts list each. The CLI ADR's
 * `source.operation` ↔ contract table is generated from this map; a unit test checks every function
 * against the vendored ABIs.
 */
export const MULTI_TOKEN_POOL_OPERATIONS: {
  readonly [Op in keyof typeof OPERATIONS]: (typeof OPERATIONS)[Op] & MultiTokenPoolOperationTarget
} = OPERATIONS

/** An MTTP op that calls one function (not a merged op). @internal */
export type MultiTokenPoolSingleFunctionOperation = {
  [Op in keyof typeof OPERATIONS]: (typeof OPERATIONS)[Op] extends { function: string } ? Op : never
}[keyof typeof OPERATIONS]

/** The function an op calls, from the op map (its one source of truth). @internal */
export function multiTokenPoolFunctionOf(op: MultiTokenPoolSingleFunctionOperation): string {
  return OPERATIONS[op].function
}

/**
 * The contract(s) and function(s) one MTTP op calls; see {@link MULTI_TOKEN_POOL_OPERATIONS}. A
 * merged op (one op over several record types or store kinds) names one function per kind.
 */
export type MultiTokenPoolOperationTarget = {
  /** Contract types the op can target (one of them per call). */
  readonly contracts: readonly MultiTokenPoolContractType[]
} & (
  | {
      /** The function the op calls, or `constructor` for a deploy. */
      readonly function: string
    }
  | {
      /** The function per kind the op takes (e.g. per `recordType`). */
      readonly functions: Readonly<Record<string, string>>
    }
)

/**
 * The PCM role, besides `CONFIG_ROLE` and `TOKEN_MANAGER_ROLE`, that may assign each record type's
 * policy (`PoolConfigManager._checkTokenRoles`, chainlink-ccip c950d9bc).
 * @internal
 */
export const TOKEN_POLICY_ROLES = {
  connection: 'CONNECTION_ROLE',
  remotePool: 'REMOTE_POOL_ROLE',
  rateLimit: 'RATE_LIMIT_ROLE',
  fee: 'FEE_ROLE',
  destOverhead: 'DEST_OVERHEAD_ROLE',
  security: 'SECURITY_ROLE',
} as const satisfies Record<LaneRecordType, PoolConfigManagerRole>

/** An MTTP op name, or an existing CCT op a planner step runs. */
export type MultiTokenPoolOperationName =
  | keyof typeof OPERATIONS
  | 'grantMintAndBurnRoles'
  | 'registerAdmin'
  | 'acceptAdmin'
  | 'setPool'
  | 'applyCCVConfigUpdates'
  | 'setThresholdAmount'
  | 'revokeMintRole'
  | 'revokeBurnRole'
  | 'withdrawFeeTokens'
  | 'addRemotePool'

/**
 * Reads an address's type and its version joined with the suffix (`'2.1.0' + '-dev'`).
 * @throws {@link CCTContractTypeInvalidError} if the address reports no `typeAndVersion`
 */
async function readReportedContract(
  chain: EVMChain,
  address: string,
  expected: readonly string[],
): Promise<{ contractType: string; version: string }> {
  const [contractType, version, , suffix] = await readContractType(
    chain,
    address,
    expected.join(', '),
  )
  return { contractType, version: version + (suffix ?? '') }
}

/**
 * Why `contractType` is not one of `expected`, naming the read that takes it, for the common
 * mix-ups: a PCM passed as a pool, a single-token pool passed to a multi-token op.
 */
function wrongTypeReason(contractType: string, expected: readonly string[]): string | undefined {
  if (
    contractType === POOL_CONFIG_MANAGER_TYPE &&
    expected.some((t) => isSupportedMultiTokenPoolType(t))
  )
    return 'this is a PoolConfigManager, not a pool: pass it as poolConfigManager'
  if (
    isSupportedMultiTokenPoolType(contractType) &&
    expected.some((t) => t === POOL_CONFIG_MANAGER_TYPE)
  )
    return 'this is a multi-token pool: pass it as poolAddress, which resolves its PoolConfigManager'
  if (contractType.endsWith('TokenPool') && !isMultiTokenPoolType(contractType))
    return 'this is a single-token pool: use getTokenPoolState and the single-token ops'
  return undefined
}

/**
 * Resolves a multi-token stack contract (pool, PCM or store) at `address`: its reported type must be
 * one of `expected`, and its version must be a known {@link MultiTokenPoolVersion}.
 *
 * @remarks Exact match on both. Each contract's ABI is chosen by its own version, so a PCM is resolved
 * on its own, not through its pool's version.
 * @param chain - Chain to read on.
 * @param address - Contract address.
 * @param expected - Accepted contract types.
 * @returns The reported type and the joined version.
 * @throws {@link CCTContractTypeInvalidError} if the address reports no `typeAndVersion`, or a type
 * not in `expected`
 * @throws {@link CCTContractVersionUnsupportedError} if the version is not a known one
 * @internal
 */
export async function resolveMultiTokenPoolContract<T extends MultiTokenPoolContractType>(
  chain: EVMChain,
  address: string,
  expected: readonly T[],
): Promise<{ type: T; version: MultiTokenPoolVersion }> {
  const { contractType, version } = await readReportedContract(chain, address, expected)
  const type = expected.find((t) => t === contractType)
  if (!type)
    throw new CCTContractTypeInvalidError(
      address,
      expected.join(', '),
      contractType,
      wrongTypeReason(contractType, expected),
    )
  if (!isMultiTokenPoolVersion(version))
    throw new CCTContractVersionUnsupportedError(contractType, version, { context: { address } })
  return { type, version }
}

/**
 * Checks that an auxiliary contract (hooks, provider) at `address` reports one of `expected`, on
 * type only, as `assertAdvancedPoolHooksContract` does: a later version keeps binding.
 * @param chain - Chain to read on.
 * @param address - Contract address.
 * @param expected - Accepted contract types.
 * @returns The reported type.
 * @throws {@link CCTContractTypeInvalidError} if the address reports no `typeAndVersion`, or a type
 * not in `expected`
 * @internal
 */
export async function assertMultiTokenPoolAuxContract<
  T extends MultiTokenPoolHooksType | MultiTokenPoolProviderType,
>(chain: EVMChain, address: string, expected: readonly T[]): Promise<T> {
  const { contractType } = await readReportedContract(chain, address, expected)
  const type = expected.find((t) => t === contractType)
  if (!type) throw new CCTContractTypeInvalidError(address, expected.join(', '), contractType)
  return type
}

/**
 * Each stack contract's ABI per version (exact: a type that never shipped at a version has no entry).
 * Unexported on purpose: an exported ABI literal is inlined into the published `.d.ts`.
 */
const MULTI_TOKEN_POOL_ABIS = {
  BurnMintMultiTokenPool: {
    [MultiTokenPoolVersion.V2_1_0_DEV]: BURN_MINT_MULTI_TOKEN_POOL_V2_1_0_DEV_ABI,
  },
  PoolConfigManager: { [MultiTokenPoolVersion.V2_1_0_DEV]: POOL_CONFIG_MANAGER_V2_1_0_DEV_ABI },
  ConnectionPolicyStore: {
    [MultiTokenPoolVersion.V2_1_0_DEV]: CONNECTION_POLICY_STORE_V2_1_0_DEV_ABI,
  },
  FeePolicyStore: { [MultiTokenPoolVersion.V2_1_0_DEV]: FEE_POLICY_STORE_V2_1_0_DEV_ABI },
  SecurityPolicyStore: { [MultiTokenPoolVersion.V2_1_0_DEV]: SECURITY_POLICY_STORE_V2_1_0_DEV_ABI },
  MultiTokenPoolHooks: {
    [MultiTokenPoolVersion.V2_1_0_DEV]: MULTI_TOKEN_POOL_HOOKS_V2_1_0_DEV_ABI,
  },
  MultiTokenPoolHooksExternalBlocklist: {
    [MultiTokenPoolVersion.V2_1_0_DEV]: MULTI_TOKEN_POOL_HOOKS_EXTERNAL_BLOCKLIST_V2_1_0_DEV_ABI,
  },
  SameAddressRemoteTokenAddressProvider: {
    [MultiTokenPoolVersion.V2_1_0_DEV]: SAME_ADDRESS_REMOTE_TOKEN_ADDRESS_PROVIDER_V2_1_0_DEV_ABI,
  },
  FactoryTokenWithUIDPoolDataProvider: {
    [MultiTokenPoolVersion.V2_1_0_DEV]: FACTORY_TOKEN_WITH_UID_POOL_DATA_PROVIDER_V2_1_0_DEV_ABI,
  },
} as const satisfies Record<
  MultiTokenPoolContractType,
  Partial<Record<MultiTokenPoolVersion, unknown>>
>

/** One cached {@link Interface} per (contract type, version). */
const INTERFACES = new Map<string, Interface>()

/**
 * The cached {@link Interface} of a stack contract at a version, built on first use.
 * @param type - Contract type.
 * @param version - Its resolved version.
 * @internal
 */
export function getMultiTokenPoolInterface(
  type: MultiTokenPoolContractType,
  version: MultiTokenPoolVersion,
): Interface {
  const key = `${type} ${version}`
  let iface = INTERFACES.get(key)
  if (!iface) {
    iface = new Interface(MULTI_TOKEN_POOL_ABIS[type][version])
    INTERFACES.set(key, iface)
  }
  return iface
}

// ─── Typed handles ─────────────────────────────────────────────────────────────────────────
// Every handle has an explicit return type: an inferred one would inline the whole ABI literal into
// the published `.d.ts`. When a second version lands, widen each to a union of `typeof` its ABIs.

/**
 * A call-typed handle on a resolved multi-token pool.
 * @internal
 */
export function multiTokenPoolContract(
  chain: EVMChain,
  address: string,
  version: MultiTokenPoolVersion,
): TypedContract<typeof BURN_MINT_MULTI_TOKEN_POOL_V2_1_0_DEV_ABI> {
  return getTypedContract(chain, address, MULTI_TOKEN_POOL_ABIS.BurnMintMultiTokenPool[version])
}

/**
 * A call-typed handle on a resolved PoolConfigManager.
 * @internal
 */
export function poolConfigManagerContract(
  chain: EVMChain,
  address: string,
  version: MultiTokenPoolVersion,
): TypedContract<typeof POOL_CONFIG_MANAGER_V2_1_0_DEV_ABI> {
  return getTypedContract(chain, address, MULTI_TOKEN_POOL_ABIS.PoolConfigManager[version])
}

/**
 * A call-typed handle on a PCM's ConnectionPolicyStore (pause flags, profiles, pause logs).
 * @internal
 */
export function connectionPolicyStoreContract(
  chain: EVMChain,
  address: string,
  version: MultiTokenPoolVersion,
): TypedContract<typeof CONNECTION_POLICY_STORE_V2_1_0_DEV_ABI> {
  return getTypedContract(chain, address, MULTI_TOKEN_POOL_ABIS.ConnectionPolicyStore[version])
}

/**
 * A handle on the getters the three policy stores share (`Ownable2Step`, `AuthorizedCallers`), through
 * the ConnectionPolicyStore ABI, which declares them identically.
 * @internal
 */
export function policyStoreContract(
  chain: EVMChain,
  address: string,
  version: MultiTokenPoolVersion,
): TypedContract<typeof CONNECTION_POLICY_STORE_V2_1_0_DEV_ABI> {
  return connectionPolicyStoreContract(chain, address, version)
}

/**
 * A handle on a hook contract. Hooks are gated on type only, so the vendored `2.1.0-dev` ABI of the
 * external-blocklist variant (a superset of the base hooks) is used for every version.
 * @internal
 */
export function multiTokenPoolHooksContract(
  chain: EVMChain,
  address: string,
): TypedContract<typeof MULTI_TOKEN_POOL_HOOKS_EXTERNAL_BLOCKLIST_V2_1_0_DEV_ABI> {
  return getTypedContract(
    chain,
    address,
    MULTI_TOKEN_POOL_ABIS.MultiTokenPoolHooksExternalBlocklist[MultiTokenPoolVersion.V2_1_0_DEV],
  )
}

/**
 * A handle on a UID provider (gated on type only, as the hooks).
 * @internal
 */
export function uidProviderContract(
  chain: EVMChain,
  address: string,
): TypedContract<typeof FACTORY_TOKEN_WITH_UID_POOL_DATA_PROVIDER_V2_1_0_DEV_ABI> {
  return getTypedContract(
    chain,
    address,
    MULTI_TOKEN_POOL_ABIS.FactoryTokenWithUIDPoolDataProvider[MultiTokenPoolVersion.V2_1_0_DEV],
  )
}

/**
 * A handle on a SameAddress remote token address provider (gated on type only, as the hooks).
 * @internal
 */
export function sameAddressProviderContract(
  chain: EVMChain,
  address: string,
): TypedContract<typeof SAME_ADDRESS_REMOTE_TOKEN_ADDRESS_PROVIDER_V2_1_0_DEV_ABI> {
  return getTypedContract(
    chain,
    address,
    MULTI_TOKEN_POOL_ABIS.SameAddressRemoteTokenAddressProvider[MultiTokenPoolVersion.V2_1_0_DEV],
  )
}

/**
 * ERC-165 ID of `IMultiTokenPool`: the XOR of the selectors it declares itself
 * (`isSupportedChain(address,uint64)`, `getRemoteToken(address,uint64)`, `getTokenDecimals(address)`,
 * `withdrawFeeTokens(address[],address)`). `contracts.test.ts` recomputes it from the vendored ABI.
 * @internal
 */
export const I_MULTI_TOKEN_POOL_INTERFACE_ID = '0x409c3bb0'

/** Storage slot of `s_pendingOwner` in Chainlink `Ownable2Step` (declared first; `s_owner` is slot 1). */
const PENDING_OWNER_SLOT = 0n
/** Storage slot of `s_owner` in Chainlink `Ownable2Step`. */
const OWNER_SLOT = 1n

/** The address an `address` storage word holds. */
function wordToAddress(word: string): string {
  return getAddress('0x' + word.slice(-40))
}

/**
 * The getters every contract of the stack shares (`Ownable2Step.owner`, and ERC-165 on the pool),
 * through the vendored pool ABI, for a probe that does not know the contract's type yet.
 * @internal
 */
export function multiTokenPoolProbe(
  chain: EVMChain,
  address: string,
): Pick<
  TypedContract<typeof BURN_MINT_MULTI_TOKEN_POOL_V2_1_0_DEV_ABI>,
  'owner' | 'supportsInterface'
> {
  return multiTokenPoolContract(chain, address, MultiTokenPoolVersion.V2_1_0_DEV)
}

/** A contract's owner and its pending `Ownable2Step` transfer. */
export type PendingOwner = {
  /** The proposed owner that has not accepted yet, or `null` when no transfer is pending. */
  pendingOwner: string | null
}

/**
 * Reads a Chainlink `Ownable2Step` contract's owner and pending owner at one block. The pending owner
 * has no getter: it is storage slot 0, read only after checking that slot 1 holds `owner()`, so a
 * different storage layout is reported, never misread.
 *
 * @param chain - Chain to read on.
 * @param address - The `Ownable2Step` contract.
 * @param blockTag - Block to read at; defaults to the latest block, read once.
 * @returns `owner` and `pendingOwner` (`null` when no transfer is pending).
 * @throws {@link CCTDataDecodeError} if slot 1 does not hold `owner()`: the layout is not the
 * vendored one
 * @internal
 */
export async function readOwnership(
  chain: EVMChain,
  address: string,
  blockTag?: number,
): Promise<PendingOwner & { owner: string }> {
  // one block for the getter and both slots, so a transfer landing in between cannot look like a
  // layout mismatch
  const block = blockTag ?? (await chain.provider.getBlockNumber())
  const [owner, ownerWord, pendingWord] = await Promise.all([
    multiTokenPoolProbe(chain, address)
      .owner({ blockTag: block })
      .then((o) => getAddress(resultToObject(o))),
    chain.provider.getStorage(address, OWNER_SLOT, block),
    chain.provider.getStorage(address, PENDING_OWNER_SLOT, block),
  ])
  if (wordToAddress(ownerWord) !== owner)
    throw new CCTDataDecodeError(address, {
      recovery:
        'The contract is not laid out as Chainlink Ownable2Step (owner in slot 1), so its pending owner cannot be read safely; owner() still works. Check the address and its typeAndVersion.',
      context: {
        reason: `storage slot ${OWNER_SLOT} does not hold owner() ${owner}`,
      },
    })
  const pending = wordToAddress(pendingWord)
  return { owner, pendingOwner: pending === ZeroAddress ? null : pending }
}

/** Errors a node returns for state it has pruned (no archive), as opposed to a transport failure. */
const PRUNED_STATE =
  /missing trie node|header not found|historical state|state (is )?not available|pruned|archive/i

/**
 * The block a contract was deployed in: the lowest block where it has code, by binary search over
 * `eth_getCode` (needs an RPC that serves historical state).
 * @param chain - Chain to read on.
 * @param address - The contract.
 * @param latest - Upper bound of the search.
 * @returns The deployment block (`latest + 1` when there is no code at `latest`), or `undefined`
 * when the RPC answers historical code with a pruned-state error. Any other error propagates.
 * @remarks A node that answers pruned history with `0x` instead of an error makes the search land
 * later than the real deployment; callers treat the result as a lower bound of what they scanned.
 * @internal
 */
export async function findDeploymentBlock(
  chain: EVMChain,
  address: string,
  latest: number,
): Promise<number | undefined> {
  try {
    if ((await chain.provider.getCode(address, latest)) === '0x') return latest + 1
    let [lo, hi] = [0, latest]
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      if ((await chain.provider.getCode(address, mid)) === '0x') lo = mid + 1
      else hi = mid
    }
    return lo
  } catch (err) {
    if (err instanceof Error && PRUNED_STATE.test(err.message)) return
    throw err
  }
}

/**
 * Resolves a multi-token pool at `address` (exact type and version).
 * @throws as {@link resolveMultiTokenPoolContract}
 * @internal
 */
export function resolveMultiTokenPool(chain: EVMChain, address: string) {
  return resolveMultiTokenPoolContract(chain, address, MULTI_TOKEN_POOL_TYPES)
}
