/**
 * The in-memory stack stub keeps its own hand-written interfaces on purpose (an independent oracle,
 * rule R16), so these tests pin them to the vendored ABIs: a vendored-ABI change that the stub does
 * not follow fails here instead of passing every op test with stale encodings.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { type Fragment, FunctionFragment, Interface } from 'ethers'

import TOKEN_ADMIN_REGISTRY_V1_5_0_ABI from '../artifacts/abi/V1_5_0/token-admin-registry.ts'
import {
  type MultiTokenPoolContractType,
  MULTI_TOKEN_POOL_HOOKS_TYPES,
  MULTI_TOKEN_POOL_PROVIDER_TYPES,
  MULTI_TOKEN_POOL_TYPES,
  MultiTokenPoolVersion,
  POOL_CONFIG_MANAGER_ROLES,
  POOL_CONFIG_MANAGER_TYPE,
  getMultiTokenPoolInterface,
  poolConfigManagerRoleId,
} from './contracts.ts'
import {
  AUX_IFACE,
  PCM_IFACE,
  POOL_IFACE,
  STORE_IFACE,
  TAR_IFACE,
  roleId,
} from './stack.test.helpers.ts'

const STORE_TYPES = ['ConnectionPolicyStore', 'FeePolicyStore', 'SecurityPolicyStore'] as const
const ALL: MultiTokenPoolContractType[] = [
  ...MULTI_TOKEN_POOL_TYPES,
  POOL_CONFIG_MANAGER_TYPE,
  ...STORE_TYPES,
  ...MULTI_TOKEN_POOL_HOOKS_TYPES,
  ...MULTI_TOKEN_POOL_PROVIDER_TYPES,
]
const vendored = (types: readonly MultiTokenPoolContractType[]) =>
  types.map((t) => getMultiTokenPoolInterface(t, MultiTokenPoolVersion.V2_1_0_DEV))

/** A fragment's canonical types: kind, name, inputs and, for a function, outputs (no names). */
function signature(f: Fragment): string {
  const outputs =
    f instanceof FunctionFragment
      ? ` -> (${f.outputs.map((o) => o.format('sighash')).join(',')})`
      : ''
  return `${f.type} ${f.format('sighash')}${outputs}`
}

function assertSubset(stub: Interface, against: Interface[], label: string) {
  const known = new Set(
    against.flatMap((iface) =>
      iface.fragments.filter((f) => f.type !== 'constructor').map(signature),
    ),
  )
  for (const f of stub.fragments.filter((x) => x.type !== 'constructor'))
    assert.ok(
      known.has(signature(f)),
      `${label}: '${signature(f)}' is not in the vendored 2.1.0-dev ABIs`,
    )
}

describe('stack stub vs vendored ABIs (cct/evm multi-token-pool)', () => {
  it('declares only fragments the vendored ABIs declare, with the same types', () => {
    assertSubset(POOL_IFACE, vendored(MULTI_TOKEN_POOL_TYPES), 'POOL_IFACE')
    assertSubset(PCM_IFACE, vendored([POOL_CONFIG_MANAGER_TYPE, ...STORE_TYPES]), 'PCM_IFACE')
    assertSubset(STORE_IFACE, vendored(STORE_TYPES), 'STORE_IFACE')
    assertSubset(AUX_IFACE, vendored(ALL), 'AUX_IFACE')
    assertSubset(TAR_IFACE, [new Interface(TOKEN_ADMIN_REGISTRY_V1_5_0_ABI)], 'TAR_IFACE')
  })

  it('derives the same role ids as the SDK', () => {
    for (const role of POOL_CONFIG_MANAGER_ROLES)
      assert.equal(roleId(role), poolConfigManagerRoleId(role), role)
  })
})
