import assert from 'node:assert/strict'
import { after, beforeEach, describe, it, mock } from 'node:test'

import { getAddress, hexlify, randomBytes, solidityPackedKeccak256, toBeHex } from 'ethers'

import { findBalancesSlot } from './gas.ts'
import { CCIPBalancesSlotNotFoundError } from '../errors/index.ts'

const SENTINEL = toBeHex(0xdeadbeefn, 32)

// Builds a mock JsonRpcApiProvider for findBalancesSlot.
// - `call` backs ethers Contract.totalSupply() (the fast-path uses totalSupply()+1).
// - `send` handles eth_estimateGas (fast-path transfer probe), eth_createAccessList and eth_call
//   (sentinel override causal test). Options tune each leg.
function makeProvider(opts: {
  // if set, eth_estimateGas resolves ONLY when the override targets keccak(holder, fastSlot)
  fastSlot?: number
  holder?: string
  // storage keys returned by eth_createAccessList for the token (or 'unsupported' to throw)
  accessListKeys?: string[] | 'unsupported'
  // the key whose sentinel override makes balanceOf return the sentinel
  balanceKey?: string
}) {
  const send = mock.fn(async (method: string, params: unknown[]) => {
    if (method === 'eth_estimateGas') {
      if (opts.fastSlot === undefined) throw new Error('estimateGas revert (wrong slot)')
      const stateDiff = params[2] as Record<string, { stateDiff: Record<string, string> }>
      const token = Object.keys(stateDiff)[0]!
      const want = solidityPackedKeccak256(['uint256', 'uint256'], [opts.holder!, opts.fastSlot])
      if (want in stateDiff[token]!.stateDiff) return toBeHex(50_000)
      throw new Error('estimateGas revert (wrong slot)')
    }
    if (method === 'eth_createAccessList') {
      if (opts.accessListKeys === 'unsupported')
        throw new Error('the method eth_createAccessList does not exist')
      const to = (params[0] as { to: string }).to
      return { accessList: [{ address: to, storageKeys: opts.accessListKeys ?? [] }] }
    }
    if (method === 'eth_call') {
      const stateDiff = params[2] as Record<string, { stateDiff: Record<string, string> }>
      const token = Object.keys(stateDiff)[0]
      if (token && opts.balanceKey && opts.balanceKey in stateDiff[token]!.stateDiff)
        return SENTINEL
      return toBeHex(0n, 32)
    }
    throw new Error(`unexpected method ${method}`)
  })
  // ethers Contract.totalSupply() -> provider.call returns 1000
  const call = mock.fn(async () => toBeHex(1000n, 32))
  return { send, call } as unknown as Parameters<typeof findBalancesSlot>[1] & {
    send: typeof send
    call: typeof call
  }
}

describe('findBalancesSlot', () => {
  beforeEach(() => mock.restoreAll())
  after(() => mock.restoreAll())

  it('fast-path: resolves a common integer slot without an access list', async () => {
    const token = getAddress(hexlify(randomBytes(20)))
    const holder = getAddress(hexlify(randomBytes(20)))
    const provider = makeProvider({ fastSlot: 0, holder })

    const result = await findBalancesSlot(token, provider, holder)

    assert.equal(result.method, 'fast-path')
    assert.equal(result.slot, 0n)
    assert.equal(result.key, solidityPackedKeccak256(['uint256', 'uint256'], [holder, 0]))
    // access list must NOT be consulted when the fast path hits
    assert.ok(!provider.send.mock.calls.some((c) => c.arguments[0] === 'eth_createAccessList'))
  })

  it('fast-path: resolves USDC-style slot 9', async () => {
    const token = getAddress(hexlify(randomBytes(20)))
    const holder = getAddress(hexlify(randomBytes(20)))
    const provider = makeProvider({ fastSlot: 9, holder })

    const result = await findBalancesSlot(token, provider, holder)

    assert.equal(result.method, 'fast-path')
    assert.equal(result.slot, 9n)
  })

  it('access-list: resolves an ERC-7201 namespaced token the fast path misses', async () => {
    const token = getAddress(hexlify(randomBytes(20)))
    const holder = getAddress(hexlify(randomBytes(20)))
    const decoyKey = hexlify(randomBytes(32)) // e.g. the EIP-1967 implementation slot
    const balanceKey = hexlify(randomBytes(32)) // the namespaced _balances[holder] key
    const provider = makeProvider({ accessListKeys: [decoyKey, balanceKey], balanceKey })

    const result = await findBalancesSlot(token, provider, holder)

    assert.equal(result.method, 'access-list')
    assert.equal(result.slot, null)
    assert.equal(result.key, balanceKey)
    // it must have enumerated via access list and confirmed via a causal eth_call override
    assert.ok(provider.send.mock.calls.some((c) => c.arguments[0] === 'eth_createAccessList'))
    assert.ok(provider.send.mock.calls.some((c) => c.arguments[0] === 'eth_call'))
  })

  it('throws a typed CCIPBalancesSlotNotFoundError when the provider lacks eth_createAccessList', async () => {
    const token = getAddress(hexlify(randomBytes(20)))
    const holder = getAddress(hexlify(randomBytes(20)))
    const provider = makeProvider({ accessListKeys: 'unsupported' })

    await assert.rejects(
      () => findBalancesSlot(token, provider, holder),
      CCIPBalancesSlotNotFoundError,
    )
  })

  it('throws a typed error when no access-list candidate is causal (none moves balanceOf)', async () => {
    const token = getAddress(hexlify(randomBytes(20)))
    const holder = getAddress(hexlify(randomBytes(20)))
    // access list returns keys but none of them, when overridden, moves balanceOf
    const provider = makeProvider({ accessListKeys: [hexlify(randomBytes(32))] })

    await assert.rejects(
      () => findBalancesSlot(token, provider, holder),
      CCIPBalancesSlotNotFoundError,
    )
  })
})
