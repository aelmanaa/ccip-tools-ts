/**
 * getMultiTokenPoolTransferQuote: what it refuses before any RPC. The quote itself runs live in
 * `lane-check.integration.test.ts`.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { getAddress } from 'ethers'

import { CCTParamsInvalidError } from '../../../errors.ts'
import { POOL, stackChain } from '../stack.test.helpers.ts'
import { GetMultiTokenPoolTransferQuote } from './get-multi-token-pool-transfer-quote.ts'

const quote = {
  poolAddress: POOL,
  tokenAddress: getAddress('0x' + 'a1'.repeat(20)),
  remoteChainSelector: 1n,
  amount: 10n,
}

describe('GetMultiTokenPoolTransferQuote (cct/evm multi-token-pool)', () => {
  it('refuses a malformed amount, finality, fee token or key before any RPC', async () => {
    const { chain, calls } = stackChain()
    for (const [bad, param] of [
      [{ ...quote, amount: -1n }, 'amount'],
      [{ ...quote, finality: 0 }, 'finality'],
      [{ ...quote, feeToken: '0x12' }, 'feeToken'],
      [{ ...quote, poolAddress: undefined }, 'poolAddress'],
    ] as const)
      await assert.rejects(
        new GetMultiTokenPoolTransferQuote().query(chain, bad as never),
        (e: unknown) => e instanceof CCTParamsInvalidError && e.context.param === param,
      )
    assert.deepEqual(calls, [])
  })
})
