import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BN, BorshAccountsCoder } from '@coral-xyz/anchor'
import { type Connection, Keypair, PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import { getAddress, getBytes, sha256, toUtf8Bytes } from 'ethers'

import '../../../index.ts'
import { networkInfo } from '../../../networks.ts'
import { SolanaChain } from '../../../solana/index.ts'
import { CCTDataDecodeError, CCTParamsInvalidError } from '../../errors.ts'
import { deriveTokenPoolGlobalConfigPda } from '../programs/token-pool.ts'
import { GROUP_CHAIN_POLICY_FIXED_LEN, poolGroupPdas, poolGroupsCoder } from './accounts.ts'
import { decodeClassBits, decodeHookConfig, decodeLaneMode, decodeSections } from './decode.ts'
import { blocklistKey } from './operations/hooks.ts'
import {
  GetPoolGroup,
  GetPoolGroupChain,
  GetPoolGroupHooks,
  GetPoolGroupListEntries,
  GetPoolGroupMembers,
  GetPoolGroupPolicy,
  GetTokenPoolGlobalConfig,
  HasPoolGroupListEntry,
} from './operations/index.ts'

const PROGRAM = Keypair.generate().publicKey
const OTHER = Keypair.generate().publicKey
const GROUP_ID = Keypair.generate().publicKey
const GROUP = poolGroupPdas.group(PROGRAM, GROUP_ID)
const OWNER = Keypair.generate().publicKey
const SEPOLIA = networkInfo('ethereum-testnet-sepolia').chainSelector
const disc = (name: string) => BorshAccountsCoder.accountDiscriminator(name)
const bn = (v: bigint | number) => new BN(v.toString())
const u32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}

function encode(name: string, patch: (v: Record<string, unknown>) => void = () => {}): Buffer {
  const value = poolGroupsCoder.types.decode<Record<string, unknown>>(name, Buffer.alloc(4096))
  patch(value)
  return Buffer.concat([disc(name), poolGroupsCoder.types.encode(name, value)])
}

type Accounts = Map<string, { data: Buffer; owner: PublicKey }>

function chainWith(accounts: Accounts, extra: Record<string, unknown> = {}): SolanaChain {
  const get = (key: PublicKey) => {
    const a = accounts.get(key.toBase58())
    return a ? { ...a, lamports: 1, executable: false } : null
  }
  const connection = {
    getAccountInfo: async (key: PublicKey) => get(key),
    getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map(get),
    getProgramAccounts: async (
      program: PublicKey,
      { filters }: { filters: { memcmp: { offset: number; bytes: string } }[] },
    ) =>
      [...accounts.entries()]
        .filter(([, a]) => a.owner.equals(program))
        .filter(([, a]) =>
          filters.every(({ memcmp: { offset, bytes } }) =>
            a.data
              .subarray(offset)
              .subarray(0, bs58.decode(bytes).length)
              .equals(Buffer.from(bs58.decode(bytes))),
          ),
        )
        .map(([k, a]) => ({
          pubkey: new PublicKey(k),
          account: { ...a, lamports: 1, executable: false },
        })),
    getSignaturesForAddress: async () => [],
    ...extra,
  } as unknown as Connection
  return new SolanaChain(connection, networkInfo('solana-devnet'), { apiClient: null })
}

const groupData = (patch: (v: Record<string, unknown>) => void = () => {}) =>
  encode('Group', (v) => {
    Object.assign(v, { version: 1, groupId: GROUP_ID, owner: OWNER, chainSelectors: [bn(SEPOLIA)] })
    patch(v)
  })

function memberData(mint: PublicKey, index: number, group = GROUP): Buffer {
  return Buffer.concat([
    disc('GroupMember'),
    Buffer.from([1, 255]),
    group.toBuffer(),
    mint.toBuffer(),
    u32(index),
    u32(0),
    PublicKey.default.toBuffer(),
    u32(0),
    u32(0),
  ])
}

const base = () => new Map([[GROUP.toBase58(), { data: groupData(), owner: PROGRAM }]]) as Accounts
const ref = { poolProgramAddress: PROGRAM.toBase58(), poolGroupAddress: GROUP.toBase58() }

