/**
 * The shared shape of the six per-policy reads: validate the target and the policy name, resolve
 * the PCM, then read the policy's view.
 *
 * @packageDocumentation
 */

import type { EVMChain } from '../../../../evm/index.ts'
import { LANE_RECORD_TYPES } from '../../../../evm/multi-token-pool.ts'
import { poolConfigManagerContract } from '../../multi-token-pool/contracts.ts'
import { EVMQuery } from '../../query.ts'
import {
  type PolicyName,
  type PoolConfigManagerReader,
  type PoolConfigManagerTarget,
  decodePolicyName,
  encodePolicyName,
  resolvePoolConfigManagerTarget,
  validatePoolConfigManagerTarget,
} from '../contracts.ts'

/** Parameters for the per-policy views. */
export type GetMultiTokenPoolPolicyParams = PoolConfigManagerTarget & {
  /** The policy, as text or a raw `bytes32`. */
  policyName: PolicyName
}

/** Policy params after `prepare`. */
export type ParsedPolicyParams<P extends GetMultiTokenPoolPolicyParams> = P & {
  /** The policy name encoded as its `bytes32`. */
  policyWord: string
}

/** The policy a per-policy read answers for. */
export type MultiTokenPoolPolicyIdentity = {
  /** The policy read, spelled as reads return it (text, or raw `bytes32` hex). */
  policyName: PolicyName
  /**
   * Whether the PCM lists the policy for its record type. `false` means no such policy (a mistyped
   * name, say), which a defined policy with no records or tokens never reads.
   */
  exists: boolean
}

/** A per-policy result without its {@link MultiTokenPoolPolicyIdentity}, which the base adds. */
export type PolicyRecords<R> = Omit<R, keyof MultiTokenPoolPolicyIdentity>

/** What {@link PolicyQuery.readPolicy} reads with: the chain, and the block every view is pinned to. */
export type PolicyReadContext = { chain: EVMChain; blockTag: number }

/**
 * Base of the per-policy reads, generic over the records part `B` of the result. Subclasses supply {@link PolicyQuery.readPolicy} and the record type
 * whose policy list decides `exists`; the base reads both at one block.
 * @internal
 */
export abstract class PolicyQuery<
  P extends GetMultiTokenPoolPolicyParams,
  B extends object,
> extends EVMQuery<P, B & MultiTokenPoolPolicyIdentity, ParsedPolicyParams<P>> {
  /** The record type the policy belongs to. */
  protected abstract readonly recordType: (typeof LANE_RECORD_TYPES)[number]

  /** Reads the policy's views at `blockTag`; `policyWord` is the encoded `bytes32`. */
  protected abstract readPolicy(
    pcm: PoolConfigManagerReader,
    params: ParsedPolicyParams<P>,
    context: PolicyReadContext,
  ): Promise<B>

  /** The caller's block, for a read that takes one; the latest block otherwise. */
  protected blockTagOf(_params: P): number | undefined {
    return undefined
  }

  /** Validates the target and the policy name; subclasses add their own checks after calling it. */
  protected prepare(params: P): ParsedPolicyParams<P> {
    validatePoolConfigManagerTarget(this.name, params)
    return { ...params, policyWord: encodePolicyName(this.name, 'policyName', params.policyName) }
  }

  protected async read(
    chain: EVMChain,
    params: ParsedPolicyParams<P>,
  ): Promise<B & MultiTokenPoolPolicyIdentity> {
    const { address, version } = await resolvePoolConfigManagerTarget(chain, params)
    const pcm = poolConfigManagerContract(chain, address, version)
    const blockTag = this.blockTagOf(params) ?? (await chain.provider.getBlockNumber())
    const [records, names] = await Promise.all([
      this.readPolicy(pcm, params, { chain, blockTag }),
      pcm.getPolicyNames({ blockTag }),
    ])
    const word = params.policyWord.toLowerCase()
    const list = names[LANE_RECORD_TYPES.indexOf(this.recordType)] ?? []
    return {
      ...records,
      policyName: decodePolicyName(params.policyWord) ?? params.policyWord,
      exists: list.some((w) => String(w).toLowerCase() === word),
    }
  }
}
