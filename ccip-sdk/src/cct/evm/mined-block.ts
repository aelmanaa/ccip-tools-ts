/**
 * The read-after-write floor: a signed write that just mined must be visible to the next read or
 * build on the same provider. ethers answers a repeated `eth_blockNumber` from its 250ms cache, so
 * right after a receipt the provider can still report the block before it, and a build pinned to it
 * would judge, simulate and seal the pre-write state.
 *
 * @packageDocumentation
 */

import type { EVMChain } from '../../evm/index.ts'

/** The last block a write of this SDK mined, per provider (two chains on one provider share it). */
const MINED = new WeakMap<object, number>()

/** Records the block a signed write mined on `chain`, so later reads never pin before it. @internal */
export function noteMinedBlock(chain: Pick<EVMChain, 'provider'>, blockNumber: number): void {
  const key = chain.provider as object
  MINED.set(key, Math.max(MINED.get(key) ?? 0, blockNumber))
}

/**
 * The block a read or build pins to: the provider's head, but never before the last block a write of
 * this SDK mined on it (the receipt proves that block exists on the node).
 * @internal
 */
export async function latestBlock(chain: Pick<EVMChain, 'provider'>): Promise<number> {
  const head = await chain.provider.getBlockNumber()
  return Math.max(head, MINED.get(chain.provider as object) ?? 0)
}