describe('pool-group refs', () => {
  it('needs exactly one of poolGroupAddress and poolGroupId; the id derives the PDA', async () => {
    const op = new GetPoolGroup()
    const chain = chainWith(base())
    await assert.rejects(
      op.query(chain, { poolProgramAddress: PROGRAM.toBase58() } as never),
      CCTParamsInvalidError,
    )
    await assert.rejects(
      op.query(chain, { ...ref, poolGroupId: GROUP_ID.toBase58() } as never),
      CCTParamsInvalidError,
    )
    // the id derives the PDA: the group is found, its chain record is not
    await assert.rejects(
      new GetPoolGroupChain().query(chain, {
        poolProgramAddress: PROGRAM.toBase58(),
        poolGroupId: GROUP_ID.toBase58(),
        remoteChainSelector: SEPOLIA,
      }),
      /no chain record/,
    )
  })

  it('refuses a missing group, another owner, or another program', async () => {
    const op = new GetPoolGroupChain()
    const q = { ...ref, remoteChainSelector: SEPOLIA }
    await assert.rejects(op.query(chainWith(new Map()), q), /no pool group/)
    await assert.rejects(
      op.query(chainWith(base()), { ...q, expectedOwner: OTHER.toBase58() }),
      /owned by/,
    )
    const foreign: Accounts = new Map([[GROUP.toBase58(), { data: groupData(), owner: OTHER }]])
    await assert.rejects(op.query(chainWith(foreign), q), CCTDataDecodeError)
  })
})

describe('getPoolGroupChain', () => {
  it('joins the subset bitmap with the current members, stale bits apart', async () => {
    const accounts = base()
    const gcp = Buffer.alloc(GROUP_CHAIN_POLICY_FIXED_LEN)
    encode('GroupChainPolicy', (v) => {
      Object.assign(v, {
        version: 1,
        group: GROUP,
        remoteChainSelector: bn(SEPOLIA),
        laneMode: { subset: {} },
        inheritsDefault: 0b0101,
      })
    }).copy(gcp)
    const address = poolGroupPdas.groupChain(PROGRAM, GROUP, SEPOLIA)
    accounts.set(address.toBase58(), {
      data: Buffer.concat([gcp, Buffer.from([0b0000_0101])]),
      owner: PROGRAM,
    })
    const mint = Keypair.generate().publicKey
    accounts.set(Keypair.generate().publicKey.toBase58(), {
      data: memberData(mint, 0),
      owner: PROGRAM,
    })
    // a member of another group at index 2 does not count
    accounts.set(Keypair.generate().publicKey.toBase58(), {
      data: memberData(Keypair.generate().publicKey, 2, OTHER),
      owner: PROGRAM,
    })
    const result = await new GetPoolGroupChain().query(chainWith(accounts), {
      ...ref,
      remoteChainSelector: SEPOLIA,
    })
    assert.equal(result.laneMode, 'subset')
    assert.deepEqual(result.inheritsDefault, ['connection', 'rateLimit'])
    assert.deepEqual(result.subsetMemberIndices, [0, 2])
    assert.deepEqual(result.subsetTokens, [mint.toBase58()])
    assert.deepEqual(result.staleSubsetMemberIndices, [2])
    await assert.rejects(
      new GetPoolGroupChain().query(chainWith(base()), { ...ref, remoteChainSelector: 1n }),
      /no chain record/,
    )
  })
})

