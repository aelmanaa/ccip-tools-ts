import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { id, makeError } from 'ethers'

import type { EVMChain } from '../../../evm/index.ts'
import { LANE_RECORD_TYPES } from '../../../evm/multi-token-pool.ts'
import { parseTypeAndVersion } from '../../../utils.ts'
import { CCTContractTypeInvalidError, CCTContractVersionUnsupportedError } from '../../errors.ts'
import {
  LOCK_OR_BURN_FLAVORS,
  MULTI_TOKEN_POOL_OPERATIONS,
  MultiTokenPoolVersion,
  POOL_CONFIG_MANAGER_ROLES,
  TOKEN_POLICY_ROLES,
  assertMultiTokenPoolAuxContract,
  getMultiTokenPoolInterface,
  isPoolConfigManagerRole,
  isSupportedMultiTokenPoolType,
  poolConfigManagerRoleId,
  resolveMultiTokenPoolContract,
} from './contracts.ts'

const ADDR = '0x' + '11'.repeat(20)

/** A chain whose `typeAndVersion` parses `raw` exactly as the real one does, or fails. */
function chainReporting(raw: string | Error): EVMChain {
  return {
    typeAndVersion: async () => {
      if (raw instanceof Error) throw raw
      return parseTypeAndVersion(raw)
    },
  } as unknown as EVMChain
}

describe('resolveMultiTokenPoolContract', () => {
  it('joins version and suffix from the real on-chain string', async () => {
    // the 4th tuple element keeps the hyphen, so the join is '2.1.0-dev', not '2.1.0--dev'
    assert.deepEqual(parseTypeAndVersion('BurnMintMultiTokenPool 2.1.0-dev').at(3), '-dev')
    assert.deepEqual(
      await resolveMultiTokenPoolContract(
        chainReporting('BurnMintMultiTokenPool 2.1.0-dev'),
        ADDR,
        ['BurnMintMultiTokenPool'],
      ),
      { type: 'BurnMintMultiTokenPool', version: MultiTokenPoolVersion.V2_1_0_DEV },
    )
    assert.deepEqual(
      await resolveMultiTokenPoolContract(chainReporting('PoolConfigManager 2.1.0-dev'), ADDR, [
        'PoolConfigManager',
      ]),
      { type: 'PoolConfigManager', version: '2.1.0-dev' },
    )
  })

  it('refuses a released or other pre-release version instead of floor-matching -dev', async () => {
    for (const raw of ['BurnMintMultiTokenPool 2.1.0', 'BurnMintMultiTokenPool 2.1.0-rc1'])
      await assert.rejects(
        resolveMultiTokenPoolContract(chainReporting(raw), ADDR, ['BurnMintMultiTokenPool']),
        CCTContractVersionUnsupportedError,
      )
  })

  it('refuses another type, and an address without typeAndVersion', async () => {
    await assert.rejects(
      resolveMultiTokenPoolContract(chainReporting('BurnMintTokenPool 2.0.0'), ADDR, [
        'BurnMintMultiTokenPool',
      ]),
      (e: unknown) =>
        e instanceof CCTContractTypeInvalidError && e.context.actual === 'BurnMintTokenPool',
    )
    await assert.rejects(
      resolveMultiTokenPoolContract(
        chainReporting(
          Object.assign(makeError('execution reverted', 'CALL_EXCEPTION'), { data: '0x' }),
        ),
        ADDR,
        ['PoolConfigManager'],
      ),
      (e: unknown) => e instanceof CCTContractTypeInvalidError && e.context.actual === 'unknown',
    )
  })

  it('propagates a transport error instead of calling the address a non-CCIP contract', async () => {
    const throttled = makeError('429 Too Many Requests', 'SERVER_ERROR')
    await assert.rejects(
      resolveMultiTokenPoolContract(chainReporting(throttled), ADDR, ['PoolConfigManager']),
      (e: unknown) => e === throttled,
    )
  })

  it('names the read to use for the common mix-ups', async () => {
    const reasonFor = async (
      raw: string,
      expected: Parameters<typeof resolveMultiTokenPoolContract>[2],
    ) =>
      resolveMultiTokenPoolContract(chainReporting(raw), ADDR, expected).then(
        () => assert.fail('resolved'),
        (e: CCTContractTypeInvalidError) => String(e.context.reason),
      )
    assert.match(
      await reasonFor('PoolConfigManager 2.1.0-dev', ['BurnMintMultiTokenPool']),
      /pass it as poolConfigManager/,
    )
    assert.match(
      await reasonFor('BurnMintMultiTokenPool 2.1.0-dev', ['PoolConfigManager']),
      /pass it as poolAddress/,
    )
    assert.match(
      await reasonFor('BurnMintTokenPool 2.0.0', ['BurnMintMultiTokenPool']),
      /getTokenPoolState/,
    )
  })
})

