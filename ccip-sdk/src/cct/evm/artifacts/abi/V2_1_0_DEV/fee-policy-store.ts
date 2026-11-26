/**
 * FeePolicyStore: fee and destination-overhead policies behind a PoolConfigManager.
 *
 * `FeePolicyStore 2.1.0-dev`, pinned to chainlink-ccip `c950d9bc` (the commit docs-cct-foundry builds and
 * deploys; its release-settings build is byte-identical to these gobindings). Kept unexported from
 * the package: an exported ABI literal is inlined into the published `.d.ts`.
 */
// TODO: track a chainlink-ccip release tag and a `V2_1_0` folder once multi-token pools are released
export default [
  // generate:
  // fetch('https://github.com/smartcontractkit/chainlink-ccip/raw/c950d9bcab28ec9f6d52c4e38919c81a45deb8ca/chains/evm/gobindings/generated/latest/fee_policy_store/fee_policy_store.go')
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
    name: 'applyDestOverheadPolicyConfigUpdates',
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
        internalType: 'struct FeePolicyStore.DestOverheadPolicyConfigArgs[]',
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
            name: 'destOverheadConfig',
            type: 'tuple',
            internalType: 'struct FeePolicyStore.DestOverheadConfig',
            components: [
              {
                name: 'destGasOverhead',
                type: 'uint32',
                internalType: 'uint32',
              },
              {
                name: 'destBytesOverhead',
                type: 'uint32',
                internalType: 'uint32',
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
    name: 'applyFeePolicyConfigUpdates',
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
        internalType: 'struct FeePolicyStore.FeePolicyConfigArgs[]',
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
            name: 'feeConfig',
            type: 'tuple',
            internalType: 'struct FeePolicyStore.FeeConfig',
            components: [
              {
                name: 'finalityFeeUSDCents',
                type: 'uint32',
                internalType: 'uint32',
              },
              {
                name: 'fastFinalityFeeUSDCents',
                type: 'uint32',
                internalType: 'uint32',
              },
              {
                name: 'finalityTransferFeeBps',
                type: 'uint16',
                internalType: 'uint16',
              },
              {
                name: 'fastFinalityTransferFeeBps',
                type: 'uint16',
                internalType: 'uint16',
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
    name: 'applyInlineDestOverheadConfigUpdates',
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
        internalType: 'struct FeePolicyStore.InlineDestOverheadConfigArgs[]',
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
            name: 'destOverheadConfig',
            type: 'tuple',
            internalType: 'struct FeePolicyStore.DestOverheadConfig',
            components: [
              {
                name: 'destGasOverhead',
                type: 'uint32',
                internalType: 'uint32',
              },
              {
                name: 'destBytesOverhead',
                type: 'uint32',
                internalType: 'uint32',
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
    name: 'applyInlineFeeConfigUpdates',
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
        internalType: 'struct FeePolicyStore.InlineFeeConfigArgs[]',
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
            name: 'feeConfig',
            type: 'tuple',
            internalType: 'struct FeePolicyStore.FeeConfig',
            components: [
              {
                name: 'finalityFeeUSDCents',
                type: 'uint32',
                internalType: 'uint32',
              },
              {
                name: 'fastFinalityFeeUSDCents',
                type: 'uint32',
                internalType: 'uint32',
              },
              {
                name: 'finalityTransferFeeBps',
                type: 'uint16',
                internalType: 'uint16',
              },
              {
                name: 'fastFinalityTransferFeeBps',
                type: 'uint16',
                internalType: 'uint16',
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
    name: 'applyTokenDestOverheadPolicyUpdates',
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
    name: 'applyTokenFeePolicyUpdates',
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
    name: 'getAllAuthorizedCallers',
    inputs: [],
    outputs: [{ name: '', type: 'address[]', internalType: 'address[]' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getDestOverheadPolicy',
    inputs: [{ name: 'policyName', type: 'bytes32', internalType: 'bytes32' }],
    outputs: [
      { name: 'tokenCount', type: 'uint32', internalType: 'uint32' },
      {
        name: 'policyConfigs',
        type: 'tuple[]',
        internalType: 'struct FeePolicyStore.DestOverheadPolicyConfigArgs[]',
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
            name: 'destOverheadConfig',
            type: 'tuple',
            internalType: 'struct FeePolicyStore.DestOverheadConfig',
            components: [
              {
                name: 'destGasOverhead',
                type: 'uint32',
                internalType: 'uint32',
              },
              {
                name: 'destBytesOverhead',
                type: 'uint32',
                internalType: 'uint32',
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
    name: 'getFeeBatch',
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
    outputs: [
      {
        name: 'fees',
        type: 'tuple[]',
        internalType: 'struct IPoolConfigManager.LaneFee[]',
        components: [
          {
            name: 'feeUSDCents',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'destGasOverhead',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'destBytesOverhead',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'tokenFeeBps',
            type: 'uint16',
            internalType: 'uint16',
          },
          { name: 'isEnabled', type: 'bool', internalType: 'bool' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getFeePolicy',
    inputs: [{ name: 'policyName', type: 'bytes32', internalType: 'bytes32' }],
    outputs: [
      { name: 'tokenCount', type: 'uint32', internalType: 'uint32' },
      {
        name: 'policyConfigs',
        type: 'tuple[]',
        internalType: 'struct FeePolicyStore.FeePolicyConfigArgs[]',
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
            name: 'feeConfig',
            type: 'tuple',
            internalType: 'struct FeePolicyStore.FeeConfig',
            components: [
              {
                name: 'finalityFeeUSDCents',
                type: 'uint32',
                internalType: 'uint32',
              },
              {
                name: 'fastFinalityFeeUSDCents',
                type: 'uint32',
                internalType: 'uint32',
              },
              {
                name: 'finalityTransferFeeBps',
                type: 'uint16',
                internalType: 'uint16',
              },
              {
                name: 'fastFinalityTransferFeeBps',
                type: 'uint16',
                internalType: 'uint16',
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
    name: 'getInlineDestOverheadConfigs',
    inputs: [{ name: 'localToken', type: 'address', internalType: 'address' }],
    outputs: [
      {
        name: 'inlineConfigs',
        type: 'tuple[]',
        internalType: 'struct FeePolicyStore.InlineDestOverheadConfigArgs[]',
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
            name: 'destOverheadConfig',
            type: 'tuple',
            internalType: 'struct FeePolicyStore.DestOverheadConfig',
            components: [
              {
                name: 'destGasOverhead',
                type: 'uint32',
                internalType: 'uint32',
              },
              {
                name: 'destBytesOverhead',
                type: 'uint32',
                internalType: 'uint32',
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
    name: 'getInlineFeeConfigs',
    inputs: [{ name: 'localToken', type: 'address', internalType: 'address' }],
    outputs: [
      {
        name: 'inlineConfigs',
        type: 'tuple[]',
        internalType: 'struct FeePolicyStore.InlineFeeConfigArgs[]',
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
            name: 'feeConfig',
            type: 'tuple',
            internalType: 'struct FeePolicyStore.FeeConfig',
            components: [
              {
                name: 'finalityFeeUSDCents',
                type: 'uint32',
                internalType: 'uint32',
              },
              {
                name: 'fastFinalityFeeUSDCents',
                type: 'uint32',
                internalType: 'uint32',
              },
              {
                name: 'finalityTransferFeeBps',
                type: 'uint16',
                internalType: 'uint16',
              },
              {
                name: 'fastFinalityTransferFeeBps',
                type: 'uint16',
                internalType: 'uint16',
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
        name: 'feeLevels',
        type: 'uint8[]',
        internalType: 'enum PolicyConfig.RecordLevel[]',
      },
      {
        name: 'destOverheadLevels',
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
        name: 'feePolicyNames',
        type: 'bytes32[]',
        internalType: 'bytes32[]',
      },
      {
        name: 'destOverheadPolicyNames',
        type: 'bytes32[]',
        internalType: 'bytes32[]',
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
        name: 'feePolicyName',
        type: 'bytes32',
        internalType: 'bytes32',
      },
      {
        name: 'destOverheadPolicyName',
        type: 'bytes32',
        internalType: 'bytes32',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getTokenPolicyNamesBatch',
    inputs: [
      {
        name: 'localTokens',
        type: 'address[]',
        internalType: 'address[]',
      },
    ],
    outputs: [
      {
        name: 'feePolicyNames',
        type: 'bytes32[]',
        internalType: 'bytes32[]',
      },
      {
        name: 'destOverheadPolicyNames',
        type: 'bytes32[]',
        internalType: 'bytes32[]',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getTokenTransferFeeConfigBatch',
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
        name: 'feeConfigs',
        type: 'tuple[]',
        internalType: 'struct IPoolV2.TokenTransferFeeConfig[]',
        components: [
          {
            name: 'destGasOverhead',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'destBytesOverhead',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'finalityFeeUSDCents',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'fastFinalityFeeUSDCents',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'finalityTransferFeeBps',
            type: 'uint16',
            internalType: 'uint16',
          },
          {
            name: 'fastFinalityTransferFeeBps',
            type: 'uint16',
            internalType: 'uint16',
          },
          { name: 'isEnabled', type: 'bool', internalType: 'bool' },
        ],
      },
    ],
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
    type: 'function',
    name: 'validateLockOrBurn',
    inputs: [
      { name: 'localToken', type: 'address', internalType: 'address' },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        internalType: 'uint64',
      },
      { name: 'amount', type: 'uint256', internalType: 'uint256' },
      {
        name: 'requestedFinalityConfig',
        type: 'bytes4',
        internalType: 'bytes4',
      },
      { name: 'chargeTokenFee', type: 'bool', internalType: 'bool' },
      {
        name: 'destPoolDataLength',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [{ name: 'feeAmount', type: 'uint256', internalType: 'uint256' }],
    stateMutability: 'view',
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
    name: 'DestOverheadPolicyConfigRemoved',
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
    name: 'DestOverheadPolicyConfigSet',
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
        name: 'destOverheadConfig',
        type: 'tuple',
        indexed: false,
        internalType: 'struct FeePolicyStore.DestOverheadConfig',
        components: [
          {
            name: 'destGasOverhead',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'destBytesOverhead',
            type: 'uint32',
            internalType: 'uint32',
          },
        ],
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'DestOverheadPolicyRemoved',
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
    name: 'FeePolicyConfigRemoved',
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
    name: 'FeePolicyConfigSet',
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
        name: 'feeConfig',
        type: 'tuple',
        indexed: false,
        internalType: 'struct FeePolicyStore.FeeConfig',
        components: [
          {
            name: 'finalityFeeUSDCents',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'fastFinalityFeeUSDCents',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'finalityTransferFeeBps',
            type: 'uint16',
            internalType: 'uint16',
          },
          {
            name: 'fastFinalityTransferFeeBps',
            type: 'uint16',
            internalType: 'uint16',
          },
        ],
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'FeePolicyRemoved',
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
    name: 'InlineDestOverheadConfigRemoved',
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
    name: 'InlineDestOverheadConfigSet',
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
        name: 'destOverheadConfig',
        type: 'tuple',
        indexed: false,
        internalType: 'struct FeePolicyStore.DestOverheadConfig',
        components: [
          {
            name: 'destGasOverhead',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'destBytesOverhead',
            type: 'uint32',
            internalType: 'uint32',
          },
        ],
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'InlineFeeConfigRemoved',
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
    name: 'InlineFeeConfigSet',
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
        name: 'feeConfig',
        type: 'tuple',
        indexed: false,
        internalType: 'struct FeePolicyStore.FeeConfig',
        components: [
          {
            name: 'finalityFeeUSDCents',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'fastFinalityFeeUSDCents',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'finalityTransferFeeBps',
            type: 'uint16',
            internalType: 'uint16',
          },
          {
            name: 'fastFinalityTransferFeeBps',
            type: 'uint16',
            internalType: 'uint16',
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
    name: 'TokenDestOverheadPolicySet',
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
    name: 'TokenFeePolicySet',
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
    name: 'TokenProfileSet',
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
    name: 'DestOverheadRecordNotFound',
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
    name: 'FeeRecordNotFound',
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
    name: 'InvalidDestOverheadPolicyConfig',
    inputs: [
      { name: 'policyName', type: 'bytes32', internalType: 'bytes32' },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        internalType: 'uint64',
      },
      {
        name: 'destOverheadConfig',
        type: 'tuple',
        internalType: 'struct FeePolicyStore.DestOverheadConfig',
        components: [
          {
            name: 'destGasOverhead',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'destBytesOverhead',
            type: 'uint32',
            internalType: 'uint32',
          },
        ],
      },
    ],
  },
  {
    type: 'error',
    name: 'InvalidFeePolicyConfig',
    inputs: [
      { name: 'policyName', type: 'bytes32', internalType: 'bytes32' },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        internalType: 'uint64',
      },
      {
        name: 'feeConfig',
        type: 'tuple',
        internalType: 'struct FeePolicyStore.FeeConfig',
        components: [
          {
            name: 'finalityFeeUSDCents',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'fastFinalityFeeUSDCents',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'finalityTransferFeeBps',
            type: 'uint16',
            internalType: 'uint16',
          },
          {
            name: 'fastFinalityTransferFeeBps',
            type: 'uint16',
            internalType: 'uint16',
          },
        ],
      },
    ],
  },
  {
    type: 'error',
    name: 'InvalidInlineDestOverheadConfig',
    inputs: [
      { name: 'localToken', type: 'address', internalType: 'address' },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        internalType: 'uint64',
      },
      {
        name: 'destOverheadConfig',
        type: 'tuple',
        internalType: 'struct FeePolicyStore.DestOverheadConfig',
        components: [
          {
            name: 'destGasOverhead',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'destBytesOverhead',
            type: 'uint32',
            internalType: 'uint32',
          },
        ],
      },
    ],
  },
  {
    type: 'error',
    name: 'InvalidInlineFeeConfig',
    inputs: [
      { name: 'localToken', type: 'address', internalType: 'address' },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        internalType: 'uint64',
      },
      {
        name: 'feeConfig',
        type: 'tuple',
        internalType: 'struct FeePolicyStore.FeeConfig',
        components: [
          {
            name: 'finalityFeeUSDCents',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'fastFinalityFeeUSDCents',
            type: 'uint32',
            internalType: 'uint32',
          },
          {
            name: 'finalityTransferFeeBps',
            type: 'uint16',
            internalType: 'uint16',
          },
          {
            name: 'fastFinalityTransferFeeBps',
            type: 'uint16',
            internalType: 'uint16',
          },
        ],
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
    name: 'PoolDataTooLarge',
    inputs: [
      { name: 'localToken', type: 'address', internalType: 'address' },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        internalType: 'uint64',
      },
      {
        name: 'destPoolDataLength',
        type: 'uint256',
        internalType: 'uint256',
      },
      {
        name: 'destBytesOverhead',
        type: 'uint32',
        internalType: 'uint32',
      },
    ],
  },
  {
    type: 'error',
    name: 'TokenHasConfig',
    inputs: [{ name: 'localToken', type: 'address', internalType: 'address' }],
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
