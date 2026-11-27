import type { PublicKey } from '@solana/web3.js'

import type { SolanaChain } from '../../../../solana/index.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { deriveTokenPoolGlobalConfigPda } from '../../programs/token-pool.ts'
import { SolanaQuery } from '../../query.ts'
import type { GetTokenPoolGlobalConfigParams, GetTokenPoolGlobalConfigResult } from '../types.ts'
import { decodeOwned, parsePoolGroupProgram } from './common.ts'

/** Reads a pool program's program-wide `PoolConfig`. */
export class GetTokenPoolGlobalConfig extends SolanaQuery<
  GetTokenPoolGlobalConfigParams,
  GetTokenPoolGlobalConfigResult,
  { program: PublicKey }
> {
  readonly name = 'getTokenPoolGlobalConfig'

  /** @throws {@link CCTParamsInvalidError} if `poolProgramAddress` is invalid */
  protected prepare(params: GetTokenPoolGlobalConfigParams) {
    return { program: parsePoolGroupProgram(this.name, params) }
  }

  /** Decodes the `PoolConfig` PDA (`[b"config"]`). */
  protected async read(chain: SolanaChain, { program }: { program: PublicKey }) {
    const address = deriveTokenPoolGlobalConfigPda(program)
    const account = await chain.connection.getAccountInfo(address)
    if (!account)
      throw new CCTParamsInvalidError(
        this.name,
        'poolProgramAddress',
        `the pool program has no PoolConfig at ${address.toBase58()} (global config not initialized)`,
      )
    const config = decodeOwned('poolConfig', account, address, program)
    return {
      version: config.version,
      selfServedAllowed: config.selfServedAllowed,
      defaultRouter: config.router.toBase58(),
      defaultRmnRemote: config.rmnRemote.toBase58(),
    }
  }
}
