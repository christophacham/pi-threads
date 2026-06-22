import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { StatusFeedWidgetController } from "../status-feed-widget.ts";
import { ThreadWaitAbortedError } from "../thread-manager.ts";
import { THREAD_TOOL_ERROR_CODES } from "../thread-tool-error.ts";
import { registerWaitThreadTool } from "./wait.ts";

type WaitThreadExecute = (
	toolCallId: string,
	params: { thread_ids: string[]; timeout?: number },
	signal: AbortSignal | undefined,
	onUpdate: unknown,
	ctx: ExtensionContext,
) => Promise<AgentToolResult<unknown>>;

function createUiContext(): {
	ctx: ExtensionContext;
	onTerminalInput: ReturnType<typeof vi.fn>;
	unsubscribe: ReturnType<typeof vi.fn>;
	getHandler: () => ((data: string) => unknown) | undefined;
} {
	let handler: ((data: string) => unknown) | undefined;
	const unsubscribe = vi.fn();
	const onTerminalInput = vi.fn((nextHandler: (data: string) => unknown) => {
		handler = nextHandler;
		return unsubscribe;
	});
	const ctx = {
		hasUI: true,
		ui: {
			onTerminalInput,
			setWidget: vi.fn(),
			requestRender: vi.fn(),
		},
	} as unknown as ExtensionContext;
	return {
		ctx,
		onTerminalInput,
		unsubscribe,
		getHandler: () => handler,
	};
}

function registerWaitTool(wait: ReturnType<typeof vi.fn>): {
	execute: WaitThreadExecute;
	statusFeedWidget: StatusFeedWidgetController;
} {
	let execute: WaitThreadExecute | undefined;
	const pi = {
		registerTool: vi.fn((nextTool: { execute: WaitThreadExecute }) => {
			execute = nextTool.execute;
		}),
	} as unknown as ExtensionAPI;
	const statusFeedWidget = {
		refresh: vi.fn(),
		ensurePoller: vi.fn(),
		bindContext: vi.fn(),
		reset: vi.fn(),
		stopPoller: vi.fn(),
	} as unknown as StatusFeedWidgetController;

	registerWaitThreadTool(pi, { wait } as never, statusFeedWidget);
	if (!execute) {
		throw new Error("wait_thread tool was not registered");
	}
	return { execute, statusFeedWidget };
}

describe("wait_thread tool", () => {
	it("aborts wait on Escape with ABORTED and cleans up terminal input handler", async () => {
		const wait = vi.fn(async (_ctx, _params, _onUpdate, signal?: AbortSignal) => {
			await new Promise<void>((_resolve, reject) => {
				const onAbort = () => {
					reject(
						new ThreadWaitAbortedError(
							"Wait aborted before threads completed: t1",
							new Map(),
							["t1"],
						),
					);
				};
				if (signal?.aborted) {
					onAbort();
					return;
				}
				signal?.addEventListener("abort", onAbort, { once: true });
			});
		});
		const { execute } = registerWaitTool(wait);
		const { ctx, onTerminalInput, unsubscribe, getHandler } = createUiContext();

		const executePromise = execute(
			"call-1",
			{ thread_ids: ["t1"] },
			new AbortController().signal,
			undefined,
			ctx,
		);

		expect(onTerminalInput).toHaveBeenCalledTimes(1);
		expect(getHandler()?.("\x1b")).toEqual({ consume: true });

		const outcome = await executePromise;
		expect((outcome as AgentToolResult<unknown> & { isError?: boolean }).isError).toBe(true);
		expect(outcome.details).toEqual({
			error: {
				code: THREAD_TOOL_ERROR_CODES.ABORTED,
				message: "Wait aborted before threads completed: t1",
				pending_thread_ids: ["t1"],
				partial_results: {},
			},
		});
		expect(unsubscribe).toHaveBeenCalledTimes(1);
		expect(wait).toHaveBeenCalledWith(
			ctx,
			{ thread_ids: ["t1"] },
			expect.any(Function),
			expect.any(AbortSignal),
		);
	});

	it("ignores non-Escape terminal input while waiting", async () => {
		const wait = vi.fn(async () => ({ threads: [], timedOut: false }));
		const { execute } = registerWaitTool(wait);
		const { ctx, getHandler } = createUiContext();

		await execute("call-1", { thread_ids: ["t1"] }, new AbortController().signal, undefined, ctx);

		expect(getHandler()?.("a")).toBeUndefined();
		expect(wait).toHaveBeenCalledTimes(1);
	});

	it("does not register terminal input handler without UI", async () => {
		const wait = vi.fn(async () => ({ threads: [], timedOut: false }));
		const { execute } = registerWaitTool(wait);
		const onTerminalInput = vi.fn();
		const ctx = {
			hasUI: false,
			ui: { onTerminalInput },
		} as unknown as ExtensionContext;

		await execute("call-1", { thread_ids: ["t1"] }, new AbortController().signal, undefined, ctx);

		expect(onTerminalInput).not.toHaveBeenCalled();
	});

	it("unsubscribes terminal input handler after each wait", async () => {
		const wait = vi.fn(async () => ({ threads: [], timedOut: false }));
		const { execute } = registerWaitTool(wait);
		const { ctx, onTerminalInput, unsubscribe } = createUiContext();

		await execute("call-1", { thread_ids: ["t1"] }, new AbortController().signal, undefined, ctx);
		await execute("call-2", { thread_ids: ["t2"] }, new AbortController().signal, undefined, ctx);

		expect(onTerminalInput).toHaveBeenCalledTimes(2);
		expect(unsubscribe).toHaveBeenCalledTimes(2);
	});
});