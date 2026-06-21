import type { ChildProcess } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	findFirstThreadMeta,
	findLatestThreadCompleted,
	writeThreadCompleted,
	writeThreadMeta,
	writeThreadSpawnedDurable,
} from "./persistence.ts";
import { parseChildStdoutLine } from "./status-feed.ts";
import {
	createRingBuffer,
	KILL_SUBPROCESS_TIMEOUT_MS,
	PI_THREADS_EXTENSION_ENTRY,
	SIGKILL_TIMEOUT_MS,
	WAIT_POLL_INTERVAL_MS,
} from "./thread-subprocess.ts";
import {
	pollThreadCompletions,
	ThreadManager,
	ThreadWaitAbortedError,
	ThreadWaitTimeoutError,
	type WaitThreadUpdate,
} from "./thread-manager.ts";
import { setupSessionFixture } from "./test/fixtures/session.ts";
import { ThreadToolError, THREAD_TOOL_ERROR_CODES } from "./thread-tool-error.ts";
import { THREAD_ENTRY_TYPES, THREAD_TRANSCRIPT_TYPES } from "./types.ts";

const TEST_USAGE = {
	input: 10,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
};

describe("ThreadManager", () => {
	const { createWorkspace, trackSession, persistSession } = setupSessionFixture("pi-threads-manager-test-");

	function createMockPi(): ExtensionAPI {
		return {
			appendEntry: vi.fn(),
			sendMessage: vi.fn(),
		} as unknown as ExtensionAPI;
	}

	function createMockProcess(options?: {
		exitImmediately?: boolean;
		exitCode?: number;
		noExitOnKill?: boolean;
	}): ChildProcess {
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
				if (options?.noExitOnKill) return;
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

	function createContext(cwd: string): ExtensionContext {
		const parent = trackSession(SessionManager.create(cwd));
		return {
			cwd,
			sessionManager: parent,
			ui: {
				notify: vi.fn(),
			},
		} as unknown as ExtensionContext;
	}

	function parentSession(ctx: ExtensionContext): SessionManager {
		return ctx.sessionManager as SessionManager;
	}

	function createThreadSession(
		cwd: string,
		data: {
			thread_id: string;
			thread_name: string;
			task: string;
			status?: "completed" | "error" | "aborted" | "closed";
			usage?: typeof TEST_USAGE;
			model?: string;
		},
	): SessionManager {
		const session = trackSession(SessionManager.create(cwd));
		writeThreadMeta(session, {
			parent_id: "parent-1",
			thread_id: data.thread_id,
			thread_name: data.thread_name,
			depth: 1,
			task: data.task,
			agent_type: "worker",
		});
		if (data.status) {
			writeThreadCompleted(session, { status: data.status, usage: data.usage });
		}
		persistSession(session, data.model);
		return session;
	}

	function appendAssistantOutput(session: SessionManager, text: string): void {
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text }],
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

	describe("resume", () => {
		it("reports incomplete thread sessions and respawns subprocesses", async () => {
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
				"pi-threads: resumed 1 of 1 incomplete thread session(s)",
				"info",
			);
		});

		it("skips terminal sessions with completed, error, aborted, or closed status", async () => {
			const cwd = createWorkspace();
			const spawnMock = vi.fn(() => createMockProcess());
			const manager = new ThreadManager(createMockPi(), {
				spawner: { spawn: spawnMock },
			});
			const ctx = createContext(cwd);

			const incomplete = trackSession(SessionManager.create(cwd));
			writeThreadMeta(incomplete, {
				parent_id: "parent-1",
				thread_id: "thread-incomplete",
				thread_name: "runner",
				depth: 1,
				task: "Still running",
				agent_type: "worker",
			});
			persistSession(incomplete);

			for (const [threadId, status] of [
				["thread-completed", "completed"],
				["thread-error", "error"],
				["thread-aborted", "aborted"],
				["thread-closed", "closed"],
			] as const) {
				const session = trackSession(SessionManager.create(cwd));
				writeThreadMeta(session, {
					parent_id: "parent-1",
					thread_id: threadId,
					thread_name: threadId,
					depth: 1,
					task: "Done",
					agent_type: "worker",
				});
				writeThreadCompleted(session, { status });
				persistSession(session);
			}

			const result = await manager.resume(ctx);

			expect(result).toEqual({
				incompleteCount: 1,
				totalThreadSessions: 5,
				resumedCount: 1,
			});
			expect(spawnMock).toHaveBeenCalledTimes(1);
			expect(manager.getActiveThreads().has("thread-incomplete")).toBe(true);
		});

		it("respawns without injecting a new prompt", async () => {
			const cwd = createWorkspace();
			const spawnMock = vi.fn(() => createMockProcess());
			const manager = new ThreadManager(createMockPi(), {
				spawner: { spawn: spawnMock },
			});
			const ctx = createContext(cwd);

			const child = trackSession(SessionManager.create(cwd));
			writeThreadMeta(child, {
				parent_id: "parent-1",
				thread_id: "thread-resume",
				thread_name: "worker",
				depth: 1,
				task: "Continue work",
				agent_type: "worker",
			});
			persistSession(child);

			await manager.resume(ctx);

			expect(spawnMock).toHaveBeenCalledTimes(1);
			const resumeSpawnCall = spawnMock.mock.calls[0] as unknown as
				| [string, string[], { cwd: string }]
				| undefined;
			expect(resumeSpawnCall).toBeDefined();
			const args = resumeSpawnCall![1];
			expect(args).toContain("--session");
			expect(args).not.toContain("-p");
		});

		it("rebuilds parent-child tree from thread_spawned entries", async () => {
			const cwd = createWorkspace();
			const manager = new ThreadManager(createMockPi(), {
				spawner: { spawn: vi.fn(() => createMockProcess()) },
			});
			const ctx = createContext(cwd);
			const parentId = ctx.sessionManager.getSessionId();
			const parent = parentSession(ctx);

			writeThreadSpawnedDurable(
				{
					appendEntry: (customType, data) => parent.appendCustomEntry(customType, data),
				},
				{
					thread_id: "child-a",
					thread_name: "child-a",
					parent_id: parentId,
					depth: 1,
					agent_type: "worker",
				},
			);
			persistSession(parent);

			const child = trackSession(SessionManager.create(cwd));
			writeThreadMeta(child, {
				parent_id: parentId,
				thread_id: "child-a",
				thread_name: "child-a",
				depth: 1,
				task: "Child task",
				agent_type: "worker",
			});
			persistSession(child);

			await manager.resume(ctx);

			expect(manager.getThreadChildren(parentId)).toEqual(["child-a"]);
		});
	});

	describe("list", () => {
		it("excludes closed threads from default list and includes completed metadata", async () => {
			const cwd = createWorkspace();
			const manager = new ThreadManager(createMockPi());
			const ctx = createContext(cwd);

			createThreadSession(cwd, {
				thread_id: "thread-running",
				thread_name: "runner",
				task: "Run task",
				model: "claude-sonnet",
			});
			createThreadSession(cwd, {
				thread_id: "thread-completed",
				thread_name: "done",
				task: "Finished task",
				status: "completed",
				usage: TEST_USAGE,
				model: "gpt-4",
			});
			createThreadSession(cwd, {
				thread_id: "thread-error",
				thread_name: "failed",
				task: "Failed task",
				status: "error",
			});
			createThreadSession(cwd, {
				thread_id: "thread-aborted",
				thread_name: "stopped",
				task: "Aborted task",
				status: "aborted",
			});
			createThreadSession(cwd, {
				thread_id: "thread-closed",
				thread_name: "archived",
				task: "Old task",
				status: "closed",
			});

			const defaultList = await manager.list(ctx);
			expect(defaultList.map((item) => item.thread_id).sort()).toEqual([
				"thread-aborted",
				"thread-completed",
				"thread-error",
				"thread-running",
			]);
			expect(defaultList.find((item) => item.thread_id === "thread-completed")).toMatchObject({
				thread_name: "done",
				parent_id: "parent-1",
				depth: 1,
				status: "completed",
				task: "Finished task",
				usage: TEST_USAGE,
				model: "gpt-4",
			});
		});

		it("filters by running status", async () => {
			const cwd = createWorkspace();
			const manager = new ThreadManager(createMockPi());
			const ctx = createContext(cwd);

			createThreadSession(cwd, {
				thread_id: "thread-running",
				thread_name: "runner",
				task: "Run task",
			});
			createThreadSession(cwd, {
				thread_id: "thread-completed",
				thread_name: "done",
				task: "Finished task",
				status: "completed",
			});

			const runningOnly = await manager.list(ctx, { status: "running" });
			expect(runningOnly).toHaveLength(1);
			expect(runningOnly[0]?.thread_id).toBe("thread-running");
		});

		it("filters by completed status including closed threads", async () => {
			const cwd = createWorkspace();
			const manager = new ThreadManager(createMockPi());
			const ctx = createContext(cwd);

			createThreadSession(cwd, {
				thread_id: "thread-completed",
				thread_name: "done",
				task: "Finished task",
				status: "completed",
			});
			createThreadSession(cwd, {
				thread_id: "thread-closed",
				thread_name: "archived",
				task: "Old task",
				status: "closed",
			});

			const completedOnly = await manager.list(ctx, { status: "completed" });
			expect(completedOnly.map((item) => item.thread_id).sort()).toEqual([
				"thread-closed",
				"thread-completed",
			]);
		});

		it("filters by error status", async () => {
			const cwd = createWorkspace();
			const manager = new ThreadManager(createMockPi());
			const ctx = createContext(cwd);

			createThreadSession(cwd, {
				thread_id: "thread-error",
				thread_name: "failed",
				task: "Failed task",
				status: "error",
			});

			const errorOnly = await manager.list(ctx, { status: "error" });
			expect(errorOnly).toHaveLength(1);
			expect(errorOnly[0]?.thread_id).toBe("thread-error");
		});

		it("filters by aborted status", async () => {
			const cwd = createWorkspace();
			const manager = new ThreadManager(createMockPi());
			const ctx = createContext(cwd);

			createThreadSession(cwd, {
				thread_id: "thread-aborted",
				thread_name: "stopped",
				task: "Aborted task",
				status: "aborted",
			});

			const abortedOnly = await manager.list(ctx, { status: "aborted" });
			expect(abortedOnly).toHaveLength(1);
			expect(abortedOnly[0]?.thread_id).toBe("thread-aborted");
		});

		it("includes closed threads when status is all", async () => {
			const cwd = createWorkspace();
			const manager = new ThreadManager(createMockPi());
			const ctx = createContext(cwd);

			createThreadSession(cwd, {
				thread_id: "thread-running",
				thread_name: "runner",
				task: "Run task",
			});
			createThreadSession(cwd, {
				thread_id: "thread-completed",
				thread_name: "done",
				task: "Finished task",
				status: "completed",
			});
			createThreadSession(cwd, {
				thread_id: "thread-error",
				thread_name: "failed",
				task: "Failed task",
				status: "error",
			});
			createThreadSession(cwd, {
				thread_id: "thread-aborted",
				thread_name: "stopped",
				task: "Aborted task",
				status: "aborted",
			});
			createThreadSession(cwd, {
				thread_id: "thread-closed",
				thread_name: "archived",
				task: "Old task",
				status: "closed",
			});

			const allList = await manager.list(ctx, { status: "all" });
			expect(allList).toHaveLength(5);
		});
	});

	describe("spawn", () => {
		it("returns thread metadata and registers active thread", async () => {
			const cwd = createWorkspace();
			const pi = createMockPi();
			const mockProcess = createMockProcess();
			const spawnFn = vi.fn(() => mockProcess);
			const manager = new ThreadManager(pi, {
				spawner: {
					spawn: spawnFn,
				},
			});
			const ctx = createContext(cwd);

			const result = await manager.spawn(ctx, {
				task: "Research auth",
				thread_name: "researcher",
				agent_type: "researcher",
				model: "claude-sonnet",
				tools: ["read", "bash"],
				cwd,
			});

			expect(result).toEqual({
				thread_id: expect.any(String),
				thread_name: "researcher",
				agent_type: "researcher",
				task: "Research auth",
			});
			expect(manager.getActiveThreads().has(result.thread_id)).toBe(true);
		});

		it("creates child session with thread meta in default session dir", async () => {
			const cwd = createWorkspace();
			const manager = new ThreadManager(createMockPi(), {
				spawner: { spawn: vi.fn(() => createMockProcess()) },
			});
			const ctx = createContext(cwd);
			const parentId = ctx.sessionManager.getSessionId();

			const result = await manager.spawn(ctx, {
				task: "Research auth",
				thread_name: "researcher",
				agent_type: "researcher",
				cwd,
			});

			const listed = await SessionManager.list(cwd);
			const childInfo = listed.find((session) => session.id === result.thread_id);
			expect(childInfo).toBeTruthy();

			const childSession = SessionManager.open(childInfo!.path);
			expect(childSession.getHeader()?.parentSession).toBe(ctx.sessionManager.getSessionFile());
			expect(childSession.usesDefaultSessionDir()).toBe(true);
			expect(childSession.getSessionDir()).toContain("/sessions/");

			const firstCustom = childSession.getEntries().find((entry) => entry.type === "custom");
			expect(firstCustom).toMatchObject({
				type: "custom",
				customType: THREAD_ENTRY_TYPES.META,
				data: {
					parent_id: parentId,
					thread_id: result.thread_id,
					thread_name: "researcher",
					depth: 1,
					task: "Research auth",
					agent_type: "researcher",
				},
			});
			expect(findFirstThreadMeta(childSession.getEntries())?.parent_id).toBe(parentId);
		});

		it("spawns subprocess with session path, prompt, model, tools, and extension", async () => {
			const cwd = createWorkspace();
			const spawnFn = vi.fn(() => createMockProcess());
			const manager = new ThreadManager(createMockPi(), {
				spawner: { spawn: spawnFn },
			});
			const ctx = createContext(cwd);

			const result = await manager.spawn(ctx, {
				task: "Research auth",
				thread_name: "researcher",
				agent_type: "researcher",
				model: "claude-sonnet",
				tools: ["read", "bash"],
				cwd,
			});

			expect(spawnFn).toHaveBeenCalledTimes(1);
			const spawnCall = spawnFn.mock.calls[0] as unknown as [string, string[], { cwd: string }] | undefined;
			expect(spawnCall).toBeDefined();
			const args = spawnCall![1];
			const options = spawnCall![2];
			expect(options.cwd).toBe(cwd);

			const listed = await SessionManager.list(cwd);
			const childInfo = listed.find((session) => session.id === result.thread_id);

			const sessionIdx = args.indexOf("--session");
			expect(sessionIdx).toBeGreaterThanOrEqual(0);
			expect(args[sessionIdx + 1]).toBe(childInfo!.path);

			const promptIdx = args.indexOf("-p");
			expect(promptIdx).toBeGreaterThanOrEqual(0);
			expect(args[promptIdx + 1]).toBe("[From root to researcher]: Research auth");

			expect(args).toContain("--model");
			expect(args).toContain("claude-sonnet");
			expect(args).toContain("--tools");
			expect(args).toContain("read,bash");
			expect(args).toContain("--extension");
			expect(args).toContain(PI_THREADS_EXTENSION_ENTRY);
		});

		it("records spawned entry in parent transcript", async () => {
			const cwd = createWorkspace();
			const pi = createMockPi();
			const manager = new ThreadManager(pi, {
				spawner: { spawn: vi.fn(() => createMockProcess()) },
			});
			const ctx = createContext(cwd);
			const parentId = ctx.sessionManager.getSessionId();

			const result = await manager.spawn(ctx, {
				task: "Research auth",
				thread_name: "researcher",
				agent_type: "researcher",
				cwd,
			});

			expect(pi.appendEntry).toHaveBeenCalledWith(
				THREAD_ENTRY_TYPES.SPAWNED,
				expect.objectContaining({
					thread_id: result.thread_id,
					thread_name: "researcher",
					parent_id: parentId,
					depth: 1,
					agent_type: "researcher",
				}),
			);
			expect(pi.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					customType: THREAD_TRANSCRIPT_TYPES.SPAWNED,
					display: true,
				}),
				undefined,
			);
		});

		it("with fork_turns all copies parent branch entries into child", async () => {
			const cwd = createWorkspace();
			const manager = new ThreadManager(createMockPi(), {
				spawner: {
					spawn: vi.fn(() => createMockProcess()),
				},
			});
			const ctx = createContext(cwd);
			parentSession(ctx).appendMessage({
				role: "user",
				content: "parent-context",
				timestamp: Date.now(),
			});
			parentSession(ctx).appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "parent-reply" }],
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

			const result = await manager.spawn(ctx, {
				task: "Forked task",
				thread_name: "worker",
				agent_type: "worker",
				fork_turns: "all",
			});

			const listed = await SessionManager.list(cwd);
			const childInfo = listed.find((session) => session.id === result.thread_id);
			const childSession = SessionManager.open(childInfo!.path);
			const messageEntries = childSession.getEntries().filter((entry) => entry.type === "message");
			const userMessages = messageEntries
				.filter((entry) => entry.message.role === "user")
				.map((entry) => (entry.message.role === "user" ? entry.message.content : ""));
			const assistantTexts = messageEntries
				.filter((entry) => entry.message.role === "assistant")
				.map((entry) => {
					if (entry.message.role !== "assistant") return "";
					const textBlock = entry.message.content.find((block) => block.type === "text");
					return textBlock?.type === "text" ? textBlock.text : "";
				});

			expect(messageEntries).toHaveLength(3);
			expect(userMessages).toEqual(["parent-context"]);
			expect(assistantTexts).toEqual(["parent-reply", "thread session initialized"]);
		});

		it("defaults fork_turns to none (fresh context, no parent turn copy)", async () => {
			const cwd = createWorkspace();
			const manager = new ThreadManager(createMockPi(), {
				spawner: {
					spawn: vi.fn(() => createMockProcess()),
				},
			});
			const ctx = createContext(cwd);

			const withoutFork = await manager.spawn(ctx, {
				task: "Fresh task",
				thread_name: "worker",
				agent_type: "worker",
			});
			const withExplicitNone = await manager.spawn(ctx, {
				task: "Also fresh",
				thread_name: "worker-2",
				agent_type: "worker",
				fork_turns: "none",
			});

			for (const result of [withoutFork, withExplicitNone]) {
				const listed = await SessionManager.list(cwd);
				const childInfo = listed.find((session) => session.id === result.thread_id);
				const childSession = SessionManager.open(childInfo!.path);
				const messages = childSession
					.getEntries()
					.filter((entry) => entry.type === "message")
					.map((entry) => entry.message);
				expect(messages).toHaveLength(1);
				expect(messages[0]?.role).toBe("assistant");
			}
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
	});

	describe("pollThreadCompletions", () => {
		it("resolves when all threads complete", async () => {
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

		it("throws on timeout with partial results", async () => {
			const statuses = new Map<string, "completed" | undefined>([
				["fast-thread", "completed"],
				["slow-thread", undefined],
			]);

			let error: unknown;
			try {
				await pollThreadCompletions(
					["fast-thread", "slow-thread"],
					(threadId) => statuses.get(threadId),
					{
						timeoutMs: 5,
						pollIntervalMs: 1,
						sleep: async () => {},
					},
				);
			} catch (caught) {
				error = caught;
			}

			expect(error).toBeInstanceOf(ThreadWaitTimeoutError);
			expect(error).toMatchObject({
				message: "Timed out waiting for threads: slow-thread",
				pendingThreadIds: ["slow-thread"],
			});
			if (error instanceof ThreadWaitTimeoutError) {
				expect(error.partialResults.get("fast-thread")).toBe("completed");
			}
		});

		it("invokes onPoll between completion checks", async () => {
			let polls = 0;
			let reads = 0;

			const result = await pollThreadCompletions(
				["pending"],
				() => {
					reads++;
					return reads >= 2 ? "completed" : undefined;
				},
				{
					pollIntervalMs: 1,
					onPoll: () => {
						polls++;
					},
					sleep: async () => {},
				},
			);

				expect(result.get("pending")).toBe("completed");
			expect(polls).toBeGreaterThan(0);
		});

		it("throws when signal is aborted during polling", async () => {
			const controller = new AbortController();
			let polls = 0;

			const promise = pollThreadCompletions(
				["slow-thread"],
				() => {
					polls++;
					if (polls >= 1) controller.abort();
					return undefined;
				},
				{
					pollIntervalMs: 1,
					signal: controller.signal,
					sleep: async () => {},
				},
			);

			await expect(promise).rejects.toBeInstanceOf(ThreadWaitAbortedError);
			await expect(promise).rejects.toMatchObject({
				code: THREAD_TOOL_ERROR_CODES.ABORTED,
				message: "Wait aborted before threads completed: slow-thread",
				pendingThreadIds: ["slow-thread"],
			});
		});
	});

	describe("wait", () => {
		it("throws when aborted during polling", async () => {
			const cwd = createWorkspace();
			const pi = createMockPi();
			const controller = new AbortController();
			const manager = new ThreadManager(pi, {
				sleep: async () => {
					controller.abort();
				},
			});
			const ctx = createContext(cwd);

			const running = trackSession(SessionManager.create(cwd));
			writeThreadMeta(running, {
				parent_id: "parent-1",
				thread_id: "thread-running",
				thread_name: "runner",
				depth: 1,
				task: "Long task",
				agent_type: "worker",
			});
			persistSession(running);

			const record = {
				process: createMockProcess(),
				sessionFile: running.getSessionFile()!,
				threadName: "runner",
				status: "running" as const,
				agent_type: "worker",
				depth: 1,
				task: "Long task",
				stdoutBuffer: createRingBuffer(16),
				stderrBuffer: createRingBuffer(16),
				activityBuffer: createRingBuffer(16),
			};
			(manager as unknown as { threads: Map<string, typeof record> }).threads.set("thread-running", record);

			await expect(
				manager.wait(ctx, { thread_ids: ["thread-running"] }, undefined, controller.signal),
			).rejects.toBeInstanceOf(ThreadWaitAbortedError);

			expect(manager.getActiveThreads().has("thread-running")).toBe(true);
		});

		it("returns completed thread summaries with output", async () => {
			const cwd = createWorkspace();
			const pi = createMockPi();
			const manager = new ThreadManager(pi, {
				sleep: async () => {},
			});
			const ctx = createContext(cwd);

			const alpha = trackSession(SessionManager.create(cwd));
			writeThreadMeta(alpha, {
				parent_id: "parent-1",
				thread_id: "thread-alpha",
				thread_name: "alpha",
				depth: 1,
				task: "Task A",
				agent_type: "worker",
			});
			writeThreadCompleted(alpha, { status: "completed" });
			persistSession(alpha);
			appendAssistantOutput(alpha, "alpha output");

			const beta = trackSession(SessionManager.create(cwd));
			writeThreadMeta(beta, {
				parent_id: "parent-1",
				thread_id: "thread-beta",
				thread_name: "beta",
				depth: 1,
				task: "Task B",
				agent_type: "researcher",
			});
			writeThreadCompleted(beta, { status: "error" });
			persistSession(beta);
			appendAssistantOutput(beta, "beta output");

			const result = await manager.wait(ctx, {
				thread_ids: ["thread-alpha", "thread-beta"],
				timeout: 2,
			});

			expect(result.threads).toHaveLength(2);
			expect(result.threads).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						thread_id: "thread-alpha",
						thread_name: "alpha",
						status: "completed",
						output: "alpha output",
						task: "Task A",
					}),
					expect.objectContaining({
						thread_id: "thread-beta",
						thread_name: "beta",
						status: "error",
						output: "beta output",
						task: "Task B",
					}),
				]),
			);
		});

		it("emits wait transcript messages for started and finished phases", async () => {
			const cwd = createWorkspace();
			const pi = createMockPi();
			const manager = new ThreadManager(pi, {
				sleep: async () => {},
			});
			const ctx = createContext(cwd);

			const alpha = trackSession(SessionManager.create(cwd));
			writeThreadMeta(alpha, {
				parent_id: "parent-1",
				thread_id: "thread-alpha",
				thread_name: "alpha",
				depth: 1,
				task: "Task A",
				agent_type: "worker",
			});
			writeThreadCompleted(alpha, { status: "completed" });
			persistSession(alpha);

			const beta = trackSession(SessionManager.create(cwd));
			writeThreadMeta(beta, {
				parent_id: "parent-1",
				thread_id: "thread-beta",
				thread_name: "beta",
				depth: 1,
				task: "Task B",
				agent_type: "researcher",
			});
			writeThreadCompleted(beta, { status: "error" });
			persistSession(beta);

			await manager.wait(ctx, {
				thread_ids: ["thread-alpha", "thread-beta"],
				timeout: 2,
			});

			const waitCalls = vi
				.mocked(pi.sendMessage)
				.mock.calls.filter(([message]) => message.customType === THREAD_TRANSCRIPT_TYPES.WAIT);

			expect(waitCalls).toHaveLength(4);
			expect(waitCalls[0]?.[0]).toMatchObject({
				customType: THREAD_TRANSCRIPT_TYPES.WAIT,
				content: "Waiting for alpha: Running",
				display: true,
				details: {
					kind: "Interacted",
					thread_id: "thread-alpha",
					thread_name: "alpha",
					agent_type: "worker",
					phase: "started",
					status: "Running",
				},
			});
			expect(waitCalls[1]?.[0]).toMatchObject({
				content: "Waiting for beta: Running",
				details: expect.objectContaining({
					thread_id: "thread-beta",
					thread_name: "beta",
					phase: "started",
				}),
			});
			expect(waitCalls[2]?.[0]).toMatchObject({
				content: "Finished waiting → alpha: completed",
				details: expect.objectContaining({
					thread_id: "thread-alpha",
					phase: "finished",
					status: "completed",
				}),
			});
			expect(waitCalls[3]?.[0]).toMatchObject({
				content: "Finished waiting → beta: error",
				details: expect.objectContaining({
					thread_id: "thread-beta",
					phase: "finished",
					status: "error",
				}),
			});
		});

		it("calls onUpdate while polling and uses 500ms poll interval", async () => {
			const cwd = createWorkspace();
			const pi = createMockPi();
			const sleepCalls: number[] = [];
			let pollCount = 0;
			const child = createThreadSession(cwd, {
				thread_id: "thread-poll",
				thread_name: "runner",
				task: "Running",
			});
			const manager = new ThreadManager(pi, {
				sleep: async (ms) => {
					sleepCalls.push(ms);
					pollCount++;
					if (pollCount === 1) {
						writeThreadCompleted(SessionManager.open(child.getSessionFile()!), { status: "completed" });
					}
				},
			});
			const ctx = createContext(cwd);

			const onUpdates: WaitThreadUpdate[] = [];
			const result = await manager.wait(
				ctx,
				{ thread_ids: ["thread-poll"] },
				(update) => onUpdates.push(update),
			);

			expect(onUpdates.length).toBeGreaterThan(0);
			expect(onUpdates[0]?.waiting).toEqual([
				{
					thread_id: "thread-poll",
					thread_name: "runner",
					agent_type: "worker",
					task: "Running",
					status: "running",
					activities: [],
				},
			]);
			expect(sleepCalls).toContain(WAIT_POLL_INTERVAL_MS);
			expect(result.threads[0]).toMatchObject({
				thread_id: "thread-poll",
				thread_name: "runner",
				status: "completed",
			});
		});

		it("times out when threads do not complete", async () => {
			const cwd = createWorkspace();
			const manager = new ThreadManager(createMockPi(), {
				sleep: async () => {},
			});
			const ctx = createContext(cwd);

			createThreadSession(cwd, {
				thread_id: "thread-slow",
				thread_name: "slow",
				task: "Never finishes",
			});

			await expect(
				manager.wait(ctx, { thread_ids: ["thread-slow"], timeout: 0.001 }),
			).rejects.toThrow("Timed out waiting for threads: thread-slow");
		});

		it("timeout reconciles stale active map entries for completed threads", async () => {
			const cwd = createWorkspace();
			const pi = createMockPi();
			const manager = new ThreadManager(pi, {
				spawner: {
					spawn: vi.fn(() => createMockProcess()),
				},
				sleep: async () => {},
			});
			const ctx = createContext(cwd);

			const fast = await manager.spawn(ctx, {
				task: "Finish quickly",
				thread_name: "fast",
				agent_type: "worker",
			});
			const slow = await manager.spawn(ctx, {
				task: "Keep running",
				thread_name: "slow",
				agent_type: "worker",
			});

			const fastRecord = manager.getActiveThreads().get(fast.thread_id)!;
			writeThreadCompleted(SessionManager.open(fastRecord.sessionFile), { status: "completed" });

			await expect(
				manager.wait(ctx, { thread_ids: [fast.thread_id, slow.thread_id], timeout: 0.001 }),
			).rejects.toThrow("Timed out waiting for threads: " + slow.thread_id);

			expect(manager.getActiveThreads().has(fast.thread_id)).toBe(false);
			expect(manager.getActiveThreads().has(slow.thread_id)).toBe(true);

			const summaries = await manager.list(ctx);
			expect(summaries.find((item) => item.thread_id === fast.thread_id)?.status).toBe("completed");
			expect(summaries.find((item) => item.thread_id === slow.thread_id)?.status).toBe("running");

			await expect(
				manager.send(ctx, { thread_id: slow.thread_id, message: "continue" }),
			).resolves.toEqual({
				thread_id: slow.thread_id,
				thread_name: "slow",
			});
		});

		it("rejects unknown thread ids", async () => {
			const cwd = createWorkspace();
			const manager = new ThreadManager(createMockPi(), {
				sleep: async () => {},
			});
			const ctx = createContext(cwd);

			let error: unknown;
			try {
				await manager.wait(ctx, { thread_ids: ["missing-thread"] });
			} catch (caught) {
				error = caught;
			}
			expect(error).toBeInstanceOf(ThreadToolError);
			expect(error).toMatchObject({
				code: THREAD_TOOL_ERROR_CODES.THREAD_NOT_FOUND,
				message: "Thread not found: missing-thread",
				details: { code: THREAD_TOOL_ERROR_CODES.THREAD_NOT_FOUND, thread_id: "missing-thread" },
			});
		});
	});

	describe("interrupt", () => {
		it("completes when subprocess never emits exit", async () => {
			vi.useFakeTimers();
			try {
				const cwd = createWorkspace();
				const pi = createMockPi();
				const mockProcess = createMockProcess({ noExitOnKill: true });
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

				const interruptPromise = manager.interrupt(ctx, { thread_id: spawned.thread_id });
				await vi.advanceTimersByTimeAsync(SIGKILL_TIMEOUT_MS);
				expect(mockProcess.kill).toHaveBeenCalledWith("SIGKILL");

				await vi.advanceTimersByTimeAsync(KILL_SUBPROCESS_TIMEOUT_MS - SIGKILL_TIMEOUT_MS);
				const result = await interruptPromise;

				expect(result).toEqual({
					thread_id: spawned.thread_id,
					thread_name: "runner",
					status: "aborted",
				});
				expect(manager.getActiveThreads().has(spawned.thread_id)).toBe(false);
				expect(mockProcess.kill).toHaveBeenCalledWith("SIGTERM");
			} finally {
				vi.useRealTimers();
			}
		});

		it("aborts running thread and clears active map", async () => {
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

			expect(result).toEqual({
				thread_id: spawned.thread_id,
				thread_name: "runner",
				status: "aborted",
			});
			expect(manager.getActiveThreads().has(spawned.thread_id)).toBe(false);
			expect(mockProcess.kill).toHaveBeenCalledWith("SIGTERM");
		});

		it("records interrupted transcript and persists aborted status", async () => {
			const cwd = createWorkspace();
			const pi = createMockPi();
			const manager = new ThreadManager(pi, {
				spawner: {
					spawn: vi.fn(() => createMockProcess()),
				},
				sleep: async () => {},
			});
			const ctx = createContext(cwd);

			const spawned = await manager.spawn(ctx, {
				task: "Run forever",
				thread_name: "runner",
				agent_type: "worker",
			});

			await manager.interrupt(ctx, { thread_id: spawned.thread_id });

			const interruptedCall = vi
				.mocked(pi.sendMessage)
				.mock.calls.find(([message]) => message.customType === THREAD_TRANSCRIPT_TYPES.INTERRUPTED);
			expect(interruptedCall?.[0]).toMatchObject({
				customType: THREAD_TRANSCRIPT_TYPES.INTERRUPTED,
				content: "Interrupted runner",
				display: true,
				details: {
					kind: "Interrupted",
					thread_id: spawned.thread_id,
					thread_name: "runner",
					agent_type: "worker",
				},
			});

			const session = await import("./persistence.ts").then((mod) =>
				mod.findThreadSessionById(cwd, spawned.thread_id),
			);
			expect(session?.completion?.status).toBe("aborted");
		});

		it("rejects interrupt on non-running thread", async () => {
			const cwd = createWorkspace();
			const pi = createMockPi();
			const manager = new ThreadManager(pi, {
				spawner: {
					spawn: vi.fn(() => createMockProcess()),
				},
				sleep: async () => {},
			});
			const ctx = createContext(cwd);

			const spawned = await manager.spawn(ctx, {
				task: "Run forever",
				thread_name: "runner",
				agent_type: "worker",
			});

			await manager.interrupt(ctx, { thread_id: spawned.thread_id });

			await expect(manager.interrupt(ctx, { thread_id: spawned.thread_id })).rejects.toThrow(
				"Thread is not running",
			);
		});
	});

	describe("close", () => {
		it("rejects actively running threads", async () => {
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

		it("rejects threads that are not completed", async () => {
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

		it("marks completed thread as closed and updates list visibility", async () => {
			const cwd = createWorkspace();
			const pi = createMockPi();
			const manager = new ThreadManager(pi);
			const ctx = createContext(cwd);

			const child = createThreadSession(cwd, {
				thread_id: "thread-close",
				thread_name: "done",
				task: "Finished",
				status: "completed",
			});

			const result = await manager.close(ctx, { thread_id: "thread-close" });

			expect(result).toEqual({
				thread_id: "thread-close",
				thread_name: "done",
				status: "closed",
			});

			const reopened = SessionManager.open(child.getSessionFile()!);
			expect(findLatestThreadCompleted(reopened.getEntries())?.status).toBe("closed");

			const defaultList = await manager.list(ctx);
			expect(defaultList.some((item) => item.thread_id === "thread-close")).toBe(false);

			const completedList = await manager.list(ctx, { status: "completed" });
			expect(completedList.some((item) => item.thread_id === "thread-close")).toBe(true);
		});

		it("records closed transcript message", async () => {
			const cwd = createWorkspace();
			const pi = createMockPi();
			const manager = new ThreadManager(pi);
			const ctx = createContext(cwd);

			createThreadSession(cwd, {
				thread_id: "thread-close",
				thread_name: "done",
				task: "Finished",
				status: "completed",
			});

			await manager.close(ctx, { thread_id: "thread-close" });

			expect(pi.sendMessage).toHaveBeenCalledWith({
				customType: THREAD_TRANSCRIPT_TYPES.CLOSED,
				content: "Closed done",
				display: true,
				details: {
					kind: "Closed",
					thread_id: "thread-close",
					thread_name: "done",
					agent_type: "worker",
					customType: THREAD_TRANSCRIPT_TYPES.CLOSED,
				},
			});
		});
	});

	describe("send", () => {
		it("delivers message to running thread and records transcript", async () => {
			const cwd = createWorkspace();
			const pi = createMockPi();
			const mockProcess = createMockProcess();
			const manager = new ThreadManager(pi, {
				spawner: {
					spawn: vi.fn(() => mockProcess),
				},
			});
			const ctx = createContext(cwd);

			const spawned = await manager.spawn(ctx, {
				task: "Initial work",
				thread_name: "worker",
				agent_type: "worker",
			});

			const result = await manager.send(ctx, {
				thread_id: spawned.thread_id,
				message: "Please continue with tests",
			});

			expect(result).toEqual({
				thread_id: spawned.thread_id,
				thread_name: "worker",
			});

			const childSession = SessionManager.open(manager.getActiveThreads().get(spawned.thread_id)!.sessionFile);
			const userMessages = childSession
				.getEntries()
				.filter((entry) => entry.type === "message" && entry.message.role === "user")
				.map((entry) =>
					entry.type === "message" && entry.message.role === "user" ? entry.message.content : "",
				);
			expect(userMessages).toContain("[From root to worker]: Please continue with tests");

			expect(pi.appendEntry).toHaveBeenCalledWith(
				THREAD_TRANSCRIPT_TYPES.SEND,
				expect.objectContaining({
					kind: "Interacted",
					thread_id: spawned.thread_id,
					thread_name: "worker",
					agent_type: "worker",
					message_preview: "Please continue with tests",
				}),
			);
			expect(pi.sendMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					customType: THREAD_TRANSCRIPT_TYPES.SEND,
					content: "Sent input to worker: Please continue with tests",
					display: true,
					details: expect.objectContaining({
						kind: "Interacted",
						thread_id: spawned.thread_id,
						thread_name: "worker",
					}),
				}),
			);
		});

		it("rejects unknown thread", async () => {
			const cwd = createWorkspace();
			const manager = new ThreadManager(createMockPi());
			const ctx = createContext(cwd);

			await expect(
				manager.send(ctx, { thread_id: "missing-thread", message: "hello" }),
			).rejects.toThrow("Thread not found");
		});

		it("rejects non-running thread", async () => {
			const cwd = createWorkspace();
			const manager = new ThreadManager(createMockPi());
			const ctx = createContext(cwd);

			createThreadSession(cwd, {
				thread_id: "thread-done",
				thread_name: "done",
				task: "Finished",
				status: "completed",
			});

			await expect(
				manager.send(ctx, { thread_id: "thread-done", message: "hello" }),
			).rejects.toThrow("Thread is not running");
		});
	});

	describe("getStatusFeed", () => {
		it("returns parsed tool activity lines from child stdout", () => {
			const manager = new ThreadManager(createMockPi());
			const stdoutLine = JSON.stringify({
				type: "tool_execution_start",
				toolCallId: "call_1",
				toolName: "read",
				args: { path: "src/index.ts" },
			});

			const record = {
				process: null,
				sessionFile: "/tmp/thread.jsonl",
				threadName: "worker",
				status: "running" as const,
				agent_type: "worker",
				depth: 1,
				task: "scan",
				stdoutBuffer: createRingBuffer(10),
				stderrBuffer: createRingBuffer(10),
				activityBuffer: createRingBuffer(10),
			};
			(manager as unknown as { threads: Map<string, typeof record> }).threads.set("thread-1", record);

			const activity = parseChildStdoutLine(stdoutLine);
			expect(activity).toBe("read src/index.ts");
			if (activity) {
				record.activityBuffer.lines.push(activity);
			}

			expect(manager.getStatusFeed()).toEqual([
				{
					thread_id: "thread-1",
					thread_name: "worker",
					status: "running",
					lines: ["read src/index.ts"],
				},
			]);
		});
	});
});