/**
 * A Squads v4 propose/execute harness for fork tests (T1c): multisig creation, vault transactions
 * and batches, proposals, approvals and executes, built with the on-chain IDL and the Squads
 * transaction-message encoding. Test helper only: the SDK has no Squads dependency.
 *
 * @packageDocumentation
 */

import { Buffer } from 'buffer'

import { type Program, BN } from '@coral-xyz/anchor'
import {
  type AddressLookupTableAccount,
  type Connection,
  type Keypair,
  type TransactionInstruction,
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'

import { newProgram } from '../../../solana/coder.ts'
import { simulationProvider } from '../../../solana/utils.ts'
import { SQUADS_V4_IDL, SQUADS_V4_PROGRAM_ID } from './squads-v4-idl.test.helpers.ts'
import type { PoolGroupSquadsTransaction } from './write-types.ts'

const PROGRAM = new PublicKey(SQUADS_V4_PROGRAM_ID)
const seed = (s: string) => Buffer.from(s)
const u64 = (v: bigint) => {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(v)
  return b
}
const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM)[0]

/** Squads v4 PDAs. */
export const squadsPdas = {
  programConfig: () => pda(seed('multisig'), seed('program_config')),
  multisig: (createKey: PublicKey) => pda(seed('multisig'), seed('multisig'), createKey.toBuffer()),
  vault: (multisig: PublicKey, index = 0) =>
    pda(seed('multisig'), multisig.toBuffer(), seed('vault'), Buffer.from([index])),
  transaction: (multisig: PublicKey, index: bigint) =>
    pda(seed('multisig'), multisig.toBuffer(), seed('transaction'), u64(index)),
  proposal: (multisig: PublicKey, index: bigint) =>
    pda(seed('multisig'), multisig.toBuffer(), seed('transaction'), u64(index), seed('proposal')),
  batchTransaction: (multisig: PublicKey, batchIndex: bigint, txIndex: number) => {
    const i = Buffer.alloc(4)
    i.writeUInt32LE(txIndex)
    return pda(
      seed('multisig'),
      multisig.toBuffer(),
      seed('transaction'),
      u64(batchIndex),
      seed('batch_transaction'),
      i,
    )
  },
}

/** A small array: a length prefix of `lenBytes`, then the items. */
function small(lenBytes: 1 | 2, items: Buffer[]): Buffer {
  const len = Buffer.alloc(lenBytes)
  if (lenBytes === 1) len.writeUInt8(items.length)
  else len.writeUInt16LE(items.length)
  return Buffer.concat([len, ...items])
}

/**
 * Squads' `TransactionMessage` encoding of a vault message (`@sqds/multisig`
 * `transactionMessageToMultisigTransactionMessageBytes`): the v0 message compiled with the vault as
 * payer, as signer and writable counts, account keys, compiled instructions (data with a u16 length)
 * and lookups.
 */
export function squadsTransactionMessage(
  vault: PublicKey,
  instructions: TransactionInstruction[],
  tables: AddressLookupTableAccount[],
): {
  bytes: Buffer
  accountKeys: PublicKey[]
  message: ReturnType<TransactionMessage['compileToV0Message']>
} {
  const message = new TransactionMessage({
    payerKey: vault,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions,
  }).compileToV0Message(tables)
  const h = message.header
  const keys = message.staticAccountKeys
  const bytes = Buffer.concat([
    Buffer.from([
      h.numRequiredSignatures,
      h.numRequiredSignatures - h.numReadonlySignedAccounts,
      keys.length - h.numRequiredSignatures - h.numReadonlyUnsignedAccounts,
    ]),
    small(
      1,
      keys.map((k) => k.toBuffer()),
    ),
    small(
      1,
      message.compiledInstructions.map((ix) =>
        Buffer.concat([
          Buffer.from([ix.programIdIndex]),
          small(
            1,
            ix.accountKeyIndexes.map((i) => Buffer.from([i])),
          ),
          small(
            2,
            [...ix.data].map((b) => Buffer.from([b])),
          ),
        ]),
      ),
    ),
    small(
      1,
      message.addressTableLookups.map((l) =>
        Buffer.concat([
          l.accountKey.toBuffer(),
          small(
            1,
            l.writableIndexes.map((i) => Buffer.from([i])),
          ),
          small(
            1,
            l.readonlyIndexes.map((i) => Buffer.from([i])),
          ),
        ]),
      ),
    ),
  ])
  return { bytes, accountKeys: keys, message }
}

