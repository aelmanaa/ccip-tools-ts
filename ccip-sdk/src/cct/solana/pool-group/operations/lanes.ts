/**
 * Linked lanes (S5): `link_lanes`, `unlink_lanes`, `init_group_lanes`, `set_lane_pool_data`.
 * Program of record: chainlink-ccip-solana 7558722, `burnmint-token-pool/src/instructions/groups/`
 * `lanes.rs` and `lane_pool_data.rs`.
 *
 * Every write runs the shared write guard: the program computes the post-state in a simulation, and
 * a lane the write makes live (linking clears a lane's own pauses; a created lane on an unpaused
 * chain is live at once) runs the lane check as the write leaves it. Lanes the write links or
 * creates are judged although no listing before the write holds them.
 *
 * @packageDocumentation
 */

import { BN } from '@coral-xyz/anchor'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import {
  type AccountMeta,
  type TransactionInstruction,
  PublicKey,
  SystemProgram,
} from '@solana/web3.js'

import type { SolanaChain } from '../../../../solana/index.ts'
import {
  deriveTokenPoolChainConfigOverridePda,
  deriveTokenPoolChainConfigV2Pda,
} from '../../../../solana/token-pool.ts'
import { getMultipleAccountsInfoPaged } from '../../../../solana/utils.ts'
import { encodeAddressToAny } from '../../../../shared/codec.ts'
import { getAddressBytes } from '../../../../utils.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import type { PoolDataFormat } from '../../../multi-token-pool.ts'
import {
  decodeRemoteAddress,
  parseRemoteAddress,
  parseUniqueRemoteAddresses,
} from '../../../remote-address.ts'
import type { SolanaGenerateParams } from '../../operation.ts'
import { deriveTokenAdminRegistryPda } from '../../programs/router.ts'
import {
  deriveTokenPoolChainConfigPda,
  deriveTokenPoolConfigPda,
  deriveTokenPoolFeeVaultPda,
} from '../../programs/token-pool.ts'
import { parsePublicKey } from '../../validate.ts'
import { poolGroupPdas } from '../accounts.ts'
import { decodeSections } from '../decode.ts'
import { type PoolGroupLaneState, isUnread } from '../lane.ts'
import type { PoolGroupPackItem } from '../packer.ts'
import { createPoolGroupProgram } from '../program.ts'
import type { PoolState } from '../remote-lane.ts'
import { POOL_GROUP_POLICY_CLASSES, type PoolGroupPolicyClass } from '../types.ts'
import {
  type ParsedPoolGroupWrite,
  type PoolGroupWritePlan,
  PoolGroupWriteOperation,
  parseWriteBase,
} from '../write-operation.ts'
import type {
  InitPoolGroupLanesParams,
  LinkPoolGroupLanesParams,
  PoolGroupGuardOptions,
  PoolGroupLinkClassSource,
  SetPoolGroupLanePoolDataParams,
  UnlinkPoolGroupLanesParams,
} from '../write-types.ts'
import {
  type ParsedPoolGroupRef,
  decodeOwned,
  parsePoolGroupProgram,
  parseTokenAddresses,
  readPoolGroup,
  validateSelector,
} from './common.ts'
import { readPoolGroupLaneStates } from './lane.ts'
import {
  type ParsedGroupWrite,
  bigField,
  decodeOne,
  eventAccounts,
  field,
  fittedItems,
  membershipCoSigner,
  mintsOfPoolStates,
  parseGroupWrite,
  poolGroupTrustOf,
  proposalBase,
  readPoolStates,
  requireExpectedGroupOwner,
} from './write-common.ts'

/** `CLASS_SOURCE_INLINE` and `CLASS_SOURCE_GROUP_DEFAULT` (groups.rs). */
const SOURCE = { inline: 0, default: 1 } as const

/** Accounts per lane of `link_lanes` (lanes.rs:31). */
const LINK_LANE_ACCOUNTS = 6
/** Accounts per lane of `unlink_lanes` (lanes.rs:34). */
const UNLINK_LANE_ACCOUNTS = 4
/** Accounts per lane of `init_group_lanes` (lanes.rs:37). */
const INIT_LANE_ACCOUNTS = 5

