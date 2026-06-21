import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { parsePollIntervalMs, startChildMessagePoller } from "./child-message-poller.ts";
import {
	appendInterAgentUserMessage,
	findLatestThreadCompleted,
	writeThreadCompleted,
	writeThreadMeta,
} from "./persistence.ts";
import { setupSessionFixture } from "./test/fixtures/session.ts";

describe("child message poller", () => {
	const { createWorkspace, trackSession, persistSession } = setupSessionFixture("pi-threads-poller-test-");

	function createThreadChildSession(cwd: string): SessionManager {
		const session = trackSession(SessionManager.create(cwd));
		writeThreadMeta(session, {
			parent_id: "parent-1",
			thread_id: "thread-child",
			thread_name: "worker",
			depth: 1,
			task: "Initial task",
			agent_type: "worker",
		});
		appendInterAgentUserMessage(session, {
			author: "root",
			recipient: "worker",
			content: "Initial task",
		});
		persistSession(session);
		return session;
	}

	it("parsePollIntervalMs falls back for invalid values", () => {
		expect(parsePollIntervalMs(undefined, 2000)).toBe(2000);
		expect(parsePollIntervalMs("abc", 2000)).toBe(2000);
		expect(parsePollIntervalMs("0", 2000)).toBe(2000);
		expect(parsePollIntervalMs("1500", 2000)).toBe(1500);
	});

	it("pollOnce injects new user messages via sendUserMessage when idle", async () => {
		const cwd = createWorkspace();
		const child = createThreadChildSession(cwd);
		const sessionFile = child.getSessionFile()!;

		const pi = {
			sendUserMessage: vi.fn(),
		} as unknown as ExtensionAPI;
		const ctx = {
			sessionManager: child,
			isIdle: () => true,
		} as unknown as ExtensionContext;

		const poller = startChildMessagePoller(pi, ctx, { pollIntervalMs: 10_000 });
		expect(poller.processedIds.size).toBe(1);

		const reopened = SessionManager.open(sessionFile);
		appendInterAgentUserMessage(reopened, {
			author: "root",
			recipient: "worker",
			content: "Follow-up task",
		});

		await poller.pollOnce();

		expect(pi.sendUserMessage).toHaveBeenCalledWith("[From root to worker]: Follow-up task");
		expect(poller.processedIds.size).toBe(2);
		poller.stop();
	});

	it("pollOnce uses steer delivery when agent is streaming", async () => {
		const cwd = createWorkspace();
		const child = createThreadChildSession(cwd);
		const sessionFile = child.getSessionFile()!;

		const pi = {
			sendUserMessage: vi.fn(),
		} as unknown as ExtensionAPI;
		const ctx = {
			sessionManager: child,
			isIdle: () => false,
		} as unknown as ExtensionContext;

		const poller = startChildMessagePoller(pi, ctx, { pollIntervalMs: 10_000 });

		const reopened = SessionManager.open(sessionFile);
		appendInterAgentUserMessage(reopened, {
			author: "root",
			recipient: "worker",
			content: "Steer now",
		});

		await poller.pollOnce();

		expect(pi.sendUserMessage).toHaveBeenCalledWith("[From root to worker]: Steer now", {
			deliverAs: "steer",
		});
		poller.stop();
	});

	it("pollOnce stops polling when thread_completed is present", async () => {
		const cwd = createWorkspace();
		const child = createThreadChildSession(cwd);
		const sessionFile = child.getSessionFile()!;

		const pi = {
			sendUserMessage: vi.fn(),
		} as unknown as ExtensionAPI;
		const ctx = {
			sessionManager: child,
			isIdle: () => true,
		} as unknown as ExtensionContext;

		const poller = startChildMessagePoller(pi, ctx, { pollIntervalMs: 10_000 });

		const reopened = SessionManager.open(sessionFile);
		writeThreadCompleted(reopened, { status: "completed" });

		await poller.pollOnce();

		expect(findLatestThreadCompleted(SessionManager.open(sessionFile).getEntries())?.status).toBe("completed");
		expect(pi.sendUserMessage).not.toHaveBeenCalled();

		const reopenedAfterStop = SessionManager.open(sessionFile);
		appendInterAgentUserMessage(reopenedAfterStop, {
			author: "root",
			recipient: "worker",
			content: "Too late",
		});
		await poller.pollOnce();
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});
});