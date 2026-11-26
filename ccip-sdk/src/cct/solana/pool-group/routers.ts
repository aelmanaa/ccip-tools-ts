/**
 * The CCIP Router program of each Solana cluster, for checking the Router a pool `State` names.
 *
 * - `solana-devnet` and `solana-mainnet`: `Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C`, the
 *   `router` of both clusters in the CCIP Directory (documentation@2362efd3c,
 *   `src/config/data/ccip/v1_2_0/{testnet,mainnet}/chains.json`, `"version": "V1"`). The CCIP 2.0
 *   Router is the same program, upgraded in place: `ccip_router` in chainlink-ccip-solana@7558722
 *   `contracts/Anchor.toml:14`, and the Router every pool `State` and the `PoolConfig` of the
 *   pool-groups program 22P6h4QV5wswBX63KCncFGctC9dyVRMjykBBDdhwXjg7 record on Devnet (27 of 27
 *   States, read 2026-11-26).
 *
 * Other clusters have no entry; their Routers are not verified.
 *
 * @packageDocumentation
 */

import { networkInfo } from '../../../networks.ts'

const CCIP_ROUTER = 'Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C'

/** Known CCIP Router program IDs by Solana chain selector. @internal */
export const KNOWN_SOLANA_ROUTERS: ReadonlyMap<bigint, readonly string[]> = new Map([
  [networkInfo('solana-devnet').chainSelector, [CCIP_ROUTER]],
  [networkInfo('solana-mainnet').chainSelector, [CCIP_ROUTER]],
])
