/**
 * SameAddressRemoteTokenAddressProvider: answers the local token address as the remote token on EVM chains.
 *
 * `SameAddressRemoteTokenAddressProvider 2.1.0-dev`, pinned to chainlink-ccip `c950d9bc` (the commit docs-cct-foundry builds and
 * deploys; its release-settings build is byte-identical to these gobindings). Kept unexported from
 * the package: an exported ABI literal is inlined into the published `.d.ts`.
 */
// TODO: track a chainlink-ccip release tag and a `V2_1_0` folder once multi-token pools are released
export default [
  // generate:
  // fetch('https://github.com/smartcontractkit/chainlink-ccip/raw/c950d9bcab28ec9f6d52c4e38919c81a45deb8ca/chains/evm/gobindings/generated/latest/same_address_remote_token_address_provider/same_address_remote_token_address_provider.go')
  //   .then((res) => res.text())
  //   .then((body) => body.match(/^\s*ABI: "(.*?)",$/m)?.[1])
  //   .then((abi) => JSON.parse(abi.replace(/\\"/g, '"')))
  //   .then((obj) => require('util').inspect(obj, { depth: 99, maxArrayLength: Infinity }).split('\n').slice(1, -1))
  {
    type: 'function',
    name: 'getRemoteTokenAddress',
    inputs: [
      { name: 'localToken', type: 'address', internalType: 'address' },
      { name: '', type: 'uint64', internalType: 'uint64' },
    ],
    outputs: [{ name: 'remoteToken', type: 'bytes', internalType: 'bytes' }],
    stateMutability: 'pure',
  },
  {
    type: 'function',
    name: 'typeAndVersion',
    inputs: [],
    outputs: [{ name: '', type: 'string', internalType: 'string' }],
    stateMutability: 'pure',
  },
  // generate:end
] as const
