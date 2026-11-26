/**
 * FactoryTokenWithUIDPoolDataProvider: additional pool data (a 32-byte factory UID) for factory tokens.
 *
 * `FactoryTokenWithUIDPoolDataProvider 2.1.0-dev`, pinned to chainlink-ccip `c950d9bc` (the commit docs-cct-foundry builds and
 * deploys; its release-settings build is byte-identical to these gobindings). Kept unexported from
 * the package: an exported ABI literal is inlined into the published `.d.ts`.
 */
// TODO: track a chainlink-ccip release tag and a `V2_1_0` folder once multi-token pools are released
export default [
  // generate:
  // fetch('https://github.com/smartcontractkit/chainlink-ccip/raw/c950d9bcab28ec9f6d52c4e38919c81a45deb8ca/chains/evm/gobindings/generated/latest/factory_token_with_uid_pool_data_provider/factory_token_with_uid_pool_data_provider.go')
  //   .then((res) => res.text())
  //   .then((body) => body.match(/^\s*ABI: "(.*?)",$/m)?.[1])
  //   .then((abi) => JSON.parse(abi.replace(/\\"/g, '"')))
  //   .then((obj) => require('util').inspect(obj, { depth: 99, maxArrayLength: Infinity }).split('\n').slice(1, -1))
  {
    type: 'constructor',
    inputs: [
      {
        name: 'tokenFactory',
        type: 'address',
        internalType: 'contract IResolveTokenAddressFromUID',
      },
    ],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'getAdditionalPoolData',
    inputs: [
      { name: 'localToken', type: 'address', internalType: 'address' },
      { name: '', type: 'uint64', internalType: 'uint64' },
      { name: '', type: 'bytes4', internalType: 'bytes4' },
      { name: '', type: 'bytes', internalType: 'bytes' },
    ],
    outputs: [
      {
        name: 'additionalPoolData',
        type: 'bytes',
        internalType: 'bytes',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getTokenFactory',
    inputs: [],
    outputs: [
      {
        name: 'tokenFactory',
        type: 'address',
        internalType: 'contract IResolveTokenAddressFromUID',
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'isAdditionalPoolDataValid',
    inputs: [
      { name: 'localToken', type: 'address', internalType: 'address' },
      { name: '', type: 'uint64', internalType: 'uint64' },
      { name: '', type: 'bytes4', internalType: 'bytes4' },
      {
        name: 'additionalPoolData',
        type: 'bytes',
        internalType: 'bytes',
      },
    ],
    outputs: [{ name: 'isValid', type: 'bool', internalType: 'bool' }],
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
    type: 'error',
    name: 'InvalidTokenFactory',
    inputs: [
      {
        name: 'tokenFactory',
        type: 'address',
        internalType: 'contract IResolveTokenAddressFromUID',
      },
    ],
  },
  {
    type: 'error',
    name: 'TokenNotFromFactory',
    inputs: [
      { name: 'localToken', type: 'address', internalType: 'address' },
      { name: 'uid', type: 'bytes32', internalType: 'bytes32' },
    ],
  },
  // generate:end
] as const
