import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	appendInterAgentUserMessage,
	buildThreadChildrenMap,
	collectUserMessageEntryIds,
	createThreadSendActivity,
	createThreadSpawnedActivity,
	emitThreadSpawnedTranscript,
	findAllThreadSpawned,
	findThreadSessionById,
	findUnprocessedUserMessages,
	getThreadSessionIndex,
	invalidateThreadSessionScanCache,
	shouldResumeThreadSession,
	extractThreadOutput,
	findFirstThreadMeta,
	findLatestThreadCompleted,
	findLatestThreadModel,
	formatInterAgentMessage,
	THREAD_SESSION_BOOTSTRAP_TEXT,
	isThreadSession,
	listThreadSessions,
	parseInterAgentMessage,
	upsertThreadSessionScanCache,
	writeThreadCompleted,
	writeThreadMeta,
	writeThreadSendDual,
	writeThreadSpawnedDurable,
	writeThreadSpawnedDual,
} from "./persistence.ts";
import { THREAD_ENTRY_TYPES, THREAD_TRANSCRIPT_TYPES } from "./types.ts";

describe("InterAgentCommunication", () => {
	it("formats and parses envelope text", () => {
		const envelope = { author: "root", recipient: "researcher", content: "Find all TODOs" };
		const text = formatInterAgentMessage(envelope);
		expect(text).toBe("[From root to researcher]: Find all TODOs");
		expect(parseInterAgentMessage(text)).toEqual(envelope);
	});

	it("returns null for non-envelope text", () => {
		expect(parseInterAgentMessage("plain user message")).toBeNull();
	});
});

