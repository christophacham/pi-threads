/**
 * Parent-session thread runtime.
 *
 * Owns subprocess lifecycle (spawn, resume, wait, interrupt, close), dual-writes
 * spawn/send to durable + transcript channels, and appends inter-agent user messages
 * to child session files for the child poller to deliver.
 */
import { type ChildProcess, spawn } from "node:child_process";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { forkParentContextIntoChild } from "./context-fork.ts";
import {
	appendInterAgentUserMessage,
	createThreadClosedActivity,
	createThreadInterruptedActivity,
	createThreadSendActivity,
	createThreadSpawnedActivity,
	createThreadWaitActivity,
	emitThreadClosedTranscript,
	emitThreadInterruptedTranscript,
	emitThreadWaitTranscript,
	extractThreadOutput,
	buildThreadChildrenMap,
	findFirstThreadMeta,
	findLatestThreadCompleted,
	findThreadSessionById,
	formatInterAgentMessage,
	listThreadSessions,
	shouldResumeThreadSession,
	THREAD_SESSION_BOOTSTRAP_TEXT,
	writeThreadCompleted,
	writeThreadMeta,
	writeThreadSendDual,
	writeThreadSpawnedDual,
} from "./persistence.ts";
import { parseChildStdoutLine } from "./status-feed.ts";
import {
	buildThreadPiArgs,
	createRingBuffer,
	getRingBufferTail,
	OUTPUT_RING_BUFFER_SIZE,
	pushRingBufferLine,
	resolvePiSpawn,
	KILL_SUBPROCESS_TIMEOUT_MS,
	SIGKILL_TIMEOUT_MS,
	STATUS_FEED_MAX_LINES,
	WAIT_POLL_INTERVAL_MS,
	type RingBuffer,
} from "./thread-subprocess.ts";
import type { ThreadCompletedStatus, ThreadId, ThreadMetaData } from "./types.ts";

export type ThreadRuntimeStatus = ThreadCompletedStatus | "running";

export interface ThreadRecord {
	process: ChildProcess | null;
	sessionFile: string;
	threadName: string;
	status: ThreadRuntimeStatus;
	agent_type: string;
	depth: number;
	task: string;
	stdoutBuffer: RingBuffer;
	stderrBuffer: RingBuffer;
	activityBuffer: RingBuffer;
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
	agent_type: string;
	task: string;
}

export interface WaitThreadParams {
	thread_ids: ThreadId[];
	timeout?: number;
}

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
	resumedCount: number;
}

export interface StatusFeedEntry {
	thread_id: ThreadId;
	thread_name: string;
	status: ThreadRuntimeStatus;
	lines: string[];
}

export interface ThreadSubprocessSpawner {
	spawn(command: string, args: string[], options: Parameters<typeof spawn>[2]): ChildProcess;
}

export interface ThreadManagerDeps {
	spawner?: ThreadSubprocessSpawner;
	sleep?: (ms: number) => Promise<void>;
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

function resolveParentAuthor(parentMeta: ThreadMetaData | undefined): string {
	return parentMeta?.thread_name ?? "root";
}

function resolveSpawnDepth(parentMeta: ThreadMetaData | undefined): number {
	return parentMeta ? parentMeta.depth + 1 : 1;
}

function completionStatusFromExitCode(exitCode: number | null): ThreadCompletedStatus {
	return exitCode === 0 ? "completed" : "error";
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pi defers flushing session files until the first assistant message. */
function persistThreadSession(session: SessionManager): void {
	session.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: THREAD_SESSION_BOOTSTRAP_TEXT }],
		api: "pi-threads",
		provider: "pi-threads",
		model: "pi-threads",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
}

/** Thrown when pollThreadCompletions exceeds its deadline before all threads finish. */
export class ThreadWaitTimeoutError extends Error {
	readonly partialResults: ReadonlyMap<ThreadId, ThreadCompletedStatus>;
	readonly pendingThreadIds: readonly ThreadId[];

	constructor(
		message: string,
		partialResults: Map<ThreadId, ThreadCompletedStatus>,
		pendingThreadIds: ThreadId[],
	) {
		super(message);
		this.name = "ThreadWaitTimeoutError";
		this.partialResults = partialResults;
		this.pendingThreadIds = pendingThreadIds;
	}
}

