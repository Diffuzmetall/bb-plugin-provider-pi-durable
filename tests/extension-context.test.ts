import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createExtensionRuntime, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { setupExtensionRunner } from "../src/runner/extension-bridge.ts";

describe("Durable extension host contract", () => {
	it("binds live model context and preserves callable extension actions", async () => {
		const runtime = createExtensionRuntime();
		const modelRuntime = await ModelRuntime.create();
		const available = modelRuntime.getAvailableSnapshot();
		let selected = available[0];
		assert.ok(selected, "the SDK must supply models for this regression test");
		const runner = await setupExtensionRunner({
			extensions: [], runtime, modelRuntime, cwd: process.cwd(),
			executeToolFn: async () => { throw new Error("unused nested executor"); },
			contextActions: { getModel: () => selected },
		});
		const ctx = runner.createToolContext("subagent-list", undefined);
		assert.equal(ctx.model, selected);
		selected = available.find((model) => model !== selected)!;
		assert.ok(selected, "the SDK must supply a second model");
		assert.equal(ctx.model, selected, "current model must not be frozen at startup");
		assert.deepEqual(ctx.scopedModels, []);
		assert.equal(ctx.isIdle(), true);
		assert.equal(ctx.hasPendingMessages(), false);
		assert.equal(ctx.getContextUsage(), undefined);
		for (const name of ["appendEntry", "sendMessage", "sendUserMessage", "getThinkingLevel", "setModel"] as const) {
			assert.equal(typeof runtime[name], "function", `${name} must never be overwritten with undefined`);
		}
	});

	it("identifies the installed SDK host without overriding an explicit host", async () => {
		const { configureSubagentHost } = await import("../src/runner/extension-bridge.ts");
		const env: NodeJS.ProcessEnv = {};
		configureSubagentHost(env);
		assert.match(env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT!, /@earendil-works\/pi-coding-agent$/);
		const explicit: NodeJS.ProcessEnv = { PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT: "/explicit/host" };
		configureSubagentHost(explicit);
		assert.equal(explicit.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT, "/explicit/host");
	});

	it("configures the detached SDK host before model discovery first loads extensions", async () => {
		const { readFile } = await import("node:fs/promises");
		const source = await readFile(new URL("../src/runner/index.ts", import.meta.url), "utf8");
		const configuration = source.indexOf("\tconfigureSubagentHost();");
		const discovery = source.indexOf("await setupRunnerModels(");
		assert.ok(configuration >= 0 && discovery > configuration, "Nico caches its SDK host at its first import, including catalogue discovery");
	});
});