/** The accounts `vaultTransactionExecute` / `batchExecuteTransaction` take after their own. */
function executeAccounts(
  vault: PublicKey,
  tx: PoolGroupSquadsTransaction,
): { pubkey: PublicKey; isSigner: false; isWritable: boolean }[] {
  const { message } = squadsTransactionMessage(vault, tx.instructions, tx.lookupTables)
  const loadedW: PublicKey[] = []
  const loadedR: PublicKey[] = []
  for (const l of message.addressTableLookups) {
    const table = tx.lookupTables.find((t) => t.key.equals(l.accountKey))!
    loadedW.push(...l.writableIndexes.map((i) => table.state.addresses[i]!))
    loadedR.push(...l.readonlyIndexes.map((i) => table.state.addresses[i]!))
  }
  return [
    ...message.addressTableLookups.map((l) => ({
      pubkey: l.accountKey,
      isSigner: false as const,
      isWritable: false,
    })),
    ...message.staticAccountKeys.map((pubkey, i) => ({
      pubkey,
      isSigner: false as const,
      // the vault signs by CPI; Squads re-derives writability from the message header
      isWritable: message.isAccountWritable(i),
    })),
    ...loadedW.map((pubkey) => ({ pubkey, isSigner: false as const, isWritable: true })),
    ...loadedR.map((pubkey) => ({ pubkey, isSigner: false as const, isWritable: false })),
  ]
}

/** A Squads v4 client for one multisig on a fork. */
export class SquadsHarness {
  readonly program: Program
  multisig!: PublicKey
  vault!: PublicKey
  /** Measured sizes of the last sent transactions, by name. */
  readonly sizes = new Map<string, { bytes: number; locks: number }>()

  readonly connection: Connection

  constructor(connection: Connection) {
    this.connection = connection
    // the vault message travels in instruction data: the sized coder avoids anchor's 1000 B buffer
    this.program = newProgram(SQUADS_V4_IDL, PROGRAM, simulationProvider({ connection }))
  }

