import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WaitThreadParamsSchema } from "../contracts.ts";
import { clearStatusFeedWidget, updateStatusFeedWidget } from "../status-feed.ts";
import type { ThreadManager } from "../thread-manager.ts";
import { renderWaitThreadCall, renderWaitThreadResult } from "../tool-render.ts";
import { runTool } from "./common.ts";

export function registerWaitThreadTool(pi: ExtensionAPI, manager: ThreadManager): void {
	pi.registerTool(
		defineTool({
			name: "wait_thread",
			label: "Wait Thread",
			description:
				"Block until one or more subagent threads complete, streaming per-thread status via onUpdate.",
			parameters: WaitThreadParamsSchema,
			renderCall: renderWaitThreadCall,
			renderResult: renderWaitThreadResult,
			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				return runTool(
					async () => {
						try {
							updateStatusFeedWidget(ctx, manager.getStatusFeed());
							return await manager.wait(
								ctx,
								params,
								(update) => {
									updateStatusFeedWidget(ctx, manager.getStatusFeed());
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
								signal,
							);
						} finally {
							clearStatusFeedWidget(ctx);
						}
					},
					(result) => ({
						content: [
							{
								type: "text",
								text: result.threads
									.map((thread) => `${thread.thread_name}: ${thread.status}`)
									.join("\n"),
							},
						],
						details: result,
					}),
				);
			},
		}),
	);
}