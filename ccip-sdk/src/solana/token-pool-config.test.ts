import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'

import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { type Connection, Keypair, PublicKey } from '@solana/web3.js'

import { parseTypeAndVersion } from '../utils.ts'
import { SolanaChain } from './index.ts'

const POOL_STATE_SEED = Buffer.from('ccip_tokenpool_config')
const POOL_SIGNER_SEED = Buffer.from('ccip_tokenpool_signer')

/**
 * Lays out a base-token-pool `State` account: 8B anchor discriminator, `version:u8`, then
 * `BaseConfig`'s token_program, mint, decimals, pool_signer, pool_token_account, owner,
 * proposed_owner, rate_limit_admin, router_onramp_authority, router.
 */
function makePoolState(program: PublicKey) {
  const mint = Keypair.generate().publicKey
  const [statePda] = PublicKey.findProgramAddressSync([POOL_STATE_SEED, mint.toBuffer()], program)
  const [poolSigner] = PublicKey.findProgramAddressSync(
    [POOL_SIGNER_SEED, mint.toBuffer()],
    program,
  )
  const poolTokenAccount = getAssociatedTokenAddressSync(mint, poolSigner, true, TOKEN_PROGRAM_ID)
  const router = Keypair.generate().publicKey

  const data = Buffer.alloc(298)
  mint.toBuffer().copy(data, 41)
  data[73] = 9 // decimals
  poolSigner.toBuffer().copy(data, 74)
  poolTokenAccount.toBuffer().copy(data, 106)
  router.toBuffer().copy(data, 266)

  return { mint, statePda, poolSigner, poolTokenAccount, router, data }
}

function makeChain(program: PublicKey, data: Buffer, typeAndVersion: string) {
  const chain = Object.create(SolanaChain.prototype) as SolanaChain
  Object.assign(chain, {
    connection: {
      getAccountInfo: mock.fn(() => Promise.resolve({ owner: program, data })),
    } as unknown as Connection,
    typeAndVersion: mock.fn(() => Promise.resolve(parseTypeAndVersion(typeAndVersion))),
  })
  return chain
}

describe('SolanaChain.getTokenPoolConfig', () => {
  it('reports pool_signer as lockBox for a lock/release pool', async () => {
    const program = Keypair.generate().publicKey
    const { mint, statePda, poolSigner, poolTokenAccount, router, data } = makePoolState(program)
    // the deployed crate reports its directory name: `lockrelease`, one word
    const chain = makeChain(program, data, 'lockrelease-token-pool 1.6.2')

    const config = await chain.getTokenPoolConfig(statePda.toBase58())
    assert.equal(config.token, mint.toBase58())
    assert.equal(config.router, router.toBase58())
    assert.equal(config.tokenPoolProgram, program.toBase58())
    assert.equal(config.lockBox, poolSigner.toBase58())
    // Chain.checkExecute calls getBalance({ holder: lockBox }), which resolves the holder's ATA.
    // So lockBox must be the ATA's *owner* (pool_signer), not the token account itself, and
    // resolving it must land on the pool's `pool_token_account` — not on the state PDA's ATA,
    // which holds nothing and does not even exist on-chain.
    const owner = new PublicKey(config.lockBox)
    assert.equal(
      getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID).toBase58(),
      poolTokenAccount.toBase58(),
    )
    assert.notEqual(config.lockBox, poolTokenAccount.toBase58())
    assert.notEqual(config.lockBox, statePda.toBase58())
  })

  it('omits lockBox for a burn/mint pool, which holds no liquidity', async () => {
    const program = Keypair.generate().publicKey
    const { statePda, data } = makePoolState(program)
    const chain = makeChain(program, data, 'burnmint-token-pool 1.6.2')

    const config = await chain.getTokenPoolConfig(statePda.toBase58())
    assert.ok(!('lockBox' in config))
  })
})
