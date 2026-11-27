/**
 * Make-live landings on a Surfpool fork of Devnet. Surfpool cannot execute the Devnet CCIP Router
 * (`type_version` simulates as `InvalidProgramForExecution`), so on the fork the lane check reads
 * every pool's Router as "not a CCIP Router" (`TOKEN_NOT_REGISTERED`) and, with the interface
 * unknown, flags long pool data (`POOL_DATA_FORMAT_MISMATCH`). Those two fork artifacts are the only
 * findings removed here: every other local rule and the whole remote side (Sepolia) run as in the
 * op, on the post-state overlay the op's judge builds.
 */

import {
  type Keypair,
  type PublicKey,
  type TransactionInstruction,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js'

import type { ChainGetter } from '../../../chain.ts'
import type { SolanaChain } from '../../../solana/index.ts'
import type { MultiTokenPoolLaneFinding } from '../../multi-token-pool.ts'
import { checkSolanaMultiTokenPoolLane } from './multi-token-pool-check.ts'
import { type PoolGroupJudgement, judgePoolGroupWrite } from './write-guard.ts'

/** A finding caused only by the fork's non-executable Router. */
export const isForkRouterArtifact = (f: MultiTokenPoolLaneFinding) =>
  (f.check === 'TOKEN_NOT_REGISTERED' && /is not a CCIP Router/.test(f.reason)) ||
  (f.check === 'POOL_DATA_FORMAT_MISMATCH' && /reads only on interface 2/.test(f.reason))

/**
 * Judges `instructions` exactly as the op's guard does (simulated post-state, make-live check with
 * `getChain`), with the real lane check minus the fork artifacts, then sends them.
 * @returns The judgement (`goingLive` and every finding) and the landed signature.
 */
export async function judgeAndLand(input: {
  chain: SolanaChain
  program: PublicKey
  group: PublicKey
  signer: Keypair
  instructions: TransactionInstruction[]
  getChain: ChainGetter
}): Promise<{ judgement: PoolGroupJudgement; signature: string }> {
  const judgement = await judgePoolGroupWrite({
    operation: 'forkMakeLive',
    chain: input.chain,
    program: input.program,
    group: input.group,
    payer: input.signer.publicKey,
    instructions: input.instructions,
    liveCheck: { getChain: input.getChain },
    checkLane: async (...args) => {
      const r = await checkSolanaMultiTokenPoolLane(...args)
      return { findings: r.findings.filter((f) => !isForkRouterArtifact(f)) }
    },
  })
  const signature = await sendAndConfirmTransaction(
    input.chain.connection,
    new Transaction().add(...input.instructions),
    [input.signer],
    { commitment: 'confirmed' },
  )
  return { judgement, signature }
}
