import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	createThreadSpawnedActivity,
	emitThreadSpawnedTranscript,
	findAllThreadSpawned,
	extractThreadOutput,
	findFirstThreadMeta,
	findLatestThreadCompleted,
	formatInterAgentMessage,
	THREAD_SESSION_BOOTSTRAP_TEXT,
	isThreadSession,
	listThreadSessions,
	parseInterAgentMessage,
	writeThreadCompleted,
	writeThreadMeta,
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