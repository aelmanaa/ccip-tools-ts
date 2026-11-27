import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { type PublicKey, AddressLookupTableProgram, Keypair } from '@solana/web3.js'

import type { SolanaChain } from '../../../../solana/index.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { FreezeLookupTable } from './freeze-lookup-table.ts'

const AUTHORITY = Keypair.generate().publicKey
const TABLE = Keypair.generate().publicKey.toBase58()

type Table = { authority?: PublicKey; addresses: PublicKey[]; active?: boolean } | null

/** A chain whose lookup table reads `confirmed`, and `processed` (an extension in flight). */
function stubChain(confirmed: Table, processed: Table = confirmed): SolanaChain {
  const value = (t: Table) =>
    t && {
      state: { authority: t.authority, addresses: t.addresses },
      isActive: () => t.active ?? true,
    }
  return {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    connection: {
      getAddressLookupTable: async (_: PublicKey, opts: { commitment: string }) => ({
        value: value(opts.commitment === 'processed' ? processed : confirmed),
      }),
    },
  } as unknown as SolanaChain
}

const op = new FreezeLookupTable()
const params = {
  lookupTableAddress: TABLE,
  payer: AUTHORITY.toBase58(),
  confirmPermanentFreeze: true as const,
}
const param = (name: string) => (e: unknown) =>
  e instanceof CCTParamsInvalidError && e.context.param === name

describe('FreezeLookupTable', () => {
  const full = { authority: AUTHORITY, addresses: [Keypair.generate().publicKey] }

  it('builds the freeze instruction for a confirmed, non-empty table of the authority', async () => {
    const { instructions } = await op.generate(stubChain(full), params)
    assert.equal(instructions.length, 1)
    assert.ok(instructions[0]!.programId.equals(AddressLookupTableProgram.programId))
  })

  it('refuses without confirmPermanentFreeze, before any RPC', async () => {
    const { confirmPermanentFreeze: _, ...rest } = params
    await assert.rejects(
      op.generate(stubChain(null), { ...rest } as typeof params),
      param('confirmPermanentFreeze'),
    )
  })

  it('refuses a missing, frozen, deactivated, empty or still-extending table', async () => {
    await assert.rejects(op.generate(stubChain(null), params), /not found/)
    await assert.rejects(
      op.generate(stubChain({ addresses: full.addresses }), params),
      /already frozen/,
    )
    await assert.rejects(op.generate(stubChain({ ...full, active: false }), params), /deactivated/)
    await assert.rejects(op.generate(stubChain({ ...full, addresses: [] }), params), /empty/)
    await assert.rejects(
      op.generate(
        stubChain(full, { ...full, addresses: [...full.addresses, Keypair.generate().publicKey] }),
        params,
      ),
      /not confirmed yet/,
    )
  })

  it('refuses another authority', async () => {
    await assert.rejects(
      op.generate(stubChain({ ...full, authority: Keypair.generate().publicKey }), params),
      param('authority'),
    )
  })
})
