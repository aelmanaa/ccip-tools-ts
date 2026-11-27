/**
 * Family-neutral A21 drop confirmation (the types are in `multi-token-pool.ts`): what a write drops from each lane's trusted remote pools,
 * the refusal of any drop the caller did not confirm, and the stable shape `confirmDropped` is
 * sealed into a snapshot with. Shared by the EVM PoolConfigManager guard and the Solana pool-group
 * guard; each passes its own lane-key spelling (checksummed EVM token, base58 Solana mint).
 *
 * @packageDocumentation
 */

import { CCTParamsInvalidError } from './errors.ts'
import type {
  MultiTokenPoolInlineRemotePoolDrop,
  MultiTokenPoolLaneKey,
} from './multi-token-pool.ts'
import { parseUniqueRemoteAddresses } from './remote-address.ts'

/** One trusted remote pool of a lane, in its canonical spelling. @internal */
export type TrustedRemotePool = { address: string; allowLegacyPoolData: boolean }

/** The `${tokenAddress}:${remoteChainSelector}` key of a lane. @internal */
export const dropLaneKey = (l: MultiTokenPoolLaneKey) =>
  `${l.tokenAddress}:${l.remoteChainSelector}`

/**
 * What a write drops from each lane's trusted remote pools: pools trusted before and not after,
 * and `allowLegacyPoolData` turned off on a pool kept. Lanes without drops are left out. The
 * caller decides which lanes count (EVM leaves out lanes the write closes or opens).
 * @internal
 */
export function droppedRemotePools(
  lanes: readonly {
    lane: MultiTokenPoolLaneKey
    before: readonly TrustedRemotePool[]
    after: readonly TrustedRemotePool[]
  }[],
): { lane: MultiTokenPoolLaneKey; remotePools: string[]; flags: 'allowLegacyPoolData'[] }[] {
  return lanes
    .map(({ lane, before, after }) => {
      const kept = new Map(after.map((p) => [p.address, p.allowLegacyPoolData]))
      const legacyOff = before.some((p) => p.allowLegacyPoolData && kept.get(p.address) === false)
      return {
        lane,
        remotePools: before.filter((p) => !kept.has(p.address)).map((p) => p.address),
        flags: legacyOff ? (['allowLegacyPoolData'] as const).slice() : [],
      }
    })
    .filter((d) => d.remotePools.length || d.flags.length)
}

/**
 * A21: refuses a write that drops trusted remote pools (or a flag) on a lane, unless
 * `confirmDropped` lists the drop for that lane. Remote pools compare canonically; lanes by
 * `laneKey` (each family's token spelling).
 * @throws {@link CCTParamsInvalidError} (param `confirmDropped`, `context.dropped`, plus
 *   `context`) if any drop is unconfirmed
 * @internal
 */
export function assertDropsConfirmed(
  operation: string,
  dropped: readonly MultiTokenPoolInlineRemotePoolDrop[],
  confirmDropped: readonly MultiTokenPoolInlineRemotePoolDrop[],
  {
    laneKey = dropLaneKey,
    context = {},
  }: {
    laneKey?: (l: MultiTokenPoolLaneKey) => string
    context?: Record<string, unknown>
  } = {},
): void {
  if (!dropped.length) return
  const confirmed = new Map(confirmDropped.map((d) => [laneKey(d.lane), d]))
  const unconfirmed = dropped
    .map((d) => {
      const ok = confirmed.get(laneKey(d.lane))
      // canonical spellings on both sides (base58 is case-sensitive)
      const okPools = new Set(
        ok?.remotePools
          ? parseUniqueRemoteAddresses(
              operation,
              'confirmDropped',
              ok.remotePools,
              d.lane.remoteChainSelector,
            )
          : [],
      )
      return {
        lane: d.lane,
        remotePools: (d.remotePools ?? []).filter((p) => !okPools.has(p)),
        flags: (d.flags ?? []).filter((f) => !ok?.flags?.includes(f)),
      }
    })
    .filter((d) => d.remotePools.length || d.flags.length)
  if (unconfirmed.length)
    throw new CCTParamsInvalidError(
      operation,
      'confirmDropped',
      `the write drops trusted remote pools, so in-flight inbound messages from them would revert: ${unconfirmed
        .map(
          (d) =>
            `${d.lane.tokenAddress} → ${d.lane.remoteChainSelector} drops ${[
              ...(d.remotePools.length ? [`pools ${d.remotePools.join(', ')}`] : []),
              ...(d.flags.length ? [`flags ${d.flags.join(', ')}`] : []),
            ].join(' and ')}`,
        )
        .join(
          '; ',
        )}. To proceed, add confirmDropped: context.dropped (same shape), or keep them trusted`,
      { context: { ...context, dropped: unconfirmed } },
    )
}

/**
 * `confirmDropped` in the stable shape it is sealed with: tokens in each family's spelling
 * (`canonicalToken`), remote pools canonical and sorted, flags unique and sorted, lanes sorted; an
 * empty list is `undefined`.
 * @throws {@link CCTParamsInvalidError} if a token or remote pool is invalid
 * @internal
 */
export function sealConfirmDropped(
  operation: string,
  confirmDropped: readonly MultiTokenPoolInlineRemotePoolDrop[] | undefined,
  canonicalToken: (tokenAddress: unknown, param: string) => string,
  laneKey: (l: MultiTokenPoolLaneKey) => string = dropLaneKey,
): MultiTokenPoolInlineRemotePoolDrop[] | undefined {
  if (!confirmDropped?.length) return undefined
  return confirmDropped
    .map(({ lane, remotePools, flags }, i) => ({
      lane: {
        tokenAddress: canonicalToken(lane.tokenAddress, `confirmDropped[${i}].lane.tokenAddress`),
        remoteChainSelector: lane.remoteChainSelector,
      },
      ...(remotePools?.length && {
        remotePools: parseUniqueRemoteAddresses(
          operation,
          `confirmDropped[${i}].remotePools`,
          remotePools,
          lane.remoteChainSelector,
        ).sort(),
      }),
      ...(flags?.length && { flags: [...new Set(flags)].sort() }),
    }))
    .sort((a, b) => laneKey(a.lane).localeCompare(laneKey(b.lane)))
}
