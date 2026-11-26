import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { type Connection, type VersionedTransaction, Keypair } from '@solana/web3.js'

import { networkInfo } from '../../../networks.ts'
import { sighash } from '../../../solana/coder.ts'
import { SolanaChain } from '../../../solana/index.ts'
import { CCTOperationUnsupportedError } from '../../errors.ts'
import { getPoolGroupProgramFeatures } from './program.ts'

const PROBES = {
  groups: sighash('global', 'observe_group'),
  hooks: sighash('global', 'create_allowlist'),
  drivenLanes: sighash('global', 'materialize_group_lanes'),
  drivenLanesV2Layout: sighash('global', 'close_group_lanes'),
}
type Feature = keyof typeof PROBES

/** A chain whose program answers each probe with `answers[feature]` (a custom code or an error). */
function chainAnswering(answers: Partial<Record<Feature, unknown>>, slot = { value: 7n }) {
  const calls: Feature[] = []
  const connection = {
    getAccountInfo: async () => {
      const data = Buffer.alloc(45)
      data.writeUInt32LE(3, 0)
      data.writeBigUInt64LE(slot.value, 4)
      return { data, owner: Keypair.generate().publicKey, lamports: 1, executable: false }
    },
    simulateTransaction: async (tx: VersionedTransaction) => {
      const ixs = tx.message.compiledInstructions
      const data = Buffer.from(ixs[ixs.length - 1]!.data)
      const feature = (Object.keys(PROBES) as Feature[]).find((f) =>
        data.subarray(0, 8).equals(PROBES[f]),
      )!
      calls.push(feature)
      const answer = answers[feature] ?? 101
      const err =
        typeof answer === 'number'
          ? { InstructionError: [ixs.length - 1, { Custom: answer }] }
          : answer
      return { context: { slot: 1 }, value: { err, logs: [] } }
    },
    getSignaturesForAddress: async () => [],
  } as unknown as Connection
  const chain = new SolanaChain(connection, networkInfo('solana-devnet'), {
    apiClient: null,
    logger: { debug() {}, info() {}, warn() {}, error() {} } as unknown as Console,
  })
  return { chain, calls }
}

describe('getPoolGroupProgramFeatures', () => {
  const program = Keypair.generate().publicKey

  it('3012 = present, 101 = absent, 102 = the old close layout', async () => {
    const { chain } = chainAnswering({
      groups: 3012,
      hooks: 3012,
      drivenLanes: 3012,
      drivenLanesV2Layout: 102,
    })
    assert.deepEqual(await getPoolGroupProgramFeatures(chain, program), [
      'groups',
      'hooks',
      'drivenLanes',
    ])
    const none = chainAnswering({})
    assert.deepEqual(await getPoolGroupProgramFeatures(none.chain, program), [])
  })

  it('fails closed on any other answer', async () => {
    for (const answer of [
      102,
      6000,
      'AccountNotFound',
      { InstructionError: [0, 'ProgramFailedToComplete'] },
    ]) {
      const { chain } = chainAnswering({ groups: answer })
      await assert.rejects(
        getPoolGroupProgramFeatures(chain, program),
        CCTOperationUnsupportedError,
      )
    }
  })

  it('a decoded group proves groups without its probe', async () => {
    const { chain, calls } = chainAnswering({ groups: 'AccountNotFound', hooks: 3012 })
    assert.deepEqual(await getPoolGroupProgramFeatures(chain, program, { groupExists: true }), [
      'groups',
      'hooks',
    ])
    assert.ok(!calls.includes('groups'))
  })

  it('caches per program and last-deploy slot', async () => {
    const slot = { value: 7n }
    const { chain, calls } = chainAnswering({ groups: 3012 }, slot)
    await getPoolGroupProgramFeatures(chain, program)
    await getPoolGroupProgramFeatures(chain, program)
    assert.equal(calls.length, 4)
    slot.value = 8n // an upgrade in place
    await getPoolGroupProgramFeatures(chain, program)
    assert.equal(calls.length, 8)
  })
})
