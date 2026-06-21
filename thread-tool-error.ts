import type { ThreadCompletedStatus, ThreadId } from "./types.ts";

export const THREAD_TOOL_ERROR_CODES = {
	THREAD_NOT_FOUND: "THREAD_NOT_FOUND",
	THREAD_NOT_RUNNING: "THREAD_NOT_RUNNING",
	THREAD_STILL_RUNNING: "THREAD_STILL_RUNNING",
	THREAD_NOT_COMPLETED: "THREAD_NOT_COMPLETED",
	SESSION_CREATE_FAILED: "SESSION_CREATE_FAILED",
	TIMEOUT: "TIMEOUT",
	ABORTED: "ABORTED",
	UNKNOWN: "UNKNOWN",
} as const;

export type ThreadToolErrorCode = (typeof THREAD_TOOL_ERROR_CODES)[keyof typeof THREAD_TOOL_ERROR_CODES];

export interface ThreadToolErrorDetails {
	code: ThreadToolErrorCode;
	message: string;
	thread_id?: ThreadId;
	status?: ThreadCompletedStatus | "running";
	pending_thread_ids?: ThreadId[];
	partial_results?: Record<ThreadId, ThreadCompletedStatus>;
}

export class ThreadToolError extends Error {
	readonly code: ThreadToolErrorCode;
	readonly details: ThreadToolErrorDetails;
	constructor(code: ThreadToolErrorCode, message: string, extra: Omit<ThreadToolErrorDetails, "code" | "message"> = {}) {
		super(message);
		this.name = "ThreadToolError";
		this.code = code;
		this.details = { code, message, ...extra };
	}
}

export interface ThreadToolErrorResult { error: ThreadToolErrorDetails; }

export function isThreadToolError(error: unknown): error is ThreadToolError { return error instanceof ThreadToolError; }

export function toThreadToolErrorDetails(error: unknown): ThreadToolErrorDetails {
	if (error instanceof ThreadToolError) return error.details;
	return { code: THREAD_TOOL_ERROR_CODES.UNKNOWN, message: error instanceof Error ? error.message : String(error) };
}
