import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	THREAD_ENTRY_TYPES,
	THREAD_TRANSCRIPT_TYPES,
	type InterAgentCommunication,
	type SubAgentActivityEvent,
	type ThreadClosedActivity,
	type ThreadCompletedData,
	type ThreadCompletedStatus,
	type ThreadId,
	type ThreadInterruptedActivity,
	type ThreadMetaData,
	type ThreadSendActivity,
	type ThreadSpawnedActivity,
	type ThreadSpawnedData,
	type ThreadWaitActivity,
} from "./types.ts";

/** Regex for parsing InterAgentCommunication envelopes from prompt text. */
export const INTER_AGENT_MESSAGE_PATTERN = /^\[From (.+?) to (.+?)\]: ([\s\S]*)$/;

export interface DurableWriter {
	appendEntry<T>(customType: string, data?: T): void;
}

export interface TranscriptEmitter {
	sendMessage<T>(
		message: {
			customType: string;
			content: string;
			display: boolean;
			details?: T;
		},
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void;
}

export interface SessionEntryReader {
	getEntries(): SessionEntry[];
}

export function formatInterAgentMessage(envelope: InterAgentCommunication): string {
	return `[From ${envelope.author} to ${envelope.recipient}]: ${envelope.content}`;
}

export function parseInterAgentMessage(text: string): InterAgentCommunication | null {
	const match = text.match(INTER_AGENT_MESSAGE_PATTERN);
	if (!match) return null;
	return {
		author: match[1],
		recipient: match[2],
		content: match[3],
	};
}

export function isThreadMetaEntry(entry: SessionEntry): entry is SessionEntry & {
	type: "custom";
	customType: typeof THREAD_ENTRY_TYPES.META;
	data: ThreadMetaData;
} {
	return entry.type === "custom" && entry.customType === THREAD_ENTRY_TYPES.META;
}

export function isThreadSpawnedEntry(entry: SessionEntry): entry is SessionEntry & {
	type: "custom";
	customType: typeof THREAD_ENTRY_TYPES.SPAWNED;
	data: ThreadSpawnedData;
} {
	return entry.type === "custom" && entry.customType === THREAD_ENTRY_TYPES.SPAWNED;
}

export function isThreadCompletedEntry(entry: SessionEntry): entry is SessionEntry & {
	type: "custom";
	customType: typeof THREAD_ENTRY_TYPES.COMPLETED;
	data: ThreadCompletedData;
} {
	return entry.type === "custom" && entry.customType === THREAD_ENTRY_TYPES.COMPLETED;
}

export function findFirstThreadMeta(entries: SessionEntry[]): ThreadMetaData | undefined {
	for (const entry of entries) {
		if (isThreadMetaEntry(entry)) {
			return entry.data;
		}
	}
	return undefined;
}

export function findAllThreadSpawned(entries: SessionEntry[]): ThreadSpawnedData[] {
	const spawned: ThreadSpawnedData[] = [];
	for (const entry of entries) {
		if (isThreadSpawnedEntry(entry)) {
			spawned.push(entry.data);
		}
	}
	return spawned;
}

export function findLatestThreadCompleted(entries: SessionEntry[]): ThreadCompletedData | undefined {
	let latest: ThreadCompletedData | undefined;
	for (const entry of entries) {
		if (isThreadCompletedEntry(entry)) {
			latest = entry.data;
		}
	}
	return latest;
}

export function getThreadCompletionStatus(entries: SessionEntry[]): ThreadCompletedStatus | undefined {
	return findLatestThreadCompleted(entries)?.status;
}

/** Returns true when the session contains a thread_meta custom entry. */
export function isThreadSession(sessionManager: SessionEntryReader): boolean {
	return findFirstThreadMeta(sessionManager.getEntries()) !== undefined;
}

export interface ThreadSessionInfo {
	path: string;
	meta: ThreadMetaData;
	completion?: ThreadCompletedData;
}

/** Find a thread session by thread_id within a workspace. */
export async function findThreadSessionById(
	cwd: string,
	threadId: string,
	sessionDir?: string,
): Promise<ThreadSessionInfo | undefined> {
	const sessions = await listThreadSessions(cwd, sessionDir);
	return sessions.find((session) => session.meta.thread_id === threadId);
}

/** Extract the last assistant text output from a thread session. */
export function extractThreadOutput(entries: SessionEntry[]): string | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;

