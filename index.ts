/**
 * pi-threads extension entry point.
 *
 * Routes by session role: parent sessions resume ThreadManager and own thread
 * lifecycle; child sessions (thread_meta present) start the message poller instead.
 */
import type { ExtensionAPI, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import {
	type ChildMessagePollerHandle,
	parsePollIntervalMs,
	startChildMessagePoller,
} from "./child-message-poller.ts";
import { isThreadSession, listThreadSessions } from "./persistence.ts";
import { registerThreadRenderers } from "./renderers.ts";
import { registerThreadPicker } from "./thread-picker.ts";
import { ThreadManager } from "./thread-manager.ts";
import { SEND_POLL_FLAG, SEND_POLL_INTERVAL_MS } from "./thread-subprocess.ts";
import { registerThreadTools } from "./tools/index.ts";

export * from "./types.ts";
export * from "./thread-tool-error.ts";
export * from "./persistence.ts";
export * from "./thread-manager.ts";
export { registerThreadRenderers, getTranscriptContent } from "./renderers.ts";
export { registerThreadPicker, ThreadNavigator } from "./thread-picker.ts";
export {
	formatStatusFeedWidgetLines,
	parseChildStdoutLine,
	updateStatusFeedWidget,
	clearStatusFeedWidget,
} from "./status-feed.ts";
export { registerThreadTools } from "./tools/index.ts";
export { startChildMessagePoller, parsePollIntervalMs } from "./child-message-poller.ts";

/** True when session_start should respawn incomplete thread subprocesses. */
export function shouldRespawnThreadsOnSessionStart(reason: SessionStartEvent["reason"]): boolean {
	return reason !== "reload" && reason !== "fork";
}

export default function (pi: ExtensionAPI) {
	const threadManager = new ThreadManager(pi);
	registerThreadRenderers(pi);
	registerThreadTools(pi, threadManager);
	const navigator = registerThreadPicker(pi, threadManager);

	pi.registerFlag(SEND_POLL_FLAG, {
		description: "Child thread session poll interval in milliseconds",
		type: "string",
		default: String(SEND_POLL_INTERVAL_MS),
	});

	let childMessagePoller: ChildMessagePollerHandle | undefined;

	const stopChildMessagePoller = (): void => {
		childMessagePoller?.stop();
		childMessagePoller = undefined;
	};

	pi.on("session_start", async (event, ctx) => {
		threadManager.bindContext(ctx);

		if (isThreadSession(ctx.sessionManager)) {
			stopChildMessagePoller();
			childMessagePoller = startChildMessagePoller(pi, ctx, {
				pollIntervalMs: parsePollIntervalMs(pi.getFlag(SEND_POLL_FLAG)),
			});
			await navigator.refresh(ctx, threadManager);
			navigator.updateStatusBar(ctx);
			return;
		}

		stopChildMessagePoller();
		const sessions = await listThreadSessions(ctx.cwd);
		if (shouldRespawnThreadsOnSessionStart(event.reason)) {
			await threadManager.resume(ctx, sessions);
		}
		await navigator.refresh(ctx, threadManager, sessions);
		navigator.updateStatusBar(ctx);
	});

	pi.on("session_shutdown", () => {
		stopChildMessagePoller();
	});
}