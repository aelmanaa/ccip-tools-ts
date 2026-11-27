import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { getAddress } from 'ethers'

import { CCTParamsInvalidError } from '../../../errors.ts'
import { POOL, stackChain } from '../../multi-token-pool/stack.test.helpers.ts'
import {
  ChangeMultiTokenPoolDefaultAdminDelay,
  GrantMultiTokenPoolRole,
  RenounceMultiTokenPoolDefaultAdmin,
  RenounceMultiTokenPoolRole,
  RevokeMultiTokenPoolRole,
} from './role-writes.ts'
import { WithdrawMultiTokenPoolFeeTokens } from './withdraw-multi-token-pool-fee-tokens.ts'

const ACCOUNT = getAddress('0x' + 'a1'.repeat(20))
const TOKEN = getAddress('0x' + 'b2'.repeat(20))

describe('E7 PoolConfigManager writes (cct/evm pool-config-manager)', () => {
  it('refuses bad params before any RPC', async () => {
    const { chain, calls } = stackChain()
    const refused = (param: string) => (e: unknown) =>
      e instanceof CCTParamsInvalidError && e.context.param === param
    const cases: [Promise<unknown>, string][] = [
      // the default admin moves only by the two-step transfer
      [
        new GrantMultiTokenPoolRole().generate(chain, {
          poolAddress: POOL,
          role: 'DEFAULT_ADMIN_ROLE' as never,
          account: ACCOUNT,
        }),
        'role',
      ],
      [
        new RevokeMultiTokenPoolRole().generate(chain, {
          poolAddress: POOL,
          role: 'RATE_LIMIT_ROLE',
          account: '0x12',
        }),
        'account',
      ],
      [
        new RenounceMultiTokenPoolRole().generate(chain, {
          poolAddress: POOL,
          role: 'PAUSER_ROLE',
        } as never),
        'sender',
      ],
      [
        new RenounceMultiTokenPoolDefaultAdmin().generate(chain, {
          poolAddress: POOL,
          sender: ACCOUNT,
          confirmPermanentFreeze: false as never,
        }),
        'confirmPermanentFreeze',
      ],
      [
        new ChangeMultiTokenPoolDefaultAdminDelay().generate(chain, {
          poolAddress: POOL,
          newDelay: 2 ** 48,
        }),
        'newDelay',
      ],
      [
        new WithdrawMultiTokenPoolFeeTokens().generateFrom(chain, {
          poolAddress: POOL,
          feeTokens: [],
          recipient: ACCOUNT,
        }),
        'feeTokens',
      ],
      [
        new WithdrawMultiTokenPoolFeeTokens().generateFrom(chain, {
          poolAddress: POOL,
          feeTokens: [TOKEN],
          recipient: '0x0000000000000000000000000000000000000000',
        }),
        'recipient',
      ],
    ]
    for (const [built, param] of cases) await assert.rejects(built, refused(param))
    assert.deepEqual(calls, [])
  })
})
