/**
 * Reads a PCM's stored records into the projection's {@link MultiTokenPoolRecordState}, every read at
 * one block.
 *
 * @packageDocumentation
 */

import { ZeroAddress, getAddress, isError } from 'ethers'

import type { EVMChain } from '../../../evm/index.ts'
import { LANE_RECORD_TYPES } from '../../../evm/multi-token-pool.ts'
import { resultToObject } from '../../../evm/types.ts'
import { decodeRemoteAddress } from '../../remote-address.ts'
import {
  type MultiTokenPoolVersion,
  connectionPolicyStoreContract,
  poolConfigManagerContract,
  sameAddressProviderContract,
} from '../multi-token-pool/contracts.ts'
import {
  type MultiTokenPoolLaneKey,
  LANE_BATCH_SIZE,
  decodePolicyName,
  readConfiguredTokens,
  readInBatches,
  readLaneBatches,
  readPoolConfigManagerStaticConfig,
  toAbiLaneKey,
} from './contracts.ts'
import { decodeTokenPolicies } from './decode.ts'
import {
  type MultiTokenPoolPolicyRecords,
  type MultiTokenPoolProviderAnswer,
  type MultiTokenPoolRecordState,
  type MultiTokenPoolTokenRecords,
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
  const blockNumber = blockTag ?? (await chain.provider.getBlockNumber())
  const at = { blockTag: blockNumber }
  const pcm = poolConfigManagerContract(chain, address, version)
  const [{ connectionPolicyStore }, tokens, nameLists] = await Promise.all([
    readPoolConfigManagerStaticConfig(chain, address, version),
    tokenAddresses
      ? tokenAddresses.map((t) => getAddress(t))
      : readConfiguredTokens(chain, address, version, at).then((r) => r.tokens),
    pcm.getPolicyNames(at),
  ])
  const store = connectionPolicyStoreContract(chain, connectionPolicyStore, version)

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
          return {
            tokenAddress,
            isOutboundPaused: profile.isOutboundPaused,
            isInboundPaused: profile.isInboundPaused,
            policies: decodeTokenPolicies(resultToObject(configs[i]!)),
            inline,
          }
        }),
      )
    },
    { batchSize: LANE_BATCH_SIZE },
  )

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
          const policyName = decodePolicyName(word) ?? word
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
          }
        }),
      )
    }),
  )

  // pauses: one lane read per chain any record names (the zero token has no records of its own)
  const chains = new Set<bigint>(extraChains)
  for (const t of tokenRecords)
    for (const type of LANE_RECORD_TYPES)
      for (const r of t.inline[type]) chains.add(r.remoteChainSelector)
  for (const type of LANE_RECORD_TYPES)
    for (const r of policies[type])
      if (r.remoteChainSelector !== 0n) chains.add(r.remoteChainSelector)
  const chainList = [...(chains.size ? chains : [0n])]
  const flags = await readLaneBatches(
    chainList.map((remoteChainSelector) => ({ tokenAddress: ZeroAddress, remoteChainSelector })),
    async (chunk) =>
      (await pcm.getLaneConnectionBatch(chunk.map(toAbiLaneKey), at)).map((c) => resultToObject(c)),
  )

  const state: MultiTokenPoolRecordState = {
    isGloballyPaused: flags.some((f) => f.isGloballyPaused),
    chainPauses: chainList
      .map((remoteChainSelector, i) => ({
        remoteChainSelector,
        outbound: flags[i]!.isChainOutboundPaused,
        inbound: flags[i]!.isChainInboundPaused,
      }))
      .filter((p) => p.remoteChainSelector !== 0n && (p.outbound || p.inbound)),
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
  return { state, blockNumber, lanes }
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
          remoteToken = /^(0x)?0*$/.test(answer)
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
