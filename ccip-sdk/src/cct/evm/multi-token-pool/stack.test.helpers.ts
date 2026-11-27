/**
 * In-memory multi-token stack for unit tests — test-support code, NOT part of the SDK.
 *
 * Answers the `eth_call`s, storage, code and log reads the MTTP CCT ops make against a pool, its
 * PoolConfigManager and its three stores. Calldata is decoded and results encoded with interfaces
 * built here from human-readable signatures (not the SDK's vendored ABIs), so tests stay
 * non-circular (rule R16). Every call is recorded, so tests can assert "no RPC before validation".
 *
 * @packageDocumentation
 */

import { Interface, ZeroAddress, getAddress, id, makeError, zeroPadValue } from 'ethers'

import type { EVMChain } from '../../../evm/index.ts'
import { parseTypeAndVersion } from '../../../utils.ts'

export const POOL = getAddress('0x' + '11'.repeat(20))
export const PCM = getAddress('0x' + '22'.repeat(20))
export const CPS = getAddress('0x' + '33'.repeat(20))
export const FPS = getAddress('0x' + '44'.repeat(20))
export const SPS = getAddress('0x' + '55'.repeat(20))
export const TAR = getAddress('0x' + '66'.repeat(20))
export const ROUTER = getAddress('0x' + '77'.repeat(20))
export const RMN = getAddress('0x' + '88'.repeat(20))
export const OWNER = getAddress('0x' + 'aa'.repeat(20))
export const OTHER = getAddress('0x' + 'bb'.repeat(20))

/** `DEFAULT_ADMIN_ROLE` and `keccak256(name)` for the rest, as the PCM constants. */
export const roleId = (role: string) =>
  role === 'DEFAULT_ADMIN_ROLE' ? '0x' + '00'.repeat(32) : id(role)

