/**
 * Public types of the Solana pool-group reads.
 *
 * @packageDocumentation
 */

import type { TokenTransferFeeConfig } from '../../../chain.ts'
import type { FinalityAllowed, FinalityRequested } from '../../../extra-args.ts'
import type {
  MultiTokenPoolDirection,
  MultiTokenPoolSnapshot,
  PoolDataFormat,
} from '../../multi-token-pool.ts'
import type { RateLimitConfig } from '../../rate-limit.ts'

/**
 * Pool-group features a pool program may have, probed per instruction: `groups` (pool groups and
 * policies), `hooks` (allowlists, blocklists and policy engines), `drivenLanes` (group-driven lanes)
 * and `drivenLanesV2Layout` (the current `close_group_lanes` layout).
 */
export const POOL_GROUP_FEATURES = [
  'groups',
  'hooks',
  'drivenLanes',
  'drivenLanesV2Layout',
] as const
/** One pool-group feature. */
export type PoolGroupFeature = (typeof POOL_GROUP_FEATURES)[number]

/** The four policy classes. CONNECTION covers the EVM connection and remote pool types; FEE covers fee and overhead. */
export const POOL_GROUP_POLICY_CLASSES = ['connection', 'fee', 'rateLimit', 'security'] as const
/** One policy class. */
export type PoolGroupPolicyClass = (typeof POOL_GROUP_POLICY_CLASSES)[number]

/** The pool program of a pool-group read. */
export type PoolGroupProgramRef = {
  /** Pool program; defaults to the canonical burn-mint program. */
  poolProgramAddress?: string
}

/**
 * The pool group a read targets: its PDA, or the `poolGroupId` it was created with.
 * `expectedOwner` makes the read refuse a group someone else owns.
 */
export type PoolGroupRef = PoolGroupProgramRef &
  (
    | {
        /** The `Group` PDA. */
        poolGroupAddress: string
        /** Not with `poolGroupAddress`. */
        poolGroupId?: never
      }
    | {
        /** The id the group was created with (its PDA seed). */
        poolGroupId: string
        /** Not with `poolGroupId`. */
        poolGroupAddress?: never
      }
  ) & {
    /** Refuse a group whose owner is someone else. */
    expectedOwner?: string
  }

/** One lane: a mint and a remote chain. */
export type PoolGroupLaneKey = {
  /** The local mint. */
  tokenAddress: string
  /** The remote chain selector. */
  remoteChainSelector: bigint
}

/** One remote pool of a CONNECTION section. */
export type PoolGroupRemotePool = {
  /** The remote pool, in the remote chain's spelling. */
  address: string
  /** Accept legacy (empty or 32-byte) pool data from it. */
  allowLegacyPoolData: boolean
}
/** CONNECTION section. `'long'` needs an enabled FEE `destBytesOverhead >= 192` (224 with a UID). */
export type PoolGroupConnectionSection = {
  /** Remote pools every lane on the record trusts, on top of its own. */
  remotePools: PoolGroupRemotePool[]
  /** The pool data the lanes send. */
  poolDataFormat: PoolDataFormat
  /** Allowed finality for outbound transfers. */
  allowedFinality: FinalityAllowed
}
/** FEE section: the core `TokenTransferFeeConfig`. */
export type PoolGroupFeeSection = {
  /** The fee config. */
  tokenTransferFeeConfig: TokenTransferFeeConfig
}
/** RATE_LIMIT section: four buckets of the shared `RateLimitConfig`. Edits do not refill the buckets: a lowered capacity caps the stored tokens, a raised one leaves them as they are. */
export type PoolGroupRateLimitSection = {
  /** Outbound. */
  outbound: RateLimitConfig
  /** Inbound. */
  inbound: RateLimitConfig
  /** Outbound, faster than finality. */
  fastFinalityOutbound: RateLimitConfig
  /** Inbound, faster than finality. */
  fastFinalityInbound: RateLimitConfig
}
/** A decoded CCV set; `INCLUDE_DEFAULT_CCVS` reads as `'default'`. */
export type PoolGroupCCVSet = {
  /** Outbound CCVs. */
  outbound: string[]
  /** Inbound CCVs. */
  inbound: string[]
  /** The set's epoch. */
  epoch: bigint
}
/** A policy engine binding. */
export type PoolGroupPolicyEngine = {
  /** The engine program. */
  program: string
  /** Its static accounts. */
  staticAccounts: string[]
  /** Indices of the static accounts passed writable. */
  writableStatics: number[]
  /** Called on send. */
  onSend: boolean
  /** Called on receive. */
  onReceive: boolean
}
/** A decoded hook config. */
export type PoolGroupHookConfig = {
  /** Sender allowlist, if any. */
  allowlist: string | null
  /** Blocklist, if any. */
  blocklist: string | null
  /** Policy engine, if any. */
  policyEngine: PoolGroupPolicyEngine | null
}
/** A decoded SECURITY section. */
export type PoolGroupSecuritySection = {
  /** The set in force. */
  current: PoolGroupCCVSet
  /** A scheduled set and when it activates. */
  pending:
    | (PoolGroupCCVSet & {
        /** Unix time from which the set replaces the current one. */
        activatesAt: bigint
      })
    | null
  /** Lists may omit the default CCVs. */
  allowDroppingDefaultCCVs: boolean
  /** Hooks, if any. */
  hook: PoolGroupHookConfig | null
}
/** All four sections. */
export type PoolGroupSections = {
  /** CONNECTION. */
  connection: PoolGroupConnectionSection
  /** FEE. */
  fee: PoolGroupFeeSection
  /** RATE_LIMIT. */
  rateLimit: PoolGroupRateLimitSection
  /** SECURITY. */
  security: PoolGroupSecuritySection
}

