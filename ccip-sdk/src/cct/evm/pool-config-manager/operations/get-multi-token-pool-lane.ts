/**
 * getMultiTokenPoolLane — the family-neutral view of one token's lane, read at one block.
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

import type { LaneRecordType } from '../../../../chain.ts'
import { type EVMChain, toRateLimiterState } from '../../../../evm/index.ts'
import { LANE_RECORD_TYPES, toMultiTokenLaneStatus } from '../../../../evm/multi-token-pool.ts'
import { resultToObject } from '../../../../evm/types.ts'
import { ChainFamily } from '../../../../networks.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import {
  type MultiTokenPoolConfigSource,
  type MultiTokenPoolLane,
  type MultiTokenPoolLaneParams,
  isStop,
} from '../../../multi-token-pool.ts'
import {
  type MultiTokenPoolVersion,
  poolConfigManagerContract,
} from '../../multi-token-pool/contracts.ts'
import { EVMQuery } from '../../query.ts'
import { validateAddress, validateNonZeroAddress, validateUint64 } from '../../validate.ts'
import {
  type MultiTokenPoolLaneKey,
  type PolicyName,
  resolvePoolConfigManagerTarget,
} from '../contracts.ts'
import { decodeTokenPolicies } from '../decode.ts'
import { GetMultiTokenPoolLaneConnections } from './get-multi-token-pool-lane-connections.ts'
import { GetMultiTokenPoolLaneRateLimiterStates } from './get-multi-token-pool-lane-rate-limiter-states.ts'
import {
  type MultiTokenPoolRecordLevel,
  GetMultiTokenPoolLaneRecordLevels,
} from './get-multi-token-pool-lane-record-levels.ts'
import { GetMultiTokenPoolLaneTokenTransferFeeConfigs } from './get-multi-token-pool-lane-token-transfer-fee-configs.ts'
import { GetMultiTokenPoolLaneVerifications } from './get-multi-token-pool-lane-verifications.ts'

/** Where a record type resolves from, in the family-neutral terms. */
function sourceOf(
  level: MultiTokenPoolRecordLevel,
  policy: PolicyName | null,
): MultiTokenPoolConfigSource {
  switch (level) {
    case 'inline':
      return { kind: 'inline' }
    case 'policy-chain':
      return { kind: 'policy', policy: { name: policy! } }
    case 'policy-default':
      return { kind: 'default', policy: { name: policy! } }
    case 'none':
      return { kind: 'none' }
  }
}

/** An enabled bucket with no capacity and no rate holds the direction (a stop). */

/**
 * Resolves the multi-token pool of a lane read: `poolAddress`, or `TAR.getPool(token)` through
 * `registryAddress` (a TAR, or a Router/OnRamp/OffRamp to resolve it from).
 * @internal
 */
export async function resolveLanePool(
  operation: string,
  chain: EVMChain,
  { poolAddress, registryAddress, tokenAddress }: MultiTokenPoolLaneParams,
): Promise<string> {
  if (poolAddress !== undefined) return getAddress(poolAddress)
  const registry = await chain.getTokenAdminRegistryFor(registryAddress!)
  const { tokenPool } = await chain.getRegistryTokenConfig(registry, tokenAddress)
  if (!tokenPool)
    throw new CCTParamsInvalidError(
      operation,
      'registryAddress',
      `the registry names no pool for ${tokenAddress}: pass poolAddress`,
    )
  return getAddress(tokenPool)
}

/**
 * Validates the shared lane params: the token, the selector, and `poolAddress` or `registryAddress`.
 * @internal
 */
export function validateLaneParams(operation: string, params: MultiTokenPoolLaneParams): void {
  validateAddress(operation, 'tokenAddress', params.tokenAddress)
  validateUint64(operation, 'remoteChainSelector', params.remoteChainSelector)
  if (params.poolAddress !== undefined)
    validateNonZeroAddress(operation, 'poolAddress', params.poolAddress)
  else if (params.registryAddress !== undefined)
    validateNonZeroAddress(operation, 'registryAddress', params.registryAddress)
  else
    throw new CCTParamsInvalidError(
      operation,
      'poolAddress',
      'pass poolAddress, or registryAddress to resolve the pool from the registry',
    )
}

/** The lane batch reads one lane view is built from. @internal */
export type LaneViewReads = {
  connections: GetMultiTokenPoolLaneConnections
  levels: GetMultiTokenPoolLaneRecordLevels
  fees: GetMultiTokenPoolLaneTokenTransferFeeConfigs
  buckets: GetMultiTokenPoolLaneRateLimiterStates
  verifications: GetMultiTokenPoolLaneVerifications
}

