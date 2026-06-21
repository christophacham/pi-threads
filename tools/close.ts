import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CloseThreadParamsSchema } from "../contracts.ts";
import type { ThreadManager } from "../thread-manager.ts";
import { renderCloseThreadCall, renderCloseThreadResult } from "../tool-render.ts";
import { runTool } from "./common.ts";

export function registerCloseThreadTool(pi: ExtensionAPI, manager: ThreadManager): void {
	pi.registerTool(
		defineTool({
			name: "close_thread",
			label: "Close Thread",
			description:
				"Archive a completed subagent thread by marking thread_completed status as closed. Does not kill running threads.",
			parameters: CloseThreadParamsSchema,
			renderCall: renderCloseThreadCall,
			renderResult: renderCloseThreadResult,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				return runTool(
					() => manager.close(ctx, params),
					(result) => ({
						content: [
							{
								type: "text",
								text: `Closed ${result.thread_name} (${result.thread_id})`,
							},
						],
						details: result,
					}),
				);
			},
		}),
	);
}