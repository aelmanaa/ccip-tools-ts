import type { SolanaChain } from '../../../../solana/index.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { SolanaQuery } from '../../query.ts'
import { GROUP_CHAIN_POLICY_FIXED_LEN, poolGroupPdas } from '../accounts.ts'
import { decodeClassBits, decodeLaneMode, decodeSections } from '../decode.ts'
import type { GetPoolGroupChainParams, GetPoolGroupChainResult } from '../types.ts'
import {
  type ParsedPoolGroupRef,
  decodeOwned,
  listPoolGroupMembers,
  parsePoolGroupRef,
  readPoolGroup,
  validateSelector,
} from './common.ts'

type Parsed = ParsedPoolGroupRef & { selector: bigint }

/** The set bits of a subset bitmap: bit `i % 8` of byte `i / 8`. @internal */
export function subsetIndices(bitmap: Uint8Array): number[] {
  const out: number[] = []
  bitmap.forEach((byte, i) => {
    for (let bit = 0; bit < 8; bit++) if ((byte >> bit) & 1) out.push(i * 8 + bit)
  })
  return out
}

/** Decodes a pool group chain record, with its subset joined to the current members. */
export class GetPoolGroupChain extends SolanaQuery<
  GetPoolGroupChainParams,
  GetPoolGroupChainResult,
  Parsed
> {
  readonly name = 'getPoolGroupChain'

  /** @throws {@link CCTParamsInvalidError} if the ref or selector is invalid */
  protected prepare(params: GetPoolGroupChainParams): Parsed {
    return {
      ...parsePoolGroupRef(this.name, params),
      selector: validateSelector(this.name, 'remoteChainSelector', params.remoteChainSelector),
    }
  }

  /**
   * Decodes the record and its subset bitmap; set bits are joined with the members
   * (`getProgramAccounts`) only when there are any.
   */
  protected async read(chain: SolanaChain, ref: Parsed): Promise<GetPoolGroupChainResult> {
    await readPoolGroup(this.name, chain, ref)
    const address = poolGroupPdas.groupChain(ref.program, ref.group, ref.selector)
    const account = await chain.connection.getAccountInfo(address)
    if (!account)
      throw new CCTParamsInvalidError(
        this.name,
        'remoteChainSelector',
        `the pool group has no chain record for ${ref.selector}`,
      )
    const record = decodeOwned('groupChainPolicy', account, address, ref.program)
    const indices = subsetIndices(account.data.subarray(GROUP_CHAIN_POLICY_FIXED_LEN))
    const byIndex = new Map<number, string>()
    if (indices.length)
      for (const { member } of await listPoolGroupMembers(this.name, chain, ref.program, ref.group))
        byIndex.set(member.memberIndex, member.mint)
    const demand = record.poolDataDemand
    return {
      poolGroupAddress: ref.group.toBase58(),
      address: address.toBase58(),
      remoteChainSelector: ref.selector,
      inheritsDefault: decodeClassBits(record.inheritsDefault),
      groupPaused: record.groupPaused,
      pausedOutbound: record.pausedOutbound,
      pausedInbound: record.pausedInbound,
      memberLaneCount: record.memberLaneCount,
      policy: decodeSections(record.policy, ref.selector),
      poolDataDemand: {
        feeInlineLong: demand.feeInlineLong,
        feeUid: demand.feeUid,
        connectionUid: demand.connectionUid,
      },
      laneMode: decodeLaneMode(record.laneMode),
      drivenLanesPaused: record.drivenLanesPaused,
      subsetTokens: indices.flatMap((i) => byIndex.get(i) ?? []),
      subsetMemberIndices: indices,
      staleSubsetMemberIndices: indices.filter((i) => !byIndex.has(i)),
      securityGeneration: record.securityGeneration,
    }
  }
}
