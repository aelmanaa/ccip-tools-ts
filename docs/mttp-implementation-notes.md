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
| E3a | `mttp/e3a` 63a72771 | 42 | +2,729 / -407 | pure projection of the three stores, record state at one block, increment-2 DRY fixes |
| E3b | `mttp/e3b` 2d2bb25c | 18 | +3,070 / -5 | calldata decoder, post-state rules, facts reader, guard run with `eth_simulateV1` cross-check, snapshot check |
| A17 | `mttp/a17` 484b1b53 | 14 | +139 / -92 | renames (`TransferDirection`, `MultiTokenPoolFinding<C>`, lane stops) |
| X0 | `mttp/x0` 08a784cc | 8 | +295 / -79 | family-neutral shared types for the Solana track (`cct/rate-limit.ts`, planner inputs) |
| E3c | `mttp/e3c` a927c496 | 32 | +1,929 / -467 | lane view, lane check, transfer quote; MTTP branch in `getFee`/`getTokenTransferFeeConfig`/`isSupportedToken`; review fixes |
| E4 | `mttp/e4` 48d736c7 | 42 | +3,770 / -547 | write base, merged policy assignment op, profile op, provider-judged pool data, Solana remote facts, `setAllowedFinalityConfig` redirect, D22-D37, review fixes (Solana track's cherry-picks excluded) |

Effort: increment 1 (DOC0, C1-C4) took one review round with three reviewers; it found 3 majors
(one real bug in a core send path), all fixed before acceptance. Increment 2 (E1a-E2c) took one
review round with four reviewers (three lenses plus DRY); the fixes were folded into the PR that
introduced each issue, adding about 1,000 lines net (mostly shared helpers and regression tests).
Increment 3 (E3a-E3c, A17, X0) took one review round with three reviewers plus an independent DRY
audit (16 findings, one major); from E3 on, fixes land as new commits on top, not folded. Increment 4
(E4) took one round with three reviewers: 1 blocker (attested long lanes refused, hidden by a
hand-built test shape), 22 majors, all fixed or decided (A18-A20), with live, fork and unit proofs.

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

- **`TokenTransferFeeConfig`: the v2 pool-ABI decode exists twice at 2e7b73a0** (core
  `evm/index.ts:2679-2687` and CCT `token-pool/contracts.ts:807-815`, now `toTokenTransferFeeConfig`),
  plus Solana's `ChainConfigV2` decode (`solana/index.ts:2271`). What core has **three times** is the
  fee-tier bps selection (`chain.ts:1803`, `evm/index.ts:2041`, `solana/index.ts:1566`). The PCM
  store's 4-field `FeeConfig` (`decodeFeeConfig`) is a different struct and cannot reuse
  `toTokenTransferFeeConfig`.
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

### E3a (projection) and the increment-2 DRY audit fixes

| Need | Reused / extended | New, and why |
| --- | --- | --- |
| PCM view structs (`LaneConnection`, `getStaticConfig`, `TokenConfig` profile) | core's private decoders in `evm/index.ts` (`getMultiTokenPoolRemotes`, `getMultiTokenPoolConfig`, `getTokenAdminRegistryFor`) moved to core `evm/multi-token-pool.ts` | `decodeLaneConnection`, `decodeRemotePools`, `decodePoolConfigManagerStaticConfig`, `decodeTokenProfileFields`, `isZeroHex`, `nullableAddress`: one decoder per struct, the address decoder passed in; core still throws on a missing remote token and keeps its family decode, CCT keeps `null` and hex fallback. Main's 125 MTTP unit + 9 live tests unchanged and green (D7) |
| Stored-record reads | the six policy ops' and the inline op's decode bodies | moved, unchanged, into `pool-config-manager/record-reads.ts` (`POLICY_RECORD_READERS`, `INLINE_RECORD_READERS`, `readSubsetTokens`); the ops and the state loader share them |
| Lane resolution | — | `projection.ts`: pure; mirrors the three stores at c950d9bc; property-tested against a separately written reference resolver (300 seeds) and live-agreed with the PCM views on Sepolia (16 lanes, field by field, one block) |
| Record state at one block | E2 readers + `readPagesAtBlock`, `readInBatches`, `readLaneBatches` | `record-state.ts`; provider answers read as `_tryGetPolicyRemoteToken` does |
| Selector → family | `parseRemoteAddress`'s guard | `laneFamilyOf`, shared by parse and decode; main's messages unchanged (D10) |
| Exactly-one target | `validateAdvancedPoolHooksTarget` | `validateExactlyOneTarget`; both validators are one-liners; main's 200 hooks tests unchanged (D12) |
| owner / ERC-165 probe | vendored `BurnMintMultiTokenPool` ABI | `multiTokenPoolProbe`; the two hand-written fragments are gone (D14) |
| Pending default admin | `getTokenDefaultAdmin`'s convention (omitted when none, `newAdmin` test) | PCM state now matches it (D9) |
| Remote pool shape, batch size, finality word, "one of", finding sort | `MultiTokenPoolRemotePool`, `LANE_BATCH_SIZE` | `InlineRemotePool` is an alias; `ANY_FINALITY_CONFIG`, `validateOneOf`, `sortFindings` (D15-D18) |
| Stub ABIs | — | kept as an independent oracle; a test pins all 48 fragments to the vendored ABIs and the role ids to the SDK's (D20) |

Deferred to the rename batch (each would add a public name): D18's shared finding *type*, D19's
shared direction type. D8 needs no MTTP change: its three inline finality checks are main's
token-pool ops, and the only MTTP site already uses `validateFinalityRequested`.

### E3b-E3c and the increment-3 DRY audit (D22-D37, `reviews/dry-audit-increment-3.md`)

| Need | Reused / extended | New, and why |
| --- | --- | --- |
| Calldata → record changes | ethers `parseTransaction` on the vendored PCM ABI; `INLINE_RECORD_DECODERS` / `POLICY_RECORD_DECODERS` (one decoder per struct for reads and calldata) | `calldata.ts`; an unknown function throws, never judged a no-op |
| Simulate the write | `simulateEVMTx`, extended with `blockTag` | `eth_simulateV1` cross-check (write + lane views, one block); its view decode uses the lane readers' decoders (`decodeLaneRecordLevels`, `decodeLaneVerification`, `decodeRateLimits`, D23) |
| Serving pools | — | one `readPoolsServingPoolConfigManager` for the stack audit and the guard, one error policy (D22/D31); it now also returns each token's TAR entry read directly (`readTokenAdminRegistryConfig`, every admin state visible) |
| Hook callers, chain pauses, record chains, static config | `readAllAuthorizedCallers` (+`blockTag`), the chain-pauses op, `readPoolConfigManagerStaticConfig` (+`blockTag`) | `readChainPauseFlags`, `multiTokenPoolRecordChains`; the record state returns its pinned static config (D27-D29, D35) |
| Decimal rescale, profile decode, guard options | core `scaleDecimals`, `decodeTokenProfile`, `validate.ts` | `validateMultiTokenPoolGuardOptions` for write params, the lane check and sealed snapshot options; `snapshotChanges` shared by the assertion and the check op (D32-D34) |
| "not a contract" predicates | `isMissingFunction`, `isNotCcipContract` (`cct/evm/query.ts`) | used for remote pools, providers and validators (D30; a missed unparseable-`typeAndVersion` case now has a test) |
| Transfer quote | the pool's own `getFee` (it picks the tier), core `bpsFeeDeducted` | `getMultiTokenPoolTransferQuote` adds the bps token fee the Router quote leaves out |

### E4

| Need | Reused / extended | New, and why |
| --- | --- | --- |
| Every PCM write | `EVMOperation`, `submit`, `resolveWalletSender` | `PoolConfigManagerWriteOperation`: `hasRole` pre-flight per gate role, the guard on the exact calldata, `MultiTokenPoolUnsignedTx`, rebuild with the first snapshot right before submit; `makesLive` and `errorContext` hooks |
| Six assignment ops | the op map | one op, `functions: Record<LaneRecordType, …>` (A15, 61 → 56 ops); `TOKEN_POLICY_ROLES` pinned to `_checkTokenRoles` by a test over `LANE_RECORD_TYPES`; the calldata decoder derives its table from the op map |
| Profile writes | `validateAllowedFinality` (exported, param name added), `LOCK_OR_BURN_FLAVORS`, core `getTokenInfo` | the profile op's guards (decimals, live change, served flavor by pool type, burn target, removal, provider code, UID history refusal A18) |
| Pool data on both sides | the providers' own `isAdditionalPoolDataValid` / `getAdditionalPoolData`, as `ConnectionPolicyStore._checkPoolData` runs them | facts: post-write provider overrides, the remote MTTP's verdict and lane format, local acceptance of inbound and legacy-empty data; profile writes re-judge the token's open lanes |
| No-sender simulation | `simulateEVMTx` | the store calls the PCM forwards (`Address.functionCall(store, msg.data)`), from the PCM; `simulatedFrom` (A20) |
| Solana remote | the S1a reader (`readSolanaRemoteLaneFacts`, `readSolanaRemotePoolFacts`), lazy-imported | the EVM mapping: byte-exact lane back, `failsClosed`, UID, admission, `sourcePoolAddressLength`, `remoteSendsData` |
| Single-token op on an MTTP | `isMultiTokenPoolRefusal` | `redirectMultiTokenPool(err, op, how)`: same error class, reason names the MTTP op (§4.5); later redirects reuse it |

### Main-behaviour changes (all additive)

- C3/C4: `serializeUnsignedSolanaTx` serializes v0 messages with lookup tables, where main refused
  them (`serialize.test.ts` "rejects lookup tables for legacy message serialization" becomes the v0
  test). A refusal turned into a feature; no other test of main's changed except `v1.test.ts`
  dropping its local wallet stub for the shared one.
- E3b: `simulateEVMTx` takes an optional `blockTag`.
- E4: `setAllowedFinalityConfig` on a multi-token pool keeps `CCTContractTypeInvalidError` but its
  `reason` names `applyMultiTokenPoolTokenProfileUpdates` (main's 21 tests unchanged, one added).
- E4: optional `blockTag` on `readAllAuthorizedCallers`, `readPoolConfigManagerStaticConfig` and
  `readTokenAdminRegistryConfig`; `validateAllowedFinality` and `validateLaneKeys` gain an optional
  trailing parameter (param name, `minLength`). Every main caller is unchanged.

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
14. **E4 — one assignment op (A15).** The six `applyMultiTokenPoolToken<Type>PolicyUpdates` facades are
    one op with `recordType`; errors carry `context.recordType`. `MultiTokenPoolOperationTarget` became
    a `function | functions` union (unreleased).
15. **E4 — UID history is refused, not warned (A18).** Until the migration records exist (E12), a
    factory UID provider is refused when the TAR shows a pending admin or a pool not serving this PCM,
    as an error finding `UID_MIGRATION_UNCHECKED` whose `remoteChainSelector` is `0n` (token-level).
    A first version warned; the design always said refuse.
16. **E4 — no-sender writes are simulated from the PCM (A20)**: every store-level revert is caught,
    the PCM role gate is not; `simulatedFrom: 'sender' | 'pcm' | 'none'` tells a reviewer which.
17. **E4 — types renamed with the `MultiTokenPool` prefix (A19)** (`MultiTokenPoolTokenProfile`,
    `…ProfileUpdate`, `…PolicyAssignment`); `MultiTokenPoolLaneDirections`, `MultiTokenPoolGuardOptions`
    and `MultiTokenPoolSimulatedFrom` are public.
18. **E4 — `goingLive` / `confirmOpening` per direction**: confirming outbound never confirms inbound;
    a lane opened fully paused needs no confirmation.
19. **E4 — a `getChain` rejection is an `'unknown'` fact**, its error kept as `cause` and on the
    refusal (`err.cause`), so a caller tells a missing RPC from a transient failure.
20. **E4 — no router table and no router-verified flag**: the Solana reader resolves the Router from
    chain state, as core CCT does; an earlier per-cluster table was dropped on the user's direction.
21. **E4 — an unread Solana `sourcePoolAddressLength` is an `'unknown'` fact**, never an assumed 20.
22. **E4 — the Solana track's commits are cherry-picked onto `mttp/e4`** (S0, S1a and its fixes); the
    history tidy before upstream merges the two tracks.
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
- **EVM → Solana lanes store the token and the pool in different byte forms.** The v2 OnRamp sends
  both as `abi.encode(address)` (32 bytes); the Solana OffRamp passes the token on as sent but trims
  the pool to the source chain's `legacy_address_length` (20 for EVM, `token_transfer.rs:301`). So the
  lane back stores the token as 32 bytes and the pool as 20; both compare equal once checksummed, and
  either wrong form reverts every transfer. A first rule expected 32 for both and flagged a healthy lane.
- **A test fixture in a shape the reader never builds hides real bugs.** The attestation test
  hand-built `mapsBack: true`; the reader returns `false` for every attestation, so making a rule
  format-agnostic refused every attested long lane with all tests green. Feed rules the reader's output.
- **A profile write changes no stored lane record, yet changes every lane of the token** (what it
  sends and accepts). A projection that only diffs records sees no affected lane, so a flag like
  `allowLiveProfileChange` silently skips every lane rule. Re-judge the token's open lanes.
- **A provider or validator at an EOA is `BAD_DATA`, not a revert**: catch `isMissingFunction`, not
  only `CALL_EXCEPTION`, or the guard throws a raw ethers error.
- **Without a sender the write was never simulated**, while the docs said the op `eth_call`s it. The
  stores accept the PCM as caller, so simulate the forwarded store calls from the PCM.
- **Core `getRegistryTokenConfig` throws when `administrator` is zero**, hiding a proposed but not
  accepted admin; read the TAR's `getTokenConfig` directly for admin state.
- **Making a family readable changes `getChain` behaviour**: a getter without an RPC for it used to be
  skipped and now rejects; turn the rejection into an `'unknown'` fact.
- **A scratch import helper placed imports after a mid-file re-export** (`export type { … } from`);
  check import placement after scripted edits. macOS `sed` has no `\b`: a `sed` rename silently did
  nothing; use a regex in a script.
- **Docs lint flags inferred return types of `protected` methods** on exported classes (an inline
  object type's properties): annotate the return type.
- **Under full-suite load, TON unit tests time out** (pass alone, 117/117), like the `sleep` test.
