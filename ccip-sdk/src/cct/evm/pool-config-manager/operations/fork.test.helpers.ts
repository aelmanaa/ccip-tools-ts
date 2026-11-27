/**
 * Shared helpers for the PoolConfigManager fork tests (anvil forks of live testnets).
 */

import { type JsonRpcProvider, getAddress } from 'ethers'

import { CCTTxNotConfirmedError } from '../../../errors.ts'
import { noteMinedBlock } from '../../mined-block.ts'

/**
 * Awaits a signed write and returns its receipt's status (`1` for success; the test asserts it). A
 * fork can mine slower than the confirmation timeout while it fetches upstream state, so a
 * `CCTTxNotConfirmedError` is recovered as its `recovery` says: wait for the receipt by its hash,
 * never resubmit. No sleep afterwards: the SDK itself pins every later MTTP read and build at or
 * after the block the write mined in (`latestBlock`), which the tests rely on.
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
  return receipt?.status
}

/**
 * Awaits a signed deploy and returns the deployed address: a deploy the fork confirms after the
 * timeout is recovered by its hash (never resubmitted), its address read from the receipt, and the
 * block recorded as the read-after-write floor, as the SDK records it on the happy path.
 */
export async function deployed(
  chain: Parameters<typeof noteMinedBlock>[0],
  provider: JsonRpcProvider,
  deploy: Promise<{ contractAddress: string }>,
): Promise<string> {
  try {
    return (await deploy).contractAddress
  } catch (err) {
    if (!(err instanceof CCTTxNotConfirmedError)) throw err
    const receipt = await provider.waitForTransaction(String(err.context.txHash), 1, 180_000)
    if (receipt?.status !== 1 || !receipt.contractAddress) throw err
    noteMinedBlock(chain, receipt.blockNumber)
    return getAddress(receipt.contractAddress)
  }
}
