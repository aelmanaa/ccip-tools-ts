# MTTP implementation notes (reference implementation, for the SDK teams' PRD)

Running record of the MultiTokenPool (MTTP) implementation in `@chainlink/ccip-sdk`'s CCT layer, EVM
and Solana. Design of record: `DESIGN-MTTP-CCT-SDK.md` rev 4 (`~/projects/ccip/programs/cct-sdk/mttp/`).
Base: `ccip-tools-ts@2e7b73a0`. Each PR is a stacked branch `mttp/<id>`; this file lives on its own
branch `mttp/notes` and is not part of any upstream PR.

## Size per PR

| PR | Branch head | Files | Lines + / - | Notes |
| --- | --- | --- | --- | --- |
| C1 | `mttp/c1` 1cb88785 | 7 | +129 / -31 | `resolveEncoderIn`, shared MTTP name test, `EVMOperation` `Tx` generic |
| C2 | `mttp/c2` 9bef1769 | 5 | +111 | `CCTStateChangedError`, error-reference CCT section |
| C3 | `mttp/c3` d25777ec | 6 | +568 / -81 | tag-based compute budget in core simulate/send and v1 |
| C4 | `mttp/c4` c74a8b13 | 5 | +282 / -45 | `serializeUnsignedTx` options, v0 with tables, durable nonce |
| DOC0 | `mttp/doc0` 13ec734c | 8 | +350 / -16 | `lint:docs:cct` gate with a shrink-only baseline |
| E1a | `mttp/e1a` 9d496a30 | 11 | +11,391 / -4 | 9 generated ABIs (11,353 generated lines) + revert decoding |
| E1b | `mttp/e1b` 220cf63e | 10 | +1,723 | shared types and snapshot serialization; EVM taxonomy, resolver, op map |
| E2a | `mttp/e2a` 368bfdd2 | 22 | +2,215 / -2 | detection, pool/PCM/store state, roles, role holders, stack audit; shared stack test stub; live integration test |
| E2b | `mttp/e2b` bcda2bec | 30 | +2,290 / -102 | token configs/profiles, configured tokens, 6 lane batch views, chain pauses; core lane helpers moved |
| E2c | `mttp/e2c` a914b145 | 27 | +2,073 / -13 | 6 policy reads, policy names, subsets, inline configs, hooks, provider; shared record types |

Effort: increment 1 (DOC0, C1-C4) took one review round with three reviewers; it found 3 majors
(one real bug in a core send path), all fixed before acceptance. Increment 2 (E1a-E2c) took one
review round with four reviewers (three lenses plus DRY); the fixes were folded into the PR that
introduced each issue, adding about 1,000 lines net (mostly shared helpers and regression tests).

## Reuse map

### Increment 1 (DOC0, C1-C4)

| Need | Reused / extended (path at 2e7b73a0) | New, and why |
| --- | --- | --- |
| Floor-matched encoder lookup for a non-`TokenPoolVersion` family | `resolveEncoder` (`cct/evm/token-pool/contracts.ts:1731`) — kept as a wrapper | `resolveEncoderIn(order, …)`: the walk was hard-wired to `TokenPoolVersion`; the generic is the same loop |
| MTTP name detection | core `isMultiTokenPoolType` (`evm/index.ts:280`) — moved unchanged to `evm/multi-token-pool.ts` | — |
| Op base with a wider unsigned shape | `EVMOperation` (`cct/evm/operation.ts:90`), `SolanaOperation`'s `Tx` generic pattern | `Tx` generic only (not `Result`): `EVMDeployOperation` already narrows `execute` by override |
| State-moved error | `CCIPError`, `CCIPErrorCode`, `getDefaultRecovery`, the `cct/errors.ts` class pattern | `CCTStateChangedError` + `CCTStateChange`: no existing error means "re-read and rebuild" |
| Compute-budget handling | `simulateTransaction`/`simulateAndSendTxs` (`solana/utils.ts`), `compileV1Message` heap-frame move (`solana/v1.ts`) — extended | `solana/compute-budget.ts`: the existing code matched ComputeBudget by program ID only, which cannot tell a heap frame from a limit |
| External-signing serialization | `serializeUnsignedSolanaTx` (`cct/solana/serialize.ts`) — extended | `SerializeUnsignedTxOptions`, `SolanaDurableNonce` |
| Docs gate | TypeDoc already in `ccip-api-ref` | `scripts/lint-docs-cct.mjs`: no existing gate ran TypeDoc validation in `npm run check` |

