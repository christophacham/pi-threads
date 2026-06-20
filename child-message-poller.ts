import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	collectUserMessageEntryIds,
	findLatestThreadCompleted,
	findUnprocessedUserMessages,
} from "./persistence.ts";
import { SEND_POLL_INTERVAL_MS } from "./thread-subprocess.ts";

export interface ChildMessagePollerOptions {
	pollIntervalMs?: number;
}

export interface ChildMessagePollerHandle {
	stop: () => void;
	pollOnce: () => Promise<void>;
	processedIds: ReadonlySet<string>;
}

export function parsePollIntervalMs(value: boolean | string | undefined, fallback = SEND_POLL_INTERVAL_MS): number {
	if (value === undefined || value === false) return fallback;
	const parsed = Number.parseInt(String(value), 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return parsed;
}

/** Poll a thread child session file and inject new user messages via steer/followUp. */
export function startChildMessagePoller(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	options: ChildMessagePollerOptions = {},
): ChildMessagePollerHandle {
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (!sessionFile) {
		return {
			stop: () => {},
			pollOnce: async () => {},
			processedIds: new Set(),
		};
	}

	const pollIntervalMs = options.pollIntervalMs ?? SEND_POLL_INTERVAL_MS;
	const processedIds = new Set(collectUserMessageEntryIds(ctx.sessionManager.getEntries()));
	let stopped = false;
	let timer: ReturnType<typeof setInterval> | undefined;

	const pollOnce = async (): Promise<void> => {
		if (stopped) return;

		const session = SessionManager.open(sessionFile);
		const entries = session.getEntries();

		if (findLatestThreadCompleted(entries)) {
			stop();
			return;
		}

		const newMessages = findUnprocessedUserMessages(entries, processedIds);
		for (const message of newMessages) {
			processedIds.add(message.id);
			if (ctx.isIdle()) {
				pi.sendUserMessage(message.text);
			} else {
				pi.sendUserMessage(message.text, { deliverAs: "steer" });
			}
		}
	};

	const stop = (): void => {
		stopped = true;
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	};

	timer = setInterval(() => {
		void pollOnce();
	}, pollIntervalMs);
	timer.unref?.();

	return {
		stop,
		pollOnce,
		processedIds,
	};
}