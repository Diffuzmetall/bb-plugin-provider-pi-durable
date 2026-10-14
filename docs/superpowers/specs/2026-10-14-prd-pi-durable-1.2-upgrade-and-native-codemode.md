# PRD: Pi Durable & Coding Agent v1.2.0 Upgrade, Native Codemode & Decoupling

**Статус:** 📋 APPROVED SPECIFICATION (READY FOR PLANNING)  
**Дата создания:** 2026-10-14  
**Цикл арх лупа:** Cycle 91  
**Автор:** Lead Architect & Agent Systems Engineer  
**Репозиторий:** `VanDalkvist/bb-plugin-provider-pi-durable`  
**Целевая ветка:** `main`  
**Зависимости апстрима:** `@earendil-works/pi-durable@^1.2.0`, `@earendil-works/pi-coding-agent@^1.2.0`, `@earendil-works/pi-codemode@^1.2.0`

---

## 1. Executive Summary & Vision

### 1.1. Контекст
В апстриме монорепозитория `earendil-works/pi` состоялся синхронный релиз стека **v1.2.0** (`pi-durable`, `pi-coding-agent`, `pi-ai`, `pi-codemode`). 
Исторически наш плагин `bb-plugin-provider-pi-durable` содержал значительный объём вспомогательных адаптеров («монтажной пены»), компенсировавших ограничения ранних версий:
- Ручной исполнитель вложенных тулов `createNestedToolExecutor` в `src/runner/extension-mount.ts` (~120 строк) с моками `api.callId`, ручной буферизацией вывода и ручным вызовом хуков.
- Заимствование in-memory расширений `createCodemodeExtension` и `createToolSearchExtension` из `@earendil-works/pi-coding-agent`, которые не имели контекста Durable, теряли состояние при сбоях и требовали обходных путей для окружения `ExecutionEnv` (Cycle 85).
- Ручной маппинг `exposure` в `callers` и фильтрация скрытых инструментов.

