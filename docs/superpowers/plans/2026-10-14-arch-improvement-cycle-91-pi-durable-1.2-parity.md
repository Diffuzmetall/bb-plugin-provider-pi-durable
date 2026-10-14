# Architecture Improvement Plan - Cycle 91: Pi Durable & Coding Agent v1.2.0 Parity

- **Cycle**: 91
- **Branch**: `main`
- **Goal**: Upgrade plugin dependencies to `@earendil-works/pi-durable@^1.2.0`, `@earendil-works/pi-coding-agent@^1.2.0`, and `@earendil-works/pi-codemode@^1.2.0`, resolve breaking compiler and contract changes, replace in-memory codemode with crash-resilient Durable Codemode, implement defensive image error sanitization, and eliminate obsolete adapter boilerplate while preserving full AP compliance.
- **Architecture Context Map**:
  - Stage: prod / plugin harness
  - Source docs: `README.md`, `docs/superpowers/specs/2026-10-14-prd-pi-durable-1.2-upgrade-and-native-codemode.md`, upstream `~/Projects/pi` source code.
  - Active paths: `package.json`, `scripts/build-runner.mjs`, `src/runner/extension-mount.ts`, `src/runner/runtime-controller.ts`, `src/runner/subagent.ts`, `src/runner/tool-adapter.ts`, `src/runner/harness-setup.ts`, `src/runner/runtime-loader.ts`, `src/runner/bridge/tool-result-extractor.ts`, `src/runner/bridge/bb-event-adapter.ts`, `tests/*`.
  - Critical gates: AP-010 (Clean Architecture), AP-013 (Zero Placeholders), AP-019 (File size limits <200 runner, <250 host), AP-026 (Contracts & Schemas), AP-028 (Deterministic Testing), AP-029 (TypeScript strictness).
  - Verification surface: `npm test`, `npx tsc --noEmit`, `npm run build`, `npm run doctor`, `bb plugin reload provider-pi-durable`.

---

## 1. FSM State: S0–S3 Bootstrap, Memory, Orientation & Alignment

* **S0 (Bootstrap):** Root: `/Users/vanya/Projects/bb-plugin-provider-pi-durable`, Branch: `main`, Clean worktree verified.
* **S1 (Memory Load):** Loaded active lessons from `MEMORY.md`:
  - Тонкий адаптер (GoF Adapter) между BB IDE и `@earendil-works/pi-durable`.
  - Запрет догадок (проверка гипотез строго по первоисточникам `~/Projects/pi` и `~/Projects/bb-reference`).
  - Все новые проекты, библиотеки и зависимости — строго в `package.json` и `scripts/build-runner.mjs`.
  - Строгие лимиты строк (AP-019: < 200 строк для файлов в `src/runner/`).
* **S2 (Orientation):** Обновлены исходники в `~/Projects/pi`, пересобраны все 10 пакетов монорепозитория. Провалидирована совместимость на реальном коде.
* **S3 (Brainstorm / Alignment):** Сформирован и одобрен PRD `docs/superpowers/specs/2026-10-14-prd-pi-durable-1.2-upgrade-and-native-codemode.md`.

---

## 2. FSM State: S4–S5 Review & Triage Gate

### Triaged Findings (Finding Format)