/** Poll child sessions until all requested threads reach a terminal state. */
export async function pollThreadCompletions(
	threadIds: ThreadId[],
	readCompletion: (threadId: ThreadId) => ThreadCompletedStatus | undefined,
	options: {
		timeoutMs?: number;
		pollIntervalMs?: number;
		onPoll?: () => void;
		sleep?: (ms: number) => Promise<void>;
	} = {},
): Promise<Map<ThreadId, ThreadCompletedStatus>> {
	const {
		timeoutMs,
		pollIntervalMs = WAIT_POLL_INTERVAL_MS,
		onPoll,
		sleep = delay,
	} = options;

	const deadline = timeoutMs !== undefined ? Date.now() + timeoutMs : undefined;
	const results = new Map<ThreadId, ThreadCompletedStatus>();

	while (results.size < threadIds.length) {
		if (deadline !== undefined && Date.now() >= deadline) {
			const pendingThreadIds = threadIds.filter((id) => !results.has(id));
			throw new ThreadWaitTimeoutError(
				`Timed out waiting for threads: ${pendingThreadIds.join(", ")}`,
				results,
				pendingThreadIds,
			);
		}

		for (const threadId of threadIds) {
			if (results.has(threadId)) continue;
			const status = readCompletion(threadId);
			if (status) {
				results.set(threadId, status);
			}
		}

		if (results.size === threadIds.length) break;

		onPoll?.();
		await sleep(pollIntervalMs);
	}

	return results;
}

export class ThreadManager {
	private readonly threads = new Map<ThreadId, ThreadRecord>();
	private threadChildren = new Map<string, Set<ThreadId>>();
	private readonly spawner: ThreadSubprocessSpawner;
	private readonly sleep: (ms: number) => Promise<void>;
	private ctx: ExtensionContext | null = null;

	constructor(
		private readonly pi: ExtensionAPI,
		deps: ThreadManagerDeps = {},
	) {
		this.spawner = deps.spawner ?? { spawn };
		this.sleep = deps.sleep ?? delay;
	}

	bindContext(ctx: ExtensionContext): void {
		this.ctx = ctx;
	}

	getActiveThreads(): ReadonlyMap<ThreadId, ThreadRecord> {
		return this.threads;
	}

	getThreadChildren(parentId: string): ThreadId[] {
		return [...(this.threadChildren.get(parentId) ?? [])];
	}

	getStatusFeed(maxLines = STATUS_FEED_MAX_LINES): StatusFeedEntry[] {
		const feed: StatusFeedEntry[] = [];
		for (const [threadId, record] of this.threads) {
			if (record.status !== "running") continue;
			feed.push({
				thread_id: threadId,
				thread_name: record.threadName,
				status: record.status,
				lines: getRingBufferTail(record.activityBuffer, maxLines),
			});
		}
		return feed;
	}

	async spawn(ctx: ExtensionContext, params: SpawnThreadParams): Promise<SpawnThreadResult> {
		const cwd = params.cwd ?? ctx.cwd;
		const parentId = ctx.sessionManager.getSessionId();
		const parentMeta = findFirstThreadMeta(ctx.sessionManager.getEntries());
		const depth = resolveSpawnDepth(parentMeta);
		const author = resolveParentAuthor(parentMeta);

		const childSession = SessionManager.create(cwd);
		const sessionFile = childSession.getSessionFile();
		if (!sessionFile) {
			throw new Error("Failed to create thread session file");
		}

		const threadId = childSession.getSessionId();
		writeThreadMeta(childSession, {
			parent_id: parentId,
			thread_id: threadId,
			thread_name: params.thread_name,
			depth,
			task: params.task,
			agent_type: params.agent_type,
		});
		forkParentContextIntoChild(ctx.sessionManager, childSession, params.fork_turns ?? "none");
		persistThreadSession(childSession);

		const prompt = formatInterAgentMessage({
			author,
			recipient: params.thread_name,
			content: params.task,
		});

		const record: ThreadRecord = {
			process: null,
			sessionFile,
			threadName: params.thread_name,
			status: "running",
			agent_type: params.agent_type,
			depth,
			task: params.task,
			stdoutBuffer: createRingBuffer(OUTPUT_RING_BUFFER_SIZE),
			stderrBuffer: createRingBuffer(OUTPUT_RING_BUFFER_SIZE),
			activityBuffer: createRingBuffer(OUTPUT_RING_BUFFER_SIZE),
		};
		this.threads.set(threadId, record);

		record.process = this.startSubprocess({
			sessionFile,
			prompt,
			model: params.model,
			tools: params.tools,
			cwd,
			threadId,
			threadName: params.thread_name,
			agent_type: params.agent_type,
			depth,
			task: params.task,
		});

		writeThreadSpawnedDual(
			this.pi,
			{
				thread_id: threadId,
				thread_name: params.thread_name,
				parent_id: parentId,
				depth,
				agent_type: params.agent_type,
			},
			createThreadSpawnedActivity({
				thread_id: threadId,
				thread_name: params.thread_name,
				agent_type: params.agent_type,
				task: params.task,
			}),
		);

		return {
			thread_id: threadId,
			thread_name: params.thread_name,
			agent_type: params.agent_type,
			task: params.task,
		};
	}

