/**
 * What a lane's SECURITY hooks add to its transfers, for the lane check: the accounts a send
 * resolves through the pool group (so a write that adds hooks or named records is measured against
 * the 64-lock limit on its post-state), and the hook rules (the hook accounts the program needs exist
 * as it needs them; an empty enabled allowlist reverts every send).
 *
 * Program of record: chainlink-ccip-solana 7558722, `burnmint-token-pool/src/instructions/`
 * `operations_v2/burn_v2/resolve_accounts.rs` (the send's stages) and `groups/hook_checks.rs`
 * (`send_hook_accounts`, `receive_hook_accounts`, `enforce_send_hooks`).
 *
 * @packageDocumentation
 */

import { PublicKey } from '@solana/web3.js'

import type { SolanaChain } from '../../../solana/index.ts'
import { getMultipleAccountsInfoPaged } from '../../../solana/utils.ts'
import type { MultiTokenPoolLaneFinding } from '../../multi-token-pool.ts'
import { decodePoolGroupIdlAccount, poolGroupPdas } from './accounts.ts'
import { decodeSections } from './decode.ts'
import { type PoolGroupLaneState, isUnread, laneSectionsFor } from './lane.ts'
import type { PoolGroupHookConfig } from './types.ts'

/** The hook config a lane's transfers apply: its SECURITY record's, or none (inline SECURITY). */
export function laneHook(state: PoolGroupLaneState): PoolGroupHookConfig | null {
  const sections = laneSectionsFor(state, 'security')
  if (!sections || isUnread(sections)) return null
  return decodeSections(sections, 0n, state.selector).security.hook
}

/**
 * The accounts a send of the lane resolves through its pool group, beyond a standard lane's
 * (`with_lane_config`, `with_hooks`): the group chain record and the named records, then the send
 * hook accounts (`send_hook_accounts`: the sender's allowlist entry, the sender's and the
 * receiver's blocklist entries, the engine program, the hook authority and the statics). Entries
 * that depend on the sender or receiver are counted by kind (one each), as a send has one of each.
 * @internal
 */
export function laneSendFootprint(state: PoolGroupLaneState): Set<string> {
  const keys = new Set<string>()
  if (state.groupChain) keys.add(state.groupChain.address.toBase58())
  for (const n of state.named.values()) keys.add(n.address.toBase58())
  const hook = laneHook(state)
  const group = state.ext?.poolGroupAddress
  if (!hook || !group) return keys
  if (hook.allowlist) keys.add(`allowlist-entry:${hook.allowlist}:sender`)
  if (hook.blocklist) {
    keys.add(`blocklist-entry:${hook.blocklist}:sender`)
    keys.add(`blocklist-entry:${hook.blocklist}:receiver`)
  }
  const engine = hook.policyEngine
  if (engine?.onSend) {
    keys.add(engine.program)
    keys.add(poolGroupPdas.hookAuthority(state.program, new PublicKey(group)).toBase58())
    for (const s of engine.staticAccounts) keys.add(s)
  }
  return keys
}

/**
 * The extra locks a send takes after a write, against the state the resolver measured: the post
 * footprint less the one before (negative when the write removes accounts). An unreadable state
 * before counts as a standard lane's (the delta is then an upper bound).
 * @internal
 */
export function sendLockDelta(
  before: PoolGroupLaneState | null | { status: string },
  after: PoolGroupLaneState,
): number {
  const pre = before && 'chainConfig' in before ? laneSendFootprint(before) : new Set<string>()
  return laneSendFootprint(after).size - pre.size
}

type Add = (
  check: MultiTokenPoolLaneFinding['check'],
  severity: MultiTokenPoolLaneFinding['severity'],
  reason: string,
  recordType?: MultiTokenPoolLaneFinding['recordType'],
) => void

/**
 * The hook rules of a lane open in `open`: the lists the hook names are the pool program's lists
 * (`HookAccountMissing` otherwise, on every transfer), the engine is an executable program, an
 * enabled allowlist with no entry reverts every send (`SenderNotAllowed`), and (after a write) a
 * receive-side hook on an inbound-open lane may refuse in-flight messages.
 *
 * On Solana the caller a policy engine authorizes is the pool group's hook authority, which
 * `set_policy_engine` attaches itself; the SDK cannot read an engine's own state, so it checks the
 * accounts the program passes.
 * @internal
 */
export async function checkLaneHooks(
  chain: SolanaChain,
  state: PoolGroupLaneState,
  open: ReadonlySet<'outbound' | 'inbound'>,
  severity: (direction: 'outbound' | 'inbound') => MultiTokenPoolLaneFinding['severity'],
  add: Add,
  afterWrite: boolean,
): Promise<void> {
  const hook = laneHook(state)
  if (!hook) return
  const lists = [hook.allowlist, hook.blocklist].filter((l): l is string => l !== null)
  const engine = hook.policyEngine
  const keys = [...lists, ...(engine ? [engine.program] : [])].map((k) => new PublicKey(k))
  const infos = await getMultipleAccountsInfoPaged(chain.connection, keys)
  const sev = (directions: ('outbound' | 'inbound')[]) =>
    directions.some((d) => open.has(d) && severity(d) === 'error') ? 'error' : 'warning'
  lists.forEach((list, i) => {
    const info = infos[i]
    const kind = list === hook.allowlist ? 'allowlist' : 'blocklist'
    if (!info?.owner.equals(state.program)) {
      add(
        'HOOK_CALLER_MISSING',
        sev(kind === 'allowlist' ? ['outbound'] : ['outbound', 'inbound']),
        `the SECURITY hook's ${kind} ${list} is not a list of the pool program: transfers revert (HookAccountMissing)`,
        'security',
      )
      return
    }
    if (kind !== 'allowlist') return
    try {
      const decoded = decodePoolGroupIdlAccount('allowlist', info.data, list)
      if (decoded.enabled && decoded.entryCount === 0 && open.has('outbound'))
        add(
          'HOOK_CALLER_MISSING',
          'warning',
          `the SECURITY hook's allowlist ${list} is enabled with no entry: every send reverts (SenderNotAllowed) until senders are added`,
          'security',
        )
    } catch {
      add(
        'HOOK_CALLER_MISSING',
        sev(['outbound']),
        `the SECURITY hook's allowlist ${list} does not decode: sends revert`,
        'security',
      )
    }
  })
  if (engine) {
    const info = infos[lists.length]
    if (!info?.executable)
      add(
        'HOOK_CALLER_MISSING',
        sev([
          ...(engine.onSend ? (['outbound'] as const) : []),
          ...(engine.onReceive ? (['inbound'] as const) : []),
        ]),
        `the SECURITY hook's policy engine ${engine.program} is not an executable program: the transfers it checks revert (HookAccountMissing)`,
        'security',
      )
  }
  if (afterWrite && open.has('inbound') && (hook.blocklist || engine?.onReceive))
    add(
      'HOOK_CALLER_MISSING',
      'warning',
      `the lane's receive side runs ${hook.blocklist ? 'a blocklist' : 'a policy engine'} after the write: in-flight inbound messages are checked when they execute and may be refused`,
      'security',
    )
}
