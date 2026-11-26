/**
 * Anchor 0.29 IDL of `burnmint_token_pool 2.1.0` with pool groups (prototype fork, stage 2f).
 *
 * From the pool-groups fork of smartcontractkit/chainlink-ccip-solana@7558722,
 * contracts/target/idl/burnmint_token_pool.json (Devnet program
 * 22P6h4QV5wswBX63KCncFGctC9dyVRMjykBBDdhwXjg7; pass it as the pool program address).
 *
 * Converted from the `anchor build` IDL (Anchor spec 0.1.0) to the Anchor 0.29 format, with every
 * instruction and account discriminator checked against the IDL's; regenerate rather than edit.
 * Newtypes are inlined as their single field (identical Borsh layout). `GroupMember` and
 * `GroupRegistry` are not IDL accounts in the program and are decoded by hand.
 */
export type BurnmintTokenPoolGroups = {
  version: '2.1.0'
  name: 'burnmint_token_pool'
  instructions: [
    {
      name: 'acceptGroupOwnership'
      docs: [
        'Accepts a pending group ownership transfer.',
        "(All the group's chain records as remaining accounts: the previous team's CCV opt-outs and",
        'pending sets are reset.)',
      ]
      accounts: [
        { name: 'group'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: false; isSigner: true },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: []
    },
    {
      name: 'acceptListAdmin'
      docs: ['Accepts the admin role of an allowlist or blocklist (proposed admin).']
      accounts: [
        { name: 'list'; isMut: true; isSigner: false },
        {
          name: 'authority'
          isMut: false
          isSigner: true
          docs: [
            'The admin (transfer) or the proposed admin (accept), checked by the handler. For an',
            "allowlist, also its group's owner, who may always propose a new admin (review 2e S1).",
          ]
        },
        {
          name: 'group'
          isMut: false
          isSigner: false
          isOptional: true
          docs: ["The allowlist's group, when its owner transfers the admin role."]
        },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: []
    },
    {
      name: 'acceptOwnership'
      docs: [
        'Accepts a pending ownership transfer, making the caller the new pool owner.',
        'Shared function signature used by all CCIP token pool programs.',
      ]
      accounts: [
        { name: 'state'; isMut: true; isSigner: false },
        { name: 'mint'; isMut: false; isSigner: false },
        { name: 'authority'; isMut: false; isSigner: true },
      ]
      args: []
    },
    {
      name: 'activateGroupCcvsNow'
      docs: [
        'Emergency: activates a CCV set now (group owner). Unsynced lanes fail closed until synced.',
      ]
      accounts: [
        { name: 'group'; isMut: true; isSigner: false },
        {
          name: 'authority'
          isMut: false
          isSigner: true
          docs: ['Checked by each handler: the security admin schedules, the owner does the rest.']
        },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'ActivateGroupCcvsNowParams' } }]
    },
    {
      name: 'addGroupChain'
      docs: ["Creates the group's record for a remote chain, following the group default."]
      accounts: [
        { name: 'group'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: true; isSigner: true },
        { name: 'groupChainPolicy'; isMut: true; isSigner: false },
        { name: 'systemProgram'; isMut: false; isSigner: false },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'AddGroupChainParams' } }]
    },
    {
      name: 'appendRemotePoolAddresses'
      docs: [
        'Appends additional remote pool addresses to an existing ChainConfig.',
        'Reallocates the PDA to accommodate the extra entries.',
      ]
      accounts: [
        { name: 'state'; isMut: false; isSigner: false },
        { name: 'chainConfig'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: true; isSigner: true },
        { name: 'systemProgram'; isMut: false; isSigner: false },
      ]
      args: [
        { name: 'remoteChainSelector'; type: 'u64' },
        { name: 'mint'; type: 'publicKey' },
        { name: 'addresses'; type: { vec: { defined: 'RemoteAddress' } } },
      ]
    },
    {
      name: 'applyListUpdates'
      docs: [
        'Adds and removes entries of an allowlist or a blocklist (its admin; entry PDAs as',
        'remaining accounts).',
      ]
      accounts: [
        { name: 'list'; isMut: true; isSigner: false },
        {
          name: 'admin'
          isMut: true
          isSigner: true
          docs: ["The list's admin; pays for new entries, receives their rent back."]
        },
        { name: 'systemProgram'; isMut: false; isSigner: false },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'ApplyListUpdatesParams' } }]
    },
    {
      name: 'assignLanePolicies'
      docs: [
        'Assigns per-class sources (inline, group default, named policy) to linked lanes (batched).',
      ]
      accounts: [
        { name: 'group'; isMut: false; isSigner: false },
        { name: 'groupChainPolicy'; isMut: true; isSigner: false },
        {
          name: 'groupOwner'
          isMut: false
          isSigner: true
          isOptional: true
          docs: ['Required unless the group has open membership.']
        },
        { name: 'authority'; isMut: true; isSigner: true },
        { name: 'systemProgram'; isMut: false; isSigner: false },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'AssignLanePoliciesParams' } }]
    },
    {
      name: 'closeGroupLanes'
      docs: [
        'Closes group-driven lanes the group no longer enables (permissionless), or any of them by',
        'their token owner (batched).',
      ]
      accounts: [
        { name: 'group'; isMut: false; isSigner: false },
        { name: 'groupChainPolicy'; isMut: true; isSigner: false },
        {
          name: 'groupRegistry'
          isMut: false
          isSigner: false
          docs: ['`set_group_chain_lanes` for the next member index.']
        },
        { name: 'authority'; isMut: true; isSigner: true },
        { name: 'systemProgram'; isMut: false; isSigner: false },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [
        { name: 'remoteChainSelector'; type: 'u64' },
        { name: 'params'; type: { defined: 'CloseGroupLanesParams' } },
      ]
    },
    {
      name: 'closeGroupMembers'
      docs: [
        'Closes memberships without group-driven lanes (batched; the token owner, or the group).',
      ]
      accounts: [
        { name: 'group'; isMut: false; isSigner: false },
        {
          name: 'groupRegistry'
          isMut: true
          isSigner: false
          docs: ['join. Loaded and checked by the handlers.']
        },
        {
          name: 'groupOwner'
          isMut: false
          isSigner: true
          isOptional: true
          docs: ['`join_group` only: required unless the group has open membership.']
        },
        { name: 'authority'; isMut: true; isSigner: true },
        { name: 'systemProgram'; isMut: false; isSigner: false },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: []
    },
    {
      name: 'closePolicy'
      docs: ['Closes a named policy with no chain records left.']
      accounts: [
        { name: 'group'; isMut: false; isSigner: false },
        { name: 'policy'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: false; isSigner: true },
        {
          name: 'rentReceiver'
          isMut: true
          isSigner: false
          docs: [
            "The group owner receives the closed account's rent, whoever closes it (review 2d N8).",
          ]
        },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'PolicyIdParams' } }]
    },
    {
      name: 'closePolicyChainRecord'
      docs: ['Closes a named policy chain record no lane references.']
      accounts: [
        { name: 'group'; isMut: false; isSigner: false },
        { name: 'policy'; isMut: true; isSigner: false },
        { name: 'policyChainRecord'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: false; isSigner: true },
        {
          name: 'rentReceiver'
          isMut: true
          isSigner: false
          docs: [
            "The group owner receives the closed account's rent, whoever closes it (review 2d N8).",
          ]
        },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'PolicyChainParams' } }]
    },
    {
      name: 'configureAllowList'
      docs: [
        'Adds addresses to the allow-list and/or enables the allow-list check.',
        'When enabled, only listed addresses may send tokens through the pool.',
      ]
      accounts: [
        { name: 'state'; isMut: true; isSigner: false },
        { name: 'mint'; isMut: false; isSigner: false },
        { name: 'authority'; isMut: true; isSigner: true },
        { name: 'systemProgram'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'add'; type: { vec: 'publicKey' } }, { name: 'enabled'; type: 'bool' }]
    },
    {
      name: 'createAllowlist'
      docs: [
        'Creates a sender allowlist of the group for the send hook (owner or security admin);',
        '`enabled` is fixed for its life.',
      ]
      accounts: [
        { name: 'group'; isMut: false; isSigner: false },
        { name: 'allowlist'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: true; isSigner: true },
        { name: 'systemProgram'; isMut: false; isSigner: false },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'CreateAllowlistParams' } }]
    },
    {
      name: 'createBlocklist'
      docs: ['Creates a shared blocklist with its own admin (anyone pays).']
      accounts: [
        { name: 'blocklist'; isMut: true; isSigner: false },
        { name: 'creator'; isMut: true; isSigner: true },
        { name: 'systemProgram'; isMut: false; isSigner: false },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'CreateBlocklistParams' } }]
    },
    {
      name: 'createGroup'
      docs: [
        'Creates a token group at `[GROUP_SEED, group_id]`, owned by the signer. Lanes (mint × chain)',
        'of any pool of this program can then link to it and read connection, fee and rate-limit',
        'policies from it instead of their own fields.',
      ]
      accounts: [
        { name: 'group'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: true; isSigner: true },
        { name: 'systemProgram'; isMut: false; isSigner: false },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'CreateGroupParams' } }]
    },
    {
      name: 'createPolicy'
      docs: [
        'Creates a named policy of the group carrying the given classes (owner or policy admin).',
      ]
      accounts: [
        { name: 'group'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: true; isSigner: true },
        { name: 'policy'; isMut: true; isSigner: false },
        { name: 'systemProgram'; isMut: false; isSigner: false },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'CreatePolicyParams' } }]
    },
    {
      name: 'deleteChainConfig'
      docs: [
        'Closes and reclaims rent from a ChainConfig PDA.',
        'After this call no cross-chain messages can be sent to or from that chain.',
      ]
      accounts: [
        { name: 'state'; isMut: false; isSigner: false },
        { name: 'chainConfig'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: true; isSigner: true },
      ]
      args: [{ name: 'remoteChainSelector'; type: 'u64' }, { name: 'mint'; type: 'publicKey' }]
    },
    {
      name: 'deleteChainConfigOverride'
      docs: ['Closes and reclaims rent from a ChainConfigOverride PDA.']
      accounts: [
        { name: 'state'; isMut: false; isSigner: false },
        { name: 'chainConfigOverride'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: true; isSigner: true },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'DeleteChainConfigOverrideParams' } }]
    },
    {
      name: 'deriveAccountsLockOrBurnTokens'
      docs: [
        'Called by the router via CPI during `DeriveAccountsCcipSend` to discover',
        'any extra accounts needed for the onramp token transfer.',
        'Burnmint pools have no additional account requirements beyond the',
        'standard token lookup table, so this returns an empty set.',
      ]
      accounts: []
      args: [
        { name: 'stage'; type: 'string' },
        { name: 'LockOrBurn'; type: { defined: 'LockOrBurnInV1' } },
      ]
      returns: { defined: 'DeriveAccountsResponse' }
    },
    {
      name: 'deriveAccountsReleaseOrMintTokens'
      docs: [
        'Called by the offramp via CPI during `DeriveAccountsExecute` to discover',
        'any extra accounts needed for the offramp token transfer.',
        'Burnmint pools have no additional account requirements beyond the',
        'standard token lookup table, so this returns an empty set.',
      ]
      accounts: []
      args: [
        { name: 'stage'; type: 'string' },
        { name: 'ReleaseOrMint'; type: { defined: 'ReleaseOrMintInV1' } },
      ]
      returns: { defined: 'DeriveAccountsResponse' }
    },
    {
      name: 'editChainConfigV2'
      accounts: [
        { name: 'state'; isMut: false; isSigner: false },
        {
          name: 'chainConfigV2'
          isMut: true
          isSigner: false
          docs: [
            'Resized by the handler rather than by a `realloc` constraint: a lane linked to a group has a',
            'tail after this body, which the handler keeps (see `LaneConfigV2::store`).',
          ]
        },
        { name: 'authority'; isMut: true; isSigner: true },
        { name: 'systemProgram'; isMut: false; isSigner: false },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'SetChainConfigV2Params' } }]
    },
    {
      name: 'editChainRemoteConfig'
      docs: [
        'Overwrites the remote config (token address and pool addresses) for an',
        'existing ChainConfig. Reallocates the PDA if the new config is larger.',
      ]
      accounts: [
        { name: 'state'; isMut: false; isSigner: false },
        { name: 'chainConfig'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: true; isSigner: true },
        { name: 'systemProgram'; isMut: false; isSigner: false },
      ]
      args: [
        { name: 'remoteChainSelector'; type: 'u64' },
        { name: 'mint'; type: 'publicKey' },
        { name: 'cfg'; type: { defined: 'RemoteConfig' } },
      ]
    },
    {
      name: 'editPolicyChainRecord'
      docs: [
        "Sets one class of a named policy chain record (the class's admin; FEE by the fee admin).",
      ]
      accounts: [
        { name: 'group'; isMut: false; isSigner: false },
        { name: 'policy'; isMut: false; isSigner: false },
        { name: 'policyChainRecord'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: false; isSigner: true },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'EditPolicyChainRecordParams' } }]
    },
    {
      name: 'getPoolFee'
      docs: ['Returns the fee receipt for a token transfer.']
      accounts: [
        { name: 'state'; isMut: false; isSigner: false },
        { name: 'chainConfig'; isMut: false; isSigner: false },
        {
          name: 'chainConfigV2'
          isMut: false
          isSigner: false
          docs: ['May or may not be initialized']
        },
      ]
      args: [{ name: 'getFeeIn'; type: { defined: 'GetFeeParams' } }]
      returns: { defined: 'GetFeeResult' }
    },
    {
      name: 'getRequiredCcvs'
      docs: [
        'This implementation returns base CCVs for all transfers, and includes additional CCVs when the transfer amount is above the configured threshold.',
      ]
      accounts: [
        { name: 'state'; isMut: false; isSigner: false },
        { name: 'chainConfig'; isMut: false; isSigner: false },
        {
          name: 'chainConfigV2'
          isMut: false
          isSigner: false
          docs: ['When initialized (owner == this program)']
        },
      ]
      args: [{ name: 'getRequiredCcvsIn'; type: { defined: 'GetRequiredCCVsIn' } }]
      returns: { defined: 'GetRequiredCCVsOut' }
    },
    {
      name: 'inheritGroupDefault'
      docs: ['Makes one chain record follow the group default again for one class.']
      accounts: [
        { name: 'group'; isMut: false; isSigner: false },
        { name: 'groupChainPolicy'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: false; isSigner: true },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'InheritGroupDefaultParams' } }]
    },
    {
      name: 'initChainConfigOverride'
      docs: [
        'Initializes a ChainConfigOverride PDA for the given remote chain and override type.',
        'Used to set separate rate limit buckets (e.g. for faster-than-finality transfers).',
      ]
      accounts: [
        { name: 'state'; isMut: false; isSigner: false },
        { name: 'chainConfigOverride'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: true; isSigner: true },
        { name: 'systemProgram'; isMut: false; isSigner: false },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'InitChainConfigOverrideParams' } }]
    },
    {
      name: 'initChainConfigV2'
      accounts: [
        { name: 'state'; isMut: false; isSigner: false },
        { name: 'chainConfigV2'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: true; isSigner: true },
        { name: 'systemProgram'; isMut: false; isSigner: false },
        {
          name: 'mint'
          isMut: false
          isSigner: false
          docs: [
            "The token this pool wraps. Needed to create the fee vault ATA the lane's in-token BPS fee",
            'accrues into.',
          ]
        },
        { name: 'feeVault'; isMut: false; isSigner: false },
        {
          name: 'feeVaultTokenAccount'
          isMut: true
          isSigner: false
          docs: [
            "The fee vault's ATA for the pool's own mint, where `lock_or_burn_tokens_v2` accrues the",
            'in-token BPS fee. Created here so that configuring a',
            'lane and being able to collect (and withdraw) its BPS fee are the same operation.',
          ]
        },
        { name: 'tokenProgram'; isMut: false; isSigner: false },
        { name: 'associatedTokenProgram'; isMut: false; isSigner: false },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'SetChainConfigV2Params' } }]
    },
    {
      name: 'initChainRemoteConfig'
      docs: [
        'Initializes a ChainConfig PDA for the given remote chain.',
        'Must be called before any cross-chain messages can be sent to or from',
        'that chain. Remote pool addresses are added separately via',
        'append_remote_pool_addresses.',
      ]
      accounts: [
        { name: 'state'; isMut: false; isSigner: false },
        { name: 'chainConfig'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: true; isSigner: true },
        { name: 'systemProgram'; isMut: false; isSigner: false },
      ]
      args: [
        { name: 'remoteChainSelector'; type: 'u64' },
        { name: 'mint'; type: 'publicKey' },
        { name: 'cfg'; type: { defined: 'RemoteConfig' } },
      ]
    },
    {
      name: 'initGlobalConfig'
      docs: [
        'Initializes the program-level PoolConfig PDA.',
        "Must be called once by the program's upgrade authority before any",
        'token pool can be created.',
      ]
      accounts: [
        { name: 'config'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: true; isSigner: true },
        { name: 'systemProgram'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
        { name: 'programData'; isMut: false; isSigner: false },
      ]
      args: [
        { name: 'routerAddress'; type: 'publicKey' },
        { name: 'rmnAddress'; type: 'publicKey' },
      ]
    },
    {
      name: 'initGroupLanes'
      docs: ['Creates new lanes of one chain directly in a group (batched).']
      accounts: [
        { name: 'group'; isMut: false; isSigner: false },
        { name: 'groupChainPolicy'; isMut: true; isSigner: false },
        {
          name: 'groupOwner'
          isMut: false
          isSigner: true
          isOptional: true
          docs: ['Required unless the group has open membership.']
        },
        { name: 'authority'; isMut: true; isSigner: true },
        { name: 'systemProgram'; isMut: false; isSigner: false },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'InitGroupLanesParams' } }]
    },
    {
      name: 'initPolicyChainRecord'
      docs: [
        "Creates a named policy's record for a chain of the group (a copy of the policy default).",
      ]
      accounts: [
        { name: 'group'; isMut: false; isSigner: false },
        { name: 'policy'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: true; isSigner: true },
        { name: 'policyChainRecord'; isMut: true; isSigner: false },
        { name: 'systemProgram'; isMut: false; isSigner: false },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'PolicyChainParams' } }]
    },
    {
      name: 'initialize'
      docs: [
        'Creates a new per-mint State PDA for the given mint.',
        'The upgrade authority (or a mint authority when self-serve is enabled)',
        'becomes the pool owner.',
      ]
      accounts: [
        { name: 'state'; isMut: true; isSigner: false },
        { name: 'mint'; isMut: false; isSigner: false },
        { name: 'authority'; isMut: true; isSigner: true },
        { name: 'systemProgram'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
        { name: 'programData'; isMut: false; isSigner: false },
        { name: 'config'; isMut: false; isSigner: false },
      ]
      args: []
    },
    {
      name: 'initializeByMultisig'
      docs: [
        'Creates a new per-mint State PDA for the given mint via a mint authority multisig signer.',
        'Self-serve must be enabled. Only 1-of-N multisigs are supported.',
      ]
      accounts: [
        { name: 'state'; isMut: true; isSigner: false },
        { name: 'mint'; isMut: false; isSigner: false },
        { name: 'authority'; isMut: true; isSigner: true },
        { name: 'systemProgram'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
        { name: 'programData'; isMut: false; isSigner: false },
        { name: 'config'; isMut: false; isSigner: false },
        {
          name: 'mintAuthorityMultisig'
          isMut: false
          isSigner: false
          docs: ['Only 1-of-N SPL Token multisigs are supported here.']
        },
      ]
      args: []
    },
    {
      name: 'joinGroup'
      docs: [
        'Tokens join a group once (batched; pool owner, plus the group owner unless open), with the',
        'remote tokens their group-driven lanes are created with.',
      ]
      accounts: [
        { name: 'group'; isMut: false; isSigner: false },
        {
          name: 'groupRegistry'
          isMut: true
          isSigner: false
          docs: ['join. Loaded and checked by the handlers.']
        },
        {
          name: 'groupOwner'
          isMut: false
          isSigner: true
          isOptional: true
          docs: ['`join_group` only: required unless the group has open membership.']
        },
        { name: 'authority'; isMut: true; isSigner: true },
        { name: 'systemProgram'; isMut: false; isSigner: false },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'JoinGroupParams' } }]
    },
    {
      name: 'linkLanes'
      docs: ['Links existing lanes of one chain to a group in place (batched).']
      accounts: [
        { name: 'group'; isMut: false; isSigner: false },
        { name: 'groupChainPolicy'; isMut: true; isSigner: false },
        {
          name: 'groupOwner'
          isMut: false
          isSigner: true
          isOptional: true
          docs: ['Required unless the group has open membership.']
        },
        { name: 'authority'; isMut: true; isSigner: true },
        { name: 'systemProgram'; isMut: false; isSigner: false },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'LinkLanesParams' } }]
    },
    {
      name: 'lockOrBurnTokens'
      docs: [
        "Burns tokens from the sender's account as part of an outbound",
        'cross-chain transfer. Called by the router via CPI after the onramp',
        'has validated the message.',
      ]
      accounts: [
        { name: 'authority'; isMut: false; isSigner: true },
        { name: 'state'; isMut: false; isSigner: false },
        { name: 'tokenProgram'; isMut: false; isSigner: false },
        { name: 'mint'; isMut: true; isSigner: false },
        { name: 'poolSigner'; isMut: false; isSigner: false },
        { name: 'poolTokenAccount'; isMut: true; isSigner: false },
        { name: 'rmnRemote'; isMut: false; isSigner: false },
        { name: 'rmnRemoteCurses'; isMut: false; isSigner: false },
        { name: 'rmnRemoteConfig'; isMut: false; isSigner: false },
        { name: 'chainConfig'; isMut: true; isSigner: false },
      ]
      args: [{ name: 'lockOrBurn'; type: { defined: 'LockOrBurnInV1' } }]
      returns: { defined: 'LockOrBurnOutV1' }
    },
    {
      name: 'lockOrBurnTokensV2'
      docs: ['Burns tokens from the pool as part of an outbound cross-chain transfer (V2).']
      accounts: [
        { name: 'authority'; isMut: false; isSigner: true },
        { name: 'state'; isMut: false; isSigner: false },
        { name: 'tokenProgram'; isMut: false; isSigner: false },
        { name: 'mint'; isMut: true; isSigner: false },
        { name: 'poolSigner'; isMut: false; isSigner: false },
        { name: 'poolTokenAccount'; isMut: true; isSigner: false },
        { name: 'chainConfig'; isMut: true; isSigner: false },
        {
          name: 'chainConfigV2'
          isMut: false
          isSigner: false
          docs: ['May or may not be initialized']
        },
        {
          name: 'chainConfigOverride'
          isMut: true
          isSigner: false
          docs: [
            'When initialized (owner == this program), its rate limit buckets',
            'override the default ones for faster-than-finality transfers.',
          ]
        },
        {
          name: 'feeVaultTokenAccount'
          isMut: true
          isSigner: false
          docs: [
            'token-pool receipt fees into. In-token BPS fees accrue here until the owner withdraws them',
            'with `withdraw_fee_tokens`. The vault PDA is derived inline rather than passed in: it holds',
            'no data and never signs here, and every account this instruction takes costs 32 bytes of a',
            '`ccip_send` transaction that is already close to the size limit.',
          ]
        },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'lockOrBurn'; type: { defined: 'LockOrBurnInV2' } }]
      returns: { defined: 'LockOrBurnOutV2' }
    },
    {
      name: 'materializeGroupLanes'
      docs: ['Creates the group-driven lanes the group enables (batched, permissionless).']
      accounts: [
        { name: 'group'; isMut: false; isSigner: false },
        { name: 'groupChainPolicy'; isMut: true; isSigner: false },
        {
          name: 'groupRegistry'
          isMut: false
          isSigner: false
          docs: ['`set_group_chain_lanes` for the next member index.']
        },
        { name: 'authority'; isMut: true; isSigner: true },
        { name: 'systemProgram'; isMut: false; isSigner: false },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'remoteChainSelector'; type: 'u64' }]
    },
    {
      name: 'nestedResolveAccountsStart'
      docs: [
        'Resolves the accounts needed for V2 lock_or_burn or release_or_mint',
        'instructions based on the instruction discriminator.',
      ]
      accounts: [{ name: 'state'; isMut: false; isSigner: false }]
      args: [{ name: 'params'; type: { defined: 'NestedResolveAccountsParams' } }]
      returns: { defined: 'NestedResolveAccountsResponse' }
    },
    {
      name: 'observeChainConfig'
      docs: [
        "Returns a pool's configuration for a single remote chain, for observability consumers.",
        'Rate limiter buckets are reported as of now, i.e. including the refill accrued since the',
        'last transfer.',
        '',
        'Permissionless and read-only: meant to be executed through `simulateTransaction`. Fails if',
        'the lane has no chain config, which callers can read as "not configured".',
      ]
      accounts: [{ name: 'chainConfig'; isMut: false; isSigner: false }]
      args: [{ name: 'remoteChainSelector'; type: 'u64' }, { name: 'mint'; type: 'publicKey' }]
      returns: { defined: 'PoolChainConfigObservation' }
    },
    {
      name: 'observeChainConfigOverride'
      docs: [
        "Returns a pool's rate limit override for a single remote chain and override type, for",
        'observability consumers. Rate limiter buckets are reported as of now, i.e. including the',
        'refill accrued since the last transfer.',
        '',
        'Permissionless and read-only: meant to be executed through `simulateTransaction`. Fails if',
        'the lane has no override of that type, which callers can read as "not overridden".',
      ]
      accounts: [{ name: 'chainConfigOverride'; isMut: false; isSigner: false }]
      args: [
        { name: 'remoteChainSelector'; type: 'u64' },
        { name: 'mint'; type: 'publicKey' },
        { name: 'overrideType'; type: { defined: 'PoolChainConfigOverrideType' } },
      ]
      returns: { defined: 'PoolChainConfigOverrideObservation' }
    },
    {
      name: 'observeChainConfigV2'
      docs: [
        "Returns a pool's CCIP 2.0 CCV configuration for a single remote chain, for observability",
        'consumers.',
        '',
        'Permissionless and read-only: meant to be executed through `simulateTransaction`. Fails if',
        'the lane has no CCV config, which callers can read as "not configured".',
      ]
      accounts: [{ name: 'chainConfigV2'; isMut: false; isSigner: false }]
      args: [{ name: 'remoteChainSelector'; type: 'u64' }, { name: 'mint'; type: 'publicKey' }]
      returns: { defined: 'PoolChainConfigV2Observation' }
    },
    {
      name: 'observeGroup'
      docs: ["Returns a group's root (owner, roles, settings, chains). Read-only."]
      accounts: [{ name: 'group'; isMut: false; isSigner: false }]
      args: []
      returns: { defined: 'GroupObservation' }
    },
    {
      name: 'observeGroupChainPolicy'
      docs: ['Returns a group chain record. Read-only.']
      accounts: [{ name: 'groupChainPolicy'; isMut: false; isSigner: false }]
      args: []
      returns: { defined: 'GroupChainPolicyObservation' }
    },
    {
      name: 'observeHooks'
      docs: [
        "Returns a security section's hooks, its lists' admins and the group's hook authority",
        '(a `Group`, `Policy` or chain record; the lists as optional remaining accounts). Read-only.',
      ]
      accounts: [
        { name: 'record'; isMut: false; isSigner: false; docs: ['apart by its discriminator.'] },
      ]
      args: []
      returns: { defined: 'HookObservation' }
    },
    {
      name: 'observeLaneGroup'
      docs: [
        "Returns a lane's effective group configuration (the group chain record as remaining account",
        'when linked). Read-only.',
      ]
      accounts: [
        { name: 'chainConfig'; isMut: false; isSigner: false },
        { name: 'chainConfigV2'; isMut: false; isSigner: false },
        { name: 'chainConfigOverride'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'ObserveLaneGroupParams' } }]
      returns: { defined: 'LaneGroupObservation' }
    },
    {
      name: 'observeState'
      docs: [
        "Returns a pool's per-mint configuration, for observability consumers.",
        '',
        'Permissionless and read-only: meant to be executed through `simulateTransaction`. The',
        'allow list is reported as a count only.',
      ]
      accounts: [{ name: 'state'; isMut: false; isSigner: false }]
      args: [{ name: 'mint'; type: 'publicKey' }]
      returns: { defined: 'PoolStateObservation' }
    },
    {
      name: 'releaseOrMintTokens'
      docs: [
        "Mints tokens to the receiver's account as part of an inbound",
        'cross-chain transfer. Called by the offramp via CPI after the',
        'message has been verified and committed.',
      ]
      accounts: [
        { name: 'authority'; isMut: false; isSigner: true },
        {
          name: 'offrampProgram'
          isMut: false
          isSigner: false
          docs: [
            'CHECK offramp program: exists only to derive the allowed offramp PDA',
            'and the authority PDA.',
          ]
        },
        {
          name: 'allowedOfframp'
          isMut: false
          isSigner: false
          docs: [
            'CHECK PDA of the router program verifying the signer is an allowed offramp.',
            "If PDA does not exist, the router doesn't allow this offramp",
          ]
        },
        { name: 'state'; isMut: false; isSigner: false },
        { name: 'tokenProgram'; isMut: false; isSigner: false },
        { name: 'mint'; isMut: true; isSigner: false },
        { name: 'poolSigner'; isMut: false; isSigner: false },
        { name: 'poolTokenAccount'; isMut: true; isSigner: false },
        { name: 'chainConfig'; isMut: true; isSigner: false },
        { name: 'rmnRemote'; isMut: false; isSigner: false },
        { name: 'rmnRemoteCurses'; isMut: false; isSigner: false },
        { name: 'rmnRemoteConfig'; isMut: false; isSigner: false },
        { name: 'receiverTokenAccount'; isMut: true; isSigner: false },
      ]
      args: [{ name: 'releaseOrMint'; type: { defined: 'ReleaseOrMintInV1' } }]
      returns: { defined: 'ReleaseOrMintOutV1' }
    },
    {
      name: 'releaseOrMintTokensV2'
      docs: ['Mints tokens to the receiver as part of an inbound cross-chain transfer (V2).']
      accounts: [
        { name: 'authority'; isMut: false; isSigner: true },
        {
          name: 'offrampProgram'
          isMut: false
          isSigner: false
          docs: [
            'CHECK offramp program: exists only to derive the allowed offramp PDA',
            'and the authority PDA.',
          ]
        },
        {
          name: 'allowedOfframp'
          isMut: false
          isSigner: false
          docs: [
            'CHECK PDA of the router program verifying the signer is an allowed offramp.',
            "If PDA does not exist, the router doesn't allow this offramp",
          ]
        },
        { name: 'state'; isMut: false; isSigner: false },
        { name: 'tokenProgram'; isMut: false; isSigner: false },
        { name: 'mint'; isMut: true; isSigner: false },
        { name: 'poolSigner'; isMut: false; isSigner: false },
        { name: 'poolTokenAccount'; isMut: true; isSigner: false },
        { name: 'chainConfig'; isMut: true; isSigner: false },
        {
          name: 'chainConfigOverride'
          isMut: true
          isSigner: false
          docs: [
            'When initialized (owner == this program), its rate limit buckets',
            'override the default ones for faster-than-finality transfers.',
          ]
        },
        { name: 'receiverTokenAccount'; isMut: true; isSigner: false },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'releaseOrMint'; type: { defined: 'ReleaseOrMintInV2' } }]
      returns: { defined: 'ReleaseOrMintOutV2' }
    },
    {
      name: 'removeFromAllowList'
      docs: ['Removes addresses from the allow-list.']
      accounts: [
        { name: 'state'; isMut: true; isSigner: false },
        { name: 'mint'; isMut: false; isSigner: false },
        { name: 'authority'; isMut: true; isSigner: true },
        { name: 'systemProgram'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'remove'; type: { vec: 'publicKey' } }]
    },
    {
      name: 'removeGroupChain'
      docs: ['Closes a group chain record that no lane uses.']
      accounts: [
        { name: 'group'; isMut: true; isSigner: false },
        { name: 'groupChainPolicy'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: false; isSigner: true },
        {
          name: 'rentReceiver'
          isMut: true
          isSigner: false
          docs: [
            "The group owner receives the closed account's rent, whoever closes it (review 2d N8).",
          ]
        },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'RemoveGroupChainParams' } }]
    },
    {
      name: 'resetLaneBuckets'
      docs: ["Refills member lanes' buckets to the group's capacities (batched)."]
      accounts: [
        { name: 'group'; isMut: false; isSigner: false },
        { name: 'groupChainPolicy'; isMut: false; isSigner: false },
        { name: 'authority'; isMut: false; isSigner: true },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'ResetLaneBucketsParams' } }]
    },
    {
      name: 'resetPolicySecurity'
      docs: [
        "After an ownership change, resets a named policy's SECURITY (owner only; the `Policy` and all",
        'its records as remaining accounts).',
      ]
      accounts: [
        { name: 'group'; isMut: true; isSigner: false },
        {
          name: 'authority'
          isMut: false
          isSigner: true
          docs: ['Checked by each handler: the security admin schedules, the owner does the rest.']
        },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'ResetPolicySecurityParams' } }]
    },
    {
      name: 'scheduleGroupCcvs'
      docs: [
        'Schedules a CCV set on the group default or one chain record (security admin; at least',
        '`min_ccv_activation_delay` ahead). Non-empty lists keep INCLUDE_DEFAULT_CCVS unless the',
        'owner allowed dropping the defaults.',
      ]
      accounts: [
        { name: 'group'; isMut: true; isSigner: false },
        {
          name: 'authority'
          isMut: false
          isSigner: true
          docs: ['Checked by each handler: the security admin schedules, the owner does the rest.']
        },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'ScheduleGroupCcvsParams' } }]
    },
    {
      name: 'setAllowDroppingDefaultCcvs'
      docs: ["Lets a security record's CCV lists leave out the lane defaults (group owner)."]
      accounts: [
        { name: 'group'; isMut: true; isSigner: false },
        {
          name: 'authority'
          isMut: false
          isSigner: true
          docs: ['Checked by each handler: the security admin schedules, the owner does the rest.']
        },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'SetAllowDroppingDefaultCcvsParams' } }]
    },
    {
      name: 'setChainConfigOverrideRateLimit'
      docs: [
        'Updates the rate limits on a ChainConfigOverride PDA.',
        'Callable by the pool owner or the rate-limit admin.',
      ]
      accounts: [
        { name: 'state'; isMut: false; isSigner: false },
        { name: 'chainConfigOverride'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: false; isSigner: true },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'SetChainConfigOverrideRateLimitParams' } }]
    },
    {
      name: 'setChainRateLimit'
      docs: [
        'Updates the inbound and outbound rate limits for a specific remote chain.',
        'Callable by either the pool owner or the rate-limit admin.',
      ]
      accounts: [
        { name: 'state'; isMut: false; isSigner: false },
        { name: 'chainConfig'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: true; isSigner: true },
      ]
      args: [
        { name: 'remoteChainSelector'; type: 'u64' },
        { name: 'mint'; type: 'publicKey' },
        { name: 'inbound'; type: { defined: 'RateLimitConfig' } },
        { name: 'outbound'; type: { defined: 'RateLimitConfig' } },
      ]
    },
    {
      name: 'setGroupChainLanes'
      docs: ["Enables a chain's group-driven lanes for every member or a subset, in one write."]
      accounts: [
        { name: 'group'; isMut: false; isSigner: false },
        { name: 'groupChainPolicy'; isMut: true; isSigner: false },
        {
          name: 'groupRegistry'
          isMut: false
          isSigner: false
          docs: ['`set_group_chain_lanes` for the next member index.']
        },
        { name: 'authority'; isMut: true; isSigner: true },
        { name: 'systemProgram'; isMut: false; isSigner: false },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [
        { name: 'remoteChainSelector'; type: 'u64' },
        { name: 'params'; type: { defined: 'SetGroupChainLanesParams' } },
      ]
    },
    {
      name: 'setGroupChainPause'
      docs: ['Pauses or unpauses, per direction, every member lane of the group on one chain.']
      accounts: [
        { name: 'group'; isMut: false; isSigner: false },
        { name: 'groupChainPolicy'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: false; isSigner: true },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'SetGroupChainPauseParams' } }]
    },
    {
      name: 'setGroupChainPolicy'
      docs: ['Sets one policy class of one chain record explicitly.']
      accounts: [
        { name: 'group'; isMut: false; isSigner: false },
        { name: 'groupChainPolicy'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: false; isSigner: true },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'SetGroupChainPolicyParams' } }]
    },
    {
      name: 'setGroupDefault'
      docs: [
        'Sets one class of the group default and writes it into every chain record that follows the',
        'default (all chain records as remaining accounts).',
      ]
      accounts: [
        { name: 'group'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: false; isSigner: true },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'SetGroupDefaultParams' } }]
    },
    {
      name: 'setGroupPause'
      docs: [
        'Pauses or unpauses every member lane of the group (all chain records as remaining accounts).',
      ]
      accounts: [
        { name: 'group'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: false; isSigner: true },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'SetGroupPauseParams' } }]
    },
    {
      name: 'setGroupRoles'
      docs: ['Sets every group role. Owner only.']
      accounts: [
        { name: 'group'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: false; isSigner: true },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'SetGroupRolesParams' } }]
    },
    {
      name: 'setGroupSettings'
      docs: [
        "Updates open membership and lowers the group's maximum BPS fee (all chain records as",
        'remaining accounts when lowering). Owner only.',
      ]
      accounts: [
        { name: 'group'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: false; isSigner: true },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'SetGroupSettingsParams' } }]
    },
    {
      name: 'setHookConfig'
      docs: ["Sets a security section's allowlist and blocklist hooks."]
      accounts: [
        { name: 'group'; isMut: true; isSigner: false },
        {
          name: 'authority'
          isMut: false
          isSigner: true
          docs: ['The owner, or (only to add hooks where there were none) the security admin.']
        },
        { name: 'allowlist'; isMut: false; isSigner: false; isOptional: true },
        { name: 'blocklist'; isMut: false; isSigner: false; isOptional: true },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'SetHookConfigParams' } }]
    },
    {
      name: 'setLanePause'
      docs: [
        'Pauses or unpauses, per direction, lanes of one mint (their `ChainConfigV2` accounts as',
        'remaining accounts).',
      ]
      accounts: [
        {
          name: 'state'
          isMut: false
          isSigner: false
          docs: [
            '`State` keeps no bump, so its address is bound through its mint: only `initialize` creates',
            '`State` accounts, at `[POOL_STATE_SEED, mint]`.',
          ]
        },
        { name: 'group'; isMut: false; isSigner: false },
        {
          name: 'authority'
          isMut: true
          isSigner: true
          docs: [
            "The lane owner (`State.owner`) may always set its lanes' flags. Otherwise setting a flag",
            'needs the group owner or pauser and clearing one the group owner or unpauser; checked per',
            'lane in the handler.',
          ]
        },
        { name: 'systemProgram'; isMut: false; isSigner: false },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'SetLanePauseParams' } }]
    },
    {
      name: 'setLanePoolData'
      docs: [
        "Sets a lane's own pool-data format and factory UID, used while its CONNECTION class is",
        'inline (the group chain record as remaining account when linked). Lane owner only.',
      ]
      accounts: [
        {
          name: 'state'
          isMut: false
          isSigner: false
          docs: [
            '`State` keeps no bump, so its address is bound through its mint: only `initialize` creates',
            '`State` accounts, at `[POOL_STATE_SEED, mint]`.',
          ]
        },
        {
          name: 'chainConfigV2'
          isMut: true
          isSigner: false
          docs: ['Resized by the handler, which keeps the body (see `LaneConfigV2::store`).']
        },
        {
          name: 'chainConfig'
          isMut: true
          isSigner: false
          docs: [
            '`LANE_EXTENDED_MARKER`). Loaded and checked at its PDA by the handler (it keeps no bump).',
          ]
        },
        { name: 'authority'; isMut: true; isSigner: true },
        { name: 'systemProgram'; isMut: false; isSigner: false },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'SetLanePoolDataParams' } }]
    },
    {
      name: 'setMemberRemoteTokens'
      docs: ["Replaces members' remote tokens (batched; pool owner)."]
      accounts: [
        { name: 'group'; isMut: false; isSigner: false },
        {
          name: 'groupRegistry'
          isMut: true
          isSigner: false
          docs: ['join. Loaded and checked by the handlers.']
        },
        {
          name: 'groupOwner'
          isMut: false
          isSigner: true
          isOptional: true
          docs: ['`join_group` only: required unless the group has open membership.']
        },
        { name: 'authority'; isMut: true; isSigner: true },
        { name: 'systemProgram'; isMut: false; isSigner: false },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'SetMemberRemoteTokensParams' } }]
    },
    {
      name: 'setPolicyDefault'
      docs: [
        "Sets one class of a named policy's default and writes it into every chain record of the",
        'policy that follows the default (all of them as remaining accounts).',
      ]
      accounts: [
        { name: 'group'; isMut: false; isSigner: false },
        { name: 'policy'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: false; isSigner: true },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'SetPolicyDefaultParams' } }]
    },
    {
      name: 'setPolicyEngine'
      docs: [
        "Sets a security section's policy engine (attach on the new one, detach on the old one",
        'unless `skip_detach`).',
      ]
      accounts: [
        { name: 'group'; isMut: true; isSigner: false },
        {
          name: 'authority'
          isMut: false
          isSigner: true
          docs: ['Checked by each handler: the security admin schedules, the owner does the rest.']
        },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'SetPolicyEngineParams' } }]
    },
    {
      name: 'setRateLimitAdmin'
      docs: [
        'Sets the rate-limit admin for a token pool.',
        'The rate-limit admin may call set_chain_rate_limit without being the pool owner.',
      ]
      accounts: [
        { name: 'state'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: true; isSigner: true },
      ]
      args: [{ name: 'mint'; type: 'publicKey' }, { name: 'newRateLimitAdmin'; type: 'publicKey' }]
    },
    {
      name: 'setRmn'
      docs: [
        "Updates the RMN Remote address on an individual token pool's State.",
        'Only callable by the upgrade authority if they also own the pool.',
      ]
      accounts: [
        { name: 'state'; isMut: true; isSigner: false },
        { name: 'mint'; isMut: false; isSigner: false },
        { name: 'authority'; isMut: true; isSigner: true },
        { name: 'program'; isMut: false; isSigner: false },
        { name: 'programData'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'rmnAddress'; type: 'publicKey' }]
    },
    {
      name: 'setRouter'
      docs: [
        "Updates the router address on an individual token pool's State.",
        'Changes the expected signer for lock/burn and release/mint calls.',
        'Only callable by the upgrade authority if they also own the pool.',
      ]
      accounts: [
        { name: 'state'; isMut: true; isSigner: false },
        { name: 'mint'; isMut: false; isSigner: false },
        { name: 'authority'; isMut: true; isSigner: true },
        { name: 'program'; isMut: false; isSigner: false },
        { name: 'programData'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'newRouter'; type: 'publicKey' }]
    },
    {
      name: 'syncGroupCcvs'
      docs: ["Copies a chain record's CCVs into member lanes (permissionless, batched)."]
      accounts: [
        { name: 'group'; isMut: false; isSigner: false },
        { name: 'groupChainPolicy'; isMut: false; isSigner: false },
        {
          name: 'payer'
          isMut: true
          isSigner: true
          docs: ['Anyone: the copy is group-authorized data. Pays any growth of the lane accounts.']
        },
        { name: 'systemProgram'; isMut: false; isSigner: false },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'SyncGroupCcvsParams' } }]
    },
    {
      name: 'syncPolicyCcvs'
      docs: [
        "Copies a named policy's chain record CCVs into the lanes taking SECURITY from it",
        '(permissionless, batched).',
      ]
      accounts: [
        { name: 'group'; isMut: false; isSigner: false },
        {
          name: 'policyChainRecord'
          isMut: false
          isSigner: false
          docs: [
            "The policy's record for `params.remote_chain_selector`, PDA-checked by the handler against",
            '`[POLICY_SEED, group, params.policy_id]` with its stored bump.',
          ]
        },
        {
          name: 'payer'
          isMut: true
          isSigner: true
          docs: ['Anyone: the copy is group-authorized data. Pays any growth of the lane accounts.']
        },
        { name: 'systemProgram'; isMut: false; isSigner: false },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'SyncPolicyCcvsParams' } }]
    },
    {
      name: 'transferGroupOwnership'
      docs: ['Proposes a new group owner, who must call `accept_group_ownership`.']
      accounts: [
        { name: 'group'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: false; isSigner: true },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'TransferGroupOwnershipParams' } }]
    },
    {
      name: 'transferListAdmin'
      docs: ['Proposes a new admin for an allowlist or blocklist (current admin).']
      accounts: [
        { name: 'list'; isMut: true; isSigner: false },
        {
          name: 'authority'
          isMut: false
          isSigner: true
          docs: [
            'The admin (transfer) or the proposed admin (accept), checked by the handler. For an',
            "allowlist, also its group's owner, who may always propose a new admin (review 2e S1).",
          ]
        },
        {
          name: 'group'
          isMut: false
          isSigner: false
          isOptional: true
          docs: ["The allowlist's group, when its owner transfers the admin role."]
        },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'TransferListAdminParams' } }]
    },
    {
      name: 'transferMintAuthorityToMultisig'
      docs: [
        'Transfers the mint authority from the pool-signer PDA to a multisig.',
        'Used when an operator wants shared, multi-party control over minting.',
        'Only the program upgrade authority may invoke this.',
      ]
      accounts: [
        { name: 'state'; isMut: true; isSigner: false },
        { name: 'mint'; isMut: true; isSigner: false },
        { name: 'tokenProgram'; isMut: false; isSigner: false },
        { name: 'poolSigner'; isMut: false; isSigner: false },
        { name: 'authority'; isMut: false; isSigner: true },
        { name: 'newMultisigMintAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
        { name: 'programData'; isMut: false; isSigner: false },
      ]
      args: []
    },
    {
      name: 'transferMintAuthorityToPdaSigner'
      docs: [
        'Transfers the mint authority back from a multisig to the pool-signer PDA.',
        'Used during migration cleanup to revert from a multisig back to direct',
        'pool-signer control.',
      ]
      accounts: [
        { name: 'state'; isMut: false; isSigner: false },
        { name: 'mint'; isMut: true; isSigner: false },
        { name: 'tokenProgram'; isMut: false; isSigner: false },
        { name: 'poolSigner'; isMut: false; isSigner: false },
        { name: 'authority'; isMut: false; isSigner: true },
        { name: 'currentMintAuthorityAccount'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
        { name: 'programData'; isMut: false; isSigner: false },
      ]
      args: []
    },
    {
      name: 'transferOwnership'
      docs: [
        'Initiates an ownership transfer for this token pool to a new proposed owner.',
        'The proposed owner must call accept_ownership to complete the handover.',
      ]
      accounts: [
        { name: 'state'; isMut: true; isSigner: false },
        { name: 'mint'; isMut: false; isSigner: false },
        { name: 'authority'; isMut: false; isSigner: true },
      ]
      args: [{ name: 'proposedOwner'; type: 'publicKey' }]
    },
    {
      name: 'typeVersion'
      docs: [
        'Returns the program type (name) and version string encoded at build time.',
        'Offchain code calls this to confirm which program and version is deployed',
        'before sending any other instruction.',
      ]
      accounts: []
      args: []
      returns: 'string'
    },
    {
      name: 'unlinkLanes'
      docs: [
        'Unlinks lanes of one chain from a group, restoring their own configuration (batched).',
      ]
      accounts: [
        { name: 'group'; isMut: false; isSigner: false },
        { name: 'groupChainPolicy'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: true; isSigner: true },
        { name: 'systemProgram'; isMut: false; isSigner: false },
        { name: 'eventAuthority'; isMut: false; isSigner: false },
        { name: 'program'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'params'; type: { defined: 'UnlinkLanesParams' } }]
    },
    {
      name: 'updateDefaultRmn'
      docs: [
        'Updates the default RMN Remote address stored in PoolConfig.',
        'New token pools created after this call will use the new RMN Remote.',
      ]
      accounts: [
        { name: 'config'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: false; isSigner: true },
        { name: 'program'; isMut: false; isSigner: false },
        { name: 'programData'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'rmnAddress'; type: 'publicKey' }]
    },
    {
      name: 'updateDefaultRouter'
      docs: [
        'Updates the default router address stored in PoolConfig.',
        'New token pools created after this call will use the new router.',
      ]
      accounts: [
        { name: 'config'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: false; isSigner: true },
        { name: 'program'; isMut: false; isSigner: false },
        { name: 'programData'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'routerAddress'; type: 'publicKey' }]
    },
    {
      name: 'updateSelfServedAllowed'
      docs: [
        'Enables or disables self-served pool initialization.',
        'When enabled, any mint authority may create a pool for their mint',
        'without requiring the program upgrade authority.',
      ]
      accounts: [
        { name: 'config'; isMut: true; isSigner: false },
        { name: 'authority'; isMut: false; isSigner: true },
        { name: 'program'; isMut: false; isSigner: false },
        { name: 'programData'; isMut: false; isSigner: false },
      ]
      args: [{ name: 'selfServedAllowed'; type: 'bool' }]
    },
    {
      name: 'withdrawFeeTokens'
      docs: [
        'Sweeps the fees this pool accrued for `mint` in a single fee token into a recipient token',
        "account of the pool owner's choosing. Restricted to the pool owner.",
        '',
        'If `amount` is provided, only the requested amount is transferred. Otherwise (if None) the',
        'entire balance is transferred.',
      ]
      accounts: [
        { name: 'state'; isMut: false; isSigner: false },
        {
          name: 'mint'
          isMut: false
          isSigner: false
          docs: [
            'The token this pool wraps. Unrelated to `fee_token_mint`, but part of the fee vault seeds.',
          ]
        },
        { name: 'feeVault'; isMut: false; isSigner: false },
        { name: 'feeVaultTokenAccount'; isMut: true; isSigner: false },
        {
          name: 'recipient'
          isMut: true
          isSigner: false
          docs: [
            'Where the fees go. Freely chosen by the pool owner, unlike the executor and the CCVs, which',
            'pin the destination to a `fee_aggregator` held in their config.',
          ]
        },
        {
          name: 'feeTokenMint'
          isMut: false
          isSigner: false
          docs: [
            'The token the fees were billed in, which is whatever the sender paid with, so a pool',
            'accrues one vault ATA per fee token it has ever been paid in.',
          ]
        },
        { name: 'feeTokenProgram'; isMut: false; isSigner: false },
        { name: 'authority'; isMut: false; isSigner: true },
      ]
      args: [{ name: 'amount'; type: { option: 'u64' } }]
    },
  ]
  accounts: [
    {
      name: 'allowlist'
      type: {
        kind: 'struct'
        fields: [
          { name: 'version'; type: 'u8' },
          { name: 'bump'; type: 'u8' },
          { name: 'group'; type: 'publicKey' },
          { name: 'listId'; type: 'publicKey' },
          { name: 'admin'; type: 'publicKey' },
          { name: 'proposedAdmin'; type: 'publicKey' },
          { name: 'enabled'; type: 'bool' },
          { name: 'entryCount'; type: 'u32' },
          { name: 'reserved'; type: { array: ['u8', 32] } },
        ]
      }
    },
    {
      name: 'blocklist'
      type: {
        kind: 'struct'
        fields: [
          { name: 'version'; type: 'u8' },
          { name: 'bump'; type: 'u8' },
          { name: 'creator'; type: 'publicKey' },
          { name: 'blocklistId'; type: 'publicKey' },
          { name: 'admin'; type: 'publicKey' },
          { name: 'proposedAdmin'; type: 'publicKey' },
          { name: 'entryCount'; type: 'u32' },
          { name: 'reserved'; type: { array: ['u8', 32] } },
        ]
      }
    },
    {
      name: 'chainConfig'
      type: { kind: 'struct'; fields: [{ name: 'base'; type: { defined: 'BaseChain' } }] }
    },
    {
      name: 'chainConfigOverride'
      type: {
        kind: 'struct'
        fields: [
          { name: 'bump'; type: 'u8' },
          { name: 'version'; type: 'u8' },
          { name: 'base'; type: { defined: 'BaseOverrideConfig' } },
        ]
      }
    },
    {
      name: 'chainConfigV2'
      type: {
        kind: 'struct'
        fields: [
          { name: 'bump'; type: 'u8' },
          { name: 'version'; type: 'u8' },
          { name: 'remoteChainSelector'; type: 'u64' },
          { name: 'mint'; type: 'publicKey' },
          {
            name: 'allowedFinalityConfig'
            docs: [
              'Allowed finality policy for *outbound* (lock_or_burn) transfers on this lane.',
              "Mirrors EVM's pool-wide `s_allowedFinalityConfig`. Zero-initialized",
              '(`WAIT_FOR_FINALITY`) means only full-finality transfers are permitted.',
            ]
            type: { defined: 'FinalityConfig' }
          },
          { name: 'tokenTransferFeeConfig'; type: { defined: 'TokenTransferFeeConfig' } },
          { name: 'ccvConfig'; type: { defined: 'CCVConfig' } },
        ]
      }
    },
    {
      name: 'group'
      type: {
        kind: 'struct'
        fields: [
          { name: 'version'; type: 'u8' },
          { name: 'bump'; type: 'u8' },
          {
            name: 'groupId'
            docs: ['Chosen by the creator; only used to derive the address.']
            type: 'publicKey'
          },
          { name: 'owner'; type: 'publicKey' },
          { name: 'proposedOwner'; type: 'publicKey' },
          { name: 'roles'; type: { defined: 'GroupRoles' } },
          {
            name: 'maxBpsFee'
            docs: [
              "Cap on every BPS fee of the group's records. Only the owner can change it, and only down.",
            ]
            type: 'u16'
          },
          {
            name: 'openMembership'
            docs: [
              'When set, joining needs only the lane owner; otherwise the group owner must co-sign.',
            ]
            type: 'bool'
          },
          {
            name: 'paused'
            docs: [
              'Mirrors `GroupChainPolicy.group_paused`, so records added while paused start paused.',
            ]
            type: 'bool'
          },
          {
            name: 'minCcvActivationDelay'
            docs: [
              'Minimum notice, in seconds, for a scheduled CCV change (at most',
              '`MAX_MIN_CCV_ACTIVATION_DELAY`). A decrease waits out the notice in force (see',
              '`pending_min_ccv_activation_delay`).',
            ]
            type: 'u64'
          },
          { name: 'defaultPolicy'; type: { defined: 'PolicySections' } },
          {
            name: 'ccvEpochCounter'
            docs: [
              'Group-wide CCV epoch counter: every scheduled set of the group (default or chain record)',
              'takes the next value, so no two sets ever share an epoch (review 2c B1).',
            ]
            type: 'u64'
          },
          {
            name: 'pendingMinCcvActivationDelay'
            docs: [
              'A lowered `min_ccv_activation_delay`, applied from `pending_min_ccv_activation_delay_at`',
              '(0 = none).',
            ]
            type: 'u64'
          },
          { name: 'pendingMinCcvActivationDelayAt'; type: 'i64' },
          {
            name: 'nextPolicyId'
            docs: [
              'Named policies are numbered `0..next_policy_id` (`create_policy` takes the next id), so the',
              'group can enumerate them (`observe_group`), closed ones leaving gaps.',
            ]
            type: 'u32'
          },
          {
            name: 'securityGeneration'
            docs: [
              'Bumped on every ownership acceptance (review 2d S3). Named SECURITY records carry the',
              'generation they were last reset or written in; a record from an older generation fails closed',
              'until the new owner resets it (`reset_policy_security`).',
            ]
            type: 'u32'
          },
          {
            name: 'hookLookupTable'
            docs: [
              "An address lookup table the owner keeps with the group's static hook accounts (named",
              'records, hook authority, engine program and statics). The resolvers return it with the hook',
              'accounts, so a lane with four named slots and every hook still fits a transaction (review 2e',
              'S4). Carved from `reserved`: `Pubkey::default()` = none.',
            ]
            type: 'publicKey'
          },
          {
            name: 'chainSelectors'
            docs: [
              'Chains the group has a `GroupChainPolicy` for. Group-wide writes take all of them.',
            ]
            type: { vec: 'u64' }
          },
        ]
      }
    },
    {
      name: 'groupChainPolicy'
      type: {
        kind: 'struct'
        fields: [
          { name: 'version'; type: 'u8' },
          { name: 'bump'; type: 'u8' },
          { name: 'group'; type: 'publicKey' },
          { name: 'remoteChainSelector'; type: 'u64' },
          {
            name: 'inheritsDefault'
            docs: [
              'One bit per `PolicyClass` (`PolicyClass::bit`): the class follows the group default.',
            ]
            type: 'u16'
          },
          { name: 'groupPaused'; type: 'bool' },
          { name: 'pausedOutbound'; type: 'bool' },
          { name: 'pausedInbound'; type: 'bool' },
          {
            name: 'memberLaneCount'
            docs: [
              'Lanes linked to the group on this chain. A record with members cannot be closed.',
            ]
            type: 'u32'
          },
          { name: 'policy'; type: { defined: 'PolicySections' } },
          {
            name: 'poolDataDemand'
            docs: ["What the member lanes need from `policy`'s pool-data settings."]
            type: { defined: 'PoolDataDemand' }
          },
          {
            name: 'maxBpsFee'
            docs: [
              'Mirror of `Group.max_bps_fee`, written by `add_group_chain` and `set_group_settings`, so the',
              'transfer path enforces the cap on any policy-sourced fee without another account (review 2d',
              'S2). `max_bps_fee_set` = false only on records written before the mirror existed.',
            ]
            type: 'u16'
          },
          { name: 'maxBpsFeeSet'; type: 'bool' },
          {
            name: 'securityGeneration'
            docs: ['Mirror of `Group.security_generation`, written on ownership acceptance.']
            type: 'u32'
          },
          {
            name: 'laneMode'
            docs: [
              'Group-driven lanes on this chain (increment 2f, `set_group_chain_lanes`): none, every',
              "member, or the members in the subset bitmap stored after the record's fixed allocation",
              '(see [`GROUP_CHAIN_POLICY_FIXED_LEN`]). Carved from `reserved`: older records read `Off`.',
            ]
            type: { defined: 'GroupLaneMode' }
          },
          {
            name: 'drivenLanesPaused'
            docs: [
              'Group-driven lanes on this chain are paused in both directions (they can be materialized',
              'and inspected, not used). Enabling a chain from `Off` must set it (review 2f S2); clearing it',
              'needs the owner or `unpauser`. Hand-linked lanes ignore it.',
            ]
            type: 'bool'
          },
          { name: 'reserved'; type: { array: ['u8', 42] } },
        ]
      }
    },
    {
      name: 'policy'
      type: {
        kind: 'struct'
        fields: [
          { name: 'version'; type: 'u8' },
          { name: 'bump'; type: 'u8' },
          { name: 'group'; type: 'publicKey' },
          { name: 'policyId'; type: 'u32' },
          {
            name: 'classes'
            docs: [
              'One bit per `PolicyClass` (`PolicyClass::bit`) the policy carries. Lanes may take only',
              'these classes from it, and only these sections are written.',
            ]
            type: 'u16'
          },
          { name: 'defaultPolicy'; type: { defined: 'PolicySections' } },
          {
            name: 'securityGeneration'
            docs: [
              "The group's `security_generation` this policy's SECURITY default was last reset or written in.",
            ]
            type: 'u32'
          },
          { name: 'reserved'; type: { array: ['u8', 60] } },
          {
            name: 'chainSelectors'
            docs: [
              'Chains the policy has a `PolicyChainRecord` for. A policy with records cannot be closed',
              '(`PolicyHasRecords`); policy-wide writes take all of them.',
            ]
            type: { vec: 'u64' }
          },
        ]
      }
    },
    {
      name: 'policyChainRecord'
      type: {
        kind: 'struct'
        fields: [
          { name: 'version'; type: 'u8' },
          { name: 'bump'; type: 'u8' },
          { name: 'policy'; type: 'publicKey' },
          { name: 'remoteChainSelector'; type: 'u64' },
          { name: 'group'; type: 'publicKey' },
          {
            name: 'classes'
            docs: ["Copied from the policy at creation (fixed for the policy's life)."]
            type: 'u16'
          },
          { name: 'inheritsDefault'; type: 'u16' },
          {
            name: 'laneRefCount'
            docs: [
              'Lanes referencing this record for any class. A record in use cannot be closed',
              '(`PolicyInUse`).',
            ]
            type: 'u32'
          },
          { name: 'sections'; type: { defined: 'PolicySections' } },
          {
            name: 'poolDataDemand'
            docs: ["What the referencing lanes need from `sections`' pool-data settings."]
            type: { defined: 'PoolDataDemand' }
          },
          {
            name: 'securityGeneration'
            docs: [
              "The group's `security_generation` this record's SECURITY section was last reset or written",
              'in; an older one fails transfers closed (review 2d S3).',
            ]
            type: 'u32'
          },
          { name: 'reserved'; type: { array: ['u8', 59] } },
        ]
      }
    },
    {
      name: 'poolConfig'
      type: {
        kind: 'struct'
        fields: [
          { name: 'version'; type: 'u8' },
          { name: 'selfServedAllowed'; type: 'bool' },
          { name: 'router'; type: 'publicKey' },
          { name: 'rmnRemote'; type: 'publicKey' },
        ]
      }
    },
    {
      name: 'state'
      type: {
        kind: 'struct'
        fields: [
          { name: 'version'; type: 'u8' },
          { name: 'config'; type: { defined: 'BaseConfig' } },
        ]
      }
    },
  ]
  types: [
    {
      name: 'ActivateGroupCcvsNowParams'
      type: {
        kind: 'struct'
        fields: [
          { name: 'remoteChainSelector'; type: { option: 'u64' } },
          { name: 'policyId'; type: { option: 'u32' } },
          { name: 'outbound'; type: { vec: 'publicKey' } },
          { name: 'inbound'; type: { vec: 'publicKey' } },
        ]
      }
    },
    {
      name: 'AddGroupChainParams'
      type: { kind: 'struct'; fields: [{ name: 'remoteChainSelector'; type: 'u64' }] }
    },
    {
      name: 'Allowlist'
      type: {
        kind: 'struct'
        fields: [
          { name: 'version'; type: 'u8' },
          { name: 'bump'; type: 'u8' },
          { name: 'group'; type: 'publicKey' },
          { name: 'listId'; type: 'publicKey' },
          { name: 'admin'; type: 'publicKey' },
          { name: 'proposedAdmin'; type: 'publicKey' },
          { name: 'enabled'; type: 'bool' },
          { name: 'entryCount'; type: 'u32' },
          { name: 'reserved'; type: { array: ['u8', 32] } },
        ]
      }
    },
    {
      name: 'ApplyListUpdatesParams'
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'adds'
            docs: [
              'Entries to add: senders (32-byte keys) for an allowlist; addresses of any chain (normalized',
              'before hashing) for a blocklist. Their entry PDAs follow as remaining accounts (writable),',
              'then those of `removes`, in order.',
            ]
            type: { vec: 'bytes' }
          },
          { name: 'removes'; type: { vec: 'bytes' } },
        ]
      }
    },
    {
      name: 'AssignLanePoliciesParams'
      type: {
        kind: 'struct'
        fields: [
          { name: 'remoteChainSelector'; type: 'u64' },
          {
            name: 'classSource'
            docs: [
              'Per `PolicyClass`: 0 = inline, 1 = the group default, 2..=5 = the named policy in',
              '`policy_slots[source - 2]`. Applied to every lane of the batch.',
            ]
            type: { array: ['u8', 4] }
          },
          {
            name: 'policySlots'
            docs: [
              'The named policies (`Policy` accounts) the slots hold; unused slots are the default key.',
            ]
            type: { array: ['publicKey', 4] }
          },
          {
            name: 'recordCount'
            docs: [
              'How many leading remaining accounts are `PolicyChainRecord`s (writable): every record',
              'referenced before or after by any lane of the batch, for this chain.',
            ]
            type: 'u8'
          },
        ]
      }
    },
    {
      name: 'BaseChain'
      type: {
        kind: 'struct'
        fields: [
          { name: 'remote'; type: { defined: 'RemoteConfig' } },
          { name: 'inboundRateLimit'; type: { defined: 'RateLimitTokenBucket' } },
          { name: 'outboundRateLimit'; type: { defined: 'RateLimitTokenBucket' } },
        ]
      }
    },
    {
      name: 'BaseConfig'
      type: {
        kind: 'struct'
        fields: [
          { name: 'tokenProgram'; type: 'publicKey' },
          { name: 'mint'; type: 'publicKey' },
          { name: 'decimals'; type: 'u8' },
          { name: 'poolSigner'; type: 'publicKey' },
          { name: 'poolTokenAccount'; type: 'publicKey' },
          { name: 'owner'; type: 'publicKey' },
          { name: 'proposedOwner'; type: 'publicKey' },
          { name: 'rateLimitAdmin'; type: 'publicKey' },
          { name: 'routerOnrampAuthority'; type: 'publicKey' },
          { name: 'router'; type: 'publicKey' },
          {
            name: 'rebalancer'
            docs: [
              'Set the rebalancer address for the pool; if set to the default "no rebalance" address',
              '(Pubkey::default()), no rebalance is allowed.',
            ]
            type: 'publicKey'
          },
          {
            name: 'canAcceptLiquidity'
            docs: [
              'DEPRECATED: this field is no longer enforced at runtime. It is kept for backward',
              'compatibility (no PDA migration) and is always initialized to `true`.',
              'To disable inflows operationally, set the rebalancer to `Pubkey::default()`.',
            ]
            type: 'bool'
          },
          { name: 'listEnabled'; type: 'bool' },
          { name: 'allowList'; type: { vec: 'publicKey' } },
          { name: 'rmnRemote'; type: 'publicKey' },
        ]
      }
    },
    {
      name: 'BaseOverrideConfig'
      type: {
        kind: 'struct'
        fields: [
          { name: 'remoteChainSelector'; type: 'u64' },
          { name: 'mint'; type: 'publicKey' },
          { name: 'inboundRateLimit'; type: { defined: 'RateLimitTokenBucket' } },
          { name: 'outboundRateLimit'; type: { defined: 'RateLimitTokenBucket' } },
          { name: 'overrideType'; type: { defined: 'PoolChainConfigOverrideType' } },
        ]
      }
    },
    {
      name: 'Blocklist'
      type: {
        kind: 'struct'
        fields: [
          { name: 'version'; type: 'u8' },
          { name: 'bump'; type: 'u8' },
          { name: 'creator'; type: 'publicKey' },
          { name: 'blocklistId'; type: 'publicKey' },
          { name: 'admin'; type: 'publicKey' },
          { name: 'proposedAdmin'; type: 'publicKey' },
          { name: 'entryCount'; type: 'u32' },
          { name: 'reserved'; type: { array: ['u8', 32] } },
        ]
      }
    },
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
      name: 'ChainConfig'
      type: { kind: 'struct'; fields: [{ name: 'base'; type: { defined: 'BaseChain' } }] }
    },
    {
      name: 'ChainConfigOverride'
      type: {
        kind: 'struct'
        fields: [
          { name: 'bump'; type: 'u8' },
          { name: 'version'; type: 'u8' },
          { name: 'base'; type: { defined: 'BaseOverrideConfig' } },
        ]
      }
    },
    {
      name: 'ChainConfigV2'
      type: {
        kind: 'struct'
        fields: [
          { name: 'bump'; type: 'u8' },
          { name: 'version'; type: 'u8' },
          { name: 'remoteChainSelector'; type: 'u64' },
          { name: 'mint'; type: 'publicKey' },
          {
            name: 'allowedFinalityConfig'
            docs: [
              'Allowed finality policy for *outbound* (lock_or_burn) transfers on this lane.',
              "Mirrors EVM's pool-wide `s_allowedFinalityConfig`. Zero-initialized",
              '(`WAIT_FOR_FINALITY`) means only full-finality transfers are permitted.',
            ]
            type: { defined: 'FinalityConfig' }
          },
          { name: 'tokenTransferFeeConfig'; type: { defined: 'TokenTransferFeeConfig' } },
          { name: 'ccvConfig'; type: { defined: 'CCVConfig' } },
        ]
      }
    },
    {
      name: 'CloseGroupLanesParams'
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'recordCount'
            docs: [
              'The leading remaining accounts are the named policy chain records (writable) the lanes',
              "reference: their references are released (review 2f S1). The group owner's wallet follows",
              'them, then the lanes.',
            ]
            type: 'u8'
          },
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
      name: 'CreateAllowlistParams'
      type: {
        kind: 'struct'
        fields: [
          { name: 'listId'; type: 'publicKey' },
          {
            name: 'enabled'
            docs: ["Fixed for the list's life (EVM constructor-time `allowlistEnabled`)."]
            type: 'bool'
          },
          { name: 'admin'; type: 'publicKey' },
        ]
      }
    },
    {
      name: 'CreateBlocklistParams'
      type: {
        kind: 'struct'
        fields: [{ name: 'blocklistId'; type: 'publicKey' }, { name: 'admin'; type: 'publicKey' }]
      }
    },
    {
      name: 'CreateGroupParams'
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'groupId'
            docs: ["Any key the creator picks; the group's address is `[GROUP_SEED, group_id]`."]
            type: 'publicKey'
          },
          {
            name: 'maxBpsFee'
            docs: [
              "Cap on every BPS fee the group's records may charge (at most 10,000). `None` sets",
              '`DEFAULT_GROUP_MAX_BPS_FEE` (1,000). After creation the cap can only go down.',
            ]
            type: { option: 'u16' }
          },
          {
            name: 'openMembership'
            docs: ["When set, lane owners join without the group owner's signature."]
            type: 'bool'
          },
          {
            name: 'minCcvActivationDelay'
            docs: ['Minimum notice, in seconds, for a scheduled CCV change.']
            type: 'u64'
          },
        ]
      }
    },
    {
      name: 'CreatePolicyParams'
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'policyId'
            docs: [
              "Must be the group's `next_policy_id`: policies are numbered from 0 so the group can enumerate",
              "them. The policy's address is `[POLICY_SEED, group, policy_id_le]`.",
            ]
            type: 'u32'
          },
          {
            name: 'classes'
            docs: ['One bit per class (`PolicyClass::bit`) the policy carries; at least one.']
            type: 'u16'
          },
        ]
      }
    },
    {
      name: 'DeleteChainConfigOverrideParams'
      type: {
        kind: 'struct'
        fields: [
          { name: 'remoteChainSelector'; type: 'u64' },
          { name: 'mint'; type: 'publicKey' },
          { name: 'overrideType'; type: { defined: 'PoolChainConfigOverrideType' } },
        ]
      }
    },
    {
      name: 'DeriveAccountsResponse'
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'askAgainWith'
            type: { vec: { defined: 'base_token_pool::v1::CcipAccountMeta' } }
          },
          {
            name: 'accountsToSave'
            type: { vec: { defined: 'base_token_pool::v1::CcipAccountMeta' } }
          },
          { name: 'lookUpTablesToSave'; type: { vec: 'publicKey' } },
          { name: 'currentStage'; type: 'string' },
          { name: 'nextStage'; type: 'string' },
        ]
      }
    },
    {
      name: 'EditPolicyChainRecordParams'
      type: {
        kind: 'struct'
        fields: [
          { name: 'policyId'; type: 'u32' },
          { name: 'remoteChainSelector'; type: 'u64' },
          {
            name: 'section'
            docs: [
              'Written to the chain record, which stops following the policy default for that class.',
            ]
            type: { defined: 'PolicySection' }
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
      name: 'GetFeeParams'
      type: {
        kind: 'struct'
        fields: [
          { name: 'remoteChainSelector'; type: 'u64' },
          { name: 'amount'; type: 'u64' },
          { name: 'localToken'; type: 'publicKey' },
          { name: 'feeToken'; type: 'publicKey' },
          { name: 'requestedFinalityConfig'; type: { defined: 'FinalityConfig' } },
          { name: 'tokenArgs'; type: 'bytes' },
        ]
      }
    },
    {
      name: 'GetFeeResult'
      type: {
        kind: 'struct'
        fields: [
          { name: 'destGasLimit'; type: 'u32' },
          { name: 'destBytesOverhead'; type: 'u32' },
          { name: 'fee'; type: 'u32' },
          { name: 'tokenFeeBps'; type: 'u16' },
          { name: 'isEnabled'; type: 'bool' },
        ]
      }
    },
    {
      name: 'GetRequiredCCVsIn'
      type: {
        kind: 'struct'
        fields: [
          { name: 'remoteChainSelector'; type: 'u64' },
          {
            name: 'amount'
            docs: [
              'Token amount used to determine the required CCVs.',
              '',
              "For inbound transfers, the amount is denominated in the remote token's decimals",
              'and must be converted to local token decimals before applying amount-based CCV',
              'policies. For outbound transfers, the amount is already denominated in local',
              "token decimals, but is the gross amount before the pool's in-token BPS fee: the",
              'pool deducts that fee before applying amount-based CCV policies, as it only sends',
              'the post-fee remainder cross-chain. Inbound amounts are already post-fee.',
            ]
            type: { defined: 'ProtocolAmount' }
          },
          { name: 'localToken'; type: 'publicKey' },
          { name: 'direction'; type: { defined: 'MessageDirection' } },
          { name: 'requestedFinalityConfig'; type: { defined: 'FinalityConfig' } },
        ]
      }
    },
    {
      name: 'GetRequiredCCVsOut'
      type: { kind: 'struct'; fields: [{ name: 'requiredCcvs'; type: { vec: 'publicKey' } }] }
    },
    {
      name: 'Group'
      type: {
        kind: 'struct'
        fields: [
          { name: 'version'; type: 'u8' },
          { name: 'bump'; type: 'u8' },
          {
            name: 'groupId'
            docs: ['Chosen by the creator; only used to derive the address.']
            type: 'publicKey'
          },
          { name: 'owner'; type: 'publicKey' },
          { name: 'proposedOwner'; type: 'publicKey' },
          { name: 'roles'; type: { defined: 'GroupRoles' } },
          {
            name: 'maxBpsFee'
            docs: [
              "Cap on every BPS fee of the group's records. Only the owner can change it, and only down.",
            ]
            type: 'u16'
          },
          {
            name: 'openMembership'
            docs: [
              'When set, joining needs only the lane owner; otherwise the group owner must co-sign.',
            ]
            type: 'bool'
          },
          {
            name: 'paused'
            docs: [
              'Mirrors `GroupChainPolicy.group_paused`, so records added while paused start paused.',
            ]
            type: 'bool'
          },
          {
            name: 'minCcvActivationDelay'
            docs: [
              'Minimum notice, in seconds, for a scheduled CCV change (at most',
              '`MAX_MIN_CCV_ACTIVATION_DELAY`). A decrease waits out the notice in force (see',
              '`pending_min_ccv_activation_delay`).',
            ]
            type: 'u64'
          },
          { name: 'defaultPolicy'; type: { defined: 'PolicySections' } },
          {
            name: 'ccvEpochCounter'
            docs: [
              'Group-wide CCV epoch counter: every scheduled set of the group (default or chain record)',
              'takes the next value, so no two sets ever share an epoch (review 2c B1).',
            ]
            type: 'u64'
          },
          {
            name: 'pendingMinCcvActivationDelay'
            docs: [
              'A lowered `min_ccv_activation_delay`, applied from `pending_min_ccv_activation_delay_at`',
              '(0 = none).',
            ]
            type: 'u64'
          },
          { name: 'pendingMinCcvActivationDelayAt'; type: 'i64' },
          {
            name: 'nextPolicyId'
            docs: [
              'Named policies are numbered `0..next_policy_id` (`create_policy` takes the next id), so the',
              'group can enumerate them (`observe_group`), closed ones leaving gaps.',
            ]
            type: 'u32'
          },
          {
            name: 'securityGeneration'
            docs: [
              'Bumped on every ownership acceptance (review 2d S3). Named SECURITY records carry the',
              'generation they were last reset or written in; a record from an older generation fails closed',
              'until the new owner resets it (`reset_policy_security`).',
            ]
            type: 'u32'
          },
          {
            name: 'hookLookupTable'
            docs: [
              "An address lookup table the owner keeps with the group's static hook accounts (named",
              'records, hook authority, engine program and statics). The resolvers return it with the hook',
              'accounts, so a lane with four named slots and every hook still fits a transaction (review 2e',
              'S4). Carved from `reserved`: `Pubkey::default()` = none.',
            ]
            type: 'publicKey'
          },
          {
            name: 'chainSelectors'
            docs: [
              'Chains the group has a `GroupChainPolicy` for. Group-wide writes take all of them.',
            ]
            type: { vec: 'u64' }
          },
        ]
      }
    },
    {
      name: 'GroupChainPolicy'
      type: {
        kind: 'struct'
        fields: [
          { name: 'version'; type: 'u8' },
          { name: 'bump'; type: 'u8' },
          { name: 'group'; type: 'publicKey' },
          { name: 'remoteChainSelector'; type: 'u64' },
          {
            name: 'inheritsDefault'
            docs: [
              'One bit per `PolicyClass` (`PolicyClass::bit`): the class follows the group default.',
            ]
            type: 'u16'
          },
          { name: 'groupPaused'; type: 'bool' },
          { name: 'pausedOutbound'; type: 'bool' },
          { name: 'pausedInbound'; type: 'bool' },
          {
            name: 'memberLaneCount'
            docs: [
              'Lanes linked to the group on this chain. A record with members cannot be closed.',
            ]
            type: 'u32'
          },
          { name: 'policy'; type: { defined: 'PolicySections' } },
          {
            name: 'poolDataDemand'
            docs: ["What the member lanes need from `policy`'s pool-data settings."]
            type: { defined: 'PoolDataDemand' }
          },
          {
            name: 'maxBpsFee'
            docs: [
              'Mirror of `Group.max_bps_fee`, written by `add_group_chain` and `set_group_settings`, so the',
              'transfer path enforces the cap on any policy-sourced fee without another account (review 2d',
              'S2). `max_bps_fee_set` = false only on records written before the mirror existed.',
            ]
            type: 'u16'
          },
          { name: 'maxBpsFeeSet'; type: 'bool' },
          {
            name: 'securityGeneration'
            docs: ['Mirror of `Group.security_generation`, written on ownership acceptance.']
            type: 'u32'
          },
          {
            name: 'laneMode'
            docs: [
              'Group-driven lanes on this chain (increment 2f, `set_group_chain_lanes`): none, every',
              "member, or the members in the subset bitmap stored after the record's fixed allocation",
              '(see [`GROUP_CHAIN_POLICY_FIXED_LEN`]). Carved from `reserved`: older records read `Off`.',
            ]
            type: { defined: 'GroupLaneMode' }
          },
          {
            name: 'drivenLanesPaused'
            docs: [
              'Group-driven lanes on this chain are paused in both directions (they can be materialized',
              'and inspected, not used). Enabling a chain from `Off` must set it (review 2f S2); clearing it',
              'needs the owner or `unpauser`. Hand-linked lanes ignore it.',
            ]
            type: 'bool'
          },
          { name: 'reserved'; type: { array: ['u8', 42] } },
        ]
      }
    },
    {
      name: 'GroupChainPolicyObservation'
      type: {
        kind: 'struct'
        fields: [
          { name: 'observationVersion'; type: 'u16' },
          { name: 'typeVersion'; type: 'string' },
          { name: 'version'; type: 'u8' },
          { name: 'group'; type: 'publicKey' },
          { name: 'remoteChainSelector'; type: 'u64' },
          { name: 'inheritsDefault'; type: 'u16' },
          { name: 'groupPaused'; type: 'bool' },
          { name: 'pausedOutbound'; type: 'bool' },
          { name: 'pausedInbound'; type: 'bool' },
          { name: 'memberLaneCount'; type: 'u32' },
          { name: 'policy'; type: { defined: 'PolicySections' } },
        ]
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
      name: 'GroupObservation'
      docs: [
        "A group's root, without its default policy (read it from any chain record that inherits, or",
        'from the account): return data is capped at 1,024 bytes.',
      ]
      type: {
        kind: 'struct'
        fields: [
          { name: 'observationVersion'; type: 'u16' },
          { name: 'typeVersion'; type: 'string' },
          { name: 'version'; type: 'u8' },
          { name: 'groupId'; type: 'publicKey' },
          { name: 'owner'; type: 'publicKey' },
          { name: 'proposedOwner'; type: 'publicKey' },
          { name: 'roles'; type: { defined: 'GroupRoles' } },
          { name: 'maxBpsFee'; type: 'u16' },
          { name: 'openMembership'; type: 'bool' },
          { name: 'paused'; type: 'bool' },
          { name: 'chainSelectors'; type: { vec: 'u64' } },
          {
            name: 'nextPolicyId'
            docs: [
              'Named policies are numbered `0..next_policy_id` (closed ones leave gaps): the list an owner',
              'reviews after an ownership change.',
            ]
            type: 'u32'
          },
          { name: 'securityGeneration'; type: 'u32' },
          { name: 'minCcvActivationDelay'; type: 'u64' },
          {
            name: 'hookLookupTable'
            docs: [
              '`Pubkey::default()`: none. Its authority (if not frozen) can close it: review it after a',
              "hand-over (appended; `observation_version` is ccip_common's shared constant).",
            ]
            type: 'publicKey'
          },
        ]
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
      name: 'HookObservation'
      docs: [
        "A security section's hooks and who controls them (review 2e S1, N5, N10): what a new owner",
        'reviews after a hand-over. The admins are filled when the lists are passed as remaining',
        'accounts. A lane escapes these hooks when its SECURITY is inline, or comes from another record',
        '(a detached chain record, or a named policy without hooks).',
      ]
      type: {
        kind: 'struct'
        fields: [
          { name: 'observationVersion'; type: 'u16' },
          {
            name: 'record'
            docs: ['The record observed: a `Group` or `Policy` (its default) or one chain record.']
            type: 'publicKey'
          },
          { name: 'hook'; type: { option: { defined: 'HookConfig' } } },
          { name: 'allowlistAdmin'; type: { option: 'publicKey' } },
          { name: 'blocklistAdmin'; type: { option: 'publicKey' } },
          {
            name: 'hookAuthority'
            docs: ["The pool's signer on engine calls for this record's group."]
            type: 'publicKey'
          },
        ]
      }
    },
    {
      name: 'InheritGroupDefaultParams'
      type: {
        kind: 'struct'
        fields: [
          { name: 'remoteChainSelector'; type: 'u64' },
          {
            name: 'class'
            docs: ['The chain record copies the default for this class and follows it from now on.']
            type: { defined: 'PolicyClass' }
          },
        ]
      }
    },
    {
      name: 'InitChainConfigOverrideParams'
      type: {
        kind: 'struct'
        fields: [
          { name: 'remoteChainSelector'; type: 'u64' },
          { name: 'mint'; type: 'publicKey' },
          { name: 'overrideType'; type: { defined: 'PoolChainConfigOverrideType' } },
          { name: 'inbound'; type: { defined: 'RateLimitConfig' } },
          { name: 'outbound'; type: { defined: 'RateLimitConfig' } },
        ]
      }
    },
    {
      name: 'InitGroupLaneEntry'
      type: {
        kind: 'struct'
        fields: [
          { name: 'mint'; type: 'publicKey' },
          {
            name: 'remote'
            docs: [
              "The lane's inline connection: remote token, decimals and the remote pools it trusts itself.",
            ]
            type: { defined: 'RemoteConfig' }
          },
        ]
      }
    },
    {
      name: 'InitGroupLanesParams'
      type: {
        kind: 'struct'
        fields: [
          { name: 'remoteChainSelector'; type: 'u64' },
          { name: 'classSource'; type: { array: ['u8', 4] } },
          { name: 'lanes'; type: { vec: { defined: 'InitGroupLaneEntry' } } },
        ]
      }
    },
    {
      name: 'JoinGroupEntry'
      type: {
        kind: 'struct'
        fields: [
          { name: 'mint'; type: 'publicKey' },
          {
            name: 'remoteTokens'
            docs: ["The remote tokens the member's group-driven lanes are created with, by chain."]
            type: { vec: { defined: 'MemberRemoteToken' } }
          },
        ]
      }
    },
    {
      name: 'JoinGroupParams'
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'rentReceiver'
            docs: ["Receives the members' rent when they close (the first remaining account)."]
            type: 'publicKey'
          },
          { name: 'members'; type: { vec: { defined: 'JoinGroupEntry' } } },
        ]
      }
    },
    {
      name: 'LaneGroupObservation'
      docs: ['What a lane actually applies, per class, after resolving its group link.']
      type: {
        kind: 'struct'
        fields: [
          { name: 'observationVersion'; type: 'u16' },
          { name: 'typeVersion'; type: 'string' },
          { name: 'mint'; type: 'publicKey' },
          { name: 'remoteChainSelector'; type: 'u64' },
          {
            name: 'group'
            docs: ['`Pubkey::default()` when the lane is not linked.']
            type: 'publicKey'
          },
          { name: 'classSource'; type: { array: ['u8', 4] } },
          {
            name: 'outboundPaused'
            docs: [
              'Whether a transfer in each direction is paused at any level (group, chain, lane).',
            ]
            type: 'bool'
          },
          { name: 'inboundPaused'; type: 'bool' },
          { name: 'lanePausedOutbound'; type: 'bool' },
          { name: 'lanePausedInbound'; type: 'bool' },
          { name: 'allowedFinalityConfig'; type: { defined: 'FinalityConfig' } },
          { name: 'feeConfig'; type: { option: { defined: 'TokenTransferFeeConfig' } } },
          {
            name: 'inboundRateLimit'
            docs: ['The buckets as of now under the configs the lane applies.']
            type: { defined: 'RateLimiterObservation' }
          },
          { name: 'outboundRateLimit'; type: { defined: 'RateLimiterObservation' } },
          { name: 'ftfInboundRateLimit'; type: { option: { defined: 'RateLimiterObservation' } } },
          { name: 'ftfOutboundRateLimit'; type: { option: { defined: 'RateLimiterObservation' } } },
        ]
      }
    },
    {
      name: 'LinkLanesParams'
      type: {
        kind: 'struct'
        fields: [
          { name: 'remoteChainSelector'; type: 'u64' },
          {
            name: 'classSource'
            docs: [
              "Per `PolicyClass`: 0 = the lane's own (inline) fields, 1 = the group default. `SECURITY`",
              'stays inline in this version.',
            ]
            type: { array: ['u8', 4] }
          },
        ]
      }
    },
    {
      name: 'LockOrBurnInV1'
      type: {
        kind: 'struct'
        fields: [
          { name: 'receiver'; type: 'bytes' },
          { name: 'remoteChainSelector'; type: 'u64' },
          { name: 'originalSender'; type: 'publicKey' },
          { name: 'amount'; type: 'u64' },
          { name: 'localToken'; type: 'publicKey' },
          {
            name: 'msgTotalNonce'
            docs: [
              "DEPRECATED. The onramp's full nonce for this message, keyed by `original_sender` and",
              '`remote_chain_selector`. Still populated with a real value by the 1.6 onramp',
              "(`ccip-router`'s `instructions_v1/v1/onramp.rs`), but hard-coded to `0` by `ccip_send_v2`,",
              'which no longer tracks per-sender nonces.',
              '',
              'The only pool that reads it is `cctp-token-pool`, which uses it as a PDA seed for the',
              "`cctp_message_sent_event` account (see that program's `lib.rs` and `derive.rs`). A constant",
              '`0` would therefore collide across messages — so the `0` is only sound because a CCTP v1 pool',
              'can never be reached from `ccip_send_v2`:',
              '',
              '- CCTP and Lombard are the only v1 pools that set `implements_account_resolution`.',
              "- `TokenTransferContext::new` (the router's `instructions/common.rs`) verifies the",
              '`TokenAdminRegistry` PDA and then rejects `interface_version == 1` &&',
              '`implements_account_resolution` with `UnsupportedPoolV1ResolutionOnLaneV2`. That runs in',
              '`ccip_send_v2` before any pool CPI, so it is the authoritative gate; the account-resolution',
              'stage (`ccip_send/resolve_accounts/token_transfer_static.rs`) rejects the same combination',
              'earlier, but is only advisory since callers can build the transaction themselves.',
              '- `set_pool_interface_implementation` additionally refuses to register',
              '`implements_account_resolution` below `interface_version` 2. The runtime check still',
              'matters because registries migrated from 1.6 can carry the v1/resolution combination.',
              '',
              'Removing the field outright is a breaking change to the v1 pool interface, so it stays until',
              'the 1.6 lane is retired. Anything that starts consuming it must not assume it is meaningful',
              'on the v2 lane.',
            ]
            type: 'u64'
          },
        ]
      }
    },
    {
      name: 'LockOrBurnInV2'
      type: {
        kind: 'struct'
        fields: [
          { name: 'receiver'; type: 'bytes' },
          { name: 'remoteChainSelector'; type: 'u64' },
          { name: 'originalSender'; type: 'publicKey' },
          { name: 'amount'; type: 'u64' },
          { name: 'localToken'; type: 'publicKey' },
          { name: 'requestedFinalityConfig'; type: { defined: 'FinalityConfig' } },
          { name: 'tokenArgs'; type: 'bytes' },
        ]
      }
    },
    {
      name: 'LockOrBurnOutV1'
      type: {
        kind: 'struct'
        fields: [
          { name: 'destTokenAddress'; type: { defined: 'RemoteAddress' } },
          { name: 'destPoolData'; type: 'bytes' },
        ]
      }
    },
    {
      name: 'LockOrBurnOutV2'
      type: {
        kind: 'struct'
        fields: [
          { name: 'destTokenAddress'; type: { defined: 'RemoteAddress' } },
          { name: 'destPoolData'; type: 'bytes' },
          { name: 'destTokenAmount'; type: 'u64' },
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
      name: 'MessageDirection'
      docs: ['Direction of a cross-chain message, used for CCV requirements.']
      type: { kind: 'enum'; variants: [{ name: 'Outbound' }, { name: 'Inbound' }] }
    },
    {
      name: 'NestedResolveAccountsParams'
      docs: [
        'Resolution parameters used by nested resolvers. Rather than the full ix_data and a metadata',
        'field, they have an opaque `cpi_resolution_inputs` field that doubles as both. The caller',
        'of the nested resolution is responsible for correctly encoding it by consulting',
        'the documentation.',
      ]
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'caller'
            docs: ['The account expected to sign the final instruction being resolved.']
            type: 'publicKey'
          },
          {
            name: 'callerProgram'
            docs: [
              'The program ID that derived `caller` and is driving this resolution (the router on the',
              'send side, the offramp on the execute side).',
            ]
            type: 'publicKey'
          },
          {
            name: 'cpiResolutionInputs'
            docs: [
              'Will be deserialized into a type the nested resolver understands. For what to',
              "send in the first stage of nested resolution, consult the nested resolver's documentation.",
            ]
            type: 'bytes'
          },
        ]
      }
    },
    {
      name: 'NestedResolveAccountsResponse'
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'askAgainWith'
            docs: [
              'In the next resolution round, call the resolution method',
              'including these accounts (all read-only).',
            ]
            type: { vec: 'publicKey' }
          },
          {
            name: 'accountsToSave'
            docs: [
              'Append these accounts to a separate accumulator list. Once',
              '`next_ix_discriminator` is empty, this accumulated list',
              'contains all accounts for the instruction of interest.',
            ]
            type: { vec: { defined: 'ccip_common::resolution::CcipAccountMeta' } }
          },
          {
            name: 'lookupTablesToSave'
            docs: [
              'Append these lookup tables to a separate accumulator list.',
              'Once resolution is complete, the accumulated list contains all',
              'LUTs that the instruction of interest can use.',
            ]
            type: { vec: 'publicKey' }
          },
          {
            name: 'nextCpiResolutionInputs'
            docs: ['If nonempty, perform another resolution stage with these inputs.']
            type: 'bytes'
          },
        ]
      }
    },
    {
      name: 'ObserveLaneGroupParams'
      type: {
        kind: 'struct'
        fields: [{ name: 'remoteChainSelector'; type: 'u64' }, { name: 'mint'; type: 'publicKey' }]
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
      name: 'Policy'
      type: {
        kind: 'struct'
        fields: [
          { name: 'version'; type: 'u8' },
          { name: 'bump'; type: 'u8' },
          { name: 'group'; type: 'publicKey' },
          { name: 'policyId'; type: 'u32' },
          {
            name: 'classes'
            docs: [
              'One bit per `PolicyClass` (`PolicyClass::bit`) the policy carries. Lanes may take only',
              'these classes from it, and only these sections are written.',
            ]
            type: 'u16'
          },
          { name: 'defaultPolicy'; type: { defined: 'PolicySections' } },
          {
            name: 'securityGeneration'
            docs: [
              "The group's `security_generation` this policy's SECURITY default was last reset or written in.",
            ]
            type: 'u32'
          },
          { name: 'reserved'; type: { array: ['u8', 60] } },
          {
            name: 'chainSelectors'
            docs: [
              'Chains the policy has a `PolicyChainRecord` for. A policy with records cannot be closed',
              '(`PolicyHasRecords`); policy-wide writes take all of them.',
            ]
            type: { vec: 'u64' }
          },
        ]
      }
    },
    {
      name: 'PolicyChainParams'
      type: {
        kind: 'struct'
        fields: [{ name: 'policyId'; type: 'u32' }, { name: 'remoteChainSelector'; type: 'u64' }]
      }
    },
    {
      name: 'PolicyChainRecord'
      type: {
        kind: 'struct'
        fields: [
          { name: 'version'; type: 'u8' },
          { name: 'bump'; type: 'u8' },
          { name: 'policy'; type: 'publicKey' },
          { name: 'remoteChainSelector'; type: 'u64' },
          { name: 'group'; type: 'publicKey' },
          {
            name: 'classes'
            docs: ["Copied from the policy at creation (fixed for the policy's life)."]
            type: 'u16'
          },
          { name: 'inheritsDefault'; type: 'u16' },
          {
            name: 'laneRefCount'
            docs: [
              'Lanes referencing this record for any class. A record in use cannot be closed',
              '(`PolicyInUse`).',
            ]
            type: 'u32'
          },
          { name: 'sections'; type: { defined: 'PolicySections' } },
          {
            name: 'poolDataDemand'
            docs: ["What the referencing lanes need from `sections`' pool-data settings."]
            type: { defined: 'PoolDataDemand' }
          },
          {
            name: 'securityGeneration'
            docs: [
              "The group's `security_generation` this record's SECURITY section was last reset or written",
              'in; an older one fails transfers closed (review 2d S3).',
            ]
            type: 'u32'
          },
          { name: 'reserved'; type: { array: ['u8', 59] } },
        ]
      }
    },
    {
      name: 'PolicyClass'
      docs: [
        'The policy classes. EVM assigns six policy types per token; Solana merges the ones that are',
        'always read together on the same paths (connection + remote pool, fee + dest overhead).',
      ]
      type: {
        kind: 'enum'
        variants: [
          { name: 'Connection' },
          { name: 'Fee' },
          { name: 'RateLimit' },
          { name: 'Security' },
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
      name: 'PolicyIdParams'
      type: { kind: 'struct'; fields: [{ name: 'policyId'; type: 'u32' }] }
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
    {
      name: 'PolicySections'
      docs: [
        "One value per policy class: a group's default record (EVM's selector-0 record) and each of its",
        'chain records.',
      ]
      type: {
        kind: 'struct'
        fields: [
          { name: 'connection'; type: { defined: 'ConnectionPolicy' } },
          { name: 'fee'; type: { defined: 'FeePolicy' } },
          { name: 'rateLimit'; type: { defined: 'RateLimitPolicy' } },
          { name: 'security'; type: { defined: 'SecurityPolicy' } },
        ]
      }
    },
    {
      name: 'PoolChainConfigObservation'
      docs: ['Per-remote-chain configuration of a token pool, as observed by off-chain consumers.']
      type: {
        kind: 'struct'
        fields: [
          { name: 'observationVersion'; type: 'u16' },
          { name: 'typeVersion'; type: 'string' },
          { name: 'remoteChainSelector'; type: 'u64' },
          { name: 'mint'; type: 'publicKey' },
          {
            name: 'remoteTokenAddress'
            docs: ['Token address on the remote chain, as raw bytes.']
            type: 'bytes'
          },
          { name: 'remoteDecimals'; type: 'u8' },
          {
            name: 'remotePoolAddresses'
            docs: [
              'Pool addresses on the remote chain, as raw bytes. More than one entry means earlier pool',
              'versions are still accepted as sources.',
            ]
            type: { vec: 'bytes' }
          },
          { name: 'inboundRateLimit'; type: { defined: 'RateLimiterObservation' } },
          { name: 'outboundRateLimit'; type: { defined: 'RateLimiterObservation' } },
        ]
      }
    },
    {
      name: 'PoolChainConfigOverrideObservation'
      docs: [
        'Per-remote-chain, per-override-type rate limit override of a token pool, as observed by',
        'off-chain consumers.',
        '',
        'Override PDAs are optional: when a lane has no override of the requested type, the observing',
        'instruction fails, which callers can read as "not overridden".',
      ]
      type: {
        kind: 'struct'
        fields: [
          { name: 'observationVersion'; type: 'u16' },
          { name: 'typeVersion'; type: 'string' },
          { name: 'version'; type: 'u8' },
          { name: 'remoteChainSelector'; type: 'u64' },
          { name: 'mint'; type: 'publicKey' },
          {
            name: 'overrideType'
            docs: ['Which flavour of transfer this override applies to (e.g. fast transfers).']
            type: { defined: 'PoolChainConfigOverrideType' }
          },
          { name: 'inboundRateLimit'; type: { defined: 'RateLimiterObservation' } },
          { name: 'outboundRateLimit'; type: { defined: 'RateLimiterObservation' } },
        ]
      }
    },
    { name: 'PoolChainConfigOverrideType'; type: { kind: 'enum'; variants: [{ name: 'FTF' }] } },
    {
      name: 'PoolChainConfigV2Observation'
      docs: [
        'Per-remote-chain CCIP 2.0 configuration of a token pool, as observed by off-chain consumers.',
      ]
      type: {
        kind: 'struct'
        fields: [
          { name: 'observationVersion'; type: 'u16' },
          { name: 'typeVersion'; type: 'string' },
          { name: 'version'; type: 'u8' },
          { name: 'remoteChainSelector'; type: 'u64' },
          { name: 'mint'; type: 'publicKey' },
          {
            name: 'thresholdAmount'
            docs: [
              'Transfer amount above which the threshold CCVs are additionally required. Zero disables the',
              'threshold lists.',
            ]
            type: 'u64'
          },
          { name: 'outboundCcvs'; type: { vec: 'publicKey' } },
          { name: 'thresholdOutboundCcvs'; type: { vec: 'publicKey' } },
          { name: 'inboundCcvs'; type: { vec: 'publicKey' } },
          { name: 'thresholdInboundCcvs'; type: { vec: 'publicKey' } },
          {
            name: 'allowedFinalityConfig'
            docs: ['Allowed finality policy for outbound (lock_or_burn) transfers on this lane.']
            type: { defined: 'FinalityConfig' }
          },
        ]
      }
    },
    {
      name: 'PoolConfig'
      type: {
        kind: 'struct'
        fields: [
          { name: 'version'; type: 'u8' },
          { name: 'selfServedAllowed'; type: 'bool' },
          { name: 'router'; type: 'publicKey' },
          { name: 'rmnRemote'; type: 'publicKey' },
        ]
      }
    },
    {
      name: 'PoolDataDemand'
      docs: [
        "What a chain record's member lanes need from its pool-data settings, counted at link, unlink,",
        'init and `set_lane_pool_data` (see [`PolicySections::validate_pool_data_fee`]). Members that',
        "take `CONNECTION` from the record without a UID are covered by the record's own format.",
      ]
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'feeInlineLong'
            docs: [
              'Members with `FEE` from the record, an inline `CONNECTION` sending the long format and no UID.',
            ]
            type: 'u32'
          },
          {
            name: 'feeUid'
            docs: ['Members with `FEE` from the record and a UID (always the long format).']
            type: 'u32'
          },
          {
            name: 'connectionUid'
            docs: ['Members with `CONNECTION` from the record and a UID.']
            type: 'u32'
          },
        ]
      }
    },
    {
      name: 'PoolDataFormat'
      docs: ['The remote pool data a lane emits on send.']
      type: { kind: 'enum'; variants: [{ name: 'Legacy32' }, { name: 'Long' }] }
    },
    {
      name: 'PoolStateObservation'
      docs: [
        'Per-mint configuration of a token pool, as observed by off-chain consumers.',
        '',
        'The allow list is reported as a count only, as its size is unbounded by configuration.',
      ]
      type: {
        kind: 'struct'
        fields: [
          { name: 'observationVersion'; type: 'u16' },
          { name: 'typeVersion'; type: 'string' },
          { name: 'version'; type: 'u8' },
          { name: 'tokenProgram'; type: 'publicKey' },
          { name: 'mint'; type: 'publicKey' },
          { name: 'decimals'; type: 'u8' },
          { name: 'poolSigner'; type: 'publicKey' },
          { name: 'poolTokenAccount'; type: 'publicKey' },
          { name: 'owner'; type: 'publicKey' },
          { name: 'proposedOwner'; type: 'publicKey' },
          { name: 'rateLimitAdmin'; type: 'publicKey' },
          { name: 'router'; type: 'publicKey' },
          { name: 'routerOnrampAuthority'; type: 'publicKey' },
          { name: 'rmnRemote'; type: 'publicKey' },
          {
            name: 'rebalancer'
            docs: [
              'Rebalancer, only meaningful for lock/release pools. The default pubkey means rebalancing is',
              'not allowed.',
            ]
            type: 'publicKey'
          },
          { name: 'listEnabled'; type: 'bool' },
          { name: 'allowListCount'; type: 'u32' },
        ]
      }
    },
    {
      name: 'ProtocolAmount'
      docs: [
        'CCIP 2.0 compatible cross-chain amount representation (u256 in big-endian bytes, based',
        'on abi.encodePacked)',
      ]
      type: { kind: 'struct'; fields: [{ name: 'beBytes'; type: { array: ['u8', 32] } }] }
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
      name: 'RateLimitTokenBucket'
      type: {
        kind: 'struct'
        fields: [
          { name: 'tokens'; type: 'u64' },
          { name: 'lastUpdated'; type: 'u64' },
          { name: 'cfg'; type: { defined: 'RateLimitConfig' } },
        ]
      }
    },
    {
      name: 'RateLimiterObservation'
      docs: ['State of one rate limiter bucket, as of the moment of observation.']
      type: {
        kind: 'struct'
        fields: [
          { name: 'isEnabled'; type: 'bool' },
          { name: 'capacity'; type: 'u64' },
          { name: 'rate'; type: 'u64' },
          {
            name: 'tokens'
            docs: [
              'Tokens available now: the stored balance plus the refill accrued since the bucket was last',
              "touched, capped at `capacity`. This is the value EVM's `getCurrent*RateLimiterState`",
              'returns, not the raw stored balance.',
            ]
            type: 'u64'
          },
          {
            name: 'lastUpdated'
            docs: [
              'Timestamp the `tokens` value corresponds to (the observation time, for an enabled bucket).',
            ]
            type: 'u64'
          },
        ]
      }
    },
    {
      name: 'ReleaseOrMintInV1'
      type: {
        kind: 'struct'
        fields: [
          { name: 'originalSender'; type: { defined: 'RemoteAddress' } },
          { name: 'remoteChainSelector'; type: 'u64' },
          { name: 'receiver'; type: 'publicKey' },
          { name: 'amount'; type: { array: ['u8', 32] } },
          { name: 'localToken'; type: 'publicKey' },
          {
            name: 'sourcePoolAddress'
            docs: [
              '@dev WARNING: sourcePoolAddress should be checked prior to any processing of funds. Make sure it matches the',
              'expected pool address for the given remoteChainSelector.',
            ]
            type: { defined: 'RemoteAddress' }
          },
          { name: 'sourcePoolData'; type: 'bytes' },
          {
            name: 'offchainTokenData'
            docs: ['@dev WARNING: offchainTokenData is untrusted data.']
            type: 'bytes'
          },
        ]
      }
    },
    {
      name: 'ReleaseOrMintInV2'
      type: {
        kind: 'struct'
        fields: [
          { name: 'originalSender'; type: { defined: 'RemoteAddress' } },
          { name: 'remoteChainSelector'; type: 'u64' },
          { name: 'receiver'; type: 'publicKey' },
          { name: 'amount'; type: { defined: 'ProtocolAmount' } },
          { name: 'localToken'; type: 'publicKey' },
          { name: 'sourcePoolAddress'; type: { defined: 'RemoteAddress' } },
          { name: 'sourcePoolData'; type: 'bytes' },
          { name: 'requestedFinalityConfig'; type: { defined: 'FinalityConfig' } },
          { name: 'receiverUsage'; type: { defined: 'SVMTokenReceiverUsage' } },
        ]
      }
    },
    {
      name: 'ReleaseOrMintOutV1'
      type: { kind: 'struct'; fields: [{ name: 'destinationAmount'; type: 'u64' }] }
    },
    {
      name: 'ReleaseOrMintOutV2'
      type: { kind: 'struct'; fields: [{ name: 'destinationAmount'; type: 'u64' }] }
    },
    {
      name: 'RemoteAddress'
      type: { kind: 'struct'; fields: [{ name: 'address'; type: 'bytes' }] }
    },
    {
      name: 'RemoteConfig'
      type: {
        kind: 'struct'
        fields: [
          { name: 'poolAddresses'; type: { vec: { defined: 'RemoteAddress' } } },
          { name: 'tokenAddress'; type: { defined: 'RemoteAddress' } },
          { name: 'decimals'; type: 'u8' },
        ]
      }
    },
    {
      name: 'RemoveGroupChainParams'
      type: { kind: 'struct'; fields: [{ name: 'remoteChainSelector'; type: 'u64' }] }
    },
    {
      name: 'ResetLaneBucketsParams'
      type: {
        kind: 'struct'
        fields: [
          { name: 'remoteChainSelector'; type: 'u64' },
          {
            name: 'policyId'
            docs: [
              "`None`: lanes on the group default's RATE_LIMIT. `Some`: lanes on this named policy's, whose",
              'chain record is then the first remaining account (review 2d N2).',
            ]
            type: { option: 'u32' }
          },
        ]
      }
    },
    {
      name: 'ResetPolicySecurityParams'
      type: { kind: 'struct'; fields: [{ name: 'policyId'; type: 'u32' }] }
    },
    {
      name: 'SVMTokenReceiverUsage'
      type: {
        kind: 'enum'
        variants: [
          { name: 'DeriveAtaAndCreate' },
          { name: 'DeriveAtaDontCreate' },
          { name: 'UseAsIs' },
        ]
      }
    },
    {
      name: 'ScheduleGroupCcvsParams'
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'remoteChainSelector'
            docs: [
              "`None`: the default (the group's, or the named policy's), written into every chain record",
              "that follows it for `SECURITY` (as remaining accounts: all the group's chain records; for a",
              'named policy, the `Policy` account first, then all its chain records). `Some`: that chain',
              'record only (the one remaining account), which then stops following the default.',
            ]
            type: { option: 'u64' }
          },
          {
            name: 'policyId'
            docs: [
              "`None`: the group's own security policy. `Some`: the group's named policy with this id,",
              'which must carry `SECURITY`.',
            ]
            type: { option: 'u32' }
          },
          { name: 'outbound'; type: { vec: 'publicKey' } },
          { name: 'inbound'; type: { vec: 'publicKey' } },
          {
            name: 'activatesAt'
            docs: ['Must be at least `Group.min_ccv_activation_delay` seconds from now.']
            type: 'i64'
          },
        ]
      }
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
      name: 'SetAllowDroppingDefaultCcvsParams'
      type: {
        kind: 'struct'
        fields: [
          { name: 'remoteChainSelector'; type: { option: 'u64' } },
          { name: 'policyId'; type: { option: 'u32' } },
          { name: 'allow'; type: 'bool' },
        ]
      }
    },
    {
      name: 'SetChainConfigOverrideRateLimitParams'
      type: {
        kind: 'struct'
        fields: [
          { name: 'remoteChainSelector'; type: 'u64' },
          { name: 'mint'; type: 'publicKey' },
          { name: 'overrideType'; type: { defined: 'PoolChainConfigOverrideType' } },
          { name: 'inbound'; type: { defined: 'RateLimitConfig' } },
          { name: 'outbound'; type: { defined: 'RateLimitConfig' } },
        ]
      }
    },
    {
      name: 'SetChainConfigV2Params'
      type: {
        kind: 'struct'
        fields: [
          { name: 'mint'; type: 'publicKey' },
          { name: 'remoteChainSelector'; type: 'u64' },
          {
            name: 'allowedFinalityConfig'
            docs: [
              'Allowed finality policy for outbound (lock_or_burn) transfers on this lane.',
              '`WAIT_FOR_FINALITY` (zero) permits only full-finality transfers.',
            ]
            type: { defined: 'FinalityConfig' }
          },
          { name: 'tokenTransferFeeConfig'; type: { defined: 'TokenTransferFeeConfig' } },
          { name: 'ccvConfig'; type: { defined: 'CCVConfig' } },
        ]
      }
    },
    {
      name: 'SetGroupChainLanesParams'
      type: {
        kind: 'struct'
        fields: [
          { name: 'mode'; type: { defined: 'GroupLaneMode' } },
          {
            name: 'drivenLanesPaused'
            docs: [
              "Pause the chain's group-driven lanes (both directions). Required when enabling from `Off`.",
            ]
            type: 'bool'
          },
          {
            name: 'bitmapWrite'
            docs: ['Applied first: a raw overwrite of the subset bitmap (bulk changes).']
            type: { option: { defined: 'SubsetBitmapWrite' } }
          },
          {
            name: 'remove'
            docs: ['Member indices removed from the subset, then those added.']
            type: { vec: 'u32' }
          },
          { name: 'add'; type: { vec: 'u32' } },
        ]
      }
    },
    {
      name: 'SetGroupChainPauseParams'
      type: {
        kind: 'struct'
        fields: [
          { name: 'remoteChainSelector'; type: 'u64' },
          { name: 'pausedOutbound'; type: 'bool' },
          { name: 'pausedInbound'; type: 'bool' },
        ]
      }
    },
    {
      name: 'SetGroupChainPolicyParams'
      type: {
        kind: 'struct'
        fields: [
          { name: 'remoteChainSelector'; type: 'u64' },
          {
            name: 'section'
            docs: ['Written to the chain record, which stops following the default for that class.']
            type: { defined: 'PolicySection' }
          },
        ]
      }
    },
    {
      name: 'SetGroupDefaultParams'
      type: { kind: 'struct'; fields: [{ name: 'section'; type: { defined: 'PolicySection' } }] }
    },
    {
      name: 'SetGroupPauseParams'
      type: { kind: 'struct'; fields: [{ name: 'paused'; type: 'bool' }] }
    },
    {
      name: 'SetGroupRolesParams'
      type: { kind: 'struct'; fields: [{ name: 'roles'; type: { defined: 'GroupRoles' } }] }
    },
    {
      name: 'SetGroupSettingsParams'
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'maxBpsFee'
            docs: [
              "Can only be lowered, and not below a BPS fee any of the group's records charges. Lowering it",
              'takes every chain record (writable): each mirrors the cap, which the transfer path enforces',
              'on named FEE policies too.',
            ]
            type: 'u16'
          },
          { name: 'openMembership'; type: 'bool' },
          {
            name: 'minCcvActivationDelay'
            docs: [
              "Minimum notice, in seconds, for a scheduled CCV change (the owner's emergency activation",
              'is not bound by it). `None` leaves it, and any pending decrease, as they are.',
            ]
            type: { option: 'u64' }
          },
          {
            name: 'hookLookupTable'
            docs: [
              "The group's hook lookup table (`Group.hook_lookup_table`); `None` leaves it,",
              '`Some(Pubkey::default())` clears it. Any other table must be an active address lookup table,',
              'passed as the last remaining account (review 2e fixes R2); a frozen one (no authority) cannot',
              'be closed under the group.',
            ]
            type: { option: 'publicKey' }
          },
        ]
      }
    },
    {
      name: 'SetHookConfigParams'
      type: {
        kind: 'struct'
        fields: [
          { name: 'remoteChainSelector'; type: { option: 'u64' } },
          { name: 'policyId'; type: { option: 'u32' } },
          {
            name: 'allowlist'
            docs: ['An enabled allowlist of this group (passed as `allowlist`), or none.']
            type: { option: 'publicKey' }
          },
          {
            name: 'blocklist'
            docs: ['Any blocklist (passed as `blocklist`), or none.']
            type: { option: 'publicKey' }
          },
        ]
      }
    },
    {
      name: 'SetLanePauseParams'
      type: {
        kind: 'struct'
        fields: [
          { name: 'mint'; type: 'publicKey' },
          { name: 'pausedOutbound'; type: 'bool' },
          { name: 'pausedInbound'; type: 'bool' },
        ]
      }
    },
    {
      name: 'SetLanePoolDataParams'
      type: {
        kind: 'struct'
        fields: [
          { name: 'mint'; type: 'publicKey' },
          { name: 'remoteChainSelector'; type: 'u64' },
          {
            name: 'poolDataFormat'
            docs: [
              'The pool data the lane sends while its CONNECTION class is inline: `Legacy32` toward',
              'standard pools, `Long` toward EVM MultiTokenPools.',
            ]
            type: { defined: 'PoolDataFormat' }
          },
          {
            name: 'uid'
            docs: [
              'Factory UID: sent as additional pool data with the long format, and required of inbound',
              'long pool data.',
            ]
            type: { option: { array: ['u8', 32] } }
          },
        ]
      }
    },
    {
      name: 'SetMemberRemoteTokensParams'
      type: {
        kind: 'struct'
        fields: [
          {
            name: 'rentReceiver'
            docs: ["`Some` replaces the members' rent receiver."]
            type: { option: 'publicKey' }
          },
          {
            name: 'members'
            docs: [
              "Replaces each member's remote tokens, in remaining-account order. Removing a chain is the",
              "token owner's opt-out of it: its lane can then be closed by anyone and is not re-created.",
            ]
            type: { vec: { defined: 'JoinGroupEntry' } }
          },
        ]
      }
    },
    {
      name: 'SetPolicyDefaultParams'
      type: {
        kind: 'struct'
        fields: [
          { name: 'policyId'; type: 'u32' },
          { name: 'section'; type: { defined: 'PolicySection' } },
        ]
      }
    },
    {
      name: 'SetPolicyEngineParams'
      type: {
        kind: 'struct'
        fields: [
          { name: 'remoteChainSelector'; type: { option: 'u64' } },
          { name: 'policyId'; type: { option: 'u32' } },
          { name: 'engine'; type: { option: { defined: 'PolicyEngineConfig' } } },
          {
            name: 'skipDetach'
            docs: [
              'Do not call `detach` on the engine being replaced (Solana cannot catch a failed CPI, so this',
              "is EVM's `setPolicyEngineAllowFailedDetach` as an explicit, evented choice).",
            ]
            type: 'bool'
          },
          {
            name: 'recordCount'
            docs: [
              "The leading remaining accounts that are the target's security records. After them, in any",
              "order: the group's hook authority, and the program and static accounts of the new engine",
              '(if any) and of the replaced one (unless `skip_detach`).',
            ]
            type: 'u8'
          },
        ]
      }
    },
    {
      name: 'State'
      type: {
        kind: 'struct'
        fields: [
          { name: 'version'; type: 'u8' },
          { name: 'config'; type: { defined: 'BaseConfig' } },
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
      name: 'SyncGroupCcvsParams'
      type: { kind: 'struct'; fields: [{ name: 'remoteChainSelector'; type: 'u64' }] }
    },
    {
      name: 'SyncPolicyCcvsParams'
      type: {
        kind: 'struct'
        fields: [{ name: 'policyId'; type: 'u32' }, { name: 'remoteChainSelector'; type: 'u64' }]
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
    {
      name: 'TransferGroupOwnershipParams'
      type: { kind: 'struct'; fields: [{ name: 'proposedOwner'; type: 'publicKey' }] }
    },
    {
      name: 'TransferListAdminParams'
      type: { kind: 'struct'; fields: [{ name: 'proposedAdmin'; type: 'publicKey' }] }
    },
    {
      name: 'UnlinkLanesParams'
      type: {
        kind: 'struct'
        fields: [
          { name: 'remoteChainSelector'; type: 'u64' },
          {
            name: 'recordCount'
            docs: [
              'The leading remaining accounts that are named policy chain records (writable): every record',
              'the lanes of the batch reference. Their references are released first (review 2d S1).',
            ]
            type: 'u8'
          },
        ]
      }
    },
    {
      name: 'base_token_pool::v1::CcipAccountMeta'
      type: {
        kind: 'struct'
        fields: [
          { name: 'pubkey'; type: 'publicKey' },
          { name: 'isSigner'; type: 'bool' },
          { name: 'isWritable'; type: 'bool' },
        ]
      }
    },
    {
      name: 'ccip_common::resolution::CcipAccountMeta'
      type: {
        kind: 'struct'
        fields: [
          { name: 'pubkey'; type: 'publicKey' },
          { name: 'isSigner'; type: 'bool' },
          { name: 'isWritable'; type: 'bool' },
        ]
      }
    },
  ]
  errors: [
    { code: 6000; name: 'InvalidMultisig'; msg: 'Invalid Multisig Mint' },
    { code: 6001; name: 'MintAuthorityAlreadySet'; msg: 'Mint Authority already set' },
    { code: 6002; name: 'FixedMintToken'; msg: 'Token with no Mint Authority' },
    { code: 6003; name: 'UnsupportedTokenProgram'; msg: 'Unsupported Token Program' },
    {
      code: 6004
      name: 'InvalidToken2022Multisig'
      msg: 'Invalid Multisig Account Data for Token 2022'
    },
    {
      code: 6005
      name: 'InvalidSPLTokenMultisig'
      msg: 'Invalid Multisig Account Data for SPL Token'
    },
    {
      code: 6006
      name: 'PoolSignerNotInMultisig'
      msg: 'Token Pool Signer PDA must be m times a signer of the Multisig'
    },
    {
      code: 6007
      name: 'MultisigMustHaveAtLeastTwoSigners'
      msg: 'Multisig must have at least 2 valid signers'
    },
    {
      code: 6008
      name: 'MultisigMustHaveMoreThanOneSigner'
      msg: 'Multisig must have more than one required signer'
    },
    { code: 6009; name: 'InvalidMultisigOwner'; msg: 'Multisig Owner must match Token Program ID' },
    {
      code: 6010
      name: 'InvalidMultisigThreshold'
      msg: 'Invalid multisig threshold: required signatures cannot exceed total signers'
    },
    {
      code: 6011
      name: 'InvalidMultisigThresholdTooHigh'
      msg: 'Invalid multisig m: required signatures cannot exceed the available for outside signers'
    },
  ]
}

export const IDL: BurnmintTokenPoolGroups = {
  version: '2.1.0',
  name: 'burnmint_token_pool',
  instructions: [
    {
      name: 'acceptGroupOwnership',
      docs: [
        'Accepts a pending group ownership transfer.',
        "(All the group's chain records as remaining accounts: the previous team's CCV opt-outs and",
        'pending sets are reset.)',
      ],
      accounts: [
        { name: 'group', isMut: true, isSigner: false },
        { name: 'authority', isMut: false, isSigner: true },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [],
    },
    {
      name: 'acceptListAdmin',
      docs: ['Accepts the admin role of an allowlist or blocklist (proposed admin).'],
      accounts: [
        { name: 'list', isMut: true, isSigner: false },
        {
          name: 'authority',
          isMut: false,
          isSigner: true,
          docs: [
            'The admin (transfer) or the proposed admin (accept), checked by the handler. For an',
            "allowlist, also its group's owner, who may always propose a new admin (review 2e S1).",
          ],
        },
        {
          name: 'group',
          isMut: false,
          isSigner: false,
          isOptional: true,
          docs: ["The allowlist's group, when its owner transfers the admin role."],
        },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [],
    },
    {
      name: 'acceptOwnership',
      docs: [
        'Accepts a pending ownership transfer, making the caller the new pool owner.',
        'Shared function signature used by all CCIP token pool programs.',
      ],
      accounts: [
        { name: 'state', isMut: true, isSigner: false },
        { name: 'mint', isMut: false, isSigner: false },
        { name: 'authority', isMut: false, isSigner: true },
      ],
      args: [],
    },
    {
      name: 'activateGroupCcvsNow',
      docs: [
        'Emergency: activates a CCV set now (group owner). Unsynced lanes fail closed until synced.',
      ],
      accounts: [
        { name: 'group', isMut: true, isSigner: false },
        {
          name: 'authority',
          isMut: false,
          isSigner: true,
          docs: ['Checked by each handler: the security admin schedules, the owner does the rest.'],
        },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'ActivateGroupCcvsNowParams' } }],
    },
    {
      name: 'addGroupChain',
      docs: ["Creates the group's record for a remote chain, following the group default."],
      accounts: [
        { name: 'group', isMut: true, isSigner: false },
        { name: 'authority', isMut: true, isSigner: true },
        { name: 'groupChainPolicy', isMut: true, isSigner: false },
        { name: 'systemProgram', isMut: false, isSigner: false },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'AddGroupChainParams' } }],
    },
    {
      name: 'appendRemotePoolAddresses',
      docs: [
        'Appends additional remote pool addresses to an existing ChainConfig.',
        'Reallocates the PDA to accommodate the extra entries.',
      ],
      accounts: [
        { name: 'state', isMut: false, isSigner: false },
        { name: 'chainConfig', isMut: true, isSigner: false },
        { name: 'authority', isMut: true, isSigner: true },
        { name: 'systemProgram', isMut: false, isSigner: false },
      ],
      args: [
        { name: 'remoteChainSelector', type: 'u64' },
        { name: 'mint', type: 'publicKey' },
        { name: 'addresses', type: { vec: { defined: 'RemoteAddress' } } },
      ],
    },
    {
      name: 'applyListUpdates',
      docs: [
        'Adds and removes entries of an allowlist or a blocklist (its admin; entry PDAs as',
        'remaining accounts).',
      ],
      accounts: [
        { name: 'list', isMut: true, isSigner: false },
        {
          name: 'admin',
          isMut: true,
          isSigner: true,
          docs: ["The list's admin; pays for new entries, receives their rent back."],
        },
        { name: 'systemProgram', isMut: false, isSigner: false },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'ApplyListUpdatesParams' } }],
    },
    {
      name: 'assignLanePolicies',
      docs: [
        'Assigns per-class sources (inline, group default, named policy) to linked lanes (batched).',
      ],
      accounts: [
        { name: 'group', isMut: false, isSigner: false },
        { name: 'groupChainPolicy', isMut: true, isSigner: false },
        {
          name: 'groupOwner',
          isMut: false,
          isSigner: true,
          isOptional: true,
          docs: ['Required unless the group has open membership.'],
        },
        { name: 'authority', isMut: true, isSigner: true },
        { name: 'systemProgram', isMut: false, isSigner: false },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'AssignLanePoliciesParams' } }],
    },
    {
      name: 'closeGroupLanes',
      docs: [
        'Closes group-driven lanes the group no longer enables (permissionless), or any of them by',
        'their token owner (batched).',
      ],
      accounts: [
        { name: 'group', isMut: false, isSigner: false },
        { name: 'groupChainPolicy', isMut: true, isSigner: false },
        {
          name: 'groupRegistry',
          isMut: false,
          isSigner: false,
          docs: ['`set_group_chain_lanes` for the next member index.'],
        },
        { name: 'authority', isMut: true, isSigner: true },
        { name: 'systemProgram', isMut: false, isSigner: false },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [
        { name: 'remoteChainSelector', type: 'u64' },
        { name: 'params', type: { defined: 'CloseGroupLanesParams' } },
      ],
    },
    {
      name: 'closeGroupMembers',
      docs: [
        'Closes memberships without group-driven lanes (batched; the token owner, or the group).',
      ],
      accounts: [
        { name: 'group', isMut: false, isSigner: false },
        {
          name: 'groupRegistry',
          isMut: true,
          isSigner: false,
          docs: ['join. Loaded and checked by the handlers.'],
        },
        {
          name: 'groupOwner',
          isMut: false,
          isSigner: true,
          isOptional: true,
          docs: ['`join_group` only: required unless the group has open membership.'],
        },
        { name: 'authority', isMut: true, isSigner: true },
        { name: 'systemProgram', isMut: false, isSigner: false },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [],
    },
    {
      name: 'closePolicy',
      docs: ['Closes a named policy with no chain records left.'],
      accounts: [
        { name: 'group', isMut: false, isSigner: false },
        { name: 'policy', isMut: true, isSigner: false },
        { name: 'authority', isMut: false, isSigner: true },
        {
          name: 'rentReceiver',
          isMut: true,
          isSigner: false,
          docs: [
            "The group owner receives the closed account's rent, whoever closes it (review 2d N8).",
          ],
        },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'PolicyIdParams' } }],
    },
    {
      name: 'closePolicyChainRecord',
      docs: ['Closes a named policy chain record no lane references.'],
      accounts: [
        { name: 'group', isMut: false, isSigner: false },
        { name: 'policy', isMut: true, isSigner: false },
        { name: 'policyChainRecord', isMut: true, isSigner: false },
        { name: 'authority', isMut: false, isSigner: true },
        {
          name: 'rentReceiver',
          isMut: true,
          isSigner: false,
          docs: [
            "The group owner receives the closed account's rent, whoever closes it (review 2d N8).",
          ],
        },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'PolicyChainParams' } }],
    },
    {
      name: 'configureAllowList',
      docs: [
        'Adds addresses to the allow-list and/or enables the allow-list check.',
        'When enabled, only listed addresses may send tokens through the pool.',
      ],
      accounts: [
        { name: 'state', isMut: true, isSigner: false },
        { name: 'mint', isMut: false, isSigner: false },
        { name: 'authority', isMut: true, isSigner: true },
        { name: 'systemProgram', isMut: false, isSigner: false },
      ],
      args: [
        { name: 'add', type: { vec: 'publicKey' } },
        { name: 'enabled', type: 'bool' },
      ],
    },
    {
      name: 'createAllowlist',
      docs: [
        'Creates a sender allowlist of the group for the send hook (owner or security admin);',
        '`enabled` is fixed for its life.',
      ],
      accounts: [
        { name: 'group', isMut: false, isSigner: false },
        { name: 'allowlist', isMut: true, isSigner: false },
        { name: 'authority', isMut: true, isSigner: true },
        { name: 'systemProgram', isMut: false, isSigner: false },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'CreateAllowlistParams' } }],
    },
    {
      name: 'createBlocklist',
      docs: ['Creates a shared blocklist with its own admin (anyone pays).'],
      accounts: [
        { name: 'blocklist', isMut: true, isSigner: false },
        { name: 'creator', isMut: true, isSigner: true },
        { name: 'systemProgram', isMut: false, isSigner: false },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'CreateBlocklistParams' } }],
    },
    {
      name: 'createGroup',
      docs: [
        'Creates a token group at `[GROUP_SEED, group_id]`, owned by the signer. Lanes (mint × chain)',
        'of any pool of this program can then link to it and read connection, fee and rate-limit',
        'policies from it instead of their own fields.',
      ],
      accounts: [
        { name: 'group', isMut: true, isSigner: false },
        { name: 'authority', isMut: true, isSigner: true },
        { name: 'systemProgram', isMut: false, isSigner: false },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'CreateGroupParams' } }],
    },
    {
      name: 'createPolicy',
      docs: [
        'Creates a named policy of the group carrying the given classes (owner or policy admin).',
      ],
      accounts: [
        { name: 'group', isMut: true, isSigner: false },
        { name: 'authority', isMut: true, isSigner: true },
        { name: 'policy', isMut: true, isSigner: false },
        { name: 'systemProgram', isMut: false, isSigner: false },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'CreatePolicyParams' } }],
    },
    {
      name: 'deleteChainConfig',
      docs: [
        'Closes and reclaims rent from a ChainConfig PDA.',
        'After this call no cross-chain messages can be sent to or from that chain.',
      ],
      accounts: [
        { name: 'state', isMut: false, isSigner: false },
        { name: 'chainConfig', isMut: true, isSigner: false },
        { name: 'authority', isMut: true, isSigner: true },
      ],
      args: [
        { name: 'remoteChainSelector', type: 'u64' },
        { name: 'mint', type: 'publicKey' },
      ],
    },
    {
      name: 'deleteChainConfigOverride',
      docs: ['Closes and reclaims rent from a ChainConfigOverride PDA.'],
      accounts: [
        { name: 'state', isMut: false, isSigner: false },
        { name: 'chainConfigOverride', isMut: true, isSigner: false },
        { name: 'authority', isMut: true, isSigner: true },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'DeleteChainConfigOverrideParams' } }],
    },
    {
      name: 'deriveAccountsLockOrBurnTokens',
      docs: [
        'Called by the router via CPI during `DeriveAccountsCcipSend` to discover',
        'any extra accounts needed for the onramp token transfer.',
        'Burnmint pools have no additional account requirements beyond the',
        'standard token lookup table, so this returns an empty set.',
      ],
      accounts: [],
      args: [
        { name: 'stage', type: 'string' },
        { name: 'LockOrBurn', type: { defined: 'LockOrBurnInV1' } },
      ],
      returns: { defined: 'DeriveAccountsResponse' },
    },
    {
      name: 'deriveAccountsReleaseOrMintTokens',
      docs: [
        'Called by the offramp via CPI during `DeriveAccountsExecute` to discover',
        'any extra accounts needed for the offramp token transfer.',
        'Burnmint pools have no additional account requirements beyond the',
        'standard token lookup table, so this returns an empty set.',
      ],
      accounts: [],
      args: [
        { name: 'stage', type: 'string' },
        { name: 'ReleaseOrMint', type: { defined: 'ReleaseOrMintInV1' } },
      ],
      returns: { defined: 'DeriveAccountsResponse' },
    },
    {
      name: 'editChainConfigV2',
      accounts: [
        { name: 'state', isMut: false, isSigner: false },
        {
          name: 'chainConfigV2',
          isMut: true,
          isSigner: false,
          docs: [
            'Resized by the handler rather than by a `realloc` constraint: a lane linked to a group has a',
            'tail after this body, which the handler keeps (see `LaneConfigV2::store`).',
          ],
        },
        { name: 'authority', isMut: true, isSigner: true },
        { name: 'systemProgram', isMut: false, isSigner: false },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'SetChainConfigV2Params' } }],
    },
    {
      name: 'editChainRemoteConfig',
      docs: [
        'Overwrites the remote config (token address and pool addresses) for an',
        'existing ChainConfig. Reallocates the PDA if the new config is larger.',
      ],
      accounts: [
        { name: 'state', isMut: false, isSigner: false },
        { name: 'chainConfig', isMut: true, isSigner: false },
        { name: 'authority', isMut: true, isSigner: true },
        { name: 'systemProgram', isMut: false, isSigner: false },
      ],
      args: [
        { name: 'remoteChainSelector', type: 'u64' },
        { name: 'mint', type: 'publicKey' },
        { name: 'cfg', type: { defined: 'RemoteConfig' } },
      ],
    },
    {
      name: 'editPolicyChainRecord',
      docs: [
        "Sets one class of a named policy chain record (the class's admin; FEE by the fee admin).",
      ],
      accounts: [
        { name: 'group', isMut: false, isSigner: false },
        { name: 'policy', isMut: false, isSigner: false },
        { name: 'policyChainRecord', isMut: true, isSigner: false },
        { name: 'authority', isMut: false, isSigner: true },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'EditPolicyChainRecordParams' } }],
    },
    {
      name: 'getPoolFee',
      docs: ['Returns the fee receipt for a token transfer.'],
      accounts: [
        { name: 'state', isMut: false, isSigner: false },
        { name: 'chainConfig', isMut: false, isSigner: false },
        {
          name: 'chainConfigV2',
          isMut: false,
          isSigner: false,
          docs: ['May or may not be initialized'],
        },
      ],
      args: [{ name: 'getFeeIn', type: { defined: 'GetFeeParams' } }],
      returns: { defined: 'GetFeeResult' },
    },
    {
      name: 'getRequiredCcvs',
      docs: [
        'This implementation returns base CCVs for all transfers, and includes additional CCVs when the transfer amount is above the configured threshold.',
      ],
      accounts: [
        { name: 'state', isMut: false, isSigner: false },
        { name: 'chainConfig', isMut: false, isSigner: false },
        {
          name: 'chainConfigV2',
          isMut: false,
          isSigner: false,
          docs: ['When initialized (owner == this program)'],
        },
      ],
      args: [{ name: 'getRequiredCcvsIn', type: { defined: 'GetRequiredCCVsIn' } }],
      returns: { defined: 'GetRequiredCCVsOut' },
    },
    {
      name: 'inheritGroupDefault',
      docs: ['Makes one chain record follow the group default again for one class.'],
      accounts: [
        { name: 'group', isMut: false, isSigner: false },
        { name: 'groupChainPolicy', isMut: true, isSigner: false },
        { name: 'authority', isMut: false, isSigner: true },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'InheritGroupDefaultParams' } }],
    },
    {
      name: 'initChainConfigOverride',
      docs: [
        'Initializes a ChainConfigOverride PDA for the given remote chain and override type.',
        'Used to set separate rate limit buckets (e.g. for faster-than-finality transfers).',
      ],
      accounts: [
        { name: 'state', isMut: false, isSigner: false },
        { name: 'chainConfigOverride', isMut: true, isSigner: false },
        { name: 'authority', isMut: true, isSigner: true },
        { name: 'systemProgram', isMut: false, isSigner: false },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'InitChainConfigOverrideParams' } }],
    },
    {
      name: 'initChainConfigV2',
      accounts: [
        { name: 'state', isMut: false, isSigner: false },
        { name: 'chainConfigV2', isMut: true, isSigner: false },
        { name: 'authority', isMut: true, isSigner: true },
        { name: 'systemProgram', isMut: false, isSigner: false },
        {
          name: 'mint',
          isMut: false,
          isSigner: false,
          docs: [
            "The token this pool wraps. Needed to create the fee vault ATA the lane's in-token BPS fee",
            'accrues into.',
          ],
        },
        { name: 'feeVault', isMut: false, isSigner: false },
        {
          name: 'feeVaultTokenAccount',
          isMut: true,
          isSigner: false,
          docs: [
            "The fee vault's ATA for the pool's own mint, where `lock_or_burn_tokens_v2` accrues the",
            'in-token BPS fee. Created here so that configuring a',
            'lane and being able to collect (and withdraw) its BPS fee are the same operation.',
          ],
        },
        { name: 'tokenProgram', isMut: false, isSigner: false },
        { name: 'associatedTokenProgram', isMut: false, isSigner: false },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'SetChainConfigV2Params' } }],
    },
    {
      name: 'initChainRemoteConfig',
      docs: [
        'Initializes a ChainConfig PDA for the given remote chain.',
        'Must be called before any cross-chain messages can be sent to or from',
        'that chain. Remote pool addresses are added separately via',
        'append_remote_pool_addresses.',
      ],
      accounts: [
        { name: 'state', isMut: false, isSigner: false },
        { name: 'chainConfig', isMut: true, isSigner: false },
        { name: 'authority', isMut: true, isSigner: true },
        { name: 'systemProgram', isMut: false, isSigner: false },
      ],
      args: [
        { name: 'remoteChainSelector', type: 'u64' },
        { name: 'mint', type: 'publicKey' },
        { name: 'cfg', type: { defined: 'RemoteConfig' } },
      ],
    },
    {
      name: 'initGlobalConfig',
      docs: [
        'Initializes the program-level PoolConfig PDA.',
        "Must be called once by the program's upgrade authority before any",
        'token pool can be created.',
      ],
      accounts: [
        { name: 'config', isMut: true, isSigner: false },
        { name: 'authority', isMut: true, isSigner: true },
        { name: 'systemProgram', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
        { name: 'programData', isMut: false, isSigner: false },
      ],
      args: [
        { name: 'routerAddress', type: 'publicKey' },
        { name: 'rmnAddress', type: 'publicKey' },
      ],
    },
    {
      name: 'initGroupLanes',
      docs: ['Creates new lanes of one chain directly in a group (batched).'],
      accounts: [
        { name: 'group', isMut: false, isSigner: false },
        { name: 'groupChainPolicy', isMut: true, isSigner: false },
        {
          name: 'groupOwner',
          isMut: false,
          isSigner: true,
          isOptional: true,
          docs: ['Required unless the group has open membership.'],
        },
        { name: 'authority', isMut: true, isSigner: true },
        { name: 'systemProgram', isMut: false, isSigner: false },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'InitGroupLanesParams' } }],
    },
    {
      name: 'initPolicyChainRecord',
      docs: [
        "Creates a named policy's record for a chain of the group (a copy of the policy default).",
      ],
      accounts: [
        { name: 'group', isMut: false, isSigner: false },
        { name: 'policy', isMut: true, isSigner: false },
        { name: 'authority', isMut: true, isSigner: true },
        { name: 'policyChainRecord', isMut: true, isSigner: false },
        { name: 'systemProgram', isMut: false, isSigner: false },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'PolicyChainParams' } }],
    },
    {
      name: 'initialize',
      docs: [
        'Creates a new per-mint State PDA for the given mint.',
        'The upgrade authority (or a mint authority when self-serve is enabled)',
        'becomes the pool owner.',
      ],
      accounts: [
        { name: 'state', isMut: true, isSigner: false },
        { name: 'mint', isMut: false, isSigner: false },
        { name: 'authority', isMut: true, isSigner: true },
        { name: 'systemProgram', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
        { name: 'programData', isMut: false, isSigner: false },
        { name: 'config', isMut: false, isSigner: false },
      ],
      args: [],
    },
    {
      name: 'initializeByMultisig',
      docs: [
        'Creates a new per-mint State PDA for the given mint via a mint authority multisig signer.',
        'Self-serve must be enabled. Only 1-of-N multisigs are supported.',
      ],
      accounts: [
        { name: 'state', isMut: true, isSigner: false },
        { name: 'mint', isMut: false, isSigner: false },
        { name: 'authority', isMut: true, isSigner: true },
        { name: 'systemProgram', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
        { name: 'programData', isMut: false, isSigner: false },
        { name: 'config', isMut: false, isSigner: false },
        {
          name: 'mintAuthorityMultisig',
          isMut: false,
          isSigner: false,
          docs: ['Only 1-of-N SPL Token multisigs are supported here.'],
        },
      ],
      args: [],
    },
    {
      name: 'joinGroup',
      docs: [
        'Tokens join a group once (batched; pool owner, plus the group owner unless open), with the',
        'remote tokens their group-driven lanes are created with.',
      ],
      accounts: [
        { name: 'group', isMut: false, isSigner: false },
        {
          name: 'groupRegistry',
          isMut: true,
          isSigner: false,
          docs: ['join. Loaded and checked by the handlers.'],
        },
        {
          name: 'groupOwner',
          isMut: false,
          isSigner: true,
          isOptional: true,
          docs: ['`join_group` only: required unless the group has open membership.'],
        },
        { name: 'authority', isMut: true, isSigner: true },
        { name: 'systemProgram', isMut: false, isSigner: false },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'JoinGroupParams' } }],
    },
    {
      name: 'linkLanes',
      docs: ['Links existing lanes of one chain to a group in place (batched).'],
      accounts: [
        { name: 'group', isMut: false, isSigner: false },
        { name: 'groupChainPolicy', isMut: true, isSigner: false },
        {
          name: 'groupOwner',
          isMut: false,
          isSigner: true,
          isOptional: true,
          docs: ['Required unless the group has open membership.'],
        },
        { name: 'authority', isMut: true, isSigner: true },
        { name: 'systemProgram', isMut: false, isSigner: false },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'LinkLanesParams' } }],
    },
    {
      name: 'lockOrBurnTokens',
      docs: [
        "Burns tokens from the sender's account as part of an outbound",
        'cross-chain transfer. Called by the router via CPI after the onramp',
        'has validated the message.',
      ],
      accounts: [
        { name: 'authority', isMut: false, isSigner: true },
        { name: 'state', isMut: false, isSigner: false },
        { name: 'tokenProgram', isMut: false, isSigner: false },
        { name: 'mint', isMut: true, isSigner: false },
        { name: 'poolSigner', isMut: false, isSigner: false },
        { name: 'poolTokenAccount', isMut: true, isSigner: false },
        { name: 'rmnRemote', isMut: false, isSigner: false },
        { name: 'rmnRemoteCurses', isMut: false, isSigner: false },
        { name: 'rmnRemoteConfig', isMut: false, isSigner: false },
        { name: 'chainConfig', isMut: true, isSigner: false },
      ],
      args: [{ name: 'lockOrBurn', type: { defined: 'LockOrBurnInV1' } }],
      returns: { defined: 'LockOrBurnOutV1' },
    },
    {
      name: 'lockOrBurnTokensV2',
      docs: ['Burns tokens from the pool as part of an outbound cross-chain transfer (V2).'],
      accounts: [
        { name: 'authority', isMut: false, isSigner: true },
        { name: 'state', isMut: false, isSigner: false },
        { name: 'tokenProgram', isMut: false, isSigner: false },
        { name: 'mint', isMut: true, isSigner: false },
        { name: 'poolSigner', isMut: false, isSigner: false },
        { name: 'poolTokenAccount', isMut: true, isSigner: false },
        { name: 'chainConfig', isMut: true, isSigner: false },
        {
          name: 'chainConfigV2',
          isMut: false,
          isSigner: false,
          docs: ['May or may not be initialized'],
        },
        {
          name: 'chainConfigOverride',
          isMut: true,
          isSigner: false,
          docs: [
            'When initialized (owner == this program), its rate limit buckets',
            'override the default ones for faster-than-finality transfers.',
          ],
        },
        {
          name: 'feeVaultTokenAccount',
          isMut: true,
          isSigner: false,
          docs: [
            'token-pool receipt fees into. In-token BPS fees accrue here until the owner withdraws them',
            'with `withdraw_fee_tokens`. The vault PDA is derived inline rather than passed in: it holds',
            'no data and never signs here, and every account this instruction takes costs 32 bytes of a',
            '`ccip_send` transaction that is already close to the size limit.',
          ],
        },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'lockOrBurn', type: { defined: 'LockOrBurnInV2' } }],
      returns: { defined: 'LockOrBurnOutV2' },
    },
    {
      name: 'materializeGroupLanes',
      docs: ['Creates the group-driven lanes the group enables (batched, permissionless).'],
      accounts: [
        { name: 'group', isMut: false, isSigner: false },
        { name: 'groupChainPolicy', isMut: true, isSigner: false },
        {
          name: 'groupRegistry',
          isMut: false,
          isSigner: false,
          docs: ['`set_group_chain_lanes` for the next member index.'],
        },
        { name: 'authority', isMut: true, isSigner: true },
        { name: 'systemProgram', isMut: false, isSigner: false },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'remoteChainSelector', type: 'u64' }],
    },
    {
      name: 'nestedResolveAccountsStart',
      docs: [
        'Resolves the accounts needed for V2 lock_or_burn or release_or_mint',
        'instructions based on the instruction discriminator.',
      ],
      accounts: [{ name: 'state', isMut: false, isSigner: false }],
      args: [{ name: 'params', type: { defined: 'NestedResolveAccountsParams' } }],
      returns: { defined: 'NestedResolveAccountsResponse' },
    },
    {
      name: 'observeChainConfig',
      docs: [
        "Returns a pool's configuration for a single remote chain, for observability consumers.",
        'Rate limiter buckets are reported as of now, i.e. including the refill accrued since the',
        'last transfer.',
        '',
        'Permissionless and read-only: meant to be executed through `simulateTransaction`. Fails if',
        'the lane has no chain config, which callers can read as "not configured".',
      ],
      accounts: [{ name: 'chainConfig', isMut: false, isSigner: false }],
      args: [
        { name: 'remoteChainSelector', type: 'u64' },
        { name: 'mint', type: 'publicKey' },
      ],
      returns: { defined: 'PoolChainConfigObservation' },
    },
    {
      name: 'observeChainConfigOverride',
      docs: [
        "Returns a pool's rate limit override for a single remote chain and override type, for",
        'observability consumers. Rate limiter buckets are reported as of now, i.e. including the',
        'refill accrued since the last transfer.',
        '',
        'Permissionless and read-only: meant to be executed through `simulateTransaction`. Fails if',
        'the lane has no override of that type, which callers can read as "not overridden".',
      ],
      accounts: [{ name: 'chainConfigOverride', isMut: false, isSigner: false }],
      args: [
        { name: 'remoteChainSelector', type: 'u64' },
        { name: 'mint', type: 'publicKey' },
        { name: 'overrideType', type: { defined: 'PoolChainConfigOverrideType' } },
      ],
      returns: { defined: 'PoolChainConfigOverrideObservation' },
    },
    {
      name: 'observeChainConfigV2',
      docs: [
        "Returns a pool's CCIP 2.0 CCV configuration for a single remote chain, for observability",
        'consumers.',
        '',
        'Permissionless and read-only: meant to be executed through `simulateTransaction`. Fails if',
        'the lane has no CCV config, which callers can read as "not configured".',
      ],
      accounts: [{ name: 'chainConfigV2', isMut: false, isSigner: false }],
      args: [
        { name: 'remoteChainSelector', type: 'u64' },
        { name: 'mint', type: 'publicKey' },
      ],
      returns: { defined: 'PoolChainConfigV2Observation' },
    },
    {
      name: 'observeGroup',
      docs: ["Returns a group's root (owner, roles, settings, chains). Read-only."],
      accounts: [{ name: 'group', isMut: false, isSigner: false }],
      args: [],
      returns: { defined: 'GroupObservation' },
    },
    {
      name: 'observeGroupChainPolicy',
      docs: ['Returns a group chain record. Read-only.'],
      accounts: [{ name: 'groupChainPolicy', isMut: false, isSigner: false }],
      args: [],
      returns: { defined: 'GroupChainPolicyObservation' },
    },
    {
      name: 'observeHooks',
      docs: [
        "Returns a security section's hooks, its lists' admins and the group's hook authority",
        '(a `Group`, `Policy` or chain record; the lists as optional remaining accounts). Read-only.',
      ],
      accounts: [
        { name: 'record', isMut: false, isSigner: false, docs: ['apart by its discriminator.'] },
      ],
      args: [],
      returns: { defined: 'HookObservation' },
    },
    {
      name: 'observeLaneGroup',
      docs: [
        "Returns a lane's effective group configuration (the group chain record as remaining account",
        'when linked). Read-only.',
      ],
      accounts: [
        { name: 'chainConfig', isMut: false, isSigner: false },
        { name: 'chainConfigV2', isMut: false, isSigner: false },
        { name: 'chainConfigOverride', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'ObserveLaneGroupParams' } }],
      returns: { defined: 'LaneGroupObservation' },
    },
    {
      name: 'observeState',
      docs: [
        "Returns a pool's per-mint configuration, for observability consumers.",
        '',
        'Permissionless and read-only: meant to be executed through `simulateTransaction`. The',
        'allow list is reported as a count only.',
      ],
      accounts: [{ name: 'state', isMut: false, isSigner: false }],
      args: [{ name: 'mint', type: 'publicKey' }],
      returns: { defined: 'PoolStateObservation' },
    },
    {
      name: 'releaseOrMintTokens',
      docs: [
        "Mints tokens to the receiver's account as part of an inbound",
        'cross-chain transfer. Called by the offramp via CPI after the',
        'message has been verified and committed.',
      ],
      accounts: [
        { name: 'authority', isMut: false, isSigner: true },
        {
          name: 'offrampProgram',
          isMut: false,
          isSigner: false,
          docs: [
            'CHECK offramp program: exists only to derive the allowed offramp PDA',
            'and the authority PDA.',
          ],
        },
        {
          name: 'allowedOfframp',
          isMut: false,
          isSigner: false,
          docs: [
            'CHECK PDA of the router program verifying the signer is an allowed offramp.',
            "If PDA does not exist, the router doesn't allow this offramp",
          ],
        },
        { name: 'state', isMut: false, isSigner: false },
        { name: 'tokenProgram', isMut: false, isSigner: false },
        { name: 'mint', isMut: true, isSigner: false },
        { name: 'poolSigner', isMut: false, isSigner: false },
        { name: 'poolTokenAccount', isMut: true, isSigner: false },
        { name: 'chainConfig', isMut: true, isSigner: false },
        { name: 'rmnRemote', isMut: false, isSigner: false },
        { name: 'rmnRemoteCurses', isMut: false, isSigner: false },
        { name: 'rmnRemoteConfig', isMut: false, isSigner: false },
        { name: 'receiverTokenAccount', isMut: true, isSigner: false },
      ],
      args: [{ name: 'releaseOrMint', type: { defined: 'ReleaseOrMintInV1' } }],
      returns: { defined: 'ReleaseOrMintOutV1' },
    },
    {
      name: 'releaseOrMintTokensV2',
      docs: ['Mints tokens to the receiver as part of an inbound cross-chain transfer (V2).'],
      accounts: [
        { name: 'authority', isMut: false, isSigner: true },
        {
          name: 'offrampProgram',
          isMut: false,
          isSigner: false,
          docs: [
            'CHECK offramp program: exists only to derive the allowed offramp PDA',
            'and the authority PDA.',
          ],
        },
        {
          name: 'allowedOfframp',
          isMut: false,
          isSigner: false,
          docs: [
            'CHECK PDA of the router program verifying the signer is an allowed offramp.',
            "If PDA does not exist, the router doesn't allow this offramp",
          ],
        },
        { name: 'state', isMut: false, isSigner: false },
        { name: 'tokenProgram', isMut: false, isSigner: false },
        { name: 'mint', isMut: true, isSigner: false },
        { name: 'poolSigner', isMut: false, isSigner: false },
        { name: 'poolTokenAccount', isMut: true, isSigner: false },
        { name: 'chainConfig', isMut: true, isSigner: false },
        {
          name: 'chainConfigOverride',
          isMut: true,
          isSigner: false,
          docs: [
            'When initialized (owner == this program), its rate limit buckets',
            'override the default ones for faster-than-finality transfers.',
          ],
        },
        { name: 'receiverTokenAccount', isMut: true, isSigner: false },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'releaseOrMint', type: { defined: 'ReleaseOrMintInV2' } }],
      returns: { defined: 'ReleaseOrMintOutV2' },
    },
    {
      name: 'removeFromAllowList',
      docs: ['Removes addresses from the allow-list.'],
      accounts: [
        { name: 'state', isMut: true, isSigner: false },
        { name: 'mint', isMut: false, isSigner: false },
        { name: 'authority', isMut: true, isSigner: true },
        { name: 'systemProgram', isMut: false, isSigner: false },
      ],
      args: [{ name: 'remove', type: { vec: 'publicKey' } }],
    },
    {
      name: 'removeGroupChain',
      docs: ['Closes a group chain record that no lane uses.'],
      accounts: [
        { name: 'group', isMut: true, isSigner: false },
        { name: 'groupChainPolicy', isMut: true, isSigner: false },
        { name: 'authority', isMut: false, isSigner: true },
        {
          name: 'rentReceiver',
          isMut: true,
          isSigner: false,
          docs: [
            "The group owner receives the closed account's rent, whoever closes it (review 2d N8).",
          ],
        },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'RemoveGroupChainParams' } }],
    },
    {
      name: 'resetLaneBuckets',
      docs: ["Refills member lanes' buckets to the group's capacities (batched)."],
      accounts: [
        { name: 'group', isMut: false, isSigner: false },
        { name: 'groupChainPolicy', isMut: false, isSigner: false },
        { name: 'authority', isMut: false, isSigner: true },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'ResetLaneBucketsParams' } }],
    },
    {
      name: 'resetPolicySecurity',
      docs: [
        "After an ownership change, resets a named policy's SECURITY (owner only; the `Policy` and all",
        'its records as remaining accounts).',
      ],
      accounts: [
        { name: 'group', isMut: true, isSigner: false },
        {
          name: 'authority',
          isMut: false,
          isSigner: true,
          docs: ['Checked by each handler: the security admin schedules, the owner does the rest.'],
        },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'ResetPolicySecurityParams' } }],
    },
    {
      name: 'scheduleGroupCcvs',
      docs: [
        'Schedules a CCV set on the group default or one chain record (security admin; at least',
        '`min_ccv_activation_delay` ahead). Non-empty lists keep INCLUDE_DEFAULT_CCVS unless the',
        'owner allowed dropping the defaults.',
      ],
      accounts: [
        { name: 'group', isMut: true, isSigner: false },
        {
          name: 'authority',
          isMut: false,
          isSigner: true,
          docs: ['Checked by each handler: the security admin schedules, the owner does the rest.'],
        },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'ScheduleGroupCcvsParams' } }],
    },
    {
      name: 'setAllowDroppingDefaultCcvs',
      docs: ["Lets a security record's CCV lists leave out the lane defaults (group owner)."],
      accounts: [
        { name: 'group', isMut: true, isSigner: false },
        {
          name: 'authority',
          isMut: false,
          isSigner: true,
          docs: ['Checked by each handler: the security admin schedules, the owner does the rest.'],
        },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'SetAllowDroppingDefaultCcvsParams' } }],
    },
    {
      name: 'setChainConfigOverrideRateLimit',
      docs: [
        'Updates the rate limits on a ChainConfigOverride PDA.',
        'Callable by the pool owner or the rate-limit admin.',
      ],
      accounts: [
        { name: 'state', isMut: false, isSigner: false },
        { name: 'chainConfigOverride', isMut: true, isSigner: false },
        { name: 'authority', isMut: false, isSigner: true },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'SetChainConfigOverrideRateLimitParams' } }],
    },
    {
      name: 'setChainRateLimit',
      docs: [
        'Updates the inbound and outbound rate limits for a specific remote chain.',
        'Callable by either the pool owner or the rate-limit admin.',
      ],
      accounts: [
        { name: 'state', isMut: false, isSigner: false },
        { name: 'chainConfig', isMut: true, isSigner: false },
        { name: 'authority', isMut: true, isSigner: true },
      ],
      args: [
        { name: 'remoteChainSelector', type: 'u64' },
        { name: 'mint', type: 'publicKey' },
        { name: 'inbound', type: { defined: 'RateLimitConfig' } },
        { name: 'outbound', type: { defined: 'RateLimitConfig' } },
      ],
    },
    {
      name: 'setGroupChainLanes',
      docs: ["Enables a chain's group-driven lanes for every member or a subset, in one write."],
      accounts: [
        { name: 'group', isMut: false, isSigner: false },
        { name: 'groupChainPolicy', isMut: true, isSigner: false },
        {
          name: 'groupRegistry',
          isMut: false,
          isSigner: false,
          docs: ['`set_group_chain_lanes` for the next member index.'],
        },
        { name: 'authority', isMut: true, isSigner: true },
        { name: 'systemProgram', isMut: false, isSigner: false },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [
        { name: 'remoteChainSelector', type: 'u64' },
        { name: 'params', type: { defined: 'SetGroupChainLanesParams' } },
      ],
    },
    {
      name: 'setGroupChainPause',
      docs: ['Pauses or unpauses, per direction, every member lane of the group on one chain.'],
      accounts: [
        { name: 'group', isMut: false, isSigner: false },
        { name: 'groupChainPolicy', isMut: true, isSigner: false },
        { name: 'authority', isMut: false, isSigner: true },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'SetGroupChainPauseParams' } }],
    },
    {
      name: 'setGroupChainPolicy',
      docs: ['Sets one policy class of one chain record explicitly.'],
      accounts: [
        { name: 'group', isMut: false, isSigner: false },
        { name: 'groupChainPolicy', isMut: true, isSigner: false },
        { name: 'authority', isMut: false, isSigner: true },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'SetGroupChainPolicyParams' } }],
    },
    {
      name: 'setGroupDefault',
      docs: [
        'Sets one class of the group default and writes it into every chain record that follows the',
        'default (all chain records as remaining accounts).',
      ],
      accounts: [
        { name: 'group', isMut: true, isSigner: false },
        { name: 'authority', isMut: false, isSigner: true },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'SetGroupDefaultParams' } }],
    },
    {
      name: 'setGroupPause',
      docs: [
        'Pauses or unpauses every member lane of the group (all chain records as remaining accounts).',
      ],
      accounts: [
        { name: 'group', isMut: true, isSigner: false },
        { name: 'authority', isMut: false, isSigner: true },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'SetGroupPauseParams' } }],
    },
    {
      name: 'setGroupRoles',
      docs: ['Sets every group role. Owner only.'],
      accounts: [
        { name: 'group', isMut: true, isSigner: false },
        { name: 'authority', isMut: false, isSigner: true },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'SetGroupRolesParams' } }],
    },
    {
      name: 'setGroupSettings',
      docs: [
        "Updates open membership and lowers the group's maximum BPS fee (all chain records as",
        'remaining accounts when lowering). Owner only.',
      ],
      accounts: [
        { name: 'group', isMut: true, isSigner: false },
        { name: 'authority', isMut: false, isSigner: true },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'SetGroupSettingsParams' } }],
    },
    {
      name: 'setHookConfig',
      docs: ["Sets a security section's allowlist and blocklist hooks."],
      accounts: [
        { name: 'group', isMut: true, isSigner: false },
        {
          name: 'authority',
          isMut: false,
          isSigner: true,
          docs: ['The owner, or (only to add hooks where there were none) the security admin.'],
        },
        { name: 'allowlist', isMut: false, isSigner: false, isOptional: true },
        { name: 'blocklist', isMut: false, isSigner: false, isOptional: true },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'SetHookConfigParams' } }],
    },
    {
      name: 'setLanePause',
      docs: [
        'Pauses or unpauses, per direction, lanes of one mint (their `ChainConfigV2` accounts as',
        'remaining accounts).',
      ],
      accounts: [
        {
          name: 'state',
          isMut: false,
          isSigner: false,
          docs: [
            '`State` keeps no bump, so its address is bound through its mint: only `initialize` creates',
            '`State` accounts, at `[POOL_STATE_SEED, mint]`.',
          ],
        },
        { name: 'group', isMut: false, isSigner: false },
        {
          name: 'authority',
          isMut: true,
          isSigner: true,
          docs: [
            "The lane owner (`State.owner`) may always set its lanes' flags. Otherwise setting a flag",
            'needs the group owner or pauser and clearing one the group owner or unpauser; checked per',
            'lane in the handler.',
          ],
        },
        { name: 'systemProgram', isMut: false, isSigner: false },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'SetLanePauseParams' } }],
    },
    {
      name: 'setLanePoolData',
      docs: [
        "Sets a lane's own pool-data format and factory UID, used while its CONNECTION class is",
        'inline (the group chain record as remaining account when linked). Lane owner only.',
      ],
      accounts: [
        {
          name: 'state',
          isMut: false,
          isSigner: false,
          docs: [
            '`State` keeps no bump, so its address is bound through its mint: only `initialize` creates',
            '`State` accounts, at `[POOL_STATE_SEED, mint]`.',
          ],
        },
        {
          name: 'chainConfigV2',
          isMut: true,
          isSigner: false,
          docs: ['Resized by the handler, which keeps the body (see `LaneConfigV2::store`).'],
        },
        {
          name: 'chainConfig',
          isMut: true,
          isSigner: false,
          docs: [
            '`LANE_EXTENDED_MARKER`). Loaded and checked at its PDA by the handler (it keeps no bump).',
          ],
        },
        { name: 'authority', isMut: true, isSigner: true },
        { name: 'systemProgram', isMut: false, isSigner: false },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'SetLanePoolDataParams' } }],
    },
    {
      name: 'setMemberRemoteTokens',
      docs: ["Replaces members' remote tokens (batched; pool owner)."],
      accounts: [
        { name: 'group', isMut: false, isSigner: false },
        {
          name: 'groupRegistry',
          isMut: true,
          isSigner: false,
          docs: ['join. Loaded and checked by the handlers.'],
        },
        {
          name: 'groupOwner',
          isMut: false,
          isSigner: true,
          isOptional: true,
          docs: ['`join_group` only: required unless the group has open membership.'],
        },
        { name: 'authority', isMut: true, isSigner: true },
        { name: 'systemProgram', isMut: false, isSigner: false },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'SetMemberRemoteTokensParams' } }],
    },
    {
      name: 'setPolicyDefault',
      docs: [
        "Sets one class of a named policy's default and writes it into every chain record of the",
        'policy that follows the default (all of them as remaining accounts).',
      ],
      accounts: [
        { name: 'group', isMut: false, isSigner: false },
        { name: 'policy', isMut: true, isSigner: false },
        { name: 'authority', isMut: false, isSigner: true },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'SetPolicyDefaultParams' } }],
    },
    {
      name: 'setPolicyEngine',
      docs: [
        "Sets a security section's policy engine (attach on the new one, detach on the old one",
        'unless `skip_detach`).',
      ],
      accounts: [
        { name: 'group', isMut: true, isSigner: false },
        {
          name: 'authority',
          isMut: false,
          isSigner: true,
          docs: ['Checked by each handler: the security admin schedules, the owner does the rest.'],
        },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'SetPolicyEngineParams' } }],
    },
    {
      name: 'setRateLimitAdmin',
      docs: [
        'Sets the rate-limit admin for a token pool.',
        'The rate-limit admin may call set_chain_rate_limit without being the pool owner.',
      ],
      accounts: [
        { name: 'state', isMut: true, isSigner: false },
        { name: 'authority', isMut: true, isSigner: true },
      ],
      args: [
        { name: 'mint', type: 'publicKey' },
        { name: 'newRateLimitAdmin', type: 'publicKey' },
      ],
    },
    {
      name: 'setRmn',
      docs: [
        "Updates the RMN Remote address on an individual token pool's State.",
        'Only callable by the upgrade authority if they also own the pool.',
      ],
      accounts: [
        { name: 'state', isMut: true, isSigner: false },
        { name: 'mint', isMut: false, isSigner: false },
        { name: 'authority', isMut: true, isSigner: true },
        { name: 'program', isMut: false, isSigner: false },
        { name: 'programData', isMut: false, isSigner: false },
      ],
      args: [{ name: 'rmnAddress', type: 'publicKey' }],
    },
    {
      name: 'setRouter',
      docs: [
        "Updates the router address on an individual token pool's State.",
        'Changes the expected signer for lock/burn and release/mint calls.',
        'Only callable by the upgrade authority if they also own the pool.',
      ],
      accounts: [
        { name: 'state', isMut: true, isSigner: false },
        { name: 'mint', isMut: false, isSigner: false },
        { name: 'authority', isMut: true, isSigner: true },
        { name: 'program', isMut: false, isSigner: false },
        { name: 'programData', isMut: false, isSigner: false },
      ],
      args: [{ name: 'newRouter', type: 'publicKey' }],
    },
    {
      name: 'syncGroupCcvs',
      docs: ["Copies a chain record's CCVs into member lanes (permissionless, batched)."],
      accounts: [
        { name: 'group', isMut: false, isSigner: false },
        { name: 'groupChainPolicy', isMut: false, isSigner: false },
        {
          name: 'payer',
          isMut: true,
          isSigner: true,
          docs: [
            'Anyone: the copy is group-authorized data. Pays any growth of the lane accounts.',
          ],
        },
        { name: 'systemProgram', isMut: false, isSigner: false },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'SyncGroupCcvsParams' } }],
    },
    {
      name: 'syncPolicyCcvs',
      docs: [
        "Copies a named policy's chain record CCVs into the lanes taking SECURITY from it",
        '(permissionless, batched).',
      ],
      accounts: [
        { name: 'group', isMut: false, isSigner: false },
        {
          name: 'policyChainRecord',
          isMut: false,
          isSigner: false,
          docs: [
            "The policy's record for `params.remote_chain_selector`, PDA-checked by the handler against",
            '`[POLICY_SEED, group, params.policy_id]` with its stored bump.',
          ],
        },
        {
          name: 'payer',
          isMut: true,
          isSigner: true,
          docs: [
            'Anyone: the copy is group-authorized data. Pays any growth of the lane accounts.',
          ],
        },
        { name: 'systemProgram', isMut: false, isSigner: false },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'SyncPolicyCcvsParams' } }],
    },
    {
      name: 'transferGroupOwnership',
      docs: ['Proposes a new group owner, who must call `accept_group_ownership`.'],
      accounts: [
        { name: 'group', isMut: true, isSigner: false },
        { name: 'authority', isMut: false, isSigner: true },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'TransferGroupOwnershipParams' } }],
    },
    {
      name: 'transferListAdmin',
      docs: ['Proposes a new admin for an allowlist or blocklist (current admin).'],
      accounts: [
        { name: 'list', isMut: true, isSigner: false },
        {
          name: 'authority',
          isMut: false,
          isSigner: true,
          docs: [
            'The admin (transfer) or the proposed admin (accept), checked by the handler. For an',
            "allowlist, also its group's owner, who may always propose a new admin (review 2e S1).",
          ],
        },
        {
          name: 'group',
          isMut: false,
          isSigner: false,
          isOptional: true,
          docs: ["The allowlist's group, when its owner transfers the admin role."],
        },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'TransferListAdminParams' } }],
    },
    {
      name: 'transferMintAuthorityToMultisig',
      docs: [
        'Transfers the mint authority from the pool-signer PDA to a multisig.',
        'Used when an operator wants shared, multi-party control over minting.',
        'Only the program upgrade authority may invoke this.',
      ],
      accounts: [
        { name: 'state', isMut: true, isSigner: false },
        { name: 'mint', isMut: true, isSigner: false },
        { name: 'tokenProgram', isMut: false, isSigner: false },
        { name: 'poolSigner', isMut: false, isSigner: false },
        { name: 'authority', isMut: false, isSigner: true },
        { name: 'newMultisigMintAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
        { name: 'programData', isMut: false, isSigner: false },
      ],
      args: [],
    },
    {
      name: 'transferMintAuthorityToPdaSigner',
      docs: [
        'Transfers the mint authority back from a multisig to the pool-signer PDA.',
        'Used during migration cleanup to revert from a multisig back to direct',
        'pool-signer control.',
      ],
      accounts: [
        { name: 'state', isMut: false, isSigner: false },
        { name: 'mint', isMut: true, isSigner: false },
        { name: 'tokenProgram', isMut: false, isSigner: false },
        { name: 'poolSigner', isMut: false, isSigner: false },
        { name: 'authority', isMut: false, isSigner: true },
        { name: 'currentMintAuthorityAccount', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
        { name: 'programData', isMut: false, isSigner: false },
      ],
      args: [],
    },
    {
      name: 'transferOwnership',
      docs: [
        'Initiates an ownership transfer for this token pool to a new proposed owner.',
        'The proposed owner must call accept_ownership to complete the handover.',
      ],
      accounts: [
        { name: 'state', isMut: true, isSigner: false },
        { name: 'mint', isMut: false, isSigner: false },
        { name: 'authority', isMut: false, isSigner: true },
      ],
      args: [{ name: 'proposedOwner', type: 'publicKey' }],
    },
    {
      name: 'typeVersion',
      docs: [
        'Returns the program type (name) and version string encoded at build time.',
        'Offchain code calls this to confirm which program and version is deployed',
        'before sending any other instruction.',
      ],
      accounts: [],
      args: [],
      returns: 'string',
    },
    {
      name: 'unlinkLanes',
      docs: [
        'Unlinks lanes of one chain from a group, restoring their own configuration (batched).',
      ],
      accounts: [
        { name: 'group', isMut: false, isSigner: false },
        { name: 'groupChainPolicy', isMut: true, isSigner: false },
        { name: 'authority', isMut: true, isSigner: true },
        { name: 'systemProgram', isMut: false, isSigner: false },
        { name: 'eventAuthority', isMut: false, isSigner: false },
        { name: 'program', isMut: false, isSigner: false },
      ],
      args: [{ name: 'params', type: { defined: 'UnlinkLanesParams' } }],
    },
    {
      name: 'updateDefaultRmn',
      docs: [
        'Updates the default RMN Remote address stored in PoolConfig.',
        'New token pools created after this call will use the new RMN Remote.',
      ],
      accounts: [
        { name: 'config', isMut: true, isSigner: false },
        { name: 'authority', isMut: false, isSigner: true },
        { name: 'program', isMut: false, isSigner: false },
        { name: 'programData', isMut: false, isSigner: false },
      ],
      args: [{ name: 'rmnAddress', type: 'publicKey' }],
    },
    {
      name: 'updateDefaultRouter',
      docs: [
        'Updates the default router address stored in PoolConfig.',
        'New token pools created after this call will use the new router.',
      ],
      accounts: [
        { name: 'config', isMut: true, isSigner: false },
        { name: 'authority', isMut: false, isSigner: true },
        { name: 'program', isMut: false, isSigner: false },
        { name: 'programData', isMut: false, isSigner: false },
      ],
      args: [{ name: 'routerAddress', type: 'publicKey' }],
    },
    {
      name: 'updateSelfServedAllowed',
      docs: [
        'Enables or disables self-served pool initialization.',
        'When enabled, any mint authority may create a pool for their mint',
        'without requiring the program upgrade authority.',
      ],
      accounts: [
        { name: 'config', isMut: true, isSigner: false },
        { name: 'authority', isMut: false, isSigner: true },
        { name: 'program', isMut: false, isSigner: false },
        { name: 'programData', isMut: false, isSigner: false },
      ],
      args: [{ name: 'selfServedAllowed', type: 'bool' }],
    },
    {
      name: 'withdrawFeeTokens',
      docs: [
        'Sweeps the fees this pool accrued for `mint` in a single fee token into a recipient token',
        "account of the pool owner's choosing. Restricted to the pool owner.",
        '',
        'If `amount` is provided, only the requested amount is transferred. Otherwise (if None) the',
        'entire balance is transferred.',
      ],
      accounts: [
        { name: 'state', isMut: false, isSigner: false },
        {
          name: 'mint',
          isMut: false,
          isSigner: false,
          docs: [
            'The token this pool wraps. Unrelated to `fee_token_mint`, but part of the fee vault seeds.',
          ],
        },
        { name: 'feeVault', isMut: false, isSigner: false },
        { name: 'feeVaultTokenAccount', isMut: true, isSigner: false },
        {
          name: 'recipient',
          isMut: true,
          isSigner: false,
          docs: [
            'Where the fees go. Freely chosen by the pool owner, unlike the executor and the CCVs, which',
            'pin the destination to a `fee_aggregator` held in their config.',
          ],
        },
        {
          name: 'feeTokenMint',
          isMut: false,
          isSigner: false,
          docs: [
            'The token the fees were billed in, which is whatever the sender paid with, so a pool',
            'accrues one vault ATA per fee token it has ever been paid in.',
          ],
        },
        { name: 'feeTokenProgram', isMut: false, isSigner: false },
        { name: 'authority', isMut: false, isSigner: true },
      ],
      args: [{ name: 'amount', type: { option: 'u64' } }],
    },
  ],
  accounts: [
    {
      name: 'allowlist',
      type: {
        kind: 'struct',
        fields: [
          { name: 'version', type: 'u8' },
          { name: 'bump', type: 'u8' },
          { name: 'group', type: 'publicKey' },
          { name: 'listId', type: 'publicKey' },
          { name: 'admin', type: 'publicKey' },
          { name: 'proposedAdmin', type: 'publicKey' },
          { name: 'enabled', type: 'bool' },
          { name: 'entryCount', type: 'u32' },
          { name: 'reserved', type: { array: ['u8', 32] } },
        ],
      },
    },
    {
      name: 'blocklist',
      type: {
        kind: 'struct',
        fields: [
          { name: 'version', type: 'u8' },
          { name: 'bump', type: 'u8' },
          { name: 'creator', type: 'publicKey' },
          { name: 'blocklistId', type: 'publicKey' },
          { name: 'admin', type: 'publicKey' },
          { name: 'proposedAdmin', type: 'publicKey' },
          { name: 'entryCount', type: 'u32' },
          { name: 'reserved', type: { array: ['u8', 32] } },
        ],
      },
    },
    {
      name: 'chainConfig',
      type: { kind: 'struct', fields: [{ name: 'base', type: { defined: 'BaseChain' } }] },
    },
    {
      name: 'chainConfigOverride',
      type: {
        kind: 'struct',
        fields: [
          { name: 'bump', type: 'u8' },
          { name: 'version', type: 'u8' },
          { name: 'base', type: { defined: 'BaseOverrideConfig' } },
        ],
      },
    },
    {
      name: 'chainConfigV2',
      type: {
        kind: 'struct',
        fields: [
          { name: 'bump', type: 'u8' },
          { name: 'version', type: 'u8' },
          { name: 'remoteChainSelector', type: 'u64' },
          { name: 'mint', type: 'publicKey' },
          {
            name: 'allowedFinalityConfig',
            docs: [
              'Allowed finality policy for *outbound* (lock_or_burn) transfers on this lane.',
              "Mirrors EVM's pool-wide `s_allowedFinalityConfig`. Zero-initialized",
              '(`WAIT_FOR_FINALITY`) means only full-finality transfers are permitted.',
            ],
            type: { defined: 'FinalityConfig' },
          },
          { name: 'tokenTransferFeeConfig', type: { defined: 'TokenTransferFeeConfig' } },
          { name: 'ccvConfig', type: { defined: 'CCVConfig' } },
        ],
      },
    },
    {
      name: 'group',
      type: {
        kind: 'struct',
        fields: [
          { name: 'version', type: 'u8' },
          { name: 'bump', type: 'u8' },
          {
            name: 'groupId',
            docs: ['Chosen by the creator; only used to derive the address.'],
            type: 'publicKey',
          },
          { name: 'owner', type: 'publicKey' },
          { name: 'proposedOwner', type: 'publicKey' },
          { name: 'roles', type: { defined: 'GroupRoles' } },
          {
            name: 'maxBpsFee',
            docs: [
              "Cap on every BPS fee of the group's records. Only the owner can change it, and only down.",
            ],
            type: 'u16',
          },
          {
            name: 'openMembership',
            docs: [
              'When set, joining needs only the lane owner; otherwise the group owner must co-sign.',
            ],
            type: 'bool',
          },
          {
            name: 'paused',
            docs: [
              'Mirrors `GroupChainPolicy.group_paused`, so records added while paused start paused.',
            ],
            type: 'bool',
          },
          {
            name: 'minCcvActivationDelay',
            docs: [
              'Minimum notice, in seconds, for a scheduled CCV change (at most',
              '`MAX_MIN_CCV_ACTIVATION_DELAY`). A decrease waits out the notice in force (see',
              '`pending_min_ccv_activation_delay`).',
            ],
            type: 'u64',
          },
          { name: 'defaultPolicy', type: { defined: 'PolicySections' } },
          {
            name: 'ccvEpochCounter',
            docs: [
              'Group-wide CCV epoch counter: every scheduled set of the group (default or chain record)',
              'takes the next value, so no two sets ever share an epoch (review 2c B1).',
            ],
            type: 'u64',
          },
          {
            name: 'pendingMinCcvActivationDelay',
            docs: [
              'A lowered `min_ccv_activation_delay`, applied from `pending_min_ccv_activation_delay_at`',
              '(0 = none).',
            ],
            type: 'u64',
          },
          { name: 'pendingMinCcvActivationDelayAt', type: 'i64' },
          {
            name: 'nextPolicyId',
            docs: [
              'Named policies are numbered `0..next_policy_id` (`create_policy` takes the next id), so the',
              'group can enumerate them (`observe_group`), closed ones leaving gaps.',
            ],
            type: 'u32',
          },
          {
            name: 'securityGeneration',
            docs: [
              'Bumped on every ownership acceptance (review 2d S3). Named SECURITY records carry the',
              'generation they were last reset or written in; a record from an older generation fails closed',
              'until the new owner resets it (`reset_policy_security`).',
            ],
            type: 'u32',
          },
          {
            name: 'hookLookupTable',
            docs: [
              "An address lookup table the owner keeps with the group's static hook accounts (named",
              'records, hook authority, engine program and statics). The resolvers return it with the hook',
              'accounts, so a lane with four named slots and every hook still fits a transaction (review 2e',
              'S4). Carved from `reserved`: `Pubkey::default()` = none.',
            ],
            type: 'publicKey',
          },
          {
            name: 'chainSelectors',
            docs: [
              'Chains the group has a `GroupChainPolicy` for. Group-wide writes take all of them.',
            ],
            type: { vec: 'u64' },
          },
        ],
      },
    },
    {
      name: 'groupChainPolicy',
      type: {
        kind: 'struct',
        fields: [
          { name: 'version', type: 'u8' },
          { name: 'bump', type: 'u8' },
          { name: 'group', type: 'publicKey' },
          { name: 'remoteChainSelector', type: 'u64' },
          {
            name: 'inheritsDefault',
            docs: [
              'One bit per `PolicyClass` (`PolicyClass::bit`): the class follows the group default.',
            ],
            type: 'u16',
          },
          { name: 'groupPaused', type: 'bool' },
          { name: 'pausedOutbound', type: 'bool' },
          { name: 'pausedInbound', type: 'bool' },
          {
            name: 'memberLaneCount',
            docs: [
              'Lanes linked to the group on this chain. A record with members cannot be closed.',
            ],
            type: 'u32',
          },
          { name: 'policy', type: { defined: 'PolicySections' } },
          {
            name: 'poolDataDemand',
            docs: ["What the member lanes need from `policy`'s pool-data settings."],
            type: { defined: 'PoolDataDemand' },
          },
          {
            name: 'maxBpsFee',
            docs: [
              'Mirror of `Group.max_bps_fee`, written by `add_group_chain` and `set_group_settings`, so the',
              'transfer path enforces the cap on any policy-sourced fee without another account (review 2d',
              'S2). `max_bps_fee_set` = false only on records written before the mirror existed.',
            ],
            type: 'u16',
          },
          { name: 'maxBpsFeeSet', type: 'bool' },
          {
            name: 'securityGeneration',
            docs: ['Mirror of `Group.security_generation`, written on ownership acceptance.'],
            type: 'u32',
          },
          {
            name: 'laneMode',
            docs: [
              'Group-driven lanes on this chain (increment 2f, `set_group_chain_lanes`): none, every',
              "member, or the members in the subset bitmap stored after the record's fixed allocation",
              '(see [`GROUP_CHAIN_POLICY_FIXED_LEN`]). Carved from `reserved`: older records read `Off`.',
            ],
            type: { defined: 'GroupLaneMode' },
          },
          {
            name: 'drivenLanesPaused',
            docs: [
              'Group-driven lanes on this chain are paused in both directions (they can be materialized',
              'and inspected, not used). Enabling a chain from `Off` must set it (review 2f S2); clearing it',
              'needs the owner or `unpauser`. Hand-linked lanes ignore it.',
            ],
            type: 'bool',
          },
          { name: 'reserved', type: { array: ['u8', 42] } },
        ],
      },
    },
    {
      name: 'policy',
      type: {
        kind: 'struct',
        fields: [
          { name: 'version', type: 'u8' },
          { name: 'bump', type: 'u8' },
          { name: 'group', type: 'publicKey' },
          { name: 'policyId', type: 'u32' },
          {
            name: 'classes',
            docs: [
              'One bit per `PolicyClass` (`PolicyClass::bit`) the policy carries. Lanes may take only',
              'these classes from it, and only these sections are written.',
            ],
            type: 'u16',
          },
          { name: 'defaultPolicy', type: { defined: 'PolicySections' } },
          {
            name: 'securityGeneration',
            docs: [
              "The group's `security_generation` this policy's SECURITY default was last reset or written in.",
            ],
            type: 'u32',
          },
          { name: 'reserved', type: { array: ['u8', 60] } },
          {
            name: 'chainSelectors',
            docs: [
              'Chains the policy has a `PolicyChainRecord` for. A policy with records cannot be closed',
              '(`PolicyHasRecords`); policy-wide writes take all of them.',
            ],
            type: { vec: 'u64' },
          },
        ],
      },
    },
    {
      name: 'policyChainRecord',
      type: {
        kind: 'struct',
        fields: [
          { name: 'version', type: 'u8' },
          { name: 'bump', type: 'u8' },
          { name: 'policy', type: 'publicKey' },
          { name: 'remoteChainSelector', type: 'u64' },
          { name: 'group', type: 'publicKey' },
          {
            name: 'classes',
            docs: ["Copied from the policy at creation (fixed for the policy's life)."],
            type: 'u16',
          },
          { name: 'inheritsDefault', type: 'u16' },
          {
            name: 'laneRefCount',
            docs: [
              'Lanes referencing this record for any class. A record in use cannot be closed',
              '(`PolicyInUse`).',
            ],
            type: 'u32',
          },
          { name: 'sections', type: { defined: 'PolicySections' } },
          {
            name: 'poolDataDemand',
            docs: ["What the referencing lanes need from `sections`' pool-data settings."],
            type: { defined: 'PoolDataDemand' },
          },
          {
            name: 'securityGeneration',
            docs: [
              "The group's `security_generation` this record's SECURITY section was last reset or written",
              'in; an older one fails transfers closed (review 2d S3).',
            ],
            type: 'u32',
          },
          { name: 'reserved', type: { array: ['u8', 59] } },
        ],
      },
    },
    {
      name: 'poolConfig',
      type: {
        kind: 'struct',
        fields: [
          { name: 'version', type: 'u8' },
          { name: 'selfServedAllowed', type: 'bool' },
          { name: 'router', type: 'publicKey' },
          { name: 'rmnRemote', type: 'publicKey' },
        ],
      },
    },
    {
      name: 'state',
      type: {
        kind: 'struct',
        fields: [
          { name: 'version', type: 'u8' },
          { name: 'config', type: { defined: 'BaseConfig' } },
        ],
      },
    },
  ],
  types: [
    {
      name: 'ActivateGroupCcvsNowParams',
      type: {
        kind: 'struct',
        fields: [
          { name: 'remoteChainSelector', type: { option: 'u64' } },
          { name: 'policyId', type: { option: 'u32' } },
          { name: 'outbound', type: { vec: 'publicKey' } },
          { name: 'inbound', type: { vec: 'publicKey' } },
        ],
      },
    },
    {
      name: 'AddGroupChainParams',
      type: { kind: 'struct', fields: [{ name: 'remoteChainSelector', type: 'u64' }] },
    },
    {
      name: 'Allowlist',
      type: {
        kind: 'struct',
        fields: [
          { name: 'version', type: 'u8' },
          { name: 'bump', type: 'u8' },
          { name: 'group', type: 'publicKey' },
          { name: 'listId', type: 'publicKey' },
          { name: 'admin', type: 'publicKey' },
          { name: 'proposedAdmin', type: 'publicKey' },
          { name: 'enabled', type: 'bool' },
          { name: 'entryCount', type: 'u32' },
          { name: 'reserved', type: { array: ['u8', 32] } },
        ],
      },
    },
    {
      name: 'ApplyListUpdatesParams',
      type: {
        kind: 'struct',
        fields: [
          {
            name: 'adds',
            docs: [
              'Entries to add: senders (32-byte keys) for an allowlist; addresses of any chain (normalized',
              'before hashing) for a blocklist. Their entry PDAs follow as remaining accounts (writable),',
              'then those of `removes`, in order.',
            ],
            type: { vec: 'bytes' },
          },
          { name: 'removes', type: { vec: 'bytes' } },
        ],
      },
    },
    {
      name: 'AssignLanePoliciesParams',
      type: {
        kind: 'struct',
        fields: [
          { name: 'remoteChainSelector', type: 'u64' },
          {
            name: 'classSource',
            docs: [
              'Per `PolicyClass`: 0 = inline, 1 = the group default, 2..=5 = the named policy in',
              '`policy_slots[source - 2]`. Applied to every lane of the batch.',
            ],
            type: { array: ['u8', 4] },
          },
          {
            name: 'policySlots',
            docs: [
              'The named policies (`Policy` accounts) the slots hold; unused slots are the default key.',
            ],
            type: { array: ['publicKey', 4] },
          },
          {
            name: 'recordCount',
            docs: [
              'How many leading remaining accounts are `PolicyChainRecord`s (writable): every record',
              'referenced before or after by any lane of the batch, for this chain.',
            ],
            type: 'u8',
          },
        ],
      },
    },
    {
      name: 'BaseChain',
      type: {
        kind: 'struct',
        fields: [
          { name: 'remote', type: { defined: 'RemoteConfig' } },
          { name: 'inboundRateLimit', type: { defined: 'RateLimitTokenBucket' } },
          { name: 'outboundRateLimit', type: { defined: 'RateLimitTokenBucket' } },
        ],
      },
    },
    {
      name: 'BaseConfig',
      type: {
        kind: 'struct',
        fields: [
          { name: 'tokenProgram', type: 'publicKey' },
          { name: 'mint', type: 'publicKey' },
          { name: 'decimals', type: 'u8' },
          { name: 'poolSigner', type: 'publicKey' },
          { name: 'poolTokenAccount', type: 'publicKey' },
          { name: 'owner', type: 'publicKey' },
          { name: 'proposedOwner', type: 'publicKey' },
          { name: 'rateLimitAdmin', type: 'publicKey' },
          { name: 'routerOnrampAuthority', type: 'publicKey' },
          { name: 'router', type: 'publicKey' },
          {
            name: 'rebalancer',
            docs: [
              'Set the rebalancer address for the pool; if set to the default "no rebalance" address',
              '(Pubkey::default()), no rebalance is allowed.',
            ],
            type: 'publicKey',
          },
          {
            name: 'canAcceptLiquidity',
            docs: [
              'DEPRECATED: this field is no longer enforced at runtime. It is kept for backward',
              'compatibility (no PDA migration) and is always initialized to `true`.',
              'To disable inflows operationally, set the rebalancer to `Pubkey::default()`.',
            ],
            type: 'bool',
          },
          { name: 'listEnabled', type: 'bool' },
          { name: 'allowList', type: { vec: 'publicKey' } },
          { name: 'rmnRemote', type: 'publicKey' },
        ],
      },
    },
    {
      name: 'BaseOverrideConfig',
      type: {
        kind: 'struct',
        fields: [
          { name: 'remoteChainSelector', type: 'u64' },
          { name: 'mint', type: 'publicKey' },
          { name: 'inboundRateLimit', type: { defined: 'RateLimitTokenBucket' } },
          { name: 'outboundRateLimit', type: { defined: 'RateLimitTokenBucket' } },
          { name: 'overrideType', type: { defined: 'PoolChainConfigOverrideType' } },
        ],
      },
    },
    {
      name: 'Blocklist',
      type: {
        kind: 'struct',
        fields: [
          { name: 'version', type: 'u8' },
          { name: 'bump', type: 'u8' },
          { name: 'creator', type: 'publicKey' },
          { name: 'blocklistId', type: 'publicKey' },
          { name: 'admin', type: 'publicKey' },
          { name: 'proposedAdmin', type: 'publicKey' },
          { name: 'entryCount', type: 'u32' },
          { name: 'reserved', type: { array: ['u8', 32] } },
        ],
      },
    },
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
      name: 'ChainConfig',
      type: { kind: 'struct', fields: [{ name: 'base', type: { defined: 'BaseChain' } }] },
    },
    {
      name: 'ChainConfigOverride',
      type: {
        kind: 'struct',
        fields: [
          { name: 'bump', type: 'u8' },
          { name: 'version', type: 'u8' },
          { name: 'base', type: { defined: 'BaseOverrideConfig' } },
        ],
      },
    },
    {
      name: 'ChainConfigV2',
      type: {
        kind: 'struct',
        fields: [
          { name: 'bump', type: 'u8' },
          { name: 'version', type: 'u8' },
          { name: 'remoteChainSelector', type: 'u64' },
          { name: 'mint', type: 'publicKey' },
          {
            name: 'allowedFinalityConfig',
            docs: [
              'Allowed finality policy for *outbound* (lock_or_burn) transfers on this lane.',
              "Mirrors EVM's pool-wide `s_allowedFinalityConfig`. Zero-initialized",
              '(`WAIT_FOR_FINALITY`) means only full-finality transfers are permitted.',
            ],
            type: { defined: 'FinalityConfig' },
          },
          { name: 'tokenTransferFeeConfig', type: { defined: 'TokenTransferFeeConfig' } },
          { name: 'ccvConfig', type: { defined: 'CCVConfig' } },
        ],
      },
    },
    {
      name: 'CloseGroupLanesParams',
      type: {
        kind: 'struct',
        fields: [
          {
            name: 'recordCount',
            docs: [
              'The leading remaining accounts are the named policy chain records (writable) the lanes',
              "reference: their references are released (review 2f S1). The group owner's wallet follows",
              'them, then the lanes.',
            ],
            type: 'u8',
          },
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
      name: 'CreateAllowlistParams',
      type: {
        kind: 'struct',
        fields: [
          { name: 'listId', type: 'publicKey' },
          {
            name: 'enabled',
            docs: ["Fixed for the list's life (EVM constructor-time `allowlistEnabled`)."],
            type: 'bool',
          },
          { name: 'admin', type: 'publicKey' },
        ],
      },
    },
    {
      name: 'CreateBlocklistParams',
      type: {
        kind: 'struct',
        fields: [
          { name: 'blocklistId', type: 'publicKey' },
          { name: 'admin', type: 'publicKey' },
        ],
      },
    },
    {
      name: 'CreateGroupParams',
      type: {
        kind: 'struct',
        fields: [
          {
            name: 'groupId',
            docs: ["Any key the creator picks; the group's address is `[GROUP_SEED, group_id]`."],
            type: 'publicKey',
          },
          {
            name: 'maxBpsFee',
            docs: [
              "Cap on every BPS fee the group's records may charge (at most 10,000). `None` sets",
              '`DEFAULT_GROUP_MAX_BPS_FEE` (1,000). After creation the cap can only go down.',
            ],
            type: { option: 'u16' },
          },
          {
            name: 'openMembership',
            docs: ["When set, lane owners join without the group owner's signature."],
            type: 'bool',
          },
          {
            name: 'minCcvActivationDelay',
            docs: ['Minimum notice, in seconds, for a scheduled CCV change.'],
            type: 'u64',
          },
        ],
      },
    },
    {
      name: 'CreatePolicyParams',
      type: {
        kind: 'struct',
        fields: [
          {
            name: 'policyId',
            docs: [
              "Must be the group's `next_policy_id`: policies are numbered from 0 so the group can enumerate",
              "them. The policy's address is `[POLICY_SEED, group, policy_id_le]`.",
            ],
            type: 'u32',
          },
          {
            name: 'classes',
            docs: ['One bit per class (`PolicyClass::bit`) the policy carries; at least one.'],
            type: 'u16',
          },
        ],
      },
    },
    {
      name: 'DeleteChainConfigOverrideParams',
      type: {
        kind: 'struct',
        fields: [
          { name: 'remoteChainSelector', type: 'u64' },
          { name: 'mint', type: 'publicKey' },
          { name: 'overrideType', type: { defined: 'PoolChainConfigOverrideType' } },
        ],
      },
    },
    {
      name: 'DeriveAccountsResponse',
      type: {
        kind: 'struct',
        fields: [
          {
            name: 'askAgainWith',
            type: { vec: { defined: 'base_token_pool::v1::CcipAccountMeta' } },
          },
          {
            name: 'accountsToSave',
            type: { vec: { defined: 'base_token_pool::v1::CcipAccountMeta' } },
          },
          { name: 'lookUpTablesToSave', type: { vec: 'publicKey' } },
          { name: 'currentStage', type: 'string' },
          { name: 'nextStage', type: 'string' },
        ],
      },
    },
    {
      name: 'EditPolicyChainRecordParams',
      type: {
        kind: 'struct',
        fields: [
          { name: 'policyId', type: 'u32' },
          { name: 'remoteChainSelector', type: 'u64' },
          {
            name: 'section',
            docs: [
              'Written to the chain record, which stops following the policy default for that class.',
            ],
            type: { defined: 'PolicySection' },
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
      name: 'GetFeeParams',
      type: {
        kind: 'struct',
        fields: [
          { name: 'remoteChainSelector', type: 'u64' },
          { name: 'amount', type: 'u64' },
          { name: 'localToken', type: 'publicKey' },
          { name: 'feeToken', type: 'publicKey' },
          { name: 'requestedFinalityConfig', type: { defined: 'FinalityConfig' } },
          { name: 'tokenArgs', type: 'bytes' },
        ],
      },
    },
    {
      name: 'GetFeeResult',
      type: {
        kind: 'struct',
        fields: [
          { name: 'destGasLimit', type: 'u32' },
          { name: 'destBytesOverhead', type: 'u32' },
          { name: 'fee', type: 'u32' },
          { name: 'tokenFeeBps', type: 'u16' },
          { name: 'isEnabled', type: 'bool' },
        ],
      },
    },
    {
      name: 'GetRequiredCCVsIn',
      type: {
        kind: 'struct',
        fields: [
          { name: 'remoteChainSelector', type: 'u64' },
          {
            name: 'amount',
            docs: [
              'Token amount used to determine the required CCVs.',
              '',
              "For inbound transfers, the amount is denominated in the remote token's decimals",
              'and must be converted to local token decimals before applying amount-based CCV',
              'policies. For outbound transfers, the amount is already denominated in local',
              "token decimals, but is the gross amount before the pool's in-token BPS fee: the",
              'pool deducts that fee before applying amount-based CCV policies, as it only sends',
              'the post-fee remainder cross-chain. Inbound amounts are already post-fee.',
            ],
            type: { defined: 'ProtocolAmount' },
          },
          { name: 'localToken', type: 'publicKey' },
          { name: 'direction', type: { defined: 'MessageDirection' } },
          { name: 'requestedFinalityConfig', type: { defined: 'FinalityConfig' } },
        ],
      },
    },
    {
      name: 'GetRequiredCCVsOut',
      type: { kind: 'struct', fields: [{ name: 'requiredCcvs', type: { vec: 'publicKey' } }] },
    },
    {
      name: 'Group',
      type: {
        kind: 'struct',
        fields: [
          { name: 'version', type: 'u8' },
          { name: 'bump', type: 'u8' },
          {
            name: 'groupId',
            docs: ['Chosen by the creator; only used to derive the address.'],
            type: 'publicKey',
          },
          { name: 'owner', type: 'publicKey' },
          { name: 'proposedOwner', type: 'publicKey' },
          { name: 'roles', type: { defined: 'GroupRoles' } },
          {
            name: 'maxBpsFee',
            docs: [
              "Cap on every BPS fee of the group's records. Only the owner can change it, and only down.",
            ],
            type: 'u16',
          },
          {
            name: 'openMembership',
            docs: [
              'When set, joining needs only the lane owner; otherwise the group owner must co-sign.',
            ],
            type: 'bool',
          },
          {
            name: 'paused',
            docs: [
              'Mirrors `GroupChainPolicy.group_paused`, so records added while paused start paused.',
            ],
            type: 'bool',
          },
          {
            name: 'minCcvActivationDelay',
            docs: [
              'Minimum notice, in seconds, for a scheduled CCV change (at most',
              '`MAX_MIN_CCV_ACTIVATION_DELAY`). A decrease waits out the notice in force (see',
              '`pending_min_ccv_activation_delay`).',
            ],
            type: 'u64',
          },
          { name: 'defaultPolicy', type: { defined: 'PolicySections' } },
          {
            name: 'ccvEpochCounter',
            docs: [
              'Group-wide CCV epoch counter: every scheduled set of the group (default or chain record)',
              'takes the next value, so no two sets ever share an epoch (review 2c B1).',
            ],
            type: 'u64',
          },
          {
            name: 'pendingMinCcvActivationDelay',
            docs: [
              'A lowered `min_ccv_activation_delay`, applied from `pending_min_ccv_activation_delay_at`',
              '(0 = none).',
            ],
            type: 'u64',
          },
          { name: 'pendingMinCcvActivationDelayAt', type: 'i64' },
          {
            name: 'nextPolicyId',
            docs: [
              'Named policies are numbered `0..next_policy_id` (`create_policy` takes the next id), so the',
              'group can enumerate them (`observe_group`), closed ones leaving gaps.',
            ],
            type: 'u32',
          },
          {
            name: 'securityGeneration',
            docs: [
              'Bumped on every ownership acceptance (review 2d S3). Named SECURITY records carry the',
              'generation they were last reset or written in; a record from an older generation fails closed',
              'until the new owner resets it (`reset_policy_security`).',
            ],
            type: 'u32',
          },
          {
            name: 'hookLookupTable',
            docs: [
              "An address lookup table the owner keeps with the group's static hook accounts (named",
              'records, hook authority, engine program and statics). The resolvers return it with the hook',
              'accounts, so a lane with four named slots and every hook still fits a transaction (review 2e',
              'S4). Carved from `reserved`: `Pubkey::default()` = none.',
            ],
            type: 'publicKey',
          },
          {
            name: 'chainSelectors',
            docs: [
              'Chains the group has a `GroupChainPolicy` for. Group-wide writes take all of them.',
            ],
            type: { vec: 'u64' },
          },
        ],
      },
    },
    {
      name: 'GroupChainPolicy',
      type: {
        kind: 'struct',
        fields: [
          { name: 'version', type: 'u8' },
          { name: 'bump', type: 'u8' },
          { name: 'group', type: 'publicKey' },
          { name: 'remoteChainSelector', type: 'u64' },
          {
            name: 'inheritsDefault',
            docs: [
              'One bit per `PolicyClass` (`PolicyClass::bit`): the class follows the group default.',
            ],
            type: 'u16',
          },
          { name: 'groupPaused', type: 'bool' },
          { name: 'pausedOutbound', type: 'bool' },
          { name: 'pausedInbound', type: 'bool' },
          {
            name: 'memberLaneCount',
            docs: [
              'Lanes linked to the group on this chain. A record with members cannot be closed.',
            ],
            type: 'u32',
          },
          { name: 'policy', type: { defined: 'PolicySections' } },
          {
            name: 'poolDataDemand',
            docs: ["What the member lanes need from `policy`'s pool-data settings."],
            type: { defined: 'PoolDataDemand' },
          },
          {
            name: 'maxBpsFee',
            docs: [
              'Mirror of `Group.max_bps_fee`, written by `add_group_chain` and `set_group_settings`, so the',
              'transfer path enforces the cap on any policy-sourced fee without another account (review 2d',
              'S2). `max_bps_fee_set` = false only on records written before the mirror existed.',
            ],
            type: 'u16',
          },
          { name: 'maxBpsFeeSet', type: 'bool' },
          {
            name: 'securityGeneration',
            docs: ['Mirror of `Group.security_generation`, written on ownership acceptance.'],
            type: 'u32',
          },
          {
            name: 'laneMode',
            docs: [
              'Group-driven lanes on this chain (increment 2f, `set_group_chain_lanes`): none, every',
              "member, or the members in the subset bitmap stored after the record's fixed allocation",
              '(see [`GROUP_CHAIN_POLICY_FIXED_LEN`]). Carved from `reserved`: older records read `Off`.',
            ],
            type: { defined: 'GroupLaneMode' },
          },
          {
            name: 'drivenLanesPaused',
            docs: [
              'Group-driven lanes on this chain are paused in both directions (they can be materialized',
              'and inspected, not used). Enabling a chain from `Off` must set it (review 2f S2); clearing it',
              'needs the owner or `unpauser`. Hand-linked lanes ignore it.',
            ],
            type: 'bool',
          },
          { name: 'reserved', type: { array: ['u8', 42] } },
        ],
      },
    },
    {
      name: 'GroupChainPolicyObservation',
      type: {
        kind: 'struct',
        fields: [
          { name: 'observationVersion', type: 'u16' },
          { name: 'typeVersion', type: 'string' },
          { name: 'version', type: 'u8' },
          { name: 'group', type: 'publicKey' },
          { name: 'remoteChainSelector', type: 'u64' },
          { name: 'inheritsDefault', type: 'u16' },
          { name: 'groupPaused', type: 'bool' },
          { name: 'pausedOutbound', type: 'bool' },
          { name: 'pausedInbound', type: 'bool' },
          { name: 'memberLaneCount', type: 'u32' },
          { name: 'policy', type: { defined: 'PolicySections' } },
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
      name: 'GroupObservation',
      docs: [
        "A group's root, without its default policy (read it from any chain record that inherits, or",
        'from the account): return data is capped at 1,024 bytes.',
      ],
      type: {
        kind: 'struct',
        fields: [
          { name: 'observationVersion', type: 'u16' },
          { name: 'typeVersion', type: 'string' },
          { name: 'version', type: 'u8' },
          { name: 'groupId', type: 'publicKey' },
          { name: 'owner', type: 'publicKey' },
          { name: 'proposedOwner', type: 'publicKey' },
          { name: 'roles', type: { defined: 'GroupRoles' } },
          { name: 'maxBpsFee', type: 'u16' },
          { name: 'openMembership', type: 'bool' },
          { name: 'paused', type: 'bool' },
          { name: 'chainSelectors', type: { vec: 'u64' } },
          {
            name: 'nextPolicyId',
            docs: [
              'Named policies are numbered `0..next_policy_id` (closed ones leave gaps): the list an owner',
              'reviews after an ownership change.',
            ],
            type: 'u32',
          },
          { name: 'securityGeneration', type: 'u32' },
          { name: 'minCcvActivationDelay', type: 'u64' },
          {
            name: 'hookLookupTable',
            docs: [
              '`Pubkey::default()`: none. Its authority (if not frozen) can close it: review it after a',
              "hand-over (appended; `observation_version` is ccip_common's shared constant).",
            ],
            type: 'publicKey',
          },
        ],
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
      name: 'HookObservation',
      docs: [
        "A security section's hooks and who controls them (review 2e S1, N5, N10): what a new owner",
        'reviews after a hand-over. The admins are filled when the lists are passed as remaining',
        'accounts. A lane escapes these hooks when its SECURITY is inline, or comes from another record',
        '(a detached chain record, or a named policy without hooks).',
      ],
      type: {
        kind: 'struct',
        fields: [
          { name: 'observationVersion', type: 'u16' },
          {
            name: 'record',
            docs: ['The record observed: a `Group` or `Policy` (its default) or one chain record.'],
            type: 'publicKey',
          },
          { name: 'hook', type: { option: { defined: 'HookConfig' } } },
          { name: 'allowlistAdmin', type: { option: 'publicKey' } },
          { name: 'blocklistAdmin', type: { option: 'publicKey' } },
          {
            name: 'hookAuthority',
            docs: ["The pool's signer on engine calls for this record's group."],
            type: 'publicKey',
          },
        ],
      },
    },
    {
      name: 'InheritGroupDefaultParams',
      type: {
        kind: 'struct',
        fields: [
          { name: 'remoteChainSelector', type: 'u64' },
          {
            name: 'class',
            docs: [
              'The chain record copies the default for this class and follows it from now on.',
            ],
            type: { defined: 'PolicyClass' },
          },
        ],
      },
    },
    {
      name: 'InitChainConfigOverrideParams',
      type: {
        kind: 'struct',
        fields: [
          { name: 'remoteChainSelector', type: 'u64' },
          { name: 'mint', type: 'publicKey' },
          { name: 'overrideType', type: { defined: 'PoolChainConfigOverrideType' } },
          { name: 'inbound', type: { defined: 'RateLimitConfig' } },
          { name: 'outbound', type: { defined: 'RateLimitConfig' } },
        ],
      },
    },
    {
      name: 'InitGroupLaneEntry',
      type: {
        kind: 'struct',
        fields: [
          { name: 'mint', type: 'publicKey' },
          {
            name: 'remote',
            docs: [
              "The lane's inline connection: remote token, decimals and the remote pools it trusts itself.",
            ],
            type: { defined: 'RemoteConfig' },
          },
        ],
      },
    },
    {
      name: 'InitGroupLanesParams',
      type: {
        kind: 'struct',
        fields: [
          { name: 'remoteChainSelector', type: 'u64' },
          { name: 'classSource', type: { array: ['u8', 4] } },
          { name: 'lanes', type: { vec: { defined: 'InitGroupLaneEntry' } } },
        ],
      },
    },
    {
      name: 'JoinGroupEntry',
      type: {
        kind: 'struct',
        fields: [
          { name: 'mint', type: 'publicKey' },
          {
            name: 'remoteTokens',
            docs: ["The remote tokens the member's group-driven lanes are created with, by chain."],
            type: { vec: { defined: 'MemberRemoteToken' } },
          },
        ],
      },
    },
    {
      name: 'JoinGroupParams',
      type: {
        kind: 'struct',
        fields: [
          {
            name: 'rentReceiver',
            docs: ["Receives the members' rent when they close (the first remaining account)."],
            type: 'publicKey',
          },
          { name: 'members', type: { vec: { defined: 'JoinGroupEntry' } } },
        ],
      },
    },
    {
      name: 'LaneGroupObservation',
      docs: ['What a lane actually applies, per class, after resolving its group link.'],
      type: {
        kind: 'struct',
        fields: [
          { name: 'observationVersion', type: 'u16' },
          { name: 'typeVersion', type: 'string' },
          { name: 'mint', type: 'publicKey' },
          { name: 'remoteChainSelector', type: 'u64' },
          {
            name: 'group',
            docs: ['`Pubkey::default()` when the lane is not linked.'],
            type: 'publicKey',
          },
          { name: 'classSource', type: { array: ['u8', 4] } },
          {
            name: 'outboundPaused',
            docs: [
              'Whether a transfer in each direction is paused at any level (group, chain, lane).',
            ],
            type: 'bool',
          },
          { name: 'inboundPaused', type: 'bool' },
          { name: 'lanePausedOutbound', type: 'bool' },
          { name: 'lanePausedInbound', type: 'bool' },
          { name: 'allowedFinalityConfig', type: { defined: 'FinalityConfig' } },
          { name: 'feeConfig', type: { option: { defined: 'TokenTransferFeeConfig' } } },
          {
            name: 'inboundRateLimit',
            docs: ['The buckets as of now under the configs the lane applies.'],
            type: { defined: 'RateLimiterObservation' },
          },
          { name: 'outboundRateLimit', type: { defined: 'RateLimiterObservation' } },
          { name: 'ftfInboundRateLimit', type: { option: { defined: 'RateLimiterObservation' } } },
          { name: 'ftfOutboundRateLimit', type: { option: { defined: 'RateLimiterObservation' } } },
        ],
      },
    },
    {
      name: 'LinkLanesParams',
      type: {
        kind: 'struct',
        fields: [
          { name: 'remoteChainSelector', type: 'u64' },
          {
            name: 'classSource',
            docs: [
              "Per `PolicyClass`: 0 = the lane's own (inline) fields, 1 = the group default. `SECURITY`",
              'stays inline in this version.',
            ],
            type: { array: ['u8', 4] },
          },
        ],
      },
    },
    {
      name: 'LockOrBurnInV1',
      type: {
        kind: 'struct',
        fields: [
          { name: 'receiver', type: 'bytes' },
          { name: 'remoteChainSelector', type: 'u64' },
          { name: 'originalSender', type: 'publicKey' },
          { name: 'amount', type: 'u64' },
          { name: 'localToken', type: 'publicKey' },
          {
            name: 'msgTotalNonce',
            docs: [
              "DEPRECATED. The onramp's full nonce for this message, keyed by `original_sender` and",
              '`remote_chain_selector`. Still populated with a real value by the 1.6 onramp',
              "(`ccip-router`'s `instructions_v1/v1/onramp.rs`), but hard-coded to `0` by `ccip_send_v2`,",
              'which no longer tracks per-sender nonces.',
              '',
              'The only pool that reads it is `cctp-token-pool`, which uses it as a PDA seed for the',
              "`cctp_message_sent_event` account (see that program's `lib.rs` and `derive.rs`). A constant",
              '`0` would therefore collide across messages — so the `0` is only sound because a CCTP v1 pool',
              'can never be reached from `ccip_send_v2`:',
              '',
              '- CCTP and Lombard are the only v1 pools that set `implements_account_resolution`.',
              "- `TokenTransferContext::new` (the router's `instructions/common.rs`) verifies the",
              '`TokenAdminRegistry` PDA and then rejects `interface_version == 1` &&',
              '`implements_account_resolution` with `UnsupportedPoolV1ResolutionOnLaneV2`. That runs in',
              '`ccip_send_v2` before any pool CPI, so it is the authoritative gate; the account-resolution',
              'stage (`ccip_send/resolve_accounts/token_transfer_static.rs`) rejects the same combination',
              'earlier, but is only advisory since callers can build the transaction themselves.',
              '- `set_pool_interface_implementation` additionally refuses to register',
              '`implements_account_resolution` below `interface_version` 2. The runtime check still',
              'matters because registries migrated from 1.6 can carry the v1/resolution combination.',
              '',
              'Removing the field outright is a breaking change to the v1 pool interface, so it stays until',
              'the 1.6 lane is retired. Anything that starts consuming it must not assume it is meaningful',
              'on the v2 lane.',
            ],
            type: 'u64',
          },
        ],
      },
    },
    {
      name: 'LockOrBurnInV2',
      type: {
        kind: 'struct',
        fields: [
          { name: 'receiver', type: 'bytes' },
          { name: 'remoteChainSelector', type: 'u64' },
          { name: 'originalSender', type: 'publicKey' },
          { name: 'amount', type: 'u64' },
          { name: 'localToken', type: 'publicKey' },
          { name: 'requestedFinalityConfig', type: { defined: 'FinalityConfig' } },
          { name: 'tokenArgs', type: 'bytes' },
        ],
      },
    },
    {
      name: 'LockOrBurnOutV1',
      type: {
        kind: 'struct',
        fields: [
          { name: 'destTokenAddress', type: { defined: 'RemoteAddress' } },
          { name: 'destPoolData', type: 'bytes' },
        ],
      },
    },
    {
      name: 'LockOrBurnOutV2',
      type: {
        kind: 'struct',
        fields: [
          { name: 'destTokenAddress', type: { defined: 'RemoteAddress' } },
          { name: 'destPoolData', type: 'bytes' },
          { name: 'destTokenAmount', type: 'u64' },
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
      name: 'MessageDirection',
      docs: ['Direction of a cross-chain message, used for CCV requirements.'],
      type: { kind: 'enum', variants: [{ name: 'Outbound' }, { name: 'Inbound' }] },
    },
    {
      name: 'NestedResolveAccountsParams',
      docs: [
        'Resolution parameters used by nested resolvers. Rather than the full ix_data and a metadata',
        'field, they have an opaque `cpi_resolution_inputs` field that doubles as both. The caller',
        'of the nested resolution is responsible for correctly encoding it by consulting',
        'the documentation.',
      ],
      type: {
        kind: 'struct',
        fields: [
          {
            name: 'caller',
            docs: ['The account expected to sign the final instruction being resolved.'],
            type: 'publicKey',
          },
          {
            name: 'callerProgram',
            docs: [
              'The program ID that derived `caller` and is driving this resolution (the router on the',
              'send side, the offramp on the execute side).',
            ],
            type: 'publicKey',
          },
          {
            name: 'cpiResolutionInputs',
            docs: [
              'Will be deserialized into a type the nested resolver understands. For what to',
              "send in the first stage of nested resolution, consult the nested resolver's documentation.",
            ],
            type: 'bytes',
          },
        ],
      },
    },
    {
      name: 'NestedResolveAccountsResponse',
      type: {
        kind: 'struct',
        fields: [
          {
            name: 'askAgainWith',
            docs: [
              'In the next resolution round, call the resolution method',
              'including these accounts (all read-only).',
            ],
            type: { vec: 'publicKey' },
          },
          {
            name: 'accountsToSave',
            docs: [
              'Append these accounts to a separate accumulator list. Once',
              '`next_ix_discriminator` is empty, this accumulated list',
              'contains all accounts for the instruction of interest.',
            ],
            type: { vec: { defined: 'ccip_common::resolution::CcipAccountMeta' } },
          },
          {
            name: 'lookupTablesToSave',
            docs: [
              'Append these lookup tables to a separate accumulator list.',
              'Once resolution is complete, the accumulated list contains all',
              'LUTs that the instruction of interest can use.',
            ],
            type: { vec: 'publicKey' },
          },
          {
            name: 'nextCpiResolutionInputs',
            docs: ['If nonempty, perform another resolution stage with these inputs.'],
            type: 'bytes',
          },
        ],
      },
    },
    {
      name: 'ObserveLaneGroupParams',
      type: {
        kind: 'struct',
        fields: [
          { name: 'remoteChainSelector', type: 'u64' },
          { name: 'mint', type: 'publicKey' },
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
      name: 'Policy',
      type: {
        kind: 'struct',
        fields: [
          { name: 'version', type: 'u8' },
          { name: 'bump', type: 'u8' },
          { name: 'group', type: 'publicKey' },
          { name: 'policyId', type: 'u32' },
          {
            name: 'classes',
            docs: [
              'One bit per `PolicyClass` (`PolicyClass::bit`) the policy carries. Lanes may take only',
              'these classes from it, and only these sections are written.',
            ],
            type: 'u16',
          },
          { name: 'defaultPolicy', type: { defined: 'PolicySections' } },
          {
            name: 'securityGeneration',
            docs: [
              "The group's `security_generation` this policy's SECURITY default was last reset or written in.",
            ],
            type: 'u32',
          },
          { name: 'reserved', type: { array: ['u8', 60] } },
          {
            name: 'chainSelectors',
            docs: [
              'Chains the policy has a `PolicyChainRecord` for. A policy with records cannot be closed',
              '(`PolicyHasRecords`); policy-wide writes take all of them.',
            ],
            type: { vec: 'u64' },
          },
        ],
      },
    },
    {
      name: 'PolicyChainParams',
      type: {
        kind: 'struct',
        fields: [
          { name: 'policyId', type: 'u32' },
          { name: 'remoteChainSelector', type: 'u64' },
        ],
      },
    },
    {
      name: 'PolicyChainRecord',
      type: {
        kind: 'struct',
        fields: [
          { name: 'version', type: 'u8' },
          { name: 'bump', type: 'u8' },
          { name: 'policy', type: 'publicKey' },
          { name: 'remoteChainSelector', type: 'u64' },
          { name: 'group', type: 'publicKey' },
          {
            name: 'classes',
            docs: ["Copied from the policy at creation (fixed for the policy's life)."],
            type: 'u16',
          },
          { name: 'inheritsDefault', type: 'u16' },
          {
            name: 'laneRefCount',
            docs: [
              'Lanes referencing this record for any class. A record in use cannot be closed',
              '(`PolicyInUse`).',
            ],
            type: 'u32',
          },
          { name: 'sections', type: { defined: 'PolicySections' } },
          {
            name: 'poolDataDemand',
            docs: ["What the referencing lanes need from `sections`' pool-data settings."],
            type: { defined: 'PoolDataDemand' },
          },
          {
            name: 'securityGeneration',
            docs: [
              "The group's `security_generation` this record's SECURITY section was last reset or written",
              'in; an older one fails transfers closed (review 2d S3).',
            ],
            type: 'u32',
          },
          { name: 'reserved', type: { array: ['u8', 59] } },
        ],
      },
    },
    {
      name: 'PolicyClass',
      docs: [
        'The policy classes. EVM assigns six policy types per token; Solana merges the ones that are',
        'always read together on the same paths (connection + remote pool, fee + dest overhead).',
      ],
      type: {
        kind: 'enum',
        variants: [
          { name: 'Connection' },
          { name: 'Fee' },
          { name: 'RateLimit' },
          { name: 'Security' },
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
      name: 'PolicyIdParams',
      type: { kind: 'struct', fields: [{ name: 'policyId', type: 'u32' }] },
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
    {
      name: 'PolicySections',
      docs: [
        "One value per policy class: a group's default record (EVM's selector-0 record) and each of its",
        'chain records.',
      ],
      type: {
        kind: 'struct',
        fields: [
          { name: 'connection', type: { defined: 'ConnectionPolicy' } },
          { name: 'fee', type: { defined: 'FeePolicy' } },
          { name: 'rateLimit', type: { defined: 'RateLimitPolicy' } },
          { name: 'security', type: { defined: 'SecurityPolicy' } },
        ],
      },
    },
    {
      name: 'PoolChainConfigObservation',
      docs: ['Per-remote-chain configuration of a token pool, as observed by off-chain consumers.'],
      type: {
        kind: 'struct',
        fields: [
          { name: 'observationVersion', type: 'u16' },
          { name: 'typeVersion', type: 'string' },
          { name: 'remoteChainSelector', type: 'u64' },
          { name: 'mint', type: 'publicKey' },
          {
            name: 'remoteTokenAddress',
            docs: ['Token address on the remote chain, as raw bytes.'],
            type: 'bytes',
          },
          { name: 'remoteDecimals', type: 'u8' },
          {
            name: 'remotePoolAddresses',
            docs: [
              'Pool addresses on the remote chain, as raw bytes. More than one entry means earlier pool',
              'versions are still accepted as sources.',
            ],
            type: { vec: 'bytes' },
          },
          { name: 'inboundRateLimit', type: { defined: 'RateLimiterObservation' } },
          { name: 'outboundRateLimit', type: { defined: 'RateLimiterObservation' } },
        ],
      },
    },
    {
      name: 'PoolChainConfigOverrideObservation',
      docs: [
        'Per-remote-chain, per-override-type rate limit override of a token pool, as observed by',
        'off-chain consumers.',
        '',
        'Override PDAs are optional: when a lane has no override of the requested type, the observing',
        'instruction fails, which callers can read as "not overridden".',
      ],
      type: {
        kind: 'struct',
        fields: [
          { name: 'observationVersion', type: 'u16' },
          { name: 'typeVersion', type: 'string' },
          { name: 'version', type: 'u8' },
          { name: 'remoteChainSelector', type: 'u64' },
          { name: 'mint', type: 'publicKey' },
          {
            name: 'overrideType',
            docs: ['Which flavour of transfer this override applies to (e.g. fast transfers).'],
            type: { defined: 'PoolChainConfigOverrideType' },
          },
          { name: 'inboundRateLimit', type: { defined: 'RateLimiterObservation' } },
          { name: 'outboundRateLimit', type: { defined: 'RateLimiterObservation' } },
        ],
      },
    },
    { name: 'PoolChainConfigOverrideType', type: { kind: 'enum', variants: [{ name: 'FTF' }] } },
    {
      name: 'PoolChainConfigV2Observation',
      docs: [
        'Per-remote-chain CCIP 2.0 configuration of a token pool, as observed by off-chain consumers.',
      ],
      type: {
        kind: 'struct',
        fields: [
          { name: 'observationVersion', type: 'u16' },
          { name: 'typeVersion', type: 'string' },
          { name: 'version', type: 'u8' },
          { name: 'remoteChainSelector', type: 'u64' },
          { name: 'mint', type: 'publicKey' },
          {
            name: 'thresholdAmount',
            docs: [
              'Transfer amount above which the threshold CCVs are additionally required. Zero disables the',
              'threshold lists.',
            ],
            type: 'u64',
          },
          { name: 'outboundCcvs', type: { vec: 'publicKey' } },
          { name: 'thresholdOutboundCcvs', type: { vec: 'publicKey' } },
          { name: 'inboundCcvs', type: { vec: 'publicKey' } },
          { name: 'thresholdInboundCcvs', type: { vec: 'publicKey' } },
          {
            name: 'allowedFinalityConfig',
            docs: ['Allowed finality policy for outbound (lock_or_burn) transfers on this lane.'],
            type: { defined: 'FinalityConfig' },
          },
        ],
      },
    },
    {
      name: 'PoolConfig',
      type: {
        kind: 'struct',
        fields: [
          { name: 'version', type: 'u8' },
          { name: 'selfServedAllowed', type: 'bool' },
          { name: 'router', type: 'publicKey' },
          { name: 'rmnRemote', type: 'publicKey' },
        ],
      },
    },
    {
      name: 'PoolDataDemand',
      docs: [
        "What a chain record's member lanes need from its pool-data settings, counted at link, unlink,",
        'init and `set_lane_pool_data` (see [`PolicySections::validate_pool_data_fee`]). Members that',
        "take `CONNECTION` from the record without a UID are covered by the record's own format.",
      ],
      type: {
        kind: 'struct',
        fields: [
          {
            name: 'feeInlineLong',
            docs: [
              'Members with `FEE` from the record, an inline `CONNECTION` sending the long format and no UID.',
            ],
            type: 'u32',
          },
          {
            name: 'feeUid',
            docs: ['Members with `FEE` from the record and a UID (always the long format).'],
            type: 'u32',
          },
          {
            name: 'connectionUid',
            docs: ['Members with `CONNECTION` from the record and a UID.'],
            type: 'u32',
          },
        ],
      },
    },
    {
      name: 'PoolDataFormat',
      docs: ['The remote pool data a lane emits on send.'],
      type: { kind: 'enum', variants: [{ name: 'Legacy32' }, { name: 'Long' }] },
    },
    {
      name: 'PoolStateObservation',
      docs: [
        'Per-mint configuration of a token pool, as observed by off-chain consumers.',
        '',
        'The allow list is reported as a count only, as its size is unbounded by configuration.',
      ],
      type: {
        kind: 'struct',
        fields: [
          { name: 'observationVersion', type: 'u16' },
          { name: 'typeVersion', type: 'string' },
          { name: 'version', type: 'u8' },
          { name: 'tokenProgram', type: 'publicKey' },
          { name: 'mint', type: 'publicKey' },
          { name: 'decimals', type: 'u8' },
          { name: 'poolSigner', type: 'publicKey' },
          { name: 'poolTokenAccount', type: 'publicKey' },
          { name: 'owner', type: 'publicKey' },
          { name: 'proposedOwner', type: 'publicKey' },
          { name: 'rateLimitAdmin', type: 'publicKey' },
          { name: 'router', type: 'publicKey' },
          { name: 'routerOnrampAuthority', type: 'publicKey' },
          { name: 'rmnRemote', type: 'publicKey' },
          {
            name: 'rebalancer',
            docs: [
              'Rebalancer, only meaningful for lock/release pools. The default pubkey means rebalancing is',
              'not allowed.',
            ],
            type: 'publicKey',
          },
          { name: 'listEnabled', type: 'bool' },
          { name: 'allowListCount', type: 'u32' },
        ],
      },
    },
    {
      name: 'ProtocolAmount',
      docs: [
        'CCIP 2.0 compatible cross-chain amount representation (u256 in big-endian bytes, based',
        'on abi.encodePacked)',
      ],
      type: { kind: 'struct', fields: [{ name: 'beBytes', type: { array: ['u8', 32] } }] },
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
      name: 'RateLimitTokenBucket',
      type: {
        kind: 'struct',
        fields: [
          { name: 'tokens', type: 'u64' },
          { name: 'lastUpdated', type: 'u64' },
          { name: 'cfg', type: { defined: 'RateLimitConfig' } },
        ],
      },
    },
    {
      name: 'RateLimiterObservation',
      docs: ['State of one rate limiter bucket, as of the moment of observation.'],
      type: {
        kind: 'struct',
        fields: [
          { name: 'isEnabled', type: 'bool' },
          { name: 'capacity', type: 'u64' },
          { name: 'rate', type: 'u64' },
          {
            name: 'tokens',
            docs: [
              'Tokens available now: the stored balance plus the refill accrued since the bucket was last',
              "touched, capped at `capacity`. This is the value EVM's `getCurrent*RateLimiterState`",
              'returns, not the raw stored balance.',
            ],
            type: 'u64',
          },
          {
            name: 'lastUpdated',
            docs: [
              'Timestamp the `tokens` value corresponds to (the observation time, for an enabled bucket).',
            ],
            type: 'u64',
          },
        ],
      },
    },
    {
      name: 'ReleaseOrMintInV1',
      type: {
        kind: 'struct',
        fields: [
          { name: 'originalSender', type: { defined: 'RemoteAddress' } },
          { name: 'remoteChainSelector', type: 'u64' },
          { name: 'receiver', type: 'publicKey' },
          { name: 'amount', type: { array: ['u8', 32] } },
          { name: 'localToken', type: 'publicKey' },
          {
            name: 'sourcePoolAddress',
            docs: [
              '@dev WARNING: sourcePoolAddress should be checked prior to any processing of funds. Make sure it matches the',
              'expected pool address for the given remoteChainSelector.',
            ],
            type: { defined: 'RemoteAddress' },
          },
          { name: 'sourcePoolData', type: 'bytes' },
          {
            name: 'offchainTokenData',
            docs: ['@dev WARNING: offchainTokenData is untrusted data.'],
            type: 'bytes',
          },
        ],
      },
    },
    {
      name: 'ReleaseOrMintInV2',
      type: {
        kind: 'struct',
        fields: [
          { name: 'originalSender', type: { defined: 'RemoteAddress' } },
          { name: 'remoteChainSelector', type: 'u64' },
          { name: 'receiver', type: 'publicKey' },
          { name: 'amount', type: { defined: 'ProtocolAmount' } },
          { name: 'localToken', type: 'publicKey' },
          { name: 'sourcePoolAddress', type: { defined: 'RemoteAddress' } },
          { name: 'sourcePoolData', type: 'bytes' },
          { name: 'requestedFinalityConfig', type: { defined: 'FinalityConfig' } },
          { name: 'receiverUsage', type: { defined: 'SVMTokenReceiverUsage' } },
        ],
      },
    },
    {
      name: 'ReleaseOrMintOutV1',
      type: { kind: 'struct', fields: [{ name: 'destinationAmount', type: 'u64' }] },
    },
    {
      name: 'ReleaseOrMintOutV2',
      type: { kind: 'struct', fields: [{ name: 'destinationAmount', type: 'u64' }] },
    },
    {
      name: 'RemoteAddress',
      type: { kind: 'struct', fields: [{ name: 'address', type: 'bytes' }] },
    },
    {
      name: 'RemoteConfig',
      type: {
        kind: 'struct',
        fields: [
          { name: 'poolAddresses', type: { vec: { defined: 'RemoteAddress' } } },
          { name: 'tokenAddress', type: { defined: 'RemoteAddress' } },
          { name: 'decimals', type: 'u8' },
        ],
      },
    },
    {
      name: 'RemoveGroupChainParams',
      type: { kind: 'struct', fields: [{ name: 'remoteChainSelector', type: 'u64' }] },
    },
    {
      name: 'ResetLaneBucketsParams',
      type: {
        kind: 'struct',
        fields: [
          { name: 'remoteChainSelector', type: 'u64' },
          {
            name: 'policyId',
            docs: [
              "`None`: lanes on the group default's RATE_LIMIT. `Some`: lanes on this named policy's, whose",
              'chain record is then the first remaining account (review 2d N2).',
            ],
            type: { option: 'u32' },
          },
        ],
      },
    },
    {
      name: 'ResetPolicySecurityParams',
      type: { kind: 'struct', fields: [{ name: 'policyId', type: 'u32' }] },
    },
    {
      name: 'SVMTokenReceiverUsage',
      type: {
        kind: 'enum',
        variants: [
          { name: 'DeriveAtaAndCreate' },
          { name: 'DeriveAtaDontCreate' },
          { name: 'UseAsIs' },
        ],
      },
    },
    {
      name: 'ScheduleGroupCcvsParams',
      type: {
        kind: 'struct',
        fields: [
          {
            name: 'remoteChainSelector',
            docs: [
              "`None`: the default (the group's, or the named policy's), written into every chain record",
              "that follows it for `SECURITY` (as remaining accounts: all the group's chain records; for a",
              'named policy, the `Policy` account first, then all its chain records). `Some`: that chain',
              'record only (the one remaining account), which then stops following the default.',
            ],
            type: { option: 'u64' },
          },
          {
            name: 'policyId',
            docs: [
              "`None`: the group's own security policy. `Some`: the group's named policy with this id,",
              'which must carry `SECURITY`.',
            ],
            type: { option: 'u32' },
          },
          { name: 'outbound', type: { vec: 'publicKey' } },
          { name: 'inbound', type: { vec: 'publicKey' } },
          {
            name: 'activatesAt',
            docs: ['Must be at least `Group.min_ccv_activation_delay` seconds from now.'],
            type: 'i64',
          },
        ],
      },
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
      name: 'SetAllowDroppingDefaultCcvsParams',
      type: {
        kind: 'struct',
        fields: [
          { name: 'remoteChainSelector', type: { option: 'u64' } },
          { name: 'policyId', type: { option: 'u32' } },
          { name: 'allow', type: 'bool' },
        ],
      },
    },
    {
      name: 'SetChainConfigOverrideRateLimitParams',
      type: {
        kind: 'struct',
        fields: [
          { name: 'remoteChainSelector', type: 'u64' },
          { name: 'mint', type: 'publicKey' },
          { name: 'overrideType', type: { defined: 'PoolChainConfigOverrideType' } },
          { name: 'inbound', type: { defined: 'RateLimitConfig' } },
          { name: 'outbound', type: { defined: 'RateLimitConfig' } },
        ],
      },
    },
    {
      name: 'SetChainConfigV2Params',
      type: {
        kind: 'struct',
        fields: [
          { name: 'mint', type: 'publicKey' },
          { name: 'remoteChainSelector', type: 'u64' },
          {
            name: 'allowedFinalityConfig',
            docs: [
              'Allowed finality policy for outbound (lock_or_burn) transfers on this lane.',
              '`WAIT_FOR_FINALITY` (zero) permits only full-finality transfers.',
            ],
            type: { defined: 'FinalityConfig' },
          },
          { name: 'tokenTransferFeeConfig', type: { defined: 'TokenTransferFeeConfig' } },
          { name: 'ccvConfig', type: { defined: 'CCVConfig' } },
        ],
      },
    },
    {
      name: 'SetGroupChainLanesParams',
      type: {
        kind: 'struct',
        fields: [
          { name: 'mode', type: { defined: 'GroupLaneMode' } },
          {
            name: 'drivenLanesPaused',
            docs: [
              "Pause the chain's group-driven lanes (both directions). Required when enabling from `Off`.",
            ],
            type: 'bool',
          },
          {
            name: 'bitmapWrite',
            docs: ['Applied first: a raw overwrite of the subset bitmap (bulk changes).'],
            type: { option: { defined: 'SubsetBitmapWrite' } },
          },
          {
            name: 'remove',
            docs: ['Member indices removed from the subset, then those added.'],
            type: { vec: 'u32' },
          },
          { name: 'add', type: { vec: 'u32' } },
        ],
      },
    },
    {
      name: 'SetGroupChainPauseParams',
      type: {
        kind: 'struct',
        fields: [
          { name: 'remoteChainSelector', type: 'u64' },
          { name: 'pausedOutbound', type: 'bool' },
          { name: 'pausedInbound', type: 'bool' },
        ],
      },
    },
    {
      name: 'SetGroupChainPolicyParams',
      type: {
        kind: 'struct',
        fields: [
          { name: 'remoteChainSelector', type: 'u64' },
          {
            name: 'section',
            docs: [
              'Written to the chain record, which stops following the default for that class.',
            ],
            type: { defined: 'PolicySection' },
          },
        ],
      },
    },
    {
      name: 'SetGroupDefaultParams',
      type: { kind: 'struct', fields: [{ name: 'section', type: { defined: 'PolicySection' } }] },
    },
    {
      name: 'SetGroupPauseParams',
      type: { kind: 'struct', fields: [{ name: 'paused', type: 'bool' }] },
    },
    {
      name: 'SetGroupRolesParams',
      type: { kind: 'struct', fields: [{ name: 'roles', type: { defined: 'GroupRoles' } }] },
    },
    {
      name: 'SetGroupSettingsParams',
      type: {
        kind: 'struct',
        fields: [
          {
            name: 'maxBpsFee',
            docs: [
              "Can only be lowered, and not below a BPS fee any of the group's records charges. Lowering it",
              'takes every chain record (writable): each mirrors the cap, which the transfer path enforces',
              'on named FEE policies too.',
            ],
            type: 'u16',
          },
          { name: 'openMembership', type: 'bool' },
          {
            name: 'minCcvActivationDelay',
            docs: [
              "Minimum notice, in seconds, for a scheduled CCV change (the owner's emergency activation",
              'is not bound by it). `None` leaves it, and any pending decrease, as they are.',
            ],
            type: { option: 'u64' },
          },
          {
            name: 'hookLookupTable',
            docs: [
              "The group's hook lookup table (`Group.hook_lookup_table`); `None` leaves it,",
              '`Some(Pubkey::default())` clears it. Any other table must be an active address lookup table,',
              'passed as the last remaining account (review 2e fixes R2); a frozen one (no authority) cannot',
              'be closed under the group.',
            ],
            type: { option: 'publicKey' },
          },
        ],
      },
    },
    {
      name: 'SetHookConfigParams',
      type: {
        kind: 'struct',
        fields: [
          { name: 'remoteChainSelector', type: { option: 'u64' } },
          { name: 'policyId', type: { option: 'u32' } },
          {
            name: 'allowlist',
            docs: ['An enabled allowlist of this group (passed as `allowlist`), or none.'],
            type: { option: 'publicKey' },
          },
          {
            name: 'blocklist',
            docs: ['Any blocklist (passed as `blocklist`), or none.'],
            type: { option: 'publicKey' },
          },
        ],
      },
    },
    {
      name: 'SetLanePauseParams',
      type: {
        kind: 'struct',
        fields: [
          { name: 'mint', type: 'publicKey' },
          { name: 'pausedOutbound', type: 'bool' },
          { name: 'pausedInbound', type: 'bool' },
        ],
      },
    },
    {
      name: 'SetLanePoolDataParams',
      type: {
        kind: 'struct',
        fields: [
          { name: 'mint', type: 'publicKey' },
          { name: 'remoteChainSelector', type: 'u64' },
          {
            name: 'poolDataFormat',
            docs: [
              'The pool data the lane sends while its CONNECTION class is inline: `Legacy32` toward',
              'standard pools, `Long` toward EVM MultiTokenPools.',
            ],
            type: { defined: 'PoolDataFormat' },
          },
          {
            name: 'uid',
            docs: [
              'Factory UID: sent as additional pool data with the long format, and required of inbound',
              'long pool data.',
            ],
            type: { option: { array: ['u8', 32] } },
          },
        ],
      },
    },
    {
      name: 'SetMemberRemoteTokensParams',
      type: {
        kind: 'struct',
        fields: [
          {
            name: 'rentReceiver',
            docs: ["`Some` replaces the members' rent receiver."],
            type: { option: 'publicKey' },
          },
          {
            name: 'members',
            docs: [
              "Replaces each member's remote tokens, in remaining-account order. Removing a chain is the",
              "token owner's opt-out of it: its lane can then be closed by anyone and is not re-created.",
            ],
            type: { vec: { defined: 'JoinGroupEntry' } },
          },
        ],
      },
    },
    {
      name: 'SetPolicyDefaultParams',
      type: {
        kind: 'struct',
        fields: [
          { name: 'policyId', type: 'u32' },
          { name: 'section', type: { defined: 'PolicySection' } },
        ],
      },
    },
    {
      name: 'SetPolicyEngineParams',
      type: {
        kind: 'struct',
        fields: [
          { name: 'remoteChainSelector', type: { option: 'u64' } },
          { name: 'policyId', type: { option: 'u32' } },
          { name: 'engine', type: { option: { defined: 'PolicyEngineConfig' } } },
          {
            name: 'skipDetach',
            docs: [
              'Do not call `detach` on the engine being replaced (Solana cannot catch a failed CPI, so this',
              "is EVM's `setPolicyEngineAllowFailedDetach` as an explicit, evented choice).",
            ],
            type: 'bool',
          },
          {
            name: 'recordCount',
            docs: [
              "The leading remaining accounts that are the target's security records. After them, in any",
              "order: the group's hook authority, and the program and static accounts of the new engine",
              '(if any) and of the replaced one (unless `skip_detach`).',
            ],
            type: 'u8',
          },
        ],
      },
    },
    {
      name: 'State',
      type: {
        kind: 'struct',
        fields: [
          { name: 'version', type: 'u8' },
          { name: 'config', type: { defined: 'BaseConfig' } },
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
      name: 'SyncGroupCcvsParams',
      type: { kind: 'struct', fields: [{ name: 'remoteChainSelector', type: 'u64' }] },
    },
    {
      name: 'SyncPolicyCcvsParams',
      type: {
        kind: 'struct',
        fields: [
          { name: 'policyId', type: 'u32' },
          { name: 'remoteChainSelector', type: 'u64' },
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
    {
      name: 'TransferGroupOwnershipParams',
      type: { kind: 'struct', fields: [{ name: 'proposedOwner', type: 'publicKey' }] },
    },
    {
      name: 'TransferListAdminParams',
      type: { kind: 'struct', fields: [{ name: 'proposedAdmin', type: 'publicKey' }] },
    },
    {
      name: 'UnlinkLanesParams',
      type: {
        kind: 'struct',
        fields: [
          { name: 'remoteChainSelector', type: 'u64' },
          {
            name: 'recordCount',
            docs: [
              'The leading remaining accounts that are named policy chain records (writable): every record',
              'the lanes of the batch reference. Their references are released first (review 2d S1).',
            ],
            type: 'u8',
          },
        ],
      },
    },
    {
      name: 'base_token_pool::v1::CcipAccountMeta',
      type: {
        kind: 'struct',
        fields: [
          { name: 'pubkey', type: 'publicKey' },
          { name: 'isSigner', type: 'bool' },
          { name: 'isWritable', type: 'bool' },
        ],
      },
    },
    {
      name: 'ccip_common::resolution::CcipAccountMeta',
      type: {
        kind: 'struct',
        fields: [
          { name: 'pubkey', type: 'publicKey' },
          { name: 'isSigner', type: 'bool' },
          { name: 'isWritable', type: 'bool' },
        ],
      },
    },
  ],
  errors: [
    { code: 6000, name: 'InvalidMultisig', msg: 'Invalid Multisig Mint' },
    { code: 6001, name: 'MintAuthorityAlreadySet', msg: 'Mint Authority already set' },
    { code: 6002, name: 'FixedMintToken', msg: 'Token with no Mint Authority' },
    { code: 6003, name: 'UnsupportedTokenProgram', msg: 'Unsupported Token Program' },
    {
      code: 6004,
      name: 'InvalidToken2022Multisig',
      msg: 'Invalid Multisig Account Data for Token 2022',
    },
    {
      code: 6005,
      name: 'InvalidSPLTokenMultisig',
      msg: 'Invalid Multisig Account Data for SPL Token',
    },
    {
      code: 6006,
      name: 'PoolSignerNotInMultisig',
      msg: 'Token Pool Signer PDA must be m times a signer of the Multisig',
    },
    {
      code: 6007,
      name: 'MultisigMustHaveAtLeastTwoSigners',
      msg: 'Multisig must have at least 2 valid signers',
    },
    {
      code: 6008,
      name: 'MultisigMustHaveMoreThanOneSigner',
      msg: 'Multisig must have more than one required signer',
    },
    { code: 6009, name: 'InvalidMultisigOwner', msg: 'Multisig Owner must match Token Program ID' },
    {
      code: 6010,
      name: 'InvalidMultisigThreshold',
      msg: 'Invalid multisig threshold: required signatures cannot exceed total signers',
    },
    {
      code: 6011,
      name: 'InvalidMultisigThresholdTooHigh',
      msg: 'Invalid multisig m: required signatures cannot exceed the available for outside signers',
    },
  ],
}
