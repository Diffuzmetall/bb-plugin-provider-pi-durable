# Architecture Improvement Plan - Cycle 91: Pi Durable & Coding Agent v1.2.0 Parity

- **Cycle**: 91
- **Branch**: `main`
- **Goal**: Upgrade plugin dependencies to `@earendil-works/pi-durable@^1.2.0`, `@earendil-works/pi-coding-agent@^1.2.0`, and `@earendil-works/pi-codemode@^1.2.0`, resolve breaking compiler and contract changes, replace in-memory codemode with crash-resilient Durable Codemode, implement defensive image error sanitization, and eliminate obsolete adapter boilerplate while preserving full AP compliance.
- **Architecture Context Map**:
  - Stage: prod / plugin harness
  - Source docs: `README.md`, `docs/superpowers/specs/2026-10-14-prd-pi-durable-1.2-upgrade-and-native-codemode.md`, upstream `~/Projects/pi` source code.
  - Active paths: `package.json`, `scripts/build-runner.mjs`, `src/runner/extension-mount.ts`, `src/runner/runtime-controller.ts`, `src/runner/subagent.ts`, `src/runner/tool-adapter.ts`, `src/runner/harness-setup.ts`, `src/runner/bridge/tool-result-extractor.ts`, `tests/*`.
  - Critical gates: AP-010 (Clean Architecture), AP-013 (Zero Placeholders), AP-019 (File size limits <200 runner, <250 host), AP-026 (Contracts & Schemas), AP-028 (Deterministic Testing), AP-029 (TypeScript strictness).
  - Verification surface: `npm test`, `npx tsc --noEmit`, `npm run build`, `npm run doctor`, `bb plugin reload provider-pi-durable`.

---

## Triaged Findings (S5 Triage Gate)