/** The seven roles; `null` = unset (never held). FEE is `feeAdmin`'s alone: the owner is not a fee writer. */
export type PoolGroupRoles = {
  /** Any class of any chain record, and chain record lifecycle. */
  policyAdmin: string | null
  /** CONNECTION. */
  connectionAdmin: string | null
  /** FEE. */
  feeAdmin: string | null
  /** RATE_LIMIT and bucket resets. */
  rateLimitAdmin: string | null
  /** SECURITY (CCVs, hooks). */
  securityAdmin: string | null
  /** Sets pauses. */
  pauser: string | null
  /** Clears pauses. */
  unpauser: string | null
}

/** Result of `getPoolGroup` (IDL account decode, a superset of `observe_group`). */
export type GetPoolGroupResult = {
  /** The `Group` PDA. */
  poolGroupAddress: string
  /** Its id. */
  poolGroupId: string
  /** Its program. */
  poolProgramAddress: string
  /** Owner. */
  owner: string
  /** Proposed owner, if a transfer is pending. */
  proposedOwner: string | null
  /** Roles. */
  roles: PoolGroupRoles
  /** Cap on every BPS fee of the group's records. */
  maxBpsFee: number
  /** Joining needs only the lane owner. */
  openMembership: boolean
  /** Group-wide pause. */
  paused: boolean
  /** Least delay before a scheduled CCV set activates. */
  minCCVActivationDelay: bigint
  /** A pending change of that delay. */
  pendingMinCCVActivationDelay: {
    /** The new delay, in seconds. */
    delay: bigint
    /** Unix time from which it applies. */
    appliesAt: bigint
  } | null
  /** The default record (EVM's selector-0 record). */
  defaultPolicy: PoolGroupSections
  /** Last CCV epoch handed out. */
  ccvEpochCounter: bigint
  /** Next named policy id. */
  nextPolicyId: number
  /** Bumped on each ownership change. */
  securityGeneration: number
  /** Lookup table of hook accounts, if set. */
  hookLookupTable: string | null
  /** Chains with a chain record. */
  remoteChainSelectors: bigint[]
  /** The program's pool-group features. */
  features: PoolGroupFeature[]
}

/** How a chain record admits pool group members to driven lanes. */
export type PoolGroupLaneMode = 'off' | 'all-members' | 'subset'

/** Result of `getPoolGroupChain`, including the subset bitmap and carved fields. */
export type GetPoolGroupChainResult = {
  /** The group. */
  poolGroupAddress: string
  /** The chain record. */
  address: string
  /** Its chain. */
  remoteChainSelector: bigint
  /** Classes that follow the group default. */
  inheritsDefault: PoolGroupPolicyClass[]
  /** Mirror of the group pause. */
  groupPaused: boolean
  /** Chain pause, outbound. */
  pausedOutbound: boolean
  /** Chain pause, inbound. */
  pausedInbound: boolean
  /** Lanes linked to the group on this chain. */
  memberLaneCount: number
  /** The record's sections. */
  policy: PoolGroupSections
  /** What the member lanes need from the record's pool-data settings. */
  poolDataDemand: {
    /** Members with FEE from the record, an inline long CONNECTION and no UID. */
    feeInlineLong: number
    /** Members with FEE from the record and a UID. */
    feeUid: number
    /** Members with CONNECTION from the record and a UID. */
    connectionUid: number
  }
  /** Driven-lane mode. */
  laneMode: PoolGroupLaneMode
  /** Driven lanes paused in both directions. */
  drivenLanesPaused: boolean
  /** Live subset members (index joined with current `GroupMember`s of this pool group). */
  subsetTokens: string[]
  /** Raw set bits; includes stale bits of departed members (indices are never reused). */
  subsetMemberIndices: number[]
  /** Set bits with no current member. */
  staleSubsetMemberIndices: number[]
  /** Mirror of the group's security generation. */
  securityGeneration: number
}