| ID | Finding & Rule | Severity | Decision | Evidence & Impact | Resolution Action |
|---|---|---|---|---|---|
| **F-91-1** | **`emitBeforeAgentStart` TS2554**<br>Rule: AP-026, AP-029 | **P0** | `fix-now` | **Evidence:** `npx tsc --noEmit` fails on `extension-mount.ts:171` and `runtime-controller.ts:70` with `Expected 2 arguments, but got 3`.<br>**Impact:** Код не компилируется на зависимостях 1.2.0. | Переписать вызовы на 2 аргумента с объектом `{ messageType: "user", prompt: text, images: undefined }`. |
| **F-91-2** | **Silent Subagent Output Drop**<br>Rule: AP-013, AP-026 | **P0** | `fix-now` | **Evidence:** В 1.2.0 `ToolExecutionResult.content` переименован в `output`. `subagent.ts` возвращает `{ content }`, которое игнорируется ядром Durable ([#10815](https://github.com/earendil-works/pi/issues/10815)).<br>**Impact:** Сабагент молча отдает пустой ответ родительской модели. | Заменить свойство `content` на `output` в `subagent.ts` и `tool-adapter.ts`. В `tool-result-extractor.ts` поддерживать `output ?? content`. |
| **F-91-3** | **`retainedOutput` Missing in Mock API**<br>Rule: AP-010, AP-026 | **P1** | `fix-now` | **Evidence:** `bash` в Durable 1.2.0 вызывает `api.retainedOutput()`. Тест `codemode-nested-env.test.ts` падает с `TypeError: api.retainedOutput is not a function`.<br>**Impact:** Вызов системных инструментов через вложенный исполнитель падает. | Реализовать `retainedOutput: () => ({ text: outputText, truncated: false })` в объекте `api` в `createNestedToolExecutor`. |
| **F-91-4** | **In-Memory Codemode & Missing Dep**<br>Rule: AP-010, AP-026 | **P1** | `fix-now` | **Evidence:** `tool-adapter.ts` берет in-memory `createCodemodeExtension` из `coding-agent`. Пакет `@earendil-works/pi-codemode` отсутствует в манифесте.<br>**Impact:** Скрипты кодемода не персистентны, теряют состояние при рестарте. | Добавить `@earendil-works/pi-codemode` в `package.json` и `build-runner.mjs`. Переключить реестр на `@earendil-works/pi-durable/codemode`. |
| **F-91-5** | **Anthropic HTTP 400 on Image Error**<br>Rule: AP-010, AP-026 | **P1** | `fix-now` | **Evidence:** Anthropic отклоняет `is_error: true` с нетекстовыми блоками ([#10794](https://github.com/earendil-works/pi/issues/10794)).<br>**Impact:** Падение диалога при ошибке инструмента, выведшего изображение. | Заменять блоки `type: "image"` на текст `[image omitted: error tool results cannot contain images]` при `isError === true`. |
| **F-91-6** | **Multimodal Read Tool Lacks Photon**<br>Rule: AP-010, AP-013 | **P2** | `fix-now` | **Evidence:** `CodingTools` инициализирован без `images`. `read` падает на картинках с `unsupported_image`.<br>**Impact:** Модель не может просматривать скриншоты и диаграммы. | Подключить `@earendil-works/pi-durable/images/node` с `createNodePhotonImages()` в `harness-setup.ts`. |
| **F-91-7** | **Bash Exit Code Test Mismatch**<br>Rule: AP-028 | **P2** | `fix-now` | **Evidence:** В 1.2.0 `exit 42` в кодемоде резолвится с `{ exitCode: 42 }` вместо выброса исключения.<br>**Impact:** Падение ассерта в `codemode-full-coverage.test.ts`. | Обновить ассерт теста: проверять возврат объекта `{ exitCode: 42 }`. |
| **F-91-8** | **Subagent `parentToolCallId` Assumption**<br>Rule: AP-012, AP-026 | **P1** | `log-only` | **Evidence:** Анализ `events.ts:468` подтвердил: отдельные беседы субагентов НЕ получают `parentToolCallId` от Durable.<br>**Impact:** Удаление `BBChildEventAdapter` сломало бы таймлайн BB. | Оставить `BBChildEventAdapter` и связывание по `parentRef`. |

---

## 3. FSM State: S6–S7 Plan Write & Plan Review

### Срез 0. Манифест зависимостей и сборщик (F-91-4, AP-026)
- **Целевые файлы:** `package.json`, `scripts/build-runner.mjs`
- **Действия:**
  1. В `package.json` обновить:
     - `"@earendil-works/pi-durable": "^1.2.0"`
     - `"@earendil-works/pi-coding-agent": "^1.2.0"`
     - Добавить `"@earendil-works/pi-codemode": "^1.2.0"` в `dependencies`.
  2. В `scripts/build-runner.mjs` добавить в `external`:
     - `"@earendil-works/pi-codemode"`, `"@earendil-works/pi-codemode/*"`.
  3. Запустить `npm install` и верифицировать консистентность дерева `node_modules`.

### Срез 1. Устранение Breaking Changes компилятора и контрактов (F-91-1, F-91-2)
- **Целевые файлы:** `src/runner/extension-mount.ts`, `src/runner/runtime-controller.ts`, `src/runner/subagent.ts`, `src/runner/tool-adapter.ts`, `src/runner/bridge/tool-result-extractor.ts`
- **Действия:**
  1. В `src/runner/extension-mount.ts` (L171) обновить вызов:
     ```typescript
     await extensionRunner.emitBeforeAgentStart(
         { messageType: "user", prompt: "", images: undefined },
         { cwd: location.cwd, selectedTools: currentTools, sections: dynamicSections?.getSections() ?? {} }
     );
     ```
  2. В `src/runner/runtime-controller.ts` (L70) обновить вызов:
     ```typescript
     await extensionRunner.emitBeforeAgentStart(
         { messageType: "user", prompt: text, images: undefined },
         promptOptions as import("@earendil-works/pi-coding-agent").BuildSystemPromptOptions
     );
     ```
  3. В `src/runner/subagent.ts` (L73, L88) заменить свойство `content:` на `output:`.
  4. В `src/runner/tool-adapter.ts` (L121, L147) возвращать `output: result.content` (или `output: errorContent`).
  5. В `src/runner/bridge/tool-result-extractor.ts` в `extractToolResult` поддержать:
     ```typescript
     const raw = msg?.output ?? msg?.content;
     ```
  6. Проверка: `npx tsc --noEmit` завершается с кодом 0.

### Срез 2. Доработка Mock API (`retainedOutput`) и Anthropic Error Sanitization (F-91-3, F-91-5)
- **Целевые файлы:** `src/runner/extension-mount.ts`, `src/runner/bridge/tool-result-extractor.ts`, `src/runner/tool-adapter.ts`
- **Действия:**
  1. В `src/runner/extension-mount.ts` в `createNestedToolExecutor` расширить мок-объект `api`:
     ```typescript
     const api = {
         callId: `${callerId}/nested`,
         output: (chunk: string | Uint8Array) => {
             outputText += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
         },
         retainedOutput: () => ({ text: outputText, truncated: false }),
         env: getEnv?.(),
         diagnostic: () => {},
     };
     ```
  2. В `src/runner/tool-adapter.ts` и `src/runner/bridge/tool-result-extractor.ts` добавить функцию санитизации:
     ```typescript
     function sanitizeForAnthropic<T extends { type: string }>(blocks: T[], isError?: boolean): T[] {
         if (!isError) return blocks;
         return blocks.map((b) => b.type === "image" ? ({ type: "text", text: "[image omitted: error tool results cannot contain images]" } as unknown as T) : b);
     }
     ```
  3. Проверка: запустить `node --test tests/codemode-nested-env.test.ts` (Green).

### Срез 3. Переход на нативные модули Durable 1.2.0 (F-91-4, F-91-6)
- **Целевые файлы:** `src/runner/tool-adapter.ts`, `src/runner/harness-setup.ts`, `src/runner/runtime-loader.ts`
- **Действия:**
  1. В `src/runner/tool-adapter.ts`:
     - Оставить в `createStandardExtensionFactories()` только `createMcpExtension()`.
     - Исправить маппинг `exposure`:
       - `exposure === "deferred"` -> `deferred: true, callers: ["model", "tools"]`
       - `exposure === "codemode-deferred"` -> `deferred: true, callers: ["tools"]`
       - `exposure === "codemode"` -> `callers: ["tools"]`
       - `exposure === "model-only"` -> `callers: ["model"]`
  2. В `src/runner/harness-setup.ts`:
     - Импортировать `createCodemodeExtension` из `@earendil-works/pi-durable/codemode`.
     - Импортировать `CodemodeSandbox` из `@earendil-works/pi-codemode`.
     - Импортировать `createToolSearchExtension` из `@earendil-works/pi-durable/tool-search`.
     - Импортировать `createCodingTools` из `@earendil-works/pi-durable/tools`.
     - Импортировать `createNodePhotonImages` из `@earendil-works/pi-durable/images/node`.
     - Сделать функцию `createCodingRegistry` асинхронной (или загружать image processor безопасно) и устанавливать:
       ```typescript
       let tools = CodingTools;
       try {
           tools = createCodingTools({ images: await createNodePhotonImages() });
       } catch { /* fallback to default */ }
       registry.install(tools);
       registry.install(createCodemodeExtension({ sandbox: new CodemodeSandbox() }));
       registry.install(createToolSearchExtension());
       registry.install(Subagent);
       registry.install(createPiPrompt(settingsManager, cwd, promptOptions));
       ```
  3. В `src/runner/bridge/bb-event-adapter.ts`:
     - В `tool_execution_start`, `tool_execution_update`, `tool_execution_end` прокидывать `event.parentToolCallId` как `parentRef`, чтобы вызовы внутри codemode нативно отображались вложенными.

### Срез 4. Адаптация тестов и TDD верификация (F-91-7, AP-028)
- **Целевые файлы:** `tests/codemode-full-coverage.test.ts`, `tests/subagent.test.ts`, `tests/durable-subagent.test.ts`
- **Действия:**
  1. В `tests/codemode-full-coverage.test.ts`:
     - Обновить тест non-zero exit code для bash: проверить, что вызов резолвится объектом `{ output: ..., exitCode: 42 }` и свойством `isError: true` в деталях.
  2. В `tests/durable-subagent.test.ts`:
     - Адаптировать вызов `createCodingRegistry` с `await`.
     - Добавить регрессионный тест, проверяющий, что результат `subagent` возвращает `output` (а не пустой `content`).
  3. Запустить `npm test` и добиться 100% прохождения тестов (203+ tests passing, 0 failures).

### Срез 5. Архитектурный контроль, Doctor & Ledger (AP-019, AP-029, S9–S12)
- **Целевые файлы:** `docs/arch-improvement/ledger.md`, `dist/`
- **Действия:**
  1. Проверить лимиты строк во всех файлах `src/runner/`: `wc -l $(find src/runner -maxdepth 1 -type f)` строго < 200 строк.
  2. Запустить `npx tsc --noEmit` (0 ошибок).
  3. Запустить `npm run build` (успешная сборка runner и host).
  4. Запустить `npm run doctor` (чистый аудит окружения и инструментов).
  5. Синхронизировать артефакты в кеш BB (`~/.bb/plugins/cache/.../dist/`) и перезагрузить:
     `bb plugin reload provider-pi-durable`.
  6. Зафиксировать итоги Cycle 91 в `docs/arch-improvement/ledger.md`.