describe('getPoolGroupMembers', () => {
  it('reads named mints by PDA, refuses a non-member; lists by getProgramAccounts', async () => {
    const accounts = base()
    const mint = Keypair.generate().publicKey
    accounts.set(poolGroupPdas.groupMember(PROGRAM, mint).toBase58(), {
      data: memberData(mint, 3),
      owner: PROGRAM,
    })
    const op = new GetPoolGroupMembers()
    const named = await op.query(chainWith(accounts), { ...ref, tokenAddresses: [mint.toBase58()] })
    assert.equal(named.registry, null)
    assert.equal(named.poolGroupMembers[0]?.memberIndex, 3)
    await assert.rejects(
      op.query(chainWith(accounts), { ...ref, tokenAddresses: [OTHER.toBase58()] }),
      /is not a member/,
    )
    await assert.rejects(
      op.query(chainWith(accounts), { ...ref, tokenAddresses: [mint.toBase58(), mint.toBase58()] }),
      /duplicate/,
    )
    const listed = await op.query(chainWith(accounts), ref)
    assert.equal(listed.poolGroupMembers.length, 1)
    // an RPC that refuses getProgramAccounts
    const refusing = chainWith(accounts, {
      getProgramAccounts: async () => {
        throw new Error('410 Gone: getProgramAccounts is disabled')
      },
    })
    await assert.rejects(op.query(refusing, ref), /pass tokenAddresses explicitly/)
  })
})

describe('getPoolGroupPolicy', () => {
  it('decodes a policy and its chain records; a missing record is refused', async () => {
    const accounts = base()
    const policy = poolGroupPdas.policy(PROGRAM, GROUP, 4)
    accounts.set(policy.toBase58(), {
      data: encode('Policy', (v) => {
        Object.assign(v, {
          version: 1,
          group: GROUP,
          policyId: 4,
          classes: 3,
          chainSelectors: [bn(SEPOLIA)],
        })
      }),
      owner: PROGRAM,
    })
    const op = new GetPoolGroupPolicy()
    const plain = await op.query(chainWith(accounts), { ...ref, policyId: 4 })
    assert.deepEqual(plain.classes, ['connection', 'fee'])
    assert.equal(plain.chainRecords, undefined)
    await assert.rejects(
      op.query(chainWith(accounts), { ...ref, policyId: 4, withChainRecords: true }),
      /no chain record/,
    )
    accounts.set(poolGroupPdas.policyChain(PROGRAM, policy, SEPOLIA).toBase58(), {
      data: encode('PolicyChainRecord', (v) => {
        Object.assign(v, {
          version: 1,
          group: GROUP,
          policy,
          remoteChainSelector: bn(SEPOLIA),
          classes: 3,
        })
      }),
      owner: PROGRAM,
    })
    const full = await op.query(chainWith(accounts), {
      ...ref,
      policyId: 4,
      withChainRecords: true,
    })
    assert.equal(full.chainRecords?.[0]?.remoteChainSelector, SEPOLIA)
    await assert.rejects(op.query(chainWith(accounts), { ...ref, policyId: 5 }), /no policy 5/)
    await assert.rejects(
      op.query(chainWith(accounts), { ...ref, policyId: -1 }),
      CCTParamsInvalidError,
    )
  })
})

describe('getTokenPoolGlobalConfig', () => {
  it('decodes the PoolConfig; a program without one is refused', async () => {
    const accounts: Accounts = new Map([
      [
        deriveTokenPoolGlobalConfigPda(PROGRAM).toBase58(),
        {
          data: encode('PoolConfig', (v) => {
            Object.assign(v, {
              version: 1,
              selfServedAllowed: true,
              router: OWNER,
              rmnRemote: OTHER,
            })
          }),
          owner: PROGRAM,
        },
      ],
    ])
    const op = new GetTokenPoolGlobalConfig()
    assert.deepEqual(
      await op.query(chainWith(accounts), { poolProgramAddress: PROGRAM.toBase58() }),
      {
        version: 1,
        selfServedAllowed: true,
        defaultRouter: OWNER.toBase58(),
        defaultRmnRemote: OTHER.toBase58(),
      },
    )
    await assert.rejects(
      op.query(chainWith(new Map()), { poolProgramAddress: PROGRAM.toBase58() }),
      /no PoolConfig/,
    )
  })
})

