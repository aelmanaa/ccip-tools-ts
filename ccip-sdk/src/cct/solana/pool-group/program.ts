/**
 * Program client and feature probe of the Solana pool-groups program (design §6.2).
 *
 * `type_version` is `2.1.0` upstream and in the fork, and one program ID is upgraded in place
 * through the pool-group stages, so features are probed per instruction: simulate the newest
 * instruction a feature brings against a missing account. `Custom(101)` (fallback not found) =
 * absent; `AccountNotInitialized` (3012) = present; anything else is unknown and fails closed.
 *
 * @packageDocumentation
 */

import { Buffer } from 'buffer'

import { BN } from '@coral-xyz/anchor'
import { type TransactionInstruction, Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import { memoize } from 'micro-memoize'

import { newProgram } from '../../../solana/coder.ts'
import { IDL as POOL_GROUPS_BASE_IDL } from '../../../solana/idl/pool-groups-7558722/BASE_TOKEN_POOL.ts'
import { IDL as POOL_GROUPS_BURN_MINT_IDL } from '../../../solana/idl/pool-groups-7558722/BURN_MINT_TOKEN_POOL.ts'
import type { SolanaChain } from '../../../solana/index.ts'
import {
  SIMULATION_PAYER,
  customInstructionErrorCode,
  getInstructionError,
  simulateTransaction,
  simulationProvider,
} from '../../../solana/utils.ts'
import { CCTOperationUnsupportedError } from '../../errors.ts'
import { deriveTokenPoolProgramDataPda } from '../programs/token-pool.ts'

/** Pool-group features a program may have, oldest first. @internal */
export const POOL_GROUP_PROBED_FEATURES = [
  'groups',
  'hooks',
  'drivenLanes',
  'drivenLanesV2Layout',
] as const
/** One probed feature. @internal */
export type PoolGroupProbedFeature = (typeof POOL_GROUP_PROBED_FEATURES)[number]

/**
 * The pool-groups IDL with the base pool's events and errors, as `composeTokenPoolIdl` does for the
 * canonical pools.
 * @internal
 */
export const POOL_GROUPS_IDL = {
  ...POOL_GROUPS_BURN_MINT_IDL,
  events: POOL_GROUPS_BASE_IDL.events,
  errors: [...POOL_GROUPS_BASE_IDL.errors, ...POOL_GROUPS_BURN_MINT_IDL.errors],
}

/**
 * Creates an Anchor Program client for a pool-groups program.
 *
 * @param chain - The Solana chain.
 * @param poolProgram - The pool program (`poolProgramAddress`).
 * @param payer - Fee payer for simulations and the provider wallet.
 * @returns The program client.
 * @internal
 */
export function createPoolGroupProgram(
  chain: SolanaChain,
  poolProgram: PublicKey,
  payer: PublicKey = SIMULATION_PAYER,
) {
  return newProgram(POOL_GROUPS_IDL, poolProgram, simulationProvider(chain, payer))
}

/** `InstructionFallbackNotFound`: the program has no such instruction. */
const ABSENT = 101
/** `InstructionDidNotDeserialize`: the instruction exists with an older argument layout. */
const OLD_LAYOUT = 102
/** `AccountNotInitialized`: the instruction ran into the missing account, so it exists. */
const PRESENT = 3012

// Slot of the last deploy in `UpgradeableLoaderState::ProgramData` (u32 variant, then u64 slot)
const PROGRAM_DATA_SLOT_OFFSET = 4
const PROGRAM_DATA_HEADER_LEN = 45

/** The probe instruction of each feature, against a fresh (missing) group. */
async function probeInstruction(
  chain: SolanaChain,
  poolProgram: PublicKey,
  feature: PoolGroupProbedFeature,
): Promise<TransactionInstruction> {
  const program = createPoolGroupProgram(chain, poolProgram)
  const group = Keypair.generate().publicKey
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    poolProgram,
  )
  const lanes = {
    group,
    groupChainPolicy: Keypair.generate().publicKey,
    groupRegistry: Keypair.generate().publicKey,
    authority: SIMULATION_PAYER,
    systemProgram: SystemProgram.programId,
    eventAuthority,
    program: poolProgram,
  }
  switch (feature) {
    case 'groups':
      return program.methods.observeGroup().accountsStrict({ group }).instruction()
    case 'hooks':
      return program.methods
        .createAllowlist({
          listId: Keypair.generate().publicKey,
          enabled: false,
          admin: SIMULATION_PAYER,
        })
        .accountsStrict({
          group,
          allowlist: Keypair.generate().publicKey,
          authority: SIMULATION_PAYER,
          systemProgram: SystemProgram.programId,
          eventAuthority,
          program: poolProgram,
        })
        .instruction()
    case 'drivenLanes':
      return program.methods.materializeGroupLanes(new BN(1)).accountsStrict(lanes).instruction()
    case 'drivenLanesV2Layout':
      // the older layout's `by_token_owner: bool` cannot decode 2
      return program.methods
        .closeGroupLanes(new BN(1), { recordCount: 2 })
        .accountsStrict(lanes)
        .instruction()
  }
}

