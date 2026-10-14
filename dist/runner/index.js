import { createRequire as __createRequire } from "node:module";
const require = __createRequire(import.meta.url);

// src/runner/model-setup.ts
import {
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  getAgentDir,
  resolveModelScopeWithDiagnostics
} from "@earendil-works/pi-coding-agent";

// src/runner/harness-setup.ts
import {
  createRegistry
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createCodingTools, CodingTools } from "@earendil-works/pi-durable/tools";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";

// src/runner/subagent.ts
import { Type } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  configure,
  defineExtension,
  defineTool
} from "@earendil-works/pi-durable";
function buildRoleEnvelope(task) {
  return [
    "You are an isolated worker subagent.",
    `Your ONLY goal is to solve the delegated task: "${task}".`,
    "Rules:",
    "- Focus strictly on solving the assigned task using your available tools.",
    "- Do not attempt repository-wide meta-discovery, git archaeology, or searching for other agents.",
    "- Execute the task and return your final answer concisely."
  ].join("\n");
}
async function answerText(api, answer, context) {
  const entry = await api.commit((tx) => tx.entry(AssistantEntry, answer), context);
  const message = entry?.model?.[0];
  return message?.content.flatMap((content) => content.type === "text" ? [content.text] : []).join("") ?? "";
}
var Subagent = defineExtension({
  name: "subagent",
  tools: [
    defineTool({
      name: "subagent",
      description: "Delegate a self-contained task to an async subagent. Runs in the background by default without blocking the conversation.",
      parameters: Type.Object({
        task: Type.String({ description: "What the subagent should do" }),
        background: Type.Optional(
          Type.Boolean({
            description: "Run in background asynchronously (default: true). Set false only if an immediate synchronous answer is strictly required.",
            default: true
          })
        )
      }),
      replay: "safe",
      execute: async (args2, api, context) => {
        const isBackground = args2.background !== false;
        const child = await api.commit(async (tx) => {
          const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
          if (existing !== void 0) return existing.id;
          const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
          await configure(tx, created.id, { instructions: buildRoleEnvelope(args2.task) });
          return created.id;
        }, context);
        await api.details({ conversationId: child, task: args2.task, background: isBackground }, context);
        const handle = await api.conversation(child, context);
        if (!handle) {
          throw new Error(`Failed to access subagent conversation: ${child}`);
        }
        const request = { type: "input", content: args2.task, requestId: `subagent:${api.taskId}` };
        const submission = await handle.submit(request, context);
        if (isBackground) {
          return {
            output: [
              {
                type: "text",
                text: `Subagent spawned in background (conversation ${child}). The task is running independently and will report upon completion.`
              }
            ],
            details: { conversationId: child, background: true, task: args2.task }
          };
        }
        const settled = await submission.wait(context);
        if (settled.status !== "done" || settled.type !== "input") {
          throw new Error(`Subagent ${child} failed: ${settled.status}`);
        }
        const text = await answerText(api, settled.answer, context);
        return { output: [{ type: "text", text }], details: { conversationId: child, background: false, task: args2.task } };
      }
    })
  ]
});

// src/runner/harness-setup.ts
import {
  resolveCliModel
} from "@earendil-works/pi-coding-agent";

// src/runner/prompt.ts
import { existsSync, readFileSync } from "node:fs";
import { defineExtension as defineExtension2, section } from "@earendil-works/pi-durable";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  formatSkillsForPrompt
} from "@earendil-works/pi-coding-agent";
var DynamicPromptSections = class {
  sections = {};
  revision = 0;
  getSections() {
    return { ...this.sections };
  }
  updateSections(sections) {
    this.sections = { ...sections };
    this.revision++;
  }
  getRevision() {
    return this.revision;
  }
};
var CANONICAL_TOOL_DEFS = {
  read: createReadToolDefinition(process.cwd()),
  write: createWriteToolDefinition(process.cwd()),
  edit: createEditToolDefinition(process.cwd()),
  bash: createBashToolDefinition(process.cwd())
};
var KEYS = [
  "preamble",
  "tools",
  "rules",
  "docs",
  "addendum",
  "project_context",
  "skills",
  "cwd",
  "mcp_servers",
  "dynamic_sections"
];
function resolveContextFiles(options) {
  if (options.contextFiles && options.contextFiles.length > 0) return options.contextFiles;
  return options.resourceLoader?.getAgentsFiles?.()?.agentsFiles ?? [];
}
function resolveSkills(options) {
  return options.resourceLoader?.getSkills?.()?.skills ?? [];
}
function buildRules(tools) {
  const rules = [];
  const seen = /* @__PURE__ */ new Set();
  const addRule = (rule) => {
    const normalized = rule.trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    rules.push(normalized);
  };
  if (tools.some((t) => t.name === "bash")) {
    addRule("Use bash for file operations like ls, rg, find");
  }
  for (const tool of tools) {
    const def = CANONICAL_TOOL_DEFS[tool.name];
    if (def?.promptGuidelines) {
      for (const guideline of def.promptGuidelines) addRule(guideline);
    }
    if (tool.promptGuidelines) {
      for (const guideline of tool.promptGuidelines) addRule(guideline);
    }
  }
  addRule("Be concise in your responses");
  addRule("Show file paths clearly when working with files");
  return rules.map((r) => `- ${r}`).join("\n");
}
function tryReadPromptFile(path, label) {
  if (!path || !existsSync(path)) return void 0;
  try {
    return readFileSync(path, "utf8").trim();
  } catch (err) {
    console.error(`Warning: failed to read ${label ?? "prompt"}: ${err}`);
    return void 0;
  }
}
function createPiPrompt(_settings, fallbackCwd, options = {}) {
  const systemPromptOverride = tryReadPromptFile(options.systemPromptPath, "system-prompt");
  const appendPrompt = tryReadPromptFile(options.appendSystemPromptPath, "append-system-prompt");
  const buildSections = (input) => {
    const cwd = input.env?.cwd ?? input.agent.cwd ?? fallbackCwd;
    const contextFiles = resolveContextFiles(options);
    const skills = resolveSkills(options);
    const tools = input.agent.tools ?? [];
    const sections = {};
    if (systemPromptOverride) {
      sections.preamble = systemPromptOverride;
    } else {
      sections.preamble = "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
      const visibleTools = tools.map((t) => {
        const def = CANONICAL_TOOL_DEFS[t.name];
        const snippet = def?.promptSnippet ?? t.promptSnippet ?? t.description ?? "";
        return snippet ? `- ${t.name}: ${snippet}` : `- ${t.name}`;
      });
      sections.tools = `<tools>
${visibleTools.join("\n")}

In addition to the tools above, you may have access to other custom tools depending on the project.
</tools>`;
      sections.rules = `<rules>
${buildRules(tools)}
</rules>`;
    }
    if (appendPrompt) sections.addendum = `<addendum>
${appendPrompt}
</addendum>`;
    if (contextFiles.length > 0) {
      const rendered = contextFiles.map((cf) => `<project_instructions path="${cf.path}">
${cf.content}
</project_instructions>`).join("\n\n");
      sections.project_context = `<project_context>
Project-specific instructions and guidelines:

${rendered}
</project_context>`;
    }
    if (skills.length > 0) sections.skills = `<skills>
${formatSkillsForPrompt(skills, "read")}
</skills>`;
    sections.cwd = `<cwd>
${cwd.replace(/\\/g, "/")}
</cwd>`;
    if (options.dynamicSections) {
      const extra = options.dynamicSections.getSections();
      if (extra.mcp_servers?.trim()) sections.mcp_servers = `<mcp_servers>
${extra.mcp_servers}
</mcp_servers>`;
      const otherEntries = Object.entries(extra).filter(([k, text]) => k !== "mcp_servers" && Boolean(text?.trim()));
      if (otherEntries.length > 0) {
        sections.dynamic_sections = otherEntries.map(([name, text]) => `<${name}>
${text}
</${name}>`).join("\n\n");
      }
    }
    return sections;
  };
  const built = /* @__PURE__ */ new WeakMap();
  const getOrBuild = (input) => {
    const currentRev = options.dynamicSections?.getRevision?.() ?? 0;
    const cached = built.get(input);
    if (cached === void 0 || cached.revision !== currentRev) {
      const sections = buildSections(input);
      built.set(input, { revision: currentRev, sections });
      return sections;
    }
    return cached.sections;
  };
  return defineExtension2({
    name: "pi-prompt",
    sections: KEYS.map((key) => section(key, (input) => getOrBuild(input)[key], { tag: false }))
  });
}

