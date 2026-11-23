import { Buffer } from 'buffer'

import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToCheckedInstruction,
  getMint,
} from '@solana/spl-token'
import { type AccountMeta, type TransactionInstruction, PublicKey } from '@solana/web3.js'
import BN from 'bn.js'
import type { BytesLike } from 'ethers'

import type { WithLogger } from '../types.ts'
import { bytesToBuffer, getAddressBytes, getDataBytes, toLeArray } from '../utils.ts'
import { newProgram, sizedCoder } from './coder.ts'
import { IDL as RECEIVER_IDL } from './idl/1.6.0/CCIP_RECEIVER.ts'
import { IDL as RECEIVER_V2_IDL } from './idl/2.0.0/CCIP_RECEIVER.ts'
import { resolveATA, simulateTransaction, simulationProvider } from './utils.ts'

const SIMULATION_PAYER = new PublicKey('11111111111111111111111111111112')

/** Schema version of the Router's `ReceiverRegistry` account the OffRamp accepts. */
const RECEIVER_REGISTRY_SCHEMA_VERSION = 1
/** `ReceiverRegistry.receiverVersion` of a receiver exposing `ccip_receive_v2`. */
const RECEIVER_INTERFACE_V2 = 2

type EstimateExecComputeUnitsOpts = {
  connection: Parameters<typeof simulationProvider>[0]['connection']
  router: string
  offRamp: string
  /**
   * Version of `offRamp` (from `typeAndVersion`). A 2.x OffRamp delivers to receivers registered v2
   * in the Router's `ReceiverRegistry` through `ccip_receive_v2`; any other value (or none) keeps the
   * v1 `ccip_receive` simulation, which is what a 1.6 OffRamp always calls.
   */
  offRampVersion?: string
  message: {
    sourceChainSelector: bigint
    messageId: string
    receiver: string
    sender?: string
    data?: BytesLike
    tokenReceiver?: string
    destTokenAmounts?: readonly ((
      | { token: string }
      | { destTokenAddress: string; extraData?: string }
    ) & { amount: bigint })[]
    accounts?: readonly string[]
    accountIsWritableBitmap?: bigint
  }
} & WithLogger

function getReceiverRemainingAccounts(
  accounts: readonly string[] | undefined,
  accountIsWritableBitmap: bigint | undefined,
): AccountMeta[] {
  const bitmap = accountIsWritableBitmap ?? 0n
  return (accounts ?? []).map((account, index) => ({
    pubkey: new PublicKey(account),
    isSigner: false,
    isWritable: (bitmap & (1n << BigInt(index))) !== 0n,
  }))
}

async function getTokenSetupInstructions({
  connection,
  message,
  payer,
  logger,
}: {
  connection: EstimateExecComputeUnitsOpts['connection']
  message: EstimateExecComputeUnitsOpts['message']
  payer: PublicKey
} & WithLogger): Promise<TransactionInstruction[]> {
  if (!message.tokenReceiver || !message.destTokenAmounts?.length) return []

  const tokenReceiver = new PublicKey(message.tokenReceiver)
  if (tokenReceiver.equals(PublicKey.default)) return []

  const instructions: TransactionInstruction[] = []
  for (const tokenAmount of message.destTokenAmounts) {
    const mint = new PublicKey(
      'token' in tokenAmount ? tokenAmount.token : tokenAmount.destTokenAddress,
    )
    const { ata, tokenProgram } = await resolveATA(connection, mint, tokenReceiver)
    const mintInfo = await getMint(connection, mint, undefined, tokenProgram)
    if (!mintInfo.mintAuthority) {
      logger?.debug('Skipping Solana token setup; mint has no authority:', mint.toBase58())
      continue
    }

    const ataInfo = await connection.getAccountInfo(ata)
    if (!ataInfo) {
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          payer,
          ata,
          tokenReceiver,
          mint,
          tokenProgram,
        ),
      )
    }

    instructions.push(
      createMintToCheckedInstruction(
        mint,
        ata,
        mintInfo.mintAuthority,
        tokenAmount.amount,
        mintInfo.decimals,
        [],
        tokenProgram,
      ),
    )
  }

  return instructions
}

/**
 * Reads which CCIP receiver interface the 2.0 OffRamp will call on `receiver`, the way the OffRamp
 * decides it: from the Router-owned `ReceiverRegistry` PDA `[b"receiver_registry", receiver]`.
 * An absent (or not Router-owned) account means v1 `ccip_receive`; a registry entry with
 * `receiverVersion == 2` means `ccip_receive_v2`.
 *
 * @param opts - `connection`, the destination `router` and the `receiver` program.
 * @returns `2` for a receiver registered v2, `1` otherwise.
 */
export async function getReceiverInterfaceVersion({
  connection,
  router,
  receiver,
  logger = console,
}: {
  connection: EstimateExecComputeUnitsOpts['connection']
  router: string
  receiver: string
} & WithLogger): Promise<1 | 2> {
  const routerProgram = new PublicKey(router)
  const [registry] = PublicKey.findProgramAddressSync(
    [Buffer.from('receiver_registry'), new PublicKey(receiver).toBuffer()],
    routerProgram,
  )
  const info = await connection.getAccountInfo(registry)
  if (!info?.owner.equals(routerProgram)) return 1
  try {
    const decoded = sizedCoder(RECEIVER_V2_IDL).accounts.decode<{
      version: number
      receiverVersion: number
    }>('ReceiverRegistry', info.data)
    if (decoded.version !== RECEIVER_REGISTRY_SCHEMA_VERSION) {
      logger.debug('Unknown ReceiverRegistry schema version; assuming a v1 receiver:', decoded)
      return 1
    }
    return decoded.receiverVersion === RECEIVER_INTERFACE_V2 ? 2 : 1
  } catch (err) {
    logger.debug('Undecodable ReceiverRegistry account; assuming a v1 receiver:', registry, err)
    return 1
  }
}

