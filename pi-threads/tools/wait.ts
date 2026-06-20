import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ThreadManager } from "../thread-manager.ts";
import { runTool } from "./common.ts";

const WaitThreadParams = Type.Object({
	thread_ids: Type.Array(Type.String(), {
		description: "One or more thread IDs to wait on until completion",
		minItems: 1,
	}),
	timeout: Type.Optional(
		Type.Number({
			description: "Optional timeout in seconds for the wait operation",
		}),
	),
});

export function registerWaitThreadTool(pi: ExtensionAPI, manager: ThreadManager): void {
	pi.registerTool(
		defineTool({
			name: "wait_thread",
			label: "Wait Thread",
			description:
				"Block until one or more subagent threads complete, streaming per-thread status via onUpdate.",
			parameters: WaitThreadParams,
			async execute(_toolCallId, params, _signal, onUpdate, ctx) {
				return runTool(
					() =>
						manager.wait(
							ctx,
							params,
							onUpdate
								? (update) =>
										onUpdate({
											content: [
												{
													type: "text",
													text: update.waiting
														.map((item) => `${item.name}: ${item.status}`)
														.join("\n"),
												},
											],
											details: update,
										})
								: undefined,
						),
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