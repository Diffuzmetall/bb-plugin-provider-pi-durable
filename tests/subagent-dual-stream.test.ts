import test from "node:test";
import assert from "node:assert/strict";
import { PiThreadSession } from "../src/host/session.ts";
import type { RunnerEvent } from "../src/host/types.ts";

test("PiThreadSession broadcasts subagent events to BOTH parent (delegation card) and child (root thread)", async () => {
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];

	const session = new PiThreadSession(
		{
			threadId: "thr_parent",
			providerThreadId: "pi_durable_root",
			sessionFilePath: "/tmp/fake-dual.sqlite",
			sessionDir: "/tmp",
			extensionPath: "/tmp/ext",
			scratchDir: "/tmp/scratch",
		},
		(method, params) => notifications.push({ method, params }),
	);

	try {
		session.registerThread("thr_child", "2");
		session.markSubagentActive("2", { task: "Audit", parentToolCallId: "call_sub_1" });

		const childEvent: RunnerEvent = {
			type: "message_update",
			conversationId: 2,
			parentRef: "call_sub_1",
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "Checking tables...",
			},
		};

		await (session as any).handleRunnerEvent(childEvent);

		// 1. Parent thread received delta with parentRef (for delegation card)
		const parentNotifs = notifications.filter((n) => n.params.threadId === "thr_parent");
		assert.ok(parentNotifs.length > 0, "Parent thread must receive delegation deltas");
		const parentDelta = (parentNotifs[0].params.deltas as any[])[0];
		assert.equal(parentDelta.key?.parentRef, "call_sub_1");

		// 2. Child thread received root delta without parentRef (for standalone child chat)
		const childNotifs = notifications.filter((n) => n.params.threadId === "thr_child");
		assert.ok(childNotifs.length > 0, "Child thread must receive root deltas");
		const childDelta = (childNotifs[0].params.deltas as any[])[0];
		assert.equal(childDelta.key?.parentRef, undefined);
	} finally {
		session.kill();
	}
});

test("PiThreadSession completes child thread when subagent finishes", async () => {
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];

	const session = new PiThreadSession(
		{
			threadId: "thr_parent",
			providerThreadId: "pi_durable_root",
			sessionFilePath: "/tmp/fake-dual-end.sqlite",
			sessionDir: "/tmp",
			extensionPath: "/tmp/ext",
			scratchDir: "/tmp/scratch",
		},
		(method, params) => notifications.push({ method, params }),
	);

	try {
		session.registerThread("thr_child", "2");
		session.markSubagentActive("2", { task: "Audit", parentToolCallId: "call_sub_1" });

		const agentEndEvent: RunnerEvent = {
			type: "agent_end",
			conversationId: 2,
			parentRef: "call_sub_1",
		};

		await (session as any).handleRunnerEvent(agentEndEvent);

		// Child thread must receive turn.boundary with status completed
		const childNotifs = notifications.filter((n) => n.params.threadId === "thr_child");
		const hasBoundary = childNotifs.some(
			(n) => Array.isArray(n.params.deltas) && (n.params.deltas as any[]).some((d) => d.kind === "turn.boundary"),
		);
		assert.ok(hasBoundary, "Child thread must receive turn.boundary upon agent_end");

		// Subagent state must transition to completed
		assert.equal(session.getSubagentState("2")?.status, "completed");
	} finally {
		session.kill();
	}
});