/** Probes one feature: present, absent, or throws when the answer is unknown. */
async function probe(
  chain: SolanaChain,
  poolProgram: PublicKey,
  feature: PoolGroupProbedFeature,
): Promise<boolean> {
  const ix = await probeInstruction(chain, poolProgram, feature)
  let code: number | undefined
  let detail: unknown
  try {
    await simulateTransaction(chain, { payerKey: SIMULATION_PAYER, instructions: [ix] })
  } catch (err) {
    code = customInstructionErrorCode(err)
    detail = getInstructionError(err)?.error ?? (err instanceof Error ? err.message : err)
  }
  if (code === PRESENT) return true
  if (code === ABSENT || (feature === 'drivenLanesV2Layout' && code === OLD_LAYOUT)) return false
  throw new CCTOperationUnsupportedError('getPoolGroupFeatures', 'unknown', {
    context: {
      poolProgram: poolProgram.toBase58(),
      feature,
      reason: `the probe of ${feature} answered ${JSON.stringify(detail ?? 'success')}, neither present (3012) nor absent (101)`,
    },
  })
}

/**
 * The slot of a program's last deploy, the probe cache key: an upgrade in place changes the
 * features. Reads only the program data header.
 */
async function lastDeploySlot(chain: SolanaChain, poolProgram: PublicKey): Promise<bigint> {
  const info = await chain.connection.getAccountInfo(deriveTokenPoolProgramDataPda(poolProgram), {
    dataSlice: { offset: 0, length: PROGRAM_DATA_HEADER_LEN },
  })
  if (!info || info.data.length < PROGRAM_DATA_SLOT_OFFSET + 8)
    throw new CCTOperationUnsupportedError('getPoolGroupFeatures', 'unknown', {
      context: {
        poolProgram: poolProgram.toBase58(),
        reason: 'the pool program has no upgradeable program data to key the feature probe on',
      },
    })
  return info.data.readBigUInt64LE(PROGRAM_DATA_SLOT_OFFSET)
}

const probeOne = (
  chain: SolanaChain,
  program: string,
  _slot: bigint,
  feature: PoolGroupProbedFeature,
) => probe(chain, new PublicKey(program), feature)

const caches = new WeakMap<SolanaChain, typeof probeOne>()

/**
 * Probes which pool-group features `poolProgram` has, cached per chain by program, last-deploy slot
 * and feature.
 *
 * @param chain - The Solana chain.
 * @param poolProgram - The pool program.
 * @param opts - `groupExists`: a `Group` was decoded at a PDA of this program, which proves
 *   `groups` and skips its probe.
 * @returns The present features, in {@link POOL_GROUP_PROBED_FEATURES} order.
 * @throws {@link CCTOperationUnsupportedError} when a probe answers neither present nor absent (a
 *   missing simulation payer, a non-executable program), or the program has no program data
 * @throws the RPC's errors, unchanged
 * @internal
 */
export async function getPoolGroupProgramFeatures(
  chain: SolanaChain,
  poolProgram: PublicKey,
  opts: { groupExists?: boolean } = {},
): Promise<PoolGroupProbedFeature[]> {
  let cached = caches.get(chain)
  if (!cached) {
    cached = memoize(probeOne, { async: true, maxArgs: 4, maxSize: 100 })
    caches.set(chain, cached)
  }
  const slot = await lastDeploySlot(chain, poolProgram)
  const present: PoolGroupProbedFeature[] = []
  for (const feature of POOL_GROUP_PROBED_FEATURES)
    if (
      (feature === 'groups' && opts.groupExists) ||
      (await cached(chain, poolProgram.toBase58(), slot, feature))
    )
      present.push(feature)
  return present
}
