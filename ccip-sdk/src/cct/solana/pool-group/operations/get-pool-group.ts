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

  /** Decodes the `Group` (a superset of `observe_group`) and probes the program's features. */
  protected async read(chain: SolanaChain, ref: ParsedPoolGroupRef): Promise<GetPoolGroupResult> {
    const group = await readPoolGroup(this.name, chain, ref)
    const pendingAt = toBigInt(group.pendingMinCcvActivationDelayAt)
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
      minCCVActivationDelay: toBigInt(group.minCcvActivationDelay),
      pendingMinCCVActivationDelay:
        pendingAt === 0n
          ? null
          : { delay: toBigInt(group.pendingMinCcvActivationDelay), appliesAt: pendingAt },
      defaultPolicy: decodeSections(group.defaultPolicy),
      ccvEpochCounter: toBigInt(group.ccvEpochCounter),
      nextPolicyId: group.nextPolicyId,
      securityGeneration: group.securityGeneration,
      hookLookupTable: keyOrNull(group.hookLookupTable),
      remoteChainSelectors: group.chainSelectors.map(toBigInt),
      features: await getPoolGroupProgramFeatures(chain, ref.program, { groupExists: true }),
    }
  }
}
