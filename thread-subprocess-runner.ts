/**
 * Child pi subprocess lifecycle: spawn, stdio capture, graceful kill, exit hooks.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { parseChildStdoutLine } from "./status-feed.ts";
import {
	buildThreadPiArgs,
	KILL_SUBPROCESS_TIMEOUT_MS,
	pushRingBufferLine,
	resolvePiSpawn,
	SIGKILL_TIMEOUT_MS,
	type RingBuffer,
} from "./thread-subprocess.ts";
import type { ThreadId } from "./types.ts";

export interface ThreadSubprocessBuffers {
	stdoutBuffer: RingBuffer;
	stderrBuffer: RingBuffer;
	activityBuffer: RingBuffer;
}

export interface ThreadSubprocessSpawner {
	spawn(command: string, args: string[], options: Parameters<typeof spawn>[2]): ChildProcess;
}

export interface StartSubprocessOptions {
	sessionFile: string;
	prompt: string;
	model?: string;
	tools?: string[];
	cwd: string;
	threadId: ThreadId;
	resume?: boolean;
}

export interface ThreadSubprocessRunnerDeps {
	spawner?: ThreadSubprocessSpawner;
	getRecord: (threadId: ThreadId) => ThreadSubprocessBuffers | undefined;
	onExit: (threadId: ThreadId, sessionFile: string, exitCode: number | null) => void | Promise<void>;
}

export class ThreadSubprocessRunner {
	private readonly spawner: ThreadSubprocessSpawner;
	private readonly getRecord: ThreadSubprocessRunnerDeps["getRecord"];
	private readonly onExit: ThreadSubprocessRunnerDeps["onExit"];

	constructor(deps: ThreadSubprocessRunnerDeps) {
		this.spawner = deps.spawner ?? { spawn };
		this.getRecord = deps.getRecord;
		this.onExit = deps.onExit;
	}

	start(options: StartSubprocessOptions): ChildProcess {
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

		const attachBuffers = () => this.getRecord(options.threadId);

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
			void this.onExit(options.threadId, options.sessionFile, code);
		});

		return proc;
	}

	kill(process: ChildProcess | null): Promise<void> {
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