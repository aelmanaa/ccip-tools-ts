/**
 * checkMultiTokenPoolLane — the lane check: the post-state rules on the current state, plus the
 * token's registration, pauses and stops, the pool's mint and burn roles, and the remote inbound
 * limit against the remote outbound one.
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

import type { EVMChain } from '../../../../evm/index.ts'
import { LOCK_OR_BURN_FLAVORS, decodeTokenProfileFields } from '../../../../evm/multi-token-pool.ts'
import { resultToObject } from '../../../../evm/types.ts'
import { CCTContractTypeInvalidError, CCTContractVersionUnsupportedError } from '../../../errors.ts'
import {
  type CheckMultiTokenPoolLaneParams,
  type MultiTokenPoolFact,
  type MultiTokenPoolLaneCheckResult,
  type MultiTokenPoolLaneFinding,
  sortFindings,
} from '../../../multi-token-pool.ts'
import { poolConfigManagerContract } from '../../multi-token-pool/contracts.ts'
import { EVMQuery } from '../../query.ts'
import { IsBurner } from '../../token/operations/is-burner.ts'
import { IsMinter } from '../../token/operations/is-minter.ts'
import { validateArray, validateOneOf, validateUint32 } from '../../validate.ts'
import { readPoolConfigManagerStaticConfig, resolvePoolConfigManagerTarget } from '../contracts.ts'
import { readMultiTokenPoolGuardFacts } from '../guard-facts.ts'
import {
  evaluateMultiTokenPoolGuards,
  guardLaneKey,
  multiTokenPoolChainLanes,
  requiredMultiTokenPoolGuardFacts,
} from '../guards.ts'
import { resolveMultiTokenPoolLanes } from '../projection.ts'
import { readMultiTokenPoolRecordState } from '../record-state.ts'
import {
  laneViewReads,
  readMultiTokenPoolLane,
  resolveLanePool,
  validateLaneParams,
} from './get-multi-token-pool-lane.ts'

const DIRECTIONS = ['outbound', 'inbound'] as const

/**
 * Runs the lane check on one lane, locally and on the remote side.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC)
 * @throws {@link CCTContractTypeInvalidError} if the pool is not a multi-token pool
 */
export class CheckMultiTokenPoolLane extends EVMQuery<
  CheckMultiTokenPoolLaneParams,
  MultiTokenPoolLaneCheckResult
