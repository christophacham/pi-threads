import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ListThreadsParamsSchema } from "../contracts.ts";
import type { ThreadManager } from "../thread-manager.ts";
import { renderListThreadsCall, renderListThreadsResult } from "../tool-render.ts";
import { runTool } from "./common.ts";

export function registerListThreadsTool(pi: ExtensionAPI, manager: ThreadManager): void {
	pi.registerTool(
		defineTool({
			name: "list_threads",
			label: "List Threads",
			description:
				"Enumerate subagent thread sessions with status, task summary, and usage. Archived (closed) threads are hidden by default.",
			parameters: ListThreadsParamsSchema,
			renderCall: renderListThreadsCall,
			renderResult: renderListThreadsResult,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				return runTool(
					async () => ({ threads: await manager.list(ctx, params) }),
					(result) => ({
						content: [
							{
								type: "text",
								text:
									result.threads.length === 0
										? "No threads match the requested filter."
										: JSON.stringify(result.threads, null, 2),
							},
						],
						details: result,
					}),
				);
			},
		}),
	);
}