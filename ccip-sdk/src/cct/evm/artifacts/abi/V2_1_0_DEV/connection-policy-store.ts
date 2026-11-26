/**
 * ConnectionPolicyStore: connection and remote-pool policies behind a PoolConfigManager.
 *
 * `ConnectionPolicyStore 2.1.0-dev`, pinned to chainlink-ccip `c950d9bc` (the commit docs-cct-foundry builds and
 * deploys; its release-settings build is byte-identical to these gobindings). Kept unexported from
 * the package: an exported ABI literal is inlined into the published `.d.ts`.
 */
// TODO: track a chainlink-ccip release tag and a `V2_1_0` folder once multi-token pools are released
export default [
  // generate:
  // fetch('https://github.com/smartcontractkit/chainlink-ccip/raw/c950d9bcab28ec9f6d52c4e38919c81a45deb8ca/chains/evm/gobindings/generated/latest/connection_policy_store/connection_policy_store.go')
  //   .then((res) => res.text())
  //   .then((body) => body.match(/^\s*ABI: "(.*?)",$/m)?.[1])
  //   .then((abi) => JSON.parse(abi.replace(/\\"/g, '"')))
  //   .then((obj) => require('util').inspect(obj, { depth: 99, maxArrayLength: Infinity }).split('\n').slice(1, -1))
  {
    type: 'constructor',
    inputs: [
      {
        name: 'authorizedCallers',
        type: 'address[]',
        internalType: 'address[]',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'acceptOwnership',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'applyAuthorizedCallerUpdates',
    inputs: [
      {
        name: 'authorizedCallerArgs',
        type: 'tuple',
        internalType: 'struct AuthorizedCallers.AuthorizedCallerArgs',
        components: [
          {
            name: 'addedCallers',
            type: 'address[]',
            internalType: 'address[]',
          },
          {
            name: 'removedCallers',
            type: 'address[]',
            internalType: 'address[]',
          },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'applyConnectionPolicyConfigUpdates',
    inputs: [
      {
        name: 'policyConfigsToRemove',
        type: 'tuple[]',
        internalType: 'struct PolicyConfig.PolicyRecordKey[]',
        components: [
          {
            name: 'policyName',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'remoteChainSelector',
            type: 'uint64',
            internalType: 'uint64',
          },
        ],
      },
      {
        name: 'policiesToRemove',
        type: 'bytes32[]',
        internalType: 'bytes32[]',
      },
      {
        name: 'policyConfigsToSet',
        type: 'tuple[]',
        internalType: 'struct ConnectionPolicyStore.ConnectionPolicyConfigArgs[]',
        components: [
          {
            name: 'policyName',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'remoteChainSelector',
            type: 'uint64',
            internalType: 'uint64',
          },
          {
            name: 'onlySubsetTokens',
            type: 'bool',
            internalType: 'bool',
          },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'applyInlineConnectionConfigUpdates',
    inputs: [
      {
        name: 'inlineConfigsToRemove',
        type: 'tuple[]',
        internalType: 'struct IPoolConfigManager.LaneKey[]',
        components: [
          {
            name: 'localToken',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'remoteChainSelector',
            type: 'uint64',
            internalType: 'uint64',
          },
        ],
      },
      {
        name: 'inlineConfigsToSet',
        type: 'tuple[]',
        internalType: 'struct ConnectionPolicyStore.InlineConnectionConfigArgs[]',
        components: [
          {
            name: 'localToken',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'remoteChainSelector',
            type: 'uint64',
            internalType: 'uint64',
          },
          { name: 'remoteToken', type: 'bytes', internalType: 'bytes' },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'applyInlineRemotePoolConfigUpdates',
    inputs: [
      {
        name: 'inlineConfigsToRemove',
        type: 'tuple[]',
        internalType: 'struct IPoolConfigManager.LaneKey[]',
        components: [
          {
            name: 'localToken',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'remoteChainSelector',
            type: 'uint64',
            internalType: 'uint64',
          },
        ],
      },
      {
        name: 'inlineConfigsToSet',
        type: 'tuple[]',
        internalType: 'struct ConnectionPolicyStore.InlineRemotePoolConfigArgs[]',
        components: [
          {
            name: 'localToken',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'remoteChainSelector',
            type: 'uint64',
            internalType: 'uint64',
          },
          {
            name: 'trustPolicyRemotePools',
            type: 'bool',
            internalType: 'bool',
          },
          {
            name: 'remotePoolConfig',
            type: 'tuple',
            internalType: 'struct ConnectionPolicyStore.RemotePoolConfig',
            components: [
              {
                name: 'useLegacyPoolDataOnSend',
                type: 'bool',
                internalType: 'bool',
              },
              {
                name: 'remotePools',
                type: 'tuple[]',
                internalType: 'struct IPoolConfigManager.RemotePool[]',
                components: [
                  {
                    name: 'remotePoolAddress',
                    type: 'bytes',
                    internalType: 'bytes',
                  },
                  {
                    name: 'allowLegacyPoolDataOnReceive',
                    type: 'bool',
                    internalType: 'bool',
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'applyRemotePoolPolicyConfigUpdates',
    inputs: [
      {
        name: 'policyConfigsToRemove',
        type: 'tuple[]',
        internalType: 'struct PolicyConfig.PolicyRecordKey[]',
        components: [
          {
            name: 'policyName',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'remoteChainSelector',
            type: 'uint64',
            internalType: 'uint64',
          },
        ],
      },
      {
        name: 'policiesToRemove',
        type: 'bytes32[]',
        internalType: 'bytes32[]',
      },
      {
        name: 'policyConfigsToSet',
        type: 'tuple[]',
        internalType: 'struct ConnectionPolicyStore.RemotePoolPolicyConfigArgs[]',
        components: [
          {
            name: 'policyName',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'remoteChainSelector',
            type: 'uint64',
            internalType: 'uint64',
          },
          {
            name: 'remotePoolAddresses',
            type: 'bytes[]',
            internalType: 'bytes[]',
          },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'applyRemoteTokenAddressProviderUpdates',
    inputs: [
      {
        name: 'providersToSet',
        type: 'tuple[]',
        internalType: 'struct ConnectionPolicyStore.RemoteTokenAddressProviderArgs[]',
        components: [
          {
            name: 'policyName',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'remoteTokenAddressProvider',
            type: 'address',
            internalType: 'address',
          },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'applySubsetTokenUpdates',
    inputs: [
      {
        name: 'tokensToRemove',
        type: 'tuple[]',
        internalType: 'struct ConnectionPolicyStore.SubsetTokenArgs[]',
        components: [
          {
            name: 'policyName',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'remoteChainSelector',
            type: 'uint64',
            internalType: 'uint64',
          },
          {
            name: 'localToken',
            type: 'address',
            internalType: 'address',
          },
        ],
      },
      {
        name: 'tokensToAdd',
        type: 'tuple[]',
        internalType: 'struct ConnectionPolicyStore.SubsetTokenArgs[]',
        components: [
          {
            name: 'policyName',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'remoteChainSelector',
            type: 'uint64',
            internalType: 'uint64',
          },
          {
            name: 'localToken',
            type: 'address',
            internalType: 'address',
          },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'applyTokenConnectionPolicyUpdates',
    inputs: [
      {
        name: 'tokenPoliciesToSet',
        type: 'tuple[]',
        internalType: 'struct PolicyConfig.TokenPolicyArgs[]',
        components: [
          {
            name: 'localToken',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'policyName',
            type: 'bytes32',
            internalType: 'bytes32',
          },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'applyTokenProfileUpdates',
    inputs: [
      {
        name: 'tokensToRemove',
        type: 'address[]',
        internalType: 'address[]',
      },
      {
        name: 'profilesToSet',
        type: 'tuple[]',
        internalType: 'struct PolicyConfig.TokenProfileArgs[]',
        components: [
          {
            name: 'localToken',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'localDecimals',
            type: 'uint8',
            internalType: 'uint8',
          },
          {
            name: 'lockOrBurnFlavor',
            type: 'uint8',
            internalType: 'enum IPoolConfigManager.LockOrBurnFlavor',
          },
          {
            name: 'allowedFinalityConfig',
            type: 'bytes4',
            internalType: 'bytes4',
          },
          {
            name: 'lockOrBurnAddress',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'additionalPoolDataProvider',
            type: 'address',
            internalType: 'address',
          },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'applyTokenRemotePoolPolicyUpdates',
    inputs: [
      {
        name: 'tokenPoliciesToSet',
        type: 'tuple[]',
        internalType: 'struct PolicyConfig.TokenPolicyArgs[]',
        components: [
          {
            name: 'localToken',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'policyName',
            type: 'bytes32',
            internalType: 'bytes32',
          },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'checkLaneRecords',
    inputs: [
      { name: 'localToken', type: 'address', internalType: 'address' },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        internalType: 'uint64',
      },
    ],
    outputs: [],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'checkRequestedFinalityBatch',
    inputs: [
      {
        name: 'lanes',
        type: 'tuple[]',
        internalType: 'struct IPoolConfigManager.LaneKey[]',
        components: [
          {
            name: 'localToken',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'remoteChainSelector',
            type: 'uint64',
            internalType: 'uint64',
          },
        ],
      },
      {
        name: 'requestedFinalityConfig',
        type: 'bytes4',
        internalType: 'bytes4',
      },
    ],
    outputs: [],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getAllAuthorizedCallers',
    inputs: [],
    outputs: [{ name: '', type: 'address[]', internalType: 'address[]' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getAllConfiguredTokens',
    inputs: [
      { name: 'startIndex', type: 'uint64', internalType: 'uint64' },
      { name: 'maxCount', type: 'uint64', internalType: 'uint64' },
    ],
    outputs: [{ name: 'tokens', type: 'address[]', internalType: 'address[]' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getConnectionPolicy',
    inputs: [{ name: 'policyName', type: 'bytes32', internalType: 'bytes32' }],
    outputs: [
      { name: 'tokenCount', type: 'uint32', internalType: 'uint32' },
      {
        name: 'remoteTokenAddressProvider',
        type: 'address',
        internalType: 'address',
      },
      {
        name: 'policyConfigs',
        type: 'tuple[]',
        internalType: 'struct ConnectionPolicyStore.ConnectionPolicyConfigArgs[]',
        components: [
          {
            name: 'policyName',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'remoteChainSelector',
            type: 'uint64',
            internalType: 'uint64',
          },
          {
            name: 'onlySubsetTokens',
            type: 'bool',
            internalType: 'bool',
          },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getInlineConnectionConfigs',
    inputs: [{ name: 'localToken', type: 'address', internalType: 'address' }],
    outputs: [
      {
        name: 'inlineConfigs',
        type: 'tuple[]',
        internalType: 'struct ConnectionPolicyStore.InlineConnectionConfigArgs[]',
        components: [
          {
            name: 'localToken',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'remoteChainSelector',
            type: 'uint64',
            internalType: 'uint64',
          },
          { name: 'remoteToken', type: 'bytes', internalType: 'bytes' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getInlineRemotePoolConfigs',
    inputs: [{ name: 'localToken', type: 'address', internalType: 'address' }],
    outputs: [
      {
        name: 'inlineConfigs',
        type: 'tuple[]',
        internalType: 'struct ConnectionPolicyStore.InlineRemotePoolConfigArgs[]',
        components: [
          {
            name: 'localToken',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'remoteChainSelector',
            type: 'uint64',
            internalType: 'uint64',
          },
          {
            name: 'trustPolicyRemotePools',
            type: 'bool',
            internalType: 'bool',
          },
          {
            name: 'remotePoolConfig',
            type: 'tuple',
            internalType: 'struct ConnectionPolicyStore.RemotePoolConfig',
            components: [
              {
                name: 'useLegacyPoolDataOnSend',
                type: 'bool',
                internalType: 'bool',
              },
              {
                name: 'remotePools',
                type: 'tuple[]',
                internalType: 'struct IPoolConfigManager.RemotePool[]',
                components: [
                  {
                    name: 'remotePoolAddress',
                    type: 'bytes',
                    internalType: 'bytes',
                  },
                  {
                    name: 'allowLegacyPoolDataOnReceive',
                    type: 'bool',
                    internalType: 'bool',
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getLaneConnectionBatch',
    inputs: [
      {
        name: 'lanes',
        type: 'tuple[]',
        internalType: 'struct IPoolConfigManager.LaneKey[]',
        components: [
          {
            name: 'localToken',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'remoteChainSelector',
            type: 'uint64',
            internalType: 'uint64',
          },
        ],
      },
    ],
    outputs: [
      {
        name: 'connections',
        type: 'tuple[]',
        internalType: 'struct IPoolConfigManager.LaneConnection[]',
        components: [
          { name: 'hasConnection', type: 'bool', internalType: 'bool' },
          {
            name: 'isOutboundPaused',
            type: 'bool',
            internalType: 'bool',
          },
          {
            name: 'isInboundPaused',
            type: 'bool',
            internalType: 'bool',
          },
          {
            name: 'isGloballyPaused',
            type: 'bool',
            internalType: 'bool',
          },
          {
            name: 'isTokenOutboundPaused',
            type: 'bool',
            internalType: 'bool',
          },
          {
            name: 'isTokenInboundPaused',
            type: 'bool',
            internalType: 'bool',
          },
          {
            name: 'isChainOutboundPaused',
            type: 'bool',
            internalType: 'bool',
          },
          {
            name: 'isChainInboundPaused',
            type: 'bool',
            internalType: 'bool',
          },
          {
            name: 'useLegacyPoolDataOnSend',
            type: 'bool',
            internalType: 'bool',
          },
          { name: 'remoteToken', type: 'bytes', internalType: 'bytes' },
          {
            name: 'remotePools',
            type: 'tuple[]',
            internalType: 'struct IPoolConfigManager.RemotePool[]',
            components: [
              {
                name: 'remotePoolAddress',
                type: 'bytes',
                internalType: 'bytes',
              },
              {
                name: 'allowLegacyPoolDataOnReceive',
                type: 'bool',
                internalType: 'bool',
              },
            ],
          },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getLaneRecordLevelBatch',
    inputs: [
      {
        name: 'lanes',
        type: 'tuple[]',
        internalType: 'struct IPoolConfigManager.LaneKey[]',
        components: [
          {
            name: 'localToken',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'remoteChainSelector',
            type: 'uint64',
            internalType: 'uint64',
          },
        ],
      },
    ],
    outputs: [
      {
        name: 'connectionLevels',
        type: 'uint8[]',
        internalType: 'enum PolicyConfig.RecordLevel[]',
      },
      {
        name: 'remotePoolLevels',
        type: 'uint8[]',
        internalType: 'enum PolicyConfig.RecordLevel[]',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getPolicyNames',
    inputs: [],
    outputs: [
      {
        name: 'connectionPolicyNames',
        type: 'bytes32[]',
        internalType: 'bytes32[]',
      },
      {
        name: 'remotePoolPolicyNames',
        type: 'bytes32[]',
        internalType: 'bytes32[]',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getRemotePoolPolicy',
    inputs: [{ name: 'policyName', type: 'bytes32', internalType: 'bytes32' }],
    outputs: [
      { name: 'tokenCount', type: 'uint32', internalType: 'uint32' },
      {
        name: 'policyConfigs',
        type: 'tuple[]',
        internalType: 'struct ConnectionPolicyStore.RemotePoolPolicyConfigArgs[]',
        components: [
          {
            name: 'policyName',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'remoteChainSelector',
            type: 'uint64',
            internalType: 'uint64',
          },
          {
            name: 'remotePoolAddresses',
            type: 'bytes[]',
            internalType: 'bytes[]',
          },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getSubsetTokens',
    inputs: [
      { name: 'policyName', type: 'bytes32', internalType: 'bytes32' },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        internalType: 'uint64',
      },
      { name: 'startIndex', type: 'uint64', internalType: 'uint64' },
      { name: 'maxCount', type: 'uint64', internalType: 'uint64' },
    ],
    outputs: [
      { name: 'onlySubsetTokens', type: 'bool', internalType: 'bool' },
      {
        name: 'subsetTokens',
        type: 'address[]',
        internalType: 'address[]',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getTokenConfigBatch',
    inputs: [
      {
        name: 'localTokens',
        type: 'address[]',
        internalType: 'address[]',
      },
    ],
    outputs: [
      {
        name: 'configs',
        type: 'tuple[]',
        internalType: 'struct IPoolConfigManager.TokenConfig[]',
        components: [
          { name: 'isRegistered', type: 'bool', internalType: 'bool' },
          {
            name: 'localDecimals',
            type: 'uint8',
            internalType: 'uint8',
          },
          {
            name: 'lockOrBurnFlavor',
            type: 'uint8',
            internalType: 'enum IPoolConfigManager.LockOrBurnFlavor',
          },
          {
            name: 'allowedFinalityConfig',
            type: 'bytes4',
            internalType: 'bytes4',
          },
          {
            name: 'lockOrBurnAddress',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'additionalPoolDataProvider',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'supportedChains',
            type: 'uint64[]',
            internalType: 'uint64[]',
          },
          {
            name: 'connectionPolicyName',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'remotePoolPolicyName',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'rateLimitPolicyName',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'feePolicyName',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'destOverheadPolicyName',
            type: 'bytes32',
            internalType: 'bytes32',
          },
          {
            name: 'securityPolicyName',
            type: 'bytes32',
            internalType: 'bytes32',
          },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getTokenPolicies',
    inputs: [{ name: 'localToken', type: 'address', internalType: 'address' }],
    outputs: [
      { name: 'isRegistered', type: 'bool', internalType: 'bool' },
      {
        name: 'connectionPolicyName',
        type: 'bytes32',
        internalType: 'bytes32',
      },
      {
        name: 'remotePoolPolicyName',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getTokenProfiles',
    inputs: [
      {
        name: 'localTokens',
        type: 'address[]',
        internalType: 'address[]',
      },
    ],
    outputs: [
      {
        name: 'profiles',
        type: 'tuple[]',
        internalType: 'struct ConnectionPolicyStore.TokenProfile[]',
        components: [
          { name: 'isRegistered', type: 'bool', internalType: 'bool' },
          {
            name: 'localDecimals',
            type: 'uint8',
            internalType: 'uint8',
          },
          {
            name: 'lockOrBurnFlavor',
            type: 'uint8',
            internalType: 'enum IPoolConfigManager.LockOrBurnFlavor',
          },
          {
            name: 'lockOrBurnAddress',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'allowedFinalityConfig',
            type: 'bytes4',
            internalType: 'bytes4',
          },
          {
            name: 'isOutboundPaused',
            type: 'bool',
            internalType: 'bool',
          },
          {
            name: 'isInboundPaused',
            type: 'bool',
            internalType: 'bool',
          },
          {
            name: 'additionalPoolDataProvider',
            type: 'address',
            internalType: 'address',
          },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'hasLaneBatch',
    inputs: [
      {
        name: 'lanes',
        type: 'tuple[]',
        internalType: 'struct IPoolConfigManager.LaneKey[]',
        components: [
          {
            name: 'localToken',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'remoteChainSelector',
            type: 'uint64',
            internalType: 'uint64',
          },
        ],
      },
    ],
    outputs: [{ name: 'hasLanes', type: 'bool[]', internalType: 'bool[]' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'owner',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'resolveInboundLane',
    inputs: [
      { name: 'localToken', type: 'address', internalType: 'address' },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        internalType: 'uint64',
      },
      {
        name: 'sourcePoolAddress',
        type: 'bytes',
        internalType: 'bytes',
      },
      { name: 'sourcePoolData', type: 'bytes', internalType: 'bytes' },
      {
        name: 'sourceDenominatedAmount',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'requestedFinalityConfig',
        type: 'bytes4',
        internalType: 'bytes4',
      },
    ],
    outputs: [
      {
        name: 'transfer',
        type: 'tuple',
        internalType: 'struct IPoolConfigManager.ResolvedInboundTransfer',
        components: [
          {
            name: 'localAmount',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'lockOrBurnFlavor',
            type: 'uint8',
            internalType: 'enum IPoolConfigManager.LockOrBurnFlavor',
          },
          {
            name: 'lockOrBurnAddress',
            type: 'address',
            internalType: 'address',
          },
          { name: 'hook', type: 'address', internalType: 'address' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'resolveOutboundLane',
    inputs: [
      { name: 'localToken', type: 'address', internalType: 'address' },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        internalType: 'uint64',
      },
      {
        name: 'requestedFinalityConfig',
        type: 'bytes4',
        internalType: 'bytes4',
      },
      { name: 'tokenArgs', type: 'bytes', internalType: 'bytes' },
    ],
    outputs: [
      {
        name: 'lane',
        type: 'tuple',
        internalType: 'struct IPoolConfigManager.OutboundLane',
        components: [
          { name: 'remoteToken', type: 'bytes', internalType: 'bytes' },
          {
            name: 'destPoolData',
            type: 'bytes',
            internalType: 'bytes',
          },
          {
            name: 'localDecimals',
            type: 'uint8',
            internalType: 'uint8',
          },
          {
            name: 'lockOrBurnFlavor',
            type: 'uint8',
            internalType: 'enum IPoolConfigManager.LockOrBurnFlavor',
          },
          {
            name: 'lockOrBurnAddress',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'feeAmount',
            type: 'uint256',
            internalType: 'uint256',
          },
          { name: 'hook', type: 'address', internalType: 'address' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'setChainPause',
    inputs: [
      {
        name: 'remoteChainSelectors',
        type: 'uint64[]',
        internalType: 'uint64[]',
      },
      {
        name: 'direction',
        type: 'uint8',
        internalType: 'enum ConnectionPolicyStore.PauseDirection',
      },
      { name: 'isPaused', type: 'bool', internalType: 'bool' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'setGlobalPause',
    inputs: [{ name: 'isPaused', type: 'bool', internalType: 'bool' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'setTokenPause',
    inputs: [
      {
        name: 'localTokens',
        type: 'address[]',
        internalType: 'address[]',
      },
      {
        name: 'direction',
        type: 'uint8',
        internalType: 'enum ConnectionPolicyStore.PauseDirection',
      },
      { name: 'isPaused', type: 'bool', internalType: 'bool' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'transferOwnership',
    inputs: [{ name: 'to', type: 'address', internalType: 'address' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'typeAndVersion',
    inputs: [],
    outputs: [{ name: '', type: 'string', internalType: 'string' }],
    stateMutability: 'pure',
  },
  {
    type: 'event',
    name: 'AuthorizedCallerAdded',
    inputs: [
      {
        name: 'caller',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'AuthorizedCallerRemoved',
    inputs: [
      {
        name: 'caller',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'ChainPauseSet',
    inputs: [
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        indexed: true,
        internalType: 'uint64',
      },
      {
        name: 'isOutboundPaused',
        type: 'bool',
        indexed: false,
        internalType: 'bool',
      },
      {
        name: 'isInboundPaused',
        type: 'bool',
        indexed: false,
        internalType: 'bool',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'ConnectionPolicyConfigRemoved',
    inputs: [
      {
        name: 'policyName',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        indexed: true,
        internalType: 'uint64',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'ConnectionPolicyConfigSet',
    inputs: [
      {
        name: 'policyName',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        indexed: true,
        internalType: 'uint64',
      },
      {
        name: 'onlySubsetTokens',
        type: 'bool',
        indexed: false,
        internalType: 'bool',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'ConnectionPolicyRemoved',
    inputs: [
      {
        name: 'policyName',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'GlobalPauseSet',
    inputs: [
      {
        name: 'isPaused',
        type: 'bool',
        indexed: false,
        internalType: 'bool',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'InlineConnectionConfigRemoved',
    inputs: [
      {
        name: 'localToken',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        indexed: true,
        internalType: 'uint64',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'InlineConnectionConfigSet',
    inputs: [
      {
        name: 'localToken',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        indexed: true,
        internalType: 'uint64',
      },
      {
        name: 'remoteToken',
        type: 'bytes',
        indexed: false,
        internalType: 'bytes',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'InlineRemotePoolConfigRemoved',
    inputs: [
      {
        name: 'localToken',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        indexed: true,
        internalType: 'uint64',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'InlineRemotePoolConfigSet',
    inputs: [
      {
        name: 'localToken',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        indexed: true,
        internalType: 'uint64',
      },
      {
        name: 'trustPolicyRemotePools',
        type: 'bool',
        indexed: false,
        internalType: 'bool',
      },
      {
        name: 'remotePoolConfig',
        type: 'tuple',
        indexed: false,
        internalType: 'struct ConnectionPolicyStore.RemotePoolConfig',
        components: [
          {
            name: 'useLegacyPoolDataOnSend',
            type: 'bool',
            internalType: 'bool',
          },
          {
            name: 'remotePools',
            type: 'tuple[]',
            internalType: 'struct IPoolConfigManager.RemotePool[]',
            components: [
              {
                name: 'remotePoolAddress',
                type: 'bytes',
                internalType: 'bytes',
              },
              {
                name: 'allowLegacyPoolDataOnReceive',
                type: 'bool',
                internalType: 'bool',
              },
            ],
          },
        ],
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'OwnershipTransferRequested',
    inputs: [
      {
        name: 'from',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'to',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'OwnershipTransferred',
    inputs: [
      {
        name: 'from',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'to',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'RemotePoolPolicyConfigRemoved',
    inputs: [
      {
        name: 'policyName',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        indexed: true,
        internalType: 'uint64',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'RemotePoolPolicyConfigSet',
    inputs: [
      {
        name: 'policyName',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        indexed: true,
        internalType: 'uint64',
      },
      {
        name: 'remotePoolAddresses',
        type: 'bytes[]',
        indexed: false,
        internalType: 'bytes[]',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'RemotePoolPolicyRemoved',
    inputs: [
      {
        name: 'policyName',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'RemoteTokenAddressProviderSet',
    inputs: [
      {
        name: 'policyName',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'remoteTokenAddressProvider',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'SubsetTokenAdded',
    inputs: [
      {
        name: 'policyName',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        indexed: true,
        internalType: 'uint64',
      },
      {
        name: 'localToken',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'SubsetTokenRemoved',
    inputs: [
      {
        name: 'policyName',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        indexed: true,
        internalType: 'uint64',
      },
      {
        name: 'localToken',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'TokenConnectionPolicySet',
    inputs: [
      {
        name: 'localToken',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'oldPolicyName',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'newPolicyName',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'TokenPauseSet',
    inputs: [
      {
        name: 'localToken',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'isOutboundPaused',
        type: 'bool',
        indexed: false,
        internalType: 'bool',
      },
      {
        name: 'isInboundPaused',
        type: 'bool',
        indexed: false,
        internalType: 'bool',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'TokenProfileSet',
    inputs: [
      {
        name: 'localToken',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'localDecimals',
        type: 'uint8',
        indexed: false,
        internalType: 'uint8',
      },
      {
        name: 'lockOrBurnFlavor',
        type: 'uint8',
        indexed: false,
        internalType: 'enum IPoolConfigManager.LockOrBurnFlavor',
      },
      {
        name: 'lockOrBurnAddress',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'allowedFinalityConfig',
        type: 'bytes4',
        indexed: false,
        internalType: 'bytes4',
      },
      {
        name: 'additionalPoolDataProvider',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'TokenRemotePoolPolicySet',
    inputs: [
      {
        name: 'localToken',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'oldPolicyName',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'newPolicyName',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'TokenRemoved',
    inputs: [
      {
        name: 'localToken',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  { type: 'error', name: 'CannotTransferToSelf', inputs: [] },
  {
    type: 'error',
    name: 'ChainIsPaused',
    inputs: [
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        internalType: 'uint64',
      },
      {
        name: 'direction',
        type: 'uint8',
        internalType: 'enum ConnectionPolicyStore.PauseDirection',
      },
    ],
  },
  {
    type: 'error',
    name: 'ConnectionRecordNotFound',
    inputs: [
      { name: 'localToken', type: 'address', internalType: 'address' },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        internalType: 'uint64',
      },
    ],
  },
  { type: 'error', name: 'GloballyPaused', inputs: [] },
  {
    type: 'error',
    name: 'InlineRecordNotFound',
    inputs: [
      { name: 'localToken', type: 'address', internalType: 'address' },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        internalType: 'uint64',
      },
    ],
  },
  {
    type: 'error',
    name: 'InvalidAdditionalPoolData',
    inputs: [
      { name: 'localToken', type: 'address', internalType: 'address' },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        internalType: 'uint64',
      },
      {
        name: 'additionalPoolData',
        type: 'bytes',
        internalType: 'bytes',
      },
    ],
  },
  {
    type: 'error',
    name: 'InvalidDecimalArgs',
    inputs: [
      { name: 'localToken', type: 'address', internalType: 'address' },
      { name: 'expected', type: 'uint8', internalType: 'uint8' },
      { name: 'actual', type: 'uint8', internalType: 'uint8' },
    ],
  },
  {
    type: 'error',
    name: 'InvalidLockOrBurnAddress',
    inputs: [
      { name: 'localToken', type: 'address', internalType: 'address' },
      {
        name: 'lockOrBurnFlavor',
        type: 'uint8',
        internalType: 'enum IPoolConfigManager.LockOrBurnFlavor',
      },
      {
        name: 'lockOrBurnAddress',
        type: 'address',
        internalType: 'address',
      },
    ],
  },
  {
    type: 'error',
    name: 'InvalidRemoteToken',
    inputs: [
      { name: 'localToken', type: 'address', internalType: 'address' },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        internalType: 'uint64',
      },
    ],
  },
  {
    type: 'error',
    name: 'InvalidRequestedFinality',
    inputs: [
      {
        name: 'requestedFinality',
        type: 'bytes4',
        internalType: 'bytes4',
      },
      {
        name: 'allowedFinality',
        type: 'bytes4',
        internalType: 'bytes4',
      },
    ],
  },
  {
    type: 'error',
    name: 'InvalidSourcePoolAddress',
    inputs: [
      { name: 'localToken', type: 'address', internalType: 'address' },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        internalType: 'uint64',
      },
      {
        name: 'sourcePoolAddress',
        type: 'bytes',
        internalType: 'bytes',
      },
    ],
  },
  {
    type: 'error',
    name: 'InvalidSourcePoolData',
    inputs: [{ name: 'sourcePoolData', type: 'bytes', internalType: 'bytes' }],
  },
  {
    type: 'error',
    name: 'LegacyPoolDataNotAllowed',
    inputs: [
      { name: 'localToken', type: 'address', internalType: 'address' },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        internalType: 'uint64',
      },
    ],
  },
  {
    type: 'error',
    name: 'LegacyRemotePoolRecord',
    inputs: [
      { name: 'localToken', type: 'address', internalType: 'address' },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        internalType: 'uint64',
      },
    ],
  },
  {
    type: 'error',
    name: 'LocalTokenNotRegistered',
    inputs: [{ name: 'localToken', type: 'address', internalType: 'address' }],
  },
  { type: 'error', name: 'MustBeProposedOwner', inputs: [] },
  { type: 'error', name: 'OnlyCallableByOwner', inputs: [] },
  {
    type: 'error',
    name: 'OverflowDetected',
    inputs: [
      { name: 'remoteDecimals', type: 'uint8', internalType: 'uint8' },
      { name: 'localDecimals', type: 'uint8', internalType: 'uint8' },
      {
        name: 'remoteAmount',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
  },
  { type: 'error', name: 'OwnerCannotBeZero', inputs: [] },
  {
    type: 'error',
    name: 'PolicyHasNoTokens',
    inputs: [{ name: 'policyName', type: 'bytes32', internalType: 'bytes32' }],
  },
  {
    type: 'error',
    name: 'PolicyHasRecords',
    inputs: [{ name: 'policyName', type: 'bytes32', internalType: 'bytes32' }],
  },
  {
    type: 'error',
    name: 'PolicyInUse',
    inputs: [{ name: 'policyName', type: 'bytes32', internalType: 'bytes32' }],
  },
  {
    type: 'error',
    name: 'PolicyNotFound',
    inputs: [{ name: 'policyName', type: 'bytes32', internalType: 'bytes32' }],
  },
  {
    type: 'error',
    name: 'PolicyRecordHasNoPools',
    inputs: [
      { name: 'policyName', type: 'bytes32', internalType: 'bytes32' },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        internalType: 'uint64',
      },
    ],
  },
  {
    type: 'error',
    name: 'PolicyRecordNotFound',
    inputs: [
      { name: 'policyName', type: 'bytes32', internalType: 'bytes32' },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        internalType: 'uint64',
      },
    ],
  },
  {
    type: 'error',
    name: 'PolicyRemoteTokenMismatch',
    inputs: [
      { name: 'localToken', type: 'address', internalType: 'address' },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        internalType: 'uint64',
      },
    ],
  },
  {
    type: 'error',
    name: 'ProviderHasNoCode',
    inputs: [{ name: 'provider', type: 'address', internalType: 'address' }],
  },
  {
    type: 'error',
    name: 'RemotePoolAlreadyAdded',
    inputs: [
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        internalType: 'uint64',
      },
      {
        name: 'remotePoolAddress',
        type: 'bytes',
        internalType: 'bytes',
      },
    ],
  },
  {
    type: 'error',
    name: 'RemotePoolRecordNotFound',
    inputs: [
      { name: 'localToken', type: 'address', internalType: 'address' },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        internalType: 'uint64',
      },
    ],
  },
  {
    type: 'error',
    name: 'RequestedFinalityCanOnlyHaveOneMode',
    inputs: [
      {
        name: 'encodedFinality',
        type: 'bytes4',
        internalType: 'bytes4',
      },
    ],
  },
  {
    type: 'error',
    name: 'SourceTokenMismatch',
    inputs: [
      { name: 'localToken', type: 'address', internalType: 'address' },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        internalType: 'uint64',
      },
      {
        name: 'expectedSourceToken',
        type: 'bytes',
        internalType: 'bytes',
      },
      {
        name: 'actualSourceToken',
        type: 'bytes',
        internalType: 'bytes',
      },
    ],
  },
  {
    type: 'error',
    name: 'SubsetTokenAlreadyAdded',
    inputs: [
      { name: 'policyName', type: 'bytes32', internalType: 'bytes32' },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        internalType: 'uint64',
      },
      { name: 'localToken', type: 'address', internalType: 'address' },
    ],
  },
  {
    type: 'error',
    name: 'SubsetTokenNotFound',
    inputs: [
      { name: 'policyName', type: 'bytes32', internalType: 'bytes32' },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        internalType: 'uint64',
      },
      { name: 'localToken', type: 'address', internalType: 'address' },
    ],
  },
  {
    type: 'error',
    name: 'TokenHasConfig',
    inputs: [{ name: 'localToken', type: 'address', internalType: 'address' }],
  },
  {
    type: 'error',
    name: 'TokenIsPaused',
    inputs: [
      { name: 'localToken', type: 'address', internalType: 'address' },
      {
        name: 'direction',
        type: 'uint8',
        internalType: 'enum ConnectionPolicyStore.PauseDirection',
      },
    ],
  },
  {
    type: 'error',
    name: 'TokenNotInPolicy',
    inputs: [
      { name: 'localToken', type: 'address', internalType: 'address' },
      { name: 'policyName', type: 'bytes32', internalType: 'bytes32' },
    ],
  },
  {
    type: 'error',
    name: 'UnauthorizedCaller',
    inputs: [{ name: 'caller', type: 'address', internalType: 'address' }],
  },
  { type: 'error', name: 'ZeroAddressInvalid', inputs: [] },
  { type: 'error', name: 'ZeroAddressNotAllowed', inputs: [] },
  { type: 'error', name: 'ZeroChainSelectorNotAllowed', inputs: [] },
  { type: 'error', name: 'ZeroPolicyNameNotAllowed', inputs: [] },
  // generate:end
] as const
