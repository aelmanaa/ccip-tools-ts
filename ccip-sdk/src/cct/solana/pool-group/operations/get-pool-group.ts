import type { SolanaChain } from '../../../../solana/index.ts'
import { SolanaQuery } from '../../query.ts'
import { decodeRoles, decodeSections, keyOrNull, toBigInt } from '../decode.ts'
import { getPoolGroupProgramFeatures } from '../program.ts'
import type { GetPoolGroupParams, GetPoolGroupResult } from '../types.ts'
import { type ParsedPoolGroupRef, parsePoolGroupRef, readPoolGroup } from './common.ts'

/** Decodes a pool group's `Group` account. */
export class GetPoolGroup extends SolanaQuery<
  GetPoolGroupParams,
  GetPoolGroupResult,
  ParsedPoolGroupRef
> {
  readonly name = 'getPoolGroup'

  /** @throws {@link CCTParamsInvalidError} if the ref is invalid */
  protected prepare(params: GetPoolGroupParams) {
    return parsePoolGroupRef(this.name, params)
  }

  /**
   * Decodes the `Group` at the cluster clock (a superset of `observe_group`, with the delay and
   * default SECURITY in force) and probes the program's features.
   */
  protected async read(chain: SolanaChain, ref: ParsedPoolGroupRef): Promise<GetPoolGroupResult> {
    const { group, now } = await readPoolGroup(this.name, chain, ref)
    const pendingAt = toBigInt(group.pendingMinCcvActivationDelayAt)
    // as `min_ccv_activation_delay_at`: a pending (lower) delay whose time has come is in force
    const applied = pendingAt !== 0n && now >= pendingAt
    const pendingDelay = toBigInt(group.pendingMinCcvActivationDelay)
    return {
      poolGroupAddress: ref.group.toBase58(),
      poolGroupId: group.groupId.toBase58(),
      poolProgramAddress: ref.program.toBase58(),
      owner: group.owner.toBase58(),
      proposedOwner: keyOrNull(group.proposedOwner),
      roles: decodeRoles(group.roles),
      maxBpsFee: group.maxBpsFee,
      openMembership: group.openMembership,
      paused: group.paused,
      minCCVActivationDelay: applied ? pendingDelay : toBigInt(group.minCcvActivationDelay),
      pendingMinCCVActivationDelay:
        pendingAt === 0n || applied ? null : { delay: pendingDelay, appliesAt: pendingAt },
      defaultPolicy: decodeSections(group.defaultPolicy, now),
      ccvEpochCounter: toBigInt(group.ccvEpochCounter),
      nextPolicyId: group.nextPolicyId,
      securityGeneration: group.securityGeneration,
      hookLookupTable: keyOrNull(group.hookLookupTable),
      remoteChainSelectors: group.chainSelectors.map(toBigInt),
      features: await getPoolGroupProgramFeatures(chain, ref.program, { groupExists: true }),
    }
  }
}
