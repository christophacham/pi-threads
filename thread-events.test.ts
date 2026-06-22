import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findLatestThreadCompleted } from "./persistence.ts";
import { ThreadEvents } from "./thread-events.ts";
import { THREAD_ENTRY_TYPES, THREAD_TRANSCRIPT_TYPES } from "./types.ts";

describe("ThreadEvents", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function createSessionManager(): SessionManager {
		const dir = mkdtempSync(join(tmpdir(), "pi-threads-events-test-"));
		tempDirs.push(dir);
		return SessionManager.create(dir, dir);
	}

	function createWriter() {
		const durableEntries: Array<{ customType: string; data?: unknown }> = [];
		const transcriptMessages: Array<{
			customType: string;
			content: string;
			display: boolean;
			details?: unknown;
		}> = [];

		const writer = {
			appendEntry: vi.fn((customType: string, data?: unknown) => {
				durableEntries.push({ customType, data });
			}),
			sendMessage: vi.fn(
				(message: { customType: string; content: string; display: boolean; details?: unknown }) => {
					transcriptMessages.push(message);
				},
			),
		};

		return { writer, durableEntries, transcriptMessages };
	}

	it("recordSpawn dual-writes durable tree entry and transcript", () => {
		const { writer, durableEntries, transcriptMessages } = createWriter();
		const events = new ThreadEvents(writer);

		events.recordSpawn(
			{
				thread_id: "thread-1",
				thread_name: "researcher",
				parent_id: "parent-1",
				depth: 1,
				agent_type: "researcher",
			},
			"Research auth module",
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
		expect(transcriptMessages[0].content).toContain("researcher");
	});

	it("recordSend dual-writes durable interaction log and transcript", () => {
		const { writer, durableEntries, transcriptMessages } = createWriter();
		const events = new ThreadEvents(writer);

		events.recordSend({
			thread_id: "thread-1",
			thread_name: "worker",
			agent_type: "worker",
			message_preview: "Please continue",
		});

		expect(durableEntries).toEqual([
			{
				customType: THREAD_TRANSCRIPT_TYPES.SEND,
				data: expect.objectContaining({
					thread_id: "thread-1",
					thread_name: "worker",
					message_preview: "Please continue",
				}),
			},
		]);
		expect(transcriptMessages).toHaveLength(1);
		expect(transcriptMessages[0].customType).toBe(THREAD_TRANSCRIPT_TYPES.SEND);
	});

	it("recordCompleted writes transcript only", () => {
		const { writer, durableEntries, transcriptMessages } = createWriter();
		const events = new ThreadEvents(writer);

		events.recordCompleted({
			thread_id: "thread-1",
			thread_name: "worker",
			agent_type: "worker",
			status: "completed",
			result_preview: "done",
		});

		expect(durableEntries).toEqual([]);
		expect(transcriptMessages).toHaveLength(1);
		expect(transcriptMessages[0].customType).toBe(THREAD_TRANSCRIPT_TYPES.COMPLETED);
		expect(transcriptMessages[0].content).toContain("worker");
	});

	it("recordWait writes transcript only", () => {
		const { writer, durableEntries, transcriptMessages } = createWriter();
		const events = new ThreadEvents(writer);

		events.recordWait({
			thread_id: "thread-1",
			thread_name: "worker",
			agent_type: "worker",
			phase: "started",
			status: "Running",
		});

		expect(durableEntries).toEqual([]);
		expect(transcriptMessages).toHaveLength(1);
		expect(transcriptMessages[0].customType).toBe(THREAD_TRANSCRIPT_TYPES.WAIT);
	});

	it("recordInterrupt writes child completion and parent transcript", () => {
		const childSession = createSessionManager();
		const { writer, durableEntries, transcriptMessages } = createWriter();
		const events = new ThreadEvents(writer);

		events.recordInterrupt({
			childSession,
			thread_id: "thread-1",
			thread_name: "worker",
			agent_type: "worker",
		});

		expect(findLatestThreadCompleted(childSession.getEntries())?.status).toBe("aborted");
		expect(durableEntries).toEqual([]);
		expect(transcriptMessages).toHaveLength(1);
		expect(transcriptMessages[0].customType).toBe(THREAD_TRANSCRIPT_TYPES.INTERRUPTED);
	});

	it("recordClose writes child completion and parent transcript", () => {
		const childSession = createSessionManager();
		const { writer, durableEntries, transcriptMessages } = createWriter();
		const events = new ThreadEvents(writer);

		events.recordClose({
			childSession,
			thread_id: "thread-1",
			thread_name: "worker",
			agent_type: "worker",
		});

		expect(findLatestThreadCompleted(childSession.getEntries())?.status).toBe("closed");
		expect(durableEntries).toEqual([]);
		expect(transcriptMessages).toHaveLength(1);
		expect(transcriptMessages[0].customType).toBe(THREAD_TRANSCRIPT_TYPES.CLOSED);
	});
});