		const parts: string[] = [];
		for (const block of message.content) {
			if (block.type === "text" && block.text.trim()) {
				parts.push(block.text);
			}
		}
		if (parts.length > 0) {
			return parts.join("\n");
		}
	}
	return undefined;
}

/** Scan SessionManager.list() results and return sessions with thread_meta entries. */
export async function listThreadSessions(
	cwd: string,
	sessionDir?: string,
): Promise<ThreadSessionInfo[]> {
	const sessions = await SessionManager.list(cwd, sessionDir);
	const threadSessions: ThreadSessionInfo[] = [];

	for (const info of sessions) {
		const manager = SessionManager.open(info.path, sessionDir);
		const meta = findFirstThreadMeta(manager.getEntries());
		if (!meta) continue;

		threadSessions.push({
			path: info.path,
			meta,
			completion: findLatestThreadCompleted(manager.getEntries()),
		});
	}

	return threadSessions;
}

/** Write thread_meta as the first custom entry in a child session. */
export function writeThreadMeta(sessionManager: SessionManager, data: ThreadMetaData): string {
	return sessionManager.appendCustomEntry(THREAD_ENTRY_TYPES.META, data);
}

/** Durable parent-session write for tree reconstruction. */
export function writeThreadSpawnedDurable(writer: DurableWriter, data: ThreadSpawnedData): void {
	writer.appendEntry(THREAD_ENTRY_TYPES.SPAWNED, data);
}

/** Inline transcript event for thread spawn. */
export function emitThreadSpawnedTranscript(
	emitter: TranscriptEmitter,
	event: ThreadSpawnedActivity,
	options?: { triggerTurn?: boolean },
): void {
	emitter.sendMessage(
		{
			customType: THREAD_TRANSCRIPT_TYPES.SPAWNED,
			content: formatSpawnedTranscriptContent(event),
			display: true,
			details: event,
		},
		options,
	);
}

/** Dual-write: durable tree entry + inline transcript for thread spawn. */
export function writeThreadSpawnedDual(
	writer: DurableWriter & TranscriptEmitter,
	durable: ThreadSpawnedData,
	transcript: ThreadSpawnedActivity,
	options?: { triggerTurn?: boolean },
): void {
	writeThreadSpawnedDurable(writer, durable);
	emitThreadSpawnedTranscript(writer, transcript, options);
}

/** Write terminal thread_completed entry (all completion states use this type). */
export function writeThreadCompleted(
	writer: DurableWriter | SessionManager,
	data: ThreadCompletedData,
): string | void {
	if (writer instanceof SessionManager) {
		return writer.appendCustomEntry(THREAD_ENTRY_TYPES.COMPLETED, data);
	}
	writer.appendEntry(THREAD_ENTRY_TYPES.COMPLETED, data);
}

export function emitThreadSendTranscript(emitter: TranscriptEmitter, event: ThreadSendActivity): void {
	emitter.sendMessage({
		customType: THREAD_TRANSCRIPT_TYPES.SEND,
		content: formatSendTranscriptContent(event),
		display: true,
		details: event,
	});
}

export function emitThreadWaitTranscript(emitter: TranscriptEmitter, event: ThreadWaitActivity): void {
	emitter.sendMessage({
		customType: THREAD_TRANSCRIPT_TYPES.WAIT,
		content: formatWaitTranscriptContent(event),
		display: true,
		details: event,
	});
}

export function emitThreadInterruptedTranscript(
	emitter: TranscriptEmitter,
	event: ThreadInterruptedActivity,
): void {
	emitter.sendMessage({
		customType: THREAD_TRANSCRIPT_TYPES.INTERRUPTED,
		content: formatInterruptedTranscriptContent(event),
		display: true,
		details: event,
	});
}

export function emitThreadClosedTranscript(emitter: TranscriptEmitter, event: ThreadClosedActivity): void {
	emitter.sendMessage({
		customType: THREAD_TRANSCRIPT_TYPES.CLOSED,
		content: formatClosedTranscriptContent(event),
		display: true,
		details: event,
	});
}

