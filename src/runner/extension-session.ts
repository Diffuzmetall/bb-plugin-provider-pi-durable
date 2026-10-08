import type { ExtensionActions, ExtensionContextActions, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Conversation, ConversationView, ModelRef, SubmissionDraft } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { runtimeContext } from "./runtime-types.ts";

/** Bridges asynchronous extension notifications to the same SQLite conversation as the parent. */
export function createExtensionSessionBindings(options: {
	modelRuntime: ModelRuntime;
	settingsManager: SettingsManager;
	getActiveModel: () => ModelRef | undefined;
	report: (error: unknown) => void;
}) {
	let getConversation: (() => Conversation) | undefined;
	let getView: (() => ConversationView) | undefined;
	let writes = Promise.resolve();
	const startupSubmissions: SubmissionDraft[] = [];
	const current = () => {
		if (!getConversation) throw new Error("Pi Durable extension session is not bound yet");
		return getConversation();
	};
	const enqueue = (operation: () => Promise<unknown>) => {
		// All synchronous Pi APIs share one ordered, observed admission queue.
		writes = writes.then(operation).then(() => {}, options.report);
	};
	const submit = (draft: SubmissionDraft) => {
		if (!getConversation) { startupSubmissions.push(draft); return; }
		const conversation = current();
		enqueue(() => conversation.submit(draft, runtimeContext));
	};
	const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value));
	const model = () => {
		const selected = getView?.().docs["pi.agent"]?.model;
		const ref = selected && typeof selected === "object" && !Array.isArray(selected)
			&& typeof selected.provider === "string" && typeof selected.modelId === "string"
			? { provider: selected.provider, modelId: selected.modelId }
			: options.getActiveModel();
		return ref ? options.modelRuntime.getModel(ref.provider, ref.modelId) : undefined;
	};

	const actions: Partial<ExtensionActions> = {
		getSettings: () => options.settingsManager.getSettings(),
		getThinkingLevel: () => {
			const level = getView?.().docs["pi.agent"]?.thinkingLevel;
			return typeof level === "string" ? level as ReturnType<ExtensionActions["getThinkingLevel"]> : options.settingsManager.getDefaultThinkingLevel() ?? "off";
		},
		sendUserMessage: (content, opts) => submit({ type: "input", content, whenBusy: opts?.deliverAs ?? "followUp" }),
		sendMessage: (message, opts) => {
			const content = message.content;
			const trigger = opts?.triggerTurn === true && opts.deliverAs !== "nextTurn";
			submit({
				type: "write",
				entry: {
					kind: "pi.extension.message",
					data: json(message),
					// Passive messages enter context without starting another generation.
					...(trigger ? {} : { model: [{ role: "user", content, timestamp: Date.now() }] }),
				},
			});
			if (trigger) submit({ type: "input", content, whenBusy: opts?.deliverAs === "steer" ? "steer" : "followUp" });
		},
		setModel: async (selected) => {
			if (!options.modelRuntime.getModel(selected.provider, selected.id)) return false;
			await current().configure({ model: { provider: selected.provider, modelId: selected.id } }, runtimeContext);
			return true;
		},
		appendEntry: (customType, data) => submit({
			type: "write",
			entry: { kind: "pi.extension.entry", data: json({ customType, data }) },
		}),
		setThinkingLevel: (thinkingLevel) => {
			const conversation = current();
			enqueue(() => conversation.configure({ thinkingLevel }, runtimeContext));
		},
	};
	const contextActions: Partial<ExtensionContextActions> = {
		getModel: model,
		getScopedModels: () => options.modelRuntime.getAvailableSnapshot().map((available) => ({ model: available })),
		isIdle: () => !getView?.().docs["pi.live"]?.run,
		hasPendingMessages: () => {
			const items = getView?.().docs["pi.inbox"]?.items;
			return Array.isArray(items) && items.length > 0;
		},
		abort: () => { const conversation = current(); enqueue(() => conversation.abort(runtimeContext)); },
		compact: (opts) => { const conversation = current(); enqueue(() => conversation.compact(opts?.customInstructions, runtimeContext)); },
	};
	return {
		actions,
		contextActions,
		bind(conversation: () => Conversation, view: () => ConversationView) {
			getConversation = conversation;
			getView = view;
			for (const draft of startupSubmissions.splice(0)) submit(draft);
		},
		flush: () => writes,
	};
}
