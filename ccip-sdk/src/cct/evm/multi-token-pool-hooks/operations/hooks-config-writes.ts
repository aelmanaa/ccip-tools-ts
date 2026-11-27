/**
 * The owner-gated settings of a multi-token pool hook contract: its sender allowlist, its policy
 * engine, and (on `MultiTokenPoolHooksExternalBlocklist`) its external blocklist. Each is shared by
 * every token whose lanes resolve to these hooks.
 *
 * @remarks Validation is main's, with its code: the allowlist update as main's
 * `applyAllowlistUpdates` (`parseAllowlistUpdates`, `assertAllowlistUpdatesChange`), the policy
 * engine as main's `setPolicyEngine` (`assertPolicyEngineContract`). None of these writes changes a
 * lane record, so none seals a snapshot.
 *
 * @packageDocumentation
 */

import { ZeroAddress, getAddress } from 'ethers'

import type { EVMChain } from '../../../../evm/index.ts'
import {
  assertDeployedContract,
  assertPolicyEngineContract,
} from '../../advanced-pool-hooks/contracts.ts'
import {
  type MultiTokenPoolContractType,
  multiTokenPoolFunctionOf,
} from '../../multi-token-pool/contracts.ts'
import {
  type MultiTokenPoolOwnedWriteContext,
  MultiTokenPoolOwnedWriteOperation,
  ownedTargetInterface,
} from '../../multi-token-pool/owned-write-operation.ts'
import {
  assertAllowlistUpdatesChange,
  parseAllowlistUpdates,
  readTokenPoolAllowlist,
} from '../../token-pool/contracts.ts'
import { validateAddress } from '../../validate.ts'

/** `applyMultiTokenPoolHooksAllowlistUpdates` (contract function `applyAllowListUpdates`). */
export type ApplyMultiTokenPoolHooksAllowlistUpdatesParams = {
  /** The hook contract. */
  hooks: string
  /**
   * Senders to remove, applied before `adds`. Distinct, non-zero, each currently allowlisted, and
   * none also in `adds`. Defaults to `[]`.
   */
  removes?: string[]
  /** Senders to add. Distinct, non-zero, none already allowlisted. Defaults to `[]`. */
  adds?: string[]
  /** The hooks owner; optional when generating an unsigned transaction. */
  sender?: string
}

/** `setMultiTokenPoolHooksPolicyEngine`. */
export type SetMultiTokenPoolHooksPolicyEngineParams = {
  /** The hook contract. */
  hooks: string
  /**
   * New engine, or `ZeroAddress` to detach. A non-zero engine must have deployed code and implement
   * `attach()` / `detach()`.
   */
  policyEngine: string
  /**
   * Use `setPolicyEngineAllowFailedDetach`: the new engine is attached even when the old one's
   * `detach()` reverts (the recovery from a broken engine). Defaults to `false`.
   */
  allowFailedDetach?: boolean
  /** The hooks owner; optional when generating an unsigned transaction. */
  sender?: string
}

/** `setMultiTokenPoolHooksBlocklist`. */
export type SetMultiTokenPoolHooksBlocklistParams = {
  /** A `MultiTokenPoolHooksExternalBlocklist`. */
  hooks: string
  /** The blocklist contract, or `ZeroAddress` to turn the blocklist off. */
  blocklist: string
  /** The hooks owner; optional when generating an unsigned transaction. */
  sender?: string
}

type ParsedAllowlistUpdates = ApplyMultiTokenPoolHooksAllowlistUpdatesParams & {
  removes: string[]
  adds: string[]
}

/** Adds and removes allowlisted senders, removes first. Owner-only. */
export class ApplyMultiTokenPoolHooksAllowlistUpdates extends MultiTokenPoolOwnedWriteOperation<
  'hooks',
  ApplyMultiTokenPoolHooksAllowlistUpdatesParams,
  ParsedAllowlistUpdates