### E1a, E1b

| Need | Reused / extended | New, and why |
| --- | --- | --- |
| ABI vendoring | `// generate:` + `scripts/generate.cjs`, the gobindings fetch pattern of `evm/abi/PoolConfigManager_2_1.ts` | 9 ABI files under `artifacts/abi/V2_1_0_DEV/` (core keeps only views; writes need the full ABI) |
| Revert decoding | core `parseWithFragment` (already knows the PCM, stores, pool, hooks errors); `CCT_ERROR_INTERFACES` and its glob test | only the UID provider's error fragments |
| ABI table + cached interfaces | the `TOKEN_POOL_ABIS` / `getTokenPoolInterface` pattern (`cct/evm/token-pool/contracts.ts:486-607`) | `MULTI_TOKEN_POOL_ABIS` / `getMultiTokenPoolInterface`, built lazily (not at import) so non-MTTP users pay nothing |
| Canonical JSON and hashes | `jsonStringify`/`jsonParse` (`shared/codec.ts`, `utils.ts:172`), ethers `id` (as `shared/codec.ts` uses) | `canonicalize` (deep key sort): no key-sorting helper exists in the SDK |
| Version parsing | `parseTypeAndVersion` 4th tuple element (`utils.ts:680`) | `resolveMultiTokenPoolContract`: every existing resolver drops the suffix; joins it |
| Aux contract type check | the shape of `assertAdvancedPoolHooksContract` (`cct/evm/advanced-pool-hooks/contracts.ts:242`) | `assertMultiTokenPoolAuxContract` for hooks/providers (that function is hard-wired to one type) |
| State-change list type | `CCTStateChange` (C2) reused for `MultiTokenPoolSnapshotCheck.changed` | — |

### DRY audit of increment 1 (independent, `reviews/dry-audit-increment-1.md`) — fixed in the introducing PR

| Id | Duplicate | Fix |
| --- | --- | --- |
| D1 | 143 of 145 MTTP error fragments added to `CCT_ERROR_INTERFACES` were already decoded by core `parseWithFragment` (`evm/abi/PoolConfigManager_2_1.ts`, `pool-errors.ts`) | E1a keeps only the UID provider's 2 errors; a test asserts every fallback entry adds errors core lacks |
| D2 | limit replace-or-prepend written twice (simulate, send) | `withComputeUnitLimit` in `solana/compute-budget.ts`, used by both (C3) |
| D3 | heap-frame read in `v1.ts` next to the tag helpers | `readHeapFrameBytes` (C3) |
| D4 | nonce shape check reimplemented base58 decoding | reuses `parsePublicKey` (`cct/solana/validate.ts:38`) (C4) |
| D5 | gate's TypeDoc options copied from the site config, already drifted (`--excludeProtected`) | `ccip-api-ref/typedoc.shared.mjs`, imported by both; the gate now matches the site; the one protected method that surfaced (`SolanaOperation.prepareWalletExecution`, 152 entries) got a documented return type (DOC0) |
| D6 | test wallet/connection stubs copied from `v1.test.ts`; 3 `noFetch` stubs | `solana/send.test.helpers.ts`; one `noFetch` (C3, C4) |
| — | `resolveTokenEncoder` (`cct/evm/token/contracts.ts:96`) was a third copy of the encoder walk | delegates to `resolveEncoderIn` (C1) |
| — | the two `simulateTransaction` branches carried the same edits | one inner `simulateInstructions` (C3; the legacy branch still skips the `allowV1` check, as before) |
| — | E1b exact type guard | calls core `isMultiTokenPoolType` first |
| — | `same-address-remote-token-address-provider.ts` unused | used by the internal `MULTI_TOKEN_POOL_ABIS` table (E1b) |

### Increment 2 (E2a-E2c reads)

