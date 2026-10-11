import type { EntryRecord } from "@earendil-works/pi-durable";
import type {
	BBToolExecutionEndEvent,
	BBToolExecutionUpdateEvent,
} from "./contracts.ts";

interface RawToolResultMessage {
	isError?: boolean;
	content?: string | Array<{ text?: string; [key: string]: unknown }>;
	[key: string]: unknown;
}

export interface ToolExecutionUpdateEventLike {
	toolCallId: string | number;
	toolName: string;
	output?: { trimStart?: number; append?: string } | { set: string };
	details?: unknown;
}

export interface ToolExecutionEndEventLike {
	toolCallId: string | number;
	toolName: string;
	entry?: EntryRecord;
	details?: unknown;
}

const activeToolDetails = new Map<string | number, unknown>();

export function clearActiveToolDetails(): void {
	activeToolDetails.clear();
}

/**
 * Extracts human-readable tool result and error status from a model item.
 */
export function extractToolResult(modelItem: unknown): { result: string; isError: boolean } {
	const msg = typeof modelItem === "object" && modelItem !== null ? (modelItem as RawToolResultMessage) : undefined;
	const isError = msg?.isError ?? false;
	let result = "";
	if (Array.isArray(msg?.content)) {
		result = msg.content
			.map((b) => (typeof b === "object" && b !== null && typeof b.text === "string" ? b.text : ""))
			.filter(Boolean)
			.join("\n");
	} else if (typeof msg?.content === "string") {
		result = msg.content;
	}
	return { result, isError };
}

/**
 * Builds a validated BBToolExecutionUpdateEvent from a native tool execution update event.
 */
export function buildToolExecutionUpdate(
	event: ToolExecutionUpdateEventLike,
	parentRef?: string,
): BBToolExecutionUpdateEvent | undefined {
	let partialResult = "";
	if (event.output) {
		if ("set" in event.output) partialResult = event.output.set;
		else if ("append" in event.output) partialResult = event.output.append ?? "";
	}
	let trimStart: number | undefined;
	if (event.output && "trimStart" in event.output && typeof event.output.trimStart === "number") {
		trimStart = event.output.trimStart;
	}
	if (event.details !== undefined) {
		activeToolDetails.set(event.toolCallId, event.details);
	}
	if (partialResult || trimStart !== undefined || event.details !== undefined) {
		return {
			type: "tool_execution_update",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			partialResult,
			...(trimStart !== undefined ? { trimStart } : {}),
			...(event.details !== undefined ? { details: event.details } : {}),
			...(parentRef !== undefined ? { parentRef } : {}),
		};
	}
	return undefined;
}

/**
 * Builds a validated BBToolExecutionEndEvent from a native tool execution end event.
 */
export function buildToolExecutionEnd(
	event: ToolExecutionEndEventLike,
	parentRef?: string,
): BBToolExecutionEndEvent {
	if (event.entry === undefined) {
		return {
			type: "tool_execution_end",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			result: "Tool execution faulted or was orphaned without generating an entry record.",
			isError: true,
			...(parentRef !== undefined ? { parentRef } : {}),
		};
	}
	const { result, isError } = extractToolResult(event.entry?.model?.[0]);
	const entryData = typeof event.entry === "object" && event.entry !== null && "data" in event.entry
		? (event.entry as { data?: unknown }).data
		: undefined;
	const bufferedDetails = activeToolDetails.get(event.toolCallId);
	activeToolDetails.delete(event.toolCallId);
	const details = entryData ?? event.details ?? bufferedDetails;
	return {
		type: "tool_execution_end",
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		result,
		isError,
		...(details !== undefined ? { details } : {}),
		...(parentRef !== undefined ? { parentRef } : {}),
	};
}