/** Result of `getPoolGroupPolicyChainRecord`. */
export type GetPoolGroupPolicyChainRecordResult = {
  /** The record. */
  address: string
  /** Its policy. */
  policyAddress: string
  /** The policy id. */
  policyId: number
  /** Its chain. */
  remoteChainSelector: bigint
  /** Classes the policy carries. */
  classes: PoolGroupPolicyClass[]
  /** Classes that follow the policy default. */
  inheritsDefault: PoolGroupPolicyClass[]
  /** Lanes referencing the record. */
  laneRefCount: number
  /** Its sections. */
  sections: PoolGroupSections
  /** Its security generation. */
  securityGeneration: number
}

/** Result of `getPoolGroupPolicy`. */
export type GetPoolGroupPolicyResult = {
  /** The policy. */
  address: string
  /** Its id. */
  policyId: number
  /** Classes it carries. */
  classes: PoolGroupPolicyClass[]
  /** Its default sections. */
  defaultPolicy: PoolGroupSections
  /** Its security generation. */
  securityGeneration: number
  /** Chains with a chain record. */
  remoteChainSelectors: bigint[]
  /** The chain records, with `withChainRecords`. */
  chainRecords?: GetPoolGroupPolicyChainRecordResult[]
}

/** One remote token entry of a pool group member. */
export type PoolGroupMemberRemoteToken = {
  /** Chains of one family. */
  remoteChainSelectors: bigint[]
  /** Remote token, in the first chain's spelling (an EVM token stored padded reads as 20 bytes). */
  token: string
  /** Its decimals. */
  decimals: number
}

/** A decoded `GroupMember` (hand decoder; length checked as `8 + consumed`, `lane_payers` included). */
export type PoolGroupMember = {
  /** The member account. */
  address: string
  /** Its group. */
  poolGroupAddress: string
  /** The mint. */
  tokenAddress: string
  /** Its bit in subset bitmaps. */
  memberIndex: number
  /** Group-driven lanes it has. */
  laneCount: number
  /** Receives the rent on close. */
  rentReceiver: string
  /** The remote tokens its driven lanes use. */
  remoteTokens: PoolGroupMemberRemoteToken[]
  /** Who paid for each driven lane. */
  lanePayers: {
    /** The lane's chain. */
    remoteChainSelector: bigint
    /** Who paid for it (refunded on close). */
    payer: string
  }[]
  /** Encoded size of the remote-token list in instruction data. */
  remoteTokensEncodedBytes: number
}

/** A decoded `GroupRegistry`. */
export type PoolGroupRegistry = {
  /** The registry. */
  address: string
  /** Its group. */
  poolGroupAddress: string
  /** The next member index. */
  nextMemberIndex: number
  /** Current members. */
  memberCount: number
}

/** Lane kind from the `ChainConfig` marker and the `ChainConfigV2` tail. */
export type PoolGroupLaneKind = 'standard' | 'linked' | 'driven'

/** Where a lane takes one class from. */
export type PoolGroupClassSource =
  | {
      /** The lane's own fields. */
      kind: 'inline'
    }
  | {
      /** The group's chain record. */
      kind: 'default'
    }
  | {
      /** A named policy's chain record. */
      kind: 'policy'
      /** The tail's policy slot. */
      slot: 0 | 1 | 2 | 3
      /** The `Policy`. */
      policyAddress: string
      /** Its id. */
      policyId: number
    }