describe('hook lists', () => {
  const allowlist = Keypair.generate().publicKey
  const blocklist = Keypair.generate().publicKey
  const sender = Keypair.generate().publicKey
  const evm = Buffer.from('1111111111111111111111111111111111111111', 'hex')
  const padded = Buffer.concat([Buffer.alloc(12), evm])
  const entry = (name: string, list: PublicKey, field: Buffer) =>
    Buffer.concat([disc(name), Buffer.from([1, 255]), list.toBuffer(), field])
  function lists(): Accounts {
    const accounts = base()
    accounts.set(allowlist.toBase58(), {
      data: encode('Allowlist', (v) =>
        Object.assign(v, { group: GROUP, admin: OWNER, enabled: true, entryCount: 1 }),
      ),
      owner: PROGRAM,
    })
    accounts.set(blocklist.toBase58(), {
      data: encode('Blocklist', (v) =>
        Object.assign(v, { creator: OWNER, admin: OWNER, entryCount: 1 }),
      ),
      owner: PROGRAM,
    })
    accounts.set(poolGroupPdas.allowlistEntry(PROGRAM, allowlist, sender).toBase58(), {
      data: entry('AllowlistEntry', allowlist, sender.toBuffer()),
      owner: PROGRAM,
    })
    accounts.set(poolGroupPdas.blocklistEntry(PROGRAM, blocklist, blocklistKey(evm)).toBase58(), {
      data: entry('BlocklistEntry', blocklist, blocklistKey(evm)),
      owner: PROGRAM,
    })
    return accounts
  }
  const p = { poolProgramAddress: PROGRAM.toBase58() }

  it('has: allowlist by sender, blocklist by normalized hash (padded EVM folds to 20 bytes)', async () => {
    const op = new HasPoolGroupListEntry()
    const chain = chainWith(lists())
    assert.equal(
      await op.query(chain, { ...p, list: allowlist.toBase58(), address: sender.toBase58() }),
      true,
    )
    assert.equal(
      await op.query(chain, { ...p, list: allowlist.toBase58(), address: OTHER.toBase58() }),
      false,
    )
    assert.equal(
      await op.query(chain, {
        ...p,
        list: blocklist.toBase58(),
        address: `0x${evm.toString('hex')}`,
      }),
      true,
    )
    assert.equal(
      await op.query(chain, {
        ...p,
        list: blocklist.toBase58(),
        address: `0x${padded.toString('hex')}`,
      }),
      true,
    )
    await assert.rejects(
      op.query(chain, { ...p, list: allowlist.toBase58(), address: `0x${evm.toString('hex')}` }),
      /Solana senders/,
    )
    await assert.rejects(
      op.query(chain, { ...p, list: GROUP.toBase58(), address: sender.toBase58() }),
      /not a hook list/,
    )
  })

  it('entries: allowlist senders; blocklist addresses from ListUpdated self-CPI events', async () => {
    const op = new GetPoolGroupListEntries()
    const allowed = await op.query(chainWith(lists()), { ...p, list: allowlist.toBase58() })
    assert.equal(allowed.complete, true)
    assert.equal(allowed.entries[0]?.address, sender.toBase58())
    // without events the blocklist address is unknown
    const bare = await op.query(chainWith(lists()), { ...p, list: blocklist.toBase58() })
    assert.equal(bare.complete, false)
    assert.equal(bare.entries[0]?.address, undefined)
    assert.equal(bare.entries[0]?.addressHash, `0x${blocklistKey(evm).toString('hex')}`)
    // a ListUpdated(list, added: [padded EVM address], removed: []) inner instruction
    const tag = Buffer.from('e445a52e51cb9a1d', 'hex')
    const event = Buffer.from(getBytes(sha256(toUtf8Bytes('event:ListUpdated')))).subarray(0, 8)
    assert.equal(event.toString('hex'), 'f8e2b1f4c48817f5')
    const data = Buffer.concat([tag, event, blocklist.toBuffer(), u32(1), u32(32), padded, u32(0)])
    const keys = [PROGRAM]
    const chain = chainWith(lists(), {
      getSignaturesForAddress: async (_k: PublicKey, opts: { before?: string }) =>
        opts.before ? [] : [{ signature: 'sig', slot: 10, err: null }],
      getTransaction: async () => ({
        transaction: { message: { getAccountKeys: () => ({ get: (i: number) => keys[i] }) } },
        meta: {
          innerInstructions: [
            {
              index: 0,
              instructions: [{ programIdIndex: 0, accounts: [], data: bs58.encode(data) }],
            },
          ],
        },
      }),
    })
    const scanned = await op.query(chain, { ...p, list: blocklist.toBase58() })
    assert.equal(scanned.complete, true)
    assert.equal(scanned.entries[0]?.address, `0x${evm.toString('hex')}`)
    // fromSlot after the update: history not scanned that far back
    const late = await op.query(chain, { ...p, list: blocklist.toBase58(), fromSlot: 11n })
    assert.equal(late.complete, false)
  })

  it('getPoolGroupHooks: the record kinds, lists and hook authority', async () => {
    const accounts = lists()
    const record = poolGroupPdas.groupChain(PROGRAM, GROUP, SEPOLIA)
    const gcp = Buffer.alloc(GROUP_CHAIN_POLICY_FIXED_LEN)
    encode('GroupChainPolicy', (v) => {
      Object.assign(v, { version: 1, group: GROUP, remoteChainSelector: bn(SEPOLIA) })
      const security = (v.policy as { security: Record<string, unknown> }).security
      security.hook = { allowlist, blocklist, policyEngine: null }
    }).copy(gcp)
    accounts.set(record.toBase58(), { data: gcp, owner: PROGRAM })
    const op = new GetPoolGroupHooks()
    const hooks = await op.query(chainWith(accounts), { ...p, record: record.toBase58() })
    assert.equal(hooks.hook?.allowlist, allowlist.toBase58())
    assert.deepEqual(
      hooks.lists.map((l) => l.kind),
      ['allowlist', 'blocklist'],
    )
    assert.equal(hooks.hookAuthority, poolGroupPdas.hookAuthority(PROGRAM, GROUP).toBase58())
    const none = await op.query(chainWith(accounts), { ...p, record: GROUP.toBase58() })
    assert.equal(none.hook, null)
    assert.equal(none.hookAuthority, poolGroupPdas.hookAuthority(PROGRAM, GROUP).toBase58())
    await assert.rejects(
      op.query(chainWith(accounts), { ...p, record: allowlist.toBase58() }),
      /SECURITY record/,
    )
  })
})

