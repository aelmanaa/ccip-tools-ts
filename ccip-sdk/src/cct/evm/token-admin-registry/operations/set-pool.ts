/**
 * setPool — registers a pool for a token in the TokenAdminRegistry.
 * Version-independent (v1.5–v2.0 share one encoding).
 *
 * @remarks For a pool that does not answer `typeAndVersion` as a multi-token pool (a custom pool, any
 * other pool, the zero address), behavior is unchanged. For a multi-token pool, every lane its PCM has
 * for the token goes live through it: each runs the lane check (`checkMultiTokenPoolLane`, no
 * attestations). `checkLanes: 'fund-loss'` (the default) refuses only the findings that lose funds
 * (`POOL_DATA_FORMAT_MISMATCH`, `REMOTE_TOKEN_ENCODING`, `REMOTE_TOKEN_SHARED`, `NO_REMOTE_POOL`) and
 * returns the rest in `warnings`; `'all'` refuses every error finding. A lane paused outbound is not
 * made live outbound, so its outbound rules wait for the unpause check. A long-data lane not paused
 * outbound must have its remote read (`getChain`), since its format decides whether a send mints;
 * a legacy lane builds without it. `requireOutboundPause` also requires the token served by the pool
 * and paused outbound.
 *
 * @packageDocumentation
 */

import { ZeroAddress, getAddress } from 'ethers'

import type { ChainGetter } from '../../../../chain.ts'
import type { EVMChain } from '../../../../evm/index.ts'
import type { UnsignedEVMTx } from '../../../../evm/types.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import type { MultiTokenPoolLaneFinding, MultiTokenPoolLaneKey } from '../../../multi-token-pool.ts'
import { latestBlock } from '../../mined-block.ts'
import { reportsMultiTokenPool, resolveMultiTokenPool } from '../../multi-token-pool/contracts.ts'
import { EVMOperation, callTx } from '../../operation.ts'
import { resolvePoolConfigManagerTarget } from '../../pool-config-manager/contracts.ts'
import { CheckMultiTokenPoolLane } from '../../pool-config-manager/operations/check-multi-token-pool-lane.ts'
import {
  multiTokenPoolSupportedChains,
  tokenRecordsOf,
} from '../../pool-config-manager/projection.ts'
import { readMultiTokenPoolRecordState } from '../../pool-config-manager/record-state.ts'
import { readContractTypeOrNull } from '../../query.ts'
import { validateAddress, validateBoolean, validateOneOf } from '../../validate.ts'
import { getTokenAdminRegistryInterface } from '../contracts.ts'

/** Parameters for `setPool`. Zero `poolAddress` delists the token. */
export type SetPoolParams = {
  tokenAddress: string
  /** The zero address as `poolAddress` delists the token from the registry. */
  poolAddress: string
  /**
   * Contract to resolve the TokenAdminRegistry from. Pass the registry itself for a
   * direct lookup; a Router, OnRamp, OffRamp, or TokenPool also work but add hops and
   * need a configured lane.
   */
  address: string
  sender?: string
  /**
   * Multi-token pools only: which lane-check findings refuse the switch. `'fund-loss'` (default):
   * only those that lose funds; `'all'`: every error finding (the planners set it).
   */
  checkLanes?: 'fund-loss' | 'all'
  /** Multi-token pools only: also require the token served by the pool and paused outbound. */
  requireOutboundPause?: boolean
  /** Multi-token pools only: resolves the remote chains the lane check reads. */
  getChain?: ChainGetter
}

/** Unsigned `setPool`; for a multi-token pool, the lanes it makes live and the non-refused findings. */
export type SetPoolUnsignedTx = UnsignedEVMTx & {
  /** Multi-token pools only: the lanes the switch makes live. */
  affectedLanes?: MultiTokenPoolLaneKey[]
  /** Multi-token pools only: the lane-check findings `checkLanes` does not refuse. */
  warnings?: MultiTokenPoolLaneFinding[]
}

/** The findings that lose funds: a burn on this side with no mint on the other. */
const FUND_LOSS: ReadonlySet<MultiTokenPoolLaneFinding['check']> = new Set([
  'POOL_DATA_FORMAT_MISMATCH',
  'REMOTE_TOKEN_ENCODING',
  'REMOTE_TOKEN_SHARED',
  'NO_REMOTE_POOL',
])
/** The fund-loss rules of the send side, deferred while the lane is paused outbound. */
const OUTBOUND_RULES: ReadonlySet<MultiTokenPoolLaneFinding['check']> = new Set([
  'POOL_DATA_FORMAT_MISMATCH',
  'REMOTE_TOKEN_ENCODING',
])

/** Registers a pool for a token in the TokenAdminRegistry resolved from `address`. */
export class SetPool extends EVMOperation<SetPoolParams, SetPoolParams, SetPoolUnsignedTx> {
  readonly name = 'setPool'
  readonly #laneCheck = new CheckMultiTokenPoolLane()

