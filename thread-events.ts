/**
 * Facade for thread protocol event recording.
 *
 * Encapsulates dual-write rules: spawn/send write durable + transcript;
 * wait, completed, interrupted, and closed are transcript-only (interrupt/close
 * also append thread_completed to the child session).
 */
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	createThreadClosedActivity,
	createThreadCompletedActivity,
	createThreadInterruptedActivity,
	createThreadSendActivity,
	createThreadSpawnedActivity,
	createThreadWaitActivity,
	emitThreadClosedTranscript,
	emitThreadCompletedTranscript,
	emitThreadInterruptedTranscript,
	emitThreadWaitTranscript,
	type DurableWriter,
	type TranscriptEmitter,
	writeThreadCompleted,
	writeThreadSendDual,
	writeThreadSpawnedDual,
} from "./persistence.ts";
import type { ThreadCompletedStatus, ThreadId, ThreadSpawnedData } from "./types.ts";

export interface ThreadEventsWriter extends DurableWriter, TranscriptEmitter {}

export class ThreadEvents {
	constructor(private readonly writer: ThreadEventsWriter) {}

	recordSpawn(durable: ThreadSpawnedData, task: string): void {
		writeThreadSpawnedDual(
			this.writer,
			durable,
			createThreadSpawnedActivity({
				thread_id: durable.thread_id,
				thread_name: durable.thread_name,
				agent_type: durable.agent_type,
				task,
			}),
		);
	}

	recordSend(params: {
		thread_id: ThreadId;
		thread_name: string;
		agent_type: string;
		message_preview: string;
	}): void {
		writeThreadSendDual(this.writer, createThreadSendActivity(params));
	}

	recordWait(params: {
		thread_id: ThreadId;
		thread_name: string;
		agent_type?: string;
		phase: "started" | "finished";
		status?: string;
	}): void {
		emitThreadWaitTranscript(this.writer, createThreadWaitActivity(params));
	}

	recordCompleted(params: {
		thread_id: ThreadId;
		thread_name: string;
		agent_type?: string;
		status: ThreadCompletedStatus;
		result_preview?: string;
		usage?: Parameters<typeof createThreadCompletedActivity>[0]["usage"];
		model?: string;
	}): void {
		emitThreadCompletedTranscript(this.writer, createThreadCompletedActivity(params));
	}

	recordInterrupt(params: {
		childSession: SessionManager;
		thread_id: ThreadId;
		thread_name: string;
		agent_type: string;
	}): void {
		writeThreadCompleted(params.childSession, { status: "aborted" });
		emitThreadInterruptedTranscript(
			this.writer,
			createThreadInterruptedActivity({
				thread_id: params.thread_id,
				thread_name: params.thread_name,
				agent_type: params.agent_type,
			}),
		);
	}

	recordClose(params: {
		childSession: SessionManager;
		thread_id: ThreadId;
		thread_name: string;
		agent_type: string;
		usage?: Parameters<typeof createThreadClosedActivity>[0]["usage"];
		model?: string;
	}): void {
		writeThreadCompleted(params.childSession, { status: "closed" });
		emitThreadClosedTranscript(
			this.writer,
			createThreadClosedActivity({
				thread_id: params.thread_id,
				thread_name: params.thread_name,
				agent_type: params.agent_type,
				usage: params.usage,
				model: params.model,
			}),
		);
	}
}