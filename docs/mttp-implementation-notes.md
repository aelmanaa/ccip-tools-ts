# MTTP implementation notes (reference implementation, for the SDK teams' PRD)

Running record of the MultiTokenPool (MTTP) implementation in `@chainlink/ccip-sdk`'s CCT layer, EVM
and Solana. Design of record: `DESIGN-MTTP-CCT-SDK.md` rev 4 (`~/projects/ccip/programs/cct-sdk/mttp/`).
Base: `ccip-tools-ts@2e7b73a0`. Each PR is a stacked branch `mttp/<id>`; this file lives on its own
branch `mttp/notes` and is not part of any upstream PR.

## Size per PR

| PR | Branch head | Files | Lines + / - | Notes |
| --- | --- | --- | --- | --- |
| C1 | `mttp/c1` 1b4b4466 | 6 | +127 / -23 | `resolveEncoderIn`, shared MTTP name test, `EVMOperation` `Tx` generic |
| C2 | `mttp/c2` 802e903e | 5 | +111 | `CCTStateChangedError`, error-reference CCT section |
| C3 | `mttp/c3` a139de77 | 4 | +510 / -32 | tag-based compute budget in core simulate/send and v1 |
| C4 | `mttp/c4` 46634e6b | 5 | +284 / -45 | `serializeUnsignedTx` options, v0 with tables, durable nonce |
| DOC0 | `mttp/doc0` 050733e7 | 4 | +297 / -2 | `lint:docs:cct` gate with a shrink-only baseline |
| E1a | `mttp/e1a` ae4964bb | 11 | +11,394 / -1 | 9 generated ABIs (11,353 generated lines) + revert decoding |
| E1b | `mttp/e1b` 9c16b6ec | 8 | +1,491 / -12 | shared types and snapshot serialization; EVM taxonomy, resolver, op map |

Effort: increment 1 (DOC0, C1-C4) took one review round with three reviewers; it found 3 majors
(one real bug in a core send path), all fixed before acceptance.

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
| Revert decoding | `CCT_ERROR_INTERFACES` in `cct/evm/simulate.ts` and its glob test over every vendored ABI | error-only `Interface`s for the stack |
| Canonical JSON and hashes | `jsonStringify`/`jsonParse` (`shared/codec.ts`, `utils.ts:172`), ethers `id` (as `shared/codec.ts` uses) | `canonicalize` (deep key sort): no key-sorting helper exists in the SDK |
| Version parsing | `parseTypeAndVersion` 4th tuple element (`utils.ts:680`) | `resolveMultiTokenPoolContract`: every existing resolver drops the suffix; joins it |
| Aux contract type check | the shape of `assertAdvancedPoolHooksContract` (`cct/evm/advanced-pool-hooks/contracts.ts:242`) | `assertMultiTokenPoolAuxContract` for hooks/providers (that function is hard-wired to one type) |
| State-change list type | `CCTStateChange` (C2) reused for `MultiTokenPoolSnapshotCheck.changed` | — |

### Existing duplication noticed, not fixed (refactor opportunities)

- `solana/exec-v2.ts:85` and `solana/send-v2.ts:98` each define an identical `requestHeapFrameIx()`.
- The "address reports no `typeAndVersion`" probe is written out per contract family
  (`assertAdvancedPoolHooksContract`, lockbox probes, and now the MTTP resolver); one shared
  `readContractType(chain, address, expected)` would serve all.
- `MULTI_TOKEN_POOL_LOCK_FLAVOR = 4` in core `evm/index.ts:274` duplicates the flavor enum order the
  CCT layer now exports as `LOCK_OR_BURN_FLAVORS`; core cannot import CCT, so the enum would have to
  move to core.

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
- **Machine load makes `utils.test.ts` `sleep` timing flaky** (pre-existing, unrelated).
