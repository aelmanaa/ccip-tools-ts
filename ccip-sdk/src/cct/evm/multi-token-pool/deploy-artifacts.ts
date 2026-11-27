/**
 * The creation artifacts of the multi-token pool stack: per contract type, its compiled name, its
 * constructor interface and its creation bytecode (`2.1.0-dev`: pinned to chainlink-ccip `c950d9bc`
 * until contracts-ccip ships multi-token pools).
 *
 * @packageDocumentation
 */

import BURN_MINT_MULTI_TOKEN_POOL_V2_1_0_DEV_BYTECODE from '../artifacts/bytecode/V2_1_0_DEV/burn-mint-multi-token-pool.ts'
import CONNECTION_POLICY_STORE_V2_1_0_DEV_BYTECODE from '../artifacts/bytecode/V2_1_0_DEV/connection-policy-store.ts'
import FACTORY_TOKEN_WITH_UID_POOL_DATA_PROVIDER_V2_1_0_DEV_BYTECODE from '../artifacts/bytecode/V2_1_0_DEV/factory-token-with-uid-pool-data-provider.ts'
import FEE_POLICY_STORE_V2_1_0_DEV_BYTECODE from '../artifacts/bytecode/V2_1_0_DEV/fee-policy-store.ts'
import MULTI_TOKEN_POOL_HOOKS_EXTERNAL_BLOCKLIST_V2_1_0_DEV_BYTECODE from '../artifacts/bytecode/V2_1_0_DEV/multi-token-pool-hooks-external-blocklist.ts'
import MULTI_TOKEN_POOL_HOOKS_V2_1_0_DEV_BYTECODE from '../artifacts/bytecode/V2_1_0_DEV/multi-token-pool-hooks.ts'
import POOL_CONFIG_MANAGER_V2_1_0_DEV_BYTECODE from '../artifacts/bytecode/V2_1_0_DEV/pool-config-manager.ts'
import SAME_ADDRESS_REMOTE_TOKEN_ADDRESS_PROVIDER_V2_1_0_DEV_BYTECODE from '../artifacts/bytecode/V2_1_0_DEV/same-address-remote-token-address-provider.ts'
import SECURITY_POLICY_STORE_V2_1_0_DEV_BYTECODE from '../artifacts/bytecode/V2_1_0_DEV/security-policy-store.ts'
import type { DeployArtifact } from '../operation.ts'
import {
  type MultiTokenPoolContractType,
  MultiTokenPoolVersion,
  getMultiTokenPoolInterface,
} from './contracts.ts'

/** The creation bytecode of each stack contract at `2.1.0-dev`. */
const BYTECODE = {
  BurnMintMultiTokenPool: BURN_MINT_MULTI_TOKEN_POOL_V2_1_0_DEV_BYTECODE,
  PoolConfigManager: POOL_CONFIG_MANAGER_V2_1_0_DEV_BYTECODE,
  ConnectionPolicyStore: CONNECTION_POLICY_STORE_V2_1_0_DEV_BYTECODE,
  FeePolicyStore: FEE_POLICY_STORE_V2_1_0_DEV_BYTECODE,
  SecurityPolicyStore: SECURITY_POLICY_STORE_V2_1_0_DEV_BYTECODE,
  MultiTokenPoolHooks: MULTI_TOKEN_POOL_HOOKS_V2_1_0_DEV_BYTECODE,
  MultiTokenPoolHooksExternalBlocklist:
    MULTI_TOKEN_POOL_HOOKS_EXTERNAL_BLOCKLIST_V2_1_0_DEV_BYTECODE,
  SameAddressRemoteTokenAddressProvider:
    SAME_ADDRESS_REMOTE_TOKEN_ADDRESS_PROVIDER_V2_1_0_DEV_BYTECODE,
  FactoryTokenWithUIDPoolDataProvider:
    FACTORY_TOKEN_WITH_UID_POOL_DATA_PROVIDER_V2_1_0_DEV_BYTECODE,
} as const satisfies Record<MultiTokenPoolContractType, `0x${string}`>

/**
 * The deploy artifact of a stack contract (`2.1.0-dev`): its compiled name, the cached constructor
 * {@link Interface}, and its creation bytecode.
 * @internal
 */
export function getMultiTokenPoolArtifact(type: MultiTokenPoolContractType): DeployArtifact {
  return {
    contract: type,
    iface: getMultiTokenPoolInterface(type, MultiTokenPoolVersion.V2_1_0_DEV),
    bytecode: BYTECODE[type],
  }
}
