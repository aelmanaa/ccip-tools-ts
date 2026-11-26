/**
 * CCT-specific error classes for write operations (prepare → encode → submit).
 * Shared CCIP errors (`CCIPWalletInvalidError`, etc.) live in `../errors/`.
 *
 * @packageDocumentation
 */

import { type CCIPErrorOptions, CCIPError, CCIPErrorCode } from '../errors/index.ts'

// Parameter validation

/**
 * Thrown before any RPC when operation params fail validation. Permanent.
 *
 * @example
 * ```typescript
 * try {
 *   await cct.setPool({ tokenAddress: 'not-an-address', poolAddress, address, wallet })
 * } catch (error) {
 *   if (error instanceof CCTParamsInvalidError) {
 *     console.log(`Invalid ${error.context.operation} param "${error.context.param}"`)
 *   }
 * }
 * ```
 */
export class CCTParamsInvalidError extends CCIPError {
  override readonly name = 'CCTParamsInvalidError'
  /** Creates a params-invalid error. */
  constructor(operation: string, param: string, reason: string, options?: CCIPErrorOptions) {
    super(
      CCIPErrorCode.CCT_PARAMS_INVALID,
      `Invalid ${operation} parameter "${param}": ${reason}`,
      {
        ...options,
        isTransient: false,
        context: { ...options?.context, operation, param, reason },
      },
    )
  }
}

/**
 * Thrown when a supplied SPL token account belongs to a different mint than requested.
 *
 * `context.requestedMint` is the requested mint; `context.resolvedMint` is decoded from the supplied
 * token account. This is permanent: supply an account for the requested mint.
 *
 * @example
 * ```typescript
 * try {
 *   await cct.generateUnsignedApproveToken({ payer, tokenAddress, tokenAccount, delegate, amount })
 * } catch (error) {
 *   if (error instanceof CCTTokenAccountMintMismatchError) {
 *     console.log(error.context.requestedMint, error.context.resolvedMint)
 *   }
 * }
 * ```
 */
export class CCTTokenAccountMintMismatchError extends CCIPError {
  override readonly name = 'CCTTokenAccountMintMismatchError'
  /** Creates a token-account mint-mismatch error. */
  constructor(tokenAccount: string, requestedMint: string, resolvedMint: string) {
    super(
      CCIPErrorCode.CCT_TOKEN_ACCOUNT_MINT_MISMATCH,
      `Token account mint mismatch for ${tokenAccount}: expected ${requestedMint}, got ${resolvedMint}`,
      {
        isTransient: false,
        context: { tokenAccount, requestedMint, resolvedMint },
      },
    )
  }
}

// Transaction submission

/**
 * Thrown when a CCT write fails before broadcast, the transaction reverts after mining,
 * or it mines without the expected effect (e.g. a deployment that produced no contract
 * address). Pre-broadcast failures (signing/RPC) may set `isTransient: true` for network
 * errors; reverts and post-mining anomalies are permanent and include `context.txHash`. For a
 * split Solana operation, `context.committedHashes` contains confirmed prior transaction hashes;
 * state is partially applied and those transactions are permanent.
 *
 * @example
 * ```typescript
 * try {
 *   await cct.setPool({ ...opts, wallet })
 * } catch (error) {
 *   if (error instanceof CCTTxFailedError) {
 *     console.log(`${error.context.operation} failed: ${error.context.reason}`)
 *   }
 * }
 * ```
 */
export class CCTTxFailedError extends CCIPError {
  override readonly name = 'CCTTxFailedError'
  /** Creates a tx-failed error. */
  constructor(operation: string, reason: string, options?: CCIPErrorOptions) {
    super(
      CCIPErrorCode.CCT_TX_FAILED,
      `${partialApplicationPrefix(options?.context)}${operation} failed: ${reason}`,
      {
        ...options,
        isTransient: options?.isTransient ?? false,
        context: { ...options?.context, operation, reason },
      },
    )
  }
}

/**
 * Thrown when a transaction was broadcast but not confirmed within the timeout.
 * Transient — it may still mine; check `context.txHash` before resubmitting. For a split Solana
 * operation, `context.committedHashes` contains confirmed prior transaction hashes; state is
 * partially applied and those transactions are permanent.
 *
 * @example
 * ```typescript
 * try {
 *   await cct.setPool({ ...opts, wallet })
 * } catch (error) {
 *   if (error instanceof CCTTxNotConfirmedError) {
 *     console.log(`Not confirmed (tx ${error.context.txHash}); retry in ${error.retryAfterMs}ms`)
 *   }
 * }
 * ```
 */
export class CCTTxNotConfirmedError extends CCIPError {
  override readonly name = 'CCTTxNotConfirmedError'
  /** Creates a tx-not-confirmed error. */
  constructor(operation: string, txHash: string, options?: CCIPErrorOptions) {
    super(
      CCIPErrorCode.CCT_TX_NOT_CONFIRMED,
      `${partialApplicationPrefix(options?.context)}${operation} transaction not confirmed within timeout: ${txHash}`,
      {
        ...options,
        isTransient: true,
        retryAfterMs: 5000,
        context: { ...options?.context, operation, txHash },
      },
    )
  }
}

function partialApplicationPrefix(context?: Record<string, unknown>): string {
  const committedHashes = context?.committedHashes
  return Array.isArray(committedHashes) && committedHashes.length
    ? `partially applied: ${committedHashes.length} transaction(s) confirmed; `
    : ''
}

// Contract version dispatch

