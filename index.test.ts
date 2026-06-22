import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionStartEvent, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendInterAgentUserMessage, writeThreadMeta } from "./persistence.ts";
import { STATUS_FEED_WIDGET_ID } from "./status-feed.ts";
import type { StatusFeedEntry } from "./thread-manager.ts";

const bindContext = vi.fn();
let statusFeedListener: (() => void) | undefined;
let statusFeed: StatusFeedEntry[] = [];

const resume = vi.fn().mockImplementation(async () => {
	statusFeed = [
		{
			thread_id: "t1",
			thread_name: "worker",
			status: "running",
			lines: ["read src/index.ts"],
		},
	];
	statusFeedListener?.();
});

vi.mock("./thread-manager.ts", () => ({
	ThreadManager: vi.fn().mockImplementation(() => ({
		bindContext,
		resume,
		setStatusFeedListener: vi.fn((listener: (() => void) | undefined) => {
			statusFeedListener = listener;
		}),
		getActiveThreads: vi.fn(() => new Map()),
		getStatusFeed: vi.fn(() => statusFeed),
		getThreadChildren: vi.fn(() => []),
	})),
}));

import registerExtension, { shouldRespawnThreadsOnSessionStart } from "./index.ts";

function createTheme(): Theme {
	const fg = (color: string, text: string) => `[${color}]${text}[/]`;
	return {
		fg,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => `**${text}**`,
	} as unknown as Theme;
}

function renderWidgetFactory(factory: unknown, width = 120): string {
	if (typeof factory !== "function") return "";
	const component = (factory as (_tui: unknown, theme: Theme) => Component)(undefined, createTheme());
	return component.render(width).join("\n");
}

