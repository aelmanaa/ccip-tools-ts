import type { PublicKey } from '@solana/web3.js'

import type { SolanaChain } from '../../../../solana/index.ts'
import { SolanaQuery } from '../../query.ts'
import { getPoolGroupProgramFeatures } from '../program.ts'
import type { GetPoolGroupFeaturesParams, PoolGroupFeature } from '../types.ts'
import { parsePoolGroupProgram } from './common.ts'

/** Probes which pool-group features a pool program has. */
export class GetPoolGroupFeatures extends SolanaQuery<
  GetPoolGroupFeaturesParams,
  PoolGroupFeature[],
  { program: PublicKey }
> {
  readonly name = 'getPoolGroupFeatures'

  /** @throws {@link CCTParamsInvalidError} if `poolProgramAddress` is invalid */
  protected prepare(params: GetPoolGroupFeaturesParams) {
    return { program: parsePoolGroupProgram(this.name, params) }
  }

  /** Simulates each feature's probe instruction (cached per program and deploy slot). */
  protected read(chain: SolanaChain, { program }: { program: PublicKey }) {
    return getPoolGroupProgramFeatures(chain, program)
  }
}