  /** Sends instructions signed by `signers` (the first pays); records the size under `name`. */
  async send(
    name: string,
    signers: Keypair[],
    instructions: TransactionInstruction[],
    tables: AddressLookupTableAccount[] = [],
  ) {
    const { blockhash } = await this.connection.getLatestBlockhash()
    const message = new TransactionMessage({
      payerKey: signers[0]!.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message(tables)
    const tx = new VersionedTransaction(message)
    tx.sign(signers)
    const bytes = tx.serialize().length
    const locks =
      message.staticAccountKeys.length +
      message.addressTableLookups.reduce(
        (n, l) => n + l.writableIndexes.length + l.readonlyIndexes.length,
        0,
      )
    this.sizes.set(name, { bytes, locks })
    const sig = await this.connection.sendTransaction(tx, { skipPreflight: false })
    await this.connection.confirmTransaction(sig, 'confirmed')
    return sig
  }

  /** Creates a `threshold`-of-`members` multisig with every permission, and its vault 0. */
  async create(creator: Keypair, createKey: Keypair, members: PublicKey[], threshold: number) {
    const programConfig = squadsPdas.programConfig()
    const config = await this.program.account.programConfig!.fetch(programConfig)
    this.multisig = squadsPdas.multisig(createKey.publicKey)
    this.vault = squadsPdas.vault(this.multisig)
    const ix = await this.program.methods.multisigCreateV2!({
      configAuthority: null,
      threshold,
      members: members.map((key) => ({ key, permissions: { mask: 7 } })),
      timeLock: 0,
      rentCollector: null,
      memo: null,
    })
      .accountsStrict({
        programConfig,
        treasury: config.treasury as PublicKey,
        multisig: this.multisig,
        createKey: createKey.publicKey,
        creator: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction()
    await this.send('multisigCreateV2', [creator, createKey], [ix])
  }

  /** The next transaction index of the multisig. */
  async nextIndex(): Promise<bigint> {
    const ms = await this.program.account.multisig!.fetch(this.multisig)
    return BigInt((ms.transactionIndex as BN).toString()) + 1n
  }

  /** Proposes one vault transaction; returns its index. */
  async propose(member: Keypair, tx: PoolGroupSquadsTransaction): Promise<bigint> {
    const index = await this.nextIndex()
    const transaction = squadsPdas.transaction(this.multisig, index)
    const { bytes } = squadsTransactionMessage(this.vault, tx.instructions, tx.lookupTables)
    const create = await this.program.methods.vaultTransactionCreate!({
      vaultIndex: 0,
      ephemeralSigners: 0,
      transactionMessage: bytes,
      memo: null,
    })
      .accountsStrict({
        multisig: this.multisig,
        transaction,
        creator: member.publicKey,
        rentPayer: member.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction()
    await this.send('vaultTransactionCreate', [member], [create])
    await this.proposal(member, index, false)
    return index
  }

  /** Creates the proposal of `index`. */
  async proposal(member: Keypair, index: bigint, draft: boolean) {
    const ix = await this.program.methods.proposalCreate!({
      transactionIndex: new BN(index.toString()),
      draft,
    })
      .accountsStrict({
        multisig: this.multisig,
        proposal: squadsPdas.proposal(this.multisig, index),
        creator: member.publicKey,
        rentPayer: member.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction()
    await this.send('proposalCreate', [member], [ix])
  }

  /** Approves the proposal of `index` as each member. */
  async approve(index: bigint, ...members: Keypair[]) {
    for (const member of members) {
      const ix = await this.program.methods.proposalApprove!({ memo: null })
        .accountsStrict({
          multisig: this.multisig,
          member: member.publicKey,
          proposal: squadsPdas.proposal(this.multisig, index),
        })
        .instruction()
      await this.send('proposalApprove', [member], [ix])
    }
  }

  /** Executes the vault transaction of `index`, with the op's outer compute budget. */
  async execute(member: Keypair, index: bigint, tx: PoolGroupSquadsTransaction) {
    const ix = await this.program.methods.vaultTransactionExecute!()
      .accountsStrict({
        multisig: this.multisig,
        proposal: squadsPdas.proposal(this.multisig, index),
        transaction: squadsPdas.transaction(this.multisig, index),
        member: member.publicKey,
      })
      .remainingAccounts(executeAccounts(this.vault, tx))
      .instruction()
    return this.send(
      'vaultTransactionExecute',
      [member],
      [ComputeBudgetProgram.setComputeUnitLimit({ units: tx.computeUnitLimit }), ix],
      tx.lookupTables,
    )
  }

  /** Proposes a batch: `batchCreate`, a draft proposal, one `batchAddTransaction` each, then activate. */
  async proposeBatch(member: Keypair, transactions: PoolGroupSquadsTransaction[]): Promise<bigint> {
    const index = await this.nextIndex()
    const batch = squadsPdas.transaction(this.multisig, index)
    const create = await this.program.methods.batchCreate!({ vaultIndex: 0, memo: null })
      .accountsStrict({
        multisig: this.multisig,
        batch,
        creator: member.publicKey,
        rentPayer: member.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction()
    await this.send('batchCreate', [member], [create])
    await this.proposal(member, index, true)
    for (const [i, tx] of transactions.entries()) {
      const { bytes } = squadsTransactionMessage(this.vault, tx.instructions, tx.lookupTables)
      const add = await this.program.methods.batchAddTransaction!({
        ephemeralSigners: 0,
        transactionMessage: bytes,
      })
        .accountsStrict({
          multisig: this.multisig,
          proposal: squadsPdas.proposal(this.multisig, index),
          batch,
          transaction: squadsPdas.batchTransaction(this.multisig, index, i + 1),
          member: member.publicKey,
          rentPayer: member.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .instruction()
      await this.send('batchAddTransaction', [member], [add])
    }
    const activate = await this.program.methods.proposalActivate!()
      .accountsStrict({
        multisig: this.multisig,
        member: member.publicKey,
        proposal: squadsPdas.proposal(this.multisig, index),
      })
      .instruction()
    await this.send('proposalActivate', [member], [activate])
    return index
  }

  /** Executes every transaction of the batch of `index`, in order. */
  async executeBatch(member: Keypair, index: bigint, transactions: PoolGroupSquadsTransaction[]) {
    for (const [i, tx] of transactions.entries()) {
      const ix = await this.program.methods.batchExecuteTransaction!()
        .accountsStrict({
          multisig: this.multisig,
          member: member.publicKey,
          proposal: squadsPdas.proposal(this.multisig, index),
          batch: squadsPdas.transaction(this.multisig, index),
          transaction: squadsPdas.batchTransaction(this.multisig, index, i + 1),
        })
        .remainingAccounts(executeAccounts(this.vault, tx))
        .instruction()
      await this.send(
        'batchExecuteTransaction',
        [member],
        [ComputeBudgetProgram.setComputeUnitLimit({ units: tx.computeUnitLimit }), ix],
        tx.lookupTables,
      )
    }
  }
}
