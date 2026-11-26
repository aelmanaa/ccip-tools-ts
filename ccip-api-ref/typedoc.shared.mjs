/**
 * TypeDoc options shared by the docs site (`docusaurus.config.ts`, `docusaurus-plugin-typedoc`) and
 * the CCT documentation gate (`scripts/lint-docs-cct.mjs`), so both document exactly the same
 * symbols. Paths are relative to this folder.
 */
export const SDK_TYPEDOC_OPTIONS = {
  tsconfig: '../ccip-sdk/tsconfig.json',
  excludePrivate: true,
  excludeInternal: true,
  excludeExternals: true,
}

/** The SDK entry points the site documents; the gate checks the CCT ones among them. */
export const SDK_TYPEDOC_ENTRY_POINTS = [
  '../ccip-sdk/src/index.ts',
  '../ccip-sdk/src/viem.ts',
  '../ccip-sdk/src/all-chains.ts',
  '../ccip-sdk/src/cct/evm/index.ts',
  '../ccip-sdk/src/cct/solana/index.ts',
  '../ccip-sdk/src/cct/canton/index.ts',
]