/** Result of `getPoolGroupLane`. */
export type GetPoolGroupLaneResult = PoolGroupLaneKey & {
  /** Lane kind. */
  kind: PoolGroupLaneKind
  /** The group, or `null` when not linked. */
  poolGroupAddress: string | null
  /** Per class; `null` on a standard lane. */
  classSource: Record<PoolGroupPolicyClass, PoolGroupClassSource> | null
  /** Effective outbound pause (group, chain record, lane, driven lanes). */
  pausedOutbound: boolean
  /** Effective inbound pause. */
  pausedInbound: boolean
  /** The effective format the lane sends. */
  poolDataFormat: PoolDataFormat
  /** Factory UID, or `null`. */
  uid: string | null
  /** Driven lanes: the member index. */
  memberIndex?: number
  /** Driven lanes: whether the chain record admits the pool group member now (`observe_lane_group` does not check). */
  admitted?: boolean
  /** The lane's CCV copy; `failsClosedAt` is the pending set's activation when the lane has not synced it. */
  ccvCopy: {
    /** The copy's epoch. */
    epoch: bigint
    /** Whether transfers enforce the same set now. */
    synced: boolean
    /** When a pending set the lane has not copied activates. */
    failsClosedAt?: bigint
  } | null
  /** The remote token, in the remote chain's spelling. */
  remoteToken: string
  /** Its decimals. */
  remoteTokenDecimals: number
  /** The lane's own remote pools. */
  ownRemotePools: string[]
  /**
   * Buckets as of now, from simulating `observe_lane_group`. Absent only on a standard lane, which
   * is not simulated; on a linked or driven lane a refused simulation throws.
   */
  rateLimits?: {
    /** Inbound tokens. */
    inbound: bigint
    /** Outbound tokens. */
    outbound: bigint
    /** Faster-than-finality inbound tokens, with an FTF override. */
    fastFinalityInbound?: bigint
    /** Faster-than-finality outbound tokens, with an FTF override. */
    fastFinalityOutbound?: bigint
  }
}

/** A decoded hook list. */
export type PoolGroupHookList = {
  /** The list. */
  address: string
  /** Its kind. */
  kind: 'allowlist' | 'blocklist'
  /** Its id. */
  listId: string
  /** Its admin. */
  admin: string
  /** Proposed admin. */
  proposedAdmin: string | null
  /** Allowlists: whether the check is on. */
  enabled?: boolean
  /** Entries. */
  entryCount: number
}

/** Params of `getPoolGroupFeatures`. */
export type GetPoolGroupFeaturesParams = PoolGroupProgramRef
/** Params of `getPoolGroup`. */
export type GetPoolGroupParams = PoolGroupRef
/** Params of `getPoolGroupChain`. */
export type GetPoolGroupChainParams = PoolGroupRef & {
  /** The chain. */
  remoteChainSelector: bigint
  /**
   * The mints to join the subset bitmap with, read by their `GroupMember` PDAs. Without it, set
   * bits are joined with every current member through `getProgramAccounts`, which many public RPCs
   * refuse. With it, `subsetTokens` lists those of these mints whose bit is set, and
   * `staleSubsetMemberIndices` is not computed (empty): an index these mints do not cover is not
   * judged.
   */
  tokenAddresses?: string[]
}
/** Params of `getPoolGroupPolicy`. */
export type GetPoolGroupPolicyParams = PoolGroupRef & {
  /** The policy id. */
  policyId: number
  /** Also read its chain records. */
  withChainRecords?: boolean
}
/** Params of `getPoolGroupPolicyChainRecord`. */
export type GetPoolGroupPolicyChainRecordParams = PoolGroupRef & {
  /** The policy id. */
  policyId: number
  /** The chain. */
  remoteChainSelector: bigint
}
/** Params of `getPoolGroupMembers`. */
export type GetPoolGroupMembersParams = PoolGroupRef & {
  /** Read these mints' members instead of listing (no `getProgramAccounts`). */
  tokenAddresses?: string[]
}
/** Result of `getPoolGroupMembers`. */
export type GetPoolGroupMembersResult = {
  /** The registry, or `null` before the first join. */
  registry: PoolGroupRegistry | null
  /** The members. */
  poolGroupMembers: PoolGroupMember[]
}
/** Params of `getPoolGroupLane`. */
export type GetPoolGroupLaneParams = PoolGroupProgramRef & PoolGroupLaneKey
/**
 * Params of `getPoolGroupLanes`. The listing needs `getProgramAccounts` over the program's
 * version-2 `ChainConfigV2` accounts (the group sits after variable-length fields, so it is not a
 * filter); an RPC that refuses it fails the read.
 */