export const POOL_IFACE = new Interface([
  'function typeAndVersion() view returns (string)',
  'function supportsInterface(bytes4) view returns (bool)',
  'function owner() view returns (address)',
  'function getRouter() view returns (address)',
  'function getRmnProxy() view returns (address)',
  'function getPoolConfigManager() view returns (address)',
])
export const PCM_IFACE = new Interface([
  'function typeAndVersion() view returns (string)',
  'function getStaticConfig() view returns (address tokenAdminRegistry, address connectionStore, address feeStore, address securityStore)',
  'function defaultAdmin() view returns (address)',
  'function pendingDefaultAdmin() view returns (address newAdmin, uint48 schedule)',
  'function defaultAdminDelay() view returns (uint48)',
  'function pendingDefaultAdminDelay() view returns (uint48 newDelay, uint48 schedule)',
  'function defaultAdminDelayIncreaseWait() view returns (uint48)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function getAllConfiguredTokens(uint64 startIndex, uint64 maxCount) view returns (address[])',
  'function getConnectionPolicy(bytes32) view returns (uint32, address, tuple(bytes32 policyName, uint64 remoteChainSelector, bool onlySubsetTokens)[])',
  'function getFeePolicy(bytes32) view returns (uint32, tuple(bytes32 policyName, uint64 remoteChainSelector, tuple(uint32 finalityFeeUSDCents, uint32 fastFinalityFeeUSDCents, uint16 finalityTransferFeeBps, uint16 fastFinalityTransferFeeBps) feeConfig)[])',
  'function getRateLimitPolicy(bytes32) view returns (uint32, uint8, tuple(bytes32 policyName, uint64 remoteChainSelector, uint8 localDecimals, tuple(tuple(bool isEnabled, uint128 capacity, uint128 rate) outbound, tuple(bool isEnabled, uint128 capacity, uint128 rate) inbound, tuple(bool isEnabled, uint128 capacity, uint128 rate) fastFinalityOutbound, tuple(bool isEnabled, uint128 capacity, uint128 rate) fastFinalityInbound) rateLimitConfig)[])',
  'function getSecurityPolicy(bytes32) view returns (uint32, tuple(bytes32 policyName, uint64 remoteChainSelector, tuple(address[] outboundCCVs, address[] inboundCCVs, address hook) securityConfig)[])',
  'function getSubsetTokens(bytes32, uint64, uint64, uint64) view returns (bool, address[])',
  'function getPolicyNames() view returns (bytes32[], bytes32[], bytes32[], bytes32[], bytes32[], bytes32[])',
  'function getInlineConnectionConfigs(address) view returns (tuple(address localToken, uint64 remoteChainSelector, bytes remoteToken)[])',
  'function getInlineFeeConfigs(address) view returns (tuple(address localToken, uint64 remoteChainSelector, tuple(uint32 finalityFeeUSDCents, uint32 fastFinalityFeeUSDCents, uint16 finalityTransferFeeBps, uint16 fastFinalityTransferFeeBps) feeConfig)[])',
  'function getTokenConfigBatch(address[] localTokens) view returns (tuple(bool isRegistered, uint8 localDecimals, uint8 lockOrBurnFlavor, bytes4 allowedFinalityConfig, address lockOrBurnAddress, address additionalPoolDataProvider, uint64[] supportedChains, bytes32 connectionPolicyName, bytes32 remotePoolPolicyName, bytes32 rateLimitPolicyName, bytes32 feePolicyName, bytes32 destOverheadPolicyName, bytes32 securityPolicyName)[] configs)',
  'function getLaneConnectionBatch(tuple(address localToken, uint64 remoteChainSelector)[] lanes) view returns (tuple(bool hasConnection, bool isOutboundPaused, bool isInboundPaused, bool isGloballyPaused, bool isTokenOutboundPaused, bool isTokenInboundPaused, bool isChainOutboundPaused, bool isChainInboundPaused, bool useLegacyPoolDataOnSend, bytes remoteToken, tuple(bytes remotePoolAddress, bool allowLegacyPoolDataOnReceive)[] remotePools)[] connections)',
  'function getLaneRecordLevelBatch(tuple(address localToken, uint64 remoteChainSelector)[] lanes) view returns (uint8[] connectionLevels, uint8[] remotePoolLevels, uint8[] rateLimitLevels, uint8[] feeLevels, uint8[] destOverheadLevels, uint8[] securityLevels)',
  'function getFeeBatch(tuple(address localToken, uint64 remoteChainSelector)[] lanes, bytes4 requestedFinalityConfig) view returns (tuple(uint256 feeUSDCents, uint32 destGasOverhead, uint32 destBytesOverhead, uint16 tokenFeeBps, bool isEnabled)[] fees)',
  'function getTokenTransferFeeConfigBatch(tuple(address localToken, uint64 remoteChainSelector)[] lanes) view returns (tuple(uint32 destGasOverhead, uint32 destBytesOverhead, uint32 finalityFeeUSDCents, uint32 fastFinalityFeeUSDCents, uint16 finalityTransferFeeBps, uint16 fastFinalityTransferFeeBps, bool isEnabled)[] feeConfigs)',
  'function getCurrentRateLimiterStateBatch(tuple(address localToken, uint64 remoteChainSelector)[] lanes) view returns (tuple(tuple(uint128 tokens, uint32 lastUpdated, bool isEnabled, uint128 capacity, uint128 rate) outbound, tuple(uint128 tokens, uint32 lastUpdated, bool isEnabled, uint128 capacity, uint128 rate) inbound, tuple(uint128 tokens, uint32 lastUpdated, bool isEnabled, uint128 capacity, uint128 rate) fastFinalityOutbound, tuple(uint128 tokens, uint32 lastUpdated, bool isEnabled, uint128 capacity, uint128 rate) fastFinalityInbound)[] states)',
  'function getLaneVerificationBatch(tuple(address localToken, uint64 remoteChainSelector)[] lanes, bytes4) view returns (address[] hooks, address[][] outboundCCVs, address[][] inboundCCVs)',
  'event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)',
  'event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)',
])
/** Views of the auxiliary contracts (hooks, providers), answered through `state.views`. */
export const AUX_IFACE = new Interface([
  'function owner() view returns (address)',
  'function getAllAuthorizedCallers() view returns (address[])',
  'function getAllowListEnabled() view returns (bool)',
  'function getAllowList() view returns (address[])',
  'function getPolicyEngine() view returns (address)',
  'function getBlocklist() view returns (address)',
  'function getRemoteTokenAddress(address localToken, uint64 remoteChainSelector) view returns (bytes)',
  'function getTokenFactory() view returns (address)',
  'function getAdditionalPoolData(address localToken, uint64 remoteChainSelector, bytes4 finality, bytes extraArgs) view returns (bytes)',
])
/** The ERC20 view a fee withdrawal reads (a token in `others`, answered through `state.views`). */
export const ERC20_IFACE = new Interface([
  'function balanceOf(address account) view returns (uint256)',
])
/**
 * The writes a simulation sends (the PCM's role, admin and withdrawal writes): served by
 * `state.writes` (a throw reverts), else they succeed.
 */
