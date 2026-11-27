/**
 * The base of the multi-token pool deploys: main's `EVMDeployOperation` (same artifact, encoding and
 * `{ hash, contractAddress, verification }` result), plus the read-after-write floor every MTTP
 * write sets, so the next MTTP read or build never pins to a block before the contract existed.
 *
 * @packageDocumentation
 */

import type { EVMChain } from '../../../evm/index.ts'
import { noteMinedBlock } from '../mined-block.ts'
import { type DeployResult, type EVMExecuteParams, EVMDeployOperation } from '../operation.ts'

/** Base of the multi-token pool deploys. @internal */
export abstract class MultiTokenPoolDeployOperation<
  P extends { sender?: string },
> extends EVMDeployOperation<P> {
  /**
   * Deploys as main's base does, then records the block it mined in (best effort: the deployment
   * already landed, so a failed receipt read never loses its hash or address).
   */
  override async execute(chain: EVMChain, params: EVMExecuteParams<P>): Promise<DeployResult> {
    const result = await super.execute(chain, params)
    const receipt = await Promise.resolve()
      .then(() => chain.provider.getTransactionReceipt(result.hash))
      .catch(() => null)
    if (receipt) noteMinedBlock(chain, receipt.blockNumber)
    return result
  }
}
