/**
 * Reads a PCM's stored records into the projection's {@link MultiTokenPoolRecordState}, every read at
 * one block.
 *
 * @packageDocumentation
 */

import { getAddress, isError } from 'ethers'

import type { LaneRecordType } from '../../../chain.ts'
import type { EVMChain } from '../../../evm/index.ts'
import { LANE_RECORD_TYPES, isZeroHex } from '../../../evm/multi-token-pool.ts'
import { resultToObject } from '../../../evm/types.ts'
import { decodeRemoteAddress } from '../../remote-address.ts'
import { latestBlock } from '../mined-block.ts'
import {
  type MultiTokenPoolVersion,
  connectionPolicyStoreContract,
  poolConfigManagerContract,
  sameAddressProviderContract,
} from '../multi-token-pool/contracts.ts'
import {
  type MultiTokenPoolLaneKey,
  type PoolConfigManagerStaticConfig,
  LANE_BATCH_SIZE,
  decodeTokenProfile,
  policyNameOf,
  readChainPauseFlags,
  readConfiguredTokens,
  readInBatches,
  readPoolConfigManagerStaticConfig,
} from './contracts.ts'
import { decodeTokenPolicies } from './decode.ts'
import {
  type MultiTokenPoolPolicyRecords,
  type MultiTokenPoolProviderAnswer,
  type MultiTokenPoolRecordState,
  type MultiTokenPoolTokenRecords,
  multiTokenPoolRecordChains,
  multiTokenPoolSupportedChains,
  requiredMultiTokenPoolProviderAnswers,
} from './projection.ts'
import { INLINE_RECORD_READERS, POLICY_RECORD_READERS, readSubsetTokens } from './record-reads.ts'

/** Options of {@link readMultiTokenPoolRecordState}. @internal */
export type ReadMultiTokenPoolRecordStateOptions = {
  /** Tokens to read; defaults to every registered token. */
  tokenAddresses?: string[]
  /** Block to read at; defaults to the latest block, read once. */
  blockTag?: number
  /** Chains to read pause flags for, besides every chain a record names. */
  extraChains?: bigint[]
}

/** The state, its block, and every lane its tokens have. @internal */
export type MultiTokenPoolRecordStateRead = {
  /** The records. */
  state: MultiTokenPoolRecordState
  /** The block every read was pinned to. */
  blockNumber: number
  /** Every (token, supported chain) of the tokens read. */
  lanes: MultiTokenPoolLaneKey[]
  /** The PCM's static config, read at the same block (callers need its TokenAdminRegistry). */
  staticConfig: PoolConfigManagerStaticConfig
  /** The policy names of each record type, as lower-case words. */
  policyNames: Record<LaneRecordType, ReadonlySet<string>>
  /** Each rate limit policy's stored decimals, by lower-case word (the store checks assignments against them). */
  rateLimitPolicyDecimals: ReadonlyMap<string, number>
}

/**
 * Reads a PCM's stored records at one block: token policies and pauses, inline records, every policy
 * (records, subsets, providers), chain and global pauses, and the provider answers the tokens' policy
 * lanes need, read as the connection view reads them (no code, a revert or an invalid address is
 * `null`; transport errors propagate).
 *
 * @param chain - The chain.
 * @param address - The PCM (already resolved and version-checked).
 * @param version - The PCM's version.
 * @param options - Tokens, block and extra chains.
 * @internal
 */