export const WRITE_IFACE = new Interface([
  'function grantRole(bytes32 role, address account)',
  'function revokeRole(bytes32 role, address account)',
  'function renounceRole(bytes32 role, address account)',
  'function beginDefaultAdminTransfer(address newAdmin)',
  'function acceptDefaultAdminTransfer()',
  'function cancelDefaultAdminTransfer()',
  'function changeDefaultAdminDelay(uint48 newDelay)',
  'function rollbackDefaultAdminDelay()',
  'function withdrawFeeTokens(address pool, address[] feeTokens, address recipient)',
  'function pauseGlobally()',
  'function unpauseGlobally()',
])
/** The TokenAdminRegistry view the registry reads use. */
export const TAR_IFACE = new Interface([
  'function getTokenConfig(address token) view returns ((address administrator, address pendingAdministrator, address tokenPool))',
])

export const STORE_IFACE = new Interface([
  'error InvalidRequestedFinality(bytes4 requestedFinality, bytes4 allowedFinality)',
  'error LocalTokenNotRegistered(address localToken)',
  'function typeAndVersion() view returns (string)',
  'function owner() view returns (address)',
  'function getAllAuthorizedCallers() view returns (address[])',
  'function getTokenProfiles(address[] localTokens) view returns (tuple(bool isRegistered, uint8 localDecimals, uint8 lockOrBurnFlavor, address lockOrBurnAddress, bytes4 allowedFinalityConfig, bool isOutboundPaused, bool isInboundPaused, address additionalPoolDataProvider)[] profiles)',
  'event ChainPauseSet(uint64 indexed remoteChainSelector, bool outbound, bool inbound)',
])

/** The state the stub serves; every field has a consistent default stack. */
export type StackState = {
  pool: { typeAndVersion: string; owner: string; pendingOwner: string; supports165: boolean }
  pcm: {
    typeAndVersion: string
    defaultAdmin: string
    pendingDefaultAdmin: [string, bigint]
    delay: bigint
    pendingDelay: [bigint, bigint]
    increaseWait: bigint
    tar: string
    roles: Record<string, string[]>
    tokens: string[]
  }
  stores: Record<
    string,
    { typeAndVersion: string; owner: string; pendingOwner: string; callers: string[] }
  >
  /** token → the pool the TokenAdminRegistry serves it from. */
  tarPools: Record<string, string>
  /** RoleGranted/RoleRevoked logs, oldest first. */
  roleLogs: {
    event: 'RoleGranted' | 'RoleRevoked'
    role: string
    account: string
    blockNumber: number
  }[]
  deploymentBlock: number
  latestBlock: number
  /** Extra contracts answering typeAndVersion (e.g. other pools, stale PCMs). */
  others: Record<string, string>
  /**
   * Per-function answers for PCM and store views the defaults do not model, keyed by function name:
   * the decoded args in, the output values out. Throwing from one reverts the call.
   */
  views: Record<string, (args: readonly unknown[], to: string) => unknown[]>
  /** Ownable2Step state of auxiliary contracts (hooks), for the storage reads. */
  auxOwners: Record<string, { owner: string; pendingOwner: string }>
  /** Raw logs served by `getLogs` besides the role logs. */
  logs: { address: string; topics: string[]; data: string; blockNumber: number }[]
  /**
   * Simulated writes ({@link WRITE_IFACE}), keyed by function name: throwing reverts the call; a
   * write with no entry succeeds.
   */
  writes?: Record<string, (args: readonly unknown[], to: string, from: string | undefined) => void>
  /** The timestamp of every block (`getBlock`); defaults to 0. */
  timestamp?: number
  /**
   * A node without archive state: historical `getCode` fails as pruned (for every address, or only
   * for the ones listed).
   */
  pruned?: boolean | string[]
  /** The PCM-wide pause, as the lane views report it. */
  globallyPaused?: boolean
}

