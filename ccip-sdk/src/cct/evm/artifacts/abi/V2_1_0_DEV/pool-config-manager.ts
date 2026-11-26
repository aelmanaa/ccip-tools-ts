/**
 * PoolConfigManager: per-token and per-lane configuration of a multi-token pool, stored in three policy stores. Full ABI (writes and views); core keeps a view-only copy in `evm/abi/PoolConfigManager_2_1.ts`.
 *
 * `PoolConfigManager 2.1.0-dev`, pinned to chainlink-ccip `c950d9bc` (the commit docs-cct-foundry builds and
 * deploys; its release-settings build is byte-identical to these gobindings). Kept unexported from
 * the package: an exported ABI literal is inlined into the published `.d.ts`.
 */
// TODO: track a chainlink-ccip release tag and a `V2_1_0` folder once multi-token pools are released
export default [
  // generate:
  // fetch('https://github.com/smartcontractkit/chainlink-ccip/raw/c950d9bcab28ec9f6d52c4e38919c81a45deb8ca/chains/evm/gobindings/generated/latest/pool_config_manager/pool_config_manager.go')
  //   .then((res) => res.text())
  //   .then((body) => body.match(/^\s*ABI: "(.*?)",$/m)?.[1])
  //   .then((abi) => JSON.parse(abi.replace(/\\"/g, '"')))
  //   .then((obj) => require('util').inspect(obj, { depth: 99, maxArrayLength: Infinity }).split('\n').slice(1, -1))
  {
    type: 'constructor',
    inputs: [
      {
        name: 'tokenAdminRegistry',
        type: 'address',
        internalType: 'contract ITokenAdminRegistry',
      },
      {
        name: 'connectionStore',
        type: 'address',
        internalType: 'contract ConnectionPolicyStore',
      },
      {
        name: 'feeStore',
        type: 'address',
        internalType: 'contract FeePolicyStore',
      },
      {
        name: 'securityStore',
        type: 'address',
        internalType: 'contract SecurityPolicyStore',
      },
      { name: 'admin', type: 'address', internalType: 'address' },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'CONFIG_ROLE',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'CONNECTION_ROLE',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'DEFAULT_ADMIN_ROLE',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'DEST_OVERHEAD_ROLE',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'FEE_COLLECTOR_ROLE',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'FEE_ROLE',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'PAUSER_ROLE',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'POLICY_ROLE',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'RATE_LIMIT_ROLE',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'REMOTE_POOL_ROLE',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'SECURITY_ROLE',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'TOKEN_MANAGER_ROLE',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'UNPAUSER_ROLE',
    inputs: [],
    outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'acceptDefaultAdminTransfer',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'applyConnectionPolicyConfigUpdates',
    inputs: [
      {
        name: '',
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
      { name: '', type: 'bytes32[]', internalType: 'bytes32[]' },
      {
        name: '',
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
    name: 'applyDestOverheadPolicyConfigUpdates',
    inputs: [
      {
        name: '',
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
      { name: '', type: 'bytes32[]', internalType: 'bytes32[]' },
      {
        name: '',
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
        name: '',
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
      { name: '', type: 'bytes32[]', internalType: 'bytes32[]' },
      {
        name: '',
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
    name: 'applyInlineConnectionConfigUpdates',
    inputs: [
      {
        name: '',
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
    name: 'applyInlineDestOverheadConfigUpdates',
    inputs: [
      {
        name: '',
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
        name: '',
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
        name: '',
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
        name: '',
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
    name: 'applyInlineRateLimitBucketUpdates',
    inputs: [
      {
        name: '',
        type: 'tuple[]',
        internalType: 'struct SecurityPolicyStore.InlineRateLimitBucketArgs[]',
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
            name: 'direction',
            type: 'uint8',
            internalType: 'enum IPoolV2.MessageDirection',
          },
          { name: 'fastFinality', type: 'bool', internalType: 'bool' },
          {
            name: 'config',
            type: 'tuple',
            internalType: 'struct RateLimiter.Config',
            components: [
              { name: 'isEnabled', type: 'bool', internalType: 'bool' },
              {
                name: 'capacity',
                type: 'uint128',
                internalType: 'uint128',
              },
              {
                name: 'rate',
                type: 'uint128',
                internalType: 'uint128',
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
    name: 'applyInlineRateLimitConfigUpdates',
    inputs: [
      {
        name: '',
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
        name: '',
        type: 'tuple[]',
        internalType: 'struct SecurityPolicyStore.InlineRateLimitConfigArgs[]',
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
            name: 'rateLimitConfig',
            type: 'tuple',
            internalType: 'struct SecurityPolicyStore.RateLimitConfig',
            components: [
              {
                name: 'outbound',
                type: 'tuple',
                internalType: 'struct RateLimiter.Config',
                components: [
                  {
                    name: 'isEnabled',
                    type: 'bool',
                    internalType: 'bool',
                  },
                  {
                    name: 'capacity',
                    type: 'uint128',
                    internalType: 'uint128',
                  },
                  {
                    name: 'rate',
                    type: 'uint128',
                    internalType: 'uint128',
                  },
                ],
              },
              {
                name: 'inbound',
                type: 'tuple',
                internalType: 'struct RateLimiter.Config',
                components: [
                  {
                    name: 'isEnabled',
                    type: 'bool',
                    internalType: 'bool',
                  },
                  {
                    name: 'capacity',
                    type: 'uint128',
                    internalType: 'uint128',
                  },
                  {
                    name: 'rate',
                    type: 'uint128',
                    internalType: 'uint128',
                  },
                ],
              },
              {
                name: 'fastFinalityOutbound',
                type: 'tuple',
                internalType: 'struct RateLimiter.Config',
                components: [
                  {
                    name: 'isEnabled',
                    type: 'bool',
                    internalType: 'bool',
                  },
                  {
                    name: 'capacity',
                    type: 'uint128',
                    internalType: 'uint128',
                  },
                  {
                    name: 'rate',
                    type: 'uint128',
                    internalType: 'uint128',
                  },
                ],
              },
              {
                name: 'fastFinalityInbound',
                type: 'tuple',
                internalType: 'struct RateLimiter.Config',
                components: [
                  {
                    name: 'isEnabled',
                    type: 'bool',
                    internalType: 'bool',
                  },
                  {
                    name: 'capacity',
                    type: 'uint128',
                    internalType: 'uint128',
                  },
                  {
                    name: 'rate',
                    type: 'uint128',
                    internalType: 'uint128',
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
    name: 'applyInlineRemotePoolConfigUpdates',
    inputs: [
      {
        name: '',
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
        name: '',
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
    name: 'applyInlineSecurityConfigUpdates',
    inputs: [
      {
        name: '',
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
        name: '',
        type: 'tuple[]',
        internalType: 'struct SecurityPolicyStore.InlineSecurityConfigArgs[]',
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
            name: 'securityConfig',
            type: 'tuple',
            internalType: 'struct SecurityPolicyStore.SecurityConfig',
            components: [
              {
                name: 'outboundCCVs',
                type: 'address[]',
                internalType: 'address[]',
              },
              {
                name: 'inboundCCVs',
                type: 'address[]',
                internalType: 'address[]',
              },
              {
                name: 'hook',
                type: 'address',
                internalType: 'address',
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
    name: 'applyRateLimitPolicyBucketUpdates',
    inputs: [
      {
        name: '',
        type: 'tuple[]',
        internalType: 'struct SecurityPolicyStore.RateLimitPolicyBucketArgs[]',
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
            name: 'direction',
            type: 'uint8',
            internalType: 'enum IPoolV2.MessageDirection',
          },
          { name: 'fastFinality', type: 'bool', internalType: 'bool' },
          {
            name: 'config',
            type: 'tuple',
            internalType: 'struct RateLimiter.Config',
            components: [
              { name: 'isEnabled', type: 'bool', internalType: 'bool' },
              {
                name: 'capacity',
                type: 'uint128',
                internalType: 'uint128',
              },
              {
                name: 'rate',
                type: 'uint128',
                internalType: 'uint128',
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
    name: 'applyRateLimitPolicyConfigUpdates',
    inputs: [
      {
        name: '',
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
      { name: '', type: 'bytes32[]', internalType: 'bytes32[]' },
      {
        name: '',
        type: 'tuple[]',
        internalType: 'struct SecurityPolicyStore.RateLimitPolicyConfigArgs[]',
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
            name: 'localDecimals',
            type: 'uint8',
            internalType: 'uint8',
          },
          {
            name: 'rateLimitConfig',
            type: 'tuple',
            internalType: 'struct SecurityPolicyStore.RateLimitConfig',
            components: [
              {
                name: 'outbound',
                type: 'tuple',
                internalType: 'struct RateLimiter.Config',
                components: [
                  {
                    name: 'isEnabled',
                    type: 'bool',
                    internalType: 'bool',
                  },
                  {
                    name: 'capacity',
                    type: 'uint128',
                    internalType: 'uint128',
                  },
                  {
                    name: 'rate',
                    type: 'uint128',
                    internalType: 'uint128',
                  },
                ],
              },
              {
                name: 'inbound',
                type: 'tuple',
                internalType: 'struct RateLimiter.Config',
                components: [
                  {
                    name: 'isEnabled',
                    type: 'bool',
                    internalType: 'bool',
                  },
                  {
                    name: 'capacity',
                    type: 'uint128',
                    internalType: 'uint128',
                  },
                  {
                    name: 'rate',
                    type: 'uint128',
                    internalType: 'uint128',
                  },
                ],
              },
              {
                name: 'fastFinalityOutbound',
                type: 'tuple',
                internalType: 'struct RateLimiter.Config',
                components: [
                  {
                    name: 'isEnabled',
                    type: 'bool',
                    internalType: 'bool',
                  },
                  {
                    name: 'capacity',
                    type: 'uint128',
                    internalType: 'uint128',
                  },
                  {
                    name: 'rate',
                    type: 'uint128',
                    internalType: 'uint128',
                  },
                ],
              },
              {
                name: 'fastFinalityInbound',
                type: 'tuple',
                internalType: 'struct RateLimiter.Config',
                components: [
                  {
                    name: 'isEnabled',
                    type: 'bool',
                    internalType: 'bool',
                  },
                  {
                    name: 'capacity',
                    type: 'uint128',
                    internalType: 'uint128',
                  },
                  {
                    name: 'rate',
                    type: 'uint128',
                    internalType: 'uint128',
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
        name: '',
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
      { name: '', type: 'bytes32[]', internalType: 'bytes32[]' },
      {
        name: '',
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
        name: '',
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
    name: 'applySecurityPolicyConfigUpdates',
    inputs: [
      {
        name: '',
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
      { name: '', type: 'bytes32[]', internalType: 'bytes32[]' },
      {
        name: '',
        type: 'tuple[]',
        internalType: 'struct SecurityPolicyStore.SecurityPolicyConfigArgs[]',
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
            name: 'securityConfig',
            type: 'tuple',
            internalType: 'struct SecurityPolicyStore.SecurityConfig',
            components: [
              {
                name: 'outboundCCVs',
                type: 'address[]',
                internalType: 'address[]',
              },
              {
                name: 'inboundCCVs',
                type: 'address[]',
                internalType: 'address[]',
              },
              {
                name: 'hook',
                type: 'address',
                internalType: 'address',
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
    name: 'applySubsetTokenUpdates',
    inputs: [
      {
        name: '',
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
        name: '',
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
    name: 'applyTokenDestOverheadPolicyUpdates',
    inputs: [
      {
        name: '',
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
        name: '',
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
      { name: '', type: 'address[]', internalType: 'address[]' },
      {
        name: '',
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
    name: 'applyTokenRateLimitPolicyUpdates',
    inputs: [
      {
        name: '',
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
    name: 'applyTokenRemotePoolPolicyUpdates',
    inputs: [
      {
        name: '',
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
    name: 'applyTokenSecurityPolicyUpdates',
    inputs: [
      {
        name: '',
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
    name: 'beginDefaultAdminTransfer',
    inputs: [{ name: 'newAdmin', type: 'address', internalType: 'address' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'cancelDefaultAdminTransfer',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'changeDefaultAdminDelay',
    inputs: [{ name: 'newDelay', type: 'uint48', internalType: 'uint48' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'defaultAdmin',
    inputs: [],
    outputs: [{ name: '', type: 'address', internalType: 'address' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'defaultAdminDelay',
    inputs: [],
    outputs: [{ name: '', type: 'uint48', internalType: 'uint48' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'defaultAdminDelayIncreaseWait',
    inputs: [],
    outputs: [{ name: '', type: 'uint48', internalType: 'uint48' }],
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
    inputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    outputs: [
      { name: '', type: 'uint32', internalType: 'uint32' },
      { name: '', type: 'address', internalType: 'address' },
      {
        name: '',
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
    name: 'getCurrentRateLimiterStateBatch',
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
        name: 'states',
        type: 'tuple[]',
        internalType: 'struct IPoolConfigManager.LaneRateLimiterState[]',
        components: [
          {
            name: 'outbound',
            type: 'tuple',
            internalType: 'struct IPoolConfigManager.TokenBucket',
            components: [
              {
                name: 'tokens',
                type: 'uint128',
                internalType: 'uint128',
              },
              {
                name: 'lastUpdated',
                type: 'uint32',
                internalType: 'uint32',
              },
              { name: 'isEnabled', type: 'bool', internalType: 'bool' },
              {
                name: 'capacity',
                type: 'uint128',
                internalType: 'uint128',
              },
              {
                name: 'rate',
                type: 'uint128',
                internalType: 'uint128',
              },
            ],
          },
          {
            name: 'inbound',
            type: 'tuple',
            internalType: 'struct IPoolConfigManager.TokenBucket',
            components: [
              {
                name: 'tokens',
                type: 'uint128',
                internalType: 'uint128',
              },
              {
                name: 'lastUpdated',
                type: 'uint32',
                internalType: 'uint32',
              },
              { name: 'isEnabled', type: 'bool', internalType: 'bool' },
              {
                name: 'capacity',
                type: 'uint128',
                internalType: 'uint128',
              },
              {
                name: 'rate',
                type: 'uint128',
                internalType: 'uint128',
              },
            ],
          },
          {
            name: 'fastFinalityOutbound',
            type: 'tuple',
            internalType: 'struct IPoolConfigManager.TokenBucket',
            components: [
              {
                name: 'tokens',
                type: 'uint128',
                internalType: 'uint128',
              },
              {
                name: 'lastUpdated',
                type: 'uint32',
                internalType: 'uint32',
              },
              { name: 'isEnabled', type: 'bool', internalType: 'bool' },
              {
                name: 'capacity',
                type: 'uint128',
                internalType: 'uint128',
              },
              {
                name: 'rate',
                type: 'uint128',
                internalType: 'uint128',
              },
            ],
          },
          {
            name: 'fastFinalityInbound',
            type: 'tuple',
            internalType: 'struct IPoolConfigManager.TokenBucket',
            components: [
              {
                name: 'tokens',
                type: 'uint128',
                internalType: 'uint128',
              },
              {
                name: 'lastUpdated',
                type: 'uint32',
                internalType: 'uint32',
              },
              { name: 'isEnabled', type: 'bool', internalType: 'bool' },
              {
                name: 'capacity',
                type: 'uint128',
                internalType: 'uint128',
              },
              {
                name: 'rate',
                type: 'uint128',
                internalType: 'uint128',
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
    name: 'getDestOverheadPolicy',
    inputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    outputs: [
      { name: '', type: 'uint32', internalType: 'uint32' },
      {
        name: '',
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
    inputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    outputs: [
      { name: '', type: 'uint32', internalType: 'uint32' },
      {
        name: '',
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
    name: 'getInlineConnectionConfigs',
    inputs: [{ name: '', type: 'address', internalType: 'address' }],
    outputs: [
      {
        name: '',
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
    name: 'getInlineDestOverheadConfigs',
    inputs: [{ name: '', type: 'address', internalType: 'address' }],
    outputs: [
      {
        name: '',
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
    inputs: [{ name: '', type: 'address', internalType: 'address' }],
    outputs: [
      {
        name: '',
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
    name: 'getInlineRateLimitConfigs',
    inputs: [{ name: '', type: 'address', internalType: 'address' }],
    outputs: [
      {
        name: '',
        type: 'tuple[]',
        internalType: 'struct SecurityPolicyStore.InlineRateLimitConfigArgs[]',
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
            name: 'rateLimitConfig',
            type: 'tuple',
            internalType: 'struct SecurityPolicyStore.RateLimitConfig',
            components: [
              {
                name: 'outbound',
                type: 'tuple',
                internalType: 'struct RateLimiter.Config',
                components: [
                  {
                    name: 'isEnabled',
                    type: 'bool',
                    internalType: 'bool',
                  },
                  {
                    name: 'capacity',
                    type: 'uint128',
                    internalType: 'uint128',
                  },
                  {
                    name: 'rate',
                    type: 'uint128',
                    internalType: 'uint128',
                  },
                ],
              },
              {
                name: 'inbound',
                type: 'tuple',
                internalType: 'struct RateLimiter.Config',
                components: [
                  {
                    name: 'isEnabled',
                    type: 'bool',
                    internalType: 'bool',
                  },
                  {
                    name: 'capacity',
                    type: 'uint128',
                    internalType: 'uint128',
                  },
                  {
                    name: 'rate',
                    type: 'uint128',
                    internalType: 'uint128',
                  },
                ],
              },
              {
                name: 'fastFinalityOutbound',
                type: 'tuple',
                internalType: 'struct RateLimiter.Config',
                components: [
                  {
                    name: 'isEnabled',
                    type: 'bool',
                    internalType: 'bool',
                  },
                  {
                    name: 'capacity',
                    type: 'uint128',
                    internalType: 'uint128',
                  },
                  {
                    name: 'rate',
                    type: 'uint128',
                    internalType: 'uint128',
                  },
                ],
              },
              {
                name: 'fastFinalityInbound',
                type: 'tuple',
                internalType: 'struct RateLimiter.Config',
                components: [
                  {
                    name: 'isEnabled',
                    type: 'bool',
                    internalType: 'bool',
                  },
                  {
                    name: 'capacity',
                    type: 'uint128',
                    internalType: 'uint128',
                  },
                  {
                    name: 'rate',
                    type: 'uint128',
                    internalType: 'uint128',
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
    name: 'getInlineRemotePoolConfigs',
    inputs: [{ name: '', type: 'address', internalType: 'address' }],
    outputs: [
      {
        name: '',
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
    name: 'getInlineSecurityConfigs',
    inputs: [{ name: '', type: 'address', internalType: 'address' }],
    outputs: [
      {
        name: '',
        type: 'tuple[]',
        internalType: 'struct SecurityPolicyStore.InlineSecurityConfigArgs[]',
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
            name: 'securityConfig',
            type: 'tuple',
            internalType: 'struct SecurityPolicyStore.SecurityConfig',
            components: [
              {
                name: 'outboundCCVs',
                type: 'address[]',
                internalType: 'address[]',
              },
              {
                name: 'inboundCCVs',
                type: 'address[]',
                internalType: 'address[]',
              },
              {
                name: 'hook',
                type: 'address',
                internalType: 'address',
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
      {
        name: 'rateLimitLevels',
        type: 'uint8[]',
        internalType: 'enum PolicyConfig.RecordLevel[]',
      },
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
      {
        name: 'securityLevels',
        type: 'uint8[]',
        internalType: 'enum PolicyConfig.RecordLevel[]',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getLaneVerificationBatch',
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
      { name: '', type: 'bytes4', internalType: 'bytes4' },
    ],
    outputs: [
      { name: 'hooks', type: 'address[]', internalType: 'address[]' },
      {
        name: 'outboundCCVs',
        type: 'address[][]',
        internalType: 'address[][]',
      },
      {
        name: 'inboundCCVs',
        type: 'address[][]',
        internalType: 'address[][]',
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
      {
        name: 'rateLimitPolicyNames',
        type: 'bytes32[]',
        internalType: 'bytes32[]',
      },
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
      {
        name: 'securityPolicyNames',
        type: 'bytes32[]',
        internalType: 'bytes32[]',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getRateLimitPolicy',
    inputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    outputs: [
      { name: '', type: 'uint32', internalType: 'uint32' },
      { name: '', type: 'uint8', internalType: 'uint8' },
      {
        name: '',
        type: 'tuple[]',
        internalType: 'struct SecurityPolicyStore.RateLimitPolicyConfigArgs[]',
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
            name: 'localDecimals',
            type: 'uint8',
            internalType: 'uint8',
          },
          {
            name: 'rateLimitConfig',
            type: 'tuple',
            internalType: 'struct SecurityPolicyStore.RateLimitConfig',
            components: [
              {
                name: 'outbound',
                type: 'tuple',
                internalType: 'struct RateLimiter.Config',
                components: [
                  {
                    name: 'isEnabled',
                    type: 'bool',
                    internalType: 'bool',
                  },
                  {
                    name: 'capacity',
                    type: 'uint128',
                    internalType: 'uint128',
                  },
                  {
                    name: 'rate',
                    type: 'uint128',
                    internalType: 'uint128',
                  },
                ],
              },
              {
                name: 'inbound',
                type: 'tuple',
                internalType: 'struct RateLimiter.Config',
                components: [
                  {
                    name: 'isEnabled',
                    type: 'bool',
                    internalType: 'bool',
                  },
                  {
                    name: 'capacity',
                    type: 'uint128',
                    internalType: 'uint128',
                  },
                  {
                    name: 'rate',
                    type: 'uint128',
                    internalType: 'uint128',
                  },
                ],
              },
              {
                name: 'fastFinalityOutbound',
                type: 'tuple',
                internalType: 'struct RateLimiter.Config',
                components: [
                  {
                    name: 'isEnabled',
                    type: 'bool',
                    internalType: 'bool',
                  },
                  {
                    name: 'capacity',
                    type: 'uint128',
                    internalType: 'uint128',
                  },
                  {
                    name: 'rate',
                    type: 'uint128',
                    internalType: 'uint128',
                  },
                ],
              },
              {
                name: 'fastFinalityInbound',
                type: 'tuple',
                internalType: 'struct RateLimiter.Config',
                components: [
                  {
                    name: 'isEnabled',
                    type: 'bool',
                    internalType: 'bool',
                  },
                  {
                    name: 'capacity',
                    type: 'uint128',
                    internalType: 'uint128',
                  },
                  {
                    name: 'rate',
                    type: 'uint128',
                    internalType: 'uint128',
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
    name: 'getRemotePoolPolicy',
    inputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    outputs: [
      { name: '', type: 'uint32', internalType: 'uint32' },
      {
        name: '',
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
    name: 'getRoleAdmin',
    inputs: [{ name: 'role', type: 'bytes32', internalType: 'bytes32' }],
    outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getSecurityPolicy',
    inputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
    outputs: [
      { name: '', type: 'uint32', internalType: 'uint32' },
      {
        name: '',
        type: 'tuple[]',
        internalType: 'struct SecurityPolicyStore.SecurityPolicyConfigArgs[]',
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
            name: 'securityConfig',
            type: 'tuple',
            internalType: 'struct SecurityPolicyStore.SecurityConfig',
            components: [
              {
                name: 'outboundCCVs',
                type: 'address[]',
                internalType: 'address[]',
              },
              {
                name: 'inboundCCVs',
                type: 'address[]',
                internalType: 'address[]',
              },
              {
                name: 'hook',
                type: 'address',
                internalType: 'address',
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
    name: 'getStaticConfig',
    inputs: [],
    outputs: [
      {
        name: 'tokenAdminRegistry',
        type: 'address',
        internalType: 'contract ITokenAdminRegistry',
      },
      {
        name: 'connectionStore',
        type: 'address',
        internalType: 'contract ConnectionPolicyStore',
      },
      {
        name: 'feeStore',
        type: 'address',
        internalType: 'contract FeePolicyStore',
      },
      {
        name: 'securityStore',
        type: 'address',
        internalType: 'contract SecurityPolicyStore',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getSubsetTokens',
    inputs: [
      { name: '', type: 'bytes32', internalType: 'bytes32' },
      { name: '', type: 'uint64', internalType: 'uint64' },
      { name: '', type: 'uint64', internalType: 'uint64' },
      { name: '', type: 'uint64', internalType: 'uint64' },
    ],
    outputs: [
      { name: '', type: 'bool', internalType: 'bool' },
      { name: '', type: 'address[]', internalType: 'address[]' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getTokenAdminRegistry',
    inputs: [],
    outputs: [
      {
        name: 'tokenAdminRegistry',
        type: 'address',
        internalType: 'address',
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
    name: 'grantRole',
    inputs: [
      { name: 'role', type: 'bytes32', internalType: 'bytes32' },
      { name: 'account', type: 'address', internalType: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'hasRole',
    inputs: [
      { name: 'role', type: 'bytes32', internalType: 'bytes32' },
      { name: 'account', type: 'address', internalType: 'address' },
    ],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
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
    name: 'pauseChains',
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
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'pauseGlobally',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'pauseTokens',
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
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'pendingDefaultAdmin',
    inputs: [],
    outputs: [
      { name: 'newAdmin', type: 'address', internalType: 'address' },
      { name: 'schedule', type: 'uint48', internalType: 'uint48' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'pendingDefaultAdminDelay',
    inputs: [],
    outputs: [
      { name: 'newDelay', type: 'uint48', internalType: 'uint48' },
      { name: 'schedule', type: 'uint48', internalType: 'uint48' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'renounceRole',
    inputs: [
      { name: 'role', type: 'bytes32', internalType: 'bytes32' },
      { name: 'account', type: 'address', internalType: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'revokeRole',
    inputs: [
      { name: 'role', type: 'bytes32', internalType: 'bytes32' },
      { name: 'account', type: 'address', internalType: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'rollbackDefaultAdminDelay',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'supportsInterface',
    inputs: [{ name: 'interfaceId', type: 'bytes4', internalType: 'bytes4' }],
    outputs: [{ name: '', type: 'bool', internalType: 'bool' }],
    stateMutability: 'view',
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
    name: 'unpauseChains',
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
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'unpauseGlobally',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'unpauseTokens',
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
    ],
    outputs: [],
    stateMutability: 'nonpayable',
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
      { name: 'tokenArgs', type: 'bytes', internalType: 'bytes' },
      { name: 'chargeTokenFee', type: 'bool', internalType: 'bool' },
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
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'validateReleaseOrMint',
    inputs: [
      {
        name: 'releaseOrMintIn',
        type: 'tuple',
        internalType: 'struct Pool.ReleaseOrMintInV1',
        components: [
          {
            name: 'originalSender',
            type: 'bytes',
            internalType: 'bytes',
          },
          {
            name: 'remoteChainSelector',
            type: 'uint64',
            internalType: 'uint64',
          },
          {
            name: 'receiver',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'sourceDenominatedAmount',
            type: 'uint256',
            internalType: 'uint256',
          },
          {
            name: 'localToken',
            type: 'address',
            internalType: 'address',
          },
          {
            name: 'sourcePoolAddress',
            type: 'bytes',
            internalType: 'bytes',
          },
          {
            name: 'sourcePoolData',
            type: 'bytes',
            internalType: 'bytes',
          },
          {
            name: 'offchainTokenData',
            type: 'bytes',
            internalType: 'bytes',
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
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'withdrawFeeTokens',
    inputs: [
      {
        name: 'pool',
        type: 'address',
        internalType: 'contract IMultiTokenPool',
      },
      {
        name: 'feeTokens',
        type: 'address[]',
        internalType: 'address[]',
      },
      { name: 'recipient', type: 'address', internalType: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    name: 'DefaultAdminDelayChangeCanceled',
    inputs: [],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'DefaultAdminDelayChangeScheduled',
    inputs: [
      {
        name: 'newDelay',
        type: 'uint48',
        indexed: false,
        internalType: 'uint48',
      },
      {
        name: 'effectSchedule',
        type: 'uint48',
        indexed: false,
        internalType: 'uint48',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'DefaultAdminTransferCanceled',
    inputs: [],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'DefaultAdminTransferScheduled',
    inputs: [
      {
        name: 'newAdmin',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'acceptSchedule',
        type: 'uint48',
        indexed: false,
        internalType: 'uint48',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'RoleAdminChanged',
    inputs: [
      {
        name: 'role',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'previousAdminRole',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'newAdminRole',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'RoleGranted',
    inputs: [
      {
        name: 'role',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'account',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'sender',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'RoleRevoked',
    inputs: [
      {
        name: 'role',
        type: 'bytes32',
        indexed: true,
        internalType: 'bytes32',
      },
      {
        name: 'account',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
      {
        name: 'sender',
        type: 'address',
        indexed: true,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'StaticConfigSet',
    inputs: [
      {
        name: 'tokenAdminRegistry',
        type: 'address',
        indexed: false,
        internalType: 'contract ITokenAdminRegistry',
      },
      {
        name: 'connectionStore',
        type: 'address',
        indexed: false,
        internalType: 'contract ConnectionPolicyStore',
      },
      {
        name: 'feeStore',
        type: 'address',
        indexed: false,
        internalType: 'contract FeePolicyStore',
      },
      {
        name: 'securityStore',
        type: 'address',
        indexed: false,
        internalType: 'contract SecurityPolicyStore',
      },
    ],
    anonymous: false,
  },
  { type: 'error', name: 'AccessControlBadConfirmation', inputs: [] },
  {
    type: 'error',
    name: 'AccessControlEnforcedDefaultAdminDelay',
    inputs: [{ name: 'schedule', type: 'uint48', internalType: 'uint48' }],
  },
  {
    type: 'error',
    name: 'AccessControlEnforcedDefaultAdminRules',
    inputs: [],
  },
  {
    type: 'error',
    name: 'AccessControlInvalidDefaultAdmin',
    inputs: [
      {
        name: 'defaultAdmin',
        type: 'address',
        internalType: 'address',
      },
    ],
  },
  {
    type: 'error',
    name: 'AccessControlUnauthorizedAccount',
    inputs: [
      { name: 'account', type: 'address', internalType: 'address' },
      { name: 'neededRole', type: 'bytes32', internalType: 'bytes32' },
    ],
  },
  {
    type: 'error',
    name: 'AddressEmptyCode',
    inputs: [{ name: 'target', type: 'address', internalType: 'address' }],
  },
  {
    type: 'error',
    name: 'CallerIsNotTokenPool',
    inputs: [
      { name: 'caller', type: 'address', internalType: 'address' },
      { name: 'localToken', type: 'address', internalType: 'address' },
    ],
  },
  { type: 'error', name: 'FailedCall', inputs: [] },
  {
    type: 'error',
    name: 'InsufficientBalance',
    inputs: [
      { name: 'balance', type: 'uint256', internalType: 'uint256' },
      { name: 'needed', type: 'uint256', internalType: 'uint256' },
    ],
  },
  {
    type: 'error',
    name: 'PoolConfigManagerMismatch',
    inputs: [
      { name: 'pool', type: 'address', internalType: 'address' },
      {
        name: 'poolConfigManager',
        type: 'address',
        internalType: 'address',
      },
    ],
  },
  {
    type: 'error',
    name: 'SafeCastOverflowedUintDowncast',
    inputs: [
      { name: 'bits', type: 'uint8', internalType: 'uint8' },
      { name: 'value', type: 'uint256', internalType: 'uint256' },
    ],
  },
  { type: 'error', name: 'ZeroAddressInvalid', inputs: [] },
  // generate:end
] as const
