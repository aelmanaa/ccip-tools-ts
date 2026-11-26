/**
 * Test-support stubs for the Solana simulate/send paths — NOT part of the SDK's public surface.
 *
 * @packageDocumentation
 */

import type { Connection, Keypair, VersionedTransaction } from '@solana/web3.js'

import type { Wallet } from './types.ts'

/** A {@link Wallet} that signs every (versioned) transaction with `keypair`. */
export function keypairWallet(keypair: Keypair): Wallet {
  return {
    publicKey: keypair.publicKey,
    signTransaction: async (tx: VersionedTransaction) => {
      tx.sign([keypair])
      return tx
    },
  } as unknown as Wallet
}

/**
 * A connection that simulates with `simulate` (default: success, 250k units), sends and confirms
 * every v0 transaction, and records what it simulated and sent.
 * @param simulate - The simulation response `value` for each simulated tx.
 */
export function mockSendConnection(
  simulate?: (tx: VersionedTransaction) => Record<string, unknown>,
  blockhash = '11111111111111111111111111111112',
) {
  const simulated: VersionedTransaction[] = []
  const sent: VersionedTransaction[] = []
  const connection = {
    getLatestBlockhash: async () => ({ blockhash, lastValidBlockHeight: 999 }),
    simulateTransaction: async (tx: VersionedTransaction) => {
      simulated.push(tx)
      return { value: simulate?.(tx) ?? { logs: [], unitsConsumed: 250_000 } }
    },
    sendTransaction: async (tx: VersionedTransaction) => `sig-${sent.push(tx)}`,
    confirmTransaction: async () => ({ value: { err: null } }),
  } as unknown as Connection
  return { connection, simulated, sent }
}
