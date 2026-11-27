/**
 * The E5 writes: what each refuses before any RPC, and the stores' bookkeeping refusals the shared
 * record-write checks name from the state. The writes themselves are built live in
 * `e5-write-ops.integration.test.ts`.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { encodeBytes32String, getAddress } from 'ethers'

import type { LaneRecordType } from '../../../../chain.ts'
import type { EVMChain } from '../../../../evm/index.ts'
import { LANE_RECORD_TYPES } from '../../../../evm/multi-token-pool.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { SAME_ADDRESS_PROVIDER_TYPE, UID_PROVIDER_TYPE } from '../../multi-token-pool/contracts.ts'
import { POOL, stackChain } from '../../multi-token-pool/stack.test.helpers.ts'
import type { MultiTokenPoolRecordState } from '../projection.ts'
import { ApplyMultiTokenPoolConnectionPolicyConfigUpdates } from './apply-multi-token-pool-connection-policy-config-updates.ts'
import { ApplyMultiTokenPoolInlineConnectionConfigUpdates } from './apply-multi-token-pool-inline-connection-config-updates.ts'
import { ApplyMultiTokenPoolInlineRemotePoolConfigUpdates } from './apply-multi-token-pool-inline-remote-pool-config-updates.ts'
import { ApplyMultiTokenPoolRemotePoolPolicyConfigUpdates } from './apply-multi-token-pool-remote-pool-policy-config-updates.ts'
import { ApplyMultiTokenPoolRemoteTokenAddressProviderUpdates } from './apply-multi-token-pool-remote-token-address-provider-updates.ts'
import { ApplyMultiTokenPoolSubsetTokenUpdates } from './apply-multi-token-pool-subset-token-updates.ts'
import {
  checkInlineRecordWrite,
  checkPolicyRecordWrite,
  sameAddressProviderConflicts,
} from './record-writes.ts'

const T = getAddress('0x' + 'a1'.repeat(20))
const REMOTE = getAddress('0x' + 'b2'.repeat(20))
const FUJI = 14767482510784806043n

/** Builds the op and expects it to refuse `param` before any RPC. */
async function refusesBeforeRpc(
  op: { generate: (c: never, p: never) => Promise<unknown> },
  cases: [object, string][],
) {
  const { chain, calls } = stackChain()
  for (const [params, param] of cases)
    await assert.rejects(
      op.generate(chain as never, { poolAddress: POOL, ...params } as never),
      (e: unknown) => e instanceof CCTParamsInvalidError && e.context.param === param,
      param,
    )
  assert.deepEqual(calls, [])
}