// src/runner/harness-setup.ts
function configureHarnessHttp(settingsManager) {
  const proxy = settingsManager.getGlobalSettings()?.httpProxy?.trim();
  if (proxy) {
    process.env.HTTP_PROXY ??= proxy;
    process.env.HTTPS_PROXY ??= proxy;
  }
}
function createHarnessSettings(settingsManager, getActiveModel) {
  return {
    get stream() {
      const provider = settingsManager.getProviderRetrySettings?.() ?? {};
      const idle = settingsManager.getHttpIdleTimeoutMs?.() ?? 3e5;
      return {
        timeoutMs: provider.timeoutMs ?? (idle === 0 ? 2147483647 : idle),
        maxRetryDelayMs: provider.maxRetryDelayMs,
        ...provider.maxRetries === void 0 ? {} : { maxRetries: provider.maxRetries }
      };
    },
    get compaction() {
      const active = getActiveModel?.();
      const model = active ? { provider: active.provider, id: active.modelId } : (() => {
        const p = settingsManager.getDefaultProvider();
        const m = settingsManager.getDefaultModel();
        return p && m ? { provider: p, id: m } : void 0;
      })();
      return settingsManager.getCompactionSettings?.(model) ?? {};
    },
    get retry() {
      return settingsManager.getRetrySettings?.() ?? {};
    },
    get steeringMode() {
      return settingsManager.getSteeringMode?.() ?? "immediate";
    },
    get followUpMode() {
      return settingsManager.getFollowUpMode?.() ?? "queue";
    }
  };
}
async function createCodingRegistry(settingsManager, cwd, promptOptions) {
  const registry = createRegistry();
  let codingTools = CodingTools;
  try {
    const images = await createNodePhotonImages();
    codingTools = createCodingTools({ images });
  } catch (err) {
    console.warn("[HarnessSetup] Photon image processor fallback to basic tools:", err);
  }
  registry.install(codingTools);
  registry.install(createCodemodeExtension({ sandbox: new CodemodeSandbox() }));
  registry.install(createToolSearchExtension());
  registry.install(Subagent);
  registry.install(createPiPrompt(settingsManager, cwd, promptOptions));
  return registry;
}
var ExecutionEnvs = class {
  #defaultCwd;
  #envs = /* @__PURE__ */ new Map();
  constructor(defaultCwd) {
    this.#defaultCwd = defaultCwd;
  }
  env = ({ cwd = this.#defaultCwd }) => {
    let env = this.#envs.get(cwd);
    if (env === void 0) {
      env = new NodeExecutionEnv({ cwd });
      this.#envs.set(cwd, env);
    }
    return env;
  };
  async cleanup(context) {
    const envs = [...this.#envs.values()];
    this.#envs.clear();
    for (const env of envs) await env.cleanup(context);
  }
};
async function findInitialAgentModel(settingsManager, modelRuntime, cli) {
  if (cli !== void 0) {
    const resolved = resolveCliModel({ cliProvider: cli.provider, cliModel: cli.model, modelRuntime });
    if (resolved.error !== void 0 || resolved.model === void 0) {
      throw new Error(`Could not resolve model: ${resolved.error ?? cli.model}`);
    }
    return {
      model: { provider: resolved.model.provider, modelId: resolved.model.id },
      thinkingLevel: cli.thinking ?? resolved.thinkingLevel ?? "off"
    };
  }
  const defaultProvider = settingsManager.getDefaultProvider?.();
  const defaultModelId = settingsManager.getDefaultModel?.();
  const defaultThinkingLevel = settingsManager.getDefaultThinkingLevel?.();
  if (defaultProvider && defaultModelId) {
    const models = modelRuntime.getAvailableSnapshot();
    const matched = models.find((m) => m.provider === defaultProvider && m.id === defaultModelId);
    if (matched) {
      return {
        model: { provider: matched.provider, modelId: matched.id },
        thinkingLevel: defaultThinkingLevel ?? "off"
      };
    }
  }
  const available = modelRuntime.getAvailableSnapshot();
  if (available.length > 0) {
    return {
      model: { provider: available[0].provider, modelId: available[0].id },
      thinkingLevel: "off"
    };
  }
  return {};
}

// src/runner/model-setup.ts
async function setupRunnerModels(cwd, args2) {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const modelRuntime = await ModelRuntime.create();
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
  await resourceLoader.reload();
  const extensionsResult = resourceLoader.getExtensions();
  for (const { name, config } of extensionsResult.runtime.pendingProviderRegistrations) {
    try {
      modelRuntime.registerProvider(name, config);
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      if (!msg.includes("already registered") && !msg.includes("duplicate")) {
        console.warn(`[ModelSetup] Failed to register provider ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  for (const { provider } of extensionsResult.runtime.pendingNativeProviderRegistrations) {
    try {
      modelRuntime.registerNativeProvider(provider);
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      if (!msg.includes("already registered") && !msg.includes("duplicate")) {
        console.warn(`[ModelSetup] Failed to register native provider ${provider?.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  for (const { definition } of extensionsResult.runtime.pendingVirtualModelRegistrations) {
    try {
      modelRuntime.registerVirtualModel(definition);
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
      if (!msg.includes("already registered") && !msg.includes("duplicate")) {
        console.warn(`[ModelSetup] Failed to register virtual model ${definition?.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  const availableModels = modelRuntime.getAvailableSnapshot();
  const enabledPatterns = settingsManager.getEnabledModels();
  const scopedScope = enabledPatterns && enabledPatterns.length > 0 ? await resolveModelScopeWithDiagnostics(enabledPatterns, modelRuntime) : void 0;
  const scopedModelList = scopedScope && scopedScope.scopedModels.length > 0 ? scopedScope.scopedModels.map((sm) => sm.model) : availableModels;
  const scopedModelIds = scopedModelList.map((m) => `${m.provider}/${m.id}`);
  const initialAgent = await findInitialAgentModel(
    settingsManager,
    modelRuntime,
    args2.model ? { provider: args2.provider, model: args2.model, thinking: args2.thinking } : void 0
  );
  const defaultModel = initialAgent.model ? modelRuntime.getModel(initialAgent.model.provider, initialAgent.model.modelId) ?? scopedModelList[0] : scopedModelList[0];
  const defaultModelId = defaultModel ? `${defaultModel.provider}/${defaultModel.id}` : void 0;
  const defaultThinkingLevel = initialAgent.thinkingLevel ?? "off";
  const modelScope = {
    scopedModelIds,
    defaultModelId
  };
  return {
    settingsManager,
    modelRuntime,
    scopedModelList,
    defaultModel,
    defaultThinkingLevel,
    modelScope
  };
}

// src/runner/jsonl.ts
import { StringDecoder } from "node:string_decoder";
function serializeJsonLine(value) {
  return `${JSON.stringify(value)}
`;
}
function attachJsonlLineReader(stream, onLine) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  const emitLine = (line) => {
    onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  };
  const onData = (chunk) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      emitLine(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
    }
  };
  const onEnd = () => {
    buffer += decoder.end();
    if (buffer.length > 0) {
      emitLine(buffer);
      buffer = "";
    }
  };
  stream.on("data", onData);
  stream.on("end", onEnd);
  return () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
  };
}

// src/runner/runtime.ts
import { resolveModelScopeWithDiagnostics as resolveModelScopeWithDiagnostics2 } from "@earendil-works/pi-coding-agent";

// src/runner/session-storage.ts
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
function getAgentDir2() {
  const override = process.env.PI_AGENT_DIR;
  if (override && override.trim().length > 0) return resolve(override.trim());
  return join(homedir(), ".pi", "agent");
}
function isProcessAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
function logUnexpectedErr(err, allowedCode, context) {
  if (err?.code !== allowedCode) {
    console.warn(`[SessionStorage] ${context}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
async function writeOwnerFile(directory, owner) {
  await writeFile(join(directory, "session.owner.json"), JSON.stringify(owner, null, 2), "utf8");
}
async function readOwnerFile(directory) {
  try {
    const content = await readFile(join(directory, "session.owner.json"), "utf8");
    return JSON.parse(content);
  } catch (err) {
    logUnexpectedErr(err, "ENOENT", `Corrupted or unreadable session.owner.json in ${directory}`);
    return null;
  }
}
async function removeOwnerFile(directory) {
  await rm(join(directory, "session.owner.json"), { force: true }).catch(
    (err) => logUnexpectedErr(err, "ENOENT", `Failed to remove owner file in ${directory}`)
  );
}
async function forceUnlock(directory) {
  await lockfile.unlock(directory, { realpath: false }).catch(
    (err) => logUnexpectedErr(err, "ENOENT", `unlock warning for ${directory}`)
  );
  await rm(`${directory}.lock`, { recursive: true, force: true }).catch(
    (err) => logUnexpectedErr(err, "ENOENT", `lockfile cleanup warning for ${directory}`)
  );
}
async function acquireSessionLock(directory, cwd, id) {
  const lockOpts = { realpath: false, retries: { retries: 2, minTimeout: 100, maxTimeout: 200 } };
  let rawRelease;
  try {
    rawRelease = await lockfile.lock(directory, lockOpts);
  } catch (initialErr) {
    let owner = await readOwnerFile(directory);
    if (!owner) {
      await new Promise((r) => setTimeout(r, 100));
      owner = await readOwnerFile(directory);
    }
    if (!owner) {
      throw new Error(`Session is already open in another process: ${directory}`, { cause: initialErr });
    }
    if (!isProcessAlive(owner.pid)) {
      await forceUnlock(directory);
      await removeOwnerFile(directory);
      try {
        rawRelease = await lockfile.lock(directory, lockOpts);
      } catch (retryErr) {
        throw new Error(`Session is already open in another process (PID: ${owner.pid}): ${directory}`, { cause: retryErr });
      }
    } else if (owner.pid !== process.pid) {
      try {
        process.kill(owner.pid, "SIGTERM");
      } catch (err) {
        logUnexpectedErr(err, "ESRCH", `Failed to send SIGTERM to PID ${owner.pid}`);
      }
      const deadline = Date.now() + 3e3;
      while (Date.now() < deadline && isProcessAlive(owner.pid)) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!isProcessAlive(owner.pid)) {
        await forceUnlock(directory);
        await removeOwnerFile(directory);
        try {
          rawRelease = await lockfile.lock(directory, lockOpts);
        } catch (retryErr) {
          throw new Error(`Session is already open in another process (PID: ${owner.pid}): ${directory}`, { cause: retryErr });
        }
      } else {
        throw new Error(`Session is already open in another process (PID: ${owner.pid}): ${directory}`, { cause: initialErr });
      }
    } else {
      throw new Error(`Session is already open in another process (PID: ${owner.pid}): ${directory}`, { cause: initialErr });
    }
  }
  await writeOwnerFile(directory, { pid: process.pid, id, cwd, startedAt: Date.now() });
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await removeOwnerFile(directory);
    } finally {
      await rawRelease();
    }
  };
}
async function selectSession(cwdInput, continueSession, targetSession) {
  const cwd = await realpath(resolve(cwdInput));
  const root = join(getAgentDir2(), "experimental", "durable-sessions", createHash("sha256").update(cwd).digest("hex").slice(0, 24));
  await mkdir(root, { recursive: true });
  let directory;
  let created = false;
  if (targetSession) {
    const clean = targetSession.endsWith(".sqlite") ? resolve(targetSession, "..") : targetSession;
    directory = clean.includes("/") || clean.includes("\\") ? resolve(clean) : join(root, clean);
    try {
      await mkdir(directory, { recursive: true });
      const entries = await readdir(directory);
      if (!entries.includes("session.sqlite")) {
        created = true;
      }
    } catch (err) {
      logUnexpectedErr(err, "ENOENT", `Directory inspection failed in ${directory}`);
    }
  } else if (continueSession) {
    const entries = await readdir(root, { withFileTypes: true });
    const newest = entries.filter((entry) => entry.isDirectory() && /^\d{13}-[0-9a-f-]{36}$/u.test(entry.name)).map((entry) => entry.name).sort().at(-1);
    if (!newest) throw new Error(`No durable session exists for ${cwd}`);
    directory = join(root, newest);
  } else {
    directory = join(root, `${String(Date.now()).padStart(13, "0")}-${randomUUID()}`);
    await mkdir(directory);
    created = true;
  }
  const id = basename(directory);
  const release = await acquireSessionLock(directory, cwd, id);
  return { id, directory, database: join(directory, "session.sqlite"), cwd, created, release };
}

// src/runner/runtime-types.ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  ROOT_CONVERSATION_ID
} from "@earendil-works/pi-durable";
var runtimeContext = BACKGROUND_CONTEXT;
function agentOf(view) {
  return view.docs["pi.agent"] ?? {};
}
function titleOf(entry) {
  const message = entry?.model?.[0];
  if (message?.role !== "user") return {};
  const text = typeof message.content === "string" ? message.content : message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join(" ");
  return { title: text.replace(/\s+/g, " ").trim() };
}
async function firstInput(harness, id) {
  if (id === ROOT_CONVERSATION_ID) return {};
  const conversation = await harness.conversation(id, runtimeContext);
  let first;
  let cursor;
  do {
    const page = await conversation.entries({}, 256, cursor, runtimeContext);
    first = [...page.items].reverse().find((entry) => entry.kind === "pi.user") ?? first;
    cursor = page.next;
  } while (cursor !== void 0);
  return titleOf(first);
}

// src/runner/runtime-controller.ts
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
function createDurableController(ctx) {
  let queue = Promise.resolve();
  const command = (operation) => {
    queue = queue.then(operation).catch(ctx.fail);
    return queue;
  };
  const watchAnswer = (submission) => {
    void submission.wait(runtimeContext).then((settled) => {
      if (settled.status === "unanswered" && settled.reason !== "aborted") {
        ctx.notice(
          "error",
          `No answer: ${settled.reason}${settled.detail === void 0 ? "" : ` ${JSON.stringify(settled.detail)}`}`
        );
      }
    }, ctx.fail);
  };
  const agentModel = () => {
    const ref = agentOf(ctx.getState().conversation).model;
    const model = ref === void 0 ? void 0 : ctx.modelRuntime.getModel(ref.provider, ref.modelId);
    if (model === void 0) {
      throw new Error(ref === void 0 ? "No model selected" : "Current model is unavailable");
    }
    return model;
  };
  return {
    submit: (text, whenBusy) => command(async () => {
      if (ctx.extensionRunner && ctx.dynamicSections) {
        try {
          const hookRes = await ctx.extensionRunner.emitBeforeAgentStart(
            { messageType: "user", prompt: text, images: void 0 },
            {
              cwd: ctx.cwd ?? process.cwd(),
              sections: ctx.dynamicSections.getSections()
            }
          );
          if (hookRes?.systemPromptOptions?.sections) {
            ctx.dynamicSections.updateSections(hookRes.systemPromptOptions.sections);
          }
        } catch (err) {
          ctx.notice(
            "warning",
            `before_agent_start error: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      return watchAnswer(await ctx.getCurrent().submit({ type: "input", content: text, whenBusy }, runtimeContext));
    }),
    compact: (instructions) => command(async () => {
      const id = await ctx.getCurrent().compact(instructions, runtimeContext);
      void ctx.opened.waitForTask(id, runtimeContext).then(async (receipt) => {
        const outcome = receipt.state.outcome;
        if (outcome.status === "completed") {
          const { entryId, submissionId } = outcome.result;
          const status = submissionId === void 0 ? void 0 : (await (await ctx.opened.submission(submissionId, runtimeContext))?.status(runtimeContext))?.status;
          ctx.notice(
            "info",
            entryId !== void 0 || status === "done" ? "Compacted." : status === "queued" ? "Compaction summary queued; it is placed at the next turn boundary." : status === "unanswered" ? "Compaction summary dropped: the context changed under it." : "Nothing to compact: the context fits in the recent window that is kept verbatim."
          );
        } else if (outcome.status === "aborted") {
          ctx.notice("info", "Compaction aborted.");
        } else {
          ctx.notice("error", `Compaction ${outcome.status}: ${outcome.error?.message ?? outcome.reason ?? ""}`);
        }
      }, ctx.fail);
    }),
    abort: () => ctx.getCurrent().abort(runtimeContext).catch(ctx.fail),
    cycleThinking: () => command(async () => {
      const model = agentModel();
      if (!model.reasoning) throw new Error("Current model does not support thinking");
      const levels = getSupportedThinkingLevels(model);
      const level = agentOf(ctx.getState().conversation).thinkingLevel ?? "off";
      const next = levels[(levels.indexOf(level) + 1) % levels.length] ?? "off";
      await ctx.getCurrent().configure({ thinkingLevel: next }, runtimeContext);
    }),
    setThinkingLevel: (targetLevel) => command(async () => {
      const model = agentModel();
      if (!model.reasoning) throw new Error("Current model does not support thinking");
      await ctx.getCurrent().configure({ thinkingLevel: clampThinkingLevel(model, targetLevel) }, runtimeContext);
    }),
    setModel: (ref) => command(async () => {
      const model = ctx.modelRuntime.getModel(ref.provider, ref.modelId);
      if (model === void 0) throw new Error(`Unknown model: ${ref.provider}/${ref.modelId}`);
      ctx.setActiveModelRef(ref);
      const thinking = agentOf(ctx.getState().conversation).thinkingLevel ?? "off";
      await ctx.getCurrent().configure({ model: ref, thinkingLevel: clampThinkingLevel(model, thinking) }, runtimeContext);
    }),
    toggleTasks: () => command(async () => {
      if (ctx.getTasks() !== void 0) {
        ctx.closeTasks();
        ctx.update({ tasks: void 0 });
        return;
      }
      const graph = await ctx.opened.taskGraph(runtimeContext);
      ctx.setTasks(graph);
      ctx.setUnsubscribeTasks(graph.subscribe((value) => ctx.update({ tasks: value })));
    }),
    switchConversation: (id) => command(async () => {
      const next = await ctx.opened.conversation(id, runtimeContext);
      if (next === void 0) throw new Error(`Conversation ${id} does not exist`);
      const nextState = await next.viewState(runtimeContext);
      ctx.getUnsubscribeConversation()();
      ctx.getConversationState().dispose();
      ctx.setCurrent(next);
      ctx.setConversationState(nextState);
      ctx.setUnsubscribeConversation(nextState.subscribe((value) => ctx.update({ conversation: value })));
    })
  };
}

// src/runner/runtime-loader.ts
import {
  DefaultResourceLoader as DefaultResourceLoader2,
  ModelRuntime as ModelRuntime2,
  SettingsManager as SettingsManager2,
  initTheme
} from "@earendil-works/pi-coding-agent";

// src/runner/extension-bridge.ts
import {
  ExtensionRunner,
  ModelRegistry,
  SessionManager
} from "@earendil-works/pi-coding-agent";

// src/runner/tool-adapter.ts
import {
  createMcpExtension
} from "@earendil-works/pi-coding-agent";
import {
  defineExtension as defineExtension3,
  defineTool as defineTool2
} from "@earendil-works/pi-durable";

// src/runner/bridge/tool-result-extractor.ts
var activeToolDetails = /* @__PURE__ */ new Map();
function extractToolResult(modelItem) {
  const msg = typeof modelItem === "object" && modelItem !== null ? modelItem : void 0;
  const isError = msg?.isError ?? false;
  let result = "";
  const raw = msg?.content ?? msg?.output;
  if (Array.isArray(raw)) {
    result = raw.map((b) => typeof b === "object" && b !== null && typeof b.text === "string" ? b.text : "").filter(Boolean).join("\n");
  } else if (typeof raw === "string") {
    result = raw;
  }
  return { result, isError };
}
function buildToolExecutionUpdate(event, parentRef) {
  let partialResult = "";
  if (event.output) {
    if ("set" in event.output) partialResult = event.output.set;
    else if ("append" in event.output) partialResult = event.output.append ?? "";
  }
  let trimStart;
  if (event.output && "trimStart" in event.output && typeof event.output.trimStart === "number") {
    trimStart = event.output.trimStart;
  }
  if (event.details !== void 0) {
    activeToolDetails.set(event.toolCallId, event.details);
  }
  if (partialResult || trimStart !== void 0 || event.details !== void 0) {
    return {
      type: "tool_execution_update",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      partialResult,
      ...trimStart !== void 0 ? { trimStart } : {},
      ...event.details !== void 0 ? { details: event.details } : {},
      ...parentRef !== void 0 ? { parentRef } : {}
    };
  }
  return void 0;
}
function buildToolExecutionEnd(event, parentRef) {
  if (event.entry === void 0) {
    return {
      type: "tool_execution_end",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      result: "Tool execution faulted or was orphaned without generating an entry record.",
      isError: true,
      ...parentRef !== void 0 ? { parentRef } : {}
    };
  }
  const { result, isError } = extractToolResult(event.entry?.model?.[0]);
  const entryData = typeof event.entry === "object" && event.entry !== null && "data" in event.entry ? event.entry.data : void 0;
  const bufferedDetails = activeToolDetails.get(event.toolCallId);
  activeToolDetails.delete(event.toolCallId);
  const details = entryData ?? event.details ?? bufferedDetails;
  return {
    type: "tool_execution_end",
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    result,
    isError,
    ...details !== void 0 ? { details } : {},
    ...parentRef !== void 0 ? { parentRef } : {}
  };
}
function sanitizeToolResultForAnthropic(blocks, isError) {
  if (!isError || !Array.isArray(blocks)) return blocks;
  return blocks.map((block) => {
    if (block.type === "image") {
      return { type: "text", text: "[image omitted: error tool results cannot contain images]" };
    }
    return block;
  });
}

// src/runner/tool-adapter.ts
function hasOutput(api) {
  return typeof api === "object" && api !== null && "output" in api && typeof api.output === "function";
}
function createStandardExtensionFactories() {
  return [createMcpExtension()];
}
function adaptExtensionTool(toolDef, executeToolFn, createToolContext, getExtensionRunner) {
  const exposure = toolDef.exposure;
  const isDeferred = exposure === "deferred" || exposure === "codemode-deferred";
  const callers = exposure === "model-only" ? ["model"] : exposure === "codemode" || exposure === "codemode-deferred" ? ["tools"] : exposure === "hidden" ? [] : ["model", "tools"];
  return defineTool2({
    name: toolDef.name,
    description: toolDef.description,
    parameters: toolDef.parameters,
    callers,
    ...isDeferred ? { deferred: true } : {},
    ...toolDef.outputSchema ? {
      outputSchema: toolDef.outputSchema,
      structuredOutputSchema: toolDef.outputSchema
    } : {},
    async execute(args2, api) {
      const runner = getExtensionRunner?.();
      if (runner?.hasHandlers("tool_call")) {
        const hookResult = await runner.emitToolCall({
          type: "tool_call",
          toolName: toolDef.name,
          toolCallId: api.callId,
          input: args2 ?? {}
        });
        if (hookResult?.block) {
          const blockContent = [{ type: "text", text: `Tool execution blocked: ${hookResult.reason ?? "policy"}` }];
          return {
            output: blockContent,
            isError: true
          };
        }
      }
      const ctx = createToolContext ? createToolContext(api.callId) : {
        tools: [],
        executeTool: async (name, nestedArgs, options) => executeToolFn(api.callId, name, nestedArgs, options)
      };
      try {
        const result = await toolDef.execute(
          api.callId,
          args2,
          void 0,
          (update) => {
            if (update?.content && hasOutput(api)) {
              const textChunks = update.content.filter((c) => c.type === "text").map((c) => c.text).join("");
              if (textChunks.length > 0) api.output(textChunks);
            }
          },
          ctx
        );
        if (runner?.hasHandlers("tool_result")) {
          await runner.emitToolResult({
            type: "tool_result",
            toolName: toolDef.name,
            toolCallId: api.callId,
            input: args2 ?? {},
            content: result.content,
            details: result.details ?? void 0,
            isError: result.isError ?? false
          });
        }
        const sanitizedOutput = sanitizeToolResultForAnthropic(
          result.content,
          result.isError
        );
        return {
          output: sanitizedOutput,
          isError: result.isError,
          details: result.details ?? void 0
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const errorContent = [{ type: "text", text: message }];
        if (runner?.hasHandlers("tool_result")) {
          await runner.emitToolResult({
            type: "tool_result",
            toolName: toolDef.name,
            toolCallId: api.callId,
            input: args2 ?? {},
            content: errorContent,
            details: void 0,
            isError: true
          });
        }
        return {
          output: errorContent,
          isError: true
        };
      }
    }
  });
}
function installExtensionTools(registry, tools) {
  if (tools.length === 0) return;
  registry.install(defineExtension3({ name: "extension-tools", tools }));
}

// src/runner/extension-bridge.ts
function createExtensionUIContext(onNotice) {
  return {
    select: async () => void 0,
    confirm: async () => false,
    input: async () => void 0,
    notify: (message, type = "info") => {
      onNotice?.(type, message);
    },
    onTerminalInput: () => () => {
    },
    setStatus: () => {
    },
    setWorkingMessage: () => {
    },
    setWorkingVisible: () => {
    },
    setWorkingIndicator: () => {
    },
    setHiddenThinkingLabel: () => {
    },
    setWidget: () => {
    },
    setFooter: () => {
    },
    setHeader: () => {
    },
    setTitle: () => {
    },
    custom: async () => void 0,
    pasteToEditor: () => {
    },
    setEditorText: () => {
    },
    getEditorText: () => "",
    editor: async () => void 0,
    addAutocompleteProvider: () => {
    },
    setEditorComponent: () => {
    },
    getEditorComponent: () => void 0,
    theme: {},
    getAllThemes: () => [],
    getTheme: () => void 0,
    setTheme: () => ({ success: true }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {
    }
  };
}
async function setupExtensionRunner(options) {
  const sessionManager = SessionManager.create(options.cwd);
  const modelRegistry = new ModelRegistry(options.modelRuntime);
  const runner = new ExtensionRunner(options.extensions, options.runtime, options.cwd, sessionManager, modelRegistry);
  runner.setUIContext(createExtensionUIContext(options.onNotice));
  let activeToolNames = options.getCallableTools ? options.getCallableTools().map((t) => t.name) : [];
  let sessionName;
  const actions = {
    getActiveTools: () => activeToolNames,
    getAllTools: () => runner.getAllRegisteredTools().map((t) => ({
      name: t.definition.name,
      description: t.definition.description,
      parameters: t.definition.parameters,
      promptGuidelines: t.definition.promptGuidelines,
      exposure: t.definition.exposure ?? "direct",
      namespace: t.definition.namespace,
      annotations: t.definition.annotations,
      sourceInfo: t.sourceInfo
    })),
    getSettings: () => ({
      ...options.settingsManager?.getGlobalSettings() ?? {},
      ...options.settingsManager?.getProjectSettings() ?? {}
    }),
    setActiveTools: (toolNames) => {
      activeToolNames = [...toolNames];
    },
    refreshTools: () => {
      options.onToolsChanged?.();
    },
    getThinkingLevel: () => options.settingsManager?.getDefaultThinkingLevel?.() ?? "high",
    setThinkingLevel: () => {
    },
    setModel: async () => false,
    getCommands: () => [],
    sendMessage: () => {
    },
    sendUserMessage: () => {
    },
    appendEntry: (customType, data) => {
      sessionManager.appendCustomEntry(customType, data);
    },
    setSessionName: (name) => {
      sessionName = name;
    },
    getSessionName: () => sessionName,
    setLabel: () => {
    }
  };
  const contextActions = {
    getModel: () => {
      const active = options.settingsManager?.getDefaultModel?.();
      const provider = options.settingsManager?.getDefaultProvider?.();
      if (active && provider) {
        const found = options.modelRuntime.getModel(provider, active);
        if (found) return found;
      }
      return options.modelRuntime.getAvailableSnapshot()[0];
    },
    getScopedModels: () => options.modelRuntime.getAvailableSnapshot().map((model) => ({ model })),
    isIdle: () => true,
    isProjectTrusted: () => true,
    getSignal: () => void 0,
    abort: () => {
    },
    hasPendingMessages: () => false,
    shutdown: () => {
    },
    getContextUsage: () => void 0,
    compact: () => {
    },
    getSystemPrompt: () => "",
    getSystemPromptOptions: () => ({ cwd: options.cwd }),
    executeTool: (callerId, name, args2, opts) => options.executeToolFn(callerId, name, args2, opts),
    getCallableTools: () => options.getCallableTools ? options.getCallableTools() : runner.getAllRegisteredTools().map((t) => ({
      name: t.definition.name,
      description: t.definition.description,
      parameters: t.definition.parameters,
      promptGuidelines: t.definition.promptGuidelines,
      exposure: t.definition.exposure,
      namespace: t.definition.namespace,
      annotations: t.definition.annotations,
      sourceInfo: t.sourceInfo
    }))
  };
  runner.bindCore(actions, contextActions);
  await runner.emit({ type: "session_start", reason: "startup" });
  return runner;
}

// src/runner/extension-mount.ts
function createNestedToolExecutor(registry, getExtensionRunner, getEnv) {
  return async (callerId, name, args2, options) => {
    const runner = getExtensionRunner?.();
    let target = registry.snapshot().tools().find((t) => t.tool.name === name);
    if (!target && runner) {
      const toolDef = runner.getAllRegisteredTools().find((t) => t.definition.name === name);
      if (toolDef) {
        const ctx = (callId) => runner.createToolContext(callId, options?.signal);
        const adapted = adaptExtensionTool(toolDef.definition, createNestedToolExecutor(registry, getExtensionRunner, getEnv), ctx, () => runner);
        installExtensionTools(registry, [adapted]);
        target = registry.snapshot().tools().find((t) => t.tool.name === name);
      }
    }
    if (!target) {
      return {
        toolCall: { type: "toolCall", id: `${callerId}/nested`, name, arguments: args2 },
        result: { content: [{ type: "text", text: `Tool ${name} not found` }], details: {} },
        isError: true
      };
    }
    if (runner?.hasHandlers("tool_call")) {
      const hook = await runner.emitToolCall({
        type: "tool_call",
        toolName: name,
        toolCallId: `${callerId}/nested`,
        parentToolCallId: callerId,
        input: args2 ?? {}
      });
      if (hook?.block) {
        return {
          toolCall: { type: "toolCall", id: `${callerId}/nested`, name, arguments: args2 },
          result: { content: [{ type: "text", text: `Tool execution blocked: ${hook.reason ?? "policy"}` }], details: {} },
          isError: true
        };
      }
    }
    try {
      const executor = target.tool.execute;
      let outputText = "";
      const api = {
        callId: `${callerId}/nested`,
        output: (chunk) => {
          outputText += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        },
        retainedOutput: () => ({ text: outputText, truncated: false }),
        outputWindow: void 0,
        env: getEnv?.(),
        diagnostic: () => {
        }
      };
      const res = await executor(args2, api, runtimeContext);
      const rawBlocks = res?.output;
      const content = Array.isArray(rawBlocks) ? rawBlocks : rawBlocks !== void 0 ? [{ type: "text", text: String(rawBlocks) }] : [{ type: "text", text: outputText }];
      if (runner?.hasHandlers("tool_result")) {
        await runner.emitToolResult({
          type: "tool_result",
          toolName: name,
          toolCallId: `${callerId}/nested`,
          parentToolCallId: callerId,
          input: args2 ?? {},
          content,
          details: res?.details,
          isError: !!res?.isError
        });
      }
      return {
        toolCall: { type: "toolCall", id: `${callerId}/nested`, name, arguments: args2 },
        result: { content, details: res?.details },
        isError: !!res?.isError
      };
    } catch (err) {
      const errorContent = [{ type: "text", text: err instanceof Error ? err.message : String(err) }];
      if (runner?.hasHandlers("tool_result")) {
        await runner.emitToolResult({
          type: "tool_result",
          toolName: name,
          toolCallId: `${callerId}/nested`,
          parentToolCallId: callerId,
          input: args2 ?? {},
          content: errorContent,
          details: {},
          isError: true
        });
      }
      return {
        toolCall: { type: "toolCall", id: `${callerId}/nested`, name, arguments: args2 },
        result: { content: errorContent, details: {} },
        isError: true
      };
    }
  };
}
async function mountExtensionBridge(location, modelRuntime, extensionsResult, registry, executeToolFn, report, dynamicSections, onNotice, settingsManager) {
  let extensionRunner;
  try {
    const syncToolsToRegistry = () => {
      if (!extensionRunner) return;
      const adapted = extensionRunner.getAllRegisteredTools().map(
        (t) => adaptExtensionTool(t.definition, executeToolFn, (callId) => extensionRunner.createToolContext(callId, void 0), () => extensionRunner)
      );
      installExtensionTools(registry, adapted);
    };
    extensionRunner = await setupExtensionRunner({
      extensions: extensionsResult.extensions,
      runtime: extensionsResult.runtime,
      cwd: location.cwd,
      modelRuntime,
      executeToolFn,
      getCallableTools: () => {
        const map = /* @__PURE__ */ new Map();
        for (const t of registry.snapshot().tools()) {
          map.set(t.tool.name, { name: t.tool.name, description: t.tool.description ?? "", parameters: t.tool.parameters });
        }
        for (const t of extensionRunner?.getAllRegisteredTools() ?? []) {
          map.set(t.definition.name, { ...t.definition, sourceInfo: t.sourceInfo });
        }
        return Array.from(map.values());
      },
      onToolsChanged: syncToolsToRegistry,
      onNotice,
      settingsManager
    });
    if (extensionRunner) {
      extensionRunner.onError((err) => {
        report(err);
        onNotice?.("error", `[Extension Error] ${err.extensionPath} (${err.event}): ${err.error}`);
      });
      try {
        const currentTools = registry.snapshot().tools().map((t) => t.tool.name);
        const beforeStart = await extensionRunner.emitBeforeAgentStart(
          { messageType: "user", prompt: "", images: void 0 },
          { cwd: location.cwd, selectedTools: currentTools, sections: dynamicSections?.getSections() ?? {} }
        );
        if (beforeStart?.systemPromptOptions?.sections && dynamicSections) {
          dynamicSections.updateSections(beforeStart.systemPromptOptions.sections);
        }
      } catch (err) {
        report(err);
      }
    }
    syncToolsToRegistry();
  } catch (error) {
    report(error);
  }
  return {
    extensionRunner,
    cleanup: async () => {
      await extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }).catch((err) => console.warn("[ExtensionBridge] Cleanup session_shutdown:", err));
    }
  };
}

// src/runner/runtime-loader.ts
import { Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
function logRegError(kind, identifier, err) {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (!msg.includes("already registered") && !msg.includes("duplicate")) {
    console.warn(`[RuntimeLoader] Failed to register ${kind} '${identifier}': ${err instanceof Error ? err.message : String(err)}`);
  }
}
function registerPendingProviders(modelRuntime, runtime) {
  for (const { name, config } of runtime.pendingProviderRegistrations) {
    try {
      modelRuntime.registerProvider(name, config);
    } catch (err) {
      logRegError("provider", name, err);
    }
  }
  for (const { provider } of runtime.pendingNativeProviderRegistrations) {
    try {
      modelRuntime.registerNativeProvider(provider);
    } catch (err) {
      logRegError("native provider", provider?.id ?? "unknown", err);
    }
  }
  for (const { definition } of runtime.pendingVirtualModelRegistrations) {
    try {
      modelRuntime.registerVirtualModel(definition);
    } catch (err) {
      logRegError("virtual model", definition?.id ?? "unknown", err);
    }
  }
}
async function loadHarnessEnvironment(location, options, envs) {
  try {
    initTheme();
  } catch (err) {
    console.warn(`[RuntimeLoader] Theme initialization warning: ${err instanceof Error ? err.message : String(err)}`);
  }
  const modelRuntime = await ModelRuntime2.create();
  const settingsManager = SettingsManager2.create(location.cwd);
  const resourceLoader = new DefaultResourceLoader2({
    cwd: location.cwd,
    agentDir: getAgentDir2(),
    settingsManager,
    extensionFactories: createStandardExtensionFactories()
  });
  await resourceLoader.reload();
  const extensionsResult = resourceLoader.getExtensions();
  registerPendingProviders(modelRuntime, extensionsResult.runtime);
  configureHarnessHttp(settingsManager);
  let activeModelRef;
  const getActiveModel = () => {
    if (activeModelRef) return activeModelRef;
    const p = settingsManager.getDefaultProvider();
    const m = settingsManager.getDefaultModel();
    return p && m ? { provider: p, modelId: m } : void 0;
  };
  const dynamicSections = new DynamicPromptSections();
  const settings = createHarnessSettings(settingsManager, getActiveModel);
  const registry = await createCodingRegistry(settingsManager, location.cwd, {
    ...options.prompt,
    resourceLoader,
    dynamicSections
  });
  const pendingReports = [];
  const report = (error) => pendingReports.push(error);
  let liveNoticeForwarder;
  let runnerRef;
  const executeToolFn = createNestedToolExecutor(
    registry,
    () => runnerRef,
    () => envs.env({ cwd: location.cwd })
  );
  const mounted = await mountExtensionBridge(
    location,
    modelRuntime,
    extensionsResult,
    registry,
    executeToolFn,
    report,
    dynamicSections,
    (level, message) => {
      if (liveNoticeForwarder) {
        liveNoticeForwarder(level, message);
      } else {
        pendingReports.push({ kind: "notice", level, message });
      }
    },
    settingsManager
  );
  runnerRef = mounted.extensionRunner;
  const harness = await Harness.open(
    await openNodeSqliteStorage(location.database),
    { models: modelRuntime, registry, settings, env: envs.env, onReport: report },
    runtimeContext
  );
  const initial = location.created ? await findInitialAgentModel(settingsManager, modelRuntime, options.cli) : void 0;
  if (initial?.model) activeModelRef = initial.model;
  return {
    modelRuntime,
    settingsManager,
    harness,
    initialModelRef: initial?.model,
    initialThinkingLevel: initial?.thinkingLevel,
    fallbackMessage: initial?.fallbackMessage,
    pendingReports,
    getActiveModel,
    setActiveModelRef: (ref) => {
      activeModelRef = ref;
    },
    cleanup: mounted.cleanup,
    extensionRunner: mounted.extensionRunner,
    dynamicSections,
    setNoticeForwarder: (forwarder) => {
      liveNoticeForwarder = forwarder;
    }
  };
}

// src/runner/runtime.ts
async function loadSummaries(harness, rootId) {
  const label = (id) => id === rootId ? "main" : `subagent ${id}`;
  const summaries = [];
  let cursor;
  do {
    const page = await harness.commit((tx) => tx.scanConversations({}, 256, cursor), runtimeContext);
    for (const { id } of page.items) summaries.push({ id, label: label(id), ...await firstInput(harness, id) });
    cursor = page.next;
  } while (cursor !== void 0);
  return summaries;
}
async function openDurable(options = {}) {
  const location = await selectSession(options.cwd ?? process.cwd(), options.continueSession ?? false, options.session);
  const envs = new ExecutionEnvs(location.cwd);
  let harness;
  let envState;
  try {
    const activeEnvState = await loadHarnessEnvironment(location, options, envs);
    envState = activeEnvState;
    const { modelRuntime, settingsManager } = activeEnvState;
    harness = activeEnvState.harness;
    const root = await harness.root(runtimeContext, {
      agent: {
        cwd: location.cwd,
        ...activeEnvState.initialModelRef ? { model: activeEnvState.initialModelRef } : {},
        ...activeEnvState.initialThinkingLevel ? { thinkingLevel: activeEnvState.initialThinkingLevel } : {}
      }
    });
    if (!location.created) {
      const rootAgent = await root.agent(runtimeContext);
      if (rootAgent.model) activeEnvState.setActiveModelRef(rootAgent.model);
      if (options.cli !== void 0) {
        const cli = await findInitialAgentModel(settingsManager, modelRuntime, options.cli);
        if (cli.model) {
          activeEnvState.setActiveModelRef(cli.model);
          await root.configure({ model: cli.model, thinkingLevel: cli.thinkingLevel }, runtimeContext);
        } else if (cli.thinkingLevel !== void 0) {
          await root.configure({ thinkingLevel: cli.thinkingLevel }, runtimeContext);
        }
      }
    }
    const summaries = await loadSummaries(harness, root.id);
    let current = root;
    let conversation = await root.viewState(runtimeContext);
    const enabled = settingsManager.getEnabledModels();
    const scoped = enabled?.length ? await resolveModelScopeWithDiagnostics2(enabled, modelRuntime) : void 0;
    const scopedList = scoped?.scopedModels?.length ? scoped.scopedModels.map((sm) => sm.model) : modelRuntime.getAvailableSnapshot();
    const models = () => scopedList.map((m) => ({ provider: m.provider, modelId: m.id, name: m.name, contextWindow: m.contextWindow }));
    let state = {
      session: { id: location.id, directory: location.directory, cwd: location.cwd },
      conversation: conversation.value,
      conversations: summaries,
      models: models(),
      notices: []
    };
    const listeners = /* @__PURE__ */ new Set();
    let notifying = false;
    const update = (patch) => {
      state = { ...state, ...patch };
      if (notifying) return;
      notifying = true;
      setImmediate(() => {
        notifying = false;
        for (const listener of listeners) listener();
      });
    };
    let nextNotice = 1;
    const notice = (level, message) => {
      update({ notices: [...state.notices, { id: nextNotice++, level, message }].slice(-20) });
    };
    const fail = (err) => notice("error", err instanceof Error ? err.message : String(err));
    for (const report of activeEnvState.pendingReports) {
      if (report && typeof report === "object" && "kind" in report && report.kind === "notice") {
        const nr = report;
        notice(nr.level, nr.message);
      } else {
        notice("warning", report instanceof Error ? report.message : String(report));
      }
    }
    activeEnvState.setNoticeForwarder?.((level, message) => notice(level, message));
    let unsubscribeConversation = conversation.subscribe((val) => update({ conversation: val }));
    const unsubscribeCommits = harness.subscribeCommits((pub) => {
      let convs = state.conversations;
      for (const ch of pub.changes) {
        if (ch.type === "conversation") {
          convs = [...convs, { id: ch.value.id, label: ch.value.id === root.id ? "main" : `subagent ${ch.value.id}` }];
        } else if (ch.type === "entry" && ch.value.kind === "pi.user") {
          const id = ch.value.conversationId;
          convs = convs.map((s) => s.id === id && !s.title ? { ...s, ...titleOf(ch.value) } : s);
        }
      }
      if (convs !== state.conversations) update({ conversations: convs });
    });
    let tasks;
    let unsubscribeTasks = () => {
    };
    const closeTasks = () => {
      unsubscribeTasks();
      tasks?.dispose();
      tasks = void 0;
    };
    const opened = harness;
    const controller = createDurableController({
      getCurrent: () => current,
      setCurrent: (c) => {
        current = c;
      },
      getConversationState: () => conversation,
      setConversationState: (cs) => {
        conversation = cs;
      },
      getUnsubscribeConversation: () => unsubscribeConversation,
      setUnsubscribeConversation: (fn) => {
        unsubscribeConversation = fn;
      },
      opened,
      modelRuntime,
      getState: () => state,
      update,
      notice,
      fail,
      getTasks: () => tasks,
      setTasks: (t) => {
        tasks = t;
      },
      setUnsubscribeTasks: (fn) => {
        unsubscribeTasks = fn;
      },
      closeTasks,
      setActiveModelRef: (ref) => activeEnvState.setActiveModelRef(ref),
      extensionRunner: activeEnvState.extensionRunner,
      dynamicSections: activeEnvState.dynamicSections,
      cwd: location.cwd
    });
    const saved = agentOf(state.conversation).model;
    if (!saved) notice("warning", "No model configured; select one with /model.");
    else if (!modelRuntime.getModel(saved.provider, saved.modelId)) {
      notice("warning", `Saved model is unavailable: ${saved.provider}/${saved.modelId}`);
    }
    if (activeEnvState.fallbackMessage) notice("info", activeEnvState.fallbackMessage);
    await controller.toggleTasks();
    harness.resume();
    let closing;
    return {
      view: {
        current: () => state,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }
      },
      controller,
      settings: settingsManager,
      modelRuntime,
      harness,
      close() {
        return closing ??= (async () => {
          unsubscribeConversation();
          unsubscribeCommits();
          conversation.dispose();
          closeTasks();
          try {
            await opened.close(runtimeContext);
            await envs.cleanup(runtimeContext);
            await activeEnvState.cleanup?.();
          } finally {
            await location.release();
          }
        })();
      }
    };
  } catch (error) {
    await envState?.cleanup?.().catch((err) => console.warn("[DurableRuntime] Cleanup extension runner:", err));
    await harness?.close(runtimeContext).catch((err) => console.warn("[DurableRuntime] Cleanup harness:", err));
    await location.release().catch((err) => console.warn("[DurableRuntime] Cleanup location:", err));
    throw error;
  }
}

// src/runner/bridge/durable-contracts.ts
function isAgentDocument(doc) {
  return typeof doc === "object" && doc !== null;
}
function isUsageDocument(doc) {
  return typeof doc === "object" && doc !== null;
}
function isConversationEntryRecord(entry) {
  return typeof entry === "object" && entry !== null;
}

// src/runner/bridge/assistant-message-builder.ts
function extractCumulativeUsage(current) {
  const rawUsageDoc = current?.conversation?.docs?.["pi.usage"];
  if (!rawUsageDoc || typeof rawUsageDoc !== "object") {
    return void 0;
  }
  const usageDoc = rawUsageDoc;
  let totalTokens = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteInputTokens = 0;
  let hasUsage = false;
  const accumulate = (entry) => {
    if (!entry || typeof entry !== "object") return;
    const inTok = Number(entry.input ?? 0);
    const outTok = Number(entry.output ?? 0);
    const totTok = Number(entry.totalTokens ?? inTok + outTok);
    const cacheRead = Number(entry.cacheRead ?? 0);
    const cacheWrite = Number(entry.cacheWrite ?? 0);
    if (totTok > 0 || inTok > 0 || outTok > 0 || cacheRead > 0 || cacheWrite > 0) {
      hasUsage = true;
      totalTokens += totTok;
      inputTokens += inTok;
      outputTokens += outTok;
      cachedInputTokens += cacheRead;
      cacheWriteInputTokens += cacheWrite;
    }
  };
  if (usageDoc.models && typeof usageDoc.models === "object") {
    for (const modelUsage of Object.values(usageDoc.models)) {
      accumulate(modelUsage);
    }
  }
  if (usageDoc.tools && typeof usageDoc.tools === "object") {
    for (const toolUsage of Object.values(usageDoc.tools)) {
      accumulate(toolUsage);
    }
  }
  if (!hasUsage && (usageDoc.totalTokens != null || usageDoc.input != null || usageDoc.output != null)) {
    accumulate(usageDoc);
  }
  if (!hasUsage && totalTokens === 0) {
    return void 0;
  }
  return {
    totalTokens,
    inputTokens,
    outputTokens,
    ...cachedInputTokens > 0 ? { cachedInputTokens } : {},
    ...cacheWriteInputTokens > 0 ? { cacheWriteInputTokens } : {}
  };
}
function buildFinalAssistantMessage(current, lastGenerationText, lastThinkingText) {
  const entries = current.conversation.entries ?? [];
  const lastAssistantEntry = [...entries].reverse().find(
    (e) => isConversationEntryRecord(e) && e.kind === "pi.assistant"
  );
  const lastAssistantMsg = lastAssistantEntry?.model?.[0];
  if (lastAssistantMsg) {
    const content = Array.isArray(lastAssistantMsg.content) ? lastAssistantMsg.content : [{ type: "text", text: lastGenerationText }];
    const stopReason = typeof lastAssistantMsg.stopReason === "string" ? lastAssistantMsg.stopReason : "stop";
    const usage = typeof lastAssistantMsg.usage === "object" && lastAssistantMsg.usage !== null ? lastAssistantMsg.usage : void 0;
    return {
      role: "assistant",
      content,
      stopReason,
      usage
    };
  }
  const finalContent = [];
  if (lastThinkingText) {
    finalContent.push({ type: "thinking", thinking: lastThinkingText });
  }
  if (lastGenerationText) {
    finalContent.push({ type: "text", text: lastGenerationText });
  }
  const rawUsageDoc = current?.conversation?.docs?.["pi.usage"];
  const usageDoc = isUsageDocument(rawUsageDoc) ? rawUsageDoc : {};
  const cumUsage = extractCumulativeUsage(current);
  const inTok = cumUsage?.inputTokens ?? usageDoc.input;
  const outTok = cumUsage?.outputTokens ?? usageDoc.output;
  const cacheRead = cumUsage?.cachedInputTokens ?? usageDoc.cacheRead;
  const cacheWrite = cumUsage?.cacheWriteInputTokens ?? usageDoc.cacheWrite;
  const totalTokens = cumUsage?.totalTokens ?? usageDoc.totalTokens ?? (inTok ?? 0) + (outTok ?? 0);
  return {
    role: "assistant",
    content: finalContent.length > 0 ? finalContent : [{ type: "text", text: "" }],
    stopReason: "stop",
    usage: {
      input: inTok,
      output: outTok,
      cacheRead,
      cacheWrite,
      totalTokens,
      cost: usageDoc.cost
    }
  };
}

// src/runner/bridge/turn-summary.ts
function resolveTurnSummary(current, currentText, currentThinking, lastAssistantMessage, resolveContextWindow) {
  const tail = current?.conversation?.entries?.at(-1);
  const lastCheckpointId = tail?.id !== void 0 ? String(tail.id) : void 0;
  const finalMsg = lastAssistantMessage ?? buildFinalAssistantMessage(
    current,
    currentText,
    currentThinking
  );
  const rawAgentDoc = current?.conversation?.docs?.["pi.agent"];
  const agentDoc = isAgentDocument(rawAgentDoc) ? rawAgentDoc : {};
  const cw = resolveContextWindow?.(agentDoc.model?.provider, agentDoc.model?.modelId);
  const cumulativeUsage = extractCumulativeUsage(current);
  const entries = current?.conversation?.entries ?? [];
  const lastAssistantEntry = [...entries].reverse().find(
    (e) => isConversationEntryRecord(e) && e.kind === "pi.assistant"
  );
  const firstModelMsg = lastAssistantEntry?.model?.[0];
  const isLastAssistantAborted = Boolean(
    firstModelMsg && "stopReason" in firstModelMsg && firstModelMsg.stopReason === "aborted"
  );
  const isAborted = finalMsg.stopReason === "aborted" || isLastAssistantAborted;
  if (isAborted && finalMsg.stopReason !== "aborted") {
    finalMsg.stopReason = "aborted";
  }
  return { finalMsg, cw, cumulativeUsage, isAborted, lastCheckpointId };
}

// src/runner/bridge/bb-child-event-adapter.ts
var BBChildEventAdapter = class {
  output;
  parentRef;
  conversationId;
  currentText = "";
  currentThinking = "";
  isInThinking = false;
  constructor(output2, parentRef, conversationId) {
    this.output = output2;
    this.parentRef = parentRef;
    this.conversationId = conversationId;
  }
  closeThinkingIfNeeded() {
    if (!this.isInThinking) return;
    this.isInThinking = false;
    this.output({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: this.currentThinking },
      parentRef: this.parentRef,
      ...this.conversationId !== void 0 ? { conversationId: this.conversationId } : {}
    });
  }
  handleEvent(event, _current) {
    switch (event.type) {
      case "message_update": {
        for (const change of event.changes) {
          if (change.type === "thinking_delta") {
            this.isInThinking = true;
            this.currentThinking += change.delta;
            this.output({
              type: "message_update",
              assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: change.delta },
              parentRef: this.parentRef,
              ...this.conversationId !== void 0 ? { conversationId: this.conversationId } : {}
            });
          } else if (change.type === "text_delta") {
            this.closeThinkingIfNeeded();
            this.currentText += change.delta;
            this.output({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: change.delta },
              parentRef: this.parentRef,
              ...this.conversationId !== void 0 ? { conversationId: this.conversationId } : {}
            });
          }
        }
        break;
      }
      case "tool_execution_start": {
        this.closeThinkingIfNeeded();
        this.output({
          type: "tool_execution_start",
          toolCallId: `${this.parentRef}:${event.toolCallId}`,
          toolName: event.toolName,
          args: event.args ?? {},
          parentRef: this.parentRef,
          ...this.conversationId !== void 0 ? { conversationId: this.conversationId } : {}
        });
        break;
      }
      case "tool_execution_update": {
        const update = buildToolExecutionUpdate(
          { ...event, toolCallId: `${this.parentRef}:${event.toolCallId}` },
          this.parentRef
        );
        if (update) {
          this.output({
            ...update,
            ...this.conversationId !== void 0 ? { conversationId: this.conversationId } : {}
          });
        }
        break;
      }
      case "tool_execution_end": {
        const end = buildToolExecutionEnd(
          { ...event, toolCallId: `${this.parentRef}:${event.toolCallId}` },
          this.parentRef
        );
        this.output({
          ...end,
          ...this.conversationId !== void 0 ? { conversationId: this.conversationId } : {}
        });
        break;
      }
      case "message_end": {
        this.closeThinkingIfNeeded();
        break;
      }
      case "run_end": {
        this.closeThinkingIfNeeded();
        this.output({
          type: "agent_end",
          messages: [],
          parentRef: this.parentRef,
          ...this.conversationId !== void 0 ? { conversationId: this.conversationId } : {}
        });
        break;
      }
      // Subagent lifecycle events are scoped to the child task and must not break parent turn
      case "message_start":
      case "run_start":
      case "turn_start":
      case "turn_end":
      case "snapshot":
      case "compaction_start":
      case "compaction_end":
      case "auto_retry_start":
      case "auto_retry_end":
      default:
        break;
    }
  }
};

// src/runner/bridge/bb-event-adapter.ts
var BBEventAdapter = class {
  output;
  resolveContextWindow;
  lastAssistantMessage;
  lastCheckpointId;
  currentText = "";
  currentThinking = "";
  isInThinking = false;
  constructor(output2, resolveContextWindow) {
    this.output = output2;
    this.resolveContextWindow = resolveContextWindow;
  }
  closeThinkingIfNeeded() {
    if (!this.isInThinking) return;
    this.isInThinking = false;
    this.output({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: this.currentThinking } });
  }
  createChildAdapter(parentCallId, conversationId) {
    return new BBChildEventAdapter(this.output, parentCallId, conversationId);
  }
  emitTerminal(type, current) {
    this.closeThinkingIfNeeded();
    const summary = resolveTurnSummary(
      current,
      this.currentText,
      this.currentThinking,
      this.lastAssistantMessage,
      this.resolveContextWindow
    );
    if (summary.lastCheckpointId) {
      this.lastCheckpointId = summary.lastCheckpointId;
    }
    const base = {
      contextWindow: summary.cw,
      ...this.lastCheckpointId ? { providerCheckpointId: this.lastCheckpointId } : {},
      ...summary.cumulativeUsage ? { cumulativeUsage: summary.cumulativeUsage } : {},
      ...summary.isAborted ? { aborted: true, stopReason: "aborted" } : {}
    };
    if (type === "turn_end") {
      this.output({ type: "turn_end", message: summary.finalMsg, ...base });
    } else {
      this.output({ type: "agent_end", messages: [summary.finalMsg], ...base });
    }
  }
  handleEvent(event, current) {
    switch (event.type) {
      case "snapshot": {
        const snapWithView = event;
        const entries = snapWithView.view?.conversation?.entries ?? event.entries ?? current?.conversation?.entries;
        const tail = entries?.at(-1);
        if (tail?.id !== void 0) {
          this.lastCheckpointId = String(tail.id);
        }
        break;
      }
      case "run_start": {
        this.currentText = "";
        this.currentThinking = "";
        this.isInThinking = false;
        this.lastAssistantMessage = void 0;
        this.output({ type: "agent_start" });
        break;
      }
      case "turn_start": {
        this.output({ type: "turn_start" });
        break;
      }
      case "message_update": {
        for (const change of event.changes) {
          if (change.type === "thinking_delta") {
            this.isInThinking = true;
            this.currentThinking += change.delta;
            this.output({
              type: "message_update",
              assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: change.delta }
            });
          } else if (change.type === "text_delta") {
            this.closeThinkingIfNeeded();
            this.currentText += change.delta;
            this.output({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: change.delta }
            });
          }
        }
        break;
      }
      case "tool_execution_start": {
        this.closeThinkingIfNeeded();
        this.output({
          type: "tool_execution_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args ?? {},
          ...event.parentToolCallId !== void 0 ? { parentRef: event.parentToolCallId } : {}
        });
        break;
      }
      case "tool_execution_update": {
        const update = buildToolExecutionUpdate(event, event.parentToolCallId);
        if (update) this.output(update);
        break;
      }
      case "tool_execution_end": {
        this.output(buildToolExecutionEnd(event, event.parentToolCallId));
        break;
      }
      case "message_end": {
        this.closeThinkingIfNeeded();
        const modelItem = event.entry?.model?.[0];
        const msg = typeof modelItem === "object" && modelItem !== null ? modelItem : void 0;
        if (msg?.role === "assistant") {
          this.lastAssistantMessage = {
            role: "assistant",
            content: msg.content ?? [{ type: "text", text: this.currentText }],
            stopReason: msg.stopReason ?? "stop",
            usage: msg.usage
          };
          this.output({ type: "message_end", message: this.lastAssistantMessage });
        }
        break;
      }
      case "compaction_start":
        this.output({ type: "compaction_start", reason: event.reason === "threshold" ? "threshold" : "manual" });
        break;
      case "compaction_end":
        this.output({ type: "compaction_end", reason: event.reason === "threshold" ? "threshold" : "manual", aborted: false });
        break;
      case "turn_end":
        this.emitTerminal("turn_end", current);
        break;
      case "run_end":
        this.emitTerminal("agent_end", current);
        break;
      case "auto_retry_start":
        this.output({
          type: "auto_retry_start",
          attempt: event.attempt,
          ...event.at !== void 0 ? { at: event.at } : {},
          ...event.errorMessage ? { errorMessage: event.errorMessage } : {}
        });
        break;
      case "auto_retry_end":
        this.output({ type: "auto_retry_end", attempt: event.attempt });
        break;
    }
  }
};

// src/runner/cli-args.ts
function parseCliArgs(argv2) {
  const args2 = {};
  for (let i = 0; i < argv2.length; i++) {
    const arg = argv2[i];
    if (arg === "--mode" && i + 1 < argv2.length) args2.mode = argv2[++i];
    else if (arg === "--session" && i + 1 < argv2.length) args2.session = argv2[++i];
    else if (arg === "--session-dir" && i + 1 < argv2.length) args2.sessionDir = argv2[++i];
    else if (arg === "--continue") args2.continueSession = true;
    else if (arg === "--no-session") args2.noSession = true;
    else if (arg === "--provider" && i + 1 < argv2.length) args2.provider = argv2[++i];
    else if (arg === "--model" && i + 1 < argv2.length) args2.model = argv2[++i];
    else if (arg === "--thinking" && i + 1 < argv2.length) args2.thinking = argv2[++i];
    else if (arg === "--system-prompt" && i + 1 < argv2.length) args2.systemPromptPath = argv2[++i];
    else if (arg === "--append-system-prompt" && i + 1 < argv2.length) args2.appendSystemPromptPath = argv2[++i];
    else if (arg === "--cwd" && i + 1 < argv2.length) args2.cwd = argv2[++i];
    else if (arg === "--extension" && i + 1 < argv2.length) args2.extension = argv2[++i];
    else if (arg.startsWith("-")) {
      if (i + 1 < argv2.length && !argv2[i + 1].startsWith("-")) {
        i++;
      }
    } else if (!args2.cwd) {
      args2.cwd = arg;
    }
  }
  return args2;
}

// src/runner/session-commands.ts
import { ROOT_CONVERSATION_ID as ROOT_CONVERSATION_ID2 } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as BACKGROUND_CONTEXT2 } from "@earendil-works/chord/context";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
function parseConversationId(id) {
  if (id === void 0 || id === null) return ROOT_CONVERSATION_ID2;
  const trimmed = typeof id === "string" ? id.trim() : id;
  if (trimmed === "") {
    throw new Error(`Invalid conversationId: ${String(id)}`);
  }
  const num = typeof trimmed === "number" ? trimmed : Number(trimmed);
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error(`Invalid conversationId: ${String(id)}`);
  }
  return num;
}
async function handleActiveSessionCommand(cmd, durable, modelRuntime, args2, respond) {
  switch (cmd.type) {
    case "prompt": {
      if (!cmd.message) {
        respond.error(cmd.id, "prompt", "Missing message");
        return;
      }
      respond.success(cmd.id, "prompt");
      const behavior = cmd.streamingBehavior || "followUp";
      const targetId = parseConversationId(cmd.conversationId);
      if (targetId !== ROOT_CONVERSATION_ID2) {
        const conv = await durable.harness.conversation(targetId, BACKGROUND_CONTEXT2);
        if (!conv) {
          throw new Error(`Conversation not found: ${cmd.conversationId}`);
        }
        await conv.submit({ type: "input", content: cmd.message, whenBusy: behavior }, BACKGROUND_CONTEXT2);
      } else {
        await durable.controller.submit(cmd.message, behavior);
      }
      break;
    }
    case "steer": {
      if (!cmd.message) {
        respond.error(cmd.id, "steer", "Missing message");
        return;
      }
      respond.success(cmd.id, "steer");
      const targetId = parseConversationId(cmd.conversationId);
      if (targetId !== ROOT_CONVERSATION_ID2) {
        const conv = await durable.harness.conversation(targetId, BACKGROUND_CONTEXT2);
        if (!conv) {
          throw new Error(`Conversation not found: ${cmd.conversationId}`);
        }
        await conv.submit({ type: "input", content: cmd.message, whenBusy: "steer" }, BACKGROUND_CONTEXT2);
      } else {
        await durable.controller.submit(cmd.message, "steer");
      }
      break;
    }
    case "abort": {
      const targetId = parseConversationId(cmd.conversationId);
      if (targetId !== ROOT_CONVERSATION_ID2) {
        const conv = await durable.harness.conversation(targetId, BACKGROUND_CONTEXT2);
        if (conv) {
          await conv.abort(BACKGROUND_CONTEXT2);
        }
      } else {
        await durable.controller.abort();
      }
      respond.success(cmd.id, "abort");
      break;
    }
    case "compact": {
      await durable.controller.compact(cmd.instructions);
      respond.success(cmd.id, "compact");
      break;
    }
    case "get_state": {
      const current = durable.view.current();
      const agentDoc = current.conversation.docs["pi.agent"] ?? {};
      const modelObj = agentDoc.model ? {
        provider: agentDoc.model.provider,
        id: agentDoc.model.id ?? agentDoc.model.modelId,
        modelId: agentDoc.model.modelId ?? agentDoc.model.id
      } : null;
      respond.success(cmd.id, "get_state", {
        model: modelObj,
        thinkingLevel: agentDoc.thinkingLevel ?? "none",
        cwd: args2.cwd ?? process.cwd(),
        sessionId: args2.session ?? "default"
      });
      break;
    }
    case "get_available_models": {
      const currentModels = modelRuntime.getAvailableSnapshot();
      respond.success(cmd.id, "get_available_models", { models: currentModels });
      break;
    }
    case "set_model": {
      if (!cmd.provider || !cmd.modelId) {
        respond.error(cmd.id, "set_model", "Missing provider or modelId");
        return;
      }
      await durable.controller.setModel({ provider: cmd.provider, modelId: cmd.modelId });
      respond.success(cmd.id, "set_model");
      break;
    }
    case "set_thinking_level": {
      if (!cmd.level) {
        respond.error(cmd.id, "set_thinking_level", "Missing thinking level");
        return;
      }
      await durable.controller.setThinkingLevel(cmd.level);
      respond.success(cmd.id, "set_thinking_level");
      break;
    }
    case "get_session_stats": {
      const current = durable.view.current();
      const agentDoc = current.conversation.docs["pi.agent"] ?? {};
      let contextWindow = 128e3;
      const provider = agentDoc.model?.provider ?? args2.provider;
      const modelId = agentDoc.model?.modelId ?? args2.model;
      if (provider && modelId) {
        const m = modelRuntime.getModel(provider, modelId);
        if (m?.contextWindow) contextWindow = m.contextWindow;
      }
      let tokens = null;
      try {
        const conv = await durable.harness.conversation(ROOT_CONVERSATION_ID2, BACKGROUND_CONTEXT2);
        if (conv) {
          const ctxView = await conv.context(BACKGROUND_CONTEXT2);
          const estimate = estimateContextTokens(ctxView.messages);
          tokens = estimate.tokens;
        }
      } catch (err) {
        console.error(`Error estimating context tokens: ${err}`);
      }
      respond.success(cmd.id, "get_session_stats", {
        contextUsage: {
          tokens,
          contextWindow
        }
      });
      break;
    }
    default: {
      respond.error(cmd.id, cmd.type ?? "unknown", `Unknown command: ${cmd.type}`);
      break;
    }
  }
}

// src/runner/version.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join as join2 } from "node:path";
import { fileURLToPath } from "node:url";
var esmRequire = createRequire(import.meta.url);
var currentDir = dirname(fileURLToPath(import.meta.url));
function getPiDurableVersion() {
  try {
    const durablePkg = esmRequire.resolve("@earendil-works/pi-durable/package.json");
    if (existsSync2(durablePkg)) {
      const parsed = JSON.parse(readFileSync2(durablePkg, "utf8"));
      if (parsed.version) return parsed.version;
    }
  } catch (err) {
    const code = err?.code;
    if (code !== "MODULE_NOT_FOUND" && code !== "ENOENT") {
      console.warn(`[Version] Failed to resolve durable package: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    const pluginPkg = join2(currentDir, "..", "..", "package.json");
    if (existsSync2(pluginPkg)) {
      const parsed = JSON.parse(readFileSync2(pluginPkg, "utf8"));
      const dep = parsed.dependencies?.["@earendil-works/pi-durable"]?.replace(/^[\^~]/, "");
      if (dep) return dep;
    }
  } catch (err) {
    const code = err?.code;
    if (code !== "ENOENT") {
      console.warn(`[Version] Failed to read plugin package: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return "1.0.0";
}

// src/runner/bridge-channel.ts
import { Socket } from "node:net";
import { writeSync } from "node:fs";
var CHILD_TO_BRIDGE_FD = 3;
var BRIDGE_TO_CHILD_FD = 4;
function createBridgeSender() {
  return (msg) => {
    const str = `${JSON.stringify(msg)}
`;
    try {
      writeSync(CHILD_TO_BRIDGE_FD, Buffer.from(str, "utf8"));
    } catch (err) {
      const code = err?.code;
      if (code !== "EBADF") {
        console.warn(`[BridgeChannel] FD ${CHILD_TO_BRIDGE_FD} write warning: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
}
function initBridgeInboundChannel(modelScope, sendToBridge2) {
  try {
    const bridgeIn = new Socket({ fd: BRIDGE_TO_CHILD_FD, readable: true, writable: false });
    bridgeIn.on("error", (err) => {
      const code = err?.code;
      if (code !== "EBADF") {
        console.warn(`[BridgeChannel] Inbound socket warning: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    bridgeIn.unref();
    attachJsonlLineReader(bridgeIn, (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const req = JSON.parse(trimmed);
        if (req.kind === "request") {
          if (req.method === "model-scope") {
            sendToBridge2({ kind: "reply", id: req.id, result: modelScope });
          } else if (req.method === "refresh-models") {
            sendToBridge2({ kind: "reply", id: req.id, result: { refreshed: true } });
          } else if (req.method === "leaf") {
            sendToBridge2({ kind: "reply", id: req.id, result: { leafId: null } });
          } else {
            sendToBridge2({ kind: "reply", id: req.id, result: {} });
          }
        }
      } catch (err) {
        console.error("[Runner] Failed to parse or process bridge channel message:", err);
      }
    });
  } catch (err) {
    const code = err?.code;
    if (code !== "EBADF") {
      console.warn(`[BridgeChannel] Inbound channel setup notice: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// src/runner/subagent-watcher.ts
import {
  ROOT_CONVERSATION_ID as ROOT_CONVERSATION_ID3,
  watchEvents
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as BACKGROUND_CONTEXT3 } from "@earendil-works/chord/context";
function extractChildConversationId(event) {
  if (event.type === "tool_execution_update") {
    const details = event.details;
    return details?.conversationId;
  }
  if (event.type === "tool_execution_end") {
    const entryData = typeof event.entry === "object" && event.entry !== null && "data" in event.entry ? event.entry.data : void 0;
    return entryData?.conversationId;
  }
  return void 0;
}
async function startSubagentWatcher(harness, adapter, getCurrentView) {
  const attached = /* @__PURE__ */ new Set();
  const activeStreams = /* @__PURE__ */ new Map();
  const attach = async (conversationId, parentCallId) => {
    if (attached.has(conversationId)) return;
    attached.add(conversationId);
    const isChild = parentCallId !== void 0;
    const childAdapter = isChild ? adapter.createChildAdapter(parentCallId, conversationId) : void 0;
    try {
      const stream = await watchEvents(harness, conversationId, BACKGROUND_CONTEXT3);
      activeStreams.set(conversationId, stream);
      stream.start(async (batch) => {
        try {
          const view = getCurrentView();
          for (const event of batch) {
            if (childAdapter) {
              childAdapter.handleEvent(event, view);
            } else {
              adapter.handleEvent(event, view);
            }
            const childId = extractChildConversationId(event);
            if (childId !== void 0 && !attached.has(childId)) {
              const callId = "toolCallId" in event ? isChild ? `${parentCallId}:${String(event.toolCallId)}` : String(event.toolCallId) : parentCallId ?? "subagent";
              void attach(childId, callId);
            }
          }
        } catch (err) {
          console.error(`[SubagentWatcher] Batch handling error for conversation ${conversationId}:`, err);
        }
      });
    } catch (err) {
      console.error(`[SubagentWatcher] Failed to attach stream for conversation ${conversationId}:`, err);
    }
  };
  await attach(ROOT_CONVERSATION_ID3);
  return {
    close: () => {
      for (const stream of activeStreams.values()) {
        try {
          stream.stop();
        } catch (err) {
          console.warn(`[SubagentWatcher] Stream stop warning: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      activeStreams.clear();
      attached.clear();
    }
  };
}

// src/runner/index.ts
var argv = process.argv.slice(2);
if (argv.includes("--version") || argv.includes("-v")) {
  console.log(getPiDurableVersion());
  process.exit(0);
}
var args = parseCliArgs(argv);
function output(data) {
  process.stdout.write(serializeJsonLine(data));
}
var sendToBridge = createBridgeSender();
async function main() {
  let activeDurable = null;
  let activeWatcher = null;
  let isTerminating = false;
  const handleExit = async (signalOrReason) => {
    if (isTerminating) return;
    isTerminating = true;
    if (activeWatcher) {
      try {
        activeWatcher.close();
      } catch (err) {
        console.warn(`[Runner] Error closing subagent watcher on ${signalOrReason}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (activeDurable) {
      try {
        await activeDurable.close();
      } catch (err) {
        console.error(`[Runner] Error releasing durable lock on ${signalOrReason}:`, err);
      }
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => {
    void handleExit("SIGTERM");
  });
  process.on("SIGINT", () => {
    void handleExit("SIGINT");
  });
  process.stdin.on("end", () => {
    void handleExit("stdin.end");
  });
  const cwd = args.cwd ?? process.cwd();
  const {
    modelRuntime,
    scopedModelList,
    defaultModel,
    defaultThinkingLevel,
    modelScope
  } = await setupRunnerModels(cwd, args);
  sendToBridge({ kind: "model-scope", ...modelScope });
  initBridgeInboundChannel(modelScope, sendToBridge);
  const success = (id, command, data) => {
    output({ id, type: "response", command, success: true, data });
  };
  const error = (id, command, message) => {
    output({ id, type: "response", command, success: false, error: message });
  };
  if (args.noSession) {
    sendToBridge({ ready: true, kind: "ready" });
    attachJsonlLineReader(process.stdin, (line) => {
      if (!line.trim()) return;
      try {
        const cmd = JSON.parse(line);
        if (cmd.type === "get_available_models") {
          success(cmd.id, "get_available_models", { models: scopedModelList });
        } else if (cmd.type === "get_state") {
          success(cmd.id, "get_state", {
            model: defaultModel ? { provider: defaultModel.provider, id: defaultModel.id, modelId: defaultModel.id } : null,
            thinkingLevel: defaultThinkingLevel,
            isStreaming: false,
            isCompacting: false,
            steeringMode: "one-at-a-time",
            followUpMode: "one-at-a-time",
            sessionId: "catalog",
            autoCompactionEnabled: true,
            messageCount: 0,
            pendingMessageCount: 0
          });
        } else {
          success(cmd.id, cmd.type, {});
        }
      } catch (err) {
        error(void 0, "unknown", err instanceof Error ? err.message : String(err));
      }
    });
    return;
  }
  const durableOptions = {
    cwd: args.cwd,
    continueSession: args.continueSession,
    session: args.session,
    cli: args.model ? { provider: args.provider, model: args.model, thinking: args.thinking } : void 0,
    prompt: {
      systemPromptPath: args.systemPromptPath,
      appendSystemPromptPath: args.appendSystemPromptPath
    }
  };
  const durable = await openDurable(durableOptions);
  activeDurable = durable;
  const adapter = new BBEventAdapter(
    (evt) => output(evt),
    (provider, modelId) => {
      const p = provider ?? args.provider;
      const m = modelId ?? args.model;
      return p && m ? modelRuntime.getModel(p, m)?.contextWindow : void 0;
    }
  );
  const watcher = await startSubagentWatcher(durable.harness, adapter, () => durable.view.current());
  activeWatcher = watcher;
  attachJsonlLineReader(process.stdin, async (line) => {
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch (e) {
      error(void 0, "parse", `Invalid JSON: ${e}`);
      return;
    }
    try {
      await handleActiveSessionCommand(cmd, durable, modelRuntime, args, { success, error });
    } catch (err) {
      error(cmd.id, cmd.type ?? "unknown", err instanceof Error ? err.message : String(err));
    }
  });
  sendToBridge({ ready: true, kind: "ready" });
}
main().catch((err) => {
  console.error(`Runner fatal error: ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
//# sourceMappingURL=index.js.map
