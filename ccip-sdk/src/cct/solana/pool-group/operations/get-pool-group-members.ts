import type { PublicKey } from '@solana/web3.js'

import type { SolanaChain } from '../../../../solana/index.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { SolanaQuery } from '../../query.ts'
import { decodePoolGroupMember, decodePoolGroupRegistry, poolGroupPdas } from '../accounts.ts'
import type { GetPoolGroupMembersParams, GetPoolGroupMembersResult } from '../types.ts'
import {
  type ParsedPoolGroupRef,
  decodeOwnedData,
  listPoolGroupMembers,
  parsePoolGroupRef,
  parseTokenAddresses,
  readPoolGroup,
} from './common.ts'
import { toPoolGroupMember } from './members.ts'

type Parsed = ParsedPoolGroupRef & { mints?: PublicKey[] }

/** Lists a pool group's members and registry. */
export class GetPoolGroupMembers extends SolanaQuery<
  GetPoolGroupMembersParams,
  GetPoolGroupMembersResult,
  Parsed
> {
  readonly name = 'getPoolGroupMembers'

  /** @throws {@link CCTParamsInvalidError} if the ref or a token address is invalid */
  protected prepare(params: GetPoolGroupMembersParams): Parsed {
    const ref = parsePoolGroupRef(this.name, params)
    const mints = parseTokenAddresses(this.name, params.tokenAddresses)
    return mints ? { ...ref, mints } : ref
  }

  /**
   * Reads the registry and the members: with `tokenAddresses`, their `GroupMember` PDAs (a mint of
   * another group, or of none, is refused); otherwise `getProgramAccounts`.
   */
  protected async read(chain: SolanaChain, ref: Parsed): Promise<GetPoolGroupMembersResult> {
    const registryAddress = poolGroupPdas.groupRegistry(ref.program, ref.group)
    const memberAddresses = (ref.mints ?? []).map((m) => poolGroupPdas.groupMember(ref.program, m))
    const {
      extras: [registryAccount, ...memberAccounts],
    } = await readPoolGroup(this.name, chain, ref, [registryAddress, ...memberAddresses])
    // absent before the first join; any other owner is not the program's registry
    const registry = registryAccount
      ? {
          address: registryAddress.toBase58(),
          ...decodePoolGroupRegistry(
            decodeOwnedData(registryAccount, registryAddress, ref.program),
            registryAddress.toBase58(),
          ),
        }
      : null
    let members
    if (ref.mints) {
      members = memberAccounts.map((account, i) => {
        const address = memberAddresses[i]!
        const member =
          account?.owner.equals(ref.program) &&
          decodePoolGroupMember(account.data, address.toBase58())
        if (!member || member.poolGroupAddress !== ref.group.toBase58())
          throw new CCTParamsInvalidError(
            this.name,
            `tokenAddresses[${i}]`,
            `${ref.mints![i]!.toBase58()} is not a member of this pool group`,
          )
        return { address, member }
      })
    } else members = await listPoolGroupMembers(this.name, chain, ref.program, ref.group)
    return {
      registry: registry && {
        address: registry.address,
        poolGroupAddress: registry.poolGroupAddress,
        nextMemberIndex: registry.nextMemberIndex,
        memberCount: registry.memberCount,
      },
      poolGroupMembers: members
        .map(({ address, member }) => toPoolGroupMember(address.toBase58(), member))
        .sort((a, b) => a.memberIndex - b.memberIndex),
    }
  }
}
