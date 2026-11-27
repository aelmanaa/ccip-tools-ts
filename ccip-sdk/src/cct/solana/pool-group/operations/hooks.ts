import { Buffer } from 'buffer'

import { BorshAccountsCoder, BorshEventCoder } from '@coral-xyz/anchor'
import { PublicKey } from '@solana/web3.js'
import { getBytes, isHexString, sha256, toUtf8Bytes } from 'ethers'

import { CCIPTransactionNotFoundError } from '../../../../errors/index.ts'
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
import { POOL_GROUPS_PROGRAM_IDL } from '../program.ts'
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
      poolGroupAddress: list.group.toBase58(),
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
    const lists: PoolGroupHookList[] = await Promise.all(
      [hook?.allowlist, hook?.blocklist].flatMap((list) =>
        list ? [readHookList(this.name, chain, program, new PublicKey(list), 'record')] : [],
      ),
    )
    return {
      hook,
      lists,
      hookAuthority: poolGroupPdas.hookAuthority(program, group).toBase58(),
    }
  }
}

/** Decodes the pool program's events from core's parsed logs (`emit_cpi!` payloads). */
const eventCoder = new BorshEventCoder(POOL_GROUPS_PROGRAM_IDL)
/** Hex topic of `ListUpdated` (its event discriminator), as core's parsed logs carry it. */
const LIST_UPDATED_TOPIC = hex(
  Buffer.from(getBytes(sha256(toUtf8Bytes('event:ListUpdated')))).subarray(0, 8),
)
/** Transactions of a list fetched at once while scanning its history. */
const TX_CONCURRENCY = 4

/**
 * The `ListUpdated` events for `list` in one transaction, from core `getTransaction` (which resolves
 * v0 lookup-table keys and checks each self-CPI's event authority); `[]` when the RPC no longer has
 * the transaction.
 */
async function listUpdatesIn(
  chain: SolanaChain,
  program: PublicKey,
  list: PublicKey,
  signature: string,
): Promise<Buffer[][]> {
  let tx
  try {
    tx = await chain.getTransaction(signature)
  } catch (err) {
    if (err instanceof CCIPTransactionNotFoundError) return []
    throw err
  }
  const out: Buffer[][] = []
  for (const log of tx.logs) {
    if (log.address !== program.toBase58() || log.topics[0] !== LIST_UPDATED_TOPIC) continue
    if (typeof log.data !== 'string') continue
    const event = eventCoder.decode(log.data)
    if (event?.name !== 'ListUpdated') continue
    const { list: eventList, added } = event.data
    if (!(eventList instanceof PublicKey) || !eventList.equals(list) || !Array.isArray(added))
      continue
    out.push(added.flatMap((a: unknown) => (a instanceof Uint8Array ? [Buffer.from(a)] : [])))
  }
  return out
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
    const { kind, entryCount } = await readHookList(this.name, chain, program, list, 'list')
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
      {
        param: 'connection',
        fix: 'listing entries needs it; check single entries with hasPoolGroupListEntry',
      },
    )
    const field = (data: Buffer) => {
      if (data.length < 74)
        throw new CCTDataDecodeError(list.toBase58(), { context: { reason: 'short list entry' } })
      return data.subarray(42, 74)
    }
    if (kind === 'allowlist')
      return {
        kind,
        // a listing shorter than the list's count is a truncated RPC answer
        complete: entries.length === entryCount,
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
    // newest first, so the newest add of a present hash wins; stops once every hash has an address
    scan: while (wanted.size > addresses.size) {
      const sigs = await chain.connection.getSignaturesForAddress(list, { before, limit: 1000 })
      if (!sigs.length) break
      const page = sigs.filter((sig) => fromSlot === undefined || BigInt(sig.slot) >= fromSlot)
      const done = page.length < sigs.length
      const ok = page.filter((sig) => !sig.err)
      for (let i = 0; i < ok.length; i += TX_CONCURRENCY) {
        const updates = await Promise.all(
          ok
            .slice(i, i + TX_CONCURRENCY)
            .map((sig) => listUpdatesIn(chain, program, list, sig.signature)),
        )
        for (const added of updates.flat(2)) {
          const key = hex(blocklistKey(added))
          if (wanted.has(key) && !addresses.has(key))
            addresses.set(key, hex(normalizeBlocklistAddress(added)))
        }
        if (addresses.size === wanted.size) break scan
      }
      if (done) break
      before = sigs[sigs.length - 1]!.signature
    }
    return {
      kind,
      // a listing shorter than the list's count is a truncated RPC answer
      complete: addresses.size === wanted.size && hashes.length === entryCount,
      entries: hashes.map((addressHash) => ({
        ...(addresses.has(addressHash) && { address: addresses.get(addressHash)! }),
        addressHash,
      })),
    }
  }
}

/** Parses a list address: base58 (Solana) or `0x` hex (any chain). */
function addressBytes(operation: string, value: unknown): Buffer {
  if (typeof value === 'string' && value.startsWith('0x')) {
    // `0` is not base58, so a `0x` value is hex or invalid, never a Solana address
    if (!isHexString(value) || value.length <= 2 || value.length % 2)
      throw new CCTParamsInvalidError(
        operation,
        'address',
        'must be even-length `0x` hex, or base58',
      )
    return Buffer.from(getBytes(value))
  }
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
