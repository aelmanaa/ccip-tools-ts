import { BN } from '@coral-xyz/anchor'
import type { PublicKey } from '@solana/web3.js'
import { toBeArray } from 'ethers'

import { encodeFinality } from '../../../../extra-args.ts'
import type { SolanaChain } from '../../../../solana/index.ts'
import { deriveTokenPoolChainConfigV2Pda } from '../../../../solana/token-pool.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import {
  deriveTokenPoolChainConfigPda,
  deriveTokenPoolConfigPda,
} from '../../programs/token-pool.ts'
import { SolanaQuery } from '../../query.ts'
import {
  U64_MAX,
  parsePublicKey,
  resolveExistingPoolProgram,
  validateBigInt,
} from '../../validate.ts'
import { decodeCCVs } from '../decode.ts'
import { laneCcvSync, readPoolGroupLaneState } from '../lane.ts'
import { createPoolGroupProgram } from '../program.ts'
import type { GetPoolGroupRequiredCCVsParams, GetPoolGroupRequiredCCVsResult } from '../types.ts'
import { orThrow, simulationRefused, validateSelector } from './common.ts'

type Parsed = {
  program?: PublicKey
  mint: PublicKey
  selector: bigint
  amount: bigint
  direction: 'outbound' | 'inbound'
  finality?: GetPoolGroupRequiredCCVsParams['finality']
}

const U256_MAX = (1n << 256n) - 1n

/** Simulates `get_required_ccvs` for a lane, and says where the answer came from. */
export class GetPoolGroupRequiredCCVs extends SolanaQuery<
  GetPoolGroupRequiredCCVsParams,
  GetPoolGroupRequiredCCVsResult,
  Parsed
> {
  readonly name = 'getPoolGroupRequiredCCVs'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected prepare(params: GetPoolGroupRequiredCCVsParams): Parsed {
    // outbound amounts are local `u64` token amounts; inbound ones are the remote chain's `u256`
    validateBigInt(
      this.name,
      'amount',
      params.amount,
      0n,
      params.direction === 'outbound' ? U64_MAX : U256_MAX,
    )
    if (!(['outbound', 'inbound'] as unknown[]).includes(params.direction))
      throw new CCTParamsInvalidError(this.name, 'direction', "must be 'outbound' or 'inbound'")
    if (params.finality !== undefined) {
      try {
        encodeFinality(params.finality)
      } catch {
        throw new CCTParamsInvalidError(
          this.name,
          'finality',
          "must be 'finalized', 'safe' or a block depth",
        )
      }
    }
    return {
      ...(params.poolProgramAddress !== undefined && {
        program: parsePublicKey(this.name, 'poolProgramAddress', params.poolProgramAddress),
      }),
      mint: parsePublicKey(this.name, 'tokenAddress', params.tokenAddress),
      selector: validateSelector(this.name, 'remoteChainSelector', params.remoteChainSelector),
      amount: params.amount,
      direction: params.direction,
      ...(params.finality !== undefined && { finality: params.finality }),
    }
  }

  /**
   * Simulates the view with the lane's `State`, `ChainConfig` and `ChainConfigV2`. With SECURITY
   * from the pool group the answer is the lane's synced copy, and the CCV sync state is reported.
   */
  protected async read(chain: SolanaChain, p: Parsed): Promise<GetPoolGroupRequiredCCVsResult> {
    const program = await resolveExistingPoolProgram(this.name, chain, p.mint, p.program)
    const read = await readPoolGroupLaneState(chain.connection, program, p.mint, p.selector)
    if (read === null)
      throw new CCTParamsInvalidError(
        this.name,
        'remoteChainSelector',
        `${p.mint.toBase58()} has no lane toward ${p.selector}`,
      )
    const state = orThrow(read, `the lane of ${p.mint.toBase58()} toward ${p.selector}`)
    const ext = state.ext?.poolGroupAddress ? state.ext : null
    const fromGroup = !!ext && ext.classSource.security.kind !== 'inline'
    const finality = encodeFinality(p.finality ?? 'finalized')
    const amount = toBeArray(p.amount, 32)
    const { requiredCcvs } = await createPoolGroupProgram(chain, program)
      .methods.getRequiredCcvs({
        remoteChainSelector: new BN(p.selector.toString()),
        amount: { beBytes: Array.from(amount) },
        localToken: p.mint,
        direction: p.direction === 'outbound' ? { outbound: {} } : { inbound: {} },
        requestedFinalityConfig: { flags: finality >>> 16, blockDepth: finality & 0xffff },
      })
      .accountsStrict({
        state: deriveTokenPoolConfigPda(program, p.mint),
        chainConfig: deriveTokenPoolChainConfigPda(program, p.selector, p.mint),
        chainConfigV2: deriveTokenPoolChainConfigV2Pda(program, p.selector, p.mint),
      })
      .view()
      .catch((err: unknown) => simulationRefused(this.name, err, 'get_required_ccvs'))
    const sync = fromGroup ? orThrow(laneCcvSync(state), p.mint.toBase58()) : null
    const feeInline = !ext || ext.classSource.fee.kind === 'inline'
    return {
      ccvs: decodeCCVs(requiredCcvs),
      source: fromGroup ? 'pool-group-copy' : 'inline',
      ...(sync && {
        epoch: sync.epoch,
        synced: sync.synced,
        ...(sync.failsClosedAt !== undefined && { failsClosedAt: sync.failsClosedAt }),
      }),
      finalityApplied:
        !fromGroup && p.direction === 'outbound' && feeInline && p.finality !== undefined,
    }
  }
}