> {
  readonly name = 'checkMultiTokenPoolLane'
  readonly #reads = laneViewReads()
  readonly #isMinter = new IsMinter()
  readonly #isBurner = new IsBurner()

  protected prepare(params: CheckMultiTokenPoolLaneParams): CheckMultiTokenPoolLaneParams {
    validateLaneParams(this.name, params)
    if (params.expectOpen !== undefined) {
      validateArray(this.name, 'expectOpen', params.expectOpen)
      Array.from(params.expectOpen, (d, i) =>
        validateOneOf(this.name, `expectOpen[${i}]`, d, DIRECTIONS),
      )
    }
    if (params.minDestGasOverhead !== undefined)
      validateUint32(this.name, 'minDestGasOverhead', params.minDestGasOverhead)
    if (params.maxTransferFeeBps !== undefined)
      validateUint32(this.name, 'maxTransferFeeBps', params.maxTransferFeeBps)
    return params
  }

  protected async read(
    chain: EVMChain,
    params: CheckMultiTokenPoolLaneParams,
  ): Promise<MultiTokenPoolLaneCheckResult> {
    const poolAddress = await resolveLanePool(this.name, chain, params)
    const pcm = await resolvePoolConfigManagerTarget(chain, { poolAddress })
    const blockTag = await chain.provider.getBlockNumber()
    const key = {
      tokenAddress: getAddress(params.tokenAddress),
      remoteChainSelector: params.remoteChainSelector,
    }
    const [lane, { state }, { tokenAdminRegistry }, [config]] = await Promise.all([
      readMultiTokenPoolLane(chain, pcm, key, blockTag, this.#reads),
      readMultiTokenPoolRecordState(chain, pcm.address, pcm.version, {
        blockTag,
        extraChains: [key.remoteChainSelector],
      }),
      readPoolConfigManagerStaticConfig(chain, pcm.address, pcm.version),
      poolConfigManagerContract(chain, pcm.address, pcm.version).getTokenConfigBatch(
        [key.tokenAddress],
        { blockTag },
      ),
    ])
    const findings: MultiTokenPoolLaneFinding[] = []
    const add = (
      check: MultiTokenPoolLaneFinding['check'],
      severity: MultiTokenPoolLaneFinding['severity'],
      reason: string,
    ) => findings.push({ check, severity, ...key, reason })

    const token = resultToObject(config!)
    if (!token.isRegistered)
      add(
        'TOKEN_NOT_REGISTERED',
        'error',
        `the PoolConfigManager does not register ${key.tokenAddress}`,
      )

    // the post-state rules, on the lane as it is
    const [projected] = resolveMultiTokenPoolLanes(state, [key])
    let remote: MultiTokenPoolFact = 'unknown'
    if (!projected!.connection.hasConnection)
      add(
        'NO_CONNECTION',
        'error',
        'no connection resolves for this token and chain: the lane does not exist',
      )
    else {
      const facts = await readMultiTokenPoolGuardFacts({
        chain,
        poolConfigManager: pcm.address,
        version: pcm.version,
        tokenAdminRegistry,
        blockTag,
        poolAddress,
        requests: requiredMultiTokenPoolGuardFacts([projected!]),
        ...(params.getChain && { getChain: params.getChain }),
        ...(params.remoteAttestations && { remoteAttestations: params.remoteAttestations }),
        now: BigInt(Math.floor(Date.now() / 1000)),
        readRemoteRateLimits: true,
      })
      const evaluated = evaluateMultiTokenPoolGuards({
        after: state,
        lanes: [{ before: projected!, after: projected! }],
        chainLanes: multiTokenPoolChainLanes(state, [key.remoteChainSelector]),
        facts,
        options: {
          ...(params.minDestGasOverhead !== undefined && {
            minDestGasOverhead: params.minDestGasOverhead,
          }),
          ...(params.maxTransferFeeBps !== undefined && {
            maxTransferFeeBps: params.maxTransferFeeBps,
          }),
        },
      })
      findings.push(...evaluated.findings)
      // fail closed: a fact that could not be read is an error finding, never a pass
      for (const f of evaluated.factFailures)
        add(
          'REMOTE_UNREADABLE',
          'error',
          f.scope === 'remote'
            ? `the remote side could not be checked (${f.reason}): pass getChain for ${key.remoteChainSelector}, or a remoteAttestations entry where the family has no reader`
            : `a local fact could not be read: ${f.reason}`,
        )
      const read = facts.remoteLanes.get(guardLaneKey(key))
      remote =
        evaluated.factFailures.find((f) => f.scope === 'remote')?.status ??
        read?.status ??
        'unknown'
      // a remote burst the local inbound cannot absorb waits here until the bucket refills; the
      // remote limit is in remote token units, so compare in local units
      const local = lane.rateLimits.inbound
      const theirs = read?.status === 'known' ? read.remoteOutbound : undefined
      const remoteDecimals = read?.status === 'known' ? read.remoteDecimals : undefined
      if (local && theirs && remoteDecimals !== undefined) {
        const localDecimals = decodeTokenProfileFields(token).localDecimals
        const toLocal = (amount: bigint) =>
          localDecimals >= remoteDecimals
            ? amount * BigInt(10) ** BigInt(localDecimals - remoteDecimals)
            : amount / BigInt(10) ** BigInt(remoteDecimals - localDecimals)
        const [capacity, rate] = [toLocal(theirs.capacity), toLocal(theirs.rate)]
        if (local.capacity < capacity || local.rate < rate)
          add(
            'INBOUND_BELOW_REMOTE_OUTBOUND',
            'warning',
            `the inbound limit (capacity ${local.capacity}, rate ${local.rate}) is below the remote outbound one (capacity ${capacity}, rate ${rate} in local units): a burst the remote side lets out waits here for the bucket to refill; raise the inbound limit`,
          )
      }
    }

    // pauses and stops, by the directions that must be open
    const expected = new Set(params.expectOpen ?? DIRECTIONS)
    for (const direction of DIRECTIONS) {
      const status = direction === 'outbound' ? lane.outboundStatus : lane.inboundStatus
      const severity = expected.has(direction) ? 'error' : 'warning'
      if (status.status === 'paused')
        add(
          'LANE_PAUSED',
          severity,
          `${direction} is paused (${status.scope} pause): lift it with the matching unpause`,
        )
      else if (lane.stopped[direction])
        add(
          'LANE_STOPPED',
          severity,
          `${direction} is stopped: its rate limit bucket is enabled with no capacity and no rate; lift it by writing a non-zero bucket (liftMultiTokenPoolLaneStops)`,
        )
    }

    // the pool must hold the roles its flavor uses: burn to send, mint to receive
    if (token.isRegistered) {
      const flavor = LOCK_OR_BURN_FLAVORS[decodeTokenProfileFields(token).lockOrBurnFlavor]
      if (flavor && flavor !== 'lock') {
        const needs = [
          ...(flavor !== 'burn-to-address' ? [['burn', this.#isBurner] as const] : []),
          ['mint', this.#isMinter] as const,
        ]
        for (const [role, op] of needs) {
          const holds = await op
            .query(chain, { tokenAddress: key.tokenAddress, account: poolAddress })
            .catch((err: unknown) => {
              // a token type the role reads do not know; anything else (transport) propagates
              if (
                err instanceof CCTContractTypeInvalidError ||
                err instanceof CCTContractVersionUnsupportedError
              )
                return undefined
              throw err
            })
          if (holds === false)
            add(
              'POOL_CANNOT_MINT_BURN',
              'error',
              `the pool ${poolAddress} lacks the ${role} role on ${key.tokenAddress}`,
            )
          else if (holds === undefined)
            add(
              'POOL_CANNOT_MINT_BURN',
              'warning',
              `the ${role} role of the pool on ${key.tokenAddress} cannot be read for this token type`,
            )
        }
      }
    }

    const sorted = sortFindings(findings)
    return { lane, findings: sorted, remote, ok: !sorted.some((f) => f.severity === 'error') }
  }
}
