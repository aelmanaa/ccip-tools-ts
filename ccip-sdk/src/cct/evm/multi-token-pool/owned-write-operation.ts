/**
 * The base of every owner-gated multi-token pool write: a write to the pool, a policy store or a
 * hook contract itself (not through the PoolConfigManager), gated by the contract's `Ownable2Step`
 * owner, or by its pending owner for an accept.
 *
 * @packageDocumentation
 */

import { getAddress } from 'ethers'

import type { EVMChain } from '../../../evm/index.ts'
import type { UnsignedEVMTx } from '../../../evm/types.ts'
import { ChainFamily } from '../../../networks.ts'
import type { MultiTokenPoolSnapshot } from '../../multi-token-pool.ts'
import { latestBlock } from '../mined-block.ts'
import { revertRefusal } from '../pool-config-manager/guard-run.ts'
import { simulateEVMTx } from '../simulate.ts'
import { validateNonZeroAddress } from '../validate.ts'
import {
  type MultiTokenPoolContractType,
  type MultiTokenPoolHooksType,
  MULTI_TOKEN_POOL_HOOKS_TYPES,
  MULTI_TOKEN_POOL_TYPES,
  MultiTokenPoolVersion,
  POLICY_STORE_TYPES,
  assertMultiTokenPoolAuxContract,
  getMultiTokenPoolInterface,
  readOwnership,
  resolveMultiTokenPoolContract,
} from './contracts.ts'
import {
  type MultiTokenPoolUnsealedUnsignedTx,
  type MultiTokenPoolWriteImpact,
  MultiTokenPoolWriteOperation,
} from './write-operation.ts'

/** The contracts an owner-gated MTTP write targets. @internal */
export type MultiTokenPoolOwnedTargetKind = 'pool' | 'policyStore' | 'hooks'

/** How each kind of owned target is named, resolved and labelled. */
const OWNED_TARGETS = {
  pool: { param: 'poolAddress', label: 'multi-token pool', types: MULTI_TOKEN_POOL_TYPES },
  policyStore: { param: 'policyStore', label: 'policy store', types: POLICY_STORE_TYPES },
  hooks: { param: 'hooks', label: 'hook contract', types: MULTI_TOKEN_POOL_HOOKS_TYPES },
} as const satisfies Record<
  MultiTokenPoolOwnedTargetKind,
  { param: string; label: string; types: readonly MultiTokenPoolContractType[] }
>

/** The param naming an owned target of `kind` (`poolAddress`, `policyStore` or `hooks`). @internal */
export type MultiTokenPoolOwnedTargetParam<K extends MultiTokenPoolOwnedTargetKind> =
  (typeof OWNED_TARGETS)[K]['param']

/** A resolved owned target, its owner and its pending transfer, read at one block. @internal */
export type MultiTokenPoolOwnedWriteContext = {
  /** The target. */
  address: string
  /** Its reported type. */
  type: MultiTokenPoolContractType
  /** Its version (hooks gate on type only and use the vendored `2.1.0-dev` ABI). */
  version: MultiTokenPoolVersion
  /** The block every read is pinned to. */
  blockTag: number
  /** `owner()`. */
  owner: string
  /** The proposed owner that has not accepted, or `null`. */
  pendingOwner: string | null
}

/** The impact fields an owned write's own guard reports (lanes, findings, follow-ups, snapshot). @internal */
export type MultiTokenPoolOwnedWriteImpact = Omit<
  MultiTokenPoolWriteImpact,
  'projectionVerified' | 'simulatedFrom'
> & { snapshot?: MultiTokenPoolSnapshot }

/**
 * Base of every owner-gated MTTP write. Subclasses name the target kind, encode the calldata, and may
 * judge the write (lanes, follow-ups, a snapshot); the base resolves the target, pre-flights `sender`
 * against `owner()` (or the pending owner), and simulates the write from `sender` at the same block.
 * @internal
 */
export abstract class MultiTokenPoolOwnedWriteOperation<
  K extends MultiTokenPoolOwnedTargetKind,
  P extends { [k in MultiTokenPoolOwnedTargetParam<K>]: string } & {
    sender?: string
    expectedSnapshot?: MultiTokenPoolSnapshot
  },
  Parsed extends P = P,
  Tx extends UnsignedEVMTx & MultiTokenPoolWriteImpact & { snapshot?: MultiTokenPoolSnapshot } =
    MultiTokenPoolUnsealedUnsignedTx,
