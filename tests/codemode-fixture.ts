import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
	createCodemodeExtension,
	ModelRuntime,
	type Extension,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { setupExtensionRunner } from "../src/runner/extension-bridge.ts";
import { createNestedToolExecutor } from "../src/runner/extension-mount.ts";
import { adaptExtensionTool, installExtensionTools } from "../src/runner/tool-adapter.ts";

export interface CodemodeHarness {
	runner: any;
	codemodeTool: any;
	env: NodeExecutionEnv;
	tmpDir: string;
	ctx: any;
	execCode: (code: string, callId?: string) => Promise<{
		content: any[];
		text: string;
		isError: boolean;
		details: any;
		raw: any;
	}>;
	cleanup: () => Promise<void>;
}

export async function createCodemodeTestHarness(): Promise<CodemodeHarness> {
	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codemode-coverage-"));
	const env = new NodeExecutionEnv({ cwd: tmpDir });
	const registry = createRegistry();
	registry.install(CodingTools);

	let runner: any;
	const executeToolFn = createNestedToolExecutor(registry, () => runner, () => env);

	const syncToolsToRegistry = () => {
		const createToolContext = (callId: string) => runner.createToolContext(callId, undefined);
		const adapted = runner.getAllRegisteredTools().map((t: any) =>
			adaptExtensionTool(t.definition, executeToolFn, createToolContext, () => runner),
		);
		installExtensionTools(registry, adapted);
	};

	const mockMcpToolDef: ToolDefinition = {
		name: "mcp__test__greet",
		description: "Greet a user by name",
		parameters: Type.Object({ name: Type.String() }),
		exposure: "codemode",
		namespace: { name: "mcp__test", description: "Mock test service" },
		execute: async (_callId, params: any) => ({
			content: [{ type: "text", text: `Hello, ${params.name}!` }],
		}),
	};

	const mockMcpExt: Extension = {
		name: "mock-mcp-service",
		path: "inline:mock-mcp-service",
		tools: new Map([["mcp__test__greet", { definition: mockMcpToolDef, sourceInfo: { path: "mock" } as any }]]),
		handlers: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
		commands: new Map(),
	} as any;

	const codemodeFactory = createCodemodeExtension({ mode: "on" });
	const codemodeExt: Extension = {
		name: "codemode",
		path: "inline:codemode",
		tools: new Map(),
		handlers: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
		commands: new Map(),
	} as any;

	codemodeFactory({
		registerTool: (def: any) => {
			codemodeExt.tools.set(def.name, { definition: def, sourceInfo: { path: "codemode" } as any });
		},
		registerCommand: () => {},
		registerShortcut: () => {},
		registerToolRenderer: () => {},
		on: () => {},
		appendEntry: (type: string, data: any) => runner.runtime.appendEntry(type, data),
		sendMessage: () => {},
		sendUserMessage: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		getActiveTools: () => ["codemode", "bash", "read", "write", "edit", "mcp__test__greet"],
		getAllTools: () => runner?.getAllRegisteredTools().map((t: any) => ({
			name: t.definition.name,
			description: t.definition.description,
			parameters: t.definition.parameters,
			promptGuidelines: t.definition.promptGuidelines,
			exposure: t.definition.exposure,
			namespace: t.definition.namespace,
			annotations: t.definition.annotations,
			sourceInfo: t.sourceInfo,
		})) ?? [],
		getSettings: () => ({}),
		setActiveTools: () => {},
		refreshTools: () => syncToolsToRegistry(),
	} as any);

	runner = await setupExtensionRunner({
		extensions: [codemodeExt, mockMcpExt],
		runtime: {
			pendingProviderRegistrations: [],
			pendingNativeProviderRegistrations: [],
			pendingVirtualModelRegistrations: [],
			flagValues: new Map(),
			mcpServers: { list: () => [], setChangeListener: () => {} },
			invalidate: () => {},
		} as any,
		cwd: tmpDir,
		modelRuntime: await ModelRuntime.create(),
		executeToolFn,
		getCallableTools: () => {
			const map = new Map<string, any>();
			for (const t of registry.snapshot().tools()) {
				map.set(t.tool.name, {
					name: t.tool.name,
					description: (t.tool as any).description ?? "",
					parameters: t.tool.parameters,
				});
			}
			for (const t of runner?.getAllRegisteredTools() ?? []) {
				map.set(t.definition.name, { ...t.definition, sourceInfo: t.sourceInfo });
			}
			return Array.from(map.values());
		},
		onToolsChanged: syncToolsToRegistry,
	});

	syncToolsToRegistry();

	const codemodeTool = runner.getAllRegisteredTools().find((t: any) => t.definition.name === "codemode");
	const ctx = runner.createToolContext("harness-call-id", undefined);

	let callCounter = 0;
	const execCode = async (code: string, callId?: string) => {
		const id = callId ?? `exec-${++callCounter}`;
		const raw = await codemodeTool.definition.execute(id, { code }, undefined, () => {}, ctx);
		const content = raw.content ?? [];
		const text = content.map((c: any) => c.text ?? "").join("\n");
		return {
			content,
			text,
			isError: !!raw.isError,
			details: raw.details,
			raw,
		};
	};

	const cleanup = async () => {
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		await env.cleanup(BACKGROUND_CONTEXT);
		await fs.rm(tmpDir, { recursive: true, force: true });
	};

	return { runner, codemodeTool, env, tmpDir, ctx, execCode, cleanup };
}
