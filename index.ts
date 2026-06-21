/**
 * pi-threads extension entry point.
 *
 * Routes by session role: parent sessions resume ThreadManager and own thread
 * lifecycle; child sessions (thread_meta present) start the message poller instead.
 *
 * ## Public package surface
 *
 * Only the symbols below are part of the supported extension API. Import internal
 * modules directly only from in-repo tests or forks — they are not re-exported.
 *
 * - **default** — Pi extension registration (`ExtensionAPI` → void)
 * - **shouldRespawnThreadsOnSessionStart** — session_start resume policy helper
 * - **contracts** — tool parameter schemas and tool/manager result types
 * - **types** — thread protocol entry types, constants, and activity payloads
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

export * from "./contracts.ts";
export * from "./types.ts";

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