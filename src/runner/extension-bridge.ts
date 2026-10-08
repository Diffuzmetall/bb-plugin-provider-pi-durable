import type { JsonValue } from "@earendil-works/chord";
import type { JsonObject } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	ExtensionRunner,
	ModelRegistry,
	SessionManager,
	type Extension,
	type ExtensionFactory,
	type ExtensionActions,
	type ExtensionContextActions,
	type ExtensionRuntime,
	type ExtensionToolContext,
	type ModelRuntime,
	type SessionStartEvent,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { defineExtension, defineTool, type Registry, type ToolRegistration } from "@earendil-works/pi-durable";

export type NestedToolExecutor = (
	callerId: string,
	name: string,
	args: unknown,
	options?: { signal?: AbortSignal },
) => Promise<{
	toolCall: { type: "toolCall"; id: string; name: string; arguments: JsonObject };
	result: { content: Array<{ type: "text"; text: string }>; details: unknown };
	isError: boolean;
}>;

/** Safe type guard checking whether an object has an output stream function. */
export function hasOutput(api: unknown): api is { output(text: string): void } {
	return (
		typeof api === "object" &&
		api !== null &&
		"output" in api &&
		typeof (api as { output: unknown }).output === "function"
	);
}

/** Nico's detached coordinator cannot infer its SDK host from a Durable runner argv. */
export function configureSubagentHost(env: NodeJS.ProcessEnv = process.env): void {
	const key = "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT";
	if (!env[key]?.trim()) {
		env[key] = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
	}
}

/** Returns the standard built-in extension factories provided by Pi. */
export function createStandardExtensionFactories(): ExtensionFactory[] {
	return [createCodemodeExtension({ mode: "auto" }), createToolSearchExtension(), createMcpExtension()];
}

/** Adapts an extension ToolDefinition to a Durable ToolRegistration without type escape hatches. */
export function adaptExtensionTool(
	toolDef: ToolDefinition,
	executeToolFn: NestedToolExecutor,
	createToolContext?: (callId: string) => ExtensionToolContext,
): ToolRegistration {
	return defineTool({
		name: toolDef.name,
		description: toolDef.description,
		parameters: toolDef.parameters,
		async execute(args, api) {
			const ctx = createToolContext
				? createToolContext(api.callId)
				: ({
						tools: [],
						executeTool: async (name: string, nestedArgs: unknown, options?: { signal?: AbortSignal }) =>
							executeToolFn(api.callId, name, nestedArgs, options),
					} as ExtensionToolContext);

			const result = await toolDef.execute(
				api.callId,
				args,
				undefined,
				(update) => {
					if (update?.content && hasOutput(api)) {
						const textChunks = update.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("");
						if (textChunks.length > 0) api.output(textChunks);
					}
				},
				ctx,
			);

			return {
				content: result.content,
				isError: result.isError,
				details: (result.details ?? undefined) as JsonValue | undefined,
			};
		},
	});
}

/** Installs adapted tools as a dynamic extension into the Durable Registry. */
export function installExtensionTools(registry: Registry, tools: ToolRegistration[]): void {
	if (tools.length === 0) return;
	registry.install(defineExtension({ name: "extension-tools", tools }));
}

export interface SetupExtensionRunnerOptions {
	extensions: Extension[];
	runtime: ExtensionRuntime;
	cwd: string;
	sessionId?: string;
	sessionReason?: SessionStartEvent["reason"];
	modelRuntime: ModelRuntime;
	executeToolFn: NestedToolExecutor;
	getCallableTools?: () => AgentTool[];
	onToolsChanged?: () => void;
	/** Live host callbacks, resolved at call time rather than captured at startup. */
	actions?: Partial<ExtensionActions>;
	contextActions?: Partial<ExtensionContextActions>;
}

/** Initializes ExtensionRunner and binds actions and nested tool execution. */
export async function setupExtensionRunner(options: SetupExtensionRunnerOptions): Promise<ExtensionRunner> {
	// SQLite owns persistence; the Pi facade must not manufacture a second JSONL session.
	const sessionManager = SessionManager.inMemory(options.cwd, { id: options.sessionId });
	const modelRegistry = new ModelRegistry(options.modelRuntime);
	const runner = new ExtensionRunner(options.extensions, options.runtime, options.cwd, sessionManager, modelRegistry);

	const unsupported = (operation: string): never => {
		throw new Error(`Pi Durable extension operation is not available: ${operation}`);
	};

	runner.bindCore(
		{
			// Preserve loader stubs for unsupported actions instead of replacing them with undefined.
			...options.runtime,
			setSessionName: (name) => { sessionManager.appendSessionInfo(name); },
			getSessionName: () => sessionManager.getSessionName(),
			setLabel: (entryId, label) => { sessionManager.appendLabelChange(entryId, label); },
			getActiveTools: () => [],
			getAllTools: () => [],
			getSettings: () => ({}),
			refreshTools: () => {
				options.onToolsChanged?.();
			},
			...options.actions,
			appendEntry: (customType, data) => {
				options.actions?.appendEntry?.(customType, data);
				sessionManager.appendCustomEntry(customType, data);
			},
		},
		{
			getModel: () => undefined,
			getScopedModels: () => [],
			isIdle: () => true,
			getSignal: () => undefined,
			abort: () => unsupported("abort before session binding"),
			hasPendingMessages: () => false,
			shutdown: () => unsupported("shutdown"),
			getContextUsage: () => undefined,
			compact: () => unsupported("compact before session binding"),
			isProjectTrusted: () => true,
			executeTool: (callerId, name, args, opts) => options.executeToolFn(callerId, name, args, opts),
			getCallableTools: () =>
				options.getCallableTools
					? options.getCallableTools()
					: runner.getAllRegisteredTools().map((t) => ({
							...t.definition,
							execute: (callId, args, signal, onUpdate) =>
								t.definition.execute(callId, args, signal, onUpdate, runner.createToolContext(callId, signal)),
						})),
			getSystemPrompt: () => "",
			...options.contextActions,
		},
	);

	await runner.emit({ type: "session_start", reason: options.sessionReason ?? "new" });
	return runner;
}