| Need | Reused / extended (path at 2e7b73a0) | New, and why |
| --- | --- | --- |
| Log scanning with range shrinking | `EVMChain.getLogs` / `getEvmLogs` (`evm/logs.ts`) | — |
| Registry pool of a token, Router's TAR | `chain.getRegistryTokenConfig`, `chain.getTokenAdminRegistryFor` | — |
| Authorized callers of a store or hook | `readAllAuthorizedCallers` (`cct/evm/advanced-pool-hooks/contracts.ts:123`) — the shared `AuthorizedCallers` selector | — |
| Bucket decode | `toTokenBucket` (`cct/evm/token-pool/contracts.ts:1339`), exported `@internal` | — |
| Finality encode/decode | `encodeFinality`, `decodeFinalityAllowed` (`extra-args.ts`), `toBeHex(…, 4)` as core | — |
| Lane record types, lane status, lock flavor | core private helpers in `evm/index.ts:274-330`, moved unchanged to `evm/multi-token-pool.ts` | — |
| Policy names | ethers `encodeBytes32String`/`decodeBytes32String` | `encodePolicyName`/`decodePolicyName`: the raw-`bytes32` round trip and the zero = "no policy" rule |
| Remote addresses on read | `decodeAddress` + `supportedChains` (as `parseRemoteAddress`) | `decodeRemoteAddress` next to `parseRemoteAddress`: reads must not fail on an unregistered family |
| ABI → `RateLimitConfig` | `RateLimitConfig` (`cct/evm/token-pool/rate-limit.ts`) | `fromAbiRateLimitConfig`: no reader existed (writes only had `parseRateLimitConfig`) |
| Pending owner | — | `readPendingOwner`: the SDK never read `s_pendingOwner` |
| Deployment block | — | `findDeploymentBlock` (binary search on `eth_getCode`): no helper existed |
| ERC-165 probe | the pattern of `evm/index.ts:1525` (`supportsInterface` + `CALL_EXCEPTION`/`BAD_DATA`) | `I_MULTI_TOKEN_POOL_INTERFACE_ID` |
| Repeated op shapes | `EVMQuery` | `LaneBatchQuery` (6 ops) and `PolicyQuery` (7 ops) bases |
| Test stub | each existing test hand-rolls its stub | `stack.test.helpers.ts`, one in-memory stack for every MTTP op test |

### Increment 2 review fixes (folded into E1b-E2c)

| Need | Reused / extended (path at 2e7b73a0) | New, and why |
| --- | --- | --- |
| Fee quote decode | the inline decode of `readTokenPoolFee` (`cct/evm/token-pool/contracts.ts:707`) | extracted as `toTokenPoolFee` (`@internal`); both the pool read and `getFeeBatch` use it |
| `TokenTransferFeeConfig` decode | the inline decode of the v2 pool fee-config read (`cct/evm/token-pool/contracts.ts:~795`) | extracted as `toTokenTransferFeeConfig` (`@internal`); the lane batch reuses it |
| Address list params | `validateArray` + `validateAddress` | `validateAddressArray` in `cct/evm/validate.ts` (4 MTTP call sites) |
| Requested finality param | `encodeFinality` (`extra-args.ts:313`) for the encoding | `validateFinalityRequested`: core's encoder throws `CCIPExtraArgsParseError` mid-read, so prepare validates first |
| "reverted with custom error X" | the inline pattern of core `evm/index.ts:3774` (`getErrorData` + `parseError`) | `isRevertWith(err, iface, name)` in `cct/evm/query.ts`; the fee read (`InvalidRequestedFinality`) and the UID provider (`TokenNotFromFactory`) use it, so other reverts and transport errors propagate |
| Paged views at one block | — | `readPagesAtBlock` (configured tokens, subsets): a swap-removed set read across blocks can skip or repeat items |
| Batched reads | — | `readInBatches` (role sweep, lane batches, token configs/profiles chunked by 100) |
| Log scans | `EVMChain.getLogs` | `scanLogs` + `validateLogScanParams`, shared by role holders and chain pauses |
| Owner + pending owner | — | `readOwnership` (one block for `owner()` and both slots); pool, stores and hooks use it |
| Token profile fields | — | `decodeTokenProfile` + `MultiTokenPoolTokenProfileFields`, shared by token configs and token profiles |
| Enum decode | — | `decodeEnum`: an out-of-range value throws `CCTDataDecodeError` instead of reading as `none` |
| Policy `exists` (A9) | `getPolicyNames` view | in the `PolicyQuery` base, read at the same block as the policy |
| Lock flavor | `LOCK_OR_BURN_FLAVORS` moved to core `evm/multi-token-pool.ts` | core's `MULTI_TOKEN_POOL_LOCK_FLAVOR` is now `LOCK_OR_BURN_FLAVORS.indexOf('lock')`, not a second literal |

