import { test } from "node:test";
import assert from "node:assert/strict";
import { translateToolStart, translateToolUpdate, buildToolItemShape } from "../src/host/tool-delta-translator.ts";
import { DeltaTranslator } from "../src/host/delta-translator.ts";
import { BBChildEventAdapter } from "../src/runner/bridge/bb-child-event-adapter.ts";
import type { AgentEvent } from "@earendil-works/pi-durable";
import type { BBWireEvent } from "../src/runner/bridge/contracts.ts";

test("Subagent delegation item carries task in label and summary", () => {
	const task = "Search for authentication bugs across repository";
	const event = {
		type: "tool_execution_start",
		toolCallId: "call_sub_1",
		toolName: "subagent",
		args: { task },
	} as any;

	const { shape, delta } = translateToolStart(event, "/tmp");

	assert.equal(shape.type, "delegation");
	assert.equal(shape.label, task);
	assert.equal(shape.summary, task);
	assert.equal(delta.item?.type, "delegation");
	assert.equal(delta.item?.label, task);
	assert.equal(delta.item?.summary, task);
});

test("BBChildEventAdapter emits initial task prompt message under parentRef", () => {
	const wireEvents: BBWireEvent[] = [];
	const adapter = new BBChildEventAdapter((ev) => wireEvents.push(ev), "call_sub_1");

	// Initial prompt submitted to child conversation
	const inputEvent: AgentEvent = {
		type: "message_start",
		message: {
			role: "user",
			content: [{ type: "text", text: "Search for authentication bugs across repository" }],
		},
	} as any;

	adapter.handleEvent(inputEvent);

	assert.equal(wireEvents.length > 0, true, "Expected wire event for initial subagent input message");
	const msgEvent = wireEvents[0];
	assert.equal(msgEvent.type, "message_update");
	assert.equal(msgEvent.parentRef, "call_sub_1");
	assert.equal(msgEvent.assistantMessageEvent?.type, "text_delta");
	assert.match(msgEvent.assistantMessageEvent?.delta ?? "", /Search for authentication bugs/);
});

test("Child tool execution deltas strictly carry parentRef and parentToolCallId matching delegation callId", () => {
	const translator = new DeltaTranslator();
	const childToolStart: any = {
		type: "tool_execution_start",
		toolCallId: "call_sub_1:call_bash_1",
		toolName: "bash",
		args: { command: "ls -la" },
		parentRef: "call_sub_1",
	};

	const deltas = translator.translate(childToolStart, {
		providerOptions: {},
		lastCheckpointId: null,
		fallbackCwd: "/tmp",
	});

	assert.equal(deltas.length, 1);
	const delta = deltas[0];
	assert.equal(delta.kind, "item.open");
	assert.equal(delta.key.parentRef, "call_sub_1");
	assert.equal(delta.item?.parentToolCallId, "call_sub_1");
});
