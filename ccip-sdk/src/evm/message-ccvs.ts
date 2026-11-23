import {
  type JsonRpcApiProvider,
  Contract,
  ZeroAddress,
  dataLength,
  getAddress,
  hexlify,
  toBeHex,
  zeroPadValue,
} from 'ethers'
import type { TypedContract } from 'ethers-abitype'

import { type FinalityRequested, encodeFinality } from '../extra-args.ts'
import type { AnyMessage } from '../types.ts'
import type OnRamp_2_0_ABI from './abi/OnRamp_2_0.ts'
import type TokenPool_2_0_ABI from './abi/TokenPool_2_0.ts'
import { interfaces } from './const.ts'
import { IPOOL_V2_INTERFACE_ID, probeSupportsInterface } from './simulate.ts'

/** `IPoolV2.MessageDirection.Outbound` */
const OUTBOUND = 0n

/** Appends the addresses of `add` missing from `list` (the OnRamp's duplicate-skipping merge). */
function appendNew(list: string[], add: readonly string[]): void {
  for (const ccv of add) if (!list.includes(ccv)) list.push(ccv)
}

/**
 * Predicts the CCV list an EVM `OnRamp` 2.0 puts on a message (the CCVs whose verifications the
 * destination will receive), resolving it as `OnRamp.forwardFromRouter` does:
 *
 * 1. the user's `extraArgs.ccvs`, or the lane's `defaultCCVs` when none is given or in place of an
 *    `address(0)` placeholder; none at all for a token-only transfer (no data, a token, gas limit 0)
 *    without user CCVs;
 * 2. plus the lane's `laneMandatedCCVs`;
 * 3. plus, per token, its source pool's outbound `getRequiredCCVs` (the lane defaults for a pool
 *    without IPoolV2 or with an empty list, and in place of an `address(0)` entry);
 *
 * skipping duplicates at each step.
 *
 * @param provider - Source chain provider
 * @param opts - `onRamp` (a 2.0 OnRamp), `destChainSelector`, and the message as built for the
 *   destination (`buildMessageForDest`), whose `extraArgs` carry `gasLimit` and, for
 *   GenericExtraArgsV3, `ccvs`, `finality` and `tokenArgs`
 * @returns The predicted CCV addresses, in the OnRamp's order
 * @throws The provider error if a read fails (no partial answer)
 */
export async function getOnRampMessageCCVs(
  provider: JsonRpcApiProvider,
  {
    onRamp,
    destChainSelector,
    message,
  }: { onRamp: string; destChainSelector: bigint; message: AnyMessage },
): Promise<string[]> {
  const contract = new Contract(
    onRamp,
    interfaces.OnRamp_v2_0,
    provider,
  ) as unknown as TypedContract<typeof OnRamp_2_0_ABI>
  const destChainConfig = await contract.getDestChainConfig(destChainSelector)
  const defaults = destChainConfig.defaultCCVs.map((a) => getAddress(a as string))
  const mandated = destChainConfig.laneMandatedCCVs.map((a) => getAddress(a as string))

  const { extraArgs } = message
  // GenericExtraArgsV3 carries CCVs, finality and tokenArgs; legacy (V1/V2) args none of them
  const v3 = 'ccvs' in extraArgs ? extraArgs : undefined
  // ccip-cli's `-x ccvs=[0x0000…0000, …]` parses the zero address as the number 0
  const userCCVs = (v3?.ccvs ?? []).map((a) => getAddress(zeroPadValue(toBeHex(BigInt(a)), 20)))
  const finalityRequested: FinalityRequested = v3?.finality ?? 'finalized'
  const tokenArgs = v3?.tokenArgs ? hexlify(v3.tokenArgs) : '0x'
  const tokenAmounts = message.tokenAmounts ?? []
  const gasLimit = 'gasLimit' in extraArgs ? extraArgs.gasLimit : undefined
  const tokenOnly = !dataLength(message.data || '0x') && tokenAmounts.length > 0 && !gasLimit

  const ccvs: string[] = []
  if (!userCCVs.length) {
    if (!tokenOnly) appendNew(ccvs, defaults)
  } else {
    // user CCVs first; the placeholder pulls in the defaults after them
    appendNew(
      ccvs,
      userCCVs.filter((a) => a !== ZeroAddress),
    )
    if (userCCVs.includes(ZeroAddress)) appendNew(ccvs, defaults)
  }
  appendNew(ccvs, mandated)

  const finality = zeroPadValue(toBeHex(encodeFinality(finalityRequested)), 4)
  for (const { token, amount } of tokenAmounts) {
    const pool = (await contract.getPoolBySourceToken(destChainSelector, token)) as string
    if (!(await probeSupportsInterface(provider, pool, IPOOL_V2_INTERFACE_ID))) {
      appendNew(ccvs, defaults)
      continue
    }
    const poolContract = new Contract(
      pool,
      interfaces.TokenPool_v2_0,
      provider,
    ) as unknown as TypedContract<typeof TokenPool_2_0_ABI>
    const required = (
      await poolContract.getRequiredCCVs(
        token,
        destChainSelector,
        amount,
        finality,
        tokenArgs,
        OUTBOUND,
      )
    ).map((a) => getAddress(a as string))
    if (!required.length) {
      appendNew(ccvs, defaults)
      continue
    }
    appendNew(
      ccvs,
      required.filter((a) => a !== ZeroAddress),
    )
    if (required.includes(ZeroAddress)) appendNew(ccvs, defaults)
  }
  return ccvs
}