export function emitSubAgentActivity(emitter: TranscriptEmitter, event: SubAgentActivityEvent): void {
	switch (event.customType) {
		case THREAD_TRANSCRIPT_TYPES.SPAWNED:
			emitThreadSpawnedTranscript(emitter, event);
			break;
		case THREAD_TRANSCRIPT_TYPES.SEND:
			emitThreadSendTranscript(emitter, event);
			break;
		case THREAD_TRANSCRIPT_TYPES.WAIT:
			emitThreadWaitTranscript(emitter, event);
			break;
		case THREAD_TRANSCRIPT_TYPES.INTERRUPTED:
			emitThreadInterruptedTranscript(emitter, event);
			break;
		case THREAD_TRANSCRIPT_TYPES.CLOSED:
			emitThreadClosedTranscript(emitter, event);
			break;
	}
}

export function createThreadSpawnedActivity(params: {
	thread_id: ThreadId;
	thread_name: string;
	agent_type: string;
	task: string;
}): ThreadSpawnedActivity {
	return {
		customType: THREAD_TRANSCRIPT_TYPES.SPAWNED,
		kind: "Spawned",
		thread_id: params.thread_id,
		thread_name: params.thread_name,
		agent_type: params.agent_type,
		task: params.task,
	};
}

export function createThreadSendActivity(params: {
	thread_id: ThreadId;
	thread_name: string;
	message_preview: string;
	agent_type?: string;
}): ThreadSendActivity {
	return {
		customType: THREAD_TRANSCRIPT_TYPES.SEND,
		kind: "Interacted",
		thread_id: params.thread_id,
		thread_name: params.thread_name,
		agent_type: params.agent_type,
		message_preview: params.message_preview,
	};
}

export function createThreadWaitActivity(params: {
	thread_id: ThreadId;
	thread_name: string;
	phase: "started" | "finished";
	status?: string;
	agent_type?: string;
}): ThreadWaitActivity {
	return {
		customType: THREAD_TRANSCRIPT_TYPES.WAIT,
		kind: "Interacted",
		thread_id: params.thread_id,
		thread_name: params.thread_name,
		agent_type: params.agent_type,
		phase: params.phase,
		status: params.status,
	};
}

export function createThreadInterruptedActivity(params: {
	thread_id: ThreadId;
	thread_name: string;
	agent_type?: string;
}): ThreadInterruptedActivity {
	return {
		customType: THREAD_TRANSCRIPT_TYPES.INTERRUPTED,
		kind: "Interrupted",
		thread_id: params.thread_id,
		thread_name: params.thread_name,
		agent_type: params.agent_type,
	};
}

export function createThreadClosedActivity(params: {
	thread_id: ThreadId;
	thread_name: string;
	agent_type?: string;
}): ThreadClosedActivity {
	return {
		customType: THREAD_TRANSCRIPT_TYPES.CLOSED,
		kind: "Closed",
		thread_id: params.thread_id,
		thread_name: params.thread_name,
		agent_type: params.agent_type,
	};
}

function previewText(text: string, maxLength = 80): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	if (singleLine.length <= maxLength) return singleLine;
	return `${singleLine.slice(0, maxLength - 3)}...`;
}

export function formatSpawnedTranscriptContent(event: ThreadSpawnedActivity): string {
	const agentLabel = event.agent_type ? ` [${event.agent_type}]` : "";
	return `Spawned ${event.thread_name}${agentLabel}: ${previewText(event.task)}`;
}

export function formatSendTranscriptContent(event: ThreadSendActivity): string {
	return `Sent input to ${event.thread_name}: ${previewText(event.message_preview)}`;
}

export function formatWaitTranscriptContent(event: ThreadWaitActivity): string {
	if (event.phase === "started") {
		return `Waiting for ${event.thread_name}: ${event.status ?? "Running"}`;
	}
	return `Finished waiting → ${event.thread_name}: ${event.status ?? "Completed"}`;
}

export function formatInterruptedTranscriptContent(event: ThreadInterruptedActivity): string {
	return `Interrupted ${event.thread_name}`;
}

export function formatClosedTranscriptContent(event: ThreadClosedActivity): string {
	return `Closed ${event.thread_name}`;
}