export type GetPoolGroupLanesParams = PoolGroupRef & {
  /** Only this chain. */
  remoteChainSelector?: bigint
  /** Only this kind. */
  kind?: Exclude<PoolGroupLaneKind, 'standard'>
}
/** Params of `getPoolGroupHooks`. */
export type GetPoolGroupHooksParams = PoolGroupProgramRef & {
  /** A `Group`, `Policy`, chain record or policy chain record. */
  record: string
}
/** Result of `getPoolGroupHooks`. */
export type GetPoolGroupHooksResult = {
  /** The record's hook config. */
  hook: PoolGroupHookConfig | null
  /** Its lists. */
  lists: PoolGroupHookList[]
  /** The group's hook authority (signs engine calls). */
  hookAuthority: string
}
/**
 * Params of `getPoolGroupListEntries`. Entries come from `getProgramAccounts` (memcmp on the list
 * at offset 10). Blocklist addresses come from `ListUpdated` events (self-CPI, read through core
 * `getTransaction`): cost is one `getTransaction` per transaction touching the list, back to
 * `fromSlot`, stopping once every entry has an address.
 */
export type GetPoolGroupListEntriesParams = PoolGroupProgramRef & {
  /** The list. */
  list: string
  /** Blocklists: scan `ListUpdated` events back to this slot. */
  fromSlot?: bigint
}
/** Result of `getPoolGroupListEntries`. */
export type GetPoolGroupListEntriesResult = {
  /** The list kind. */
  kind: 'allowlist' | 'blocklist'
  /** Entries; blocklist entries have an address only when an event named it. */
  entries: {
    /** The address: base58 for an allowlist, `0x` hex of the normalized bytes for a blocklist. */
    address?: string
    /** `sha256` of the normalized address (the blocklist entry key), `0x` hex. */
    addressHash: string
  }[]
  /** Blocklist: `false` when some hashes have no address in the scanned events. */
  complete: boolean
}
/** Params of `hasPoolGroupListEntry`. */
export type HasPoolGroupListEntryParams = PoolGroupProgramRef & {
  /** The list. */
  list: string
  /** A Solana sender (allowlist), or an address of any chain (blocklist). */
  address: string
}
/** Params of `getPoolGroupRequiredCCVs`. */
export type GetPoolGroupRequiredCCVsParams = PoolGroupProgramRef &
  PoolGroupLaneKey & {
    /** The amount, in local units (outbound) or remote units (inbound). */
    amount: bigint
    /** Direction. */
    direction: MultiTokenPoolDirection
    /** Requested finality (outbound, inline FEE only). */
    finality?: FinalityRequested
  }
/**
 * Result of `getPoolGroupRequiredCCVs`. With SECURITY from the pool group, the program answers from
 * the lane's synced copy at the cluster clock and ignores amount and finality; on an unsynced lane the
 * copy differs from what transfers enforce (they fail closed). `finality` changes the answer only when
 * both SECURITY and FEE are inline (it picks the BPS tier for the outbound threshold amount; with
 * group FEE the gross amount is compared). The account reads and the simulation may land on
 * different slots, so `synced` and `ccvs` can disagree across an activation.
 */
export type GetPoolGroupRequiredCCVsResult = {
  /** The CCVs; `'default'` for `INCLUDE_DEFAULT_CCVS`. */
  ccvs: string[]
  /** Where the answer came from. */
  source: 'inline' | 'pool-group-copy'
  /** The copy's epoch. */
  epoch?: bigint
  /** Whether the copy matches what transfers enforce. */
  synced?: boolean
  /** When a pending set the lane has not synced activates. */
  failsClosedAt?: bigint
  /**
   * Whether the program considered `finality` (it picks the BPS tier the outbound threshold amount
   * is compared after): an outbound transfer with inline SECURITY and FEE and a given `finality`. The
   * answer may still be the same, for example when both tiers are equal or no threshold is set.
   */
  finalityApplied: boolean
}
/** Params of `checkPoolGroupSnapshot`. */
export type CheckPoolGroupSnapshotParams = PoolGroupRef & {
  /** The snapshot a pool-group op returned with the proposal. */
  snapshot: MultiTokenPoolSnapshot
}
/** Params of `getTokenPoolGlobalConfig`. */
export type GetTokenPoolGlobalConfigParams = PoolGroupProgramRef
/** Result of `getTokenPoolGlobalConfig`: the deployment's defaults. */
export type GetTokenPoolGlobalConfigResult = {
  /** Account version. */
  version: number
  /** Whether mint owners may initialize pools themselves. */
  selfServedAllowed: boolean
  /** Default router. */
  defaultRouter: string
  /** Default RMN remote. */
  defaultRmnRemote: string
}
