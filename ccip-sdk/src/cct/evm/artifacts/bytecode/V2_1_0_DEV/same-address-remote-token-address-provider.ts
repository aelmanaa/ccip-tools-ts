/**
 * SameAddressRemoteTokenAddressProvider creation bytecode, `2.1.0-dev`: pinned to chainlink-ccip `c950d9bc` (its gobindings, the
 * build the E1a ABIs are pinned to) until contracts-ccip ships multi-token pools. The generator
 * refuses a source whose bytecode does not hash to `sha256` below; a unit test refuses a file that
 * does not.
 *
 * sha256: 9620b7432b181473d7ab2e1ebfedc3045911a802aaad556ae36ac0badde9c1d6
 */
// TODO: read `@chainlink/contracts-ccip/bytecode/<release>/same_address_remote_token_address_provider.bin` once released
export default // generate:
// fetch('https://github.com/smartcontractkit/chainlink-ccip/raw/c950d9bcab28ec9f6d52c4e38919c81a45deb8ca/chains/evm/gobindings/generated/latest/same_address_remote_token_address_provider/same_address_remote_token_address_provider.go')
//   .then((res) => res.text())
//   .then((body) => body.match(/^\s*Bin: "(0x[0-9a-f]+)",$/m)?.[1])
//   .then((bin) => {
//     const sha = require('node:crypto').createHash('sha256').update(bin ?? '').digest('hex')
//     if (sha !== '9620b7432b181473d7ab2e1ebfedc3045911a802aaad556ae36ac0badde9c1d6') throw new Error(`same_address_remote_token_address_provider bytecode sha256 ${sha} is not the pinned one`)
//     return `'${bin}' as const`
//   })
'0x60808060405234601557610226908161001b8239f35b600080fdfe608080604052600436101561001357600080fd5b60003560e01c90816309bebd6214610122575063181f5a771461003557600080fd5b3461011d5760007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261011d57604051606081019080821067ffffffffffffffff8311176100ee576100ea91604052602f81527f53616d654164647265737352656d6f7465546f6b656e4164647265737350726f60208201527f766964657220322e312e302d646576000000000000000000000000000000000060408201526040519182916020835260208301906101ba565b0390f35b7f4e487b7100000000000000000000000000000000000000000000000000000000600052604160045260246000fd5b600080fd5b3461011d5760407ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261011d5760043573ffffffffffffffffffffffffffffffffffffffff811680910361011d5760243567ffffffffffffffff81160361011d57602082015260208152604081019080821067ffffffffffffffff8311176100ee576040829052602080835282916100ea918301905b919082519283825260005b8481106102045750507fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe0601f8460006020809697860101520116010190565b806020809284010151828286010152016101c556fea164736f6c634300081a000a' as const
// generate:end