/** Fresh lane batch reads, for a caller without its own. @internal */
export function laneViewReads(): LaneViewReads {
  return {
    connections: new GetMultiTokenPoolLaneConnections(),
    levels: new GetMultiTokenPoolLaneRecordLevels(),
    fees: new GetMultiTokenPoolLaneTokenTransferFeeConfigs(),
    buckets: new GetMultiTokenPoolLaneRateLimiterStates(),
    verifications: new GetMultiTokenPoolLaneVerifications(),
  }
}

/**
 * Reads the family-neutral view of one lane of a resolved PCM, every view at `blockTag`.
 * @internal
 */
export async function readMultiTokenPoolLane(
  chain: EVMChain,
  { address, version }: { address: string; version: MultiTokenPoolVersion },
  key: MultiTokenPoolLaneKey,
  blockTag: number,
  ops: LaneViewReads = laneViewReads(),
): Promise<MultiTokenPoolLane> {
  const tokenAddress = getAddress(key.tokenAddress)
  const lane = { tokenAddress, remoteChainSelector: key.remoteChainSelector }
  const at = { poolConfigManager: address, lanes: [lane], blockTag }
  const [[connection], [levels], [fee], [buckets], [verification], [config]] = await Promise.all([
    ops.connections.query(chain, at),
    ops.levels.query(chain, at),
    ops.fees.query(chain, at),
    ops.buckets.query(chain, at),
    ops.verifications.query(chain, at),
    poolConfigManagerContract(chain, address, version).getTokenConfigBatch([tokenAddress], {
      blockTag,
    }),
  ])
  const policies = decodeTokenPolicies(resultToObject(config!))
  const sources = Object.fromEntries(
    LANE_RECORD_TYPES.map((t) => [t, sourceOf(levels!.levels[t], policies[t])]),
  ) as Record<LaneRecordType, MultiTokenPoolConfigSource>
  const present = LANE_RECORD_TYPES.map((t) => (levels!.levels[t] === 'none' ? 0n : 1n))
  const b = buckets!
  return {
    family: ChainFamily.EVM,
    tokenAddress,
    remoteChainSelector: key.remoteChainSelector,
    exists: connection!.hasConnection || present.some(Boolean),
    remoteToken: connection!.remoteToken,
    remotePools: connection!.remotePools,
    poolDataFormat: connection!.poolDataFormat,
    sources,
    rateLimits: {
      outbound: toRateLimiterState(b.outbound),
      inbound: toRateLimiterState(b.inbound),
      ...(b.fastFinalityOutbound.isEnabled && {
        fastFinalityOutbound: toRateLimiterState(b.fastFinalityOutbound),
      }),
      ...(b.fastFinalityInbound.isEnabled && {
        fastFinalityInbound: toRateLimiterState(b.fastFinalityInbound),
      }),
    },
    stopped: { outbound: isStop(b.outbound), inbound: isStop(b.inbound) },
    ...(fee!.isEnabled && {
      tokenTransferFeeConfig: (({ tokenAddress: _t, remoteChainSelector: _c, ...f }) => f)(fee!),
    }),
    ccvs: { outbound: verification!.outboundCCVs, inbound: verification!.inboundCCVs },
    hasHooks: verification!.hook !== null,
    outboundStatus: toMultiTokenLaneStatus(connection!, present, 'outbound'),
    inboundStatus: toMultiTokenLaneStatus(connection!, present, 'inbound'),
  }
}

/**
 * Reads the family-neutral view of one lane, every view at one block.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), or the registry names
 *   no pool for the token
 * @throws {@link CCTContractTypeInvalidError} if the pool is not a multi-token pool
 * @throws {@link CCTContractVersionUnsupportedError} if a version is unknown
 */
export class GetMultiTokenPoolLane extends EVMQuery<MultiTokenPoolLaneParams, MultiTokenPoolLane> {
  readonly name = 'getMultiTokenPoolLane'
  readonly #reads = laneViewReads()

  protected prepare(params: MultiTokenPoolLaneParams): MultiTokenPoolLaneParams {
    validateLaneParams(this.name, params)
    return params
  }

  protected async read(
    chain: EVMChain,
    params: MultiTokenPoolLaneParams,
  ): Promise<MultiTokenPoolLane> {
    const poolAddress = await resolveLanePool(this.name, chain, params)
    const pcm = await resolvePoolConfigManagerTarget(chain, { poolAddress })
    return readMultiTokenPoolLane(
      chain,
      pcm,
      params,
      await chain.provider.getBlockNumber(),
      this.#reads,
    )
  }
}
