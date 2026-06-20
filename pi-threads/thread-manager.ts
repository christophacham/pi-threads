import type { ChildProcess } from "node:child_process";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { listThreadSessions } from "./persistence.ts";
import type { ThreadCompletedStatus, ThreadId } from "./types.ts";

const NOT_IMPLEMENTED = "Not implemented — see pi-threads-w9k";

export type ThreadRuntimeStatus = ThreadCompletedStatus | "running";

export interface ThreadRecord {
	process: ChildProcess | null;
	sessionFile: string;
	threadName: string;
	status: ThreadRuntimeStatus;
	agent_type: string;
	depth: number;
	task: string;
}

export type ForkTurns = "none" | "all" | number;

export interface SpawnThreadParams {
	task: string;
	thread_name: string;
	agent_type: string;
	model?: string;
	tools?: string[];
	fork_turns?: ForkTurns;
	cwd?: string;
}

export interface SpawnThreadResult {
	thread_id: ThreadId;
	thread_name: string;
}

export interface WaitThreadParams {
	thread_ids: ThreadId[];
	timeout?: number;
}

export interface WaitThreadUpdate {
	waiting: Array<{
		name: string;
		status: string;
		lastActivity?: string;
	}>;
}

export interface WaitThreadResult {
	threads: Array<{
		thread_id: ThreadId;
		thread_name: string;
		status: ThreadCompletedStatus;
		output?: string;
	}>;
}

export interface SendToThreadParams {
	thread_id: ThreadId;
	message: string;
}

export interface SendToThreadResult {
	thread_id: ThreadId;
	thread_name: string;
}

export type ListThreadsFilter = "running" | "completed" | "error" | "aborted" | "all";

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

export interface ListThreadsParams {
	status?: ListThreadsFilter;
}

export interface InterruptThreadParams {
	thread_id: ThreadId;
}

export interface InterruptThreadResult {
	thread_id: ThreadId;
	thread_name: string;
	status: "aborted";
}

export interface CloseThreadParams {
	thread_id: ThreadId;
}

export interface CloseThreadResult {
	thread_id: ThreadId;
	thread_name: string;
	status: "closed";
}

export interface ResumeResult {
	incompleteCount: number;
	totalThreadSessions: number;
}

function notImplemented(method: string): never {
	throw new Error(`${NOT_IMPLEMENTED} (${method})`);
}

function resolveThreadStatus(
	inActiveMap: boolean,
	completion?: { status: ThreadCompletedStatus },
): ThreadRuntimeStatus {
	if (!completion) return "running";
	if (inActiveMap && completion.status !== "closed") return "running";
	return completion.status;
}

function matchesListFilter(summary: ThreadSummary, filter?: ListThreadsFilter): boolean {
	if (!filter) {
		return summary.status !== "closed";
	}

	switch (filter) {
		case "running":
			return summary.status === "running";
		case "completed":
			return summary.status === "completed" || summary.status === "closed";
		case "error":
			return summary.status === "error";
		case "aborted":
			return summary.status === "aborted";
		case "all":
			return true;
	}
}

export class ThreadManager {
	private readonly threads = new Map<ThreadId, ThreadRecord>();

	bindContext(_ctx: ExtensionContext): void {
		// Reserved for future session-scoped state (pi-threads-w9k / pi-threads-rf0).
	}

	getActiveThreads(): ReadonlyMap<ThreadId, ThreadRecord> {
		return this.threads;
	}

	async spawn(_ctx: ExtensionContext, _params: SpawnThreadParams): Promise<SpawnThreadResult> {
		notImplemented("spawn");
	}

	async wait(
		_ctx: ExtensionContext,
		_params: WaitThreadParams,
		_onUpdate?: (update: WaitThreadUpdate) => void,
	): Promise<WaitThreadResult> {
		notImplemented("wait");
	}

	async list(ctx: ExtensionContext, params: ListThreadsParams = {}): Promise<ThreadSummary[]> {
		const sessions = await listThreadSessions(ctx.cwd);
		const summaries = sessions.map((session) => {
			const active = this.threads.get(session.meta.thread_id);
			return {
				thread_id: session.meta.thread_id,
				thread_name: session.meta.thread_name,
				parent_id: session.meta.parent_id,
				depth: session.meta.depth,
				status: resolveThreadStatus(active !== undefined, session.completion),
				task: session.meta.task,
				usage: session.completion?.usage,
				model: undefined,
			} satisfies ThreadSummary;
		});

		return summaries.filter((summary) => matchesListFilter(summary, params.status));
	}

	async send(_ctx: ExtensionContext, _params: SendToThreadParams): Promise<SendToThreadResult> {
		notImplemented("send");
	}

	async interrupt(_ctx: ExtensionContext, _params: InterruptThreadParams): Promise<InterruptThreadResult> {
		notImplemented("interrupt");
	}

	async close(_ctx: ExtensionContext, _params: CloseThreadParams): Promise<CloseThreadResult> {
		notImplemented("close");
	}

	async resume(ctx: ExtensionContext): Promise<ResumeResult> {
		const sessions = await listThreadSessions(ctx.cwd);
		const incomplete = sessions.filter((session) => !session.completion);

		if (incomplete.length > 0) {
			ctx.ui.notify(
				`pi-threads: ${incomplete.length} incomplete thread session(s) found (full resumption: pi-threads-rf0)`,
				"info",
			);
		}

		return {
			incompleteCount: incomplete.length,
			totalThreadSessions: sessions.length,
		};
	}
}