export async function readMultiTokenPoolRecordState(
  chain: EVMChain,
  address: string,
  version: MultiTokenPoolVersion,
  { tokenAddresses, blockTag, extraChains = [] }: ReadMultiTokenPoolRecordStateOptions = {},
): Promise<MultiTokenPoolRecordStateRead> {
  const blockNumber = blockTag ?? (await latestBlock(chain))
  const at = { blockTag: blockNumber }
  const pcm = poolConfigManagerContract(chain, address, version)
  const [staticConfig, tokens, nameLists] = await Promise.all([
    readPoolConfigManagerStaticConfig(chain, address, version, at),
    tokenAddresses
      ? tokenAddresses.map((t) => getAddress(t))
      : readConfiguredTokens(chain, address, version, at).then((r) => r.tokens),
    pcm.getPolicyNames(at),
  ])
  const store = connectionPolicyStoreContract(chain, staticConfig.connectionPolicyStore, version)

  // tokens: policies, own pauses and inline records
  const tokenRecords: MultiTokenPoolTokenRecords[] = await readInBatches(
    tokens,
    async (batch) => {
      const [configs, profiles] = await Promise.all([
        pcm.getTokenConfigBatch(batch, at),
        store.getTokenProfiles(batch, at),
      ])
      return Promise.all(
        batch.map(async (tokenAddress, i) => {
          const profile = resultToObject(profiles[i]!)
          const inline = Object.fromEntries(
            await Promise.all(
              LANE_RECORD_TYPES.map(
                async (type) =>
                  [type, await INLINE_RECORD_READERS[type](pcm, tokenAddress, at)] as const,
              ),
            ),
          ) as MultiTokenPoolTokenRecords['inline']
          const config = resultToObject(configs[i]!)
          return {
            tokenAddress,
            isOutboundPaused: profile.isOutboundPaused,
            isInboundPaused: profile.isInboundPaused,
            policies: decodeTokenPolicies(config),
            inline,
            profile: decodeTokenProfile(tokenAddress, config, address),
          }
        }),
      )
    },
    { batchSize: LANE_BATCH_SIZE },
  )

  const rateLimitPolicyDecimals = new Map<string, number>()
  // every policy of every type, with connection subsets and providers
  const policies: MultiTokenPoolPolicyRecords = {
    connection: [],
    remoteTokenAddressProviders: [],
    remotePool: [],
    rateLimit: [],
    fee: [],
    destOverhead: [],
    security: [],
  }
  await Promise.all(
    LANE_RECORD_TYPES.map(async (type, t) => {
      const words = (nameLists[t] ?? []).map(String)
      await Promise.all(
        words.map(async (word) => {
          const policyName = policyNameOf(word)
          if (type === 'connection') {
            const read = await POLICY_RECORD_READERS.connection(pcm, word, at)
            if (read.remoteTokenAddressProvider)
              policies.remoteTokenAddressProviders.push({
                policyName,
                provider: read.remoteTokenAddressProvider,
              })
            for (const record of read.records) {
              const { tokens: subsetTokens } = await readSubsetTokens(
                chain,
                pcm,
                word,
                record.remoteChainSelector,
                blockNumber,
              )
              policies.connection.push({ ...record, subsetTokens })
            }
          } else {
            const read = await POLICY_RECORD_READERS[type](pcm, word, at)
            ;(policies[type] as unknown[]).push(...read.records)
            if ('localDecimals' in read && read.localDecimals !== null)
              rateLimitPolicyDecimals.set(word.toLowerCase(), read.localDecimals)
          }
        }),
      )
    }),
  )

  // pauses: one lane read per chain any record names (the zero token has no records of its own)
  const chainList = [
    ...new Set([...extraChains, ...multiTokenPoolRecordChains({ tokens: tokenRecords, policies })]),
  ]
  const pauses = await readChainPauseFlags(pcm, address, chainList, blockNumber)

  const state: MultiTokenPoolRecordState = {
    isGloballyPaused: pauses.global,
    chainPauses: pauses.chains.filter((p) => p.outbound || p.inbound),
    tokens: tokenRecords,
    policies,
    providerAnswers: [],
  }

  const lanes = tokenRecords.flatMap((t) =>
    multiTokenPoolSupportedChains(state, t.tokenAddress).map((remoteChainSelector) => ({
      tokenAddress: t.tokenAddress,
      remoteChainSelector,
    })),
  )
  state.providerAnswers = await readProviderAnswers(
    chain,
    requiredMultiTokenPoolProviderAnswers(state, lanes),
    blockNumber,
  )
  const policyNames = {} as Record<LaneRecordType, ReadonlySet<string>>
  LANE_RECORD_TYPES.forEach((type, t) => {
    policyNames[type] = new Set((nameLists[t] ?? []).map((w) => String(w).toLowerCase()))
  })
  return { state, blockNumber, lanes, staticConfig, policyNames, rateLimitPolicyDecimals }
}

/**
 * Asks each provider for its remote token, as `ConnectionPolicyStore._tryGetPolicyRemoteToken`
 * does: no code, a revert, or an empty or all-zero answer reads as `null`.
 * @internal
 */
export async function readProviderAnswers(
  chain: EVMChain,
  queries: readonly (MultiTokenPoolLaneKey & { provider: string })[],
  blockTag: number,
): Promise<MultiTokenPoolProviderAnswer[]> {
  const hasCode = new Map<string, Promise<boolean>>()
  return Promise.all(
    queries.map(async (q) => {
      const provider = getAddress(q.provider)
      if (!hasCode.has(provider))
        hasCode.set(
          provider,
          chain.provider.getCode(provider, blockTag).then((code) => code !== '0x'),
        )
      let remoteToken: string | null = null
      if (await hasCode.get(provider)) {
        try {
          const answer = await sameAddressProviderContract(chain, provider).getRemoteTokenAddress(
            q.tokenAddress,
            q.remoteChainSelector,
            { blockTag },
          )
          remoteToken = isZeroHex(answer)
            ? null
            : decodeRemoteAddress(answer, q.remoteChainSelector)
        } catch (err) {
          // a revert is caught by the store; anything else (transport, bad data) is not ours to hide
          if (!isError(err, 'CALL_EXCEPTION')) throw err
        }
      }
      return { ...q, provider, remoteToken }
    }),
  )
}

/**
 * Adds to `state` the provider answers its policy lanes among `lanes` need, read at `blockTag`.
 * @internal
 */
export async function fillProviderAnswers(
  chain: EVMChain,
  state: MultiTokenPoolRecordState,
  lanes: readonly MultiTokenPoolLaneKey[],
  blockTag: number,
): Promise<void> {
  const queries = requiredMultiTokenPoolProviderAnswers(state, lanes)
  if (queries.length)
    state.providerAnswers.push(...(await readProviderAnswers(chain, queries, blockTag)))
}
