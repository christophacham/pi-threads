import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ThreadManager } from "../thread-manager.ts";
import { runTool } from "./common.ts";

const ListThreadsParams = Type.Object({
	status: Type.Optional(
		StringEnum(["running", "completed", "error", "aborted", "all"] as const, {
			description:
				"Filter threads by status. Default excludes archived (closed) threads. Use 'all' to include closed threads.",
		}),
	),
});

export function registerListThreadsTool(pi: ExtensionAPI, manager: ThreadManager): void {
	pi.registerTool(
		defineTool({
			name: "list_threads",
			label: "List Threads",
			description:
				"Enumerate subagent thread sessions with status, task summary, and usage. Archived (closed) threads are hidden by default.",
			parameters: ListThreadsParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				return runTool(
					() => manager.list(ctx, params),
					(threads) => ({
						content: [
							{
								type: "text",
								text:
									threads.length === 0
										? "No threads match the requested filter."
										: JSON.stringify(threads, null, 2),
							},
						],
						details: { threads },
					}),
				);
			},
		}),
	);
}