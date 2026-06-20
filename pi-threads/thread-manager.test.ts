import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	findLatestThreadCompleted,
	writeThreadCompleted,
	writeThreadMeta,
} from "./persistence.ts";
import { pollThreadCompletions, ThreadManager } from "./thread-manager.ts";

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

	function createMockPi(): ExtensionAPI {
		return {
			appendEntry: vi.fn(),
			sendMessage: vi.fn(),
		} as unknown as ExtensionAPI;
	}

	function createMockProcess(options?: { exitImmediately?: boolean; exitCode?: number }): ChildProcess {
		const eventHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
		const proc = {
			stdout: { on: vi.fn() },
			stderr: { on: vi.fn() },
			on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				const handlers = eventHandlers.get(event) ?? [];
				handlers.push(handler);
				eventHandlers.set(event, handlers);
				if (options?.exitImmediately && event === "exit") {
					handler(options.exitCode ?? 0);
				}
			}),
			once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
				const wrapped = (...args: unknown[]) => {
					handler(...args);
					const handlers = eventHandlers.get(event) ?? [];
					eventHandlers.set(
						event,
						handlers.filter((item) => item !== wrapped),
					);
				};
				const handlers = eventHandlers.get(event) ?? [];
				handlers.push(wrapped);
				eventHandlers.set(event, handlers);
			}),
			kill: vi.fn(() => {
				for (const handler of eventHandlers.get("exit") ?? []) {
					handler(0);
				}
			}),
			exitCode: null,
			killed: false,
			pid: 4242,
		};
		return proc as unknown as ChildProcess;
	}

	function createContext(cwd: string, sessionId = "parent-session-id"): ExtensionContext {
		const parent = trackSession(SessionManager.create(cwd));
		return {
			cwd,
			sessionManager: parent,
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

	it("resume reports incomplete thread sessions and respawns subprocesses", async () => {
		const cwd = createWorkspace();
		const mockProcess = createMockProcess();
		const manager = new ThreadManager(createMockPi(), {
			spawner: {
				spawn: vi.fn(() => mockProcess),
			},
		});
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

		expect(result).toEqual({ incompleteCount: 1, totalThreadSessions: 2, resumedCount: 1 });
		expect(manager.getActiveThreads().has("thread-1")).toBe(true);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"pi-threads: 1 incomplete thread session(s); resumed 1 (full resumption: pi-threads-rf0)",
			"info",
		);
	});

	it("list returns thread summaries with status filtering", async () => {
		const cwd = createWorkspace();
		const manager = new ThreadManager(createMockPi());
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

	it("spawn creates thread session metadata and tracks active subprocess", async () => {
		const cwd = createWorkspace();
		const pi = createMockPi();
		const mockProcess = createMockProcess();
		const manager = new ThreadManager(pi, {
			spawner: {
				spawn: vi.fn(() => mockProcess),
			},
		});
		const ctx = createContext(cwd);

		const result = await manager.spawn(ctx, {
			task: "Research auth",
			thread_name: "researcher",
			agent_type: "researcher",
		});

		expect(result.thread_name).toBe("researcher");
		expect(result.thread_id).toBeTruthy();
		expect(manager.getActiveThreads().has(result.thread_id)).toBe(true);
		expect(pi.appendEntry).toHaveBeenCalled();
		expect(pi.sendMessage).toHaveBeenCalled();
	});

	it("pollThreadCompletions resolves when all threads complete", async () => {
		const statuses = new Map<string, "completed" | undefined>([
			["a", undefined],
			["b", undefined],
		]);
		let polls = 0;

		const result = await pollThreadCompletions(
			["a", "b"],
			(threadId) => {
				polls++;
				if (polls >= 2) {
					statuses.set("a", "completed");
					statuses.set("b", "completed");
				}
				return statuses.get(threadId);
			},
			{
				pollIntervalMs: 1,
				sleep: async () => {},
			},
		);

		expect(result.get("a")).toBe("completed");
		expect(result.get("b")).toBe("completed");
	});

	it("pollThreadCompletions throws on timeout", async () => {
		await expect(
			pollThreadCompletions(
				["slow-thread"],
				() => undefined,
				{
					timeoutMs: 5,
					pollIntervalMs: 1,
					sleep: async () => {},
				},
			),
		).rejects.toThrow("Timed out waiting for threads: slow-thread");
	});

	it("wait returns completion status from child session", async () => {
		const cwd = createWorkspace();
		const manager = new ThreadManager(createMockPi(), {
			sleep: async () => {},
		});
		const ctx = createContext(cwd);

		const child = trackSession(SessionManager.create(cwd));
		writeThreadMeta(child, {
			parent_id: "parent-1",
			thread_id: "thread-wait",
			thread_name: "worker",
			depth: 1,
			task: "Do work",
			agent_type: "worker",
		});
		writeThreadCompleted(child, { status: "completed" });
		persistSession(child);

		const result = await manager.wait(ctx, { thread_ids: ["thread-wait"], timeout: 1 });

		expect(result.threads).toHaveLength(1);
		expect(result.threads[0]?.status).toBe("completed");
	});

	it("interrupt marks thread aborted and removes it from active map", async () => {
		const cwd = createWorkspace();
		const pi = createMockPi();
		const mockProcess = createMockProcess();
		const manager = new ThreadManager(pi, {
			spawner: {
				spawn: vi.fn(() => mockProcess),
			},
			sleep: async () => {},
		});
		const ctx = createContext(cwd);

		const spawned = await manager.spawn(ctx, {
			task: "Run forever",
			thread_name: "runner",
			agent_type: "worker",
		});

		const result = await manager.interrupt(ctx, { thread_id: spawned.thread_id });

		expect(result.status).toBe("aborted");
		expect(manager.getActiveThreads().has(spawned.thread_id)).toBe(false);
		expect(pi.sendMessage).toHaveBeenCalled();

		const session = await import("./persistence.ts").then((mod) =>
			mod.findThreadSessionById(cwd, spawned.thread_id),
		);
		expect(session?.completion?.status).toBe("aborted");
	});

	it("registers active thread before subprocess handlers attach", async () => {
		const cwd = createWorkspace();
		const mockProcess = createMockProcess();
		const manager = new ThreadManager(createMockPi(), {
			spawner: {
				spawn: vi.fn(() => mockProcess),
			},
		});
		let recordVisibleOnExit = false;
		const eventHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
		(mockProcess.on as ReturnType<typeof vi.fn>).mockImplementation(
			(event: string, handler: (...args: unknown[]) => void) => {
				const handlers = eventHandlers.get(event) ?? [];
				handlers.push(handler);
				eventHandlers.set(event, handlers);
				if (event === "exit") {
					recordVisibleOnExit = manager.getActiveThreads().size > 0;
					handler(0);
				}
			},
		);
		const ctx = createContext(cwd);

		await manager.spawn(ctx, {
			task: "Fast exit",
			thread_name: "fast",
			agent_type: "worker",
		});

		expect(recordVisibleOnExit).toBe(true);
	});

	it("writes thread_completed when subprocess exits immediately", async () => {
		const cwd = createWorkspace();
		const mockProcess = createMockProcess({ exitImmediately: true, exitCode: 0 });
		const manager = new ThreadManager(createMockPi(), {
			spawner: {
				spawn: vi.fn(() => mockProcess),
			},
		});
		const ctx = createContext(cwd);

		const result = await manager.spawn(ctx, {
			task: "Fast exit",
			thread_name: "fast",
			agent_type: "worker",
		});

		await vi.waitFor(() => {
			const sessions = SessionManager.list(cwd);
			return sessions.then((listed) => {
				const session = listed.find((item) => item.id === result.thread_id);
				if (!session) return false;
				const manager = SessionManager.open(session.path);
				return findLatestThreadCompleted(manager.getEntries())?.status === "completed";
			});
		});

		const session = (await SessionManager.list(cwd)).find((item) => item.id === result.thread_id);
		expect(session).toBeTruthy();
		const childSession = SessionManager.open(session!.path);
		expect(findLatestThreadCompleted(childSession.getEntries())?.status).toBe("completed");
		expect(manager.getActiveThreads().has(result.thread_id)).toBe(false);
	});

	it("close rejects actively running threads", async () => {
		const cwd = createWorkspace();
		const manager = new ThreadManager(createMockPi(), {
			spawner: {
				spawn: vi.fn(() => createMockProcess()),
			},
		});
		const ctx = createContext(cwd);

		const spawned = await manager.spawn(ctx, {
			task: "Still running",
			thread_name: "runner",
			agent_type: "worker",
		});

		await expect(manager.close(ctx, { thread_id: spawned.thread_id })).rejects.toThrow(
			"Thread is still running",
		);
	});

	it("close rejects threads that are not completed", async () => {
		const cwd = createWorkspace();
		const manager = new ThreadManager(createMockPi());
		const ctx = createContext(cwd);

		const errored = trackSession(SessionManager.create(cwd));
		writeThreadMeta(errored, {
			parent_id: "parent-1",
			thread_id: "thread-error",
			thread_name: "failed",
			depth: 1,
			task: "Failed task",
			agent_type: "worker",
		});
		writeThreadCompleted(errored, { status: "error" });
		persistSession(errored);

		await expect(manager.close(ctx, { thread_id: "thread-error" })).rejects.toThrow(
			"Thread is not completed",
		);
	});

	it("close archives completed thread sessions", async () => {
		const cwd = createWorkspace();
		const pi = createMockPi();
		const manager = new ThreadManager(pi);
		const ctx = createContext(cwd);

		const child = trackSession(SessionManager.create(cwd));
		writeThreadMeta(child, {
			parent_id: "parent-1",
			thread_id: "thread-close",
			thread_name: "done",
			depth: 1,
			task: "Finished",
			agent_type: "worker",
		});
		writeThreadCompleted(child, { status: "completed" });
		persistSession(child);

		const result = await manager.close(ctx, { thread_id: "thread-close" });

		expect(result.status).toBe("closed");
		const reopened = SessionManager.open(child.getSessionFile()!);
		expect(findLatestThreadCompleted(reopened.getEntries())?.status).toBe("closed");
	});
});