import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  type TokenInfo,
  CCIPArgumentInvalidError,
  CCIPTokenNotFoundError,
} from '@chainlink/ccip-sdk/src/index.ts'

import { resolveFeeTokenSymbol } from './send.ts'

const WSOL = 'So11111111111111111111111111111111111111112'
const ROUTER_LINK = 'LinkhB3afbBKb2EQQu7s7umdZceV3wcvAUJhQAfQ23L'
const OTHER_LINK = 'GAn1RmBY76BjdqPAFnqM4jhqSSeeo9Zf7ASqHoWLdwZb'
const quiet = { debug: () => {} }

/** A source chain listing `feeTokens` in this order (Solana returns getProgramAccounts order). */
function source(feeTokens: Record<string, TokenInfo>, native = WSOL) {
  return {
    getFeeTokens: () => Promise.resolve(feeTokens),
    getNativeTokenForRouter: () => Promise.resolve(native),
  }
}

describe('resolveFeeTokenSymbol', () => {
  it('refuses a symbol carried by two fee tokens instead of taking the first listed', async () => {
    const devnet = source({
      [OTHER_LINK]: { symbol: 'LINK', decimals: 9 },
      [WSOL]: { symbol: 'SOL', decimals: 9 },
      [ROUTER_LINK]: { symbol: 'LINK', decimals: 9 },
    })
    await assert.rejects(resolveFeeTokenSymbol(devnet, 'router', 'LINK', quiet), (err) => {
      assert.ok(err instanceof CCIPArgumentInvalidError)
      assert.match(err.message, new RegExp(`${OTHER_LINK}.*${ROUTER_LINK}`))
      assert.deepEqual(err.context['candidates'], [OTHER_LINK, ROUTER_LINK])
      assert.match(err.recovery ?? '', /address/)
      return true
    })
  })

  it('resolves a unique symbol, case-insensitively', async () => {
    const evm = source(
      { '0xLink': { symbol: 'LINK', decimals: 18 }, '0xWeth': { symbol: 'WETH', decimals: 18 } },
      '0xWeth',
    )
    assert.deepEqual(await resolveFeeTokenSymbol(evm, 'router', 'link', quiet), [
      '0xLink',
      { symbol: 'LINK', decimals: 18 },
    ])
  })

  it('accepts the native wrapper with or without the W prefix', async () => {
    const devnet = source({ [WSOL]: { symbol: 'SOL', decimals: 9 } })
    for (const symbol of ['WSOL', 'wSOL', 'SOL'])
      assert.equal((await resolveFeeTokenSymbol(devnet, 'router', symbol, quiet))[0], WSOL)
    const evm = source({ '0xWeth': { symbol: 'WETH', decimals: 18 } }, '0xWeth')
    for (const symbol of ['WETH', 'ETH'])
      assert.equal((await resolveFeeTokenSymbol(evm, 'router', symbol, quiet))[0], '0xWeth')
  })

  it('applies the W alias only to the native wrapper', async () => {
    const chain = source({ '0xWbtc': { symbol: 'WBTC', decimals: 8 } }, '0xWeth')
    await assert.rejects(
      resolveFeeTokenSymbol(chain, 'router', 'BTC', quiet),
      CCIPTokenNotFoundError,
    )
  })

  it('throws CCIPTokenNotFoundError for an unknown symbol, ignoring UNKNOWN entries', async () => {
    const chain = source({ '0xA': { symbol: 'UNKNOWN', decimals: 18 } })
    await assert.rejects(
      resolveFeeTokenSymbol(chain, 'router', 'UNKNOWN', quiet),
      CCIPTokenNotFoundError,
    )
  })

  it('still resolves symbols when the router has no native token', async () => {
    const chain = {
      getFeeTokens: () => Promise.resolve({ '0xLink': { symbol: 'LINK', decimals: 18 } }),
      getNativeTokenForRouter: () => Promise.reject(new Error('no native')),
    }
    assert.equal((await resolveFeeTokenSymbol(chain, 'router', 'LINK', quiet))[0], '0xLink')
  })
})