### 1.2. Цель (Cycle 91)
Перевести плагин на нативные примитивы **`@earendil-works/pi-durable@1.2.0`**, сохранив строгую архитектурную чистоту (AP-010, AP-013, AP-019 < 200 строк, AP-026, AP-028, AP-029):
1. **Durable Codemode:** Заменить in-memory кодемод на нативный `@earendil-works/pi-durable/codemode` с персистентным QuickJS-рантаймом (`CodemodeSandboxBase`), журналом повторов в SQLite (`pi.codemode.journal`) и детерминированным выживанием при падениях процесса.
2. **First-class Nested Tool Calls & Structured Output:** Делегировать выполнение вложенных тулов в нативный `api.executeTool(name, args, context)`, переведя обработку вывода на `output` + `structuredOutput` (устранение бага [#10815](https://github.com/earendil-works/pi/issues/10815)).
3. **Native Tool Search & Deferred Tools:** Подключить нативный `@earendil-works/pi-durable/tool-search` и декларативный флаг `deferred: true`.
4. **Photon WASM Image Processor:** Внедрить нативную обработку картинок в `read` через `@earendil-works/pi-durable/images/node` с обработкой в Worker-потоке.
5. **Defensive Hardening:** Внедрить защиту от падения Anthropic API (HTTP 400 из-за картинок в ошибочных вызовах — [#10794](https://github.com/earendil-works/pi/issues/10794)) и адаптировать Breaking Changes компилятора (`emitBeforeAgentStart`).

---

## 2. Архитектурный аудит и устранение антипаттернов (Gap Analysis & Truth Check)

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              LEGACY ADAPTER (CYCLE 86)                                 │
│                                                                                        │
│  Runner                                                                                │
│   ├── in-memory Codemode (from coding-agent) [Non-durable, lost on crash]              │
│   ├── createNestedToolExecutor() [~120 lines ad-hoc mock api, missing retainedOutput]  │
│   ├── ToolExecutionResult { content: [...] } [Deprecated in 1.2.0, causes empty child]│
│   └── emitBeforeAgentStart(prompt, images, opts) [TS2554 error in 1.2.0]               │
└────────────────────────────────────────────────────────────────────────────────────────┘

                                           ▼

┌────────────────────────────────────────────────────────────────────────────────────────┐
│                           CANONICAL CYCLE 91 ARCHITECTURE                              │
│                                                                                        │
│  Runner (Pi Durable 1.2.0)                                                             │
│   ├── Native Durable Codemode (@earendil-works/pi-durable/codemode)                     │
│   │   └─ QuickJS sandbox + SQLite journal (survives restarts & reconnects)             │
│   ├── Native Tool Search (@earendil-works/pi-durable/tool-search)                      │
│   ├── First-class api.executeTool() & api.retainedOutput()                             │
│   ├── ToolExecutionResult { output: [...], structuredOutput: {...} }                   │
│   ├── emitBeforeAgentStart({ messageType: "user", prompt, images }, opts)              │
│   ├── Photon WASM image worker (/images/node) for multimodal read tool                 │
│   └── Defensive Error Sanitizer (strips images on isError for Anthropic #10794)        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### Gap 1: Сигнатура `emitBeforeAgentStart` в `pi-coding-agent@1.2.0`
- **Проблема:** В `pi-coding-agent@1.2.0` сигнатура `emitBeforeAgentStart` принимает 2 аргумента вместо 3: `(trigger: BeforeAgentStartTrigger, systemPromptOptions: BuildSystemPromptOptions)`. Попытка сборки на 1.2.0 падает с `TS2554: Expected 2 arguments, but got 3`.
- **Решение:** В `extension-mount.ts` (L171) и `runtime-controller.ts` (L70) передавать `{ messageType: "user", prompt, images }`.

### Gap 2: Скрытое исчезновение ответа `subagent` (`content` -> `output`)
- **Проблема:** В `ToolExecutionResult` свойство `content` переименовано в `output`. Поскольку все поля `ToolExecutionResult` опциональны, TypeScript компилирует `{ content: [...] }` без ошибок, но ядро Durable отбрасывает `content`, оставляя ответ субагента пустым (баг [#10815](https://github.com/earendil-works/pi/issues/10815)).
- **Решение:** В `src/runner/subagent.ts` и `src/runner/tool-adapter.ts` возвращать явный `output`. В `tool-result-extractor.ts` поддерживать как `output`, так и `content` (для старых записей SQLite).

### Gap 3: Отсутствие `api.retainedOutput()` в мок-объекте `api`
- **Проблема:** В Durable 1.2.0 инструмент `bash` при завершении обращается к `api.retainedOutput()` для формирования `structuredOutput`. Наш ad-hoc мок в `createNestedToolExecutor` вызывал `TypeError: api.retainedOutput is not a function`.
- **Решение:** Оснастить исполнитель полноценным моком `api`, предоставляющим `retainedOutput: () => ({ text: outputText, truncated: false })`.

### Gap 4: In-Memory Codemode и отсутствие `@earendil-works/pi-codemode` в манифесте
- **Проблема:** Использование `createCodemodeExtension` из `coding-agent` не давало персистентности и ACID-журналирования. Для перехода на `@earendil-works/pi-durable/codemode` требуется передача `sandbox: new CodemodeSandbox()`, для которого необходим пакет `@earendil-works/pi-codemode`.
- **Решение:** Добавить `@earendil-works/pi-codemode: "^1.2.0"` в `dependencies` `package.json` и в `external` в `scripts/build-runner.mjs`.

### Gap 5: Ошибка Anthropic HTTP 400 при наличии картинок в ошибках тулов
- **Проблема:** Если инструмент или скрипт codemode падает после вывода картинки, формируется `tool_result` с `isError: true`, содержащий блок `image`. Anthropic API бракует запрос с кодом 400 (`all content must be type text if is_error is true`), подвешивая диалог ([#10794](https://github.com/earendil-works/pi/issues/10794)).
- **Решение:** Внедрить санитайзер в `tool-result-extractor.ts` и `tool-adapter.ts`: при `isError === true` заменять любые блоки `image` на текст `[image omitted: error tool results cannot contain images]`.

### Gap 6: Ложное предположение о `parentToolCallId` у Subagent
- **Фактчекинг:** Поле `parentToolCallId` нативно выставляется ядром Durable **только** для вложенных вызовов в той же беседе (`NestedToolSlot`). Беседы субагентов (`createConversation`) являются независимыми сессиями первого уровня и **не имеют** `parentToolCallId`.
- **Решение:** Сохранить `BBChildEventAdapter` и связывание по `parentRef` через `startSubagentWatcher`.

---

## 3. Требования к реализации (Functional & Non-Functional Requirements)

### 3.1. Функциональные требования
- **FR-1:** Плагин собирается и выполняется на зависимостях `@earendil-works/pi-durable@^1.2.0`, `@earendil-works/pi-coding-agent@^1.2.0`, `@earendil-works/pi-codemode@^1.2.0`.
- **FR-2:** Инструмент `codemode` использует детерминированный рантайм `CodemodeSandbox` с журналированием в SQLite.
- **FR-3:** Инструмент `read` поддерживает чтение и ресайз картинок через Photon WASM с обработкой в Worker-потоке (`/images/node`).
- **FR-4:** Инструмент `subagent` возвращает непустой `output`, корректно видимый родительской модели.
- **FR-5:** Ошибочные результаты тулов гарантированно очищаются от нетекстовых блоков перед отправкой в модель.

### 3.2. Нефункциональные требования и архитектурные правила
- **NFR-1 (AP-010 Thin Adapter):** Плагин остается тонким двунаправленным адаптером; логика журналирования и выполнения тулов делегируется в Durable.
- **NFR-2 (AP-019 File Line Limits):** 100% файлов в `src/runner/` имеют размер строго < 200 строк (soft limit 150).
- **NFR-3 (AP-026 Single Truth):** Все напрямую импортируемые рантайм-модули явно объявлены в `dependencies` `package.json`.
- **NFR-4 (AP-028 TDD):** Все изменения сопровождаются детерминированными тестами.
- **NFR-5 (AP-029 Strict TypeScript):** 0 ошибок `tsc`, 0 `any`, 0 `as unknown as`.
