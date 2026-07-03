import {
  type BytesLike,
  type JsonRpcApiProvider,
  Contract,
  FunctionFragment,
  concat,
  getAddress,
  getNumber,
  hexlify,
  randomBytes,
  solidityPackedKeccak256,
  toBeHex,
  zeroPadValue,
} from 'ethers'
import type { TypedContract } from 'ethers-abitype'
import { memoize } from 'micro-memoize'

import TokenABI from './abi/BurnMintERC677Token.ts'
import RouterABI from './abi/Router.ts'
import { defaultAbiCoder, interfaces } from './const.ts'
import { CCIPBalancesSlotNotFoundError } from '../errors/index.ts'
import { getAddressBytes, getDataBytes } from '../utils.ts'

const ccipReceive = FunctionFragment.from({
  type: 'function',
  name: 'ccipReceive',
  stateMutability: 'nonpayable',
  inputs: RouterABI.find((v) => v.type === 'function' && v.name === 'routeMessage')!.inputs.slice(
    0,
    1,
  ),
  outputs: [],
})
type Any2EVMMessage = Parameters<TypedContract<typeof RouterABI>['routeMessage']>[0]

/**
 * Result of locating a token's ERC20 `_balances[holder]` storage location.
 *
 * `key` is the concrete 32-byte storage key that can be used directly in an `eth_call` /
 * `eth_estimateGas` `stateDiff` override to set `holder`'s balance. `slot`, when non-null, is
 * the mapping's declaration slot (a low integer for common tokens); it is null when only the
 * concrete key is known (e.g. resolved from an access list on a namespaced-storage token).
 * `method` records how it was resolved, for diagnostics/telemetry.
 */
type BalancesSlotResult = {
  key: string
  slot: bigint | null
  method: 'fast-path' | 'access-list'
}

// A nonzero sentinel used for the causal override test: override the candidate balance slot with
// this value and confirm `balanceOf(holder)` returns exactly it. Value-independent (works for
// zero-balance holders) and disambiguates proxy slots (e.g. the EIP-1967 implementation slot).
const BALANCE_SENTINEL = 0xdeadbeefn

/**
 * Causal test: override `key` on `token` with a sentinel and check whether `balanceOf(holder)`
 * returns that sentinel. This proves `key` really backs the holder's balance, regardless of the
 * current balance (including zero) and regardless of storage layout (mapping-at-int-slot or
 * ERC-7201 namespaced). Uses `eth_call` (read-only) with a state override.
 */
async function overrideMovesBalance(
  provider: JsonRpcApiProvider,
  token: string,
  holder: string,
  key: string,
): Promise<boolean> {
  try {
    const result = (await provider.send('eth_call', [
      { to: token, data: interfaces.Token.encodeFunctionData('balanceOf', [holder]) },
      'latest',
      { [token]: { stateDiff: { [key]: toBeHex(BALANCE_SENTINEL, 32) } } },
    ])) as string
    return BigInt(result) === BALANCE_SENTINEL
  } catch {
    return false
  }
}

/**
 * Enumerate the storage keys `balanceOf(holder)` reads on `token` via `eth_createAccessList`.
 * For an ERC-1967 proxy this returns the implementation slot plus the (namespaced) balance slot;
 * disambiguation happens via {@link overrideMovesBalance}. Returns [] if the provider does not
 * support `eth_createAccessList` (older/limited RPCs), so the caller can degrade gracefully.
 */
async function enumerateBalanceStorageKeys(
  provider: JsonRpcApiProvider,
  token: string,
  holder: string,
): Promise<string[]> {
  try {
    // No `from`/`gas`/`gasPrice`: keeps the call cheap and avoids sender-funds validation on most
    // nodes (geth/Alchemy/Infura). Strict nodes that reject this simply yield no keys -> fallback.
    const result = (await provider.send('eth_createAccessList', [
      { to: token, data: interfaces.Token.encodeFunctionData('balanceOf', [holder]) },
      'latest',
    ])) as { accessList?: { address: string; storageKeys?: string[] }[] }
    const tokenLc = token.toLowerCase()
    for (const entry of result.accessList ?? []) {
      if (entry.address.toLowerCase() === tokenLc) return entry.storageKeys ?? []
    }
    return []
  } catch {
    return []
  }
}

/**
 * Locate a token's ERC20 `_balances[holder]` storage slot so callers can state-override the
 * holder's post-mint balance before estimating `ccipReceive`.
 *
 * Strategy (memoized per token+holder):
 *  1. Fast path — the common integer mapping slots (0 for most ERC20s, 9 for USDC's
 *     FiatTokenProxy, then 1..15), confirmed with a sentinel override causal test.
 *  2. Access-list path — for EIP-1967 proxies with ERC-7201 namespaced storage (e.g. LBTC) whose
 *     balances are NOT at a low integer slot: enumerate the storage keys `balanceOf` touches via
 *     `eth_createAccessList`, then pick the one whose sentinel override moves `balanceOf`. Mirrors
 *     foundry's `anvil_dealERC20` algorithm.
 *  3. If neither resolves (provider lacks `eth_createAccessList`, or no candidate is causal),
 *     throw a typed {@link CCIPBalancesSlotNotFoundError} instead of a raw CALL_EXCEPTION.
 */
