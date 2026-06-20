import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ThreadManager } from "../thread-manager.ts";
import { runTool } from "./common.ts";

const SendToThreadParams = Type.Object({
	thread_id: Type.String({
		description: "Target thread ID",
	}),
	message: Type.String({
		description: "Message to send to the running thread (wrapped in InterAgentCommunication envelope)",
	}),
});

export function registerSendToThreadTool(pi: ExtensionAPI, manager: ThreadManager): void {
	pi.registerTool(
		defineTool({
			name: "send_to_thread",
			label: "Send To Thread",
			description:
				"Inject a message into a running subagent thread session using the inter-agent communication envelope.",
			parameters: SendToThreadParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				return runTool(
					() => manager.send(ctx, params),
					(result) => ({
						content: [
							{
								type: "text",
								text: `Sent message to ${result.thread_name} (${result.thread_id})`,
							},
						],
						details: result,
					}),
				);
			},
		}),
	);
}