### Existing duplication noticed, not fixed (refactor opportunities)

- **`TokenTransferFeeConfig` decoding has 3 copies in core** (the chain-level pool reads in
  `evm/index.ts`) plus the CCT one now exported as `toTokenTransferFeeConfig`. One shared decoder in
  core would serve all four; core cannot import CCT, so it would have to live in core.
- **Transport errors vs "not a CCIP contract".** Main's `assertAdvancedPoolHooksContract`
  (`cct/evm/advanced-pool-hooks/contracts.ts:240`) wraps *any* `typeAndVersion` failure, including a
  timeout or 429, as `CCTContractTypeInvalidError(actual: 'unknown')`, and main has a test pinning that.
  The MTTP resolvers use the narrower `readContractType` (only no-code / no-`typeAndVersion` becomes
  type-invalid; transport errors propagate). Left unchanged on main (out of scope); aligning it is a
  one-line change plus its test.
- **Custom-error matching** is written inline in core (`evm/index.ts:3774`); `isRevertWith` could serve it.

- `CCT_ERROR_INTERFACES` already had pre-existing overlap with core (e.g. `InsufficientBalance`); a
  core/CCT merged error index would remove it.
- The 1.4M `setComputeUnitLimit` used only as a size probe in
  `cct/solana/token-pool/operations/apply-chain-updates.ts:134`.
- ~10 `cct/solana` op tests each define their own signing wallet stub; `solana/send.test.helpers.ts`
  could serve them.

- `solana/exec-v2.ts:85`, `solana/send-v2.ts:98` and `solana/resolution.ts:235` each build the same heap-frame request.
- The "address reports no `typeAndVersion`" probe is written out per contract family (lockbox
  probes, `assertAdvancedPoolHooksContract`); MTTP adds `readContractType` in `cct/evm/query.ts`,
  which the others could adopt (see the transport-error note above).

## Design deviations and why

1. **C1 — no `Result` generic on `EVMOperation`.** The design asked for `Tx` and `Result`. A `Result`
   default would need an unsound `{ hash } as Result` in the base `execute`; `SolanaOperation` has
   only `Tx`, and `EVMDeployOperation` already narrows the return by override. (Design amended.)
2. **C3 — v1 `priorityFee` is a total.** web3.js's v1 `transactionConfig.priorityFee` is the total in
   lamports, not a per-CU price; the embedded `SetComputeUnitPrice` (micro-lamports per CU) is
   converted with `ceil(price × limit / 1e6)` and refused above `Number.MAX_SAFE_INTEGER`.
