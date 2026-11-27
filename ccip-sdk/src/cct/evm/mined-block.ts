/**
 * The read-after-write floor: a signed write that just mined must be visible to the next read or
 * build on the same chain. ethers answers a repeated `eth_blockNumber` from its 250ms cache, so
 * right after a receipt the provider can still report the block before it, and a build pinned to it
 * would judge, simulate and seal the pre-write state.
 *
 * The floor is kept per chain (its selector), not per provider object: a second `EVMChain` on the
 * same network, through the same RPC or another one, gets it too.
 *
 * @packageDocumentation
 */

import { CCIPBlockNotFoundError } from '../../errors/index.ts'
import type { EVMChain } from '../../evm/index.ts'

/** The last block a write of this SDK mined, per chain selector. */
const MINED_BY_CHAIN = new Map<bigint, number>()
/** The same, per provider, for a chain that reports no selector (a test stub). */
const MINED_BY_PROVIDER = new WeakMap<object, number>()

/** How long {@link latestBlock} waits for a node behind the floor: attempts × interval. */
const CATCH_UP = { attempts: 12, intervalMs: 250 }

type FloorChain = Pick<EVMChain, 'provider'> & { network?: { chainSelector?: bigint } }

/** The floor's key: the chain selector, else the provider object. */
const selectorOf = (chain: FloorChain): bigint | undefined => chain.network?.chainSelector

/** Records the block a signed write mined on `chain`, so later reads never pin before it. @internal */
export function noteMinedBlock(chain: FloorChain, blockNumber: number): void {
  const selector = selectorOf(chain)
  if (selector !== undefined)
    MINED_BY_CHAIN.set(selector, Math.max(MINED_BY_CHAIN.get(selector) ?? 0, blockNumber))
  else {
    const key = chain.provider as object
    MINED_BY_PROVIDER.set(key, Math.max(MINED_BY_PROVIDER.get(key) ?? 0, blockNumber))
  }
}

/** The floor of `chain`: the last block a write of this SDK mined on it, or 0. */
function floorOf(chain: FloorChain): number {
  const selector = selectorOf(chain)
  return (
    (selector !== undefined
      ? MINED_BY_CHAIN.get(selector)
      : MINED_BY_PROVIDER.get(chain.provider as object)) ?? 0
  )
}

/**
 * The block a read or build pins to: the provider's head, never before the last block a write of this
 * SDK mined on the chain. A head behind the floor (ethers' cache, a lagging load-balanced backend, a
 * reorg) is re-read uncached for a few seconds; a node that still has not reached the floor fails.
 * @throws {@link CCIPBlockNotFoundError} (transient) if the node stays behind the floor: wait, then
 *   rebuild the write (a build from before would judge the pre-write state)
 * @internal
 */
export async function latestBlock(chain: FloorChain): Promise<number> {
  const floor = floorOf(chain)
  let head = await chain.provider.getBlockNumber()
  for (let i = 0; head < floor && i < CATCH_UP.attempts; i++) {
    // uncached: ethers' getBlockNumber answers from its cache for 250ms
    head = Number(await chain.provider.send('eth_blockNumber', []))
    if (head < floor) await new Promise((resolve) => setTimeout(resolve, CATCH_UP.intervalMs))
  }
  if (head < floor)
    throw new CCIPBlockNotFoundError(floor, {
      context: { head, floor },
      recovery: `The RPC's head (${head}) is behind block ${floor}, where a write of this SDK mined: a lagging backend or a reorg. Wait for the node to catch up, then rebuild the write; never send one built before.`,
    })
  return head
}
