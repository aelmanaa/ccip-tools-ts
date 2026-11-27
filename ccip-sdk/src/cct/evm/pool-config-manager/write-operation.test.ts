import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { EVMChain } from '../../../evm/index.ts'
import { CCTDataDecodeError } from '../../errors.ts'
import {
  type PoolConfigManagerRole,
  POOL_CONFIG_MANAGER_TYPE,
  getMultiTokenPoolInterface,
} from '../multi-token-pool/contracts.ts'
import { OWNER, PCM, stackChain } from '../multi-token-pool/stack.test.helpers.ts'
import {
  type PoolConfigManagerWrite,
  type PoolConfigManagerWriteContext,
  type PoolConfigManagerWriteParams,
  PoolConfigManagerWriteOperation,
} from './write-operation.ts'

/** A broken op: it skips the record read, yet encodes a record-changing write (a global pause). */
class RecordFreeButPauses extends PoolConfigManagerWriteOperation<PoolConfigManagerWriteParams> {
  readonly name = 'pauseMultiTokenPoolGlobally'
  protected override changesRecords(): boolean {
    return false
  }
  protected override readFacts() {
    return { 'admin.defaultAdmin': OWNER }
  }
  protected sealedFrom() {
    return {}
  }
  protected gate(): readonly PoolConfigManagerRole[] {
    return ['DEFAULT_ADMIN_ROLE']
  }
  protected encode(
    _chain: EVMChain,
    _params: PoolConfigManagerWriteParams,
    { version }: PoolConfigManagerWriteContext,
  ): PoolConfigManagerWrite {
    return {
      data: getMultiTokenPoolInterface(POOL_CONFIG_MANAGER_TYPE, version).encodeFunctionData(
        'pauseGlobally',
        [],
      ),
    }
  }
}

describe('PoolConfigManagerWriteOperation', () => {
  it('refuses a record-free write whose calldata changes records (an SDK bug)', async () => {
    const { chain } = stackChain()
    await assert.rejects(
      new RecordFreeButPauses().generate(chain, { poolConfigManager: PCM, sender: OWNER }),
      (e: unknown) => {
        assert.ok(e instanceof CCTDataDecodeError)
        assert.equal(e.context.function, 'pauseGlobally')
        return true
      },
    )
  })
})
