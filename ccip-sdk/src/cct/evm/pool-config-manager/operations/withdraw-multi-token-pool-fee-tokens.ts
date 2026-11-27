/**
 * withdrawMultiTokenPoolFeeTokens — `pcm.withdrawFeeTokens(pool, feeTokens, recipient)`: withdraws a
 * multi-token pool's whole balance of each fee token through its PoolConfigManager.
 *
 * @packageDocumentation
 */

import { type Interface, type Result, getAddress } from 'ethers'

import type { EVMChain } from '../../../../evm/index.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import FACTORY_BURN_MINT_ERC20_V1_5_1_ABI from '../../artifacts/abi/V1_5_1/factory-burn-mint-erc20.ts'
import {
  type PoolConfigManagerRole,
  POOL_CONFIG_MANAGER_TYPE,
  getMultiTokenPoolInterface,
  multiTokenPoolFunctionOf,
  resolveMultiTokenPool,
} from '../../multi-token-pool/contracts.ts'
import type { EVMExecuteParams } from '../../operation.ts'
import { getTypedContract } from '../../query.ts'
import { validateArray, validateNonZeroAddress } from '../../validate.ts'
import {
  type MultiTokenPoolTransactionResult,
  type MultiTokenPoolUnsignedTx,
  type PoolConfigManagerFacts,
  type PoolConfigManagerWrite,
  type PoolConfigManagerWriteContext,
  PoolConfigManagerWriteOperation,
} from '../write-operation.ts'

/**
 * Parameters of `withdrawMultiTokenPoolFeeTokens`. Not a `PoolConfigManagerTarget`: the pool is always
 * named (the PCM withdraws from it), and the PCM may be given too.
 */
export type WithdrawMultiTokenPoolFeeTokensParams = {
  /** The pool whose balance is withdrawn. */
  poolAddress: string
  /** The PCM to send to; defaults to `pool.getPoolConfigManager()` and must equal it. */
  poolConfigManager?: string
  /** Fee tokens whose whole pool balance to withdraw, at least one. */
  feeTokens: string[]
  /** Non-zero address receiving the balances. */
  recipient: string
  /** A `FEE_COLLECTOR_ROLE` holder; optional when generating an unsigned transaction. */
  sender?: string
}

/** Result of `withdrawMultiTokenPoolFeeTokens`: the amounts, from the pool's `FeeTokenWithdrawn` logs. */
export type WithdrawMultiTokenPoolFeeTokensResult = MultiTokenPoolTransactionResult & {
  /** Each token's amount the pool sent to the recipient. */
  withdrawn: {
    /** The fee token. */
    token: string
    /** The amount sent, in the token's smallest unit. */
    amount: bigint
  }[]
}

/** Params after `prepare`: the target is the pool, the PCM kept to compare. */
type Parsed = Omit<WithdrawMultiTokenPoolFeeTokensParams, 'poolConfigManager'> & {
  /** Never set after `prepare`: the pool is the target. */
  poolConfigManager?: undefined
  /** The PCM the caller named, checked against the pool's. */
  expectedPoolConfigManager?: string
}

/**
 * Withdraws a multi-token pool's fee token balances through its PCM. Gate: `FEE_COLLECTOR_ROLE`
 * (not `DEFAULT_ADMIN_ROLE`). Validation follows main's `withdrawFeeTokens`.
 * @throws {@link CCTParamsInvalidError} if a param is invalid (before any RPC), `poolConfigManager` is
 *   not the pool's, or `sender` lacks the gate
 */
export class WithdrawMultiTokenPoolFeeTokens extends PoolConfigManagerWriteOperation<Parsed> {
  readonly name = 'withdrawMultiTokenPoolFeeTokens'

  /** Validates every address, as main's `withdrawFeeTokens` does; an empty list would mine as a no-op. */
  protected override prepare(params: Parsed): Parsed {
    const raw = params as WithdrawMultiTokenPoolFeeTokensParams
    const { poolAddress, feeTokens, recipient, poolConfigManager } = raw
    validateNonZeroAddress(this.name, 'poolAddress', poolAddress)
    if (poolConfigManager !== undefined)
      validateNonZeroAddress(this.name, 'poolConfigManager', poolConfigManager)
    validateArray(this.name, 'feeTokens', feeTokens, 1)
    feeTokens.forEach((t, i) => validateNonZeroAddress(this.name, `feeTokens[${i}]`, t))
    validateNonZeroAddress(this.name, 'recipient', recipient)
    const { poolConfigManager: _, ...rest } = raw
    return {
      ...rest,
      ...(poolConfigManager !== undefined && {
        expectedPoolConfigManager: getAddress(poolConfigManager),
      }),
    }
  }