> extends MultiTokenPoolWriteOperation<P, Parsed, Tx> {
  /** The kind of contract the write targets. */
  protected abstract readonly kind: K
  /** Who may send it: the owner (default), or the pending owner (an accept). */
  protected readonly signer: 'owner' | 'pendingOwner' = 'owner'

  /** Encodes the calldata sent to the target. */
  protected abstract encode(
    chain: EVMChain,
    params: Parsed,
    ctx: MultiTokenPoolOwnedWriteContext,
  ): string | Promise<string>

  /**
   * The target types this op accepts; defaults to every type of its kind (an op on the
   * external-blocklist hooks narrows it).
   */
  protected targetTypes(): readonly MultiTokenPoolContractType[] {
    return OWNED_TARGETS[this.kind].types
  }

  /**
   * Checks the write against the state at `ctx.blockTag` and reports its impact. The default judges
   * nothing: a write that changes no lane.
   */
  protected judge(
    _chain: EVMChain,
    _params: Parsed,
    _ctx: MultiTokenPoolOwnedWriteContext,
    _data: string,
  ): Promise<MultiTokenPoolOwnedWriteImpact> | MultiTokenPoolOwnedWriteImpact {
    return { affectedLanes: [], goingLive: [], warnings: [] }
  }

  /** The address the write targets. */
  protected targetOf(params: Parsed): string {
    return params[OWNED_TARGETS[this.kind].param as MultiTokenPoolOwnedTargetParam<K>]
  }

  /** Validates the target address; subclasses validate their own fields after it. */
  protected override prepare(params: P): Parsed {
    const { param } = OWNED_TARGETS[this.kind]
    validateNonZeroAddress(this.name, param, params[param as MultiTokenPoolOwnedTargetParam<K>])
    // `sender` is validated by `generate`, before any RPC
    return params as Parsed
  }

  protected async buildUnsigned(chain: EVMChain, params: Parsed): Promise<Tx> {
    const address = getAddress(this.targetOf(params))
    const { type, version } = await this.resolveTarget(chain, address)
    const blockTag = await latestBlock(chain)
    const { owner, pendingOwner } = await readOwnership(chain, address, blockTag)
    const ctx: MultiTokenPoolOwnedWriteContext = {
      address,
      type,
      version,
      blockTag,
      owner,
      pendingOwner,
    }
    if (params.sender !== undefined) this.assertSigner(params, ctx, getAddress(params.sender))
    const data = await this.encode(chain, params, ctx)
    const impact = await this.judge(chain, params, ctx, data)
    if (params.sender !== undefined) {
      const sim = await simulateEVMTx(
        chain,
        { family: ChainFamily.EVM, transactions: [{ to: address, data }] },
        { from: params.sender, blockTag },
      )
      if (!sim.success)
        throw revertRefusal(
          { operation: this.name, errorContext: this.errorContext(params) },
          'sender',
          `the write reverts when ${getAddress(params.sender)} executes it`,
          sim,
          'sender',
        )
    }
    return {
      family: ChainFamily.EVM,
      // `generate` sets `from` to the sender
      transactions: [{ to: address, data }],
      projectionVerified: false,
      simulatedFrom: params.sender !== undefined ? 'sender' : 'none',
      ...impact,
    } as unknown as Tx
  }

  /** Resolves the target: exact type and version, or type only for hooks. */
  private async resolveTarget(
    chain: EVMChain,
    address: string,
  ): Promise<{ type: MultiTokenPoolContractType; version: MultiTokenPoolVersion }> {
    const types = this.targetTypes()
    if (this.kind !== 'hooks') return resolveMultiTokenPoolContract(chain, address, types)
    const type = await assertMultiTokenPoolAuxContract(
      chain,
      address,
      types as readonly MultiTokenPoolHooksType[],
    )
    return { type, version: MultiTokenPoolVersion.V2_1_0_DEV }
  }

  /** The `sender` pre-flight: the owner, or the pending owner for an accept. */
  private assertSigner(params: Parsed, ctx: MultiTokenPoolOwnedWriteContext, sender: string): void {
    const { label } = OWNED_TARGETS[this.kind]
    if (this.signer === 'owner') {
      if (sender !== ctx.owner)
        throw this.refuse('sender', `must be the ${label} owner (${ctx.owner})`, params)
      return
    }
    if (ctx.pendingOwner === null)
      throw this.refuse(
        'sender',
        `must be the pending owner of the ${label}, but no ownership transfer is pending (owner ${ctx.owner})`,
        params,
      )
    if (sender !== ctx.pendingOwner)
      throw this.refuse(
        'sender',
        `must be the pending owner of the ${label} (${ctx.pendingOwner})`,
        params,
      )
  }
}

/** The interface an owned target's calldata is encoded with. @internal */
export function ownedTargetInterface(
  ctx: Pick<MultiTokenPoolOwnedWriteContext, 'type' | 'version'>,
) {
  return getMultiTokenPoolInterface(ctx.type, ctx.version)
}

/** The label of an owned target kind, for reasons. @internal */
export function ownedTargetLabel(kind: MultiTokenPoolOwnedTargetKind): string {
  return OWNED_TARGETS[kind].label
}
