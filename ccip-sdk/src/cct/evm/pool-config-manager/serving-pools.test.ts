/**
 * The one serving-pools reader the stack audit and the guard share: its error policy.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Interface, ZeroAddress, getAddress, makeError } from 'ethers'

import { CCIPTypeVersionInvalidError } from '../../../errors/index.ts'
import type { EVMChain } from '../../../evm/index.ts'
import { MultiTokenPoolVersion } from '../multi-token-pool/contracts.ts'
import { readPoolsServingPoolConfigManager } from './serving-pools.ts'

const addr = (b: string) => getAddress('0x' + b.repeat(20))
const [PCM, OTHER_PCM, TARGET, SHARING, FOREIGN, SINGLE, GARBLED, MUTE, TAR] = [
  '22',
  '23',
  '11',
  '12',
  '13',
  '14',
  '15',
  '16',
  '66',
].map(addr) as [string, string, string, string, string, string, string, string, string]
const [T_TARGET, T_SHARING, T_FOREIGN, T_SINGLE, T_GARBLED, T_MUTE, T_UNLISTED, T_NOPOOL] = [
  'a1',
  'a2',
  'a3',
  'a4',
  'a5',
  'a6',
  'a7',
  'a8',
].map(addr) as string[]
const IFACE = new Interface(['function getPoolConfigManager() view returns (address)'])
const TAR_IFACE = new Interface([
  'function getTokenConfig(address token) view returns ((address administrator, address pendingAdministrator, address tokenPool))',
])
const PENDING = addr('77')

/** A chain whose registry, `typeAndVersion` and `getPoolConfigManager` answers are given here. */
function chain(): { chain: EVMChain; blockTags: unknown[] } {
  const registry: Record<string, string | undefined> = {
    [T_TARGET!]: TARGET,
    [T_SHARING!]: SHARING,
    [T_FOREIGN!]: FOREIGN,
    [T_SINGLE!]: SINGLE,
    [T_GARBLED!]: GARBLED,
    [T_MUTE!]: MUTE,
    [T_NOPOOL!]: undefined,
  }
  const types: Record<string, string | Error> = {
    [SHARING]: 'BurnMintMultiTokenPool 2.1.0-dev',
    [FOREIGN]: 'BurnMintMultiTokenPool 2.1.0-dev',
    [SINGLE]: 'BurnMintTokenPool 2.0.0',
    [GARBLED]: new CCIPTypeVersionInvalidError('garbled'),
    [MUTE]: Object.assign(makeError('execution reverted', 'CALL_EXCEPTION'), { data: '0x' }),
  }
  const pcms: Record<string, string> = { [SHARING]: PCM, [FOREIGN]: OTHER_PCM }
  const blockTags: unknown[] = []
  return {
    blockTags,
    chain: {
      typeAndVersion: async (a: string) => {
        const t = types[getAddress(a)]
        if (t instanceof Error) throw t
        return [t!.split(' ')[0], t!.split(' ')[1], t]
      },
      provider: {
        call: async ({ to, data, blockTag }: { to: string; data: string; blockTag?: unknown }) => {
          blockTags.push(blockTag)
          if (getAddress(to) === TAR) {
            // a token the registry does not list reads as an all-zero entry
            const [token] = TAR_IFACE.decodeFunctionData('getTokenConfig', data)
            const pool = registry[getAddress(String(token))]
            const pending = getAddress(String(token)) === T_SHARING ? PENDING : ZeroAddress
            return TAR_IFACE.encodeFunctionResult('getTokenConfig', [
              [pool ? TAR : ZeroAddress, pending, pool ?? ZeroAddress],
            ])
          }
          return IFACE.encodeFunctionResult('getPoolConfigManager', [pcms[getAddress(to)]])
        },
      },
    } as unknown as EVMChain,
  }
}

describe('readPoolsServingPoolConfigManager (cct/evm pool-config-manager)', () => {
  it('lists sharing pools and diverged tokens under one error policy, pinned to the block', async () => {
    const { chain: c, blockTags } = chain()
    const r = await readPoolsServingPoolConfigManager(c, {
      poolConfigManager: PCM,
      version: MultiTokenPoolVersion.V2_1_0_DEV,
      tokenAdminRegistry: TAR,
      tokens: [
        T_TARGET,
        T_SHARING,
        T_FOREIGN,
        T_SINGLE,
        T_GARBLED,
        T_MUTE,
        T_UNLISTED,
        T_NOPOOL,
      ] as string[],
      targetPool: TARGET,
      blockTag: 1234,
    })
    // the target serves by definition and is never listed
    assert.deepEqual(r.serving, [SHARING])
    // another PCM, a single-token pool, an unparseable typeAndVersion (missed before the shared
    // reader) and no typeAndVersion at all: each is "not this PCM"
    assert.deepEqual(r.diverged.map((d) => d.pool).sort(), [FOREIGN, SINGLE, GARBLED, MUTE].sort())
    // a token the registry does not list reads as "no pool", the same as no pool set
    assert.ok(!r.diverged.some((d) => d.token === T_UNLISTED || d.token === T_NOPOOL))
    // every admin state is visible in the entries, a pending one included
    assert.equal(r.entries.get(T_SHARING!)?.pendingAdministrator, PENDING)
    assert.equal(r.entries.get(T_UNLISTED!)?.pool, null)
    // every read is pinned: 8 registry entries, then 2 PoolConfigManager reads
    assert.deepEqual(blockTags, Array(10).fill(1234))
  })

  it('propagates transport errors', async () => {
    const { chain: c } = chain()
    const timeout = Object.assign(new Error('timeout'), { code: 'TIMEOUT' })
    ;(c as unknown as { typeAndVersion: () => never }).typeAndVersion = () => {
      throw timeout
    }
    await assert.rejects(
      readPoolsServingPoolConfigManager(c, {
        poolConfigManager: PCM,
        version: MultiTokenPoolVersion.V2_1_0_DEV,
        tokenAdminRegistry: TAR,
        tokens: [T_SHARING!],
      }),
      (e: unknown) => e === timeout,
    )
  })
})
