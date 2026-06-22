import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { WaitThreadParamsSchema } from "../contracts.ts";
import type { StatusFeedWidgetController } from "../status-feed-widget.ts";
import type { ThreadManager } from "../thread-manager.ts";
import { renderWaitThreadCall, renderWaitThreadResult } from "../tool-render.ts";
import { runTool } from "./common.ts";

function combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
	const abortSignalAny = AbortSignal as typeof AbortSignal & {
		any?: (signals: AbortSignal[]) => AbortSignal;
	};
	if (typeof abortSignalAny.any === "function") {
		return abortSignalAny.any(signals);
	}

	const controller = new AbortController();
	const onAbort = (signal: AbortSignal) => {
		if (!controller.signal.aborted) {
			controller.abort(signal.reason);
		}
	};
	for (const signal of signals) {
		if (signal.aborted) {
			onAbort(signal);
			break;
		}
		signal.addEventListener("abort", () => onAbort(signal), { once: true });
	}
	return controller.signal;
}

export function registerWaitThreadTool(
	pi: ExtensionAPI,
	manager: ThreadManager,
	statusFeedWidget: StatusFeedWidgetController,
): void {
	pi.registerTool(
		defineTool({
			name: "wait_thread",
			label: "Wait Thread",
			description:
				"Block until one or more subagent threads complete, streaming per-thread status via onUpdate. When timeout elapses before all threads finish, returns partial results with timedOut: true (still-running threads remain in status running).",
			parameters: WaitThreadParamsSchema,
			renderCall: renderWaitThreadCall,
			renderResult: renderWaitThreadResult,
			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				return runTool(
					async () => {
						const escController = new AbortController();
						const combinedSignal = signal
							? combineAbortSignals(signal, escController.signal)
							: escController.signal;
						const onTerminalInput = ctx.hasUI
							? ctx.ui.onTerminalInput((input) => {
								if (!matchesKey(input, Key.escape)) return undefined;
								escController.abort();
								return { consume: true };
							})
							: undefined;
						try {
							statusFeedWidget.refresh(ctx);
							statusFeedWidget.ensurePoller();
							return await manager.wait(
								ctx,
								params,
								(update) => {
									statusFeedWidget.refresh(ctx);
									onUpdate?.({
										content: [
											{
												type: "text",
												text: update.waiting
													.map((item) => `${item.thread_name}: ${item.status}`)
													.join("\n"),
											},
										],
										details: update,
									});
								},
								combinedSignal,
							);
						} finally {
							onTerminalInput?.();
							statusFeedWidget.refresh(ctx);
						}
					},
					(result) => {
						const lines = result.threads.map(
							(thread) => `${thread.thread_name}: ${thread.status}`,
						);
						if (result.timedOut) {
							lines.unshift("(timed out — partial results)");
						}
						return {
							content: [
								{
									type: "text",
									text: lines.join("\n"),
								},
							],
							details: result,
						};
					},
				);
			},
		}),
	);
}