/** A consistent default stack: one owner everywhere, PCM authorized on every store. */
export function defaultStack(): StackState {
  return {
    pool: {
      typeAndVersion: 'BurnMintMultiTokenPool 2.1.0-dev',
      owner: OWNER,
      pendingOwner: ZeroAddress,
      supports165: true,
    },
    pcm: {
      typeAndVersion: 'PoolConfigManager 2.1.0-dev',
      defaultAdmin: OWNER,
      pendingDefaultAdmin: [ZeroAddress, 0n],
      delay: 86_400n,
      pendingDelay: [0n, 0n],
      increaseWait: 432_000n,
      tar: TAR,
      roles: { DEFAULT_ADMIN_ROLE: [OWNER], CONFIG_ROLE: [OWNER] },
      tokens: [],
    },
    stores: {
      [CPS]: {
        typeAndVersion: 'ConnectionPolicyStore 2.1.0-dev',
        owner: OWNER,
        pendingOwner: ZeroAddress,
        callers: [PCM],
      },
      [FPS]: {
        typeAndVersion: 'FeePolicyStore 2.1.0-dev',
        owner: OWNER,
        pendingOwner: ZeroAddress,
        callers: [PCM],
      },
      [SPS]: {
        typeAndVersion: 'SecurityPolicyStore 2.1.0-dev',
        owner: OWNER,
        pendingOwner: ZeroAddress,
        callers: [PCM],
      },
    },
    tarPools: {},
    roleLogs: [
      { event: 'RoleGranted', role: 'DEFAULT_ADMIN_ROLE', account: OWNER, blockNumber: 100 },
      { event: 'RoleGranted', role: 'CONFIG_ROLE', account: OWNER, blockNumber: 101 },
    ],
    deploymentBlock: 100,
    latestBlock: 1_000,
    others: {},
    views: {},
    auxOwners: {},
    logs: [],
  }
}

/** A word of storage holding an address. */
const word = (address: string) => zeroPadValue(address, 32)

/**
 * A custom-error revert for a `state.views` answer to throw: `throw revert(iface, 'Error', [args])`.
 */
export function revert(iface: Interface, error: string, args: readonly unknown[] = []): Error {
  return Object.assign(makeError('execution reverted', 'CALL_EXCEPTION'), {
    revertData: iface.encodeErrorResult(error, args),
  })
}

/** A missing function, as a node reports it to ethers. */
function callException(): Error {
  return Object.assign(makeError('execution reverted', 'CALL_EXCEPTION'), { data: '0x' })
}

/**
 * An {@link EVMChain} stub serving `state`. `calls` records every RPC, in order, as
 * `<method>:<to>[:<function>]`.
 */
