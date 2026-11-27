/**
 * The three shared planners of `SolanaTokenManager` (A16, design addendum rev 3): each in its plan,
 * unsigned and signed form, built from the S3-S5 pool-group ops.
 *
 * @packageDocumentation
 */

import { PublicKey } from '@solana/web3.js'

import { CCIPWalletInvalidError } from '../../../../errors/index.ts'
import type { SolanaChain } from '../../../../solana/index.ts'
import { isWallet } from '../../../../solana/types.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { parsePublicKey } from '../../validate.ts'
import type { ParsedPoolGroupRef } from '../operations/common.ts'
import { parseLiveCheck } from '../write-operation.ts'
import type { SolanaTxBudget } from '../write-types.ts'
import {
  type Expansion,
  type PlannerContext,
  parseLandedStepIds,
  parsePlannerSigner,
} from './context.ts'
import { expandEnablement, parseEnablement } from './enable-chain.ts'
import { expandOnboarding, parseOnboarding } from './onboard.ts'
import { expandRemoval, parseRemoval } from './remove-token.ts'
import { type RunOptions, executeFlow, generateFlow, planFlow } from './run.ts'
import type {
  ExecuteEnableMultiTokenPoolChainParams,
  ExecuteOnboardMultiTokenPoolTokensParams,
  ExecutePoolGroupPlanResult,
  ExecuteRemoveMultiTokenPoolTokenParams,
  GenerateEnableMultiTokenPoolChainParams,
  GenerateOnboardMultiTokenPoolTokensParams,
  GeneratePoolGroupPlanResult,
  GenerateRemoveMultiTokenPoolTokenParams,
  PoolGroupChainEnablementStepName,
  PoolGroupLeaveStepName,
  PoolGroupOnboardingStepName,
  PoolGroupPlan,
} from './types.ts'

/** The plan options and Solana block every planner takes. */
type CommonParams = Pick<
  GenerateOnboardMultiTokenPoolTokensParams,
  | 'actors'
  | 'onStep'
  | 'signal'
  | 'concurrency'
  | 'pendingStepHashes'
  | 'maxReadySteps'
  | 'landedStepIds'
  | 'getChain'
  | 'authority'
> & {
  solana?: { budget?: SolanaTxBudget; crankPayer?: string; lookupTablePayer?: string }
}

/** Builds the run context of one planner call. */
function contextOf(
  operation: string,
  chain: SolanaChain,
  ref: ParsedPoolGroupRef,
  params: CommonParams,
  payer: PublicKey,
): { ctx: PlannerContext; options: RunOptions } {
  const signer = parsePlannerSigner(operation, params, payer)
  const live = parseLiveCheck(operation, params)
  if (
    params.maxReadySteps !== undefined &&
    (!Number.isInteger(params.maxReadySteps) || params.maxReadySteps < 1)
  )
    throw new CCTParamsInvalidError(operation, 'maxReadySteps', 'must be a positive integer')
  const budget = params.solana?.budget
  return {
    ctx: {
      operation,
      chain,
      ref,
      ...signer,
      ...(budget && { budget }),
      ...(params.actors && { actors: params.actors }),
      ...(live?.getChain && { getChain: live.getChain }),
      ...(live?.concurrency !== undefined && { concurrency: live.concurrency }),
      landed: parseLandedStepIds(operation, params.landedStepIds),
      squads: budget?.executor === 'squads-v4',
    },
    options: {
      ...(params.pendingStepHashes && { pendingStepHashes: params.pendingStepHashes }),
      ...(params.maxReadySteps !== undefined && { maxReadySteps: params.maxReadySteps }),
      ...(params.onStep && { onStep: params.onStep }),
      ...(params.signal && { signal: params.signal }),
    },
  }
}

/** The wallet of a signed planner call (the Squads executor is refused: a vault executes proposals). */
function walletOf(operation: string, params: { wallet: unknown; solana?: { budget?: SolanaTxBudget } }) {
  if (!isWallet(params.wallet)) throw new CCIPWalletInvalidError(params.wallet)
  if (params.solana?.budget?.executor === 'squads-v4')
    throw new CCTParamsInvalidError(
      operation,
      'solana.budget.executor',
      "a Squads vault executes proposals: use the generateUnsigned form with executor 'squads-v4' and toPoolGroupSquadsBatch",
    )
  return params.wallet
}