describe('assertMultiTokenPoolAuxContract', () => {
  it('gates hooks and providers on type only, so a later version still binds', async () => {
    assert.equal(
      await assertMultiTokenPoolAuxContract(chainReporting('MultiTokenPoolHooks 2.2.0'), ADDR, [
        'MultiTokenPoolHooks',
        'MultiTokenPoolHooksExternalBlocklist',
      ]),
      'MultiTokenPoolHooks',
    )
    await assert.rejects(
      assertMultiTokenPoolAuxContract(chainReporting('AdvancedPoolHooks 2.0.0'), ADDR, [
        'MultiTokenPoolHooks',
      ]),
      CCTContractTypeInvalidError,
    )
  })
})

describe('taxonomy', () => {
  it('guards exact types and roles', () => {
    assert.equal(isSupportedMultiTokenPoolType('BurnMintMultiTokenPool'), true)
    assert.equal(isSupportedMultiTokenPoolType('LockReleaseMultiTokenPool'), false)
    assert.equal(isPoolConfigManagerRole('CONFIG_ROLE'), true)
    assert.equal(isPoolConfigManagerRole('CONFIG'), false)
  })

  it('derives role IDs as the PCM constants do', () => {
    assert.equal(poolConfigManagerRoleId('DEFAULT_ADMIN_ROLE'), '0x' + '00'.repeat(32))
    for (const role of POOL_CONFIG_MANAGER_ROLES.slice(1))
      assert.equal(poolConfigManagerRoleId(role), id(role))
    // every role, the OpenZeppelin default admin included, has a constant getter of that name
    const pcm = getMultiTokenPoolInterface('PoolConfigManager', MultiTokenPoolVersion.V2_1_0_DEV)
    for (const role of POOL_CONFIG_MANAGER_ROLES) assert.ok(pcm.getFunction(role), role)
  })

  it('lists lock-or-burn flavors in enum order (Lock = 4, as core reads it)', () => {
    assert.equal(LOCK_OR_BURN_FLAVORS.indexOf('lock'), 4)
  })
})

describe('MULTI_TOKEN_POOL_OPERATIONS', () => {
  it('names a function (or constructor) that every listed contract really has', () => {
    for (const [op, target] of Object.entries(MULTI_TOKEN_POOL_OPERATIONS)) {
      const fns = 'function' in target ? [target.function] : Object.values(target.functions)
      for (const contract of target.contracts) {
        const iface = getMultiTokenPoolInterface(contract, MultiTokenPoolVersion.V2_1_0_DEV)
        for (const fn of fns)
          if (fn === 'constructor') assert.ok(iface.deploy, `${op}: ${contract} constructor`)
          else assert.ok(iface.getFunction(fn), `${op}: ${contract}.${fn}`)
      }
    }
  })

  it('names one assignment function and one gate role per record type', () => {
    const target = MULTI_TOKEN_POOL_OPERATIONS.applyMultiTokenPoolTokenPolicyUpdates
    assert.ok('functions' in target)
    assert.deepEqual(Object.keys(target.functions).sort(), [...LANE_RECORD_TYPES].sort())
    // the gate table, as PoolConfigManager._checkTokenRoles reads it at chainlink-ccip c950d9bc
    assert.deepEqual(TOKEN_POLICY_ROLES, {
      connection: 'CONNECTION_ROLE',
      remotePool: 'REMOTE_POOL_ROLE',
      rateLimit: 'RATE_LIMIT_ROLE',
      fee: 'FEE_ROLE',
      destOverhead: 'DEST_OVERHEAD_ROLE',
      security: 'SECURITY_ROLE',
    })
    for (const type of LANE_RECORD_TYPES) {
      assert.ok(POOL_CONFIG_MANAGER_ROLES.includes(TOKEN_POLICY_ROLES[type]), type)
      assert.match(
        target.functions[type]!,
        new RegExp(`^applyToken${type[0]!.toUpperCase()}${type.slice(1)}PolicyUpdates$`),
      )
    }
  })

  it('maps every op of the agreed interface exactly once', () => {
    // 61, minus the 6 per-type assignments merged into one (A15)
    assert.equal(Object.keys(MULTI_TOKEN_POOL_OPERATIONS).length, 56)
  })
})
