/**
 * Every sealed owner-gated write is re-checked by its own op: the snapshot check's registry must be
 * exactly the owned ops that seal a snapshot.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  ApplyMultiTokenPoolHooksAllowlistUpdates,
  SetMultiTokenPoolHooksBlocklist,
  SetMultiTokenPoolHooksPolicyEngine,
} from '../multi-token-pool-hooks/operations/hooks-config-writes.ts'
import { UpdateMultiTokenPoolHooksAuthorizedCallers } from '../multi-token-pool-hooks/operations/update-multi-token-pool-hooks-authorized-callers.ts'
import { UpdatePolicyStoreAuthorizedCallers } from '../policy-store/operations/update-policy-store-authorized-callers.ts'
import { OWNED_SEALED_OPS } from '../pool-config-manager/operations/check-multi-token-pool-snapshot.ts'
import {
  AcceptMultiTokenPoolHooksOwnership,
  AcceptMultiTokenPoolOwnership,
  AcceptPolicyStoreOwnership,
  TransferMultiTokenPoolHooksOwnership,
  TransferMultiTokenPoolOwnership,
  TransferPolicyStoreOwnership,
} from './operations/ownership-writes.ts'
import { SetMultiTokenPoolRouter } from './operations/set-multi-token-pool-router.ts'
import { SetPoolConfigManager } from './operations/set-pool-config-manager.ts'

describe('sealed owner-gated writes', () => {
  it('the snapshot check registers exactly the owned ops that seal a snapshot', () => {
    const ops = [
      new SetMultiTokenPoolRouter(),
      new SetPoolConfigManager(),
      new TransferMultiTokenPoolOwnership(),
      new AcceptMultiTokenPoolOwnership(),
      new UpdatePolicyStoreAuthorizedCallers(),
      new TransferPolicyStoreOwnership(),
      new AcceptPolicyStoreOwnership(),
      new UpdateMultiTokenPoolHooksAuthorizedCallers(),
      new ApplyMultiTokenPoolHooksAllowlistUpdates(),
      new SetMultiTokenPoolHooksPolicyEngine(),
      new SetMultiTokenPoolHooksBlocklist(),
      new TransferMultiTokenPoolHooksOwnership(),
      new AcceptMultiTokenPoolHooksOwnership(),
    ]
    const sealing = ops
      .filter((op) => (op as unknown as { seals: boolean }).seals)
      .map((op) => op.name)
      .sort()
    assert.deepEqual([...OWNED_SEALED_OPS.keys()].sort(), sealing)
    assert.equal(sealing.length, 4)
  })
})
