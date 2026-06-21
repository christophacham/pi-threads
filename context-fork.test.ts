import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	applyForkedContext,
	forkParentContextIntoChild,
	getParentBranchEntries,
	normalizeForkTurns,
	selectEntriesForFork,
} from "./context-fork.ts";
import { EMPTY_USAGE, setupSessionFixture } from "./test/fixtures/session.ts";

describe("context-fork", () => {
	const { createWorkspace, trackSession } = setupSessionFixture("pi-threads-context-fork-");

	function appendUser(session: SessionManager, text: string): void {
		session.appendMessage({ role: "user", content: text, timestamp: Date.now() });
	}

	function appendAssistant(session: SessionManager, text: string): void {
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text }],
			api: "test",
			provider: "test",
			model: "test",
			usage: EMPTY_USAGE,
			stopReason: "stop",
			timestamp: Date.now(),
		});
	}

	function appendAssistantToolCall(session: SessionManager): void {
		session.appendMessage({
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "tool-call-1",
					name: "read",
					arguments: { path: "file.ts" },
				},
			],
			api: "test",
			provider: "test",
			model: "test",
			usage: EMPTY_USAGE,
			stopReason: "toolUse",
			timestamp: Date.now(),
		});
	}

	function appendToolResult(session: SessionManager): void {
		session.appendMessage({
			role: "toolResult",
			toolCallId: "tool-call-1",
			toolName: "read",
			content: [{ type: "text", text: "file contents" }],
			isError: false,
			timestamp: Date.now(),
		});
	}

	function messageTexts(entries: SessionEntry[]): string[] {
		return entries
			.filter((entry) => entry.type === "message")
			.map((entry) => {
				const message = entry.message;
				if (message.role === "user" && typeof message.content === "string") {
					return message.content;
				}
				if (message.role === "assistant" && Array.isArray(message.content)) {
					const textPart = message.content.find((part) => part.type === "text");
					return textPart?.type === "text" ? textPart.text : "[assistant]";
				}
				if (message.role === "toolResult") {
					return `[toolResult:${message.toolName}]`;
				}
				return `[${message.role}]`;
			});
	}

	it("normalizeForkTurns defaults invalid values to none", () => {
		expect(normalizeForkTurns()).toBe("none");
		expect(normalizeForkTurns("none")).toBe("none");
		expect(normalizeForkTurns(0)).toBe("none");
		expect(normalizeForkTurns(-2)).toBe("none");
		expect(normalizeForkTurns(2.9)).toBe(2);
	});

	it("selectEntriesForFork all copies the full parent branch", () => {
		const cwd = createWorkspace();
		const parent = trackSession(SessionManager.create(cwd));
		appendUser(parent, "turn-1-user");
		appendAssistant(parent, "turn-1-assistant");
		appendUser(parent, "turn-2-user");
		appendAssistant(parent, "turn-2-assistant");

		const branch = getParentBranchEntries(parent);
		const selected = selectEntriesForFork(branch, "all");
		expect(messageTexts(selected)).toEqual([
			"turn-1-user",
			"turn-1-assistant",
			"turn-2-user",
			"turn-2-assistant",
		]);
	});

	it("selectEntriesForFork N copies the last N user+assistant turn pairs", () => {
		const cwd = createWorkspace();
		const parent = trackSession(SessionManager.create(cwd));
		appendUser(parent, "turn-1-user");
		appendAssistant(parent, "turn-1-assistant");
		appendUser(parent, "turn-2-user");
		appendAssistant(parent, "turn-2-assistant");
		appendUser(parent, "turn-3-user");
		appendAssistant(parent, "turn-3-assistant");

		const branch = getParentBranchEntries(parent);
		const selected = selectEntriesForFork(branch, 2);
		expect(messageTexts(selected)).toEqual([
			"turn-2-user",
			"turn-2-assistant",
			"turn-3-user",
			"turn-3-assistant",
		]);
	});

	it("replayEntryOntoSession preserves tool calls and tool results", () => {
		const cwd = createWorkspace();
		const parent = trackSession(SessionManager.create(cwd));
		appendUser(parent, "inspect file");
		appendAssistantToolCall(parent);
		appendToolResult(parent);
		appendAssistant(parent, "done");

		const child = trackSession(SessionManager.create(cwd));
		applyForkedContext(child, getParentBranchEntries(parent));

		expect(messageTexts(child.getEntries())).toEqual([
			"inspect file",
			"[assistant]",
			"[toolResult:read]",
			"done",
		]);
	});

	it("forkParentContextIntoChild inserts copied entries before child prompt bootstrap", () => {
		const cwd = createWorkspace();
		const parent = trackSession(SessionManager.create(cwd));
		appendUser(parent, "parent-context");
		appendAssistant(parent, "parent-reply");

		const child = trackSession(SessionManager.create(cwd));
		child.appendCustomEntry("thread_meta", {
			parent_id: "parent-id",
			thread_id: child.getSessionId(),
			thread_name: "worker",
			depth: 1,
			task: "task",
			agent_type: "worker",
		});

		forkParentContextIntoChild(parent, child, "all");

		expect(messageTexts(child.getEntries())).toEqual(["parent-context", "parent-reply"]);
	});
});