export const findBalancesSlot = memoize(
  async function findBalancesSlot_(
    token: string,
    provider: JsonRpcApiProvider,
    holder: string = getAddress(hexlify(randomBytes(20))),
    recipient: string = getAddress(hexlify(randomBytes(20))),
  ): Promise<BalancesSlotResult> {
    // 1) Fast path (unchanged behaviour): probe the common integer mapping slots (0 for most
    // ERC20s, 9 for USDC's FiatTokenProxy, then 1..15) by simulating a fake transfer with the
    // holder's balance overridden at the candidate slot — a wrong slot leaves balance 0 and the
    // transfer reverts. Cheap and covers the vast majority of tokens.
    const contract = new Contract(token, interfaces.Token, provider) as unknown as TypedContract<
      typeof TokenABI
    >
    const fakeAmount = (await contract.totalSupply()) + 1n
    const calldata = interfaces.Token.encodeFunctionData('transfer', [recipient, fakeAmount])
    for (const slot of [0, 9, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15]) {
      const key = solidityPackedKeccak256(['uint256', 'uint256'], [holder, slot])
      try {
        await provider.send('eth_estimateGas', [
          { from: holder, to: token, data: calldata },
          'latest',
          { [token]: { stateDiff: { [key]: toBeHex(fakeAmount, 32) } } },
        ])
        return { key, slot: BigInt(slot), method: 'fast-path' } // if didn't reject
      } catch {
        // wrong slot: try next
      }
    }

    // 2) Access-list path: EIP-1967 proxies with ERC-7201 namespaced storage (e.g. LBTC) keep
    // `_balances` at a keccak-derived namespaced slot, NOT a low integer — the fast path above
    // never matches and previously this threw a raw CALL_EXCEPTION. Discover the exact storage key
    // dynamically via `eth_createAccessList`, then confirm it with a sentinel override causal test
    // (works even for zero-balance holders). Mirrors foundry's `anvil_dealERC20`.
    for (const key of await enumerateBalanceStorageKeys(provider, token, holder)) {
      if (await overrideMovesBalance(provider, token, holder, key)) {
        return { key, slot: null, method: 'access-list' }
      }
    }

    // 3) Neither resolved (provider lacks `eth_createAccessList`, or no candidate was causal):
    // surface a typed, descriptive error instead of a raw CALL_EXCEPTION.
    throw new CCIPBalancesSlotNotFoundError(token)
  },
  // Memoize per (token, holder): the resolved key is holder-specific, unlike the old int-slot cache.
  { maxArgs: 4, transformKey: (args) => [args[0], args[2]] },
)

type EstimateExecGasOpts = {
  provider: JsonRpcApiProvider
  router: string
  message: {
    sourceChainSelector: bigint
    messageId: string
    receiver: string
    sender?: string
    data?: BytesLike
    destTokenAmounts?: readonly { token: string; amount: bigint }[]
  }
}

/**
 * Estimate gasLimit needed to execute a request on a receiver contract.
 * @param opts - Options for estimation: provider, destRouter, receiver address and message
 * @returns Estimated gasLimit
 */
export async function estimateExecGas({ provider, router, message }: EstimateExecGasOpts) {
  // we need to override the state, increasing receiver's balance for each token, to simulate the
  // state after tokens were transferred by the offRamp just before calling `ccipReceive`
  const destAmounts: Record<string, bigint> = {}
  const stateOverrides: Record<string, { stateDiff: Record<string, string> }> = {}
  for (const { token, amount } of message.destTokenAmounts ?? []) {
    if (!(token in destAmounts)) {
      const tokenContract = new Contract(token, TokenABI, provider) as unknown as TypedContract<
        typeof TokenABI
      >
      const currentBalance = await tokenContract.balanceOf(message.receiver)
      destAmounts[token] = currentBalance
    }
    destAmounts[token]! += amount
    // Resolve the exact storage key for `_balances[receiver]` (holder == receiver here), covering
    // both low-integer-slot ERC20s and ERC-7201 namespaced-storage proxy tokens, then override it.
    const { key } = await findBalancesSlot(token, provider, message.receiver, router)
    stateOverrides[token] = {
      stateDiff: {
        [key]: toBeHex(destAmounts[token]!, 32),
      },
    }
  }

  const senderBytes = getAddressBytes(message.sender ?? '0x')
  const receiverMsg: Any2EVMMessage = {
    ...message,
    destTokenAmounts: message.destTokenAmounts ?? [],
    sender: senderBytes.length < 32 ? zeroPadValue(senderBytes, 32) : hexlify(senderBytes),
    data: hexlify(getDataBytes(message.data || '0x')),
    sourceChainSelector: message.sourceChainSelector,
  }
  const calldata = concat([
    ccipReceive.selector,
    defaultAbiCoder.encode(ccipReceive.inputs, [receiverMsg]),
  ])

  return (
    getNumber(
      (await provider.send('eth_estimateGas', [
        {
          from: router,
          to: message.receiver,
          data: calldata,
        },
        'latest',
        ...(Object.keys(stateOverrides).length ? [stateOverrides] : []),
      ])) as string,
    ) -
    (21_000 - 700) // 21k is the base gas cost for a transaction, 700 is the gas cost of the call
  )
}