export function stackChain(state: StackState = defaultStack()) {
  const calls: string[] = []
  /** Every `eth_call` with its function name and block tag, for block-pinning checks. */
  const callBlocks: { name: string; blockTag: unknown }[] = []
  const answer = (
    iface: Interface,
    data: string,
    f: (name: string, args: readonly unknown[]) => unknown[],
  ) => {
    const tx = iface.parseTransaction({ data })
    if (!tx) throw callException()
    let out
    try {
      out = f(tx.name, tx.args)
    } catch (err) {
      // a view that throws is a contract revert, as a node reports it; a thrown `{ revertData }`
      // carries the encoded custom error
      const data = (err as { revertData?: string }).revertData
      throw data ? Object.assign(callException(), { data }) : callException()
    }
    return iface.encodeFunctionResult(tx.fragment, out)
  }
  const typeAndVersionOf = (to: string): string | undefined =>
    to === POOL
      ? state.pool.typeAndVersion
      : to === PCM
        ? state.pcm.typeAndVersion
        : (state.stores[to]?.typeAndVersion ?? state.others[to])
  const provider = {
    call: async ({
      to,
      data,
      blockTag,
      from,
    }: {
      to: string
      data: string
      blockTag?: unknown
      from?: string
    }) => {
      const addr = getAddress(to)
      calls.push(`call:${addr}:${data.slice(0, 10)}`)
      const write = WRITE_IFACE.parseTransaction({ data })
      if (write) {
        callBlocks.push({ name: write.name, blockTag })
        try {
          state.writes?.[write.name]?.(write.args, addr, from)
        } catch (err) {
          const revertData = (err as { revertData?: string }).revertData
          throw revertData ? Object.assign(callException(), { data: revertData }) : callException()
        }
        return '0x'
      }
      const fn = [POOL_IFACE, PCM_IFACE, STORE_IFACE]
        .map((i) => i.getFunction(data.slice(0, 10)))
        .find(Boolean)
      callBlocks.push({ name: fn?.name ?? data.slice(0, 10), blockTag })
      if (addr === POOL)
        return answer(POOL_IFACE, data, (name, args) => {
          switch (name) {
            case 'supportsInterface':
              if (!state.pool.supports165) throw callException()
              return [args[0] === '0x409c3bb0']
            case 'owner':
              return [state.pool.owner]
            case 'getRouter':
              return [ROUTER]
            case 'getRmnProxy':
              return [RMN]
            case 'getPoolConfigManager':
              return [PCM]
            default:
              throw callException()
          }
        })
      if (addr === PCM)
        return answer(PCM_IFACE, data, (name, args) => {
          if (state.views[name]) return state.views[name](args, addr)
          const pcm = state.pcm
          switch (name) {
            case 'getStaticConfig':
              return [pcm.tar, CPS, FPS, SPS]
            case 'defaultAdmin':
              return [pcm.defaultAdmin]
            case 'pendingDefaultAdmin':
              return pcm.pendingDefaultAdmin
            case 'defaultAdminDelay':
              return [pcm.delay]
            case 'pendingDefaultAdminDelay':
              return pcm.pendingDelay
            case 'defaultAdminDelayIncreaseWait':
              return [pcm.increaseWait]
            case 'hasRole': {
              const [role, account] = args as [string, string]
              const name = Object.keys(pcm.roles).find((r) => roleId(r) === role)
              return [!!name && pcm.roles[name]!.includes(getAddress(account))]
            }
            // the pause reads: no connection, every flag clear but the global one
            case 'getLaneConnectionBatch': {
              const [lanes] = args as [unknown[]]
              const g = !!state.globallyPaused
              return [
                lanes.map(() => [false, g, g, g, false, false, false, false, false, '0x', []]),
              ]
            }
            case 'getAllConfiguredTokens': {
              const [start, max] = args as [bigint, bigint]
              return [pcm.tokens.slice(Number(start), Number(start + max))]
            }
            default:
              throw callException()
          }
        })
      const store = state.stores[addr]
      if (store)
        return answer(STORE_IFACE, data, (name, args) => {
          if (state.views[name]) return state.views[name](args, addr)
          switch (name) {
            case 'owner':
              return [store.owner]
            case 'getAllAuthorizedCallers':
              return [store.callers]
            default:
              throw callException()
          }
        })
      // the TokenAdminRegistry: `tarPools`, administered by OWNER
      if (addr === TAR)
        return answer(TAR_IFACE, data, (name, args) => {
          if (name !== 'getTokenConfig') throw callException()
          const pool = state.tarPools[getAddress(String(args[0]))]
          return [[pool ? OWNER : ZeroAddress, ZeroAddress, pool ?? ZeroAddress]]
        })
      // auxiliary contracts (hooks, providers): every answer comes from `state.views`
      if (state.others[addr])
        return answer(
          AUX_IFACE.getFunction(data.slice(0, 10)) ? AUX_IFACE : ERC20_IFACE,
          data,
          (name, args) => {
            const view = state.views[name]
            if (!view) throw callException()
            return view(args, addr)
          },
        )
      throw callException()
    },
    getStorage: async (address: string, slot: bigint) => {
      const addr = getAddress(address)
      calls.push(`getStorage:${addr}:${slot}`)
      const holder = addr === POOL ? state.pool : (state.stores[addr] ?? state.auxOwners[addr])
      if (!holder) return word(ZeroAddress)
      return word(slot === 1n ? holder.owner : holder.pendingOwner)
    },
    getCode: async (address: string, block: number) => {
      calls.push(`getCode:${getAddress(address)}:${block}`)
      const pruned = Array.isArray(state.pruned)
        ? state.pruned.includes(getAddress(address))
        : !!state.pruned
      if (pruned && block < state.latestBlock) throw makeError('missing trie node', 'SERVER_ERROR')
      return block >= state.deploymentBlock ? '0x60806040' : '0x'
    },
    getBlockNumber: async () => {
      calls.push('getBlockNumber')
      return state.latestBlock
    },
    getBlock: async (tag: number) => {
      calls.push(`getBlock:${tag}`)
      return { number: tag, timestamp: state.timestamp ?? 0 }
    },
    // no eth_simulateV1: the projection is not cross-checked
    send: async (method: string) => {
      throw makeError(`the method ${method} does not exist`, 'UNSUPPORTED_OPERATION')
    },
  }
  const chain = {
    provider,
    // Ethereum Sepolia: `generate` pins every transaction to it
    network: { chainId: 11155111 },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    typeAndVersion: async (address: string) => {
      const addr = getAddress(address)
      calls.push(`typeAndVersion:${addr}`)
      const tv = typeAndVersionOf(addr)
      if (!tv) throw callException()
      return parseTypeAndVersion(tv)
    },
    getTokenAdminRegistryFor: async () => {
      calls.push('getTokenAdminRegistryFor')
      return TAR
    },
    getRegistryTokenConfig: async (_registry: string, token: string) => {
      calls.push(`getRegistryTokenConfig:${token}`)
      return { administrator: OWNER, tokenPool: state.tarPools[token] }
    },
    getLogs: async function* ({
      address,
      startBlock,
      endBlock,
    }: {
      address: string
      startBlock: number
      endBlock: number
    }) {
      calls.push(`getLogs:${startBlock}-${endBlock}`)
      for (const l of state.logs)
        if (
          getAddress(l.address) === getAddress(address) &&
          l.blockNumber >= startBlock &&
          l.blockNumber <= endBlock
        )
          yield l
      if (getAddress(address) !== PCM) return
      for (const l of state.roleLogs) {
        if (l.blockNumber < startBlock || l.blockNumber > endBlock) continue
        yield {
          address: PCM,
          blockNumber: l.blockNumber,
          topics: [
            PCM_IFACE.getEvent(l.event)!.topicHash,
            roleId(l.role),
            zeroPadValue(l.account, 32),
            zeroPadValue(OWNER, 32),
          ],
          data: '0x',
        }
      }
    },
  } as unknown as EVMChain
  return { chain, calls, callBlocks, state }
}
