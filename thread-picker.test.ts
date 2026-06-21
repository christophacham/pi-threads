import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeThreadMeta, writeThreadSpawnedDurable } from "./persistence.ts";
import { registerThreadPicker, ThreadNavigator } from "./thread-picker.ts";
import { ThreadManager } from "./thread-manager.ts";

describe("ThreadNavigator", () => {
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
		const dir = mkdtempSync(join(tmpdir(), "pi-threads-picker-test-"));
		tempDirs.push(dir);
		return dir;
	}

	function trackSession(manager: SessionManager): SessionManager {
		const sessionFile = manager.getSessionFile();
		if (sessionFile) sessionFiles.push(sessionFile);
		return manager;
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

	function createContext(cwd: string): ExtensionContext {
		const parent = trackSession(SessionManager.create(cwd));
		persistSession(parent);
		return {
			cwd,
			sessionManager: parent,
			ui: {
				notify: vi.fn(),
				select: vi.fn(),
				setStatus: vi.fn(),
			},
		} as unknown as ExtensionContext;
	}

	it("builds stable navigation list with main session first", async () => {
		const cwd = createWorkspace();
		const ctx = createContext(cwd);
		const parent = ctx.sessionManager as SessionManager;
		const parentPath = parent.getSessionFile()!;

		const child = trackSession(SessionManager.create(cwd));
		persistSession(child);
		writeThreadMeta(child, {
			parent_id: parent.getSessionId(),
			thread_id: child.getSessionId(),
			thread_name: "alpha",
			depth: 1,
			task: "first",
			agent_type: "worker",
		});
		writeThreadSpawnedDurable(parent, {
			thread_id: child.getSessionId(),
			thread_name: "alpha",
			parent_id: parent.getSessionId(),
			depth: 1,
			agent_type: "worker",
		});

		const beta = trackSession(SessionManager.create(cwd));
		persistSession(beta);
		writeThreadMeta(beta, {
			parent_id: parent.getSessionId(),
			thread_id: beta.getSessionId(),
			thread_name: "beta",
			depth: 1,
			task: "second",
			agent_type: "researcher",
		});
		writeThreadSpawnedDurable(parent, {
			thread_id: beta.getSessionId(),
			thread_name: "beta",
			parent_id: parent.getSessionId(),
			depth: 1,
			agent_type: "researcher",
		});

		const navigator = new ThreadNavigator();
		const manager = new ThreadManager({} as never);
		const entries = await navigator.refresh(ctx, manager);

		expect(entries.map((entry) => entry.thread_name)).toEqual(["Main", "alpha", "beta"]);
		expect(entries[0]?.path).toBe(parentPath);
		expect(entries[1]?.agent_type).toBe("worker");
	});

	it("formats status bar labels for main and thread sessions", async () => {
		const navigator = new ThreadNavigator();
		expect(
			navigator.formatStatusText({
				path: "/tmp/main.jsonl",
				thread_id: null,
				thread_name: "Main",
				status: "main",
			}),
		).toBe("Main");
		expect(
			navigator.formatStatusText({
				path: "/tmp/child.jsonl",
				thread_id: "t1",
				thread_name: "worker",
				agent_type: "coder",
				status: "running",
			}),
		).toBe("worker [coder]");
	});

	it("cycles through cached navigation entries", async () => {
		const cwd = createWorkspace();
		const ctx = createContext(cwd);
		const parent = ctx.sessionManager as SessionManager;

		const child = trackSession(SessionManager.create(cwd));
		persistSession(child);
		writeThreadMeta(child, {
			parent_id: parent.getSessionId(),
			thread_id: child.getSessionId(),
			thread_name: "alpha",
			depth: 1,
			task: "first",
			agent_type: "worker",
		});

		const navigator = new ThreadNavigator();
		const manager = new ThreadManager({} as never);
		await navigator.refresh(ctx, manager);

		const switchedPaths: string[] = [];
		const commandCtx = {
			...ctx,
			switchSession: vi.fn(async (path: string) => {
				switchedPaths.push(path);
				return { cancelled: false };
			}),
		};

		await navigator.cycle(commandCtx as never, 1, manager);
		expect(switchedPaths).toHaveLength(1);
		expect(navigator.getCurrentIndex()).toBe(1);

		await navigator.cycle(commandCtx as never, 1, manager);
		expect(switchedPaths).toHaveLength(2);
		expect(navigator.getCurrentIndex()).toBe(0);
	});
});

describe("registerThreadPicker commands", () => {
	function setupCommands(): {
		pi: ExtensionAPI;
		commands: Map<string, (ctx: ExtensionContext) => Promise<void>>;
	} {
		const commands = new Map<string, (ctx: ExtensionContext) => Promise<void>>();
		const pi = {
			registerCommand: vi.fn(
				(name: string, options: { handler: (_args: string, ctx: ExtensionContext) => Promise<void> }) => {
					commands.set(name, (ctx) => options.handler("", ctx));
				},
			),
			registerShortcut: vi.fn(),
			on: vi.fn(),
		} as unknown as ExtensionAPI;

		registerThreadPicker(pi, new ThreadManager({} as never));
		return { pi, commands };
	}

	it("does not register alt+left/alt+right shortcuts (tree nav collision)", () => {
		const { pi } = setupCommands();

		expect(pi.registerShortcut).not.toHaveBeenCalled();
	});

	it("registers /threads-prev and /threads-next commands", async () => {
		const { commands } = setupCommands();
		const ctx = {
			cwd: "/tmp",
			sessionManager: SessionManager.create("/tmp"),
			ui: { notify: vi.fn(), select: vi.fn(), setStatus: vi.fn() },
			switchSession: vi.fn(async () => ({ cancelled: false })),
		} as unknown as ExtensionContext;

		const prev = commands.get("threads-prev");
		const next = commands.get("threads-next");
		expect(prev).toBeDefined();
		expect(next).toBeDefined();

		const cycleSpy = vi.spyOn(ThreadNavigator.prototype, "cycle").mockResolvedValue();

		await prev!(ctx);
		expect(cycleSpy).toHaveBeenCalledWith(ctx, -1, expect.any(ThreadManager));

		await next!(ctx);
		expect(cycleSpy).toHaveBeenCalledWith(ctx, 1, expect.any(ThreadManager));

		cycleSpy.mockRestore();
	});
});