	async wait(
		ctx: ExtensionContext,
		params: WaitThreadParams,
		onUpdate?: (update: WaitThreadUpdate) => void,
	): Promise<WaitThreadResult> {
		const sessions = await Promise.all(
			params.thread_ids.map(async (threadId) => {
				const session = await findThreadSessionById(ctx.cwd, threadId);
				if (!session) {
					throw new Error(`Thread not found: ${threadId}`);
				}
				return session;
			}),
		);

		for (const session of sessions) {
			emitThreadWaitTranscript(
				this.pi,
				createThreadWaitActivity({
					thread_id: session.meta.thread_id,
					thread_name: session.meta.thread_name,
					agent_type: session.meta.agent_type,
					phase: "started",
					status: "Running",
				}),
			);
		}

		const timeoutMs = params.timeout !== undefined ? params.timeout * 1000 : undefined;

		let completions: Map<ThreadId, ThreadCompletedStatus>;
		try {
			completions = await pollThreadCompletions(
				params.thread_ids,
				(threadId) => {
					const active = this.threads.get(threadId);
					const session = sessions.find((item) => item.meta.thread_id === threadId);
					if (!session) return undefined;

					const manager = SessionManager.open(session.path);
					const completion = findLatestThreadCompleted(manager.getEntries());
					if (completion) return completion.status;
					if (!active) return undefined;
					return undefined;
				},
				{
					timeoutMs,
					pollIntervalMs: WAIT_POLL_INTERVAL_MS,
					sleep: this.sleep,
					onPoll: () => {
						if (!onUpdate) return;
						onUpdate({
							waiting: sessions.map((session) => {
								const threadId = session.meta.thread_id;
								const active = this.threads.get(threadId);
								const manager = SessionManager.open(session.path);
								const completion = findLatestThreadCompleted(manager.getEntries());
								return {
									thread_id: threadId,
									thread_name: session.meta.thread_name,
									agent_type: session.meta.agent_type,
									task: session.meta.task,
									status: completion?.status ?? active?.status ?? "running",
									activities: active ? getRingBufferTail(active.activityBuffer, 8) : [],
								};
							}),
						});
					},
				},
			);
		} catch (error) {
			if (error instanceof ThreadWaitTimeoutError) {
				this.reconcileActiveThreadsAfterWaitTimeout(params.thread_ids, sessions);
			}
			throw error;
		}

		const threads = sessions.map((session) => {
			const threadId = session.meta.thread_id;
			const status = completions.get(threadId) ?? "error";
			const manager = SessionManager.open(session.path);
			const entries = manager.getEntries();
			const completion = findLatestThreadCompleted(entries);
			const output = extractThreadOutput(entries);
			const active = this.threads.get(threadId);
			const activities = active ? [...active.activityBuffer.lines] : [];

			emitThreadWaitTranscript(
				this.pi,
				createThreadWaitActivity({
					thread_id: threadId,
					thread_name: session.meta.thread_name,
					agent_type: session.meta.agent_type,
					phase: "finished",
					status,
				}),
			);

			this.threads.delete(threadId);

			return {
				thread_id: threadId,
				thread_name: session.meta.thread_name,
				agent_type: session.meta.agent_type,
				task: session.meta.task,
				status,
				activities,
				output,
				usage: completion?.usage,
			};
		});

		return { threads };
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
				model: session.model,
			} satisfies ThreadSummary;
		});

		return summaries.filter((summary) => matchesListFilter(summary, params.status));
	}

	async send(ctx: ExtensionContext, params: SendToThreadParams): Promise<SendToThreadResult> {
		const session = await findThreadSessionById(ctx.cwd, params.thread_id);
		if (!session) {
			throw new Error(`Thread not found: ${params.thread_id}`);
		}

		const record = this.threads.get(params.thread_id);
		if (!record || record.status !== "running") {
			throw new Error(`Thread is not running: ${params.thread_id}`);
		}

		const parentMeta = findFirstThreadMeta(ctx.sessionManager.getEntries());
		const author = resolveParentAuthor(parentMeta);

		appendInterAgentUserMessage(SessionManager.open(record.sessionFile), {
			author,
			recipient: record.threadName,
			content: params.message,
		});

		writeThreadSendDual(
			this.pi,
			createThreadSendActivity({
				thread_id: params.thread_id,
				thread_name: record.threadName,
				agent_type: record.agent_type,
				message_preview: params.message,
			}),
		);

		return {
			thread_id: params.thread_id,
			thread_name: record.threadName,
		};
	}

	async interrupt(ctx: ExtensionContext, params: InterruptThreadParams): Promise<InterruptThreadResult> {
		const record = this.threads.get(params.thread_id);
		if (!record || record.status !== "running") {
			throw new Error(`Thread is not running: ${params.thread_id}`);
		}

		const childSession = SessionManager.open(record.sessionFile);
		writeThreadCompleted(childSession, { status: "aborted" });

		await this.killSubprocess(record.process);

		emitThreadInterruptedTranscript(
			this.pi,
			createThreadInterruptedActivity({
				thread_id: params.thread_id,
				thread_name: record.threadName,
				agent_type: record.agent_type,
			}),
		);

		this.threads.delete(params.thread_id);

		return {
			thread_id: params.thread_id,
			thread_name: record.threadName,
			status: "aborted",
		};
	}

	async close(ctx: ExtensionContext, params: CloseThreadParams): Promise<CloseThreadResult> {
		if (this.threads.has(params.thread_id)) {
			throw new Error(`Thread is still running; use interrupt_thread instead: ${params.thread_id}`);
		}

		const session = await findThreadSessionById(ctx.cwd, params.thread_id);
		if (!session) {
			throw new Error(`Thread not found: ${params.thread_id}`);
		}

		if (session.completion?.status !== "completed") {
			const status = session.completion?.status ?? "running";
			throw new Error(`Thread is not completed; cannot close: ${params.thread_id} (status: ${status})`);
		}

		const childSession = SessionManager.open(session.path);
		writeThreadCompleted(childSession, { status: "closed" });

		emitThreadClosedTranscript(
			this.pi,
			createThreadClosedActivity({
				thread_id: params.thread_id,
				thread_name: session.meta.thread_name,
				agent_type: session.meta.agent_type,
			}),
		);

		this.threads.delete(params.thread_id);

		return {
			thread_id: params.thread_id,
			thread_name: session.meta.thread_name,
			status: "closed",
		};
	}

	async resume(ctx: ExtensionContext, threadSessions?: ThreadSessionInfo[]): Promise<ResumeResult> {
		const sessions = threadSessions ?? (await listThreadSessions(ctx.cwd));
		const incomplete = sessions.filter(shouldResumeThreadSession);
		this.threadChildren = await buildThreadChildrenMap(ctx.cwd, undefined, sessions);

		let resumedCount = 0;
		for (const session of incomplete) {
			if (this.threads.has(session.meta.thread_id)) continue;

			const record: ThreadRecord = {
				process: null,
				sessionFile: session.path,
				threadName: session.meta.thread_name,
				status: "running",
				agent_type: session.meta.agent_type,
				depth: session.meta.depth,
				task: session.meta.task,
				stdoutBuffer: createRingBuffer(OUTPUT_RING_BUFFER_SIZE),
				stderrBuffer: createRingBuffer(OUTPUT_RING_BUFFER_SIZE),
				activityBuffer: createRingBuffer(OUTPUT_RING_BUFFER_SIZE),
			};
			this.threads.set(session.meta.thread_id, record);

			record.process = this.startSubprocess({
				sessionFile: session.path,
				prompt: "",
				cwd: ctx.cwd,
				threadId: session.meta.thread_id,
				threadName: session.meta.thread_name,
				agent_type: session.meta.agent_type,
				depth: session.meta.depth,
				task: session.meta.task,
				resume: true,
			});
			resumedCount++;
		}

		if (incomplete.length > 0) {
			ctx.ui.notify(
				`pi-threads: resumed ${resumedCount} of ${incomplete.length} incomplete thread session(s)`,
				"info",
			);
		}

		return {
			incompleteCount: incomplete.length,
			totalThreadSessions: sessions.length,
			resumedCount,
		};
	}

	private startSubprocess(options: {
		sessionFile: string;
		prompt: string;
		model?: string;
		tools?: string[];
		cwd: string;
		threadId: ThreadId;
		threadName: string;
		agent_type: string;
		depth: number;
		task: string;
		resume?: boolean;
	}): ChildProcess {
		const { command, prefixArgs } = resolvePiSpawn();
		const args = buildThreadPiArgs({
			sessionFile: options.sessionFile,
			prompt: options.prompt,
			model: options.model,
			tools: options.tools,
			resume: options.resume,
		});

		const proc = this.spawner.spawn(command, [...prefixArgs, ...args], {
			cwd: options.cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: process.env,
		});

		const recordRef = { current: this.threads.get(options.threadId) };
		const attachBuffers = () => {
			const record = this.threads.get(options.threadId);
			recordRef.current = record;
			return record;
		};

		proc.stdout?.on("data", (chunk: Buffer | string) => {
			const record = attachBuffers();
			if (!record) return;

			for (const rawLine of String(chunk).split(/\r?\n/)) {
				const line = rawLine.trimEnd();
				if (!line) continue;
				pushRingBufferLine(record.stdoutBuffer, line);
				const activity = parseChildStdoutLine(line);
				if (activity) pushRingBufferLine(record.activityBuffer, activity);
			}
		});

		proc.stderr?.on("data", (chunk: Buffer | string) => {
			const record = attachBuffers();
			if (record) pushRingBufferLine(record.stderrBuffer, String(chunk));
		});

		proc.on("exit", (code) => {
			void this.handleSubprocessExit(options.threadId, options.sessionFile, code);
		});

		return proc;
	}

	private reconcileActiveThreadsAfterWaitTimeout(
		threadIds: ThreadId[],
		sessions: Awaited<ReturnType<typeof findThreadSessionById>>[],
	): void {
		for (const threadId of threadIds) {
			const session = sessions.find((item) => item?.meta.thread_id === threadId);
			if (!session) continue;

			const completion = findLatestThreadCompleted(SessionManager.open(session.path).getEntries());
			if (completion) {
				this.threads.delete(threadId);
			}
		}
	}

	private async handleSubprocessExit(
		threadId: ThreadId,
		sessionFile: string,
		exitCode: number | null,
	): Promise<void> {
		const record = this.threads.get(threadId);
		if (!record) return;

		const childSession = SessionManager.open(sessionFile);
		const existingCompletion = findLatestThreadCompleted(childSession.getEntries());
		if (existingCompletion) {
			this.threads.delete(threadId);
			return;
		}

		const status = completionStatusFromExitCode(exitCode);
		writeThreadCompleted(childSession, {
			status,
			exit_code: exitCode ?? undefined,
		});

		this.threads.delete(threadId);
	}

	private killSubprocess(process: ChildProcess | null): Promise<void> {
		if (!process || process.exitCode !== null || process.killed) {
			return Promise.resolve();
		}

		return new Promise((resolve) => {
			let settled = false;
			let sigkillTimer: NodeJS.Timeout | undefined;
			let killTimeoutTimer: NodeJS.Timeout | undefined;
			const finish = () => {
				if (settled) return;
				settled = true;
				if (sigkillTimer !== undefined) clearTimeout(sigkillTimer);
				if (killTimeoutTimer !== undefined) clearTimeout(killTimeoutTimer);
				resolve();
			};

			process.once("exit", finish);

			process.kill("SIGTERM");

			sigkillTimer = setTimeout(() => {
				if (process.exitCode === null && !process.killed) {
					process.kill("SIGKILL");
				}
			}, SIGKILL_TIMEOUT_MS);
			sigkillTimer.unref();

			killTimeoutTimer = setTimeout(finish, KILL_SUBPROCESS_TIMEOUT_MS);
			killTimeoutTimer.unref();
		});
	}
}