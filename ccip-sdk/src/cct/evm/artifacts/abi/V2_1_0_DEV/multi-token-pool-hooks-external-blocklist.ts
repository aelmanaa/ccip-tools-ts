/**
 * MultiTokenPoolHooksExternalBlocklist: MultiTokenPoolHooks plus an external blocklist.
 *
 * `MultiTokenPoolHooksExternalBlocklist 2.1.0-dev`, pinned to chainlink-ccip `c950d9bc` (the commit docs-cct-foundry builds and
 * deploys; its release-settings build is byte-identical to these gobindings). Kept unexported from
 * the package: an exported ABI literal is inlined into the published `.d.ts`.
 */
// TODO: track a chainlink-ccip release tag and a `V2_1_0` folder once multi-token pools are released
export default [
  // generate:
  // fetch('https://github.com/smartcontractkit/chainlink-ccip/raw/c950d9bcab28ec9f6d52c4e38919c81a45deb8ca/chains/evm/gobindings/generated/latest/multi_token_pool_hooks_external_blocklist/multi_token_pool_hooks_external_blocklist.go')
  //   .then((res) => res.text())
  //   .then((body) => body.match(/^\s*ABI: "(.*?)",$/m)?.[1])
  //   .then((abi) => JSON.parse(abi.replace(/\\"/g, '"')))
  //   .then((obj) => require('util').inspect(obj, { depth: 99, maxArrayLength: Infinity }).split('\n').slice(1, -1))
  {
    type: 'constructor',
    inputs: [
      {
        name: 'allowlist',
        type: 'address[]',
        internalType: 'address[]',
      },
      {
        name: 'policyEngine',
        type: 'address',
        internalType: 'contract IPolicyEngine',
      },
      {
        name: 'blocklist',
        type: 'address',
        internalType: 'contract IAddressBlocklist',
      },
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
    name: 'applyAllowListUpdates',
    inputs: [
      { name: 'removes', type: 'address[]', internalType: 'address[]' },
      { name: 'adds', type: 'address[]', internalType: 'address[]' },
    ],
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
    name: 'checkAllowList',
    inputs: [{ name: 'sender', type: 'address', internalType: 'address' }],
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
    name: 'getAllowList',
    inputs: [],
    outputs: [
      {
        name: 'allowlist',
        type: 'address[]',
        internalType: 'address[]',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getAllowListEnabled',
    inputs: [],
    outputs: [{ name: 'allowlistEnabled', type: 'bool', internalType: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getBlocklist',
    inputs: [],
    outputs: [
      {
        name: 'blocklist',
        type: 'address',
        internalType: 'contract IAddressBlocklist',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getPolicyEngine',
    inputs: [],
    outputs: [
      {
        name: 'policyEngine',
        type: 'address',
        internalType: 'contract IPolicyEngine',
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
    name: 'postflightCheck',
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
      { name: 'localAmount', type: 'uint256', internalType: 'uint256' },
      {
        name: 'requestedFinalityConfig',
        type: 'bytes4',
        internalType: 'bytes4',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'preflightCheck',
    inputs: [
      {
        name: 'lockOrBurnIn',
        type: 'tuple',
        internalType: 'struct Pool.LockOrBurnInV1',
        components: [
          { name: 'receiver', type: 'bytes', internalType: 'bytes' },
          {
            name: 'remoteChainSelector',
            type: 'uint64',
            internalType: 'uint64',
          },
          {
            name: 'originalSender',
            type: 'address',
            internalType: 'address',
          },
          { name: 'amount', type: 'uint256', internalType: 'uint256' },
          {
            name: 'localToken',
            type: 'address',
            internalType: 'address',
          },
        ],
      },
      {
        name: 'requestedFinalityConfig',
        type: 'bytes4',
        internalType: 'bytes4',
      },
      { name: 'tokenArgs', type: 'bytes', internalType: 'bytes' },
      {
        name: 'amountPostFee',
        type: 'uint256',
        internalType: 'uint256',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'setBlocklist',
    inputs: [
      {
        name: 'newBlocklist',
        type: 'address',
        internalType: 'contract IAddressBlocklist',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'setPolicyEngine',
    inputs: [
      {
        name: 'newPolicyEngine',
        type: 'address',
        internalType: 'contract IPolicyEngine',
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'setPolicyEngineAllowFailedDetach',
    inputs: [
      {
        name: 'newPolicyEngine',
        type: 'address',
        internalType: 'contract IPolicyEngine',
      },
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
    name: 'AllowListAdd',
    inputs: [
      {
        name: 'sender',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'AllowListRemove',
    inputs: [
      {
        name: 'sender',
        type: 'address',
        indexed: false,
        internalType: 'address',
      },
    ],
    anonymous: false,
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
    name: 'BlocklistSet',
    inputs: [
      {
        name: 'oldBlocklist',
        type: 'address',
        indexed: true,
        internalType: 'contract IAddressBlocklist',
      },
      {
        name: 'newBlocklist',
        type: 'address',
        indexed: true,
        internalType: 'contract IAddressBlocklist',
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
    name: 'PolicyEngineAttached',
    inputs: [
      {
        name: 'policyEngine',
        type: 'address',
        indexed: true,
        internalType: 'contract IPolicyEngine',
      },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'PolicyEngineDetachFailed',
    inputs: [
      {
        name: 'policyEngine',
        type: 'address',
        indexed: true,
        internalType: 'contract IPolicyEngine',
      },
    ],
    anonymous: false,
  },
  { type: 'error', name: 'AllowListNotEnabled', inputs: [] },
  { type: 'error', name: 'CannotTransferToSelf', inputs: [] },
  {
    type: 'error',
    name: 'InvalidBlocklist',
    inputs: [
      {
        name: 'blocklist',
        type: 'address',
        internalType: 'contract IAddressBlocklist',
      },
    ],
  },
  {
    type: 'error',
    name: 'LocalAddressBlocked',
    inputs: [
      {
        name: 'blocklist',
        type: 'address',
        internalType: 'contract IAddressBlocklist',
      },
      { name: 'account', type: 'address', internalType: 'address' },
    ],
  },
  { type: 'error', name: 'MustBeProposedOwner', inputs: [] },
  { type: 'error', name: 'OnlyCallableByOwner', inputs: [] },
  { type: 'error', name: 'OwnerCannotBeZero', inputs: [] },
  {
    type: 'error',
    name: 'PolicyEngineDetachReverted',
    inputs: [
      {
        name: 'oldPolicyEngine',
        type: 'address',
        internalType: 'contract IPolicyEngine',
      },
    ],
  },
  {
    type: 'error',
    name: 'RemoteAddressBlocked',
    inputs: [
      {
        name: 'blocklist',
        type: 'address',
        internalType: 'contract IAddressBlocklist',
      },
      { name: 'account', type: 'bytes', internalType: 'bytes' },
    ],
  },
  {
    type: 'error',
    name: 'SenderNotAllowed',
    inputs: [{ name: 'sender', type: 'address', internalType: 'address' }],
  },
  {
    type: 'error',
    name: 'UnauthorizedCaller',
    inputs: [{ name: 'caller', type: 'address', internalType: 'address' }],
  },
  { type: 'error', name: 'ZeroAddressNotAllowed', inputs: [] },
  // generate:end
] as const