/** The payer of an unsigned planner call. */
const payerOf = (operation: string, payer: unknown) => parsePublicKey(operation, 'payer', payer)

/** A flow: how to parse its params into a context and an expansion. */
type Flow<Name extends string, P> = {
  name: string
  prepare(chain: SolanaChain, params: P, payer: PublicKey): {
    ctx: PlannerContext
    options: RunOptions
    expand: () => Promise<Expansion<Name>>
  }
}

const onboarding: Flow<PoolGroupOnboardingStepName, GenerateOnboardMultiTokenPoolTokensParams> = {
  name: 'onboardMultiTokenPoolTokens',
  prepare(chain, params, payer) {
    const { ref, parsed } = parseOnboarding(params)
    const { ctx, options } = contextOf(this.name, chain, ref, params, payer)
    return { ctx, options, expand: () => expandOnboarding(ctx, parsed) }
  },
}

const enablement: Flow<PoolGroupChainEnablementStepName, GenerateEnableMultiTokenPoolChainParams> = {
  name: 'enableMultiTokenPoolChain',
  prepare(chain, params, payer) {
    const { ref, parsed } = parseEnablement(params)
    const { ctx, options } = contextOf(this.name, chain, ref, params, payer)
    return { ctx, options, expand: () => expandEnablement(ctx, parsed) }
  },
}

const removal: Flow<PoolGroupLeaveStepName, GenerateRemoveMultiTokenPoolTokenParams> = {
  name: 'removeMultiTokenPoolToken',
  prepare(chain, params, payer) {
    const { ref, parsed } = parseRemoval(params)
    const { ctx, options } = contextOf(this.name, chain, ref, params, payer)
    return { ctx, options, expand: () => expandRemoval(ctx, parsed) }
  },
}

/** The three forms of one flow. */
function forms<Name extends string, P extends { payer: string }, E extends { wallet: unknown; computeUnits?: number; solana?: { budget?: SolanaTxBudget } }>(
  flow: Flow<Name, P>,
  toGenerate: (e: E, payer: string) => P,
) {
  return {
    plan(chain: SolanaChain, params: P): Promise<PoolGroupPlan<Name>> {
      const { ctx, options, expand } = flow.prepare(chain, params, payerOf(flow.name, params.payer))
      return planFlow(ctx, expand, options)
    },
    generate(chain: SolanaChain, params: P): Promise<GeneratePoolGroupPlanResult<Name>> {
      const { ctx, options, expand } = flow.prepare(chain, params, payerOf(flow.name, params.payer))
      return generateFlow(ctx, expand, options)
    },
    execute(chain: SolanaChain, params: E): Promise<ExecutePoolGroupPlanResult<Name>> {
      const wallet = walletOf(flow.name, params)
      const payer = wallet.publicKey.toBase58()
      const { ctx, options, expand } = flow.prepare(chain, toGenerate(params, payer), new PublicKey(payer))
      return executeFlow(ctx, expand, options, wallet, params.computeUnits)
    },
  }
}

/** The shared planners, by flow; the facade on `SolanaTokenManager` delegates here. @internal */
export const SOLANA_MULTI_TOKEN_POOL_PLANNERS = {
  onboarding: forms<PoolGroupOnboardingStepName, GenerateOnboardMultiTokenPoolTokensParams, ExecuteOnboardMultiTokenPoolTokensParams>(
    onboarding,
    ({ wallet: _w, computeUnits: _c, ...rest }, payer) => ({ ...rest, payer }),
  ),
  chainEnablement: forms<PoolGroupChainEnablementStepName, GenerateEnableMultiTokenPoolChainParams, ExecuteEnableMultiTokenPoolChainParams>(
    enablement,
    ({ wallet: _w, computeUnits: _c, ...rest }, payer) => ({ ...rest, payer }),
  ),
  tokenRemoval: forms<PoolGroupLeaveStepName, GenerateRemoveMultiTokenPoolTokenParams, ExecuteRemoveMultiTokenPoolTokenParams>(
    removal,
    ({ wallet: _w, computeUnits: _c, ...rest }, payer) => ({ ...rest, payer }),
  ),
} as const
