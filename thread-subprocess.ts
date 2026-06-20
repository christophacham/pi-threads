import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const WAIT_POLL_INTERVAL_MS = 500;
export const SEND_POLL_INTERVAL_MS = 2000;
export const SEND_POLL_FLAG = "pi-threads-poll-ms";
export const SIGKILL_TIMEOUT_MS = 5000;
export const STATUS_FEED_MAX_LINES = 3;
export const OUTPUT_RING_BUFFER_SIZE = 200;

/** Default pi-threads extension entry for child subprocesses. */
export const PI_THREADS_EXTENSION_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "index.ts");

export interface BuildThreadPiArgsOptions {
	sessionFile: string;
	prompt: string;
	model?: string;
	tools?: string[];
	/** When true, resume an existing session without injecting a new -p prompt. */
	resume?: boolean;
	extensionEntry?: string;
	argv?: string[];
}

export interface PiSpawnCommand {
	command: string;
	prefixArgs: string[];
}

export interface RingBuffer {
	maxSize: number;
	lines: string[];
}

export function createRingBuffer(maxSize: number): RingBuffer {
	return { maxSize, lines: [] };
}

export function pushRingBufferLine(buffer: RingBuffer, chunk: string): void {
	for (const rawLine of chunk.split(/\r?\n/)) {
		const line = rawLine.trimEnd();
		if (!line) continue;
		buffer.lines.push(line);
		if (buffer.lines.length > buffer.maxSize) {
			buffer.lines.splice(0, buffer.lines.length - buffer.maxSize);
		}
	}
}

export function getRingBufferTail(buffer: RingBuffer, count: number): string[] {
	if (count <= 0) return [];
	return buffer.lines.slice(-count);
}

/** Resolve how to invoke the pi CLI from the current process (node/bun script or binary). */
export function resolvePiSpawn(argv: string[] = process.argv): PiSpawnCommand {
	const execPath = process.execPath;
	const isNode = /[\\/]node(?:\.exe)?$/i.test(execPath);
	const isBun = /[\\/]bun(?:\.exe)?$/i.test(execPath);
	if ((isNode || isBun) && argv[1]) {
		return { command: execPath, prefixArgs: [argv[1]] };
	}
	return { command: execPath, prefixArgs: [] };
}

function parseInheritedExtensionArgs(argv: string[]): string[] {
	const extensionArgs: string[] = [];
	let i = 2;
	while (i < argv.length) {
		const raw = argv[i];
		if (!raw.startsWith("-")) {
			i++;
			continue;
		}

		const eqIdx = raw.indexOf("=");
		const flagName = eqIdx !== -1 ? raw.slice(0, eqIdx) : raw;
		const inlineValue = eqIdx !== -1 ? raw.slice(eqIdx + 1) : undefined;
		const nextToken = argv[i + 1];
		const nextIsValue = nextToken !== undefined && !nextToken.startsWith("-");

		const getValue = (): [string | undefined, number] => {
			if (inlineValue !== undefined) return [inlineValue, 1];
			if (nextIsValue) return [nextToken, 2];
			return [undefined, 1];
		};

		if (flagName === "--no-extensions" || flagName === "-ne") {
			extensionArgs.push(flagName);
			i++;
			continue;
		}

		if (flagName === "--extension" || flagName === "-e") {
			const [value, skip] = getValue();
			if (value !== undefined) {
				extensionArgs.push(flagName, value);
			}
			i += skip;
			continue;
		}

		i++;
	}

	return extensionArgs;
}

/** Build argv for a child pi subprocess (fork runner pattern). */
export function buildThreadPiArgs(options: BuildThreadPiArgsOptions): string[] {
	const {
		sessionFile,
		prompt,
		model,
		tools,
		resume = false,
		extensionEntry = PI_THREADS_EXTENSION_ENTRY,
		argv = process.argv,
	} = options;

	const args: string[] = ["--mode", "json", "--session", sessionFile];

	if (!resume) {
		args.push("-p", prompt);
	}

	if (model) {
		args.push("--model", model);
	}

	if (tools !== undefined) {
		if (tools.length === 0) {
			args.push("--no-tools");
		} else {
			args.push("--tools", tools.join(","));
		}
	}

	args.push("--no-extensions");
	const inheritedExtensions = parseInheritedExtensionArgs(argv);
	if (inheritedExtensions.length > 0) {
		args.push(...inheritedExtensions);
	}
	args.push("--extension", extensionEntry);

	return args;
}