describe('decoders', () => {
  it('sections: CCV placeholder, finality, fee, rate limits, remote pools by family', () => {
    const value = poolGroupsCoder.types.decode<Parameters<typeof decodeSections>[0]>(
      'PolicySections',
      Buffer.alloc(4096),
    )
    value.security.current.outbound = [PublicKey.default, OWNER]
    value.connection.remotePools = [
      { address: { address: Buffer.alloc(20, 0x22) }, allowLegacyPoolData: true },
    ]
    value.connection.allowedFinalityConfig = { flags: 1, blockDepth: 5 }
    const sections = decodeSections(value, SEPOLIA)
    assert.deepEqual(sections.security.current.outbound, ['default', OWNER.toBase58()])
    assert.equal(sections.connection.remotePools[0]?.address, getAddress(`0x${'22'.repeat(20)}`))
    assert.deepEqual(sections.connection.allowedFinality, { finalityDepth: 5, finalitySafe: true })
    assert.equal(sections.rateLimit.outbound.enabled, false)
    assert.equal(decodeSections(value).connection.remotePools[0]?.address, `0x${'22'.repeat(20)}`)
  })

  it('class bits, lane mode, writable statics', () => {
    assert.deepEqual(decodeClassBits(0b1010), ['fee', 'security'])
    assert.equal(decodeLaneMode({ allMembers: {} }), 'all-members')
    assert.equal(decodeLaneMode({ off: {} }), 'off')
    const engine = decodeHookConfig({
      allowlist: null,
      blocklist: OWNER,
      policyEngine: {
        program: OTHER,
        staticAccounts: [OWNER, OWNER, OWNER],
        writableStatics: 0b101,
        onSend: true,
        onReceive: false,
      },
    })
    assert.deepEqual(engine.policyEngine?.writableStatics, [0, 2])
  })
})
