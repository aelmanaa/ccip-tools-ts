import { decodeRemoteAddress } from '../../../remote-address.ts'
import type { PoolGroupMemberAccount } from '../accounts.ts'
import type { PoolGroupMember } from '../types.ts'

/**
 * A decoded `GroupMember` in public form: each remote token decoded for its first chain, and the
 * encoded size of the remote-token list (`Vec<MemberRemoteToken>`).
 * @internal
 */
export function toPoolGroupMember(address: string, m: PoolGroupMemberAccount): PoolGroupMember {
  return {
    address,
    poolGroupAddress: m.poolGroupAddress,
    tokenAddress: m.mint,
    memberIndex: m.memberIndex,
    laneCount: m.laneCount,
    rentReceiver: m.rentReceiver,
    remoteTokens: m.remoteTokens.map((t) => ({
      remoteChainSelectors: t.remoteChainSelectors,
      token:
        t.remoteChainSelectors[0] === undefined
          ? `0x${t.token.toString('hex')}`
          : decodeRemoteAddress(t.token, t.remoteChainSelectors[0]),
      decimals: t.decimals,
    })),
    lanePayers: m.lanePayers,
    remoteTokensEncodedBytes:
      4 +
      m.remoteTokens.reduce(
        (n, t) => n + 4 + 8 * t.remoteChainSelectors.length + 4 + t.token.length + 1,
        0,
      ),
  }
}