describe("thread session entries", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function createSessionManager(): SessionManager {
		const dir = mkdtempSync(join(tmpdir(), "pi-threads-test-"));
		tempDirs.push(dir);
		return SessionManager.create(dir, dir);
	}

	it("writes thread_meta as first custom entry in child session", () => {
		const sm = createSessionManager();
		writeThreadMeta(sm, {
			parent_id: "parent-1",
			thread_id: "thread-1",
			thread_name: "researcher",
			depth: 1,
			task: "Research auth module",
			agent_type: "researcher",
		});

		const entries = sm.getEntries();
		expect(entries[0].type).toBe("custom");
		expect(entries[0]).toMatchObject({
			type: "custom",
			customType: THREAD_ENTRY_TYPES.META,
			data: {
				parent_id: "parent-1",
				thread_id: "thread-1",
				thread_name: "researcher",
				depth: 1,
				task: "Research auth module",
				agent_type: "researcher",
			},
		});
		expect(isThreadSession(sm)).toBe(true);
		expect(findFirstThreadMeta(entries)?.thread_id).toBe("thread-1");
	});

	it("writes thread_spawned durable entry to parent session", () => {
		const sm = createSessionManager();
		const writer = {
			appendEntry: (customType: string, data?: unknown) => {
				sm.appendCustomEntry(customType, data);
			},
		};

		writeThreadSpawnedDurable(writer, {
			thread_id: "thread-1",
			thread_name: "researcher",
			parent_id: "parent-1",
			depth: 1,
			agent_type: "researcher",
		});

		const spawned = findAllThreadSpawned(sm.getEntries());
		expect(spawned).toHaveLength(1);
		expect(spawned[0].thread_name).toBe("researcher");
	});

	it("dual-writes thread_spawned durable + transcript", () => {
		const durableEntries: Array<{ customType: string; data?: unknown }> = [];
		const transcriptMessages: Array<{ customType: string; content: string; display: boolean; details?: unknown }> =
			[];

		const dualWriter = {
			appendEntry: (customType: string, data?: unknown) => {
				durableEntries.push({ customType, data });
			},
			sendMessage: (message: { customType: string; content: string; display: boolean; details?: unknown }) => {
				transcriptMessages.push(message);
			},
		};

		const transcript = createThreadSpawnedActivity({
			thread_id: "thread-1",
			thread_name: "researcher",
			agent_type: "researcher",
			task: "Research auth module",
		});

		writeThreadSpawnedDual(
			dualWriter,
			{
				thread_id: "thread-1",
				thread_name: "researcher",
				parent_id: "parent-1",
				depth: 1,
				agent_type: "researcher",
			},
			transcript,
		);

		expect(durableEntries).toEqual([
			{
				customType: THREAD_ENTRY_TYPES.SPAWNED,
				data: {
					thread_id: "thread-1",
					thread_name: "researcher",
					parent_id: "parent-1",
					depth: 1,
					agent_type: "researcher",
				},
			},
		]);
		expect(transcriptMessages).toHaveLength(1);
		expect(transcriptMessages[0].customType).toBe(THREAD_TRANSCRIPT_TYPES.SPAWNED);
		expect(transcriptMessages[0].display).toBe(true);
	});

	it("writes thread_completed with terminal status values", () => {
		const sm = createSessionManager();
		for (const status of ["completed", "error", "aborted", "closed"] as const) {
			writeThreadCompleted(sm, { status, exit_code: status === "completed" ? 0 : 1 });
		}

		const completion = findLatestThreadCompleted(sm.getEntries());
		expect(completion?.status).toBe("closed");
	});

	it("findLatestThreadModel skips bootstrap assistant messages", () => {
		const sm = createSessionManager();
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: THREAD_SESSION_BOOTSTRAP_TEXT }],
			api: "pi-threads",
			provider: "pi-threads",
			model: "pi-threads",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "working" }],
			api: "test",
			provider: "test",
			model: "claude-sonnet",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		expect(findLatestThreadModel(sm.getEntries())).toBe("claude-sonnet");
	});

	it("identifies thread sessions via listThreadSessions", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-threads-list-"));
		tempDirs.push(dir);

		const regular = SessionManager.create(dir, dir);
		regular.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		// Pi defers writing session files until the first assistant message.
		regular.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "test",
			provider: "test",
			model: "test",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const thread = SessionManager.create(dir, dir);
		writeThreadMeta(thread, {
			parent_id: "parent-1",
			thread_id: "thread-1",
			thread_name: "worker",
			depth: 1,
			task: "do work",
			agent_type: "worker",
		});
		thread.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "working" }],
			api: "test",
			provider: "test",
			model: "test",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const listed = await listThreadSessions(dir, dir);
		expect(listed).toHaveLength(1);
		expect(listed[0].meta.thread_name).toBe("worker");
	});

	it("shouldResumeThreadSession returns true only for incomplete sessions", () => {
		const meta = {
			parent_id: "parent-1",
			thread_id: "thread-1",
			thread_name: "worker",
			depth: 1,
			task: "task",
			agent_type: "worker",
		};

		expect(shouldResumeThreadSession({ path: "/tmp/thread.jsonl", meta })).toBe(true);

		for (const status of ["completed", "error", "aborted", "closed"] as const) {
			expect(
				shouldResumeThreadSession({
					path: "/tmp/thread.jsonl",
					meta,
					completion: { status },
				}),
			).toBe(false);
		}
	});

	it("buildThreadChildrenMap cross-references thread_spawned and thread_meta", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-threads-tree-"));
		tempDirs.push(dir);

		const parent = SessionManager.create(dir, dir);
		parent.appendCustomEntry(THREAD_ENTRY_TYPES.SPAWNED, {
			thread_id: "child-1",
			thread_name: "child-1",
			parent_id: "parent-root",
			depth: 1,
			agent_type: "worker",
		});
		parent.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "persist parent" }],
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const child = SessionManager.create(dir, dir);
		writeThreadMeta(child, {
			parent_id: "parent-root",
			thread_id: "child-1",
			thread_name: "child-1",
			depth: 1,
			task: "child task",
			agent_type: "worker",
		});
		child.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "persist child" }],
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const tree = await buildThreadChildrenMap(dir, dir);
		expect([...(tree.get("parent-root") ?? [])]).toEqual(["child-1"]);
	});

	it("extractThreadOutput skips bootstrap stub and returns last assistant text", () => {
		const sm = createSessionManager();
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: THREAD_SESSION_BOOTSTRAP_TEXT }],
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "real thread output" }],
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		expect(extractThreadOutput(sm.getEntries())).toBe("real thread output");
	});

	it("appendInterAgentUserMessage writes envelope user messages", () => {
		const sm = createSessionManager();
		appendInterAgentUserMessage(sm, {
			author: "root",
			recipient: "worker",
			content: "Check tests",
		});

		const userEntries = sm
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "user");
		expect(userEntries).toHaveLength(1);
		expect(userEntries[0]).toMatchObject({
			type: "message",
			message: {
				role: "user",
				content: "[From root to worker]: Check tests",
			},
		});
	});

	it("findUnprocessedUserMessages skips already processed ids", () => {
		const sm = createSessionManager();
		appendInterAgentUserMessage(sm, { author: "root", recipient: "worker", content: "one" });
		appendInterAgentUserMessage(sm, { author: "root", recipient: "worker", content: "two" });

		const ids = collectUserMessageEntryIds(sm.getEntries());
		const processed = new Set([ids[0]]);
		const unprocessed = findUnprocessedUserMessages(sm.getEntries(), processed);

		expect(unprocessed).toHaveLength(1);
		expect(unprocessed[0]?.text).toBe("[From root to worker]: two");
	});

	it("dual-writes thread_send durable + transcript", () => {
		const durableEntries: Array<{ customType: string; data?: unknown }> = [];
		const transcriptMessages: Array<{ customType: string; content: string; display: boolean; details?: unknown }> =
			[];

		const dualWriter = {
			appendEntry: (customType: string, data?: unknown) => {
				durableEntries.push({ customType, data });
			},
			sendMessage: (message: { customType: string; content: string; display: boolean; details?: unknown }) => {
				transcriptMessages.push(message);
			},
		};

		const event = createThreadSendActivity({
			thread_id: "thread-1",
			thread_name: "worker",
			agent_type: "worker",
			message_preview: "hello there",
		});

		writeThreadSendDual(dualWriter, event);

		expect(durableEntries).toEqual([
			{
				customType: THREAD_TRANSCRIPT_TYPES.SEND,
				data: event,
			},
		]);
		expect(transcriptMessages[0]).toMatchObject({
			customType: THREAD_TRANSCRIPT_TYPES.SEND,
			content: "Sent input to worker: hello there",
			display: true,
			details: event,
		});
	});

	it("getThreadSessionIndex returns a map keyed by thread_id", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-threads-index-"));
		tempDirs.push(dir);

		const thread = SessionManager.create(dir, dir);
		writeThreadMeta(thread, {
			parent_id: "parent-1",
			thread_id: "thread-1",
			thread_name: "worker",
			depth: 1,
			task: "do work",
			agent_type: "worker",
		});
		thread.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "working" }],
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const index = await getThreadSessionIndex(dir, dir);
		expect(index.get("thread-1")?.meta.thread_name).toBe("worker");
	});

	it("reuses scan cache across findThreadSessionById lookups", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-threads-cache-"));
		tempDirs.push(dir);
		invalidateThreadSessionScanCache(dir, dir);

		const thread = SessionManager.create(dir, dir);
		writeThreadMeta(thread, {
			parent_id: "parent-1",
			thread_id: "thread-1",
			thread_name: "worker",
			depth: 1,
			task: "do work",
			agent_type: "worker",
		});
		thread.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "working" }],
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const listSpy = vi.spyOn(SessionManager, "list");
		await listThreadSessions(dir, dir);
		expect(listSpy).toHaveBeenCalledTimes(1);

		listSpy.mockClear();
		await findThreadSessionById(dir, "thread-1", dir);
		await findThreadSessionById(dir, "thread-1", dir);
		expect(listSpy).not.toHaveBeenCalled();

		listSpy.mockRestore();
	});

	it("invalidates scan cache when listThreadSessions refreshes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-threads-refresh-"));
		tempDirs.push(dir);
		invalidateThreadSessionScanCache(dir, dir);

		const thread = SessionManager.create(dir, dir);
		writeThreadMeta(thread, {
			parent_id: "parent-1",
			thread_id: "thread-1",
			thread_name: "worker",
			depth: 1,
			task: "do work",
			agent_type: "worker",
		});
		thread.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "working" }],
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		await listThreadSessions(dir, dir);

		const second = SessionManager.create(dir, dir);
		writeThreadMeta(second, {
			parent_id: "parent-1",
			thread_id: "thread-2",
			thread_name: "helper",
			depth: 1,
			task: "assist",
			agent_type: "worker",
		});
		second.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "helping" }],
			api: "test",
			provider: "test",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});

		expect((await getThreadSessionIndex(dir, dir)).has("thread-2")).toBe(false);

		await listThreadSessions(dir, dir);
		expect((await getThreadSessionIndex(dir, dir)).get("thread-2")?.meta.thread_name).toBe("helper");
	});

	it("upsertThreadSessionScanCache adds sessions without rescanning", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-threads-upsert-"));
		tempDirs.push(dir);
		invalidateThreadSessionScanCache(dir, dir);

		upsertThreadSessionScanCache(
			dir,
			{
				path: "/tmp/thread-3.jsonl",
				meta: {
					parent_id: "parent-1",
					thread_id: "thread-3",
					thread_name: "upserted",
					depth: 1,
					task: "upsert",
					agent_type: "worker",
				},
			},
			dir,
		);

		const listSpy = vi.spyOn(SessionManager, "list");
		const session = await findThreadSessionById(dir, "thread-3", dir);
		expect(session?.meta.thread_name).toBe("upserted");
		expect(listSpy).not.toHaveBeenCalled();
		listSpy.mockRestore();
	});

	it("emitThreadSpawnedTranscript sends inline event", () => {
		const messages: Array<{ customType: string; content: string; display: boolean }> = [];
		const emitter = {
			sendMessage: (message: { customType: string; content: string; display: boolean }) => {
				messages.push(message);
			},
		};

		emitThreadSpawnedTranscript(
			emitter,
			createThreadSpawnedActivity({
				thread_id: "thread-1",
				thread_name: "worker",
				agent_type: "worker",
				task: "do work",
			}),
		);

		expect(messages[0].customType).toBe(THREAD_TRANSCRIPT_TYPES.SPAWNED);
		expect(messages[0].content).toContain("worker");
	});
});