/**
 * SecurityPolicyStore: rate-limit and security policies behind a PoolConfigManager.
 *
 * `SecurityPolicyStore 2.1.0-dev`, pinned to chainlink-ccip `c950d9bc` (the commit docs-cct-foundry builds and
 * deploys; its release-settings build is byte-identical to these gobindings). Kept unexported from
 * the package: an exported ABI literal is inlined into the published `.d.ts`.
 */
// TODO: track a chainlink-ccip release tag and a `V2_1_0` folder once multi-token pools are released
export default [
  // generate:
  // fetch('https://github.com/smartcontractkit/chainlink-ccip/raw/c950d9bcab28ec9f6d52c4e38919c81a45deb8ca/chains/evm/gobindings/generated/latest/security_policy_store/security_policy_store.go')
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
    name: 'applyInlineRateLimitBucketUpdates',
    inputs: [
      {
        name: 'bucketConfigsToSet',
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
    name: 'applyInlineSecurityConfigUpdates',
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
        name: 'bucketConfigsToSet',
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
    name: 'applySecurityPolicyConfigUpdates',
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
    name: 'applyTokenRateLimitPolicyUpdates',
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
    name: 'applyTokenSecurityPolicyUpdates',
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
    name: 'getAllAuthorizedCallers',
    inputs: [],
    outputs: [{ name: '', type: 'address[]', internalType: 'address[]' }],
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
    name: 'getInlineRateLimitConfigs',
    inputs: [{ name: 'localToken', type: 'address', internalType: 'address' }],
    outputs: [
      {
        name: 'inlineConfigs',
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
    name: 'getInlineSecurityConfigs',
    inputs: [{ name: 'localToken', type: 'address', internalType: 'address' }],
    outputs: [
      {
        name: 'inlineConfigs',
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
        name: 'rateLimitLevels',
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
        name: 'rateLimitPolicyNames',
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
    inputs: [{ name: 'policyName', type: 'bytes32', internalType: 'bytes32' }],
    outputs: [
      { name: 'tokenCount', type: 'uint32', internalType: 'uint32' },
      { name: 'localDecimals', type: 'uint8', internalType: 'uint8' },
      {
        name: 'policyConfigs',
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
    name: 'getSecurityPolicy',
    inputs: [{ name: 'policyName', type: 'bytes32', internalType: 'bytes32' }],
    outputs: [
      { name: 'tokenCount', type: 'uint32', internalType: 'uint32' },
      {
        name: 'policyConfigs',
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
    name: 'getTokenPolicies',
    inputs: [{ name: 'localToken', type: 'address', internalType: 'address' }],
    outputs: [
      { name: 'isRegistered', type: 'bool', internalType: 'bool' },
      { name: 'localDecimals', type: 'uint8', internalType: 'uint8' },
      {
        name: 'rateLimitPolicyName',
        type: 'bytes32',
        internalType: 'bytes32',
      },
      {
        name: 'securityPolicyName',
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
        name: 'rateLimitPolicyNames',
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
    ],
    outputs: [{ name: 'hook', type: 'address', internalType: 'address' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'validateReleaseOrMint',
    inputs: [
      { name: 'localToken', type: 'address', internalType: 'address' },
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        internalType: 'uint64',
      },
      { name: 'localAmount', type: 'uint256', internalType: 'uint256' },
      {
        name: 'requestedFinalityConfig',
        type: 'bytes4',
        internalType: 'bytes4',
      },
    ],
    outputs: [{ name: 'hook', type: 'address', internalType: 'address' }],
    stateMutability: 'nonpayable',
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
    name: 'FastFinalityInboundRateLimitConsumed',
    inputs: [
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        indexed: true,
        internalType: 'uint64',
      },
      {
        name: 'token',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'amount',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'FastFinalityOutboundRateLimitConsumed',
    inputs: [
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        indexed: true,
        internalType: 'uint64',
      },
      {
        name: 'token',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'amount',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'InboundRateLimitConsumed',
    inputs: [
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        indexed: true,
        internalType: 'uint64',
      },
      {
        name: 'token',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'amount',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'InlineRateLimitBucketSet',
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
        name: 'direction',
        type: 'uint8',
        indexed: false,
        internalType: 'enum IPoolV2.MessageDirection',
      },
      {
        name: 'fastFinality',
        type: 'bool',
        indexed: false,
        internalType: 'bool',
      },
      {
        name: 'config',
        type: 'tuple',
        indexed: false,
        internalType: 'struct RateLimiter.Config',
        components: [
          { name: 'isEnabled', type: 'bool', internalType: 'bool' },
          {
            name: 'capacity',
            type: 'uint128',
            internalType: 'uint128',
          },
          { name: 'rate', type: 'uint128', internalType: 'uint128' },
        ],
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'InlineRateLimitConfigRemoved',
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
    name: 'InlineRateLimitConfigSet',
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
        name: 'rateLimitConfig',
        type: 'tuple',
        indexed: false,
        internalType: 'struct SecurityPolicyStore.RateLimitConfig',
        components: [
          {
            name: 'outbound',
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
          {
            name: 'inbound',
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
          {
            name: 'fastFinalityOutbound',
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
          {
            name: 'fastFinalityInbound',
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
    anonymous: false,
  },
  {
    type: 'event',
    name: 'InlineSecurityConfigRemoved',
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
    name: 'InlineSecurityConfigSet',
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
        name: 'securityConfig',
        type: 'tuple',
        indexed: false,
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
          { name: 'hook', type: 'address', internalType: 'address' },
        ],
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'OutboundRateLimitConsumed',
    inputs: [
      {
        name: 'remoteChainSelector',
        type: 'uint64',
        indexed: true,
        internalType: 'uint64',
      },
      {
        name: 'token',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
      {
        name: 'amount',
        type: 'uint256',
        indexed: false,
        internalType: 'uint256',
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
    name: 'RateLimitPolicyBucketSet',
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
        name: 'localDecimals',
        type: 'uint8',
        indexed: false,
        internalType: 'uint8',
      },
      {
        name: 'direction',
        type: 'uint8',
        indexed: false,
        internalType: 'enum IPoolV2.MessageDirection',
      },
      {
        name: 'fastFinality',
        type: 'bool',
        indexed: false,
        internalType: 'bool',
      },
      {
        name: 'config',
        type: 'tuple',
        indexed: false,
        internalType: 'struct RateLimiter.Config',
        components: [
          { name: 'isEnabled', type: 'bool', internalType: 'bool' },
          {
            name: 'capacity',
            type: 'uint128',
            internalType: 'uint128',
          },
          { name: 'rate', type: 'uint128', internalType: 'uint128' },
        ],
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'RateLimitPolicyConfigRemoved',
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
    name: 'RateLimitPolicyConfigSet',
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
        name: 'localDecimals',
        type: 'uint8',
        indexed: false,
        internalType: 'uint8',
      },
      {
        name: 'rateLimitConfig',
        type: 'tuple',
        indexed: false,
        internalType: 'struct SecurityPolicyStore.RateLimitConfig',
        components: [
          {
            name: 'outbound',
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
          {
            name: 'inbound',
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
          {
            name: 'fastFinalityOutbound',
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
          {
            name: 'fastFinalityInbound',
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
    anonymous: false,
  },
  {
    type: 'event',
    name: 'RateLimitPolicyRemoved',
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
    name: 'SecurityPolicyConfigRemoved',
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
    name: 'SecurityPolicyConfigSet',
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
        name: 'securityConfig',
        type: 'tuple',
        indexed: false,
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
          { name: 'hook', type: 'address', internalType: 'address' },
        ],
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'SecurityPolicyRemoved',
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
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'TokenRateLimitPolicySet',
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
  {
    type: 'event',
    name: 'TokenSecurityPolicySet',
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
  { type: 'error', name: 'BucketOverfilled', inputs: [] },
  { type: 'error', name: 'CannotTransferToSelf', inputs: [] },
  {
    type: 'error',
    name: 'DisabledNonZeroRateLimit',
    inputs: [
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
          { name: 'rate', type: 'uint128', internalType: 'uint128' },
        ],
      },
    ],
  },
  {
    type: 'error',
    name: 'DuplicateCCVNotAllowed',
    inputs: [{ name: 'ccvAddress', type: 'address', internalType: 'address' }],
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
    name: 'InvalidDecimalArgs',
    inputs: [
      { name: 'localToken', type: 'address', internalType: 'address' },
      { name: 'expected', type: 'uint8', internalType: 'uint8' },
      { name: 'actual', type: 'uint8', internalType: 'uint8' },
    ],
  },
  {
    type: 'error',
    name: 'InvalidInlineRateLimitBucketConfig',
    inputs: [
      { name: 'localToken', type: 'address', internalType: 'address' },
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
          { name: 'rate', type: 'uint128', internalType: 'uint128' },
        ],
      },
    ],
  },
  {
    type: 'error',
    name: 'InvalidInlineRateLimitConfig',
    inputs: [
      { name: 'localToken', type: 'address', internalType: 'address' },
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
          {
            name: 'fastFinalityOutbound',
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
          {
            name: 'fastFinalityInbound',
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
  },
  {
    type: 'error',
    name: 'InvalidRateLimitPolicyBucketConfig',
    inputs: [
      { name: 'policyName', type: 'bytes32', internalType: 'bytes32' },
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
          { name: 'rate', type: 'uint128', internalType: 'uint128' },
        ],
      },
    ],
  },
  {
    type: 'error',
    name: 'InvalidRateLimitPolicyConfig',
    inputs: [
      { name: 'policyName', type: 'bytes32', internalType: 'bytes32' },
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
          {
            name: 'fastFinalityOutbound',
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
          {
            name: 'fastFinalityInbound',
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
  },
  {
    type: 'error',
    name: 'InvalidRateLimitPolicyDecimals',
    inputs: [
      { name: 'policyName', type: 'bytes32', internalType: 'bytes32' },
      { name: 'expected', type: 'uint8', internalType: 'uint8' },
      { name: 'actual', type: 'uint8', internalType: 'uint8' },
    ],
  },
  {
    type: 'error',
    name: 'InvalidRateLimitRate',
    inputs: [
      {
        name: 'rateLimiterConfig',
        type: 'tuple',
        internalType: 'struct RateLimiter.Config',
        components: [
          { name: 'isEnabled', type: 'bool', internalType: 'bool' },
          {
            name: 'capacity',
            type: 'uint128',
            internalType: 'uint128',
          },
          { name: 'rate', type: 'uint128', internalType: 'uint128' },
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
    name: 'RateLimitRecordNotFound',
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
    name: 'SecurityRecordNotFound',
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
    name: 'TokenHasConfig',
    inputs: [{ name: 'localToken', type: 'address', internalType: 'address' }],
  },
  {
    type: 'error',
    name: 'TokenMaxCapacityExceeded',
    inputs: [
      { name: 'capacity', type: 'uint256', internalType: 'uint256' },
      { name: 'requested', type: 'uint256', internalType: 'uint256' },
      {
        name: 'tokenAddress',
        type: 'address',
        internalType: 'address',
      },
    ],
  },
  {
    type: 'error',
    name: 'TokenRateLimitReached',
    inputs: [
      {
        name: 'minWaitInSeconds',
        type: 'uint256',
        internalType: 'uint256',
      },
      { name: 'available', type: 'uint256', internalType: 'uint256' },
      {
        name: 'tokenAddress',
        type: 'address',
        internalType: 'address',
      },
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
