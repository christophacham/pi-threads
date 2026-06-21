import type { Usage } from "@earendil-works/pi-ai";

/** Durable custom entry types written via pi.appendEntry() / SessionManager.appendCustomEntry(). */
export const THREAD_ENTRY_TYPES = {
	META: "thread_meta",
	SPAWNED: "thread_spawned",
	COMPLETED: "thread_completed",
} as const;

export type ThreadEntryType = (typeof THREAD_ENTRY_TYPES)[keyof typeof THREAD_ENTRY_TYPES];

/** Inline transcript custom message types written via pi.sendMessage(). */
export const THREAD_TRANSCRIPT_TYPES = {
	SPAWNED: "thread_spawned",
	SEND: "thread_send",
	WAIT: "thread_wait",
	INTERRUPTED: "thread_interrupted",
	CLOSED: "thread_closed",
} as const;

export type ThreadTranscriptType = (typeof THREAD_TRANSCRIPT_TYPES)[keyof typeof THREAD_TRANSCRIPT_TYPES];

export type ThreadId = string;

export type ThreadCompletedStatus = "completed" | "error" | "aborted" | "closed";

/** Structured envelope prepended to inter-agent prompts. */
export interface InterAgentCommunication {
	author: string;
	recipient: string;
	content: string;
}

/**
 * First custom entry in a child thread session.
 * Marks the session as a thread session (distinct from regular user sessions).
 */
export interface ThreadMeta {
	parent_id: string;
	thread_id: ThreadId;
	thread_name: string;
	depth: number;
	task: string;
	agent_type: string;
}

/** Durable parent-session entry for tree reconstruction. */
export interface ThreadSpawnedData {
	thread_id: ThreadId;
	thread_name: string;
	parent_id: string;
	depth: number;
	agent_type: string;
}

/**
 * Single terminal entry type for all thread completion states.
 * 'closed' is a status value here — there is no separate thread_closed entry type.
 */
export interface ThreadCompletedData {
	status: ThreadCompletedStatus;
	usage?: Usage;
	exit_code?: number;
}

export type SubAgentActivityKind = "Spawned" | "Interacted" | "Interrupted" | "Closed";

export interface SubAgentActivityBase {
	thread_id: ThreadId;
	thread_name: string;
	agent_type?: string;
	kind: SubAgentActivityKind;
}

/** Inline transcript event: thread spawned. */
export interface ThreadSpawnedActivity extends SubAgentActivityBase {
	customType: typeof THREAD_TRANSCRIPT_TYPES.SPAWNED;
	kind: "Spawned";
	task: string;
}

/** Inline transcript event: message sent to a thread. */
export interface ThreadSendActivity extends SubAgentActivityBase {
	customType: typeof THREAD_TRANSCRIPT_TYPES.SEND;
	kind: "Interacted";
	message_preview: string;
}

/** Inline transcript event: waiting on a thread. */
export interface ThreadWaitActivity extends SubAgentActivityBase {
	customType: typeof THREAD_TRANSCRIPT_TYPES.WAIT;
	kind: "Interacted";
	phase: "started" | "finished";
	status?: string;
}

/** Inline transcript event: thread interrupted. */
export interface ThreadInterruptedActivity extends SubAgentActivityBase {
	customType: typeof THREAD_TRANSCRIPT_TYPES.INTERRUPTED;
	kind: "Interrupted";
}

/** Inline transcript event: thread closed/archived. */
export interface ThreadClosedActivity extends SubAgentActivityBase {
	customType: typeof THREAD_TRANSCRIPT_TYPES.CLOSED;
	kind: "Closed";
}

/** Union of all inline SubAgentActivityEvent payloads (details on pi.sendMessage). */
export type SubAgentActivityEvent =
	| ThreadSpawnedActivity
	| ThreadSendActivity
	| ThreadWaitActivity
	| ThreadInterruptedActivity
	| ThreadClosedActivity;