import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ThreadManager } from "../thread-manager.ts";
import { runTool } from "./common.ts";

const ForkTurnsSchema = Type.Union([
	Type.Literal("none"),
	Type.Literal("all"),
	Type.Number({ description: "Copy the last N parent turns into the child session" }),
]);

const SpawnThreadParams = Type.Object({
	task: Type.String({
		description: "Task for the subagent thread to complete in an isolated context window",
	}),
	thread_name: Type.String({
		description: "Human-readable name for the thread (used in envelopes and transcript events)",
	}),
	agent_type: Type.String({
		description: "Agent role/type label (e.g. researcher, implementer, reviewer)",
	}),
	model: Type.Optional(
		Type.String({
			description: "Optional model override for the child pi subprocess",
		}),
	),
	tools: Type.Optional(
		Type.Array(Type.String(), {
			description: "Optional tool allowlist for the child pi subprocess",
		}),
	),
	fork_turns: Type.Optional(
		ForkTurnsSchema,
	),
	cwd: Type.Optional(
		Type.String({
			description: "Optional working directory for the child thread (defaults to parent cwd)",
		}),
	),
});

export function registerSpawnThreadTool(pi: ExtensionAPI, manager: ThreadManager): void {
	pi.registerTool(
		defineTool({
			name: "spawn_thread",
			label: "Spawn Thread",
			description:
				"Create a persistent subagent thread with an isolated pi session and subprocess. Returns thread_id and thread_name.",
			parameters: SpawnThreadParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				return runTool(
					() => manager.spawn(ctx, params),
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