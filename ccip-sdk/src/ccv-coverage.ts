import type { Chain } from './chain.ts'
import { CCIPVersionUnsupportedError } from './errors/index.ts'
import { EVMChain } from './evm/index.ts'
import { getOnRampMessageCCVs } from './evm/message-ccvs.ts'
import { type GetRequiredCCVsResult, getRequiredCCVs } from './gas.ts'
import { buildMessageForDest } from './requests.ts'
import { type MessageInput, CCIPVersion } from './types.ts'

/** Options for {@link getCCVCoverage}. */
export type GetCCVCoverageOpts = {
  /** Source chain */
  source: Chain
  /** Destination chain */
  dest: Chain
  /** Source Router or OnRamp address */
  routerOrRamp: string
  /** The message as it will be sent, and its sender (the destination's view is sender-scoped) */
  message: MessageInput & { sender?: string }
}

/**
 * The destination's CCV requirement for a message, next to the CCVs the source will put on it.
 */
export type CCVCoverage = GetRequiredCCVsResult & {
  /**
   * CCVs the source OnRamp will put on the message, as it resolves them (user or lane defaults, lane
   * mandated, the token pools' own); `undefined` when the source family can't be predicted yet.
   */
  messageCCVs?: readonly string[]
  /** CCV verifications the executor needs: `requiredCCVs.length + optionalThreshold`. */
  needed: number
  /**
   * `false` when the message carries fewer CCVs than `needed`: the executor never executes such a
   * message (it drops it as an impossible quorum; only a manual execution after the destination's
   * configuration changes can deliver it). `true` only means the count allows a quorum, not that
   * the carried CCVs are the required ones (source and destination CCV addresses differ, so they
   * can't be matched pre-send). `undefined` when `messageCCVs` is unknown.
   */
  enoughCCVs?: boolean
}

/**
 * Compares the CCVs a CCIP 2.0 destination requires for a message with the number of CCVs the
 * source will put on it, before it is sent. The executor drops a message for good when
 * `requiredCCVs.length + optionalThreshold` exceeds the CCVs it carries; this tells a sender in
 * advance.
 *
 * The destination side is {@link getRequiredCCVs} (EVM destinations). The source side is predicted
 * for EVM `OnRamp` 2.0 sources; for other source families `messageCCVs` and `enoughCCVs` are
 * `undefined`.
 *
 * @param opts - {@link GetCCVCoverageOpts}
 * @returns The destination requirement, the predicted message CCVs and the verdict
 * @throws {@link CCIPVersionUnsupportedError} if the lane's OnRamp is not 2.0 (no CCVs before 2.0)
 * @throws {@link CCIPMethodUnsupportedError} if the destination family has no required-CCV view
 *
 * @example
 * ```typescript
 * const coverage = await getCCVCoverage({
 *   source,
 *   dest,
 *   routerOrRamp: router,
 *   message: { receiver, data: '0x01', sender },
 * })
 * if (coverage.enoughCCVs === false)
 *   console.warn(`carries ${coverage.messageCCVs?.length}, needs ${coverage.needed}`)
 * ```
 */
export async function getCCVCoverage({
  source,
  dest,
  routerOrRamp,
  message,
}: GetCCVCoverageOpts): Promise<CCVCoverage> {
  const destChainSelector = dest.network.chainSelector
  const [type] = await source.typeAndVersion(routerOrRamp)
  const onRamp = type.includes('OnRamp')
    ? routerOrRamp
    : await source.getOnRampForRouter(routerOrRamp, destChainSelector)
  const [, version, typeAndVersion] = await source.typeAndVersion(onRamp)
  if (version < CCIPVersion.V2_0)
    throw new CCIPVersionUnsupportedError(version, { context: { onRamp, typeAndVersion } })

  const built = buildMessageForDest(message, dest.network.family)
  const finality = 'finality' in built.extraArgs ? built.extraArgs.finality : undefined
  const required = await getRequiredCCVs({
    source,
    dest,
    routerOrRamp: onRamp,
    message: {
      sender: message.sender,
      receiver: built.receiver,
      data: built.data,
      tokenAmounts: built.tokenAmounts,
      ...(finality != null && { finality }),
    },
  })
  const needed = required.requiredCCVs.length + Number(required.optionalThreshold)

  if (!(source instanceof EVMChain)) return { ...required, needed }
  const messageCCVs = await getOnRampMessageCCVs(source.provider, {
    onRamp,
    destChainSelector,
    message: built,
  })
  return { ...required, needed, messageCCVs, enoughCCVs: messageCCVs.length >= needed }
}
