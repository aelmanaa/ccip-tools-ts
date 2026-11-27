import type { PublicKey } from '@solana/web3.js'

import type { SolanaChain } from '../../../../solana/index.ts'
import { getMultipleAccountsInfoPaged } from '../../../../solana/utils.ts'
import { CCTParamsInvalidError } from '../../../errors.ts'
import { SolanaQuery } from '../../query.ts'
import { U32_MAX, validateInteger } from '../../validate.ts'
import { poolGroupPdas } from '../accounts.ts'
import { decodeClassBits, decodeSections, toBigInt } from '../decode.ts'
import type {
  GetPoolGroupPolicyChainRecordParams,
  GetPoolGroupPolicyChainRecordResult,
  GetPoolGroupPolicyParams,
  GetPoolGroupPolicyResult,
} from '../types.ts'
import {
  type ParsedPoolGroupRef,
  decodeOwned,
  parsePoolGroupRef,
  readPoolGroup,
  validateSelector,
} from './common.ts'

/** Reads a named policy of `group` and its chain records. @internal */
async function readPolicy(
  operation: string,
  chain: SolanaChain,
  ref: ParsedPoolGroupRef,
  id: number,
) {
  const address = poolGroupPdas.policy(ref.program, ref.group, id)
  const {
    now,
    extras: [account],
  } = await readPoolGroup(operation, chain, ref, [address])
  if (!account)
    throw new CCTParamsInvalidError(operation, 'policyId', `the pool group has no policy ${id}`)
  return { address, now, policy: decodeOwned('policy', account, address, ref.program) }
}

/** Decodes the policy chain records at `addresses` (all must exist). */
async function readChainRecords(
  operation: string,
  chain: SolanaChain,
  program: PublicKey,
  policy: PublicKey,
  policyId: number,
  selectors: bigint[],
  now: bigint,
): Promise<GetPoolGroupPolicyChainRecordResult[]> {
  const addresses = selectors.map((s) => poolGroupPdas.policyChain(program, policy, s))
  const accounts = await getMultipleAccountsInfoPaged(chain.connection, addresses)
  return accounts.map((account, i) => {
    const address = addresses[i]!
    if (!account)
      throw new CCTParamsInvalidError(
        operation,
        'remoteChainSelector',
        `policy ${policyId} has no chain record for ${selectors[i]}`,
      )
    const record = decodeOwned('policyChainRecord', account, address, program)
    return {
      address: address.toBase58(),
      policyAddress: policy.toBase58(),
      policyId,
      remoteChainSelector: toBigInt(record.remoteChainSelector),
      classes: decodeClassBits(record.classes),
      inheritsDefault: decodeClassBits(record.inheritsDefault),
      laneRefCount: record.laneRefCount,
      sections: decodeSections(record.sections, now, toBigInt(record.remoteChainSelector)),
      securityGeneration: record.securityGeneration,
    }
  })
}

type ParsedPolicy = ParsedPoolGroupRef & { policyId: number; withChainRecords: boolean }

/** Decodes a named policy, optionally with its chain records. */
export class GetPoolGroupPolicy extends SolanaQuery<
  GetPoolGroupPolicyParams,
  GetPoolGroupPolicyResult,
  ParsedPolicy
> {
  readonly name = 'getPoolGroupPolicy'

  /** @throws {@link CCTParamsInvalidError} if the ref or policy id is invalid */
  protected prepare(params: GetPoolGroupPolicyParams): ParsedPolicy {
    validateInteger(this.name, 'policyId', params.policyId, 0, U32_MAX)
    return {
      ...parsePoolGroupRef(this.name, params),
      policyId: params.policyId,
      withChainRecords: !!params.withChainRecords,
    }
  }

  /** Decodes the `Policy` and, with `withChainRecords`, every chain record it lists. */
  protected async read(chain: SolanaChain, ref: ParsedPolicy): Promise<GetPoolGroupPolicyResult> {
    const { address, policy, now } = await readPolicy(this.name, chain, ref, ref.policyId)
    const selectors = policy.chainSelectors.map(toBigInt)
    return {
      address: address.toBase58(),
      policyId: policy.policyId,
      classes: decodeClassBits(policy.classes),
      defaultPolicy: decodeSections(policy.defaultPolicy, now),
      securityGeneration: policy.securityGeneration,
      remoteChainSelectors: selectors,
      ...(ref.withChainRecords && {
        chainRecords: await readChainRecords(
          this.name,
          chain,
          ref.program,
          address,
          policy.policyId,
          selectors,
          now,
        ),
      }),
    }
  }
}

type ParsedRecord = ParsedPoolGroupRef & { policyId: number; selector: bigint }

/** Decodes one policy chain record. */
export class GetPoolGroupPolicyChainRecord extends SolanaQuery<
  GetPoolGroupPolicyChainRecordParams,
  GetPoolGroupPolicyChainRecordResult,
  ParsedRecord
> {
  readonly name = 'getPoolGroupPolicyChainRecord'

  /** @throws {@link CCTParamsInvalidError} if the ref, policy id or selector is invalid */
  protected prepare(params: GetPoolGroupPolicyChainRecordParams): ParsedRecord {
    validateInteger(this.name, 'policyId', params.policyId, 0, U32_MAX)
    return {
      ...parsePoolGroupRef(this.name, params),
      policyId: params.policyId,
      selector: validateSelector(this.name, 'remoteChainSelector', params.remoteChainSelector),
    }
  }

  /** Decodes the record at `[policy_chain, policy, selector]`. */
  protected async read(
    chain: SolanaChain,
    ref: ParsedRecord,
  ): Promise<GetPoolGroupPolicyChainRecordResult> {
    const { address, now } = await readPolicy(this.name, chain, ref, ref.policyId)
    const [record] = await readChainRecords(
      this.name,
      chain,
      ref.program,
      address,
      ref.policyId,
      [ref.selector],
      now,
    )
    return record!
  }
}