/**
 * Parses a link's class sources: every class `'inline'` or `'default'` (named policies are assigned
 * after linking, with `assignPoolGroupLanePolicies`).
 * @throws {@link CCTParamsInvalidError} if a class is missing or has another source
 */
function parseLinkClassSource(operation: string, value: unknown): number[] {
  if (typeof value !== 'object' || value === null)
    throw new CCTParamsInvalidError(operation, 'classSource', 'must give a source for every class')
  return POOL_GROUP_POLICY_CLASSES.map((cls) => {
    const v: unknown = Reflect.get(value, cls)
    if (v !== 'inline' && v !== 'default')
      throw new CCTParamsInvalidError(
        operation,
        `classSource.${cls}`,
        "must be 'inline' or 'default' (assign named policies after linking, with assignPoolGroupLanePolicies)",
      )
    return SOURCE[v]
  })
}

/** Class source bytes back to their names (a proposal's). */
const linkClassSourceOf = (raw: unknown): PoolGroupLinkClassSource => {
  const bytes = Array.isArray(raw) ? raw : []
  const entries = POOL_GROUP_POLICY_CLASSES.map(
    (cls, i) => [cls, bytes[i] === SOURCE.default ? 'default' : 'inline'] as const,
  )
  return Object.fromEntries(entries) as Record<PoolGroupPolicyClass, 'inline' | 'default'>
}

/** The fee vault token account of a mint's pool (`require_fee_vault`, lanes.rs:865-881). */
function feeVaultTokenAccount(program: PublicKey, pool: PoolState): PublicKey {
  return getAssociatedTokenAddressSync(
    pool.state.mint,
    deriveTokenPoolFeeVaultPda(program, pool.state.mint),
    true,
    pool.state.tokenProgram,
  )
}

/**
 * The idempotent creations of the fee vault token accounts that do not exist yet: a linked lane
 * must be able to collect its group's BPS fee, so the program refuses a lane without one
 * (`MissingFeeVaultTokenAccount`); any payer may create it.
 */
async function missingFeeVaults(
  chain: SolanaChain,
  program: PublicKey,
  payer: PublicKey,
  pools: readonly PoolState[],
): Promise<Map<string, TransactionInstruction>> {
  const vaults = pools.map((p) => feeVaultTokenAccount(program, p))
  const infos = await getMultipleAccountsInfoPaged(chain.connection, vaults)
  const out = new Map<string, TransactionInstruction>()
  pools.forEach((pool, i) => {
    if (infos[i]) return
    out.set(
      pool.state.mint.toBase58(),
      createAssociatedTokenAccountIdempotentInstruction(
        payer,
        vaults[i]!,
        deriveTokenPoolFeeVaultPda(program, pool.state.mint),
        pool.state.mint,
        pool.state.tokenProgram,
      ),
    )
  })
  return out
}

/** The CONNECTION pools of a chain record, decoded. */
const recordPools = (record: { policy: Parameters<typeof decodeSections>[0] }, selector: bigint) =>
  decodeSections(record.policy, 0n, selector).connection.remotePools.map((p) => p.address)

/** A writable or read-only meta. */
const meta = (pubkey: PublicKey, isWritable: boolean): AccountMeta => ({
  pubkey,
  isSigner: false,
  isWritable,
})

/**
 * Packs per-lane items: each item is one instruction of as many lanes as fit, preceded by the fee
 * vault creations its lanes need.
 */
async function laneBatchItems<L extends { mint: PublicKey; metas: AccountMeta[] }>(
  operation: string,
  chain: SolanaChain,
  parsed: ParsedPoolGroupWrite,
  lanes: L[],
  build: (chunk: L[]) => Promise<TransactionInstruction>,
  signerRoles: PoolGroupPackItem['signerRoles'],
  prelude: ReadonlyMap<string, TransactionInstruction> = new Map(),
): Promise<PoolGroupPackItem[]> {
  const items = await fittedItems(operation, chain, parsed, lanes, build, {
    ...(signerRoles && { signerRoles }),
    tokenAddressesOf: (chunk) => chunk.map((l) => l.mint.toBase58()),
    describe: (l) => `the lane of ${l.mint.toBase58()}`,
    // a lane's fee vault is created in the same transaction: its simulation needs it first
    simulate: prelude.size === 0,
  })
  if (!prelude.size) return items
  return items.map((item) => ({
    ...item,
    instructions: [
      ...item.tokenAddresses.flatMap((m) => (prelude.has(m) ? [prelude.get(m)!] : [])),
      ...item.instructions,
    ],
  }))
}

