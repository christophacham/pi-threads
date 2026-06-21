/**
 * Shared tool parameter schemas and manager/tool result types.
 *
 * TypeBox schemas are the source of truth for tool inputs; manager methods
 * consume the matching Static<> types so params are not duplicated.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { Usage } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { ThreadCompletedStatus, ThreadId } from "./types.ts";

export type ThreadRuntimeStatus = ThreadCompletedStatus | "running";

export const ForkTurnsSchema = Type.Union([
	Type.Literal("none"),
	Type.Literal("all"),
	Type.Number({ description: "Copy the last N parent turns into the child session" }),
]);

export type ForkTurns = Static<typeof ForkTurnsSchema>;

export const SpawnThreadParamsSchema = Type.Object({
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
	fork_turns: Type.Optional(ForkTurnsSchema),
	cwd: Type.Optional(
		Type.String({
			description: "Optional working directory for the child thread (defaults to parent cwd)",
		}),
	),
});

export type SpawnThreadParams = Static<typeof SpawnThreadParamsSchema>;

export interface SpawnThreadResult {
	thread_id: ThreadId;
	thread_name: string;
	agent_type: string;
	task: string;
}

export const WaitThreadParamsSchema = Type.Object({
	thread_ids: Type.Array(Type.String(), {
		description: "One or more thread IDs to wait on until completion",
		minItems: 1,
	}),
	timeout: Type.Optional(
		Type.Number({
			description:
				"Optional timeout in seconds. When it elapses before all threads finish, the tool returns partial results with timedOut: true instead of failing.",
		}),
	),
});

export type WaitThreadParams = Static<typeof WaitThreadParamsSchema>;

export interface WaitThreadItem {
	thread_id: ThreadId;
	thread_name: string;
	agent_type: string;
	task: string;
	status: ThreadRuntimeStatus | ThreadCompletedStatus;
	activities?: string[];
	output?: string;
	usage?: Usage;
}

export interface WaitThreadUpdate {
	waiting: WaitThreadItem[];
}

export interface WaitThreadResult {
	threads: WaitThreadItem[];
	/** True when timeout elapsed before every requested thread reached a terminal state. */
	timedOut?: boolean;
}

export const SendToThreadParamsSchema = Type.Object({
	thread_id: Type.String({
		description: "Target thread ID",
	}),
	message: Type.String({
		description: "Message to send to the running thread (wrapped in InterAgentCommunication envelope)",
	}),
});

export type SendToThreadParams = Static<typeof SendToThreadParamsSchema>;

export interface SendToThreadResult {
	thread_id: ThreadId;
	thread_name: string;
}

export const ListThreadsFilterSchema = StringEnum(["running", "completed", "error", "aborted", "all"] as const, {
	description:
		"Filter threads by status. Default excludes archived (closed) threads. Use 'all' to include closed threads.",
});

export type ListThreadsFilter = Static<typeof ListThreadsFilterSchema>;

export const ListThreadsParamsSchema = Type.Object({
	status: Type.Optional(ListThreadsFilterSchema),
});

export type ListThreadsParams = Static<typeof ListThreadsParamsSchema>;

export interface ThreadSummary {
	thread_id: ThreadId;
	thread_name: string;
	parent_id: string;
	depth: number;
	status: ThreadRuntimeStatus;
	task: string;
	usage?: Usage;
	model?: string;
}

export const InterruptThreadParamsSchema = Type.Object({
	thread_id: Type.String({
		description: "Running thread ID to force-stop",
	}),
});

export type InterruptThreadParams = Static<typeof InterruptThreadParamsSchema>;

export interface InterruptThreadResult {
	thread_id: ThreadId;
	thread_name: string;
	status: "aborted";
}

export const CloseThreadParamsSchema = Type.Object({
	thread_id: Type.String({
		description: "Completed thread ID to archive/close",
	}),
});

export type CloseThreadParams = Static<typeof CloseThreadParamsSchema>;

export interface CloseThreadResult {
	thread_id: ThreadId;
	thread_name: string;
	status: "closed";
}