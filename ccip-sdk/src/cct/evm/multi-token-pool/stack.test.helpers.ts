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
  'event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)',
  'event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)',
])
export const STORE_IFACE = new Interface([
  'function typeAndVersion() view returns (string)',
  'function owner() view returns (address)',
  'function getAllAuthorizedCallers() view returns (address[])',
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
  }
}

/** A word of storage holding an address. */
const word = (address: string) => zeroPadValue(address, 32)

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
  const answer = (
    iface: Interface,
    data: string,
    f: (name: string, args: readonly unknown[]) => unknown[],
  ) => {
    const tx = iface.parseTransaction({ data })
    if (!tx) throw callException()
    return iface.encodeFunctionResult(tx.fragment, f(tx.name, tx.args))
  }
  const typeAndVersionOf = (to: string): string | undefined =>
    to === POOL
      ? state.pool.typeAndVersion
      : to === PCM
        ? state.pcm.typeAndVersion
        : (state.stores[to]?.typeAndVersion ?? state.others[to])
  const provider = {
    call: async ({ to, data }: { to: string; data: string }) => {
      const addr = getAddress(to)
      calls.push(`call:${addr}:${data.slice(0, 10)}`)
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
        return answer(STORE_IFACE, data, (name) => {
          switch (name) {
            case 'owner':
              return [store.owner]
            case 'getAllAuthorizedCallers':
              return [store.callers]
            default:
              throw callException()
          }
        })
      throw callException()
    },
    getStorage: async (address: string, slot: bigint) => {
      const addr = getAddress(address)
      calls.push(`getStorage:${addr}:${slot}`)
      const holder = addr === POOL ? state.pool : state.stores[addr]
      if (!holder) return word(ZeroAddress)
      return word(slot === 1n ? holder.owner : holder.pendingOwner)
    },
    getCode: async (address: string, block: number) => {
      calls.push(`getCode:${getAddress(address)}:${block}`)
      return block >= state.deploymentBlock ? '0x60806040' : '0x'
    },
    getBlockNumber: async () => {
      calls.push('getBlockNumber')
      return state.latestBlock
    },
  }
  const chain = {
    provider,
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
    getLogs: async function* ({ startBlock, endBlock }: { startBlock: number; endBlock: number }) {
      calls.push(`getLogs:${startBlock}-${endBlock}`)
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
  return { chain, calls, state }
}