  /** Validates all addresses before any RPC. */
  protected override prepare(p: SetPoolParams): SetPoolParams {
    validateAddress(this.name, 'tokenAddress', p.tokenAddress)
    validateAddress(this.name, 'poolAddress', p.poolAddress)
    validateAddress(this.name, 'address', p.address)
    if (p.checkLanes !== undefined)
      validateOneOf(this.name, 'checkLanes', p.checkLanes, ['fund-loss', 'all'] as const)
    if (p.requireOutboundPause !== undefined)
      validateBoolean(this.name, 'requireOutboundPause', p.requireOutboundPause)
    return p
  }

  /** Builds `setPool` calldata against the TokenAdminRegistry resolved from `address`. */
  protected async buildUnsigned(chain: EVMChain, p: SetPoolParams): Promise<SetPoolUnsignedTx> {
    const to = await chain.getTokenAdminRegistryFor(p.address)
    // TAR.setPool encoding is version-stable across v1.5–v2.0; no version dispatch needed.
    const data = getTokenAdminRegistryInterface().encodeFunctionData('setPool', [
      p.tokenAddress,
      p.poolAddress,
    ])
    const unsigned = callTx(to, data)
    // the probe: anything that does not report a multi-token pool builds as it always did
    const pool = getAddress(p.poolAddress)
    const type = pool === ZeroAddress ? null : await readContractTypeOrNull(chain, pool)
    if (type === null || !reportsMultiTokenPool(type)) {
      if (p.requireOutboundPause)
        throw new CCTParamsInvalidError(
          this.name,
          'requireOutboundPause',
          `applies to multi-token pools only, and ${pool} is not one`,
        )
      return unsigned
    }
    return { ...unsigned, ...(await this.#checkMultiTokenPool(chain, p, pool)) }
  }

  /**
   * The lanes a switch to a multi-token pool makes live, each checked; refused per `checkLanes`.
   * @throws {@link CCTParamsInvalidError} if a lane has a refused finding, or `requireOutboundPause`
   *   is set and the token is not served or not paused outbound
   */
  async #checkMultiTokenPool(
    chain: EVMChain,
    p: SetPoolParams,
    pool: string,
  ): Promise<Required<Pick<SetPoolUnsignedTx, 'affectedLanes' | 'warnings'>>> {
    await resolveMultiTokenPool(chain, pool)
    const pcm = await resolvePoolConfigManagerTarget(chain, { poolAddress: pool })
    const token = getAddress(p.tokenAddress)
    const { state } = await readMultiTokenPoolRecordState(chain, pcm.address, pcm.version, {
      blockTag: await latestBlock(chain),
      tokenAddresses: [token],
    })
    const records = tokenRecordsOf(state, token)
    if (p.requireOutboundPause) {
      if (!records?.profile?.isRegistered)
        throw new CCTParamsInvalidError(
          this.name,
          'requireOutboundPause',
          `${token} is not served by ${pool} (not registered on its PoolConfigManager): register it first`,
        )
      if (!records.isOutboundPaused)
        throw new CCTParamsInvalidError(
          this.name,
          'requireOutboundPause',
          `${token} is not paused outbound on ${pool}: pause it (pauseMultiTokenPoolTokens) before the switch`,
        )
    }
    const lanes = multiTokenPoolSupportedChains(state, token).map((remoteChainSelector) => ({
      tokenAddress: token,
      remoteChainSelector,
    }))
    const refused: MultiTokenPoolLaneFinding[] = []
    const warnings: MultiTokenPoolLaneFinding[] = []
    for (const lane of lanes) {
      const { lane: read, findings } = await this.#laneCheck.checkWith(
        chain,
        { ...lane, poolAddress: pool, ...(p.getChain && { getChain: p.getChain }) },
        pool,
        pcm,
      )
      const outboundPaused = read.outboundStatus.status === 'paused'
      for (const f of findings) {
        const deferred = outboundPaused && OUTBOUND_RULES.has(f.check)
        // a long-data lane that sends needs its remote read: its format decides whether it mints
        const unread =
          f.check === 'REMOTE_UNREADABLE' && read.poolDataFormat === 'long' && !outboundPaused
        const refuses =
          f.severity === 'error' &&
          !deferred &&
          (p.checkLanes === 'all' || FUND_LOSS.has(f.check) || unread)
        ;(refuses ? refused : warnings).push(f)
      }
    }
    if (refused.length)
      throw new CCTParamsInvalidError(
        this.name,
        'poolAddress',
        `${pool} would make ${lanes.length} lane(s) of ${token} live with ${refused.length} problem(s): ${refused
          .map((f) => `${f.check} → ${f.remoteChainSelector}: ${f.reason}`)
          .join('; ')}`,
        { context: { findings: refused } },
      )
    return { affectedLanes: lanes, warnings }
  }
}
