import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { InterruptThreadParamsSchema } from "../contracts.ts";
import type { ThreadManager } from "../thread-manager.ts";
import { renderInterruptThreadCall, renderInterruptThreadResult } from "../tool-render.ts";
import { runTool } from "./common.ts";

export function registerInterruptThreadTool(pi: ExtensionAPI, manager: ThreadManager): void {
	pi.registerTool(
		defineTool({
			name: "interrupt_thread",
			label: "Interrupt Thread",
			description:
				"Force-stop a running subagent thread subprocess and mark it as aborted in the session.",
			parameters: InterruptThreadParamsSchema,
			renderCall: renderInterruptThreadCall,
			renderResult: renderInterruptThreadResult,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				return runTool(
					() => manager.interrupt(ctx, params),
					(result) => ({
						content: [
							{
								type: "text",
								text: `Interrupted ${result.thread_name} (${result.thread_id})`,
							},
						],
						details: result,
					}),
				);
			},
		}),
	);
}