import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeThreadCompleted, writeThreadMeta } from "./persistence.ts";
import { ThreadManager } from "./thread-manager.ts";

describe("ThreadManager", () => {
	const tempDirs: string[] = [];
	const sessionFiles: string[] = [];

	afterEach(() => {
		for (const file of sessionFiles.splice(0)) {
			rmSync(file, { force: true });
		}
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function createWorkspace(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-threads-manager-test-"));
		tempDirs.push(dir);
		return dir;
	}

	function trackSession(manager: SessionManager): SessionManager {
		const sessionFile = manager.getSessionFile();
		if (sessionFile) sessionFiles.push(sessionFile);
		return manager;
	}

	function createContext(cwd: string): ExtensionContext {
		return {
			cwd,
			ui: {
				notify: vi.fn(),
			},
		} as unknown as ExtensionContext;
	}

	function persistSession(manager: SessionManager): void {
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "persist" }],
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
	}

	it("resume reports incomplete thread sessions", async () => {
		const cwd = createWorkspace();
		const manager = new ThreadManager();
		const ctx = createContext(cwd);

		const child = trackSession(SessionManager.create(cwd));
		writeThreadMeta(child, {
			parent_id: "parent-1",
			thread_id: "thread-1",
			thread_name: "researcher",
			depth: 1,
			task: "Find TODOs",
			agent_type: "researcher",
		});
		persistSession(child);

		const completed = trackSession(SessionManager.create(cwd));
		writeThreadMeta(completed, {
			parent_id: "parent-1",
			thread_id: "thread-2",
			thread_name: "done-agent",
			depth: 1,
			task: "Already done",
			agent_type: "worker",
		});
		writeThreadCompleted(completed, { status: "completed" });
		persistSession(completed);

		const result = await manager.resume(ctx);

		expect(result).toEqual({ incompleteCount: 1, totalThreadSessions: 2 });
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"pi-threads: 1 incomplete thread session(s) found (full resumption: pi-threads-rf0)",
			"info",
		);
	});

	it("list returns thread summaries with status filtering", async () => {
		const cwd = createWorkspace();
		const manager = new ThreadManager();
		const ctx = createContext(cwd);

		const running = trackSession(SessionManager.create(cwd));
		writeThreadMeta(running, {
			parent_id: "parent-1",
			thread_id: "thread-running",
			thread_name: "runner",
			depth: 1,
			task: "Run task",
			agent_type: "worker",
		});
		persistSession(running);

		const closed = trackSession(SessionManager.create(cwd));
		writeThreadMeta(closed, {
			parent_id: "parent-1",
			thread_id: "thread-closed",
			thread_name: "archived",
			depth: 1,
			task: "Old task",
			agent_type: "worker",
		});
		writeThreadCompleted(closed, { status: "closed" });
		persistSession(closed);

		const defaultList = await manager.list(ctx);
		expect(defaultList).toHaveLength(1);
		expect(defaultList[0]?.thread_id).toBe("thread-running");
		expect(defaultList[0]?.status).toBe("running");

		const allList = await manager.list(ctx, { status: "all" });
		expect(allList).toHaveLength(2);
	});

	it("unimplemented lifecycle methods throw w9k marker", async () => {
		const manager = new ThreadManager();
		const ctx = createContext(createWorkspace());

		await expect(manager.spawn(ctx, {
			task: "t",
			thread_name: "n",
			agent_type: "a",
		})).rejects.toThrow("pi-threads-w9k");
	});
});