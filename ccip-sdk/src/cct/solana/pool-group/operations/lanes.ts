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

import { encodeAddressToAny } from '../../../../shared/codec.ts'
import type { SolanaChain } from '../../../../solana/index.ts'
import {
  deriveTokenPoolChainConfigOverridePda,
  deriveTokenPoolChainConfigV2Pda,
} from '../../../../solana/token-pool.ts'
import { getMultipleAccountsInfoPaged } from '../../../../solana/utils.ts'
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
  deriveTokenPoolFeeVaultPda,
} from '../../programs/token-pool.ts'
import { parsePublicKey } from '../../validate.ts'
import { decodePoolGroupChainConfigV2, poolGroupPdas } from '../accounts.ts'
import { decodeSections } from '../decode.ts'
import { type PoolGroupLaneState, isUnread } from '../lane.ts'
import type { PoolGroupPackItem } from '../packer.ts'
import { createPoolGroupProgram } from '../program.ts'
import type { PoolState } from '../remote-lane.ts'
import { POOL_GROUP_POLICY_CLASSES } from '../types.ts'
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
  byteArrayField,
  decodeOne,
  eventAccounts,
  everyLane,
  field,
  fittedItems,
  keyField,
  membershipCoSigner,
  mintsOfPoolStates,
  optionalSigner,
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