/**
 * Thrown when the contract at an address is not of the expected type.
 *
 * @example
 * ```typescript
 * try {
 *   await cct.transferPoolOwnership({ poolAddress, newOwner, wallet })
 * } catch (error) {
 *   if (error instanceof CCTContractTypeInvalidError) {
 *     console.log(`Expected ${error.context.expected} at ${error.context.address}, got "${error.context.actual}"`)
 *   }
 * }
 * ```
 */
export class CCTContractTypeInvalidError extends CCIPError {
  override readonly name = 'CCTContractTypeInvalidError'
  /**
   * Creates a contract-type-invalid error. `reason` is appended to the message and kept in
   * `context`; pass it when `actual` is a recognized type rejected on its own grounds, so the
   * message does not read as "wrong address".
   */
  constructor(
    address: string,
    expected: string,
    actual: string,
    reason?: string,
    options?: CCIPErrorOptions,
  ) {
    super(
      CCIPErrorCode.CONTRACT_TYPE_INVALID,
      `Expected a ${expected} contract at ${address}, got "${actual}"` +
        (reason ? ` — ${reason}` : ''),
      {
        ...options,
        isTransient: false,
        context: { ...options?.context, address, expected, actual, ...(reason && { reason }) },
      },
    )
  }
}

/**
 * Thrown when a contract reports a version string the SDK does not recognize. Permanent.
 *
 * @example
 * ```typescript
 * try {
 *   await cct.transferPoolOwnership({ poolAddress, newOwner, wallet })
 * } catch (error) {
 *   if (error instanceof CCTContractVersionUnsupportedError) {
 *     console.log(`Unsupported ${error.context.contractType} version: ${error.context.version}`)
 *   }
 * }
 * ```
 */
export class CCTContractVersionUnsupportedError extends CCIPError {
  override readonly name = 'CCTContractVersionUnsupportedError'
  /** Creates a contract-version-unsupported error. */
  constructor(contractType: string, version: string, options?: CCIPErrorOptions) {
    super(
      CCIPErrorCode.CCT_CONTRACT_VERSION_UNSUPPORTED,
      `Unsupported ${contractType} version: ${version}`,
      {
        ...options,
        isTransient: false,
        context: { ...options?.context, contractType, version },
      },
    )
  }
}

/**
 * Thrown when no implementation is registered for an operation at or below the contract's
 * version (floor-match miss). Permanent for that contract version.
 *
 * @example
 * ```typescript
 * try {
 *   await cct.transferPoolOwnership({ poolAddress, newOwner, wallet })
 * } catch (error) {
 *   if (error instanceof CCTOperationUnsupportedError) {
 *     console.log(`${error.context.operation} unsupported at version ${error.context.version}`)
 *   }
 * }
 * ```
 */
export class CCTOperationUnsupportedError extends CCIPError {
  override readonly name = 'CCTOperationUnsupportedError'
  /** Creates an operation-unsupported error. */
  constructor(operation: string, version: string, options?: CCIPErrorOptions) {
    super(
      CCIPErrorCode.CCT_OPERATION_UNSUPPORTED,
      `${operation} is not supported at contract version ${version}`,
      {
        ...options,
        isTransient: false,
        context: { ...options?.context, operation, version },
      },
    )
  }
}

/**
 * Thrown when CCT account data cannot be decoded.
 *
 * @example
 * ```typescript
 * try {
 *   await cct.getTokenPoolState({ tokenAddress: mint })
 * } catch (error) {
 *   if (error instanceof CCTDataDecodeError) {
 *     console.log(error.message)
 *   }
 * }
 * ```
 */
export class CCTDataDecodeError extends CCIPError {
  override readonly name = 'CCTDataDecodeError'
  /** Creates a CCT data decode error. */
  constructor(account: string, options?: CCIPErrorOptions) {
    super(CCIPErrorCode.CCT_DATA_DECODE_FAILED, `Unable to decode CCT data at ${account}`, {
      ...options,
      isTransient: false,
      context: { ...options?.context, account },
    })
  }
}

// State drift

/** One value that moved between a write's build and its re-check, in `CCTStateChangedError` context. */
export type CCTStateChange = {
  /** Dotted path of the value, e.g. `profile.lockOrBurnFlavor`. */
  path: string
  /** The value the write was built against. */
  expected: unknown
  /** The value now on chain. */
  actual: unknown
}

/**
 * Thrown by CCT writes that verify a snapshot of the state they read, when that state moved after
 * the write was built: a snapshot the caller passed back no longer holds, or the signing form of
 * the operation re-read the chain right before sending and found a change.
 *
 * @remarks Permanent (`isTransient: false`): retrying the same call with the same snapshot fails the
 * same way, so generic retry wrappers must not loop on it. Re-read the state and rebuild the write,
 * and reject any pending multisig proposal built from the old state. `context.changed`, when set,
 * lists what moved as {@link CCTStateChange}`[]`.
 *
 * @example
 * ```typescript
 * try {
 *   await submitProposal() // any CCT write that verifies a snapshot
 * } catch (error) {
 *   if (error instanceof CCTStateChangedError) {
 *     const changed = error.context.changed as CCTStateChange[] | undefined
 *     console.log(`State moved for ${error.context.operation}:`, changed)
 *   }
 * }
 * ```
 */
export class CCTStateChangedError extends CCIPError {
  override readonly name = 'CCTStateChangedError'
  /** Creates a state-changed error. */
  constructor(operation: string, reason: string, options?: CCIPErrorOptions) {
    super(
      CCIPErrorCode.CCT_STATE_CHANGED,
      `${operation}: on-chain state changed since the write was built: ${reason}`,
      {
        ...options,
        isTransient: false,
        context: { ...options?.context, operation, reason },
      },
    )
  }
}
