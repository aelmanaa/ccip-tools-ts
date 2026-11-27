import { BorshAccountsCoder } from '@coral-xyz/anchor'
import type { PublicKey } from '@solana/web3.js'

import type { SolanaChain } from '../../../../solana/index.ts'
import { toLeArray } from '../../../../utils.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { SolanaQuery } from '../../query.ts'
import {
  parseOptionalPublicKey,
  parsePublicKey,
  resolveExistingPoolProgram,
} from '../../validate.ts'
import { decodePoolGroupChainConfigV2 } from '../accounts.ts'
import type {
  GetPoolGroupLaneParams,
  GetPoolGroupLaneResult,
  GetPoolGroupLanesParams,
} from '../types.ts'
import {
  type ParsedPoolGroupRef,
  listProgramAccounts,
  memcmp,
  parsePoolGroupRef,
  readPoolGroup,
  validateSelector,
} from './common.ts'
import { type PoolGroupLaneRequest, readPoolGroupLane, readPoolGroupLanes } from './lane.ts'

type ParsedLane = { program?: PublicKey; mint: PublicKey; selector: bigint }

/** Decodes one lane: marker, tail, admission, CCV sync state and current buckets. */
export class GetPoolGroupLane extends SolanaQuery<
  GetPoolGroupLaneParams,
  GetPoolGroupLaneResult,
  ParsedLane
> {
  readonly name = 'getPoolGroupLane'

  /** @throws {@link CCTParamsInvalidError} if the mint, program or selector is invalid */
  protected prepare(params: GetPoolGroupLaneParams): ParsedLane {
    const program = parseOptionalPublicKey(
      this.name,
      'poolProgramAddress',
      params.poolProgramAddress,
    )
    return {
      ...(program && { program }),
      mint: parsePublicKey(this.name, 'tokenAddress', params.tokenAddress),
      selector: validateSelector(this.name, 'remoteChainSelector', params.remoteChainSelector),
    }
  }

  /**
   * Reads the lane as its transfer paths resolve it, on `poolProgramAddress` or the program of the
   * mint's existing pool.
   */
  protected async read(chain: SolanaChain, { program, mint, selector }: ParsedLane) {
    const poolProgram = await resolveExistingPoolProgram(this.name, chain, mint, program)
    return readPoolGroupLane(this.name, chain, poolProgram, mint, selector)
  }
}

type ParsedLanes = ParsedPoolGroupRef & {
  selector?: bigint
  kind?: GetPoolGroupLanesParams['kind']
}

/** Lists every linked and driven lane of a pool group, optionally for one chain. */
export class GetPoolGroupLanes extends SolanaQuery<
  GetPoolGroupLanesParams,
  GetPoolGroupLaneResult[],
  ParsedLanes
> {
  readonly name = 'getPoolGroupLanes'

  /** @throws {@link CCTParamsInvalidError} if the ref, selector or kind is invalid */
  protected prepare(params: GetPoolGroupLanesParams): ParsedLanes {
    if (params.kind !== undefined && !(['linked', 'driven'] as unknown[]).includes(params.kind))
      throw new CCTParamsInvalidError(this.name, 'kind', "must be 'linked' or 'driven'")
    return {
      ...parsePoolGroupRef(this.name, params),
      ...(params.remoteChainSelector !== undefined && {
        selector: validateSelector(this.name, 'remoteChainSelector', params.remoteChainSelector),
      }),
      ...(params.kind && { kind: params.kind }),
    }
  }

  /**
   * `getProgramAccounts` on `ChainConfigV2` (discriminator @0, version 2 @9, selector @10 when
   * given); the tails naming this group are then read as lanes.
   */
  protected async read(chain: SolanaChain, ref: ParsedLanes): Promise<GetPoolGroupLaneResult[]> {
    await readPoolGroup(this.name, chain, ref)
    const filters = [
      memcmp(0, BorshAccountsCoder.accountDiscriminator('ChainConfigV2')),
      memcmp(9, Uint8Array.of(2)),
      ...(ref.selector !== undefined ? [memcmp(10, toLeArray(ref.selector, 8))] : []),
    ]
    const accounts = await listProgramAccounts(this.name, chain, ref.program, filters, {
      param: 'connection',
      fix: 'listing lanes needs it; use an RPC that serves getProgramAccounts, or read each lane with getPoolGroupLane',
    })
    const group = ref.group.toBase58()
    const lanes: PoolGroupLaneRequest[] = []
    for (const { pubkey, account } of accounts) {
      const lane = decodePoolGroupChainConfigV2(account.data, pubkey.toBase58())
      if (lane.ext?.poolGroupAddress !== group) continue
      if (ref.kind && (ref.kind === 'driven') !== lane.ext.groupDriven) continue
      lanes.push({
        mint: parsePublicKey(this.name, 'mint', lane.mint),
        selector: lane.remoteChainSelector,
        v2: account,
      })
    }
    // a tail whose ChainConfig is gone is no lane: transfers read the ChainConfig first
    const out = await readPoolGroupLanes(this.name, chain, ref.program, lanes, {
      skipMissing: true,
    })
    return out.sort(
      (a, b) =>
        a.tokenAddress.localeCompare(b.tokenAddress) ||
        Number(a.remoteChainSelector - b.remoteChainSelector),
    )
  }
}