/** The fee vault token account of a mint's pool (`require_fee_vault`, lanes.rs:865-881). @internal */
export function feeVaultTokenAccount(program: PublicKey, pool: PoolState): PublicKey {
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
 * @internal
 */
export async function missingFeeVaults(
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

/** A writable or read-only meta. @internal */
export const meta = (pubkey: PublicKey, isWritable: boolean): AccountMeta => ({
  pubkey,
  isSigner: false,
  isWritable,
})

/**
 * Packs per-lane items: each item is one instruction of as many lanes as fit, preceded by the fee
 * vault creations its lanes need.
 * @internal
 */
export async function laneBatchItems<L extends { mint: PublicKey; metas: AccountMeta[] }>(
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

/** The lanes of a write: by mint, or (from a proposal) by their pool `State` accounts. */
type LaneMints = { mints: PublicKey[] } | { states: PublicKey[] }

/** The mints of `lanes`. */
const mintsOf = (operation: string, chain: SolanaChain, program: PublicKey, lanes: LaneMints) =>
  'mints' in lanes
    ? Promise.resolve(lanes.mints)
    : mintsOfPoolStates(operation, chain, program, lanes.states)

type ParsedJoinedLanes = ParsedGroupWrite & {
  selector: bigint
  classSource: number[]
  poolGroupOwner?: PublicKey
}

/** Shared parse of a link or creation: the selector, class sources and co-signer. */
function parseJoinedLaneBase(
  operation: string,
  params:
    | SolanaGenerateParams<LinkPoolGroupLanesParams>
    | SolanaGenerateParams<InitPoolGroupLanesParams>,
): ParsedJoinedLanes {
  return {
    ...parseGroupWrite(operation, params),
    selector: validateSelector(operation, 'remoteChainSelector', params.remoteChainSelector),
    classSource: parseLinkClassSource(operation, params.classSource),
    ...(params.poolGroupOwner !== undefined && {
      poolGroupOwner: parsePublicKey(operation, 'poolGroupOwner', params.poolGroupOwner),
    }),
  }
}

/** A proposal's base for a link or creation: authority, co-signer, chain and class sources. */
function joinedFromInstruction(
  ref: ParsedPoolGroupRef,
  first: { ix: TransactionInstruction; data: unknown },
  guardOptions: PoolGroupGuardOptions,
): ParsedJoinedLanes {
  const owner = optionalSigner(first.ix.keys[2]?.pubkey, ref.program)
  return {
    ...proposalBase(ref, first.ix.keys[3]!.pubkey, guardOptions),
    selector: bigField(field(first.data, 'params', 'remoteChainSelector')) ?? 0n,
    classSource: byteArrayField(field(first.data, 'params', 'classSource')),
    ...(owner && { poolGroupOwner: owner }),
  }
}

/**
 * Reads what a link or creation needs: the group (its owner must be `expectedOwner`, default
 * `authority`), the chain record, and the pools of `mints` (owned by `authority`).
 */
async function readJoinTarget(
  operation: string,
  chain: SolanaChain,
  parsed: ParsedJoinedLanes,
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
  const owner = membershipCoSigner(
    operation,
    group,
    parsed.poolGroupOwner,
    authority,
    parsed.budget,
  )
  return { group, gcp, gcpAddress, pools, owner }
}

/** The signers of a link or creation: the pool owner, and the group owner while membership is closed. */
const joinSigners = (authority: PublicKey, owner: PublicKey | null) => ({
  [authority.toBase58()]: 'pool-owner' as const,
  ...(owner && !owner.equals(authority) && { [owner.toBase58()]: 'pool-group-owner' as const }),
})

type ParsedLink = ParsedJoinedLanes & { lanes: LaneMints }

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
    return { ...parseJoinedLaneBase(this.name, params), lanes: { mints } }
  }

  /**
   * `link_lanes`, as many lanes per instruction as one transaction fits; a missing fee vault token
   * account is created first in the same transaction. Linking clears the lanes' own pauses: a lane
   * on an unpaused chain goes live, and the make-live check runs on it.
   * @throws {@link CCTParamsInvalidError} if the group's owner is not `expectedOwner`, `authority`
   *   does not own a lane's pool, a lane has no `ChainConfigV2` or is already linked, two signers
   *   would be needed under Squads, or a guard refuses
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedLink,
  ): Promise<PoolGroupWritePlan<object>> {
    const { ref, authority, selector } = parsed
    const mints = await mintsOf(this.name, chain, ref.program, parsed.lanes)
    const { group, gcp, gcpAddress, pools, owner } = await readJoinTarget(
      this.name,
      chain,
      parsed,
      mints,
    )
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
      joinSigners(authority, owner),
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

  /** The lanes and class sources a proposal links (per lane: `State` first, after 7 accounts). */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedLink {
    const ixs = decodeOne(this.name, instructions, ['linkLanes'], false)
    return {
      ...joinedFromInstruction(ref, ixs[0]!, guardOptions),
      lanes: { states: everyLane(ixs, 7, LINK_LANE_ACCOUNTS) },
    }
  }
}

// ─── unlink_lanes ────────────────────────────────────────────────────────────────────────────

type ParsedUnlink = ParsedGroupWrite & { selector: bigint; lanes: LaneMints }

/** The named policy records a lane references on its chain. */
const laneRecords = (program: PublicKey, s: PoolGroupLaneState) =>
  (s.ext?.policySlots ?? []).flatMap((p) =>
    p ? [poolGroupPdas.policyChain(program, new PublicKey(p), s.selector).toBase58()] : [],
  )

/** Unlinks lanes of one chain from the pool group; the lane owner signs alone. */
export class UnlinkPoolGroupLanes extends PoolGroupWriteOperation<
  UnlinkPoolGroupLanesParams,
  ParsedUnlink
> {
  readonly name = 'unlinkPoolGroupLanes'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(
    params: SolanaGenerateParams<UnlinkPoolGroupLanesParams>,
  ): ParsedUnlink {
    const mints = parseTokenAddresses(this.name, params.tokenAddresses)
    if (!mints?.length)
      throw new CCTParamsInvalidError(this.name, 'tokenAddresses', 'must name at least one lane')
    return {
      ...parseGroupWrite(this.name, params),
      selector: validateSelector(this.name, 'remoteChainSelector', params.remoteChainSelector),
      lanes: { mints },
    }
  }

  /**
   * `unlink_lanes`: the named records the lanes reference first (writable), then per lane its
   * `State`, `ChainConfig`, `ChainConfigV2` and FTF override. A lane that trusted the group's pools
   * and keeps only its own drops them: confirm with `confirmDropped` (A21).
   * @throws {@link CCTParamsInvalidError} if a lane is not linked to the group, is group-driven
   *   (close it with closePoolGroupLanes), `authority` does not own its pool, or a guard refuses
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedUnlink,
  ): Promise<PoolGroupWritePlan<object>> {
    const { ref, authority, selector } = parsed
    const mints = await mintsOf(this.name, chain, ref.program, parsed.lanes)
    const gcpAddress = poolGroupPdas.groupChain(ref.program, ref.group, selector)
    await readPoolGroup(this.name, chain, ref)
    const pools = await readPoolStates(this.name, chain, ref.program, mints, authority)
    const states = await readPoolGroupLaneStates(
      chain,
      ref.program,
      mints.map((mint) => ({ mint, selector })),
    )
    const lanes = mints.map((mint, i) => {
      const where = `the lane of ${mint.toBase58()} toward ${selector}`
      const s = states[i]
      if (!s || isUnread(s) || s.ext?.poolGroupAddress !== ref.group.toBase58())
        throw new CCTParamsInvalidError(
          this.name,
          `tokenAddresses[${i}]`,
          `${where} is not linked to this pool group${s && isUnread(s) ? ` (${s.reason})` : ''} (LaneNotLinkedToGroup)`,
        )
      if (s.ext.groupDriven)
        throw new CCTParamsInvalidError(
          this.name,
          `tokenAddresses[${i}]`,
          `${where} is group-driven (LaneGroupDriven): it leaves with closePoolGroupLanes, after the member drops the chain or the group stops admitting it`,
        )
      return {
        mint,
        refs: laneRecords(ref.program, s),
        metas: [
          meta(pools[i]!.address, false),
          meta(deriveTokenPoolChainConfigPda(ref.program, selector, mint), true),
          meta(deriveTokenPoolChainConfigV2Pda(ref.program, selector, mint), true),
          meta(deriveTokenPoolChainConfigOverridePda(ref.program, selector, mint), true),
        ],
      }
    })
    const client = createPoolGroupProgram(chain, ref.program, parsed.payer)
    const items = await fittedItems(
      this.name,
      chain,
      parsed,
      lanes,
      (chunk) => {
        const records = [...new Set(chunk.flatMap((l) => l.refs))].map((r) =>
          meta(new PublicKey(r), true),
        )
        return client.methods
          .unlinkLanes({
            remoteChainSelector: new BN(selector.toString()),
            recordCount: records.length,
          })
          .accountsStrict({
            group: ref.group,
            groupChainPolicy: gcpAddress,
            authority,
            systemProgram: SystemProgram.programId,
            ...eventAccounts(ref.program),
          })
          .remainingAccounts([...records, ...chunk.flatMap((l) => l.metas)])
          .instruction()
      },
      {
        signerRoles: { [authority.toBase58()]: 'pool-owner' },
        tokenAddressesOf: (chunk) => chunk.map((l) => l.mint.toBase58()),
        describe: (l) => `the lane of ${l.mint.toBase58()}`,
      },
    )
    return {
      group: ref.group,
      items,
      judge: { failsClosedSeverity: 'error' },
      judgeEach: true,
      expected: {
        [`lanes.${selector}.linked`]: mints.map((m) => [m.toBase58(), true]),
        [`lanes.${selector}.records`]: lanes.map((l) => [l.mint.toBase58(), l.refs]),
      },
      extra: {},
    }
  }

  /** The lanes a proposal unlinks (after 6 accounts and the records: per lane, `State` first). */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedUnlink {
    const ixs = decodeOne(this.name, instructions, ['unlinkLanes'], false)
    const first = ixs[0]!
    const states = ixs.flatMap((d) => {
      const records = Number(bigField(field(d.data, 'params', 'recordCount')) ?? 0)
      return everyLane([d], 6 + records, UNLINK_LANE_ACCOUNTS)
    })
    return {
      ...proposalBase(ref, first.ix.keys[2]!.pubkey, guardOptions),
      selector: bigField(field(first.data, 'params', 'remoteChainSelector')) ?? 0n,
      lanes: { states },
    }
  }
}

// ─── init_group_lanes ────────────────────────────────────────────────────────────────────────

type InitEntry = {
  mint: PublicKey
  remoteToken: string
  decimals: number
  remotePools: string[]
}

type ParsedInit = ParsedJoinedLanes & { entries: InitEntry[] }

/** Parses the lanes to create: unique mints, remote addresses of the chain's family. */
function parseInitEntries(operation: string, value: unknown, selector: bigint): InitEntry[] {
  if (!Array.isArray(value) || !value.length)
    throw new CCTParamsInvalidError(operation, 'lanes', 'must be a non-empty array')
  const entries = value.map((e: unknown, i): InitEntry => {
    const at = `lanes[${i}]`
    const decimals: unknown = Reflect.get(Object(e), 'remoteTokenDecimals')
    if (
      typeof decimals !== 'number' ||
      !Number.isInteger(decimals) ||
      decimals < 0 ||
      decimals > 255
    )
      throw new CCTParamsInvalidError(
        operation,
        `${at}.remoteTokenDecimals`,
        'must be an integer 0-255',
      )
    const pools: unknown = Reflect.get(Object(e), 'remotePoolAddresses')
    if (!Array.isArray(pools))
      throw new CCTParamsInvalidError(operation, `${at}.remotePoolAddresses`, 'must be an array')
    return {
      mint: parsePublicKey(operation, `${at}.tokenAddress`, Reflect.get(Object(e), 'tokenAddress')),
      remoteToken: parseRemoteAddress(
        operation,
        `${at}.remoteTokenAddress`,
        Reflect.get(Object(e), 'remoteTokenAddress'),
        selector,
      ),
      decimals,
      remotePools: parseUniqueRemoteAddresses(
        operation,
        `${at}.remotePoolAddresses`,
        pools,
        selector,
      ),
    }
  })
  const seen = new Set<string>()
  entries.forEach((e, i) => {
    if (seen.has(e.mint.toBase58()))
      throw new CCTParamsInvalidError(
        operation,
        `lanes[${i}].tokenAddress`,
        'must name each mint once',
      )
    seen.add(e.mint.toBase58())
  })
  return entries
}

/** Creates linked lanes of one chain directly in the pool group. */
export class InitPoolGroupLanes extends PoolGroupWriteOperation<
  InitPoolGroupLanesParams,
  ParsedInit
> {
  readonly name = 'initPoolGroupLanes'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(params: SolanaGenerateParams<InitPoolGroupLanesParams>): ParsedInit {
    const base = parseJoinedLaneBase(this.name, params)
    return { ...base, entries: parseInitEntries(this.name, params.lanes, base.selector) }
  }

  /**
   * `init_group_lanes`: per lane `State`, `ChainConfig`, `ChainConfigV2`, fee vault token account
   * and the mint's `TokenAdminRegistry`. A lane created on an unpaused chain is live at once: the
   * make-live check runs on it as the write leaves it.
   * @throws {@link CCTParamsInvalidError} if the group's owner is not `expectedOwner`, `authority`
   *   does not own a pool, a lane already exists (link it instead), or a guard refuses
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedInit,
  ): Promise<PoolGroupWritePlan<object>> {
    const { ref, authority, selector, entries } = parsed
    const mints = entries.map((e) => e.mint)
    const { group, gcp, gcpAddress, pools, owner } = await readJoinTarget(
      this.name,
      chain,
      parsed,
      mints,
    )
    const existing = await getMultipleAccountsInfoPaged(
      chain.connection,
      mints.flatMap((m) => [
        deriveTokenPoolChainConfigPda(ref.program, selector, m),
        deriveTokenPoolChainConfigV2Pda(ref.program, selector, m),
      ]),
    )
    mints.forEach((m, i) => {
      if (existing[2 * i] || existing[2 * i + 1])
        throw new CCTParamsInvalidError(
          this.name,
          `lanes[${i}]`,
          `${m.toBase58()} already has a lane (or a ChainConfigV2) toward ${selector}: link it with linkPoolGroupLanes`,
        )
    })
    const lanes = entries.map((e, i) => {
      const pool = pools[i]!
      return {
        mint: e.mint,
        entry: {
          mint: e.mint,
          remote: {
            poolAddresses: e.remotePools.map((p) => ({ address: Buffer.from(getAddressBytes(p)) })),
            tokenAddress: { address: encodeAddressToAny(e.remoteToken) },
            decimals: e.decimals,
          },
        },
        metas: [
          meta(pool.address, false),
          meta(deriveTokenPoolChainConfigPda(ref.program, selector, e.mint), true),
          meta(deriveTokenPoolChainConfigV2Pda(ref.program, selector, e.mint), true),
          meta(feeVaultTokenAccount(ref.program, pool), false),
          meta(deriveTokenAdminRegistryPda(pool.state.router, e.mint), false),
        ],
      }
    })
    const client = createPoolGroupProgram(chain, ref.program, parsed.payer)
    const items = await laneBatchItems(
      this.name,
      chain,
      parsed,
      lanes,
      (chunk) =>
        client.methods
          .initGroupLanes({
            remoteChainSelector: new BN(selector.toString()),
            classSource: parsed.classSource,
            lanes: chunk.map((l) => l.entry),
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
      joinSigners(authority, owner),
      await missingFeeVaults(chain, ref.program, parsed.payer, pools),
    )
    const trusted =
      parsed.classSource[0] === SOURCE.default
        ? recordPools(gcp, selector)
        : [...new Set(entries.flatMap((e) => e.remotePools))]
    return {
      group: ref.group,
      items: items.map((item) => ({
        ...item,
        createdPdas: item.tokenAddresses.flatMap((m) => {
          const mint = new PublicKey(m)
          return [
            deriveTokenPoolChainConfigPda(ref.program, selector, mint),
            deriveTokenPoolChainConfigV2Pda(ref.program, selector, mint),
          ]
        }),
      })),
      judge: { failsClosedSeverity: 'error' },
      judgeEach: true,
      expected: {
        'group.owner': group.owner.toBase58(),
        'group.openMembership': group.openMembership,
        [`lanes.${selector}.exists`]: mints.map((m) => [m.toBase58(), false]),
      },
      extra: {
        poolGroupTrust: poolGroupTrustOf(group, [
          { remoteChainSelector: selector, addresses: trusted },
        ]),
      },
    }
  }

  /** The lanes a proposal creates (entries from the instruction data). */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedInit {
    const ixs = decodeOne(this.name, instructions, ['initGroupLanes'], false)
    const base = joinedFromInstruction(ref, ixs[0]!, guardOptions)
    const bytes = (v: unknown) => Buffer.from(v instanceof Uint8Array ? v : [])
    const entries = ixs.flatMap((d) => {
      const lanes = field(d.data, 'params', 'lanes')
      return (Array.isArray(lanes) ? lanes : []).map((l: unknown): InitEntry => {
        const pools = field(l, 'remote', 'poolAddresses')
        return {
          mint: keyField(this.name, l, 'mint'),
          remoteToken: decodeRemoteAddress(
            bytes(field(l, 'remote', 'tokenAddress', 'address')),
            base.selector,
          ),
          decimals: Number(field(l, 'remote', 'decimals') ?? 0),
          remotePools: (Array.isArray(pools) ? pools : []).map((p: unknown) =>
            decodeRemoteAddress(bytes(field(p, 'address')), base.selector),
          ),
        }
      })
    })
    return { ...base, entries }
  }
}

// ─── set_lane_pool_data ──────────────────────────────────────────────────────────────────────

type ParsedPoolData = ParsedPoolGroupWrite & {
  mint: PublicKey
  selector: bigint
  format: PoolDataFormat
  uid: Buffer | null
}

/** Parses a factory UID: 32-byte hex, or `null`. */
function parseUid(operation: string, value: unknown): Buffer | null {
  if (value === null) return null
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new CCTParamsInvalidError(
      operation,
      'uid',
      'must be 32-byte hex (0x + 64 digits) or null',
    )
  return Buffer.from(value.slice(2), 'hex')
}

/** Sets a lane's own pool-data format and factory UID (the lane owner). */
export class SetPoolGroupLanePoolData extends PoolGroupWriteOperation<
  SetPoolGroupLanePoolDataParams,
  ParsedPoolData
> {
  readonly name = 'setPoolGroupLanePoolData'

  /** @throws {@link CCTParamsInvalidError} if a param is invalid */
  protected override prepare(
    params: SolanaGenerateParams<SetPoolGroupLanePoolDataParams>,
  ): ParsedPoolData {
    const program = parsePoolGroupProgram(this.name, params)
    const format: unknown = params.poolDataFormat
    if (format !== 'legacy' && format !== 'long')
      throw new CCTParamsInvalidError(this.name, 'poolDataFormat', "must be 'legacy' or 'long'")
    const uid = parseUid(this.name, params.uid)
    if (uid && format !== 'long')
      throw new CCTParamsInvalidError(
        this.name,
        'uid',
        'a lane with a UID sends long pool data (UidRequiresLongPoolData): set poolDataFormat long',
      )
    return {
      ...parseWriteBase(this.name, program, params),
      mint: parsePublicKey(this.name, 'tokenAddress', params.tokenAddress),
      selector: validateSelector(this.name, 'remoteChainSelector', params.remoteChainSelector),
      format,
      uid,
    }
  }

  /**
   * `set_lane_pool_data`, with the group chain record (when linked) and the named CONNECTION and
   * FEE records the lane reaches (writable: they count its pool-data demand). The guard judges
   * this lane only: the records' demand counters are read by later record writes, not by transfers.
   * @throws {@link CCTParamsInvalidError} if the lane has no `ChainConfigV2`, `authority` does not
   *   own the pool, or a guard refuses (the format change on a live lane runs the lane check)
   */
  protected async plan(
    chain: SolanaChain,
    parsed: ParsedPoolData,
  ): Promise<PoolGroupWritePlan<object>> {
    const { program, authority, mint, selector } = parsed
    const [pool] = await readPoolStates(this.name, chain, program, [mint], authority)
    const [s] = await readPoolGroupLaneStates(chain, program, [{ mint, selector }])
    const where = `the lane of ${mint.toBase58()} toward ${selector}`
    if (!s || isUnread(s))
      throw new CCTParamsInvalidError(
        this.name,
        'tokenAddress',
        `${where} cannot be read${s ? ` (${s.reason})` : ': it does not exist'}`,
      )
    if (!s.v2)
      throw new CCTParamsInvalidError(
        this.name,
        'tokenAddress',
        `${where} has no ChainConfigV2 (LaneConfigV2Missing): create it with initChainConfigV2`,
      )
    const group = s.ext?.poolGroupAddress ? new PublicKey(s.ext.poolGroupAddress) : null
    const named = (['connection', 'fee'] as const).flatMap((cls) => {
      const src = s.ext?.classSource[cls]
      const n = src?.kind === 'policy' ? s.named.get(src.slot) : undefined
      return n ? [n.address.toBase58()] : []
    })
    const remaining = [
      ...(group ? [meta(poolGroupPdas.groupChain(program, group, selector), true)] : []),
      ...[...new Set(named)].map((a) => meta(new PublicKey(a), true)),
    ]
    const current = { format: s.ext?.poolDataFormat ?? 'legacy', uid: s.ext?.uid ?? null }
    const uidHex = parsed.uid ? `0x${parsed.uid.toString('hex')}` : null
    const expected = { [`lane.${mint.toBase58()}.${selector}.poolData`]: current }
    // the program owns the binding: a lane without a group binds its ChainConfigV2
    const bound = group ?? s.v2.address
    if (current.format === parsed.format && current.uid === uidHex)
      return { group: bound, items: [], judge: null, expected, extra: {} }
    const ix = await createPoolGroupProgram(chain, program, parsed.payer)
      .methods.setLanePoolData({
        mint,
        remoteChainSelector: new BN(selector.toString()),
        poolDataFormat: parsed.format === 'long' ? { long: {} } : { legacy32: {} },
        uid: parsed.uid ? [...parsed.uid] : null,
      })
      .accountsStrict({
        state: pool!.address,
        chainConfigV2: s.v2.address,
        chainConfig: s.chainConfig.address,
        authority,
        systemProgram: SystemProgram.programId,
        ...eventAccounts(program),
      })
      .remainingAccounts(remaining)
      .instruction()
    return {
      group: bound,
      items: [
        {
          tokenAddresses: [mint.toBase58()],
          instructions: [ix],
          signerRoles: { [authority.toBase58()]: 'pool-owner' },
        },
      ],
      judge: { failsClosedSeverity: 'error', lanes: [{ mint, selector }] },
      expected,
      extra: {},
    }
  }

  /** The lane's group, or its `ChainConfigV2` for a lane without one. */
  protected override async proposalGroupOf(chain: SolanaChain, ix: TransactionInstruction) {
    const v2 = ix.keys[1]?.pubkey
    if (!v2) return undefined
    const [info] = await getMultipleAccountsInfoPaged(chain.connection, [v2])
    if (!info?.owner.equals(ix.programId)) return v2
    const lane = decodePoolGroupChainConfigV2(info.data, v2.toBase58())
    return lane.ext?.poolGroupAddress ? new PublicKey(lane.ext.poolGroupAddress) : v2
  }

  /** The format and UID a proposal sets. */
  protected fromInstructions(
    ref: ParsedPoolGroupRef,
    instructions: readonly TransactionInstruction[],
    guardOptions: PoolGroupGuardOptions,
  ): ParsedPoolData {
    const [one] = decodeOne(this.name, instructions, ['setLanePoolData'])
    const authority = one!.ix.keys[3]!.pubkey
    const uid = field(one!.data, 'params', 'uid')
    const format = field(one!.data, 'params', 'poolDataFormat')
    return {
      payer: authority,
      authority,
      program: ref.program,
      guardOptions,
      mint: keyField(this.name, one!.data, 'params', 'mint'),
      selector: bigField(field(one!.data, 'params', 'remoteChainSelector')) ?? 0n,
      format: typeof format === 'object' && format !== null && 'long' in format ? 'long' : 'legacy',
      uid: Array.isArray(uid) ? Buffer.from(byteArrayField(uid)) : null,
    }
  }
}

/** The linked-lane ops, by name: the snapshot check runs their re-checks. @internal */
export const POOL_GROUP_LANE_OPERATIONS = {
  linkPoolGroupLanes: new LinkPoolGroupLanes(),
  unlinkPoolGroupLanes: new UnlinkPoolGroupLanes(),
  initPoolGroupLanes: new InitPoolGroupLanes(),
  setPoolGroupLanePoolData: new SetPoolGroupLanePoolData(),
} as const
