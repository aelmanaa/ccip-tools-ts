/**
 * Anchor 0.29 IDL of `base_token_pool 2.1.0` with pool groups (prototype fork, stage 2f): the shared
 * types, events and errors of the pool-groups burn-mint program. Has no instructions.
 *
 * From the pool-groups fork of smartcontractkit/chainlink-ccip-solana@7558722,
 * contracts/target/idl/base_token_pool.json.
 *
 * Converted from the `anchor build` IDL (Anchor spec 0.1.0) to the Anchor 0.29 format, with every
 * event discriminator checked against the IDL's; regenerate rather than edit. Newtypes are inlined
 * as their single field (identical Borsh layout). Event structs are listed only under `events`.
 */
export type BaseTokenPoolGroups = {
  version: '2.1.0'
  name: 'base_token_pool'
  instructions: []
  types: [
    {
      name: 'CCVConfig'
      type: {
        kind: 'struct'
        fields: [
          { name: 'thresholdAmount'; type: 'u64' },
          { name: 'outboundCcvs'; type: { vec: 'publicKey' } },
          { name: 'thresholdOutboundCcvs'; type: { vec: 'publicKey' } },
          { name: 'inboundCcvs'; type: { vec: 'publicKey' } },
          { name: 'thresholdInboundCcvs'; type: { vec: 'publicKey' } },
        ]
      }
    },
    {
      name: 'CcvSet'
      type: {
        kind: 'struct'
        fields: [
          { name: 'outbound'; type: { vec: 'publicKey' } },
          { name: 'inbound'; type: { vec: 'publicKey' } },
          { name: 'epoch'; type: 'u64' },
        ]
      }
    },
    {
      name: 'ConnectionPolicy'
      docs: ['`CONNECTION` class of a policy record.']
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'remotePools'
            docs: [
              "Remote pools every lane on this record trusts, on top of the lane's own list (see",
              '`pool_data::validate_source_pool_data`).',
            ]
            type: { vec: { defined: 'PolicyRemotePool' } }
          },
          { name: 'poolDataFormat'; type: { defined: 'PoolDataFormat' } },
          {
            name: 'allowedFinalityConfig'
            docs: [
              'Allowed finality for outbound transfers, as `ChainConfigV2.allowed_finality_config`.',
            ]
            type: { defined: 'FinalityConfig' }
          },
        ]
      }
    },
    {
      name: 'FeePolicy'
      docs: ['`FEE` class of a policy record (EVM fee and dest-overhead policies).']
      type: {
        kind: 'struct'
        fields: [{ name: 'tokenTransferFeeConfig'; type: { defined: 'TokenTransferFeeConfig' } }]
      }
    },
    {
      name: 'FinalityConfig'
      docs: [
        'Per-message finality configuration. Wire-format: 4 bytes big-endian (flags || block_depth).',
        "Mirrors the `bytes4` Finality type in chainlink-ccv's `protocol/finality.go`.",
        '',
        'Layout (MSB first):',
        'flags[15:1]  — reserved',
        'flags[0]     — S: wait for `safe` head instead of full finality',
        'block_depth  — number of block confirmations required (0 = full finality / safe, per flags)',
      ]
      type: {
        kind: 'struct'
        fields: [{ name: 'flags'; type: 'u16' }, { name: 'blockDepth'; type: 'u16' }]
      }
    },
    {
      name: 'GroupLaneMode'
      docs: [
        "How a group's chain record opens lanes for the group's members (EVM `ConnectionPolicyStore`",
        'connection record with `onlySubsetTokens`).',
      ]
      type: {
        kind: 'enum'
        variants: [{ name: 'Off' }, { name: 'AllMembers' }, { name: 'Subset' }]
      }
    },
    {
      name: 'GroupRoles'
      docs: [
        'Group roles (EVM PoolConfigManager roles). Only the group owner sets them, and the owner can act',
        'in every role. `Pubkey::default()` leaves a role unassigned.',
      ]
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'policyAdmin'
            docs: ['Any class of any chain record, and chain record lifecycle.']
            type: 'publicKey'
          },
          {
            name: 'connectionAdmin'
            docs: ['`CONNECTION` (EVM `CONNECTION` + `REMOTE_POOL`).']
            type: 'publicKey'
          },
          {
            name: 'feeAdmin'
            docs: [
              '`FEE` (EVM `FEE` + `DEST_OVERHEAD`), capped by `Group.max_bps_fee`. The only role that',
              'writes fees: neither the owner nor `policy_admin` can (MultiTokenPool finding F6); the owner',
              'can assign this role, which is evented.',
            ]
            type: 'publicKey'
          },
          {
            name: 'rateLimitAdmin'
            docs: ["`RATE_LIMIT`, and resetting member lanes' buckets."]
            type: 'publicKey'
          },
          { name: 'securityAdmin'; docs: ['`SECURITY` (CCVs, hooks).']; type: 'publicKey' },
          { name: 'pauser'; type: 'publicKey' },
          { name: 'unpauser'; type: 'publicKey' },
        ]
      }
    },
    {
      name: 'HookConfig'
      docs: ['Group hooks (EVM `MultiTokenPoolHooks`, `MultiTokenPoolHooksExternalBlocklist`).']
      type: {
        kind: 'struct'
        fields: [
          { name: 'allowlist'; type: { option: 'publicKey' } },
          { name: 'blocklist'; type: { option: 'publicKey' } },
          { name: 'policyEngine'; type: { option: { defined: 'PolicyEngineConfig' } } },
        ]
      }
    },
    {
      name: 'MemberRemoteToken'
      docs: [
        "A member token's remote token on the chains it lists, from which its group-driven lanes are",
        'created. One entry can cover several chains where the token has the same address and decimals',
        '(for example CREATE2 deployments on EVM chains), but every chain is named by the token owner: a',
        'chain the member does not list gets no group-driven lane (review 2f S2).',
      ]
      type: {
        kind: 'struct'
        fields: [
          { name: 'remoteChainSelectors'; type: { vec: 'u64' } },
          {
            name: 'token'
            docs: ['Exact bytes, in the encoding the remote pool uses for source tokens.']
            type: { defined: 'RemoteAddress' }
          },
          { name: 'decimals'; type: 'u8' },
        ]
      }
    },
    {
      name: 'PendingCcvSet'
      type: {
        kind: 'struct'
        fields: [
          { name: 'outbound'; type: { vec: 'publicKey' } },
          { name: 'inbound'; type: { vec: 'publicKey' } },
          { name: 'epoch'; type: 'u64' },
          {
            name: 'activatesAt'
            docs: ['Unix timestamp from which this set replaces the current one.']
            type: 'i64'
          },
        ]
      }
    },
    {
      name: 'PolicyEngineConfig'
      type: {
        kind: 'struct'
        fields: [
          { name: 'program'; type: 'publicKey' },
          { name: 'staticAccounts'; type: { vec: 'publicKey' } },
          {
            name: 'writableStatics'
            docs: [
              'Bit i: `static_accounts[i]` is passed writable, and must be owned by `program` (the',
              "engine's own state, so stateful policies such as volume limits are possible).",
            ]
            type: 'u8'
          },
          { name: 'onSend'; type: 'bool' },
          { name: 'onReceive'; type: 'bool' },
        ]
      }
    },
    {
      name: 'PolicyRemotePool'
      docs: ['A remote pool a policy record trusts (EVM remote pool policy entry).']
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'address'
            docs: ['Stored as the OffRamp delivers it.']
            type: { defined: 'RemoteAddress' }
          },
          {
            name: 'allowLegacyPoolData'
            docs: [
              "Accept legacy (empty or 32-byte) pool data from this pool, as EVM's per-pool",
              '`allowLegacyPoolDataOnReceive`. Default `false`: legacy data names no source token, so it',
              'cannot tell which token a shared pool burned or locked (MultiTokenPool finding F3).',
              'Ignored for lanes that send the long format or have a UID: they never accept legacy data.',
            ]
            type: 'bool'
          },
        ]
      }
    },
    {
      name: 'PolicySection'
      docs: ["One class's section, as an instruction argument."]
      type: {
        kind: 'enum'
        variants: [
          { name: 'Connection'; fields: [{ defined: 'ConnectionPolicy' }] },
          { name: 'Fee'; fields: [{ defined: 'FeePolicy' }] },
          { name: 'RateLimit'; fields: [{ defined: 'RateLimitPolicy' }] },
          { name: 'Security'; fields: [{ defined: 'SecurityPolicy' }] },
        ]
      }
    },
    { name: 'PoolChainConfigOverrideType'; type: { kind: 'enum'; variants: [{ name: 'FTF' }] } },
    {
      name: 'PoolDataFormat'
      docs: ['The remote pool data a lane emits on send.']
      type: { kind: 'enum'; variants: [{ name: 'Legacy32' }, { name: 'Long' }] }
    },
    {
      name: 'RateLimitConfig'
      type: {
        kind: 'struct'
        fields: [
          { name: 'enabled'; type: 'bool' },
          { name: 'capacity'; type: 'u64' },
          { name: 'rate'; type: 'u64' },
        ]
      }
    },
    {
      name: 'RateLimitPolicy'
      docs: [
        '`RATE_LIMIT` class of a policy record (EVM rate-limit policy). The buckets stay per lane.',
      ]
      type: {
        kind: 'struct'
        fields: [
          { name: 'inbound'; type: { defined: 'RateLimitConfig' } },
          { name: 'outbound'; type: { defined: 'RateLimitConfig' } },
          {
            name: 'ftfInbound'
            docs: ["Faster-than-finality buckets (the lane's FTF `ChainConfigOverride`)."]
            type: { defined: 'RateLimitConfig' }
          },
          { name: 'ftfOutbound'; type: { defined: 'RateLimitConfig' } },
        ]
      }
    },
    {
      name: 'RemoteAddress'
      type: { kind: 'struct'; fields: [{ name: 'address'; type: 'bytes' }] }
    },
    {
      name: 'SecurityPolicy'
      docs: [
        '`SECURITY` class of a policy record: the CCVs its lanes require (EVM security policy), changed',
        "only through a schedule (`schedule_group_ccvs`, or the owner's `activate_group_ccvs_now`), never",
        'through the generic section writers, which accept only the default section. Hooks are reserved.',
      ]
      type: {
        kind: 'struct'
        fields: [
          { name: 'current'; type: { defined: 'CcvSet' } },
          { name: 'pending'; type: { option: { defined: 'PendingCcvSet' } } },
          {
            name: 'reservedCcvMode'
            docs: [
              'Reserved, always 0. Laid out since 2a for a "live" CCV mode (reading the record from the',
              "router's pool extras), which is out of scope: kept as a byte so records already written on",
              'Devnet decode unchanged.',
            ]
            type: 'u8'
          },
          { name: 'allowDroppingDefaultCcvs'; type: 'bool' },
          { name: 'hook'; type: { option: { defined: 'HookConfig' } } },
        ]
      }
    },
    {
      name: 'SubsetBitmapWrite'
      docs: ['A raw overwrite of a subset bitmap from `byte_offset` (bulk changes).']
      type: {
        kind: 'struct'
        fields: [{ name: 'byteOffset'; type: 'u32' }, { name: 'bytes'; type: 'bytes' }]
      }
    },
    {
      name: 'TokenTransferFeeConfig'
      type: {
        kind: 'struct'
        fields: [
          { name: 'destGasOverhead'; type: 'u32' },
          { name: 'destBytesOverhead'; type: 'u32' },
          { name: 'finalityFee'; type: 'u32' },
          { name: 'fastFinalityFee'; type: 'u32' },
          { name: 'finalityBpsFee'; type: 'u16' },
          { name: 'fastFinalityBpsFee'; type: 'u16' },
          { name: 'isEnabled'; type: 'bool' },
        ]
      }
    },
  ]
  events: [
    {
      name: 'Burned'
      fields: [
        { name: 'sender'; type: 'publicKey'; index: false },
        { name: 'amount'; type: 'u64'; index: false },
        { name: 'mint'; type: 'publicKey'; index: false },
      ]
    },
    {
      name: 'ConfigChanged'
      fields: [{ name: 'config'; type: { defined: 'RateLimitConfig' }; index: false }]
    },
    {
      name: 'ConfigV2Updated'
      fields: [
        { name: 'remoteChainSelector'; type: 'u64'; index: false },
        { name: 'mint'; type: 'publicKey'; index: false },
        { name: 'ccv'; type: { defined: 'CCVConfig' }; index: false },
        { name: 'allowedFinality'; type: { defined: 'FinalityConfig' }; index: false },
        { name: 'tokenTransferFee'; type: { defined: 'TokenTransferFeeConfig' }; index: false },
      ]
    },
    {
      name: 'GlobalConfigUpdated'
      fields: [
        { name: 'selfServedAllowed'; type: 'bool'; index: false },
        { name: 'router'; type: 'publicKey'; index: false },
        { name: 'rmnRemote'; type: 'publicKey'; index: false },
      ]
    },
    {
      name: 'GroupCcvsScheduled'
      fields: [
        { name: 'group'; type: 'publicKey'; index: false },
        { name: 'remoteChainSelector'; type: { option: 'u64' }; index: false },
        { name: 'previousOutbound'; type: { vec: 'publicKey' }; index: false },
        { name: 'previousInbound'; type: { vec: 'publicKey' }; index: false },
        { name: 'outbound'; type: { vec: 'publicKey' }; index: false },
        { name: 'inbound'; type: { vec: 'publicKey' }; index: false },
        { name: 'epoch'; type: 'u64'; index: false },
        { name: 'activatesAt'; type: 'i64'; index: false },
        { name: 'emergency'; type: 'bool'; index: false },
        { name: 'defaultsMarkerPresent'; type: 'bool'; index: false },
        {
          name: 'replacedEpoch'
          docs: [
            'The pending set this one replaced before it activated, if any: lanes that synced it switch',
            'to it at `replaced_activates_at` and fail closed until resynced.',
          ]
          type: { option: 'u64' }
          index: false
        },
        { name: 'replacedActivatesAt'; type: { option: 'i64' }; index: false },
        {
          name: 'policy'
          docs: ["The named policy written; `None`: the group's own."]
          type: { option: 'publicKey' }
          index: false
        },
      ]
    },
    {
      name: 'GroupChainAdded'
      fields: [
        { name: 'group'; type: 'publicKey'; index: false },
        { name: 'remoteChainSelector'; type: 'u64'; index: false },
      ]
    },
    {
      name: 'GroupChainLanesSet'
      fields: [
        { name: 'group'; type: 'publicKey'; index: false },
        { name: 'remoteChainSelector'; type: 'u64'; index: false },
        { name: 'previousMode'; type: { defined: 'GroupLaneMode' }; index: false },
        { name: 'mode'; type: { defined: 'GroupLaneMode' }; index: false },
        { name: 'drivenLanesPaused'; type: 'bool'; index: false },
        { name: 'bitmapWrite'; type: { option: { defined: 'SubsetBitmapWrite' } }; index: false },
        { name: 'removed'; type: { vec: 'u32' }; index: false },
        { name: 'added'; type: { vec: 'u32' }; index: false },
      ]
    },
    {
      name: 'GroupChainPauseSet'
      fields: [
        { name: 'group'; type: 'publicKey'; index: false },
        { name: 'remoteChainSelector'; type: 'u64'; index: false },
        { name: 'pausedOutbound'; type: 'bool'; index: false },
        { name: 'pausedInbound'; type: 'bool'; index: false },
      ]
    },
    {
      name: 'GroupChainRemoved'
      fields: [
        { name: 'group'; type: 'publicKey'; index: false },
        { name: 'remoteChainSelector'; type: 'u64'; index: false },
      ]
    },
    {
      name: 'GroupCreated'
      fields: [
        { name: 'group'; type: 'publicKey'; index: false },
        { name: 'groupId'; type: 'publicKey'; index: false },
        { name: 'owner'; type: 'publicKey'; index: false },
        { name: 'maxBpsFee'; type: 'u16'; index: false },
        { name: 'openMembership'; type: 'bool'; index: false },
      ]
    },
    {
      name: 'GroupLaneClosed'
      fields: [
        { name: 'group'; type: 'publicKey'; index: false },
        { name: 'mint'; type: 'publicKey'; index: false },
        { name: 'remoteChainSelector'; type: 'u64'; index: false },
        { name: 'memberIndex'; type: 'u32'; index: false },
        {
          name: 'refundedTo'
          docs: [
            "Received the lane's rent: its payer, or the chain record when the payer cannot be credited",
            "any more (the record's rent returns to the group owner with `remove_group_chain`).",
          ]
          type: 'publicKey'
          index: false
        },
      ]
    },
    {
      name: 'GroupLaneMaterialized'
      fields: [
        { name: 'group'; type: 'publicKey'; index: false },
        { name: 'mint'; type: 'publicKey'; index: false },
        { name: 'remoteChainSelector'; type: 'u64'; index: false },
        { name: 'memberIndex'; type: 'u32'; index: false },
        { name: 'remoteToken'; type: { defined: 'RemoteAddress' }; index: false },
        { name: 'remoteDecimals'; type: 'u8'; index: false },
        { name: 'payer'; type: 'publicKey'; index: false },
      ]
    },
    {
      name: 'GroupMemberJoined'
      fields: [
        { name: 'group'; type: 'publicKey'; index: false },
        { name: 'mint'; type: 'publicKey'; index: false },
        { name: 'memberIndex'; type: 'u32'; index: false },
        { name: 'rentReceiver'; type: 'publicKey'; index: false },
        { name: 'remoteTokens'; type: { vec: { defined: 'MemberRemoteToken' } }; index: false },
      ]
    },
    {
      name: 'GroupMemberLeft'
      fields: [
        { name: 'group'; type: 'publicKey'; index: false },
        { name: 'mint'; type: 'publicKey'; index: false },
        { name: 'memberIndex'; type: 'u32'; index: false },
        { name: 'byTokenOwner'; type: 'bool'; index: false },
      ]
    },
    {
      name: 'GroupMemberRemoteTokensSet'
      fields: [
        { name: 'group'; type: 'publicKey'; index: false },
        { name: 'mint'; type: 'publicKey'; index: false },
        { name: 'rentReceiver'; type: 'publicKey'; index: false },
        { name: 'remoteTokens'; type: { vec: { defined: 'MemberRemoteToken' } }; index: false },
      ]
    },
    {
      name: 'GroupOwnershipTransferRequested'
      fields: [
        { name: 'group'; type: 'publicKey'; index: false },
        { name: 'owner'; type: 'publicKey'; index: false },
        { name: 'proposedOwner'; type: 'publicKey'; index: false },
      ]
    },
    {
      name: 'GroupOwnershipTransferred'
      fields: [
        { name: 'group'; type: 'publicKey'; index: false },
        { name: 'previousOwner'; type: 'publicKey'; index: false },
        { name: 'newOwner'; type: 'publicKey'; index: false },
      ]
    },
    {
      name: 'GroupPauseSet'
      fields: [
        { name: 'group'; type: 'publicKey'; index: false },
        { name: 'paused'; type: 'bool'; index: false },
      ]
    },
    {
      name: 'GroupPolicySectionSet'
      fields: [
        { name: 'group'; type: 'publicKey'; index: false },
        {
          name: 'policy'
          docs: ["The named policy written; `None`: the group's own default or chain record."]
          type: { option: 'publicKey' }
          index: false
        },
        { name: 'remoteChainSelector'; type: { option: 'u64' }; index: false },
        { name: 'inheritsDefault'; type: 'bool'; index: false },
        {
          name: 'section'
          docs: [
            "The section as written (the previous value is the previous event's; review 2d N9).",
          ]
          type: { defined: 'PolicySection' }
          index: false
        },
      ]
    },
    {
      name: 'GroupRolesSet'
      fields: [
        { name: 'group'; type: 'publicKey'; index: false },
        { name: 'previousRoles'; type: { defined: 'GroupRoles' }; index: false },
        { name: 'roles'; type: { defined: 'GroupRoles' }; index: false },
      ]
    },
    {
      name: 'GroupSecurityReset'
      fields: [
        { name: 'group'; type: 'publicKey'; index: false },
        { name: 'remoteChainSelector'; type: { option: 'u64' }; index: false },
        { name: 'clearedAllowDroppingDefaultCcvs'; type: 'bool'; index: false },
        { name: 'cancelledEpoch'; type: { option: 'u64' }; index: false },
        { name: 'cancelledActivatesAt'; type: { option: 'i64' }; index: false },
        {
          name: 'policy'
          docs: ["The named policy reset; `None`: the group's own records."]
          type: { option: 'publicKey' }
          index: false
        },
      ]
    },
    {
      name: 'GroupSecuritySettingsSet'
      fields: [
        { name: 'group'; type: 'publicKey'; index: false },
        { name: 'remoteChainSelector'; type: { option: 'u64' }; index: false },
        { name: 'allowDroppingDefaultCcvs'; type: 'bool'; index: false },
        { name: 'policy'; type: { option: 'publicKey' }; index: false },
      ]
    },
    {
      name: 'GroupSettingsUpdated'
      fields: [
        { name: 'group'; type: 'publicKey'; index: false },
        { name: 'previousMaxBpsFee'; type: 'u16'; index: false },
        { name: 'maxBpsFee'; type: 'u16'; index: false },
        { name: 'openMembership'; type: 'bool'; index: false },
        { name: 'minCcvActivationDelay'; type: { option: 'u64' }; index: false },
        {
          name: 'minCcvActivationDelayFrom'
          docs: [
            'When `min_ccv_activation_delay` applies: now for an increase, after the notice in force for',
            'a decrease.',
          ]
          type: 'i64'
          index: false
        },
        { name: 'hookLookupTable'; type: { option: 'publicKey' }; index: false },
      ]
    },
    {
      name: 'HookConfigSet'
      fields: [
        { name: 'group'; type: 'publicKey'; index: false },
        { name: 'remoteChainSelector'; type: { option: 'u64' }; index: false },
        { name: 'policy'; type: { option: 'publicKey' }; index: false },
        { name: 'previousAllowlist'; type: { option: 'publicKey' }; index: false },
        { name: 'previousBlocklist'; type: { option: 'publicKey' }; index: false },
        { name: 'allowlist'; type: { option: 'publicKey' }; index: false },
        { name: 'blocklist'; type: { option: 'publicKey' }; index: false },
      ]
    },
    {
      name: 'LaneBucketsReset'
      fields: [
        { name: 'group'; type: 'publicKey'; index: false },
        { name: 'mint'; type: 'publicKey'; index: false },
        { name: 'remoteChainSelector'; type: 'u64'; index: false },
      ]
    },
    {
      name: 'LaneCcvsSynced'
      fields: [
        { name: 'group'; type: 'publicKey'; index: false },
        { name: 'mint'; type: 'publicKey'; index: false },
        { name: 'remoteChainSelector'; type: 'u64'; index: false },
        { name: 'epoch'; type: 'u64'; index: false },
        {
          name: 'policy'
          docs: ["The named policy synced from; `None`: the group's own record."]
          type: { option: 'publicKey' }
          index: false
        },
      ]
    },
    {
      name: 'LaneLinked'
      fields: [
        { name: 'group'; type: 'publicKey'; index: false },
        { name: 'mint'; type: 'publicKey'; index: false },
        { name: 'remoteChainSelector'; type: 'u64'; index: false },
        { name: 'classSource'; type: { array: ['u8', 4] }; index: false },
      ]
    },
    {
      name: 'LanePauseSet'
      fields: [
        { name: 'group'; type: 'publicKey'; index: false },
        { name: 'mint'; type: 'publicKey'; index: false },
        { name: 'remoteChainSelector'; type: 'u64'; index: false },
        { name: 'pausedOutbound'; type: 'bool'; index: false },
        { name: 'pausedInbound'; type: 'bool'; index: false },
      ]
    },
    {
      name: 'LanePoliciesAssigned'
      fields: [
        { name: 'group'; type: 'publicKey'; index: false },
        { name: 'mint'; type: 'publicKey'; index: false },
        { name: 'remoteChainSelector'; type: 'u64'; index: false },
        { name: 'classSource'; type: { array: ['u8', 4] }; index: false },
        { name: 'policySlots'; type: { array: ['publicKey', 4] }; index: false },
        { name: 'previousClassSource'; type: { array: ['u8', 4] }; index: false },
        { name: 'previousPolicySlots'; type: { array: ['publicKey', 4] }; index: false },
      ]
    },
    {
      name: 'LanePoolDataSet'
      fields: [
        { name: 'mint'; type: 'publicKey'; index: false },
        { name: 'remoteChainSelector'; type: 'u64'; index: false },
        { name: 'poolDataFormat'; type: { defined: 'PoolDataFormat' }; index: false },
        { name: 'uid'; type: { option: { array: ['u8', 32] } }; index: false },
      ]
    },
    {
      name: 'LaneUnlinked'
      fields: [
        { name: 'group'; type: 'publicKey'; index: false },
        { name: 'mint'; type: 'publicKey'; index: false },
        { name: 'remoteChainSelector'; type: 'u64'; index: false },
      ]
    },
    {
      name: 'LiquidityDeposited'
      fields: [
        { name: 'provider'; type: 'publicKey'; index: false },
        { name: 'amount'; type: 'u64'; index: false },
        { name: 'mint'; type: 'publicKey'; index: false },
      ]
    },
    {
      name: 'LiquidityWithdrawn'
      fields: [
        { name: 'provider'; type: 'publicKey'; index: false },
        { name: 'amount'; type: 'u64'; index: false },
        { name: 'mint'; type: 'publicKey'; index: false },
      ]
    },
    {
      name: 'ListAdminTransferRequested'
      fields: [
        { name: 'list'; type: 'publicKey'; index: false },
        { name: 'admin'; type: 'publicKey'; index: false },
        { name: 'proposedAdmin'; type: 'publicKey'; index: false },
      ]
    },
    {
      name: 'ListAdminTransferred'
      fields: [
        { name: 'list'; type: 'publicKey'; index: false },
        { name: 'previousAdmin'; type: 'publicKey'; index: false },
        { name: 'admin'; type: 'publicKey'; index: false },
      ]
    },
    {
      name: 'ListCreated'
      fields: [
        { name: 'list'; type: 'publicKey'; index: false },
        { name: 'group'; type: { option: 'publicKey' }; index: false },
        { name: 'admin'; type: 'publicKey'; index: false },
        { name: 'enabled'; type: 'bool'; index: false },
      ]
    },
    {
      name: 'ListUpdated'
      fields: [
        { name: 'list'; type: 'publicKey'; index: false },
        { name: 'added'; type: { vec: 'bytes' }; index: false },
        { name: 'removed'; type: { vec: 'bytes' }; index: false },
      ]
    },
    {
      name: 'Locked'
      fields: [
        { name: 'sender'; type: 'publicKey'; index: false },
        { name: 'amount'; type: 'u64'; index: false },
        { name: 'mint'; type: 'publicKey'; index: false },
      ]
    },
    {
      name: 'LockedOrBurned'
      fields: [
        { name: 'mint'; type: 'publicKey'; index: false },
        { name: 'remoteChainSelector'; type: 'u64'; index: false },
        { name: 'sender'; type: 'publicKey'; index: false },
        { name: 'amount'; type: 'u64'; index: false },
      ]
    },
    {
      name: 'MintAuthorityTransferred'
      fields: [
        { name: 'mint'; type: 'publicKey'; index: false },
        { name: 'oldMintAuthority'; type: 'publicKey'; index: false },
        { name: 'newMintAuthority'; type: 'publicKey'; index: false },
      ]
    },
    {
      name: 'Minted'
      fields: [
        { name: 'sender'; type: 'publicKey'; index: false },
        { name: 'recipient'; type: 'publicKey'; index: false },
        { name: 'amount'; type: 'u64'; index: false },
        { name: 'mint'; type: 'publicKey'; index: false },
      ]
    },
    {
      name: 'OverrideChainConfigConfigured'
      fields: [
        { name: 'chainSelector'; type: 'u64'; index: false },
        { name: 'mint'; type: 'publicKey'; index: false },
        { name: 'overrideType'; type: { defined: 'PoolChainConfigOverrideType' }; index: false },
        { name: 'outboundRateLimit'; type: { defined: 'RateLimitConfig' }; index: false },
        { name: 'inboundRateLimit'; type: { defined: 'RateLimitConfig' }; index: false },
      ]
    },
    {
      name: 'OverrideChainConfigRemoved'
      fields: [
        { name: 'chainSelector'; type: 'u64'; index: false },
        { name: 'overrideType'; type: { defined: 'PoolChainConfigOverrideType' }; index: false },
        { name: 'mint'; type: 'publicKey'; index: false },
      ]
    },
    {
      name: 'OwnershipTransferRequested'
      fields: [
        { name: 'from'; type: 'publicKey'; index: false },
        { name: 'to'; type: 'publicKey'; index: false },
        { name: 'mint'; type: 'publicKey'; index: false },
      ]
    },
    {
      name: 'OwnershipTransferred'
      fields: [
        { name: 'from'; type: 'publicKey'; index: false },
        { name: 'to'; type: 'publicKey'; index: false },
        { name: 'mint'; type: 'publicKey'; index: false },
      ]
    },
    {
      name: 'PolicyChainRecordAdded'
      fields: [
        { name: 'group'; type: 'publicKey'; index: false },
        { name: 'policy'; type: 'publicKey'; index: false },
        { name: 'remoteChainSelector'; type: 'u64'; index: false },
      ]
    },
    {
      name: 'PolicyChainRecordRemoved'
      fields: [
        { name: 'group'; type: 'publicKey'; index: false },
        { name: 'policy'; type: 'publicKey'; index: false },
        { name: 'remoteChainSelector'; type: 'u64'; index: false },
      ]
    },
    {
      name: 'PolicyClosed'
      fields: [
        { name: 'group'; type: 'publicKey'; index: false },
        { name: 'policy'; type: 'publicKey'; index: false },
      ]
    },
    {
      name: 'PolicyCreated'
      fields: [
        { name: 'group'; type: 'publicKey'; index: false },
        { name: 'policy'; type: 'publicKey'; index: false },
        { name: 'policyId'; type: 'u32'; index: false },
        { name: 'classes'; type: 'u16'; index: false },
      ]
    },
    {
      name: 'PolicyEngineSet'
      fields: [
        { name: 'group'; type: 'publicKey'; index: false },
        { name: 'remoteChainSelector'; type: { option: 'u64' }; index: false },
        { name: 'policy'; type: { option: 'publicKey' }; index: false },
        { name: 'previous'; type: { option: { defined: 'PolicyEngineConfig' } }; index: false },
        { name: 'engine'; type: { option: { defined: 'PolicyEngineConfig' } }; index: false },
        { name: 'skipDetach'; type: 'bool'; index: false },
      ]
    },
    {
      name: 'RateLimitAdminSet'
      fields: [
        { name: 'mint'; type: 'publicKey'; index: false },
        { name: 'oldRateLimitAdmin'; type: 'publicKey'; index: false },
        { name: 'newRateLimitAdmin'; type: 'publicKey'; index: false },
      ]
    },
    {
      name: 'RateLimitConfigured'
      fields: [
        { name: 'chainSelector'; type: 'u64'; index: false },
        { name: 'outboundRateLimit'; type: { defined: 'RateLimitConfig' }; index: false },
        { name: 'inboundRateLimit'; type: { defined: 'RateLimitConfig' }; index: false },
        { name: 'mint'; type: 'publicKey'; index: false },
      ]
    },
    {
      name: 'RebalancerSet'
      fields: [
        { name: 'mint'; type: 'publicKey'; index: false },
        { name: 'oldRebalancer'; type: 'publicKey'; index: false },
        { name: 'newRebalancer'; type: 'publicKey'; index: false },
      ]
    },
    {
      name: 'Released'
      fields: [
        { name: 'sender'; type: 'publicKey'; index: false },
        { name: 'recipient'; type: 'publicKey'; index: false },
        { name: 'amount'; type: 'u64'; index: false },
        { name: 'mint'; type: 'publicKey'; index: false },
      ]
    },
    {
      name: 'ReleasedOrMinted'
      fields: [
        { name: 'mint'; type: 'publicKey'; index: false },
        { name: 'remoteChainSelector'; type: 'u64'; index: false },
        { name: 'sender'; type: 'publicKey'; index: false },
        { name: 'recipient'; type: 'publicKey'; index: false },
        { name: 'userTokenAccount'; type: 'publicKey'; index: false },
        { name: 'amount'; type: 'u64'; index: false },
      ]
    },
    {
      name: 'RemoteChainConfigured'
      fields: [
        { name: 'chainSelector'; type: 'u64'; index: false },
        { name: 'token'; type: { defined: 'RemoteAddress' }; index: false },
        { name: 'previousToken'; type: { defined: 'RemoteAddress' }; index: false },
        { name: 'poolAddresses'; type: { vec: { defined: 'RemoteAddress' } }; index: false },
        {
          name: 'previousPoolAddresses'
          type: { vec: { defined: 'RemoteAddress' } }
          index: false
        },
        { name: 'mint'; type: 'publicKey'; index: false },
      ]
    },
    {
      name: 'RemoteChainRemoved'
      fields: [
        { name: 'chainSelector'; type: 'u64'; index: false },
        { name: 'mint'; type: 'publicKey'; index: false },
      ]
    },
    {
      name: 'RemotePoolsAppended'
      fields: [
        { name: 'chainSelector'; type: 'u64'; index: false },
        { name: 'poolAddresses'; type: { vec: { defined: 'RemoteAddress' } }; index: false },
        {
          name: 'previousPoolAddresses'
          type: { vec: { defined: 'RemoteAddress' } }
          index: false
        },
        { name: 'mint'; type: 'publicKey'; index: false },
      ]
    },
    {
      name: 'RmnRemoteUpdated'
      fields: [
        { name: 'oldRmnRemote'; type: 'publicKey'; index: false },
        { name: 'newRmnRemote'; type: 'publicKey'; index: false },
        { name: 'mint'; type: 'publicKey'; index: false },
      ]
    },
    {
      name: 'RouterUpdated'
      fields: [
        { name: 'oldRouter'; type: 'publicKey'; index: false },
        { name: 'newRouter'; type: 'publicKey'; index: false },
        { name: 'mint'; type: 'publicKey'; index: false },
      ]
    },
    {
      name: 'TokenPoolInitialized'
      fields: [
        { name: 'mint'; type: 'publicKey'; index: false },
        { name: 'tokenProgram'; type: 'publicKey'; index: false },
        { name: 'owner'; type: 'publicKey'; index: false },
      ]
    },
    {
      name: 'TokenTransferFeeConfigRemoved'
      fields: [
        { name: 'chainSelector'; type: 'u64'; index: false },
        { name: 'mint'; type: 'publicKey'; index: false },
      ]
    },
    {
      name: 'TokenTransferFeeConfigUpdated'
      fields: [
        { name: 'chainSelector'; type: 'u64'; index: false },
        { name: 'mint'; type: 'publicKey'; index: false },
        { name: 'config'; type: { defined: 'TokenTransferFeeConfig' }; index: false },
      ]
    },
    { name: 'TokensConsumed'; fields: [{ name: 'tokens'; type: 'u64'; index: false }] },
  ]
  errors: [
    {
      code: 6000
      name: 'InvalidInitPoolPermissions'
      msg: 'Pool authority does not match token mint owner'
    },
    { code: 6001; name: 'InvalidRMNRemoteAddress'; msg: 'Invalid RMN Remote Address' },
    { code: 6002; name: 'Unauthorized'; msg: 'Unauthorized' },
    { code: 6003; name: 'InvalidInputs'; msg: 'Invalid inputs' },
    { code: 6004; name: 'InvalidVersion'; msg: 'Invalid state version' },
    { code: 6005; name: 'InvalidPoolCaller'; msg: 'Caller is not ramp on router' },
    { code: 6006; name: 'InvalidSender'; msg: 'Sender not allowed' },
    { code: 6007; name: 'InvalidSourcePoolAddress'; msg: 'Invalid source pool address' },
    { code: 6008; name: 'InvalidToken'; msg: 'Invalid token' },
    { code: 6009; name: 'InvalidTokenAmountConversion'; msg: 'Invalid token amount conversion' },
    { code: 6010; name: 'AllowlistKeyAlreadyExisted'; msg: 'Key already existed in the allowlist' },
    { code: 6011; name: 'AllowlistKeyDidNotExist'; msg: 'Key did not exist in the allowlist' },
    {
      code: 6012
      name: 'RemotePoolAddressAlreadyExisted'
      msg: 'Remote pool address already exists'
    },
    {
      code: 6013
      name: 'NonemptyPoolAddressesInit'
      msg: 'Expected empty pool addresses during initialization'
    },
    { code: 6014; name: 'InvalidDerivationStage'; msg: 'Unexpected account derivation stage' },
    { code: 6015; name: 'RLBucketOverfilled'; msg: 'RateLimit: bucket overfilled' },
    { code: 6016; name: 'RLMaxCapacityExceeded'; msg: 'RateLimit: max capacity exceeded' },
    { code: 6017; name: 'RLRateLimitReached'; msg: 'RateLimit: rate limit reached' },
    { code: 6018; name: 'RLInvalidRateLimitRate'; msg: 'RateLimit: invalid rate limit rate' },
    {
      code: 6019
      name: 'RLDisabledNonZeroRateLimit'
      msg: 'RateLimit: disabled non-zero rate limit'
    },
    { code: 6020; name: 'LiquidityNotAccepted'; msg: 'Liquidity not accepted' },
    {
      code: 6021
      name: 'TransferZeroTokensNotAllowed'
      msg: 'Transferring zero tokens is not allowed'
    },
    { code: 6022; name: 'InsufficientPoolBalance'; msg: 'Insufficient pool balance' },
    { code: 6023; name: 'DuplicateCCVNotAllowed'; msg: 'Invalid duplicated ccvs' },
    {
      code: 6024
      name: 'MustSpecifyUnderThresholdCCVsForThresholdCCVs'
      msg: 'Invalid Threshold CCVs config'
    },
    {
      code: 6025
      name: 'InboundOutboundDirectionOnly'
      msg: 'Invalid Direction for Get Required CCVs'
    },
    {
      code: 6026
      name: 'CcvZeroAddressNotAllowed'
      msg: 'CCV address cannot be the zero/default pubkey'
    },
    {
      code: 6027
      name: 'ThresholdAmountRequiredForThresholdCcvs'
      msg: 'Threshold amount must be non-zero when threshold CCVs are configured'
    },
    {
      code: 6028
      name: 'InvalidRequestedFinality'
      msg: "Requested finality is not allowed by the pool's configured allowed finality"
    },
    { code: 6029; name: 'ZeroTokenAddress'; msg: 'Remote token address cannot be zero/empty' },
    {
      code: 6030
      name: 'InvalidTokenTransferFeeBps'
      msg: 'Token transfer fee bps must not exceed 10000 (100%)'
    },
    {
      code: 6031
      name: 'InvalidTokenTransferFeeDestBytesOverhead'
      msg: 'Token transfer fee destination bytes overhead is below the required minimum'
    },
    { code: 6032; name: 'RLArithmeticError'; msg: 'RateLimit: arithmetic error' },
    { code: 6033; name: 'NoFeesToWithdraw'; msg: 'No fees available to withdraw (vault empty)' },
    {
      code: 6034
      name: 'InvalidFeeWithdrawAmount'
      msg: 'Invalid requested amount of fees to withdraw'
    },
    {
      code: 6035
      name: 'InsufficientFeesToWithdraw'
      msg: 'Not enough stored fees to withdraw the requested amount'
    },
    { code: 6036; name: 'InvalidSourcePoolData'; msg: 'Encoded source pool data is invalid' },
    {
      code: 6037
      name: 'ConfigAndRemotePoolDisagreeOnDecimals'
      msg: 'Remote chain config and remote pool show different decimals for token'
    },
    {
      code: 6038
      name: 'MissingFeeVaultTokenAccount'
      msg: "The fee vault token account for the pool's own mint does not exist"
    },
    { code: 6039; name: 'DuplicatedKeys'; msg: 'A key appears more than once' },
    { code: 6040; name: 'InvalidClassSource'; msg: 'A lane class source is not a valid source' },
    {
      code: 6041
      name: 'GroupChainPolicyMissing'
      msg: 'The lane is linked to a group but its group chain policy record was not passed'
    },
    {
      code: 6042
      name: 'PolicyRecordMissing'
      msg: "A policy record the lane's class sources name was not passed"
    },
    {
      code: 6043
      name: 'SecurityPolicyNotSupported'
      msg: 'This version keeps the SECURITY class inline and its group section empty'
    },
    {
      code: 6044
      name: 'LongPoolDataNotSupported'
      msg: 'The long pool data format is not supported by this version'
    },
    {
      code: 6045
      name: 'LegacyPoolDataFromPolicyPool'
      msg: "Legacy pool data is accepted only from the lane's own remote pools"
    },
    { code: 6046; name: 'GroupPaused'; msg: 'Transfers are paused for the whole group' },
    {
      code: 6047
      name: 'GroupChainPaused'
      msg: 'Transfers are paused for this chain in the group'
    },
    { code: 6048; name: 'LanePaused'; msg: 'Transfers are paused for this lane' },
    { code: 6049; name: 'LaneAlreadyLinked'; msg: 'The lane is already linked to a group' },
    { code: 6050; name: 'LaneNotLinkedToGroup'; msg: 'The lane is not linked to this group' },
    { code: 6051; name: 'LaneLinkMismatch'; msg: "The lane's link records disagree" },
    { code: 6052; name: 'LaneLinked'; msg: 'The lane is linked to a group; unlink it first' },
    { code: 6053; name: 'LaneConfigV2Missing'; msg: "The lane's v2 chain config was not passed" },
    {
      code: 6054
      name: 'GroupOwnerSignatureRequired'
      msg: "Joining this group needs the group owner's signature"
    },
    {
      code: 6055
      name: 'GroupChainAlreadyExists'
      msg: 'The group already has a record for this chain'
    },
    { code: 6056; name: 'UnknownGroupChain'; msg: 'The group has no record for this chain' },
    { code: 6057; name: 'TooManyGroupChains'; msg: 'The group has the maximum number of chains' },
    {
      code: 6058
      name: 'IncompleteGroupChainSet'
      msg: 'Every chain record of the group must be passed exactly once'
    },
    { code: 6059; name: 'GroupChainHasMembers'; msg: 'Lanes still use this group chain record' },
    { code: 6060; name: 'BpsFeeAboveGroupMax'; msg: "The BPS fee exceeds the group's maximum" },
    {
      code: 6061
      name: 'MaxBpsFeeCanOnlyDecrease'
      msg: "The group's maximum BPS fee can only be lowered"
    },
    {
      code: 6062
      name: 'TooManyPolicyRemotePools'
      msg: 'Too many remote pools in a connection policy'
    },
    {
      code: 6063
      name: 'RateLimitNotFromGroup'
      msg: "The lane's rate limit does not come from the group"
    },
    {
      code: 6064
      name: 'TokenNotOnPoolInterfaceV2'
      msg: "Token groups need the token's registry to declare pool interface 2"
    },
    {
      code: 6065
      name: 'SourceTokenMismatch'
      msg: "The source token in the pool data is not the lane's remote token"
    },
    {
      code: 6066
      name: 'InvalidAdditionalPoolData'
      msg: "The additional pool data does not match the lane's token UID"
    },
    {
      code: 6067
      name: 'LongPoolDataNeedsDestBytesOverhead'
      msg: 'Long pool data needs a pool fee config whose destination bytes overhead covers it'
    },
    {
      code: 6068
      name: 'LegacyPoolDataNotAllowed'
      msg: 'This lane sends the long pool data format or has a UID: legacy pool data is not accepted'
    },
    {
      code: 6069
      name: 'RateLimitFromGroup'
      msg: "The lane's rate limits come from its group; change them through the group"
    },
    {
      code: 6070
      name: 'UidRequiresLongPoolData'
      msg: 'A lane with a factory UID must use the long pool data format'
    },
    {
      code: 6071
      name: 'DefaultCcvsRequired'
      msg: 'A group CCV list must include the lane defaults (INCLUDE_DEFAULT_CCVS) unless the owner allowed dropping them'
    },
    { code: 6072; name: 'TooManyPolicyCcvs'; msg: 'Too many CCVs in a group CCV list' },
    {
      code: 6073
      name: 'CcvActivationTooSoon'
      msg: "A scheduled CCV change must activate at least the group's minimum delay from now"
    },
    {
      code: 6074
      name: 'GroupCcvsNotSynced'
      msg: "The lane's copy of its group CCVs is not in step with the group: run sync_group_ccvs"
    },
    {
      code: 6075
      name: 'CcvsFromGroup'
      msg: "The lane's CCVs come from its group; change them through the group"
    },
    {
      code: 6076
      name: 'SecurityInheritsDefault'
      msg: 'This chain record follows the group default for SECURITY: change the default, or detach the record with a targeted schedule first'
    },
    {
      code: 6077
      name: 'PolicyClassNotCarried'
      msg: 'The named policy does not carry this class'
    },
    {
      code: 6078
      name: 'PolicyInUse'
      msg: 'Lanes still reference this policy chain record (PolicyInUse)'
    },
    {
      code: 6079
      name: 'PolicyHasRecords'
      msg: 'The policy still has chain records (PolicyHasRecords)'
    },
    {
      code: 6080
      name: 'LaneUsesNamedPolicy'
      msg: 'The lane uses a named policy: unassign it before unlinking'
    },
    { code: 6081; name: 'TooManyPolicyChains'; msg: 'Too many chain records for this policy' },
    {
      code: 6082
      name: 'PolicySecurityStale'
      msg: "This named policy's SECURITY predates the group's last ownership change: the owner must reset it"
    },
    { code: 6083; name: 'AllowlistDisabled'; msg: 'A hook allowlist must be enabled' },
    { code: 6084; name: 'TooManyEngineAccounts'; msg: 'Too many policy engine static accounts' },
    { code: 6085; name: 'HookAccountMissing'; msg: 'An account a hook needs was not passed' },
    { code: 6086; name: 'SenderNotAllowed'; msg: "The sender is not on the group's allowlist" },
    { code: 6087; name: 'LocalAddressBlocked'; msg: 'The local address is blocked' },
    { code: 6088; name: 'RemoteAddressBlocked'; msg: 'The remote address is blocked' },
    { code: 6089; name: 'EngineProgramNotAllowed'; msg: 'This program cannot be a policy engine' },
    {
      code: 6090
      name: 'InvalidHookLookupTable'
      msg: 'The hook lookup table must be an active address lookup table'
    },
    {
      code: 6091
      name: 'GroupLaneNotEnabled'
      msg: "The group does not enable this member's lane to this chain"
    },
    {
      code: 6092
      name: 'GroupLaneStillEnabled'
      msg: 'The group still enables this lane: only its token owner can close it'
    },
    {
      code: 6093
      name: 'LaneGroupDriven'
      msg: 'The lane is group-driven: close it with close_group_lanes'
    },
    {
      code: 6094
      name: 'NotGroupDrivenLane'
      msg: 'The lane is not a group-driven lane of this member, group and chain'
    },
    {
      code: 6095
      name: 'MemberRemoteTokenMissing'
      msg: 'The member has no remote token for this chain'
    },
    { code: 6096; name: 'InvalidMemberRemoteTokens'; msg: 'Invalid member remote tokens' },
    { code: 6097; name: 'InvalidGroupMember'; msg: 'Invalid group member' },
    { code: 6098; name: 'GroupMemberHasLanes'; msg: 'The member still has group-driven lanes' },
    { code: 6099; name: 'InvalidMemberIndex'; msg: 'The member index is not an existing member' },
    {
      code: 6100
      name: 'GroupChainHasNoRemotePools'
      msg: 'Group-driven lanes need the chain record to trust a remote pool'
    },
    {
      code: 6101
      name: 'GroupLanesPaused'
      msg: "The group's driven lanes on this chain are paused"
    },
    {
      code: 6102
      name: 'GroupLanesMustStartPaused'
      msg: "A chain's group-driven lanes must be enabled paused"
    },
    {
      code: 6103
      name: 'InvalidRentReceiver'
      msg: 'A rent receiver must be a writable, non-executable system account'
    },
  ]
}