describe("pi-threads extension session lifecycle", () => {
	const tempDirs: string[] = [];
	const sessionFiles: string[] = [];
	let intervalCount = 0;

	afterEach(() => {
		for (const file of sessionFiles.splice(0)) {
			rmSync(file, { force: true });
		}
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
		vi.mocked(globalThis.setInterval).mockRestore();
		vi.mocked(globalThis.clearInterval).mockRestore();
		intervalCount = 0;
		vi.clearAllMocks();
	});

	beforeEach(() => {
		statusFeed = [];
		statusFeedListener = undefined;

		const originalSetInterval = globalThis.setInterval.bind(globalThis);
		const originalClearInterval = globalThis.clearInterval.bind(globalThis);

		vi.spyOn(globalThis, "setInterval").mockImplementation((handler, timeout, ...args) => {
			intervalCount++;
			return originalSetInterval(handler, timeout, ...args);
		});
		vi.spyOn(globalThis, "clearInterval").mockImplementation((id) => {
			intervalCount--;
			originalClearInterval(id);
		});
	});

	function createWorkspace(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-threads-index-test-"));
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

	function createContextBase(cwd: string, sessionManager: SessionManager): ExtensionContext {
		const setWidget = vi.fn();
		const requestRender = vi.fn();
		return {
			cwd,
			sessionManager,
			hasUI: true,
			isIdle: () => true,
			ui: {
				notify: vi.fn(),
				select: vi.fn(),
				setStatus: vi.fn(),
				setWidget,
				requestRender,
			},
		} as unknown as ExtensionContext;
	}

	function createParentContext(cwd: string): ExtensionContext {
		const parent = trackSession(SessionManager.create(cwd));
		persistSession(parent);
		return createContextBase(cwd, parent);
	}

	function createChildContext(cwd: string, threadId: string, threadName: string): ExtensionContext {
		const child = trackSession(SessionManager.create(cwd));
		writeThreadMeta(child, {
			parent_id: "parent-1",
			thread_id: threadId,
			thread_name: threadName,
			depth: 1,
			task: "Initial task",
			agent_type: "worker",
		});
		appendInterAgentUserMessage(child, {
			author: "root",
			recipient: threadName,
			content: "Initial task",
		});
		persistSession(child);
		return createContextBase(cwd, child);
	}

	function createMockPi() {
		const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
		const pi = {
			on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			}),
			registerFlag: vi.fn(),
			registerMessageRenderer: vi.fn(),
			registerTool: vi.fn(),
			registerCommand: vi.fn(),
			registerShortcut: vi.fn(),
			getFlag: vi.fn(() => "10000"),
			sendUserMessage: vi.fn(),
			appendEntry: vi.fn(),
		} as unknown as ExtensionAPI;

		return {
			pi,
			async emit(event: string, ...args: unknown[]): Promise<void> {
				for (const handler of handlers.get(event) ?? []) {
					await handler(...args);
				}
			},
		};
	}

	function sessionStartEvent(reason: SessionStartEvent["reason"]): SessionStartEvent {
		return { type: "session_start", reason };
	}

	describe("shouldRespawnThreadsOnSessionStart", () => {
		it("respawns on startup, new, and resume", () => {
			expect(shouldRespawnThreadsOnSessionStart("startup")).toBe(true);
			expect(shouldRespawnThreadsOnSessionStart("new")).toBe(true);
			expect(shouldRespawnThreadsOnSessionStart("resume")).toBe(true);
		});

		it("skips respawn on reload and fork", () => {
			expect(shouldRespawnThreadsOnSessionStart("reload")).toBe(false);
			expect(shouldRespawnThreadsOnSessionStart("fork")).toBe(false);
		});
	});

	it("calls resume on parent session_start with reason startup", async () => {
		const cwd = createWorkspace();
		const { pi, emit } = createMockPi();
		registerExtension(pi);

		const parent = createParentContext(cwd);
		await emit("session_start", sessionStartEvent("startup"), parent);

		expect(resume).toHaveBeenCalledTimes(1);
		expect(resume).toHaveBeenCalledWith(parent, expect.any(Array));
	});

	it("does not call resume on parent session_start with reason reload", async () => {
		const cwd = createWorkspace();
		const { pi, emit } = createMockPi();
		registerExtension(pi);

		const parent = createParentContext(cwd);
		await emit("session_start", sessionStartEvent("reload"), parent);

		expect(resume).not.toHaveBeenCalled();
	});

	it("does not call resume on parent session_start with reason fork", async () => {
		const cwd = createWorkspace();
		const { pi, emit } = createMockPi();
		registerExtension(pi);

		const parent = createParentContext(cwd);
		await emit("session_start", sessionStartEvent("fork"), parent);

		expect(resume).not.toHaveBeenCalled();
	});

	it("does not call resume for child thread sessions regardless of reason", async () => {
		const cwd = createWorkspace();
		const { pi, emit } = createMockPi();
		registerExtension(pi);

		const child = createChildContext(cwd, "thread-a", "worker-a");
		await emit("session_start", sessionStartEvent("startup"), child);

		expect(resume).not.toHaveBeenCalled();
	});

	it("renders status feed widget after session_shutdown then session_start with resumed threads", async () => {
		const cwd = createWorkspace();
		const { pi, emit } = createMockPi();
		registerExtension(pi);

		const parent = createParentContext(cwd);
		const setWidget = vi.mocked(parent.ui.setWidget);

		await emit("session_start", sessionStartEvent("startup"), parent);
		setWidget.mockClear();

		await emit("session_shutdown");
		await emit("session_start", sessionStartEvent("startup"), parent);

		expect(setWidget).toHaveBeenCalledWith(
			STATUS_FEED_WIDGET_ID,
			expect.any(Function),
			{ placement: "belowEditor" },
		);

		const rendered = renderWidgetFactory(setWidget.mock.calls.at(-1)?.[1]);
		expect(rendered).toContain("Sub-agents running");
		expect(rendered).toContain("worker");
	});

	it("does not leave duplicate intervals after session switch simulation", async () => {
		const cwd = createWorkspace();
		const { pi, emit } = createMockPi();
		registerExtension(pi);

		const childA = createChildContext(cwd, "thread-a", "worker-a");
		const childB = createChildContext(cwd, "thread-b", "worker-b");
		const parent = createParentContext(cwd);

		await emit("session_start", {}, childA);
		expect(intervalCount).toBe(1);

		await emit("session_start", {}, childB);
		expect(intervalCount).toBe(1);

		await emit("session_start", {}, parent);
		expect(intervalCount).toBe(1);

		await emit("session_shutdown");
		expect(intervalCount).toBe(0);
	});
});