describe('E5 writes refuse before any RPC (cct/evm pool-config-manager)', () => {
  const lane = { tokenAddress: T, remoteChainSelector: FUJI }

  it('connection policy records', () =>
    refusesBeforeRpc(new ApplyMultiTokenPoolConnectionPolicyConfigUpdates(), [
      [{}, 'recordsToSet'],
      [
        { recordsToSet: [{ policyName: 'p', remoteChainSelector: 0n, onlySubsetTokens: true }] },
        'recordsToSet[0].remoteChainSelector',
      ],
      // opening a chain to every token of the policy is confirmed
      [
        { recordsToSet: [{ policyName: 'p', remoteChainSelector: FUJI, onlySubsetTokens: false }] },
        'recordsToSet[0].onlySubsetTokens',
      ],
      [
        {
          recordsToRemove: [
            { policyName: 'p', remoteChainSelector: FUJI },
            { policyName: 'p', remoteChainSelector: FUJI },
          ],
        },
        'recordsToRemove[1]',
      ],
      [{ policiesToRemove: [''] }, 'policiesToRemove[0]'],
    ]))

  it('remote pool policy records', () =>
    refusesBeforeRpc(new ApplyMultiTokenPoolRemotePoolPolicyConfigUpdates(), [
      [
        { recordsToSet: [{ policyName: 'p', remoteChainSelector: FUJI, remotePoolAddresses: [] }] },
        'recordsToSet[0].remotePoolAddresses',
      ],
      [
        {
          recordsToSet: [
            {
              policyName: 'p',
              remoteChainSelector: FUJI,
              remotePoolAddresses: [REMOTE, REMOTE.toLowerCase()],
            },
          ],
        },
        'recordsToSet[0].remotePoolAddresses[1]',
      ],
      [
        {
          recordsToSet: [
            { policyName: 'p', remoteChainSelector: FUJI, remotePoolAddresses: ['not-an-address'] },
          ],
        },
        'recordsToSet[0].remotePoolAddresses[0]',
      ],
    ]))

  it('subset memberships', () =>
    refusesBeforeRpc(new ApplyMultiTokenPoolSubsetTokenUpdates(), [
      [{}, 'add'],
      [
        { add: [{ policyName: 'p', remoteChainSelector: FUJI, tokenAddress: '0x12' }] },
        'add[0].tokenAddress',
      ],
      [
        {
          add: [
            { policyName: 'p', remoteChainSelector: FUJI, tokenAddress: T },
            { policyName: 'p', remoteChainSelector: FUJI, tokenAddress: T.toLowerCase() },
          ],
        },
        'add[1]',
      ],
    ]))

  it('remote token address providers', () =>
    refusesBeforeRpc(new ApplyMultiTokenPoolRemoteTokenAddressProviderUpdates(), [
      [{ updates: [] }, 'updates'],
      [
        { updates: [{ policyName: 'p', remoteTokenAddressProvider: '0x12' }] },
        'updates[0].remoteTokenAddressProvider',
      ],
      [
        {
          updates: [
            { policyName: 'p', remoteTokenAddressProvider: null },
            { policyName: 'p', remoteTokenAddressProvider: null },
          ],
        },
        'updates[1]',
      ],
    ]))

  it('inline connections', () =>
    refusesBeforeRpc(new ApplyMultiTokenPoolInlineConnectionConfigUpdates(), [
      [{}, 'set'],
      [
        { set: [{ ...lane, remoteChainSelector: 0n, remoteToken: REMOTE }] },
        'set[0].remoteChainSelector',
      ],
      [{ set: [{ ...lane, remoteToken: '0x' + '00'.repeat(20) }] }, 'set[0].remoteToken'],
      [{ remove: [lane, lane] }, 'remove[1]'],
    ]))

  it('inline remote pools', () =>
    refusesBeforeRpc(new ApplyMultiTokenPoolInlineRemotePoolConfigUpdates(), [
      [
        {
          set: [
            { ...lane, trustPolicyRemotePools: false, poolDataFormat: 'short', remotePools: [] },
          ],
        },
        'set[0].poolDataFormat',
      ],
      [
        {
          set: [
            {
              ...lane,
              trustPolicyRemotePools: false,
              poolDataFormat: 'long',
              remotePools: [{ address: REMOTE, allowLegacyPoolData: 'no' }],
            },
          ],
        },
        'set[0].remotePools[0].allowLegacyPoolData',
      ],
      [
        {
          set: [
            {
              ...lane,
              trustPolicyRemotePools: false,
              poolDataFormat: 'long',
              remotePools: [
                { address: REMOTE, allowLegacyPoolData: false },
                { address: REMOTE, allowLegacyPoolData: true },
              ],
            },
          ],
        },
        'set[0].remotePools[1]',
      ],
      [
        { remove: [lane], confirmDropped: [{ lane, flags: ['everything'] }] },
        'confirmDropped[0].flags[0]',
      ],
    ]))
})

/** A record state with one registered token on policy `p`, which has one connection record. */
function state(): MultiTokenPoolRecordState {
  return {
    isGloballyPaused: false,
    chainPauses: [],
    tokens: [
      {
        tokenAddress: T,
        isOutboundPaused: false,
        isInboundPaused: false,
        policies: Object.fromEntries(
          LANE_RECORD_TYPES.map((t) => [t, t === 'connection' ? 'p' : null]),
        ),
        inline: Object.fromEntries(
          LANE_RECORD_TYPES.map((t) => [
            t,
            t === 'remotePool'
              ? [
                  {
                    tokenAddress: T,
                    remoteChainSelector: FUJI,
                    trustPolicyRemotePools: false,
                    poolDataFormat: 'long',
                    remotePools: [],
                  },
                ]
              : [],
          ]),
        ),
      },
    ],
    policies: {
      connection: [
        { policyName: 'p', remoteChainSelector: FUJI, onlySubsetTokens: true, subsetTokens: [T] },
      ],
      remoteTokenAddressProviders: [],
      remotePool: [],
      rateLimit: [],
      fee: [],
      destOverhead: [],
      security: [],
    },
    providerAnswers: [],
  } as unknown as MultiTokenPoolRecordState
}