> {
  readonly name = 'applyMultiTokenPoolHooksAllowlistUpdates'
  protected readonly kind = 'hooks'

  /**
   * Validates the hooks and both arrays as main's `applyAllowlistUpdates`, keeping them checksummed.
   * @throws {@link CCTParamsInvalidError} as `applyAllowlistUpdates` does
   */
  protected override prepare(
    params: ApplyMultiTokenPoolHooksAllowlistUpdatesParams,
  ): ParsedAllowlistUpdates {
    super.prepare(params)
    const { removes = [], adds = [] } = params
    return { ...params, ...parseAllowlistUpdates(this.name, removes, adds) }
  }

  /**
   * Refuses hooks built with an empty allowlist (immutable: `AllowListNotEnabled`), and any update
   * the hooks would silently skip, as main's `applyAllowlistUpdates`.
   */
  protected async encode(
    chain: EVMChain,
    params: ParsedAllowlistUpdates,
    ctx: MultiTokenPoolOwnedWriteContext,
  ): Promise<string> {
    const { enabled, entries } = await readTokenPoolAllowlist(chain, ctx.address)
    if (!enabled)
      throw this.refuse(
        'hooks',
        `the hook contract at ${ctx.address} was deployed without an allowlist and can never have one (\`allowlistEnabled\` is immutable and false); applyAllowListUpdates reverts AllowListNotEnabled. Deploy hooks with a non-empty allowlist and point the lanes' security records at them`,
        params,
      )
    assertAllowlistUpdatesChange(this.name, entries, params)
    // `removes` first, then `adds`: the ABI's own order
    return ownedTargetInterface(ctx).encodeFunctionData(multiTokenPoolFunctionOf(this.name), [
      params.removes,
      params.adds,
    ])
  }
}

/** Attaches a policy engine, or detaches it with `ZeroAddress`. Owner-only. */
export class SetMultiTokenPoolHooksPolicyEngine extends MultiTokenPoolOwnedWriteOperation<
  'hooks',
  SetMultiTokenPoolHooksPolicyEngineParams
> {
  readonly name = 'setMultiTokenPoolHooksPolicyEngine'
  protected readonly kind = 'hooks'

  /** Validates the addresses before any RPC, as main's `setPolicyEngine`; zero detaches. */
  protected override prepare(
    params: SetMultiTokenPoolHooksPolicyEngineParams,
  ): SetMultiTokenPoolHooksPolicyEngineParams {
    super.prepare(params)
    validateAddress(this.name, 'policyEngine', params.policyEngine)
    return params
  }

  /** A non-zero engine must have deployed code, as main's `setPolicyEngine`. */
  protected async encode(
    chain: EVMChain,
    params: SetMultiTokenPoolHooksPolicyEngineParams,
    ctx: MultiTokenPoolOwnedWriteContext,
  ): Promise<string> {
    const engine = getAddress(params.policyEngine)
    if (engine !== ZeroAddress)
      await assertPolicyEngineContract(this.name, 'policyEngine', chain, engine)
    return ownedTargetInterface(ctx).encodeFunctionData(
      params.allowFailedDetach
        ? 'setPolicyEngineAllowFailedDetach'
        : multiTokenPoolFunctionOf(this.name),
      [engine],
    )
  }
}

/** Sets the external blocklist, or turns it off with `ZeroAddress`. Owner-only. */
export class SetMultiTokenPoolHooksBlocklist extends MultiTokenPoolOwnedWriteOperation<
  'hooks',
  SetMultiTokenPoolHooksBlocklistParams
> {
  readonly name = 'setMultiTokenPoolHooksBlocklist'
  protected readonly kind = 'hooks'

  /** Only the external-blocklist hooks have a blocklist. */
  protected override targetTypes(): readonly MultiTokenPoolContractType[] {
    return ['MultiTokenPoolHooksExternalBlocklist']
  }

  protected override prepare(
    params: SetMultiTokenPoolHooksBlocklistParams,
  ): SetMultiTokenPoolHooksBlocklistParams {
    super.prepare(params)
    validateAddress(this.name, 'blocklist', params.blocklist)
    return params
  }

  /** A non-zero blocklist must have deployed code, as a policy engine must. */
  protected async encode(
    chain: EVMChain,
    params: SetMultiTokenPoolHooksBlocklistParams,
    ctx: MultiTokenPoolOwnedWriteContext,
  ): Promise<string> {
    const blocklist = getAddress(params.blocklist)
    if (blocklist !== ZeroAddress)
      await assertDeployedContract(
        this.name,
        'blocklist',
        chain,
        blocklist,
        'blocklist',
        ctx.blockTag,
      )
    return ownedTargetInterface(ctx).encodeFunctionData(multiTokenPoolFunctionOf(this.name), [
      blocklist,
    ])
  }
}