// ─── link_lanes ──────────────────────────────────────────────────────────────────────────────

type ParsedLink = ParsedGroupWrite & {
  selector: bigint
  mints: PublicKey[]
  classSource: number[]
  poolGroupOwner?: PublicKey
}

/** Shared parse of a link or creation: the selector, class sources and co-signer. */
function parseJoinedLaneBase<
  P extends {
    remoteChainSelector: bigint
    classSource: PoolGroupLinkClassSource
    poolGroupOwner?: string
  },
>(operation: string, params: SolanaGenerateParams<P & LinkPoolGroupLanesParams>) {
  return {
    ...parseGroupWrite(operation, params),
    selector: validateSelector(operation, 'remoteChainSelector', params.remoteChainSelector),
    classSource: parseLinkClassSource(operation, params.classSource),
    ...(params.poolGroupOwner !== undefined && {
      poolGroupOwner: parsePublicKey(operation, 'poolGroupOwner', params.poolGroupOwner),
    }),
  }
}

/**
 * Reads what a link or creation needs: the group (its owner must be `expectedOwner`, default
 * `authority`), the chain record, and the pools of `mints` (owned by `authority`).
 */
async function readJoinTarget(
  operation: string,
  chain: SolanaChain,
  parsed: ParsedGroupWrite & { selector: bigint },
  mints: readonly PublicKey[],
) {
  const { ref, authority, selector } = parsed
  const gcpAddress = poolGroupPdas.groupChain(ref.program, ref.group, selector)
  const {
    group,
    extras: [gcpInfo],
  } = await readPoolGroup(operation, chain, { program: ref.program, group: ref.group }, [
    gcpAddress,
  ])
  requireExpectedGroupOwner(operation, group.owner, ref.expectedOwner ?? authority)
  if (!gcpInfo)
    throw new CCTParamsInvalidError(
      operation,
      'remoteChainSelector',
      `the pool group has no chain record for ${selector}: add it with addPoolGroupChain`,
    )
  const gcp = decodeOwned('groupChainPolicy', gcpInfo, gcpAddress, ref.program)
  const pools = await readPoolStates(operation, chain, ref.program, mints, authority)
  return { group, gcp, gcpAddress, pools }
}

/** Links existing lanes of one chain to the pool group, in place. */
export class LinkPoolGroupLanes extends PoolGroupWriteOperation<
  LinkPoolGroupLanesParams,
  ParsedLink