3. **DOC0 — baseline.** `origin/main` already had 168 undocumented public CCT symbols, so a strict
   gate would fail on main; the gate uses a shrink-only baseline (166 entries are main's debt).
4. **C4 — stricter than declared.** The serializer also refuses a stray nonce, a malformed nonce, a
   transaction that advances a nonce without `durableNonce`, and a wrong first nonce account.
   (Interface amended.)
5. **E1b — snapshot encoding.** The design says "bigint as a decimal string" and also "as
   `jsonStringify` with sorted keys"; these conflict, because the SDK's `jsonStringify` writes bigints
   as bare integers (by design, PR #280). The implementation follows the SDK convention so
   `parseMultiTokenPoolSnapshot` (via `jsonParse`) restores bigints losslessly.
6. **E1b — op map shape.** Some ops target one of several contracts (`deployMultiTokenPoolProvider`,
   the store ops), which a runtime value cannot express as a union; every entry is
   `{ contracts: readonly […], function }`.

7. **E2c — `getMultiTokenPoolObservedState` moved to E10** (with the reconcilers it feeds; its
   interface type is still loose). **E2b — `getMultiTokenPoolLane` moved to E3c** (with the lane check).
8. **Lane batch results carry their key** (`(MultiTokenPoolLaneKey & X)[]`), so a result can be
   matched to its lane without index bookkeeping.
9. **Remote addresses read as hex only when the family cannot be decoded here** (an unknown selector,
   or a family not registered in the bundle). Bytes a registered family rejects throw
   `CCTDataDecodeError` (A10, consistent with core `getTokenPoolRemotes`). The selector must match
   `networkInfo(...).chainSelector`: `networkInfo` also resolves chain IDs.
11. **Policy names are 1-31 printable bytes as text (A9).** A 32-byte word has no NUL terminator, so
    text that long cannot round-trip; such names are addressed as raw `bytes32` hex.
12. **`InlineRemotePool.allowLegacyPoolData` (A8)**: the contract's `allowLegacyPoolDataOnReceive` is
    re-keyed at the ABI boundary, matching the Solana pool group's field and the lane-connection read.
13. **Policy reads return `policyName` and `exists` (A9)**, read at one block with the policy itself;
    `PolicyQuery` is generic over the records part so no result cast is needed.
10. **Interface TSDoc typo**: the six per-policy reads' docs in `interfaces/evm.ts` are garbled
    ("Reads a c policy and its records.onnection"); the implementation has correct text.

## Pitfalls an implementer will hit

- **v1 instruction indices.** A v1 message moves heap-frame, limit and price instructions into its
  `transactionConfig`, so the runtime's `InstructionError` index counts only the instructions left.
  Mapping it back by a scalar offset is wrong; map through the kept positions.
- **`util.inspect` truncates arrays over 100 items.** The existing `// generate:` pattern
  (`inspect(obj, {depth: 99})`) silently cut the 240-item PCM ABI to 100 entries plus
  `... 8 more items`, which is not valid TypeScript. Pass `maxArrayLength: Infinity`.
- **A compute-unit limit the builder embeds** must never be doubled (`DuplicateInstruction`) and
  must not be overwritten by a caller's `computeUnits: 0`.
- **`parseTypeAndVersion` keeps the suffix's hyphen**: join as `version + suffix`, never with `-`.
- **TypeDoc flags every property of an inferred literal type** (e.g. a `const` map): give exported
  maps an explicit, documented value type.
- **Inferred `as const` literal maps** surface per-property in TypeDoc; and an exported map typed by a
  `const` declared after it throws at import (TDZ): declare the literal first.
- **A strict "fallback errors not in core" test fails on pre-existing overlap**: assert per-entry
  coverage instead, and strictness only for new entries.
- **`s_pendingOwner` is slot 0, `s_owner` slot 1** in Chainlink's `Ownable2Step` (declaration order),
  not the reverse; verified live on the Sepolia v5v9 pool (slot 1 == `owner()`). Read the pending owner
  from slot 0 only after checking slot 1 equals `owner()`.
- **abitype types multi-output and struct results as tuples, but `resultToObject` returns an object
  with named keys at runtime** (and a plain array `.map` then fails). Destructure the raw `Result`
  positionally, or map each element through `resultToObject`; never `resultToObject(x).map`.
- **Live reads catch what stubs cannot**: the struct-decoding bug above passed a hand-built stub but
  failed against the Sepolia stack on the first run.
- **The PCM's `RoleGranted`/`RoleRevoked` scan needs a start block.** Without an archive RPC the
  deployment block cannot be found from historical code; public Sepolia endpoints vary per call, so
  pin the block in tests.
- **`networkInfo(1n)` resolves** (Ethereum); use an obviously unknown selector to test the
  unknown-chain path.
- **Machine load makes `utils.test.ts` `sleep` timing flaky** (pre-existing, unrelated).
- **A contract call that reverts on one bad input fails the whole batch.** `getFeeBatch` reverts with
  `InvalidRequestedFinality` when any lane's token disallows the finality. Match that exact error
  (decode the revert data), then re-read per lane; a bare `CALL_EXCEPTION` match would also swallow
  "token not registered" and similar reverts.
- **`resultToObject` on a whole multi-output `Result` returns a named object**, so destructuring it
  positionally fails at runtime while it type-checks. Destructure the raw `Result`, then clean each
  element.
- **A refactor to share a helper can silently change main's behaviour.** Rewiring main's hooks assert
  onto the MTTP `readContractType` changed which errors propagate, and main's own test caught it.
  Run main's full test suite on every branch, not only the new tests.
- **`networkInfo` accepts chain IDs too**: a lane selector that happens to equal a chain ID resolves
  to the wrong family unless `info.chainSelector === selector` is checked.
