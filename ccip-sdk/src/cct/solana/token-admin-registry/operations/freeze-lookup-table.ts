import { type PublicKey, AddressLookupTableProgram } from '@solana/web3.js'

import { ChainFamily } from '../../../../networks.ts'
import type { SolanaChain } from '../../../../solana/index.ts'
import type { UnsignedSolanaTx } from '../../../../solana/types.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import type { TransactionResult } from '../../../operation.ts'
import {
  type SolanaExecuteParams,
  type SolanaGenerateParams,
  SolanaOperation,
} from '../../operation.ts'
import { submit } from '../../submit.ts'
import { parsePublicKey, validateAuthorityMatchesWallet } from '../../validate.ts'

/** Parameters shared by Solana `freezeLookupTable` generation and execution. */
type FreezeLookupTableParams = {
  /** The lookup table to freeze. */
  lookupTableAddress: string
  /** ALT authority. Defaults to payer for unsigned generation and wallet public key for execute. */
  authority?: string
  /**
   * Must be `true`: a frozen table can never be extended or closed again, so the caller confirms it
   * (as EVM's permanent renounce does).
   */
  confirmPermanentFreeze: true
}

/** Parameters for unsigned Solana lookup table freezing. */
export type GenerateFreezeLookupTableParams = SolanaGenerateParams<FreezeLookupTableParams>
/** Unsigned freeze lookup table result. */
export type GenerateFreezeLookupTableResult = UnsignedSolanaTx
/** Parameters for executing Solana `freezeLookupTable`. */
export type ExecuteFreezeLookupTableParams = SolanaExecuteParams<FreezeLookupTableParams>
/** Result of executing Solana `freezeLookupTable`. */
export type ExecuteFreezeLookupTableResult = TransactionResult

type ParsedFreezeLookupTableParams = {
  payer: PublicKey
  authority: PublicKey
  lookupTableAddress: PublicKey
}

/**
 * Freezes an address lookup table: its contents can no longer change and its authority is dropped.
 * Generic, not pool-group specific (CLI ADR §15 item 10).
 */
export class FreezeLookupTable extends SolanaOperation<
  FreezeLookupTableParams,
  GenerateFreezeLookupTableResult,
  ParsedFreezeLookupTableParams
> {
  readonly name = 'freezeLookupTable'

  /** Parses all public keys before any RPC. */
  protected override prepare(
    params: GenerateFreezeLookupTableParams,
  ): ParsedFreezeLookupTableParams {
    // checked at runtime too: a JavaScript caller may omit it
    const confirmed: unknown = params.confirmPermanentFreeze
    if (confirmed !== true)
      throw new CCTParamsInvalidError(
        this.name,
        'confirmPermanentFreeze',
        'freezing is permanent (the table can never be extended or closed again): pass confirmPermanentFreeze: true',
      )
    const payer = parsePublicKey(this.name, 'payer', params.payer)
    return {
      payer,
      authority:
        params.authority === undefined
          ? payer
          : parsePublicKey(this.name, 'authority', params.authority),
      lookupTableAddress: parsePublicKey(
        this.name,
        'lookupTableAddress',
        params.lookupTableAddress,
      ),
    }
  }

  /**
   * Builds the freeze instruction. The table is read at `confirmed` and refused when it is missing,
   * empty, deactivated, already frozen, of another authority, or still being extended (an extension
   * not yet confirmed would be lost: tables are frozen only after their extension is confirmed).
   * @throws {@link CCTParamsInvalidError} on any of those
   */
  protected async buildUnsigned(
    chain: SolanaChain,
    { authority, lookupTableAddress }: ParsedFreezeLookupTableParams,
  ): Promise<GenerateFreezeLookupTableResult> {
    const param = 'lookupTableAddress'
    const where = lookupTableAddress.toBase58()
    const [confirmed, processed] = await Promise.all([
      chain.connection.getAddressLookupTable(lookupTableAddress, { commitment: 'confirmed' }),
      chain.connection.getAddressLookupTable(lookupTableAddress, { commitment: 'processed' }),
    ])
    const table = confirmed.value
    if (!table)
      throw new CCTParamsInvalidError(this.name, param, `lookup table not found: ${where}`)
    if (!table.state.authority)
      throw new CCTParamsInvalidError(
        this.name,
        param,
        `the lookup table ${where} is already frozen`,
      )
    if (!table.isActive())
      throw new CCTParamsInvalidError(this.name, param, `the lookup table ${where} is deactivated`)
    if (!table.state.addresses.length)
      throw new CCTParamsInvalidError(
        this.name,
        param,
        `the lookup table ${where} is empty: a frozen empty table can never be used`,
      )
    if ((processed.value?.state.addresses.length ?? 0) !== table.state.addresses.length)
      throw new CCTParamsInvalidError(
        this.name,
        param,
        `the lookup table ${where} has an extension that is not confirmed yet: freeze it once the extension is confirmed`,
      )
    if (!table.state.authority.equals(authority))
      throw new CCTParamsInvalidError(
        this.name,
        'authority',
        `authority mismatch; ALT authority is ${table.state.authority.toBase58()}`,
      )
    return {
      family: ChainFamily.Solana,
      instructions: [
        AddressLookupTableProgram.freezeLookupTable({ lookupTable: lookupTableAddress, authority }),
      ],
      mainIndex: 0,
    }
  }

  /** Generate, sign, simulate, send, and confirm with wallet.publicKey as payer and authority. */
  override async execute(
    chain: SolanaChain,
    params: ExecuteFreezeLookupTableParams,
  ): Promise<ExecuteFreezeLookupTableResult> {
    const { wallet, computeUnits, parsed } = this.prepareWalletExecution(chain, params)
    if (params.authority !== undefined)
      validateAuthorityMatchesWallet(
        this.name,
        parsed.authority,
        wallet.publicKey,
        'freezeLookupTable requires authority to be the executing wallet. Use generateUnsignedFreezeLookupTable for vault-owned ALTs and have the vault sign/execute it.',
      )
    return submit(
      chain,
      wallet,
      await this.buildUnsigned(chain, parsed),
      this.name,
      computeUnits,
      this.splitMode,
    )
  }
}
