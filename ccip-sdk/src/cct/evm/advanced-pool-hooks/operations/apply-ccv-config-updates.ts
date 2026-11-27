/**
 * applyCCVConfigUpdates — replaces complete per-remote-chain CCV requirements on an
 * `AdvancedPoolHooks`.
 *
 * @remarks Base CCVs apply to every transfer; threshold CCVs add requirements above the hooks'
 * configured threshold. This writes all four lists for every supplied selector — it does not merge
 * with the current config or read it to fill omitted fields. Empty base and threshold lists clear a
 * selector's configuration; threshold lists require their corresponding base list to be non-empty.
 * `address(0)` is valid in any list and requests the default CCV alongside any explicitly named
 * CCVs.
 *
 * Owner-only. The target's `typeAndVersion()` is checked before building calldata, so an EOA or an
 * unrelated Ownable contract cannot produce an unsigned no-op or misrouted transaction.
 *
 * @packageDocumentation
 */

import type { EVMChain } from '../../../../evm/index.ts'
import type { UnsignedEVMTx } from '../../../../evm/types.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { redirectMultiTokenPool } from '../../multi-token-pool/pool-reads.ts'
import { EVMOperation, callTx } from '../../operation.ts'
import { parseRecord, validateArray, validateUint64 } from '../../validate.ts'
import {
  type AdvancedPoolHooksTarget,
  type CCVConfigUpdate,
  ADVANCED_POOL_HOOKS_INTERFACE,
  assertAdvancedPoolHooksOwner,
  resolveAdvancedPoolHooksTarget,
  validateAdvancedPoolHooksTarget,
  validateCCVList,
} from '../contracts.ts'

/** Parameters for {@link ApplyCCVConfigUpdates}. */
export type ApplyCCVConfigUpdatesParams = AdvancedPoolHooksTarget & {
  /** Complete replacements to apply; an empty array is a permitted on-chain no-op. */
  ccvConfigArgs: CCVConfigUpdate[]
  /**
   * Hooks owner. Sets `tx.from` for offline / multisig signing and, when supplied, is checked
   * against the hooks' on-chain `owner()` before calldata is built. Optional for
   * {@link ApplyCCVConfigUpdates.generate}; {@link ApplyCCVConfigUpdates.execute} defaults it to
   * the signing wallet.
   */
  sender?: string
}

function validateCCVConfig(operation: string, param: string, value: unknown): void {
  const config = parseRecord(operation, param, value, 'CCV config update')
  validateUint64(operation, `${param}.remoteChainSelector`, config.remoteChainSelector)
  const outbound = validateCCVList(operation, `${param}.outboundCCVs`, config.outboundCCVs)
  const thresholdOutbound = validateCCVList(
    operation,
    `${param}.thresholdOutboundCCVs`,
    config.thresholdOutboundCCVs,
  )
  const inbound = validateCCVList(operation, `${param}.inboundCCVs`, config.inboundCCVs)
  const thresholdInbound = validateCCVList(
    operation,
    `${param}.thresholdInboundCCVs`,
    config.thresholdInboundCCVs,
  )
  if (thresholdOutbound.length > 0 && outbound.length === 0)
    throw new CCTParamsInvalidError(
      operation,
      `${param}.outboundCCVs`,
      'must not be empty when thresholdOutboundCCVs is set',
    )
  if (thresholdInbound.length > 0 && inbound.length === 0)
    throw new CCTParamsInvalidError(
      operation,
      `${param}.inboundCCVs`,
      'must not be empty when thresholdInboundCCVs is set',
    )
  for (const address of thresholdOutbound)
    if (outbound.includes(address))
      throw new CCTParamsInvalidError(
        operation,
        `${param}.thresholdOutboundCCVs`,
        'must not duplicate outboundCCVs',
      )
  for (const address of thresholdInbound)
    if (inbound.includes(address))
      throw new CCTParamsInvalidError(
        operation,
        `${param}.thresholdInboundCCVs`,
        'must not duplicate inboundCCVs',
      )
}

/** Applies complete CCV config replacements. Owner-only. */
export class ApplyCCVConfigUpdates extends EVMOperation<ApplyCCVConfigUpdatesParams> {
  readonly name = 'applyCCVConfigUpdates'

  /** Validates the hooks target and contract CCV constraints before any RPC. */
  protected override prepare(params: ApplyCCVConfigUpdatesParams): ApplyCCVConfigUpdatesParams {
    validateAdvancedPoolHooksTarget(this.name, params)
    const { ccvConfigArgs } = params
    validateArray(this.name, 'ccvConfigArgs', ccvConfigArgs)
    ccvConfigArgs.forEach((config, i) =>
      validateCCVConfig(this.name, `ccvConfigArgs[${i}]`, config),
    )
    return params
  }

  /**
   * Confirms the target is `AdvancedPoolHooks`, checks `sender` when supplied, then encodes the
   * update calldata.
   * @throws {@link CCTContractTypeInvalidError} if the target is not `AdvancedPoolHooks`
   * @throws {@link CCTParamsInvalidError} if `sender` is supplied and is not the hooks owner
   * @throws as {@link resolveAdvancedPoolHooks} for a `poolAddress` target
   */
  protected async buildUnsigned(
    chain: EVMChain,
    params: ApplyCCVConfigUpdatesParams,
  ): Promise<UnsignedEVMTx> {
    const { ccvConfigArgs, sender } = params
    const hooks = await resolveAdvancedPoolHooksTarget(this.name, chain, params).catch(
      (err: unknown) =>
        redirectMultiTokenPool(
          err,
          'applyMultiTokenPoolInlineSecurityConfigUpdates',
          'set: [{ tokenAddress, remoteChainSelector, securityConfig: { outboundCCVs, inboundCCVs, hook } }] per lane, since a multi-token pool keeps its CCVs in the PoolConfigManager, not in AdvancedPoolHooks; for a policy every token shares, applyMultiTokenPoolSecurityPolicyConfigUpdates',
        ),
    )
    if (sender !== undefined) await assertAdvancedPoolHooksOwner(this.name, chain, hooks, sender)
    return callTx(
      hooks,
      ADVANCED_POOL_HOOKS_INTERFACE.encodeFunctionData('applyCCVConfigUpdates', [ccvConfigArgs]),
    )
  }
}
