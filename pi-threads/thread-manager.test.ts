import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	findFirstThreadMeta,
	findLatestThreadCompleted,
	writeThreadCompleted,
	writeThreadMeta,
	writeThreadSpawnedDurable,
} from "./persistence.ts";
import { PI_THREADS_EXTENSION_ENTRY, WAIT_POLL_INTERVAL_MS } from "./thread-subprocess.ts";
import { pollThreadCompletions, ThreadManager, type WaitThreadUpdate } from "./thread-manager.ts";
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

	function persistSession(manager: SessionManager, model = "test"): void {
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "persist" }],
			api: "test",
			provider: "test",
			model,
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
			"pi-threads: resumed 1 of 1 incomplete thread session(s)",
			"info",
		);
	});

	it("resume skips terminal sessions with completed, error, aborted, or closed status", async () => {
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

	it("resume respawns without injecting a new prompt", async () => {
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

	it("resume rebuilds parent-child tree from thread_spawned entries", async () => {
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

	it("list meets list_threads acceptance criteria", async () => {
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

		const runningOnly = await manager.list(ctx, { status: "running" });
		expect(runningOnly).toHaveLength(1);
		expect(runningOnly[0]?.thread_id).toBe("thread-running");

		const completedOnly = await manager.list(ctx, { status: "completed" });
		expect(completedOnly.map((item) => item.thread_id).sort()).toEqual([
			"thread-closed",
			"thread-completed",
		]);

		const errorOnly = await manager.list(ctx, { status: "error" });
		expect(errorOnly).toHaveLength(1);
		expect(errorOnly[0]?.thread_id).toBe("thread-error");

		const abortedOnly = await manager.list(ctx, { status: "aborted" });
		expect(abortedOnly).toHaveLength(1);
		expect(abortedOnly[0]?.thread_id).toBe("thread-aborted");

		const allList = await manager.list(ctx, { status: "all" });
		expect(allList).toHaveLength(5);
	});

	it("spawn meets spawn_thread acceptance criteria", async () => {
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
		const parentId = ctx.sessionManager.getSessionId();

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
		});
		expect(manager.getActiveThreads().has(result.thread_id)).toBe(true);

		const listed = await SessionManager.list(cwd);
		const childInfo = listed.find((session) => session.id === result.thread_id);
		expect(childInfo).toBeTruthy();

		const childSession = SessionManager.open(childInfo!.path);
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

		expect(spawnFn).toHaveBeenCalledTimes(1);
		const spawnCall = spawnFn.mock.calls[0] as unknown as [string, string[], { cwd: string }] | undefined;
		expect(spawnCall).toBeDefined();
		const args = spawnCall![1];
		const options = spawnCall![2];
		expect(options.cwd).toBe(cwd);

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

	it("spawn with fork_turns all copies parent branch entries into child", async () => {
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

	it("spawn defaults fork_turns to none (fresh context, no parent turn copy)", async () => {
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

	it("pollThreadCompletions invokes onPoll between completion checks", async () => {
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

	it("wait meets wait_thread acceptance criteria", async () => {
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
				{
					thread_id: "thread-alpha",
					thread_name: "alpha",
					status: "completed",
					output: "alpha output",
				},
				{
					thread_id: "thread-beta",
					thread_name: "beta",
					status: "error",
					output: "beta output",
				},
			]),
		);

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

	it("wait calls onUpdate while polling and uses 500ms poll interval", async () => {
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
				name: "runner",
				status: "running",
				lastActivity: undefined,
			},
		]);
		expect(sleepCalls).toContain(WAIT_POLL_INTERVAL_MS);
		expect(result.threads[0]).toMatchObject({
			thread_id: "thread-poll",
			thread_name: "runner",
			status: "completed",
		});
	});

	it("wait times out when threads do not complete", async () => {
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

	it("wait rejects unknown thread ids", async () => {
		const cwd = createWorkspace();
		const manager = new ThreadManager(createMockPi(), {
			sleep: async () => {},
		});
		const ctx = createContext(cwd);

		await expect(manager.wait(ctx, { thread_ids: ["missing-thread"] })).rejects.toThrow(
			"Thread not found: missing-thread",
		);
	});

	it("interrupt meets interrupt_thread acceptance criteria", async () => {
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

		await expect(manager.interrupt(ctx, { thread_id: spawned.thread_id })).rejects.toThrow(
			"Thread is not running",
		);
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

	it("send meets send_to_thread acceptance criteria", async () => {
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

		await expect(
			manager.send(ctx, { thread_id: "missing-thread", message: "hello" }),
		).rejects.toThrow("Thread not found");

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

	it("close meets close_thread acceptance criteria", async () => {
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

		const reopened = SessionManager.open(child.getSessionFile()!);
		expect(findLatestThreadCompleted(reopened.getEntries())?.status).toBe("closed");

		const defaultList = await manager.list(ctx);
		expect(defaultList.some((item) => item.thread_id === "thread-close")).toBe(false);

		const completedList = await manager.list(ctx, { status: "completed" });
		expect(completedList.some((item) => item.thread_id === "thread-close")).toBe(true);
	});
});