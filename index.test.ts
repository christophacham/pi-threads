import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendInterAgentUserMessage, writeThreadMeta } from "./persistence.ts";

const bindContext = vi.fn();
const resume = vi.fn().mockResolvedValue(undefined);

vi.mock("./thread-manager.ts", () => ({
	ThreadManager: vi.fn().mockImplementation(() => ({
		bindContext,
		resume,
		getActiveThreads: vi.fn(() => new Map()),
		getStatusFeed: vi.fn(() => []),
		getThreadChildren: vi.fn(() => []),
	})),
}));

import registerExtension from "./index.ts";

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
		vi.restoreAllMocks();
		intervalCount = 0;
		vi.clearAllMocks();
	});

	beforeEach(() => {
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
		return {
			cwd,
			sessionManager,
			isIdle: () => true,
			ui: {
				notify: vi.fn(),
				select: vi.fn(),
				setStatus: vi.fn(),
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
		expect(intervalCount).toBe(0);

		await emit("session_shutdown");
		expect(intervalCount).toBe(0);
	});
});