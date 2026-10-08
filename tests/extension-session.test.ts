import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Conversation, ConversationView, SubmissionDraft, ModelRef } from "@earendil-works/pi-durable";
import type { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createExtensionSessionBindings } from "../src/runner/extension-session.ts";

function fixture() {
	const submissions: SubmissionDraft[] = [];
	const errors: unknown[] = [];
	let view = { docs: {} } as ConversationView;
	let ref: ModelRef | undefined = { provider: "test", modelId: "parent" };
	const models = [ { provider: "test", id: "parent" }, { provider: "test", id: "changed" } ];
	const modelRuntime = {
		getModel: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		getAvailableSnapshot: () => models,
	} as ModelRuntime;
	const settingsManager = { getSettings: () => ({}), getDefaultThinkingLevel: () => "medium" } as SettingsManager;
	const conversation = {
		submit: async (draft: SubmissionDraft) => { submissions.push(draft); return {}; },
	} as unknown as Conversation;
	const bindings = createExtensionSessionBindings({ modelRuntime, settingsManager, getActiveModel: () => ref, report: (e) => errors.push(e) });
	return { bindings, submissions, errors, models, conversation,
		bind: () => bindings.bind(() => conversation, () => view),
		setView: (docs: ConversationView["docs"]) => { view = { docs } as ConversationView; },
		setRef: (next: ModelRef | undefined) => { ref = next; },
	};
}

describe("Durable extension session", () => {
	it("reads the actual conversation model, busy state and pending messages", () => {
		const f = fixture();
		assert.equal(f.bindings.contextActions.getModel!(), f.models[0]);
		f.bind();
		f.setView({ "pi.agent": { model: { provider: "test", modelId: "changed" }, thinkingLevel: "high" }, "pi.live": { run: { taskId: "run" } }, "pi.inbox": { items: [{}] } });
		assert.equal(f.bindings.contextActions.getModel!(), f.models[1]);
		assert.equal(f.bindings.actions.getThinkingLevel!(), "high");
		assert.equal(f.bindings.contextActions.isIdle!(), false);
		assert.equal(f.bindings.contextActions.hasPendingMessages!(), true);
		f.setView({});
		assert.equal(f.bindings.contextActions.isIdle!(), true);
		assert.equal(f.bindings.contextActions.hasPendingMessages!(), false);
		f.setRef(undefined);
		assert.equal(f.bindings.contextActions.getModel!(), undefined);
	});

	it("durably queues an async child result and wakes the parent exactly once", async () => {
		const f = fixture(); f.bind();
		f.bindings.actions.sendMessage!({ customType: "subagent_result", content: "child completed", display: true }, { triggerTurn: true, deliverAs: "followUp" });
		await f.bindings.flush();
		assert.equal(f.submissions.length, 2);
		assert.equal(f.submissions[0].type, "write");
		if (f.submissions[0].type === "write") assert.equal(f.submissions[0].entry.model, undefined, "result text must not be duplicated in model context");
		assert.deepEqual(f.submissions[1], { type: "input", content: "child completed", whenBusy: "followUp" });
		assert.deepEqual(f.errors, []);
	});

	it("passive/nextTurn notifications do not start generation", async () => {
		const f = fixture(); f.bind();
		f.bindings.actions.sendMessage!({ customType: "notice", content: "passive", display: false });
		f.bindings.actions.sendMessage!({ customType: "notice", content: "next turn", display: false }, { triggerTurn: true, deliverAs: "nextTurn" });
		await f.bindings.flush();
		assert.equal(f.submissions.length, 2);
		for (const draft of f.submissions) {
			assert.equal(draft.type, "write");
			if (draft.type === "write") assert.equal(draft.entry.model?.[0].role, "user");
		}
	});

	it("buffers startup entries until SQLite is bound and preserves order", async () => {
		const f = fixture();
		f.bindings.actions.appendEntry!("startup", { enabled: true });
		f.bindings.actions.sendUserMessage!("wake", { deliverAs: "steer" });
		assert.deepEqual(f.submissions, []);
		f.bind(); await f.bindings.flush();
		assert.deepEqual(f.submissions[0], { type: "write", entry: { kind: "pi.extension.entry", data: { customType: "startup", data: { enabled: true } } } });
		assert.deepEqual(f.submissions[1], { type: "input", content: "wake", whenBusy: "steer" });
	});

	it("persists extension entries and passive results across a real SQLite reopen", async () => {
		const { mkdtemp } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const { Harness, createRegistry } = await import("@earendil-works/pi-durable");
		const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
		const { ModelRuntime, SettingsManager } = await import("@earendil-works/pi-coding-agent");
		const { runtimeContext } = await import("../src/runner/runtime-types.ts");
		const directory = await mkdtemp(join(tmpdir(), "pi-durable-extension-session-"));
		const database = join(directory, "session.sqlite");
		const modelRuntime = await ModelRuntime.create();
		const options = { models: modelRuntime, registry: createRegistry() };
		const harness = await Harness.open(await openNodeSqliteStorage(database), options, runtimeContext);
		try {
			const root = await harness.root(runtimeContext);
			const view = await root.viewState(runtimeContext);
			try {
				const errors: unknown[] = [];
				const bindings = createExtensionSessionBindings({ modelRuntime, settingsManager: SettingsManager.inMemory(), getActiveModel: () => undefined, report: (e) => errors.push(e) });
				bindings.bind(() => root, () => view.value);
				bindings.actions.appendEntry!("subagent-state", { enabled: true });
				bindings.actions.sendMessage!({ customType: "subagent-notify", content: "persisted child result", display: false });
				await bindings.flush();
				assert.deepEqual(errors, []);
			} finally { view.dispose(); }
		} finally { await harness.close(runtimeContext); }
		const reopened = await Harness.open(await openNodeSqliteStorage(database), options, runtimeContext);
		try {
			const root = await reopened.root(runtimeContext);
			const page = await root.entries({}, 50, undefined, runtimeContext);
			assert.ok(page.items.some((entry) => entry.kind === "pi.extension.entry"));
			assert.ok(page.items.some((entry) => entry.kind === "pi.extension.message" && entry.model?.[0].role === "user"));
		} finally { await reopened.close(runtimeContext); }
		// Retain the test database; do not delete files as implicit test cleanup.
	});

	it("reports failed admissions without unhandled rejections or dropping later work", async () => {
		const f = fixture();
		f.conversation.submit = async (draft) => {
			if (draft.type === "input" && draft.content === "fail") throw new Error("SQLite admission failed");
			f.submissions.push(draft); return {} as never;
		};
		f.bind();
		f.bindings.actions.sendUserMessage!("fail");
		f.bindings.actions.sendUserMessage!("later");
		await f.bindings.flush();
		assert.equal((f.errors[0] as Error).message, "SQLite admission failed");
		assert.equal(f.submissions.length, 1);
	});
});
