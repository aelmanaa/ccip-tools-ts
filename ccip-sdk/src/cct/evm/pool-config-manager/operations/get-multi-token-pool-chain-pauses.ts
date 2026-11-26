/**
 * getMultiTokenPoolChainPauses — the PCM-wide and per-chain pauses, discovered from the connection
 * store's logs and confirmed with a lane read.
 *
 * @packageDocumentation
 */

import { ZeroAddress } from 'ethers'

import type { EVMChain } from '../../../../evm/index.ts'
import { resultToObject } from '../../../../evm/types.ts'
import {
  getMultiTokenPoolInterface,
  poolConfigManagerContract,
} from '../../multi-token-pool/contracts.ts'
import { EVMQuery } from '../../query.ts'
import {
  type LogScanParams,
  type PoolConfigManagerTarget,
  assertResultCount,
  readLaneBatches,
  readPoolConfigManagerStaticConfig,
  resolvePoolConfigManagerTarget,
  scanLogs,
  toAbiLaneKey,
  validateLogScanParams,
  validatePoolConfigManagerTarget,
} from '../contracts.ts'

/**
 * Parameters for `getMultiTokenPoolChainPauses`. Discovery only: `ChainPauseSet`/`GlobalPauseSet` are
 * emitted by the ConnectionPolicyStore (not the PCM), only on change; each found chain's state is then
 * read through `getLaneConnectionBatch` with any lane key (an unregistered token works).
 */
export type GetMultiTokenPoolChainPausesParams = PoolConfigManagerTarget & LogScanParams
/** Result of `getMultiTokenPoolChainPauses`. */
export type GetMultiTokenPoolChainPausesResult = {
  /** Whether the PCM-wide pause is set now. */
  global: boolean
  /** Every chain whose pause was ever set in the range, with its current flags. */
  chains: {
    /** CCIP selector of the remote chain. */
    remoteChainSelector: bigint
    /** Outbound to that chain is paused now. */
    outbound: boolean
    /** Inbound from that chain is paused now. */
    inbound: boolean
  }[]
  /** The block range scanned. */
  scanned: {
    /** First block. */
    fromBlock: number
    /** Last block. */
    toBlock: number
  }
  /**
   * `true` only when the scan provably starts at or before the store's deployment block: `fromBlock`
   * is `0`, or the deployment block was found from historical code (an archive RPC).
   */
  complete: boolean
}

/**
 * Lists the global and chain pauses.
 * @remarks A chain pause set on a chain with no record anywhere is visible only this way.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), or `fromBlock` is
 * omitted and the RPC cannot find the deployment block
 * @throws {@link CCTContractTypeInvalidError} if the target is not a PCM, or `poolAddress` is not
 * a multi-token pool
 */
export class GetMultiTokenPoolChainPauses extends EVMQuery<
  GetMultiTokenPoolChainPausesParams,
  GetMultiTokenPoolChainPausesResult
> {
  readonly name = 'getMultiTokenPoolChainPauses'

  protected prepare(
    params: GetMultiTokenPoolChainPausesParams,
  ): GetMultiTokenPoolChainPausesParams {
    validatePoolConfigManagerTarget(this.name, params)
    validateLogScanParams(this.name, params)
    return params
  }

  protected async read(
    chain: EVMChain,
    params: GetMultiTokenPoolChainPausesParams,
  ): Promise<GetMultiTokenPoolChainPausesResult> {
    const { address, version } = await resolvePoolConfigManagerTarget(chain, params)
    const { connectionPolicyStore } = await readPoolConfigManagerStaticConfig(
      chain,
      address,
      version,
    )
    // the pause events are the connection store's, not the PCM's
    const { logs, scanned, complete } = await scanLogs(chain, {
      operation: this.name,
      contract: 'ConnectionPolicyStore',
      address: connectionPolicyStore,
      iface: getMultiTokenPoolInterface('ConnectionPolicyStore', version),
      events: ['ChainPauseSet'],
      range: params,
    })
    const selectors = [...new Set(logs.map((log) => BigInt(log.args[0])))]

    // the global flag is in every lane read; one with selector 0 answers it when no chain was found
    const lanes = (selectors.length ? selectors : [0n]).map((remoteChainSelector) => ({
      tokenAddress: ZeroAddress,
      remoteChainSelector,
    }))
    const pcm = poolConfigManagerContract(chain, address, version)
    const connections = await readLaneBatches(lanes, async (chunk) => {
      const read = (
        await pcm.getLaneConnectionBatch(chunk.map(toAbiLaneKey), { blockTag: scanned.toBlock })
      ).map((c) => resultToObject(c))
      assertResultCount(address, 'getLaneConnectionBatch', read, chunk.length)
      return read
    })
    return {
      global: connections.some((c) => c.isGloballyPaused),
      chains: selectors.length
        ? lanes.map((l, i) => ({
            remoteChainSelector: l.remoteChainSelector,
            outbound: connections[i]!.isChainOutboundPaused,
            inbound: connections[i]!.isChainInboundPaused,
          }))
        : [],
      scanned,
      complete,
    }
  }
}