/** The record-write context a state check reads: the state, and the connection policy names. */
const ctx = (state: MultiTokenPoolRecordState, connection: string[]) => {
  const policyNames = {} as Record<LaneRecordType, ReadonlySet<string>>
  for (const t of LANE_RECORD_TYPES) policyNames[t] = new Set<string>()
  policyNames.connection = new Set(connection.map((n) => encodeBytes32String(n).toLowerCase()))
  return { state, policyNames }
}

describe('record-write state checks (cct/evm pool-config-manager)', () => {
  const op = 'test'
  const refused = (param: string, pattern: RegExp) => (e: unknown) =>
    e instanceof CCTParamsInvalidError && e.context.param === param && pattern.test(e.message)

  it('names the policy bookkeeping refusals: missing record, missing policy, in use, records left', () => {
    const s = state()
    assert.throws(
      () =>
        checkPolicyRecordWrite(op, ctx(s, ['p']), 'connection', {
          recordsToRemove: [{ policyName: 'p', remoteChainSelector: 1n }],
        }),
      refused('recordsToRemove[0]', /PolicyRecordNotFound/),
    )
    assert.throws(
      () => checkPolicyRecordWrite(op, ctx(s, ['p']), 'connection', { policiesToRemove: ['q'] }),
      refused('policiesToRemove[0]', /PolicyNotFound/),
    )
    assert.throws(
      () => checkPolicyRecordWrite(op, ctx(s, ['p']), 'connection', { policiesToRemove: ['p'] }),
      refused('policiesToRemove[0]', /PolicyInUse/),
    )
    // with no token on it, the records left still block the removal, unless removed in the same call
    s.tokens[0]!.policies.connection = null
    assert.throws(
      () => checkPolicyRecordWrite(op, ctx(s, ['p']), 'connection', { policiesToRemove: ['p'] }),
      refused('policiesToRemove[0]', /PolicyHasRecords/),
    )
    checkPolicyRecordWrite(op, ctx(s, ['p']), 'connection', {
      recordsToRemove: [{ policyName: 'p', remoteChainSelector: FUJI }],
      policiesToRemove: ['p'],
    })
  })

  it('names the inline bookkeeping refusals: missing record, unregistered token', () => {
    const s = state()
    assert.throws(
      () =>
        checkInlineRecordWrite(op, s, 'connection', {
          remove: [{ tokenAddress: T, remoteChainSelector: FUJI }],
        }),
      refused('remove[0]', /InlineRecordNotFound/),
    )
    assert.throws(
      () =>
        checkInlineRecordWrite(op, s, 'remotePool', {
          set: [{ tokenAddress: REMOTE, remoteChainSelector: FUJI }],
        }),
      refused('set[0].tokenAddress', /LocalTokenNotRegistered/),
    )
    checkInlineRecordWrite(op, s, 'remotePool', {
      remove: [{ tokenAddress: T, remoteChainSelector: FUJI }],
    })
  })

  it('checks the same-address provider invariant from both sides with one rule', async () => {
    const SOLANA_DEVNET = 16423721717087811551n
    const PROVIDER = getAddress('0x' + 'c3'.repeat(20))
    const typed = (type: string) =>
      ({
        typeAndVersion: async () => [type, '2.1.0-dev', `${type} 2.1.0-dev`],
      }) as unknown as EVMChain
    const word = encodeBytes32String('p').toLowerCase()
    const s = state()
    // a record added: against the stored provider
    s.policies.remoteTokenAddressProviders = [{ policyName: 'p', provider: PROVIDER }] as never
    const same = typed(SAME_ADDRESS_PROVIDER_TYPE)
    assert.deepEqual(
      await sameAddressProviderConflicts(same, s, word, { chains: [SOLANA_DEVNET] }),
      [SOLANA_DEVNET],
    )
    assert.deepEqual(await sameAddressProviderConflicts(same, s, word, { chains: [FUJI] }), [])
    assert.deepEqual(
      await sameAddressProviderConflicts(typed(UID_PROVIDER_TYPE), s, word, {
        chains: [SOLANA_DEVNET],
      }),
      [],
    )
    // a provider set: against the stored records
    s.policies.connection.push({
      policyName: 'p',
      remoteChainSelector: SOLANA_DEVNET,
      onlySubsetTokens: false,
      subsetTokens: [],
    } as never)
    assert.deepEqual(await sameAddressProviderConflicts(same, s, word, { provider: PROVIDER }), [
      SOLANA_DEVNET,
    ])
    // no provider anywhere: nothing to judge, no RPC
    s.policies.remoteTokenAddressProviders = []
    assert.deepEqual(await sameAddressProviderConflicts({} as EVMChain, s, word, {}), [])
  })
})