export const IDL: BaseTokenPoolGroups = {
  version: '2.1.0',
  name: 'base_token_pool',
  instructions: [],
  types: [
    {
      name: 'CCVConfig',
      type: {
        kind: 'struct',
        fields: [
          { name: 'thresholdAmount', type: 'u64' },
          { name: 'outboundCcvs', type: { vec: 'publicKey' } },
          { name: 'thresholdOutboundCcvs', type: { vec: 'publicKey' } },
          { name: 'inboundCcvs', type: { vec: 'publicKey' } },
          { name: 'thresholdInboundCcvs', type: { vec: 'publicKey' } },
        ],
      },
    },
    {
      name: 'CcvSet',
      type: {
        kind: 'struct',
        fields: [
          { name: 'outbound', type: { vec: 'publicKey' } },
          { name: 'inbound', type: { vec: 'publicKey' } },
          { name: 'epoch', type: 'u64' },
        ],
      },
    },
    {
      name: 'ConnectionPolicy',
      docs: ['`CONNECTION` class of a policy record.'],
      type: {
        kind: 'struct',
        fields: [
          {
            name: 'remotePools',
            docs: [
              "Remote pools every lane on this record trusts, on top of the lane's own list (see",
              '`pool_data::validate_source_pool_data`).',
            ],
            type: { vec: { defined: 'PolicyRemotePool' } },
          },
          { name: 'poolDataFormat', type: { defined: 'PoolDataFormat' } },
          {
            name: 'allowedFinalityConfig',
            docs: [
              'Allowed finality for outbound transfers, as `ChainConfigV2.allowed_finality_config`.',
            ],
            type: { defined: 'FinalityConfig' },
          },
        ],
      },
    },
    {
      name: 'FeePolicy',
      docs: ['`FEE` class of a policy record (EVM fee and dest-overhead policies).'],
      type: {
        kind: 'struct',
        fields: [{ name: 'tokenTransferFeeConfig', type: { defined: 'TokenTransferFeeConfig' } }],
      },
    },
    {
      name: 'FinalityConfig',
      docs: [
        'Per-message finality configuration. Wire-format: 4 bytes big-endian (flags || block_depth).',
        "Mirrors the `bytes4` Finality type in chainlink-ccv's `protocol/finality.go`.",
        '',
        'Layout (MSB first):',
        'flags[15:1]  — reserved',
        'flags[0]     — S: wait for `safe` head instead of full finality',
        'block_depth  — number of block confirmations required (0 = full finality / safe, per flags)',
      ],
      type: {
        kind: 'struct',
        fields: [
          { name: 'flags', type: 'u16' },
          { name: 'blockDepth', type: 'u16' },
        ],
      },
    },
    {
      name: 'GroupLaneMode',
      docs: [
        "How a group's chain record opens lanes for the group's members (EVM `ConnectionPolicyStore`",
        'connection record with `onlySubsetTokens`).',
      ],
      type: {
        kind: 'enum',
        variants: [{ name: 'Off' }, { name: 'AllMembers' }, { name: 'Subset' }],
      },
    },
    {
      name: 'GroupRoles',
      docs: [
        'Group roles (EVM PoolConfigManager roles). Only the group owner sets them, and the owner can act',
        'in every role. `Pubkey::default()` leaves a role unassigned.',
      ],
      type: {
        kind: 'struct',
        fields: [
          {
            name: 'policyAdmin',
            docs: ['Any class of any chain record, and chain record lifecycle.'],
            type: 'publicKey',
          },
          {
            name: 'connectionAdmin',
            docs: ['`CONNECTION` (EVM `CONNECTION` + `REMOTE_POOL`).'],
            type: 'publicKey',
          },
          {
            name: 'feeAdmin',
            docs: [
              '`FEE` (EVM `FEE` + `DEST_OVERHEAD`), capped by `Group.max_bps_fee`. The only role that',
              'writes fees: neither the owner nor `policy_admin` can (MultiTokenPool finding F6); the owner',
              'can assign this role, which is evented.',
            ],
            type: 'publicKey',
          },
          {
            name: 'rateLimitAdmin',
            docs: ["`RATE_LIMIT`, and resetting member lanes' buckets."],
            type: 'publicKey',
          },
          { name: 'securityAdmin', docs: ['`SECURITY` (CCVs, hooks).'], type: 'publicKey' },
          { name: 'pauser', type: 'publicKey' },
          { name: 'unpauser', type: 'publicKey' },
        ],
      },
    },
    {
      name: 'HookConfig',
      docs: ['Group hooks (EVM `MultiTokenPoolHooks`, `MultiTokenPoolHooksExternalBlocklist`).'],
      type: {
        kind: 'struct',
        fields: [
          { name: 'allowlist', type: { option: 'publicKey' } },
          { name: 'blocklist', type: { option: 'publicKey' } },
          { name: 'policyEngine', type: { option: { defined: 'PolicyEngineConfig' } } },
        ],
      },
    },
    {
      name: 'MemberRemoteToken',
      docs: [
        "A member token's remote token on the chains it lists, from which its group-driven lanes are",
        'created. One entry can cover several chains where the token has the same address and decimals',
        '(for example CREATE2 deployments on EVM chains), but every chain is named by the token owner: a',
        'chain the member does not list gets no group-driven lane (review 2f S2).',
      ],
      type: {
        kind: 'struct',
        fields: [
          { name: 'remoteChainSelectors', type: { vec: 'u64' } },
          {
            name: 'token',
            docs: ['Exact bytes, in the encoding the remote pool uses for source tokens.'],
            type: { defined: 'RemoteAddress' },
          },
          { name: 'decimals', type: 'u8' },
        ],
      },
    },
    {
      name: 'PendingCcvSet',
      type: {
        kind: 'struct',
        fields: [
          { name: 'outbound', type: { vec: 'publicKey' } },
          { name: 'inbound', type: { vec: 'publicKey' } },
          { name: 'epoch', type: 'u64' },
          {
            name: 'activatesAt',
            docs: ['Unix timestamp from which this set replaces the current one.'],
            type: 'i64',
          },
        ],
      },
    },
    {
      name: 'PolicyEngineConfig',
      type: {
        kind: 'struct',
        fields: [
          { name: 'program', type: 'publicKey' },
          { name: 'staticAccounts', type: { vec: 'publicKey' } },
          {
            name: 'writableStatics',
            docs: [
              'Bit i: `static_accounts[i]` is passed writable, and must be owned by `program` (the',
              "engine's own state, so stateful policies such as volume limits are possible).",
            ],
            type: 'u8',
          },
          { name: 'onSend', type: 'bool' },
          { name: 'onReceive', type: 'bool' },
        ],
      },
    },
    {
      name: 'PolicyRemotePool',
      docs: ['A remote pool a policy record trusts (EVM remote pool policy entry).'],
      type: {
        kind: 'struct',
        fields: [
          {
            name: 'address',
            docs: ['Stored as the OffRamp delivers it.'],
            type: { defined: 'RemoteAddress' },
          },
          {
            name: 'allowLegacyPoolData',
            docs: [
              "Accept legacy (empty or 32-byte) pool data from this pool, as EVM's per-pool",
              '`allowLegacyPoolDataOnReceive`. Default `false`: legacy data names no source token, so it',
              'cannot tell which token a shared pool burned or locked (MultiTokenPool finding F3).',
              'Ignored for lanes that send the long format or have a UID: they never accept legacy data.',
            ],
            type: 'bool',
          },
        ],
      },
    },
    {
      name: 'PolicySection',
      docs: ["One class's section, as an instruction argument."],
      type: {
        kind: 'enum',
        variants: [
          { name: 'Connection', fields: [{ defined: 'ConnectionPolicy' }] },
          { name: 'Fee', fields: [{ defined: 'FeePolicy' }] },
          { name: 'RateLimit', fields: [{ defined: 'RateLimitPolicy' }] },
          { name: 'Security', fields: [{ defined: 'SecurityPolicy' }] },
        ],
      },
    },
    { name: 'PoolChainConfigOverrideType', type: { kind: 'enum', variants: [{ name: 'FTF' }] } },
    {
      name: 'PoolDataFormat',
      docs: ['The remote pool data a lane emits on send.'],
      type: { kind: 'enum', variants: [{ name: 'Legacy32' }, { name: 'Long' }] },
    },
    {
      name: 'RateLimitConfig',
      type: {
        kind: 'struct',
        fields: [
          { name: 'enabled', type: 'bool' },
          { name: 'capacity', type: 'u64' },
          { name: 'rate', type: 'u64' },
        ],
      },
    },
    {
      name: 'RateLimitPolicy',
      docs: [
        '`RATE_LIMIT` class of a policy record (EVM rate-limit policy). The buckets stay per lane.',
      ],
      type: {
        kind: 'struct',
        fields: [
          { name: 'inbound', type: { defined: 'RateLimitConfig' } },
          { name: 'outbound', type: { defined: 'RateLimitConfig' } },
          {
            name: 'ftfInbound',
            docs: ["Faster-than-finality buckets (the lane's FTF `ChainConfigOverride`)."],
            type: { defined: 'RateLimitConfig' },
          },
          { name: 'ftfOutbound', type: { defined: 'RateLimitConfig' } },
        ],
      },
    },
    {
      name: 'RemoteAddress',
      type: { kind: 'struct', fields: [{ name: 'address', type: 'bytes' }] },
    },
    {
      name: 'SecurityPolicy',
      docs: [
        '`SECURITY` class of a policy record: the CCVs its lanes require (EVM security policy), changed',
        "only through a schedule (`schedule_group_ccvs`, or the owner's `activate_group_ccvs_now`), never",
        'through the generic section writers, which accept only the default section. Hooks are reserved.',
      ],
      type: {
        kind: 'struct',
        fields: [
          { name: 'current', type: { defined: 'CcvSet' } },
          { name: 'pending', type: { option: { defined: 'PendingCcvSet' } } },
          {
            name: 'reservedCcvMode',
            docs: [
              'Reserved, always 0. Laid out since 2a for a "live" CCV mode (reading the record from the',
              "router's pool extras), which is out of scope: kept as a byte so records already written on",
              'Devnet decode unchanged.',
            ],
            type: 'u8',
          },
          { name: 'allowDroppingDefaultCcvs', type: 'bool' },
          { name: 'hook', type: { option: { defined: 'HookConfig' } } },
        ],
      },
    },
    {
      name: 'SubsetBitmapWrite',
      docs: ['A raw overwrite of a subset bitmap from `byte_offset` (bulk changes).'],
      type: {
        kind: 'struct',
        fields: [
          { name: 'byteOffset', type: 'u32' },
          { name: 'bytes', type: 'bytes' },
        ],
      },
    },
    {
      name: 'TokenTransferFeeConfig',
      type: {
        kind: 'struct',
        fields: [
          { name: 'destGasOverhead', type: 'u32' },
          { name: 'destBytesOverhead', type: 'u32' },
          { name: 'finalityFee', type: 'u32' },
          { name: 'fastFinalityFee', type: 'u32' },
          { name: 'finalityBpsFee', type: 'u16' },
          { name: 'fastFinalityBpsFee', type: 'u16' },
          { name: 'isEnabled', type: 'bool' },
        ],
      },
    },
  ],
  events: [
    {
      name: 'Burned',
      fields: [
        { name: 'sender', type: 'publicKey', index: false },
        { name: 'amount', type: 'u64', index: false },
        { name: 'mint', type: 'publicKey', index: false },
      ],
    },
    {
      name: 'ConfigChanged',
      fields: [{ name: 'config', type: { defined: 'RateLimitConfig' }, index: false }],
    },
    {
      name: 'ConfigV2Updated',
      fields: [
        { name: 'remoteChainSelector', type: 'u64', index: false },
        { name: 'mint', type: 'publicKey', index: false },
        { name: 'ccv', type: { defined: 'CCVConfig' }, index: false },
        { name: 'allowedFinality', type: { defined: 'FinalityConfig' }, index: false },
        { name: 'tokenTransferFee', type: { defined: 'TokenTransferFeeConfig' }, index: false },
      ],
    },
    {
      name: 'GlobalConfigUpdated',
      fields: [
        { name: 'selfServedAllowed', type: 'bool', index: false },
        { name: 'router', type: 'publicKey', index: false },
        { name: 'rmnRemote', type: 'publicKey', index: false },
      ],
    },
    {
      name: 'GroupCcvsScheduled',
      fields: [
        { name: 'group', type: 'publicKey', index: false },
        { name: 'remoteChainSelector', type: { option: 'u64' }, index: false },
        { name: 'previousOutbound', type: { vec: 'publicKey' }, index: false },
        { name: 'previousInbound', type: { vec: 'publicKey' }, index: false },
        { name: 'outbound', type: { vec: 'publicKey' }, index: false },
        { name: 'inbound', type: { vec: 'publicKey' }, index: false },
        { name: 'epoch', type: 'u64', index: false },
        { name: 'activatesAt', type: 'i64', index: false },
        { name: 'emergency', type: 'bool', index: false },
        { name: 'defaultsMarkerPresent', type: 'bool', index: false },
        {
          name: 'replacedEpoch',
          docs: [
            'The pending set this one replaced before it activated, if any: lanes that synced it switch',
            'to it at `replaced_activates_at` and fail closed until resynced.',
          ],
          type: { option: 'u64' },
          index: false,
        },
        { name: 'replacedActivatesAt', type: { option: 'i64' }, index: false },
        {
          name: 'policy',
          docs: ["The named policy written; `None`: the group's own."],
          type: { option: 'publicKey' },
          index: false,
        },
      ],
    },
    {
      name: 'GroupChainAdded',
      fields: [
        { name: 'group', type: 'publicKey', index: false },
        { name: 'remoteChainSelector', type: 'u64', index: false },
      ],
    },
    {
      name: 'GroupChainLanesSet',
      fields: [
        { name: 'group', type: 'publicKey', index: false },
        { name: 'remoteChainSelector', type: 'u64', index: false },
        { name: 'previousMode', type: { defined: 'GroupLaneMode' }, index: false },
        { name: 'mode', type: { defined: 'GroupLaneMode' }, index: false },
        { name: 'drivenLanesPaused', type: 'bool', index: false },
        { name: 'bitmapWrite', type: { option: { defined: 'SubsetBitmapWrite' } }, index: false },
        { name: 'removed', type: { vec: 'u32' }, index: false },
        { name: 'added', type: { vec: 'u32' }, index: false },
      ],
    },
    {
      name: 'GroupChainPauseSet',
      fields: [
        { name: 'group', type: 'publicKey', index: false },
        { name: 'remoteChainSelector', type: 'u64', index: false },
        { name: 'pausedOutbound', type: 'bool', index: false },
        { name: 'pausedInbound', type: 'bool', index: false },
      ],
    },
    {
      name: 'GroupChainRemoved',
      fields: [
        { name: 'group', type: 'publicKey', index: false },
        { name: 'remoteChainSelector', type: 'u64', index: false },
      ],
    },
    {
      name: 'GroupCreated',
      fields: [
        { name: 'group', type: 'publicKey', index: false },
        { name: 'groupId', type: 'publicKey', index: false },
        { name: 'owner', type: 'publicKey', index: false },
        { name: 'maxBpsFee', type: 'u16', index: false },
        { name: 'openMembership', type: 'bool', index: false },
      ],
    },
    {
      name: 'GroupLaneClosed',
      fields: [
        { name: 'group', type: 'publicKey', index: false },
        { name: 'mint', type: 'publicKey', index: false },
        { name: 'remoteChainSelector', type: 'u64', index: false },
        { name: 'memberIndex', type: 'u32', index: false },
        {
          name: 'refundedTo',
          docs: [
            "Received the lane's rent: its payer, or the chain record when the payer cannot be credited",
            "any more (the record's rent returns to the group owner with `remove_group_chain`).",
          ],
          type: 'publicKey',
          index: false,
        },
      ],
    },
    {
      name: 'GroupLaneMaterialized',
      fields: [
        { name: 'group', type: 'publicKey', index: false },
        { name: 'mint', type: 'publicKey', index: false },
        { name: 'remoteChainSelector', type: 'u64', index: false },
        { name: 'memberIndex', type: 'u32', index: false },
        { name: 'remoteToken', type: { defined: 'RemoteAddress' }, index: false },
        { name: 'remoteDecimals', type: 'u8', index: false },
        { name: 'payer', type: 'publicKey', index: false },
      ],
    },
    {
      name: 'GroupMemberJoined',
      fields: [
        { name: 'group', type: 'publicKey', index: false },
        { name: 'mint', type: 'publicKey', index: false },
        { name: 'memberIndex', type: 'u32', index: false },
        { name: 'rentReceiver', type: 'publicKey', index: false },
        { name: 'remoteTokens', type: { vec: { defined: 'MemberRemoteToken' } }, index: false },
      ],
    },
    {
      name: 'GroupMemberLeft',
      fields: [
        { name: 'group', type: 'publicKey', index: false },
        { name: 'mint', type: 'publicKey', index: false },
        { name: 'memberIndex', type: 'u32', index: false },
        { name: 'byTokenOwner', type: 'bool', index: false },
      ],
    },
    {
      name: 'GroupMemberRemoteTokensSet',
      fields: [
        { name: 'group', type: 'publicKey', index: false },
        { name: 'mint', type: 'publicKey', index: false },
        { name: 'rentReceiver', type: 'publicKey', index: false },
        { name: 'remoteTokens', type: { vec: { defined: 'MemberRemoteToken' } }, index: false },
      ],
    },
    {
      name: 'GroupOwnershipTransferRequested',
      fields: [
        { name: 'group', type: 'publicKey', index: false },
        { name: 'owner', type: 'publicKey', index: false },
        { name: 'proposedOwner', type: 'publicKey', index: false },
      ],
    },
    {
      name: 'GroupOwnershipTransferred',
      fields: [
        { name: 'group', type: 'publicKey', index: false },
        { name: 'previousOwner', type: 'publicKey', index: false },
        { name: 'newOwner', type: 'publicKey', index: false },
      ],
    },
    {
      name: 'GroupPauseSet',
      fields: [
        { name: 'group', type: 'publicKey', index: false },
        { name: 'paused', type: 'bool', index: false },
      ],
    },
    {
      name: 'GroupPolicySectionSet',
      fields: [
        { name: 'group', type: 'publicKey', index: false },
        {
          name: 'policy',
          docs: ["The named policy written; `None`: the group's own default or chain record."],
          type: { option: 'publicKey' },
          index: false,
        },
        { name: 'remoteChainSelector', type: { option: 'u64' }, index: false },
        { name: 'inheritsDefault', type: 'bool', index: false },
        {
          name: 'section',
          docs: [
            "The section as written (the previous value is the previous event's; review 2d N9).",
          ],
          type: { defined: 'PolicySection' },
          index: false,
        },
      ],
    },
    {
      name: 'GroupRolesSet',
      fields: [
        { name: 'group', type: 'publicKey', index: false },
        { name: 'previousRoles', type: { defined: 'GroupRoles' }, index: false },
        { name: 'roles', type: { defined: 'GroupRoles' }, index: false },
      ],
    },
    {
      name: 'GroupSecurityReset',
      fields: [
        { name: 'group', type: 'publicKey', index: false },
        { name: 'remoteChainSelector', type: { option: 'u64' }, index: false },
        { name: 'clearedAllowDroppingDefaultCcvs', type: 'bool', index: false },
        { name: 'cancelledEpoch', type: { option: 'u64' }, index: false },
        { name: 'cancelledActivatesAt', type: { option: 'i64' }, index: false },
        {
          name: 'policy',
          docs: ["The named policy reset; `None`: the group's own records."],
          type: { option: 'publicKey' },
          index: false,
        },
      ],
    },
    {
      name: 'GroupSecuritySettingsSet',
      fields: [
        { name: 'group', type: 'publicKey', index: false },
        { name: 'remoteChainSelector', type: { option: 'u64' }, index: false },
        { name: 'allowDroppingDefaultCcvs', type: 'bool', index: false },
        { name: 'policy', type: { option: 'publicKey' }, index: false },
      ],
    },
    {
      name: 'GroupSettingsUpdated',
      fields: [
        { name: 'group', type: 'publicKey', index: false },
        { name: 'previousMaxBpsFee', type: 'u16', index: false },
        { name: 'maxBpsFee', type: 'u16', index: false },
        { name: 'openMembership', type: 'bool', index: false },
        { name: 'minCcvActivationDelay', type: { option: 'u64' }, index: false },
        {
          name: 'minCcvActivationDelayFrom',
          docs: [
            'When `min_ccv_activation_delay` applies: now for an increase, after the notice in force for',
            'a decrease.',
          ],
          type: 'i64',
          index: false,
        },
        { name: 'hookLookupTable', type: { option: 'publicKey' }, index: false },
      ],
    },
    {
      name: 'HookConfigSet',
      fields: [
        { name: 'group', type: 'publicKey', index: false },
        { name: 'remoteChainSelector', type: { option: 'u64' }, index: false },
        { name: 'policy', type: { option: 'publicKey' }, index: false },
        { name: 'previousAllowlist', type: { option: 'publicKey' }, index: false },
        { name: 'previousBlocklist', type: { option: 'publicKey' }, index: false },
        { name: 'allowlist', type: { option: 'publicKey' }, index: false },
        { name: 'blocklist', type: { option: 'publicKey' }, index: false },
      ],
    },
    {
      name: 'LaneBucketsReset',
      fields: [
        { name: 'group', type: 'publicKey', index: false },
        { name: 'mint', type: 'publicKey', index: false },
        { name: 'remoteChainSelector', type: 'u64', index: false },
      ],
    },
    {
      name: 'LaneCcvsSynced',
      fields: [
        { name: 'group', type: 'publicKey', index: false },
        { name: 'mint', type: 'publicKey', index: false },
        { name: 'remoteChainSelector', type: 'u64', index: false },
        { name: 'epoch', type: 'u64', index: false },
        {
          name: 'policy',
          docs: ["The named policy synced from; `None`: the group's own record."],
          type: { option: 'publicKey' },
          index: false,
        },
      ],
    },
    {
      name: 'LaneLinked',
      fields: [
        { name: 'group', type: 'publicKey', index: false },
        { name: 'mint', type: 'publicKey', index: false },
        { name: 'remoteChainSelector', type: 'u64', index: false },
        { name: 'classSource', type: { array: ['u8', 4] }, index: false },
      ],
    },
    {
      name: 'LanePauseSet',
      fields: [
        { name: 'group', type: 'publicKey', index: false },
        { name: 'mint', type: 'publicKey', index: false },
        { name: 'remoteChainSelector', type: 'u64', index: false },
        { name: 'pausedOutbound', type: 'bool', index: false },
        { name: 'pausedInbound', type: 'bool', index: false },
      ],
    },
    {
      name: 'LanePoliciesAssigned',
      fields: [
        { name: 'group', type: 'publicKey', index: false },
        { name: 'mint', type: 'publicKey', index: false },
        { name: 'remoteChainSelector', type: 'u64', index: false },
        { name: 'classSource', type: { array: ['u8', 4] }, index: false },
        { name: 'policySlots', type: { array: ['publicKey', 4] }, index: false },
        { name: 'previousClassSource', type: { array: ['u8', 4] }, index: false },
        { name: 'previousPolicySlots', type: { array: ['publicKey', 4] }, index: false },
      ],
    },
    {
      name: 'LanePoolDataSet',
      fields: [
        { name: 'mint', type: 'publicKey', index: false },
        { name: 'remoteChainSelector', type: 'u64', index: false },
        { name: 'poolDataFormat', type: { defined: 'PoolDataFormat' }, index: false },
        { name: 'uid', type: { option: { array: ['u8', 32] } }, index: false },
      ],
    },
    {
      name: 'LaneUnlinked',
      fields: [
        { name: 'group', type: 'publicKey', index: false },
        { name: 'mint', type: 'publicKey', index: false },
        { name: 'remoteChainSelector', type: 'u64', index: false },
      ],
    },
    {
      name: 'LiquidityDeposited',
      fields: [
        { name: 'provider', type: 'publicKey', index: false },
        { name: 'amount', type: 'u64', index: false },
        { name: 'mint', type: 'publicKey', index: false },
      ],
    },
    {
      name: 'LiquidityWithdrawn',
      fields: [
        { name: 'provider', type: 'publicKey', index: false },
        { name: 'amount', type: 'u64', index: false },
        { name: 'mint', type: 'publicKey', index: false },
      ],
    },
    {
      name: 'ListAdminTransferRequested',
      fields: [
        { name: 'list', type: 'publicKey', index: false },
        { name: 'admin', type: 'publicKey', index: false },
        { name: 'proposedAdmin', type: 'publicKey', index: false },
      ],
    },
    {
      name: 'ListAdminTransferred',
      fields: [
        { name: 'list', type: 'publicKey', index: false },
        { name: 'previousAdmin', type: 'publicKey', index: false },
        { name: 'admin', type: 'publicKey', index: false },
      ],
    },
    {
      name: 'ListCreated',
      fields: [
        { name: 'list', type: 'publicKey', index: false },
        { name: 'group', type: { option: 'publicKey' }, index: false },
        { name: 'admin', type: 'publicKey', index: false },
        { name: 'enabled', type: 'bool', index: false },
      ],
    },
    {
      name: 'ListUpdated',
      fields: [
        { name: 'list', type: 'publicKey', index: false },
        { name: 'added', type: { vec: 'bytes' }, index: false },
        { name: 'removed', type: { vec: 'bytes' }, index: false },
      ],
    },
    {
      name: 'Locked',
      fields: [
        { name: 'sender', type: 'publicKey', index: false },
        { name: 'amount', type: 'u64', index: false },
        { name: 'mint', type: 'publicKey', index: false },
      ],
    },
    {
      name: 'LockedOrBurned',
      fields: [
        { name: 'mint', type: 'publicKey', index: false },
        { name: 'remoteChainSelector', type: 'u64', index: false },
        { name: 'sender', type: 'publicKey', index: false },
        { name: 'amount', type: 'u64', index: false },
      ],
    },
    {
      name: 'MintAuthorityTransferred',
      fields: [
        { name: 'mint', type: 'publicKey', index: false },
        { name: 'oldMintAuthority', type: 'publicKey', index: false },
        { name: 'newMintAuthority', type: 'publicKey', index: false },
      ],
    },
    {
      name: 'Minted',
      fields: [
        { name: 'sender', type: 'publicKey', index: false },
        { name: 'recipient', type: 'publicKey', index: false },
        { name: 'amount', type: 'u64', index: false },
        { name: 'mint', type: 'publicKey', index: false },
      ],
    },
    {
      name: 'OverrideChainConfigConfigured',
      fields: [
        { name: 'chainSelector', type: 'u64', index: false },
        { name: 'mint', type: 'publicKey', index: false },
        { name: 'overrideType', type: { defined: 'PoolChainConfigOverrideType' }, index: false },
        { name: 'outboundRateLimit', type: { defined: 'RateLimitConfig' }, index: false },
        { name: 'inboundRateLimit', type: { defined: 'RateLimitConfig' }, index: false },
      ],
    },
    {
      name: 'OverrideChainConfigRemoved',
      fields: [
        { name: 'chainSelector', type: 'u64', index: false },
        { name: 'overrideType', type: { defined: 'PoolChainConfigOverrideType' }, index: false },
        { name: 'mint', type: 'publicKey', index: false },
      ],
    },
    {
      name: 'OwnershipTransferRequested',
      fields: [
        { name: 'from', type: 'publicKey', index: false },
        { name: 'to', type: 'publicKey', index: false },
        { name: 'mint', type: 'publicKey', index: false },
      ],
    },
    {
      name: 'OwnershipTransferred',
      fields: [
        { name: 'from', type: 'publicKey', index: false },
        { name: 'to', type: 'publicKey', index: false },
        { name: 'mint', type: 'publicKey', index: false },
      ],
    },
    {
      name: 'PolicyChainRecordAdded',
      fields: [
        { name: 'group', type: 'publicKey', index: false },
        { name: 'policy', type: 'publicKey', index: false },
        { name: 'remoteChainSelector', type: 'u64', index: false },
      ],
    },
    {
      name: 'PolicyChainRecordRemoved',
      fields: [
        { name: 'group', type: 'publicKey', index: false },
        { name: 'policy', type: 'publicKey', index: false },
        { name: 'remoteChainSelector', type: 'u64', index: false },
      ],
    },
    {
      name: 'PolicyClosed',
      fields: [
        { name: 'group', type: 'publicKey', index: false },
        { name: 'policy', type: 'publicKey', index: false },
      ],
    },
    {
      name: 'PolicyCreated',
      fields: [
        { name: 'group', type: 'publicKey', index: false },
        { name: 'policy', type: 'publicKey', index: false },
        { name: 'policyId', type: 'u32', index: false },
        { name: 'classes', type: 'u16', index: false },
      ],
    },
    {
      name: 'PolicyEngineSet',
      fields: [
        { name: 'group', type: 'publicKey', index: false },
        { name: 'remoteChainSelector', type: { option: 'u64' }, index: false },
        { name: 'policy', type: { option: 'publicKey' }, index: false },
        { name: 'previous', type: { option: { defined: 'PolicyEngineConfig' } }, index: false },
        { name: 'engine', type: { option: { defined: 'PolicyEngineConfig' } }, index: false },
        { name: 'skipDetach', type: 'bool', index: false },
      ],
    },
    {
      name: 'RateLimitAdminSet',
      fields: [
        { name: 'mint', type: 'publicKey', index: false },
        { name: 'oldRateLimitAdmin', type: 'publicKey', index: false },
        { name: 'newRateLimitAdmin', type: 'publicKey', index: false },
      ],
    },
    {
      name: 'RateLimitConfigured',
      fields: [
        { name: 'chainSelector', type: 'u64', index: false },
        { name: 'outboundRateLimit', type: { defined: 'RateLimitConfig' }, index: false },
        { name: 'inboundRateLimit', type: { defined: 'RateLimitConfig' }, index: false },
        { name: 'mint', type: 'publicKey', index: false },
      ],
    },
    {
      name: 'RebalancerSet',
      fields: [
        { name: 'mint', type: 'publicKey', index: false },
        { name: 'oldRebalancer', type: 'publicKey', index: false },
        { name: 'newRebalancer', type: 'publicKey', index: false },
      ],
    },
    {
      name: 'Released',
      fields: [
        { name: 'sender', type: 'publicKey', index: false },
        { name: 'recipient', type: 'publicKey', index: false },
        { name: 'amount', type: 'u64', index: false },
        { name: 'mint', type: 'publicKey', index: false },
      ],
    },
    {
      name: 'ReleasedOrMinted',
      fields: [
        { name: 'mint', type: 'publicKey', index: false },
        { name: 'remoteChainSelector', type: 'u64', index: false },
        { name: 'sender', type: 'publicKey', index: false },
        { name: 'recipient', type: 'publicKey', index: false },
        { name: 'userTokenAccount', type: 'publicKey', index: false },
        { name: 'amount', type: 'u64', index: false },
      ],
    },
    {
      name: 'RemoteChainConfigured',
      fields: [
        { name: 'chainSelector', type: 'u64', index: false },
        { name: 'token', type: { defined: 'RemoteAddress' }, index: false },
        { name: 'previousToken', type: { defined: 'RemoteAddress' }, index: false },
        { name: 'poolAddresses', type: { vec: { defined: 'RemoteAddress' } }, index: false },
        {
          name: 'previousPoolAddresses',
          type: { vec: { defined: 'RemoteAddress' } },
          index: false,
        },
        { name: 'mint', type: 'publicKey', index: false },
      ],
    },
    {
      name: 'RemoteChainRemoved',
      fields: [
        { name: 'chainSelector', type: 'u64', index: false },
        { name: 'mint', type: 'publicKey', index: false },
      ],
    },
    {
      name: 'RemotePoolsAppended',
      fields: [
        { name: 'chainSelector', type: 'u64', index: false },
        { name: 'poolAddresses', type: { vec: { defined: 'RemoteAddress' } }, index: false },
        {
          name: 'previousPoolAddresses',
          type: { vec: { defined: 'RemoteAddress' } },
          index: false,
        },
        { name: 'mint', type: 'publicKey', index: false },
      ],
    },
    {
      name: 'RmnRemoteUpdated',
      fields: [
        { name: 'oldRmnRemote', type: 'publicKey', index: false },
        { name: 'newRmnRemote', type: 'publicKey', index: false },
        { name: 'mint', type: 'publicKey', index: false },
      ],
    },
    {
      name: 'RouterUpdated',
      fields: [
        { name: 'oldRouter', type: 'publicKey', index: false },
        { name: 'newRouter', type: 'publicKey', index: false },
        { name: 'mint', type: 'publicKey', index: false },
      ],
    },
    {
      name: 'TokenPoolInitialized',
      fields: [
        { name: 'mint', type: 'publicKey', index: false },
        { name: 'tokenProgram', type: 'publicKey', index: false },
        { name: 'owner', type: 'publicKey', index: false },
      ],
    },
    {
      name: 'TokenTransferFeeConfigRemoved',
      fields: [
        { name: 'chainSelector', type: 'u64', index: false },
        { name: 'mint', type: 'publicKey', index: false },
      ],
    },
    {
      name: 'TokenTransferFeeConfigUpdated',
      fields: [
        { name: 'chainSelector', type: 'u64', index: false },
        { name: 'mint', type: 'publicKey', index: false },
        { name: 'config', type: { defined: 'TokenTransferFeeConfig' }, index: false },
      ],
    },
    { name: 'TokensConsumed', fields: [{ name: 'tokens', type: 'u64', index: false }] },
  ],
  errors: [
    {
      code: 6000,
      name: 'InvalidInitPoolPermissions',
      msg: 'Pool authority does not match token mint owner',
    },
    { code: 6001, name: 'InvalidRMNRemoteAddress', msg: 'Invalid RMN Remote Address' },
    { code: 6002, name: 'Unauthorized', msg: 'Unauthorized' },
    { code: 6003, name: 'InvalidInputs', msg: 'Invalid inputs' },
    { code: 6004, name: 'InvalidVersion', msg: 'Invalid state version' },
    { code: 6005, name: 'InvalidPoolCaller', msg: 'Caller is not ramp on router' },
    { code: 6006, name: 'InvalidSender', msg: 'Sender not allowed' },
    { code: 6007, name: 'InvalidSourcePoolAddress', msg: 'Invalid source pool address' },
    { code: 6008, name: 'InvalidToken', msg: 'Invalid token' },
    { code: 6009, name: 'InvalidTokenAmountConversion', msg: 'Invalid token amount conversion' },
    { code: 6010, name: 'AllowlistKeyAlreadyExisted', msg: 'Key already existed in the allowlist' },
    { code: 6011, name: 'AllowlistKeyDidNotExist', msg: 'Key did not exist in the allowlist' },
    {
      code: 6012,
      name: 'RemotePoolAddressAlreadyExisted',
      msg: 'Remote pool address already exists',
    },
    {
      code: 6013,
      name: 'NonemptyPoolAddressesInit',
      msg: 'Expected empty pool addresses during initialization',
    },
    { code: 6014, name: 'InvalidDerivationStage', msg: 'Unexpected account derivation stage' },
    { code: 6015, name: 'RLBucketOverfilled', msg: 'RateLimit: bucket overfilled' },
    { code: 6016, name: 'RLMaxCapacityExceeded', msg: 'RateLimit: max capacity exceeded' },
    { code: 6017, name: 'RLRateLimitReached', msg: 'RateLimit: rate limit reached' },
    { code: 6018, name: 'RLInvalidRateLimitRate', msg: 'RateLimit: invalid rate limit rate' },
    {
      code: 6019,
      name: 'RLDisabledNonZeroRateLimit',
      msg: 'RateLimit: disabled non-zero rate limit',
    },
    { code: 6020, name: 'LiquidityNotAccepted', msg: 'Liquidity not accepted' },
    {
      code: 6021,
      name: 'TransferZeroTokensNotAllowed',
      msg: 'Transferring zero tokens is not allowed',
    },
    { code: 6022, name: 'InsufficientPoolBalance', msg: 'Insufficient pool balance' },
    { code: 6023, name: 'DuplicateCCVNotAllowed', msg: 'Invalid duplicated ccvs' },
    {
      code: 6024,
      name: 'MustSpecifyUnderThresholdCCVsForThresholdCCVs',
      msg: 'Invalid Threshold CCVs config',
    },
    {
      code: 6025,
      name: 'InboundOutboundDirectionOnly',
      msg: 'Invalid Direction for Get Required CCVs',
    },
    {
      code: 6026,
      name: 'CcvZeroAddressNotAllowed',
      msg: 'CCV address cannot be the zero/default pubkey',
    },
    {
      code: 6027,
      name: 'ThresholdAmountRequiredForThresholdCcvs',
      msg: 'Threshold amount must be non-zero when threshold CCVs are configured',
    },
    {
      code: 6028,
      name: 'InvalidRequestedFinality',
      msg: "Requested finality is not allowed by the pool's configured allowed finality",
    },
    { code: 6029, name: 'ZeroTokenAddress', msg: 'Remote token address cannot be zero/empty' },
    {
      code: 6030,
      name: 'InvalidTokenTransferFeeBps',
      msg: 'Token transfer fee bps must not exceed 10000 (100%)',
    },
    {
      code: 6031,
      name: 'InvalidTokenTransferFeeDestBytesOverhead',
      msg: 'Token transfer fee destination bytes overhead is below the required minimum',
    },
    { code: 6032, name: 'RLArithmeticError', msg: 'RateLimit: arithmetic error' },
    { code: 6033, name: 'NoFeesToWithdraw', msg: 'No fees available to withdraw (vault empty)' },
    {
      code: 6034,
      name: 'InvalidFeeWithdrawAmount',
      msg: 'Invalid requested amount of fees to withdraw',
    },
    {
      code: 6035,
      name: 'InsufficientFeesToWithdraw',
      msg: 'Not enough stored fees to withdraw the requested amount',
    },
    { code: 6036, name: 'InvalidSourcePoolData', msg: 'Encoded source pool data is invalid' },
    {
      code: 6037,
      name: 'ConfigAndRemotePoolDisagreeOnDecimals',
      msg: 'Remote chain config and remote pool show different decimals for token',
    },
    {
      code: 6038,
      name: 'MissingFeeVaultTokenAccount',
      msg: "The fee vault token account for the pool's own mint does not exist",
    },
    { code: 6039, name: 'DuplicatedKeys', msg: 'A key appears more than once' },
    { code: 6040, name: 'InvalidClassSource', msg: 'A lane class source is not a valid source' },
    {
      code: 6041,
      name: 'GroupChainPolicyMissing',
      msg: 'The lane is linked to a group but its group chain policy record was not passed',
    },
    {
      code: 6042,
      name: 'PolicyRecordMissing',
      msg: "A policy record the lane's class sources name was not passed",
    },
    {
      code: 6043,
      name: 'SecurityPolicyNotSupported',
      msg: 'This version keeps the SECURITY class inline and its group section empty',
    },
    {
      code: 6044,
      name: 'LongPoolDataNotSupported',
      msg: 'The long pool data format is not supported by this version',
    },
    {
      code: 6045,
      name: 'LegacyPoolDataFromPolicyPool',
      msg: "Legacy pool data is accepted only from the lane's own remote pools",
    },
    { code: 6046, name: 'GroupPaused', msg: 'Transfers are paused for the whole group' },
    {
      code: 6047,
      name: 'GroupChainPaused',
      msg: 'Transfers are paused for this chain in the group',
    },
    { code: 6048, name: 'LanePaused', msg: 'Transfers are paused for this lane' },
    { code: 6049, name: 'LaneAlreadyLinked', msg: 'The lane is already linked to a group' },
    { code: 6050, name: 'LaneNotLinkedToGroup', msg: 'The lane is not linked to this group' },
    { code: 6051, name: 'LaneLinkMismatch', msg: "The lane's link records disagree" },
    { code: 6052, name: 'LaneLinked', msg: 'The lane is linked to a group; unlink it first' },
    { code: 6053, name: 'LaneConfigV2Missing', msg: "The lane's v2 chain config was not passed" },
    {
      code: 6054,
      name: 'GroupOwnerSignatureRequired',
      msg: "Joining this group needs the group owner's signature",
    },
    {
      code: 6055,
      name: 'GroupChainAlreadyExists',
      msg: 'The group already has a record for this chain',
    },
    { code: 6056, name: 'UnknownGroupChain', msg: 'The group has no record for this chain' },
    { code: 6057, name: 'TooManyGroupChains', msg: 'The group has the maximum number of chains' },
    {
      code: 6058,
      name: 'IncompleteGroupChainSet',
      msg: 'Every chain record of the group must be passed exactly once',
    },
    { code: 6059, name: 'GroupChainHasMembers', msg: 'Lanes still use this group chain record' },
    { code: 6060, name: 'BpsFeeAboveGroupMax', msg: "The BPS fee exceeds the group's maximum" },
    {
      code: 6061,
      name: 'MaxBpsFeeCanOnlyDecrease',
      msg: "The group's maximum BPS fee can only be lowered",
    },
    {
      code: 6062,
      name: 'TooManyPolicyRemotePools',
      msg: 'Too many remote pools in a connection policy',
    },
    {
      code: 6063,
      name: 'RateLimitNotFromGroup',
      msg: "The lane's rate limit does not come from the group",
    },
    {
      code: 6064,
      name: 'TokenNotOnPoolInterfaceV2',
      msg: "Token groups need the token's registry to declare pool interface 2",
    },
    {
      code: 6065,
      name: 'SourceTokenMismatch',
      msg: "The source token in the pool data is not the lane's remote token",
    },
    {
      code: 6066,
      name: 'InvalidAdditionalPoolData',
      msg: "The additional pool data does not match the lane's token UID",
    },
    {
      code: 6067,
      name: 'LongPoolDataNeedsDestBytesOverhead',
      msg: 'Long pool data needs a pool fee config whose destination bytes overhead covers it',
    },
    {
      code: 6068,
      name: 'LegacyPoolDataNotAllowed',
      msg: 'This lane sends the long pool data format or has a UID: legacy pool data is not accepted',
    },
    {
      code: 6069,
      name: 'RateLimitFromGroup',
      msg: "The lane's rate limits come from its group; change them through the group",
    },
    {
      code: 6070,
      name: 'UidRequiresLongPoolData',
      msg: 'A lane with a factory UID must use the long pool data format',
    },
    {
      code: 6071,
      name: 'DefaultCcvsRequired',
      msg: 'A group CCV list must include the lane defaults (INCLUDE_DEFAULT_CCVS) unless the owner allowed dropping them',
    },
    { code: 6072, name: 'TooManyPolicyCcvs', msg: 'Too many CCVs in a group CCV list' },
    {
      code: 6073,
      name: 'CcvActivationTooSoon',
      msg: "A scheduled CCV change must activate at least the group's minimum delay from now",
    },
    {
      code: 6074,
      name: 'GroupCcvsNotSynced',
      msg: "The lane's copy of its group CCVs is not in step with the group: run sync_group_ccvs",
    },
    {
      code: 6075,
      name: 'CcvsFromGroup',
      msg: "The lane's CCVs come from its group; change them through the group",
    },
    {
      code: 6076,
      name: 'SecurityInheritsDefault',
      msg: 'This chain record follows the group default for SECURITY: change the default, or detach the record with a targeted schedule first',
    },
    {
      code: 6077,
      name: 'PolicyClassNotCarried',
      msg: 'The named policy does not carry this class',
    },
    {
      code: 6078,
      name: 'PolicyInUse',
      msg: 'Lanes still reference this policy chain record (PolicyInUse)',
    },
    {
      code: 6079,
      name: 'PolicyHasRecords',
      msg: 'The policy still has chain records (PolicyHasRecords)',
    },
    {
      code: 6080,
      name: 'LaneUsesNamedPolicy',
      msg: 'The lane uses a named policy: unassign it before unlinking',
    },
    { code: 6081, name: 'TooManyPolicyChains', msg: 'Too many chain records for this policy' },
    {
      code: 6082,
      name: 'PolicySecurityStale',
      msg: "This named policy's SECURITY predates the group's last ownership change: the owner must reset it",
    },
    { code: 6083, name: 'AllowlistDisabled', msg: 'A hook allowlist must be enabled' },
    { code: 6084, name: 'TooManyEngineAccounts', msg: 'Too many policy engine static accounts' },
    { code: 6085, name: 'HookAccountMissing', msg: 'An account a hook needs was not passed' },
    { code: 6086, name: 'SenderNotAllowed', msg: "The sender is not on the group's allowlist" },
    { code: 6087, name: 'LocalAddressBlocked', msg: 'The local address is blocked' },
    { code: 6088, name: 'RemoteAddressBlocked', msg: 'The remote address is blocked' },
    { code: 6089, name: 'EngineProgramNotAllowed', msg: 'This program cannot be a policy engine' },
    {
      code: 6090,
      name: 'InvalidHookLookupTable',
      msg: 'The hook lookup table must be an active address lookup table',
    },
    {
      code: 6091,
      name: 'GroupLaneNotEnabled',
      msg: "The group does not enable this member's lane to this chain",
    },
    {
      code: 6092,
      name: 'GroupLaneStillEnabled',
      msg: 'The group still enables this lane: only its token owner can close it',
    },
    {
      code: 6093,
      name: 'LaneGroupDriven',
      msg: 'The lane is group-driven: close it with close_group_lanes',
    },
    {
      code: 6094,
      name: 'NotGroupDrivenLane',
      msg: 'The lane is not a group-driven lane of this member, group and chain',
    },
    {
      code: 6095,
      name: 'MemberRemoteTokenMissing',
      msg: 'The member has no remote token for this chain',
    },
    { code: 6096, name: 'InvalidMemberRemoteTokens', msg: 'Invalid member remote tokens' },
    { code: 6097, name: 'InvalidGroupMember', msg: 'Invalid group member' },
    { code: 6098, name: 'GroupMemberHasLanes', msg: 'The member still has group-driven lanes' },
    { code: 6099, name: 'InvalidMemberIndex', msg: 'The member index is not an existing member' },
    {
      code: 6100,
      name: 'GroupChainHasNoRemotePools',
      msg: 'Group-driven lanes need the chain record to trust a remote pool',
    },
    {
      code: 6101,
      name: 'GroupLanesPaused',
      msg: "The group's driven lanes on this chain are paused",
    },
    {
      code: 6102,
      name: 'GroupLanesMustStartPaused',
      msg: "A chain's group-driven lanes must be enabled paused",
    },
    {
      code: 6103,
      name: 'InvalidRentReceiver',
      msg: 'A rent receiver must be a writable, non-executable system account',
    },
  ],
}
