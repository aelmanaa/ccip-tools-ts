/**
 * Shared helpers for the PoolConfigManager fork tests (anvil forks of live testnets).
 */

import type { JsonRpcProvider } from 'ethers'

import { CCTTxNotConfirmedError } from '../../../errors.ts'

/**
 * Awaits a signed write and returns its receipt's status (`1` for success; the test asserts it). A fork can mine slower than
 * the confirmation timeout while it fetches upstream state, so a `CCTTxNotConfirmedError` is
 * recovered as its `recovery` says: wait for the receipt by its hash, never resubmit. Then waits out
 * ethers' 250ms request cache, so the next read sees the block the write mined in.
 */
export async function mined(
  provider: JsonRpcProvider,
  write: Promise<{ hash: string }>,
): Promise<number | null | undefined> {
  let hash: string
  try {
    ;({ hash } = await write)
  } catch (err) {
    if (!(err instanceof CCTTxNotConfirmedError)) throw err
    hash = String(err.context.txHash)
  }
  const receipt = await provider.waitForTransaction(hash, 1, 180_000)
  await new Promise((resolve) => setTimeout(resolve, 300))
  return receipt?.status
}
