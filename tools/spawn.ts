import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SpawnThreadParamsSchema } from "../contracts.ts";
import type { ThreadManager } from "../thread-manager.ts";
import { renderSpawnThreadCall, renderSpawnThreadResult } from "../tool-render.ts";
import { runTool } from "./common.ts";

export function registerSpawnThreadTool(pi: ExtensionAPI, manager: ThreadManager): void {
	pi.registerTool(
		defineTool({
			name: "spawn_thread",
			label: "Spawn Thread",
			description:
				"Create a persistent subagent thread with an isolated pi session and subprocess. Returns thread_id and thread_name.",
			parameters: SpawnThreadParamsSchema,
			renderCall: renderSpawnThreadCall,
			renderResult: renderSpawnThreadResult,
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				return runTool(
					() => manager.spawn(ctx, params, signal),
					(result) => ({
						content: [
							{
								type: "text",
								text: `Spawned thread ${result.thread_name} (${result.thread_id})`,
							},
						],
						details: result,
					}),
				);
			},
		}),
	);
}