  protected gate(): readonly PoolConfigManagerRole[] {
    return ['FEE_COLLECTOR_ROLE']
  }

  // a withdrawal changes no stored record
  protected override changesRecords(): boolean {
    return false
  }

  /**
   * What the withdrawal moves, sealed: the PCM the pool calls, and each fee token's balance at the
   * pool (the whole of it is withdrawn).
   */
  protected override async readFacts(
    chain: EVMChain,
    { poolAddress, feeTokens }: Parsed,
    { address, blockTag }: Pick<PoolConfigManagerWriteContext, 'address' | 'version' | 'blockTag'>,
  ): Promise<PoolConfigManagerFacts> {
    const pool = getAddress(poolAddress)
    const balances = await Promise.all(
      feeTokens.map((t) =>
        getTypedContract(chain, t, FACTORY_BURN_MINT_ERC20_V1_5_1_ABI).balanceOf(pool, {
          blockTag,
        }),
      ),
    )
    return {
      'pool.poolConfigManager': getAddress(address),
      ...Object.fromEntries(
        feeTokens.map((t, i) => [`balances.${getAddress(t)}`, BigInt(balances[i]!)]),
      ),
    }
  }

  /** The pool, tokens and recipient are all in the calldata. */
  override paramsFromCalldata(args: Result, _target: unknown, sender: string): Parsed {
    return {
      poolAddress: getAddress(String(args[0])),
      feeTokens: (args[1] as string[]).map((t) => getAddress(t)),
      recipient: getAddress(String(args[2])),
      sender,
    }
  }

  protected encode(
    _chain: EVMChain,
    { poolAddress, feeTokens, recipient, expectedPoolConfigManager }: Parsed,
    { address, version }: PoolConfigManagerWriteContext,
  ): PoolConfigManagerWrite {
    if (
      expectedPoolConfigManager !== undefined &&
      expectedPoolConfigManager !== getAddress(address)
    )
      throw new CCTParamsInvalidError(
        this.name,
        'poolConfigManager',
        `is not the PoolConfigManager pool ${getAddress(poolAddress)} calls (${getAddress(address)}): omit it, or name the pool's own`,
      )
    return {
      data: getMultiTokenPoolInterface(POOL_CONFIG_MANAGER_TYPE, version).encodeFunctionData(
        multiTokenPoolFunctionOf(this.name),
        [getAddress(poolAddress), feeTokens.map((t) => getAddress(t)), getAddress(recipient)],
      ),
    }
  }

  /**
   * Builds the unsigned transaction from the public params. The pool is always the target, and a
   * named PCM is only compared (`prepare` folds it into `expectedPoolConfigManager`), so the params
   * name both where the PCM write params allow one.
   */
  generateFrom(
    chain: EVMChain,
    params: WithdrawMultiTokenPoolFeeTokensParams,
  ): Promise<MultiTokenPoolUnsignedTx> {
    return this.generate(chain, params as Parsed)
  }

  /**
   * Signs and submits, then reads the amounts from the pool's `FeeTokenWithdrawn` logs in the mined
   * receipt. The pool's event ABI is resolved before sending, so no RPC runs after the money moved.
   * A token with nothing to withdraw emits no log (`FeeTokenHandler` sends only a positive balance),
   * so it is absent from `withdrawn`.
   */
  override async execute(
    chain: EVMChain,
    params: EVMExecuteParams<WithdrawMultiTokenPoolFeeTokensParams>,
  ): Promise<WithdrawMultiTokenPoolFeeTokensResult> {
    const { type, version } = await resolveMultiTokenPool(chain, params.poolAddress)
    const pool = getMultiTokenPoolInterface(type, version)
    return this.executeWith(chain, params as EVMExecuteParams<Parsed>, (receipt) => ({
      withdrawn: feeTokensWithdrawn(receipt.logs, params.poolAddress, pool),
    }))
  }
}

/**
 * The amounts a withdrawal sent, from the pool's own `FeeTokenWithdrawn` logs: a log with the same
 * topic from any other address (another pool, a token) is not one of them.
 * @internal
 */
export function feeTokensWithdrawn(
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
  poolAddress: string,
  pool: Interface,
): { token: string; amount: bigint }[] {
  const event = pool.getEvent('FeeTokenWithdrawn')!
  const from = getAddress(poolAddress)
  return logs
    .filter((log) => getAddress(log.address) === from && log.topics[0] === event.topicHash)
    .map((log) => {
      const { args } = pool.parseLog(log)!
      return { token: getAddress(String(args.feeToken)), amount: BigInt(args.amount) }
    })
}
