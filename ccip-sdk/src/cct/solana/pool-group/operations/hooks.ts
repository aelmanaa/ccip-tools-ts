import { Buffer } from 'buffer'

import { BorshAccountsCoder } from '@coral-xyz/anchor'
import { PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import { getBytes, isHexString, sha256, toUtf8Bytes } from 'ethers'

import type { SolanaChain } from '../../../../solana/index.ts'
import { CCTDataDecodeError, CCTParamsInvalidError } from '../../../errors.ts'
import { SolanaQuery } from '../../query.ts'
import { parsePublicKey } from '../../validate.ts'
import {
  ALLOWLIST_ENTRY_DISCRIMINATOR,
  BLOCKLIST_ENTRY_DISCRIMINATOR,
  normalizeBlocklistAddress,
  poolGroupPdas,
} from '../accounts.ts'
import { decodeHookConfig, keyOrNull } from '../decode.ts'
import type {
  GetPoolGroupHooksParams,
  GetPoolGroupHooksResult,
  GetPoolGroupListEntriesParams,
  GetPoolGroupListEntriesResult,
  HasPoolGroupListEntryParams,
  PoolGroupHookList,
} from '../types.ts'
import { decodeOwned, listProgramAccounts, memcmp, parsePoolGroupProgram } from './common.ts'

const disc = (name: string) => BorshAccountsCoder.accountDiscriminator(name)
const RECORDS = ['Group', 'GroupChainPolicy', 'Policy', 'PolicyChainRecord'] as const
/** `sha256(normalize(address))`, the blocklist entry key. @internal */
export const blocklistKey = (address: Buffer) =>
  Buffer.from(getBytes(sha256(normalizeBlocklistAddress(address))))
const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString('hex')}`

type ProgramOnly = { program: PublicKey }

/** Decodes a hook list (allowlist or blocklist) owned by `program`. @internal */
export async function readHookList(
  operation: string,
  chain: SolanaChain,
  program: PublicKey,
  address: PublicKey,
  param: string,
): Promise<PoolGroupHookList> {
  const account = await chain.connection.getAccountInfo(address)
  if (!account)
    throw new CCTParamsInvalidError(operation, param, `no hook list at ${address.toBase58()}`)
  if (account.data.subarray(0, 8).equals(disc('Allowlist'))) {
    const list = decodeOwned('allowlist', account, address, program)
    return {
      address: address.toBase58(),
      kind: 'allowlist',
      listId: list.listId.toBase58(),
      admin: list.admin.toBase58(),
      proposedAdmin: keyOrNull(list.proposedAdmin),
      enabled: list.enabled,
      entryCount: list.entryCount,
    }
  }
  if (account.data.subarray(0, 8).equals(disc('Blocklist'))) {
    const list = decodeOwned('blocklist', account, address, program)
    return {
      address: address.toBase58(),
      kind: 'blocklist',
      listId: list.blocklistId.toBase58(),
      admin: list.admin.toBase58(),
      proposedAdmin: keyOrNull(list.proposedAdmin),
      entryCount: list.entryCount,
    }
  }
  throw new CCTParamsInvalidError(operation, param, `${address.toBase58()} is not a hook list`)
}

/** Reads a SECURITY record's hook config, its lists and the group's hook authority. */
export class GetPoolGroupHooks extends SolanaQuery<
  GetPoolGroupHooksParams,
  GetPoolGroupHooksResult,
  ProgramOnly & { record: PublicKey }
> {
  readonly name = 'getPoolGroupHooks'

  /** @throws {@link CCTParamsInvalidError} if `record` or the program is invalid */
  protected prepare(params: GetPoolGroupHooksParams) {
    return {
      program: parsePoolGroupProgram(this.name, params),
      record: parsePublicKey(this.name, 'record', params.record),
    }
  }

  /** Decodes the record (a `Group`, `Policy`, chain record or policy chain record) and its lists. */
  protected async read(
    chain: SolanaChain,
    { program, record }: ProgramOnly & { record: PublicKey },
  ): Promise<GetPoolGroupHooksResult> {
    const account = await chain.connection.getAccountInfo(record)
    if (!account)
      throw new CCTParamsInvalidError(this.name, 'record', `no account at ${record.toBase58()}`)
    const kind = RECORDS.find((name) => account.data.subarray(0, 8).equals(disc(name)))
    let security, group
    switch (kind) {
      case 'Group': {
        const decoded = decodeOwned('group', account, record, program)
        ;[security, group] = [decoded.defaultPolicy.security, record]
        break
      }
      case 'GroupChainPolicy': {
        const decoded = decodeOwned('groupChainPolicy', account, record, program)
        ;[security, group] = [decoded.policy.security, decoded.group]
        break
      }
      case 'Policy': {
        const decoded = decodeOwned('policy', account, record, program)
        ;[security, group] = [decoded.defaultPolicy.security, decoded.group]
        break
      }
      case 'PolicyChainRecord': {
        const decoded = decodeOwned('policyChainRecord', account, record, program)
        ;[security, group] = [decoded.sections.security, decoded.group]
        break
      }
      default:
        throw new CCTParamsInvalidError(this.name, 'record', 'not a pool group SECURITY record')
    }
    const hook = security.hook ? decodeHookConfig(security.hook) : null
    const lists: PoolGroupHookList[] = []
    for (const list of [hook?.allowlist, hook?.blocklist])
      if (list)
        lists.push(await readHookList(this.name, chain, program, new PublicKey(list), 'record'))
    return {
      hook,
      lists,
      hookAuthority: poolGroupPdas.hookAuthority(program, group).toBase58(),
    }
  }
}

/** `e445a52e51cb9a1d`: Anchor's `emit_cpi!` instruction tag, then the event discriminator. */
const EVENT_IX_TAG = Buffer.from('e445a52e51cb9a1d', 'hex')
const LIST_UPDATED = Buffer.from(getBytes(sha256(toUtf8Bytes('event:ListUpdated')))).subarray(0, 8)

/** Decodes a `ListUpdated` self-CPI payload (after the 16-byte tag): list, added, removed. */
function decodeListUpdated(data: Buffer): { list: string; added: Buffer[] } | undefined {
  let at = 16 + 32
  if (data.length < at) return
  const list = new PublicKey(data.subarray(16, at)).toBase58()
  if (at + 4 > data.length) return
  const count = data.readUInt32LE(at)
  at += 4
  const added: Buffer[] = []
  for (let i = 0; i < count; i++) {
    if (at + 4 > data.length) return
    const len = data.readUInt32LE(at)
    at += 4
    if (at + len > data.length) return
    added.push(data.subarray(at, at + len))
    at += len
  }
  return { list, added }
}

/** Lists a hook list's entries. */
export class GetPoolGroupListEntries extends SolanaQuery<
  GetPoolGroupListEntriesParams,
  GetPoolGroupListEntriesResult,
  ProgramOnly & { list: PublicKey; fromSlot?: bigint }
> {
  readonly name = 'getPoolGroupListEntries'

  /** @throws {@link CCTParamsInvalidError} if `list`, the program or `fromSlot` is invalid */
  protected prepare(params: GetPoolGroupListEntriesParams) {
    if (
      params.fromSlot !== undefined &&
      (typeof params.fromSlot !== 'bigint' || params.fromSlot < 0n)
    )
      throw new CCTParamsInvalidError(this.name, 'fromSlot', 'must be a non-negative bigint')
    return {
      program: parsePoolGroupProgram(this.name, params),
      list: parsePublicKey(this.name, 'list', params.list),
      ...(params.fromSlot !== undefined && { fromSlot: params.fromSlot }),
    }
  }

  /**
   * Allowlist: entries by `getProgramAccounts` (memcmp on the list @10), sender @42. Blocklist:
   * entry hashes the same way, and addresses from the `ListUpdated` events (self-CPI inner
   * instructions) of the list's transactions back to `fromSlot`.
   */
  protected async read(
    chain: SolanaChain,
    { program, list, fromSlot }: ProgramOnly & { list: PublicKey; fromSlot?: bigint },
  ): Promise<GetPoolGroupListEntriesResult> {
    const { kind } = await readHookList(this.name, chain, program, list, 'list')
    const entries = await listProgramAccounts(
      this.name,
      chain,
      program,
      [
        memcmp(
          0,
          kind === 'allowlist' ? ALLOWLIST_ENTRY_DISCRIMINATOR : BLOCKLIST_ENTRY_DISCRIMINATOR,
        ),
        memcmp(10, list.toBytes()),
      ],
      'check single entries with hasPoolGroupListEntry',
    )
    const field = (data: Buffer) => {
      if (data.length < 74)
        throw new CCTDataDecodeError(list.toBase58(), { context: { reason: 'short list entry' } })
      return data.subarray(42, 74)
    }
    if (kind === 'allowlist')
      return {
        kind,
        complete: true,
        entries: entries.map(({ account }) => {
          const sender = field(account.data)
          return {
            address: new PublicKey(sender).toBase58(),
            addressHash: hex(blocklistKey(Buffer.from(sender))),
          }
        }),
      }
    const hashes = entries.map(({ account }) => hex(field(account.data)))
    const addresses = new Map<string, string>()
    const wanted = new Set(hashes)
    let before: string | undefined
    scan: for (;;) {
      const sigs = await chain.connection.getSignaturesForAddress(list, { before, limit: 1000 })
      if (!sigs.length) break
      for (const sig of sigs) {
        if (fromSlot !== undefined && BigInt(sig.slot) < fromSlot) break scan
        if (sig.err) continue
        const tx = await chain.connection.getTransaction(sig.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        })
        const keys = tx?.transaction.message.getAccountKeys({
          accountKeysFromLookups: tx.meta?.loadedAddresses,
        })
        for (const { instructions } of tx?.meta?.innerInstructions ?? [])
          for (const ix of instructions) {
            if (!keys?.get(ix.programIdIndex)?.equals(program)) continue
            const data = Buffer.from(bs58.decode(ix.data))
            if (
              !data.subarray(0, 8).equals(EVENT_IX_TAG) ||
              !data.subarray(8, 16).equals(LIST_UPDATED)
            )
              continue
            const event = decodeListUpdated(data)
            if (event?.list !== list.toBase58()) continue
            for (const added of event.added) {
              const key = hex(blocklistKey(added))
              if (wanted.has(key) && !addresses.has(key))
                addresses.set(key, hex(normalizeBlocklistAddress(added)))
            }
          }
        if (addresses.size === wanted.size) break scan
      }
      before = sigs[sigs.length - 1]!.signature
    }
    return {
      kind,
      complete: addresses.size === wanted.size,
      entries: hashes.map((addressHash) => ({
        ...(addresses.has(addressHash) && { address: addresses.get(addressHash)! }),
        addressHash,
      })),
    }
  }
}

/** Parses a list address: base58 (Solana) or `0x` hex (any chain). */
function addressBytes(operation: string, value: unknown): Buffer {
  if (typeof value === 'string' && isHexString(value) && value.length > 2)
    return Buffer.from(getBytes(value))
  return parsePublicKey(operation, 'address', value).toBuffer()
}

/** Reads whether an address is on a hook list (its entry PDA exists). */
export class HasPoolGroupListEntry extends SolanaQuery<
  HasPoolGroupListEntryParams,
  boolean,
  ProgramOnly & { list: PublicKey; address: Buffer }
> {
  readonly name = 'hasPoolGroupListEntry'

  /** @throws {@link CCTParamsInvalidError} if `list`, `address` or the program is invalid */
  protected prepare(params: HasPoolGroupListEntryParams) {
    return {
      program: parsePoolGroupProgram(this.name, params),
      list: parsePublicKey(this.name, 'list', params.list),
      address: addressBytes(this.name, params.address),
    }
  }

  /** Derives the entry PDA (allowlist: the sender; blocklist: the normalized address hash). */
  protected async read(
    chain: SolanaChain,
    { program, list, address }: ProgramOnly & { list: PublicKey; address: Buffer },
  ): Promise<boolean> {
    const { kind } = await readHookList(this.name, chain, program, list, 'list')
    if (kind === 'allowlist' && address.length !== 32)
      throw new CCTParamsInvalidError(this.name, 'address', 'an allowlist holds Solana senders')
    const entry =
      kind === 'allowlist'
        ? poolGroupPdas.allowlistEntry(program, list, new PublicKey(address))
        : poolGroupPdas.blocklistEntry(program, list, blocklistKey(address))
    const account = await chain.connection.getAccountInfo(entry)
    return !!account?.owner.equals(program)
  }
}