| ID | Component | Severity | Rule | Decision | Description & Root Cause |
|---|---|---|---|---|---|
| **F-91-1** | `src/runner/extension-mount.ts`, `src/runner/runtime-controller.ts` | **P0** | AP-026, AP-029 | `fix-now` | `emitBeforeAgentStart` TS2554 compilation error. In `pi-coding-agent@1.2.0`, argument count changed from 3 to 2 (`trigger: BeforeAgentStartTrigger, systemPromptOptions: BuildSystemPromptOptions`). |
| **F-91-2** | `src/runner/subagent.ts`, `src/runner/tool-adapter.ts` | **P0** | AP-013, AP-026 | `fix-now` | Silent drop of tool output. In `pi-durable@1.2.0`, `ToolExecutionResult.content` is renamed to `output`. Tools returning `content` satisfy the optional shape but Durable ignores `content`, dropping subagent responses to the LLM ([#10815](https://github.com/earendil-works/pi/issues/10815)). |
| **F-91-3** | `src/runner/extension-mount.ts` | **P1** | AP-010, AP-026 | `fix-now` | `TypeError: api.retainedOutput is not a function`. In `pi-durable@1.2.0`, `bash` calls `api.retainedOutput()` for `structuredOutput`. The ad-hoc mock `api` in `createNestedToolExecutor` lacked this method. |
| **F-91-4** | `package.json`, `src/runner/tool-adapter.ts` | **P1** | AP-010, AP-026 | `fix-now` | Non-durable in-memory Codemode. In-memory `createCodemodeExtension` from `pi-coding-agent` loses state on crash. Must migrate to `@earendil-works/pi-durable/codemode` with `CodemodeSandbox` from `@earendil-works/pi-codemode`. |
| **F-91-5** | `src/runner/bridge/tool-result-extractor.ts`, `src/runner/tool-adapter.ts` | **P1** | AP-010, AP-026 | `fix-now` | Anthropic HTTP 400 on error tool results containing images. When codemode or image tools fail after emitting images, Anthropic rejects `is_error: true` tool results that contain non-text blocks ([#10794](https://github.com/earendil-works/pi/issues/10794)). |
| **F-91-6** | `src/runner/harness-setup.ts` | **P2** | AP-010, AP-013 | `fix-now` | Read tool lacks image processing. Models cannot inspect UI screenshots or diagrams. Integrate `@earendil-works/pi-durable/images/node` Photon WASM image processor. |
| **F-91-7** | `tests/codemode-full-coverage.test.ts` | **P2** | AP-028 | `fix-now` | Nonzero bash exit code in codemode now resolves with `{ exitCode: 42 }` rather than throwing an exception. Test assertion expecting `resCaughtBash.text.includes("Command exited with code 42")` fails and must be updated. |

---

## Task Breakdown

### Slice 0: Dependency Manifest & Build External Configuration (F-91-4)
- **Boundary**: Workspace Root (`package.json`, `scripts/build-runner.mjs`)
- **AP Gates**: AP-026 (Single Source of Truth), AP-029 (Zero any)
- [ ] Update `package.json`:
  - Set `"@earendil-works/pi-durable": "^1.2.0"`.
  - Set `"@earendil-works/pi-coding-agent": "^1.2.0"`.
  - Add `"@earendil-works/pi-codemode": "^1.2.0"` to dependencies.
- [ ] Update `scripts/build-runner.mjs`:
  - Add `"@earendil-works/pi-codemode"` and `"@earendil-works/pi-codemode/*"` to the `external` array.
- [ ] Run `npm install` and verify dependency tree lockfile.

### Slice 1: Breaking Compiler & Contract Changes (F-91-1, F-91-2)
- **Boundary**: Runner Core (`src/runner/extension-mount.ts`, `src/runner/runtime-controller.ts`, `src/runner/subagent.ts`, `src/runner/tool-adapter.ts`)
- **AP Gates**: AP-013, AP-019 (<200 lines), AP-026, AP-029
- [ ] Fix `emitBeforeAgentStart` calls:
  - In `src/runner/extension-mount.ts` (L171): pass `({ messageType: "user", prompt: "", images: undefined }, promptOptions)`.
  - In `src/runner/runtime-controller.ts` (L70): pass `({ messageType: "user", prompt: text, images: undefined }, promptOptions)`.
- [ ] Fix `ToolExecutionResult.output`:
  - In `src/runner/subagent.ts`: replace `content: [...]` with `output: [...]`.
  - In `src/runner/tool-adapter.ts`: return `output: result.content`.
  - In `src/runner/bridge/tool-result-extractor.ts`: support `entry.model[0].output ?? entry.model[0].content`.
- [ ] Verify `npx tsc --noEmit` exits with code 0.

### Slice 2: Mock API Retained Output & Anthropic Error Sanitization (F-91-3, F-91-5)
- **Boundary**: Runner Bridge (`src/runner/extension-mount.ts`, `src/runner/bridge/tool-result-extractor.ts`, `src/runner/tool-adapter.ts`)
- **AP Gates**: AP-010, AP-019 (<200 lines), AP-026, AP-029
- [ ] Enhance `createNestedToolExecutor` mock `api`:
  - Implement `retainedOutput: () => ({ text: outputText, truncated: false })`.
  - Add `outputWindow: undefined`.
- [ ] Implement Anthropic defensive image error sanitization ([#10794](https://github.com/earendil-works/pi/issues/10794)):
  - If `isError === true`, map any block of `type === "image"` to `{ type: "text", text: "[image omitted: error tool results cannot contain images]" }`.
- [ ] Verify with `tests/codemode-nested-env.test.ts`.

### Slice 3: Native Durable Codemode & Tool Search Integration (F-91-4, F-91-6)
- **Boundary**: Runner Setup (`src/runner/tool-adapter.ts`, `src/runner/harness-setup.ts`)
- **AP Gates**: AP-010, AP-019 (<200 lines), AP-026, AP-029
- [ ] Migrate `tool-adapter.ts`:
  - Import `createCodemodeExtension` from `@earendil-works/pi-durable/codemode`.
  - Import `CodemodeSandbox` from `@earendil-works/pi-codemode`.
  - Import `createToolSearchExtension` from `@earendil-works/pi-durable/tool-search`.
  - Instantiate `createCodemodeExtension({ sandbox: new CodemodeSandbox() })`.
  - Correct `exposure === "deferred"` mapping to `{ deferred: true, callers: ["model", "tools"] }`.
- [ ] In `src/runner/harness-setup.ts`:
  - Import `createNodePhotonImages` from `@earendil-works/pi-durable/images/node`.
  - Initialize `createCodingTools({ images: await createNodePhotonImages() })` with safe try/catch fallback.

### Slice 4: Test Suite Parity & Semantics Alignment (F-91-7, AP-028)
- **Boundary**: Test Suites (`tests/codemode-full-coverage.test.ts`, `tests/subagent.test.ts`)
- **AP Gates**: AP-028 (Deterministic Testing)
- [ ] Update `tests/codemode-full-coverage.test.ts`:
  - Align `bash` error test with Durable 1.2.0 structured output semantics (resolves with `exitCode: 42`).
- [ ] Add regression test in `tests/subagent.test.ts`:
  - Assert that `subagent` execution returns `output` property and does not silently drop results.
- [ ] Run full test suite: `npm test` and ensure 203+ tests pass with 0 failures.

### Slice 5: Verification, Diagnostics, Cache Sync & Ledger (S9–S12)
- **Boundary**: Quality Assurance, Build & Ledger
- **AP Gates**: AP-019 (<200 lines for 100% of runner files), AP-028, AP-029
- [ ] Verify file sizes: `wc -l $(find src/runner -maxdepth 1 -type f)` strictly < 200 lines.
- [ ] Run `npx tsc --noEmit` (0 errors).
- [ ] Run `npm run build:runner` and `npm run build:host`.
- [ ] Run `npm run doctor` to verify clean environment audit.
- [ ] Sync compiled dist artifacts to BB cache and reload plugin:
  `bb plugin reload provider-pi-durable`.
- [ ] Update `docs/arch-improvement/ledger.md` with Cycle 91 details.