> {
  readonly name = 'linkPoolGroupLanes'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(params: SolanaGenerateParams<LinkPoolGroupLanesParams>): ParsedLink {
    const mints = parseTokenAddresses(this.name, params.tokenAddresses)
    if (!mints?.length)
      throw new CCTParamsInvalidError(this.name, 'tokenAddresses', 'must name at least one lane')
    return { ...parseJoinedLaneBase(this.name, params), mints }
  }

  /**
   * `link_lanes`, as many lanes per instruction as one transaction fits; a missing fee vault token
   * account is created first in the same transaction.
   * @throws {@link CCTParamsInvalidError} if the group's owner is not `expectedOwner`, `authority`
   *   does not own a lane's pool, a lane has no `ChainConfigV2` or is already linked, two signers
   *   would be needed under Squads, or a guard refuses (the lane check on a lane linking makes live)
   */
  protected async plan(chain: SolanaChain, parsed: ParsedLink): Promise<PoolGroupWritePlan<object>> {
    const { ref, authority, selector, mints } = parsed
    const { group, gcp, gcpAddress, pools } = await readJoinTarget(this.name, chain, parsed, mints)
    const states = await readPoolGroupLaneStates(
      chain,
      ref.program,
      mints.map((mint) => ({ mint, selector })),
    )
    const lanes = mints.map((mint, i) => {
      const where = `the lane of ${mint.toBase58()} toward ${selector}`
      const s = states[i]
      if (!s)
        throw new CCTParamsInvalidError(
          this.name,
          `tokenAddresses[${i}]`,
          `${where} does not exist: create it in the group with initPoolGroupLanes`,
        )
      if (isUnread(s))
        throw new CCTParamsInvalidError(this.name, `tokenAddresses[${i}]`, `${where}: ${s.reason}`)
      if (!s.v2)
        throw new CCTParamsInvalidError(
          this.name,
          `tokenAddresses[${i}]`,
          `${where} has no ChainConfigV2 (LaneConfigV2Missing): create it with initChainConfigV2`,
        )
      if (s.ext?.poolGroupAddress)
        throw new CCTParamsInvalidError(
          this.name,
          `tokenAddresses[${i}]`,
          `${where} is already linked to the pool group ${s.ext.poolGroupAddress} (LaneAlreadyLinked)`,
        )
      const pool = pools[i]!
      return {
        mint,
        ownPools: s.chainConfig.base.remote.poolAddresses.map((p) =>
          decodeRemoteAddress(Buffer.from(p.address), selector),
        ),
        metas: [
          meta(pool.address, false),
          meta(deriveTokenPoolChainConfigPda(ref.program, selector, mint), true),
          meta(deriveTokenPoolChainConfigV2Pda(ref.program, selector, mint), true),
          meta(deriveTokenPoolChainConfigOverridePda(ref.program, selector, mint), true),
          meta(deriveTokenAdminRegistryPda(pool.state.router, mint), false),
          meta(feeVaultTokenAccount(ref.program, pool), false),
        ],
      }
    })
    const owner = membershipCoSigner(this.name, group, parsed.poolGroupOwner, authority, parsed.budget)
    const client = createPoolGroupProgram(chain, ref.program, parsed.payer)
    const items = await laneBatchItems(
      this.name,
      chain,
      parsed,
      lanes,
      (chunk) =>
        client.methods
          .linkLanes({
            remoteChainSelector: new BN(selector.toString()),
            classSource: parsed.classSource,
          })
          .accountsStrict({
            group: ref.group,
            groupChainPolicy: gcpAddress,
            groupOwner: owner,
            authority,
            systemProgram: SystemProgram.programId,
            ...eventAccounts(ref.program),
          })
          .remainingAccounts(chunk.flatMap((l) => l.metas))
          .instruction(),
      {
        [authority.toBase58()]: 'pool-owner',
        ...(owner && !owner.equals(authority) && { [owner.toBase58()]: 'pool-group-owner' }),
      },
      await missingFeeVaults(chain, ref.program, parsed.payer, pools),
    )
    const trusted =
      parsed.classSource[0] === SOURCE.default
        ? recordPools(gcp, selector)
        : [...new Set(lanes.flatMap((l) => l.ownPools))]
    return {
      group: ref.group,
      items,
      judge: { failsClosedSeverity: 'error' },
      judgeEach: true,
      expected: {
        'group.owner': group.owner.toBase58(),
        'group.openMembership': group.openMembership,
        [`lanes.${selector}.linked`]: mints.map((m) => [m.toBase58(), false]),
      },
      extra: {
        poolGroupTrust: poolGroupTrustOf(group, [
          { remoteChainSelector: selector, addresses: trusted },
        ]),
      },
    }
  }

  /** The lanes and class sources a proposal links. */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedLink {
    const ixs = decodeOne(this.name, instructions, ['linkLanes'], false)
    const first = ixs[0]!
    return {
      ...proposalBase(ref, first.ix.keys[3]!.pubkey, guardOptions),
      selector: bigField(field(first.data, 'params', 'remoteChainSelector')) ?? 0n,
      classSource: [
        ...(Array.isArray(field(first.data, 'params', 'classSource'))
          ? (field(first.data, 'params', 'classSource') as number[])
          : []),
      ],
      mints: [],
      lanes: ixs.flatMap((d) => lanePoolStates(d.ix, 7, LINK_LANE_ACCOUNTS)),
    } as ParsedLink
  }
}