/**
 * The `sender` bytes the OffRamp hands to the receiver: a non-Solana sender shorter than 32 bytes
 * (an EVM address) arrives left-padded to 32 bytes (`abi.encode(address)`), as receivers seeding
 * approved-sender PDAs with it expect.
 */
function receiverSenderBytes(sender: string | undefined): Buffer {
  if (!sender) return Buffer.alloc(0)
  const bytes = getAddressBytes(sender)
  if (bytes.length >= 32) return bytesToBuffer(bytes)
  return Buffer.concat([Buffer.alloc(32 - bytes.length), bytesToBuffer(bytes)])
}

/**
 * Estimate compute units consumed by a Solana receiver `ccip_receive` (v1) or `ccip_receive_v2`
 * callback.
 *
 * This intentionally simulates the receiver callback directly, not full OffRamp execution. The first
 * three accounts follow the standard Solana CCIP receiver convention: OffRamp external execution
 * authority PDA, OffRamp program id, and Router allowed-offramp PDA. With a 2.x `offRampVersion`,
 * the entrypoint and payload follow the receiver's `ReceiverRegistry` entry, as the OffRamp does
 * (see {@link getReceiverInterfaceVersion}).
 */
export async function estimateExecComputeUnits({
  connection,
  router,
  offRamp,
  offRampVersion,
  message,
  logger = console,
}: EstimateExecComputeUnitsOpts): Promise<number> {
  const receiver = new PublicKey(message.receiver)
  if (receiver.equals(PublicKey.default)) return 0

  const offRampProgram = new PublicKey(offRamp)
  const [authority] = PublicKey.findProgramAddressSync(
    [Buffer.from('external_execution_config'), receiver.toBuffer()],
    offRampProgram,
  )
  const [allowedOfframp] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('allowed_offramp'),
      Buffer.from(toLeArray(message.sourceChainSelector, 8)),
      offRampProgram.toBuffer(),
    ],
    new PublicKey(router),
  )
  const receiverInterface =
    offRampVersion != null && Number(offRampVersion.split('.')[0]) >= 2
      ? await getReceiverInterfaceVersion({
          connection,
          router,
          receiver: message.receiver,
          logger,
        })
      : 1
  const provider = simulationProvider({ connection, logger })
  const accounts = { authority, offrampProgram: offRampProgram, allowedOfframp }
  const remainingAccounts = getReceiverRemainingAccounts(
    message.accounts,
    message.accountIsWritableBitmap,
  )
  const destTokenAmounts = (message.destTokenAmounts ?? []).map((tokenAmount) => ({
    token: new PublicKey('token' in tokenAmount ? tokenAmount.token : tokenAmount.destTokenAddress),
    amount: new BN(tokenAmount.amount.toString()),
  }))

  let receiveIx
  if (receiverInterface === 2) {
    // the 2.0 OffRamp's `Any2SVMMessageV2`: at most one token transfer, with where it was delivered
    if (destTokenAmounts.length > 1)
      logger.debug('v2 receivers take one token transfer; estimating with the first only')
    const [tokenAmount] = destTokenAmounts
    receiveIx = await newProgram(RECEIVER_V2_IDL, receiver, provider)
      .methods.ccipReceiveV2({
        messageId: Array.from(getDataBytes(message.messageId)),
        sourceChainSelector: new BN(message.sourceChainSelector.toString()),
        sender: receiverSenderBytes(message.sender),
        data: bytesToBuffer(message.data ? getDataBytes(message.data) : []),
        tokenTransfer: tokenAmount
          ? {
              tokenAmount,
              tokenReceiver: message.tokenReceiver
                ? new PublicKey(message.tokenReceiver)
                : PublicKey.default,
              tokenReceiverUsage: { deriveAtaAndCreate: {} },
            }
          : null,
      })
      .accounts(accounts)
      .remainingAccounts(remainingAccounts)
      .instruction()
  } else {
    receiveIx = await newProgram(RECEIVER_IDL, receiver, provider)
      .methods.ccipReceive({
        messageId: Array.from(getDataBytes(message.messageId)),
        sourceChainSelector: new BN(message.sourceChainSelector.toString()),
        sender: bytesToBuffer(message.sender ? getAddressBytes(message.sender) : []),
        data: bytesToBuffer(message.data ? getDataBytes(message.data) : []),
        tokenAmounts: destTokenAmounts,
      })
      .accounts(accounts)
      .remainingAccounts(remainingAccounts)
      .instruction()
  }

  const setupIxs = await getTokenSetupInstructions({
    connection,
    message,
    payer: SIMULATION_PAYER,
    logger,
  }).catch((err: unknown) => {
    logger.debug('Failed to build Solana token setup instructions; simulating receiver only:', err)
    return []
  })

  const simResult = await simulateTransaction(
    { connection, logger },
    { payerKey: SIMULATION_PAYER, instructions: [...setupIxs, receiveIx] },
  )

  let re
  for (const log of (simResult.logs ?? []).toReversed()) {
    re ??= new RegExp(`^Program ${message.receiver} consumed (\\d+)\\b`)
    const match = log.match(re)
    if (match && Number(match[1]) > 0) {
      return Number(match[1])
    }
  }

  return simResult.unitsConsumed ?? 0
}
