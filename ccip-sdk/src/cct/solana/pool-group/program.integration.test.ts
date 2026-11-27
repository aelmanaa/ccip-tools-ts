import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'

import { PublicKey } from '@solana/web3.js'

// Register every chain family the way SDK consumers do via the package root
import '../../../index.ts'
import { rpcEndpoint } from '../../../../../scripts/test-endpoints.ts'
import { useResource } from '../../../../../scripts/useResource.ts'
import { SolanaChain } from '../../../solana/index.ts'
import { CCTOperationUnsupportedError } from '../../errors.ts'
import { TOKEN_POOL_PROGRAMS } from '../programs/token-pool.ts'
import { getPoolGroupProgramFeatures } from './program.ts'
import { POOL_GROUP_FEATURES } from './types.ts'

// Live, read-only (simulations only): the pool-groups program of record on Solana Devnet and the
// canonical burn-mint program. Override the RPC via RPC_SOLANA_DEVNET.
await useResource(['solana-devnet'])
const SOLANA_RPC = rpcEndpoint('RPC_SOLANA_DEVNET')
const skip = !!process.env.SKIP_INTEGRATION_TESTS

const POOL_GROUPS = new PublicKey('22P6h4QV5wswBX63KCncFGctC9dyVRMjykBBDdhwXjg7')

describe('getPoolGroupProgramFeatures on Devnet', { skip, timeout: 120_000 }, () => {
  let chain: SolanaChain
  before(async () => {
    chain = await SolanaChain.fromUrl(SOLANA_RPC)
  })

  it('finds every feature on the stage-2f program', async () => {
    assert.deepEqual(await getPoolGroupProgramFeatures(chain, POOL_GROUPS), [
      ...POOL_GROUP_FEATURES,
    ])
  })

  it('finds none on the canonical burn-mint program', async () => {
    assert.deepEqual(
      await getPoolGroupProgramFeatures(chain, new PublicKey(TOKEN_POOL_PROGRAMS['burn-mint'])),
      [],
    )
  })

  it('fails closed on an account that is not an upgradeable program', async () => {
    await assert.rejects(
      getPoolGroupProgramFeatures(chain, PublicKey.unique()),
      CCTOperationUnsupportedError,
    )
  })
})
