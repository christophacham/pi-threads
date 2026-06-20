import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parsePollIntervalMs, startChildMessagePoller } from "./child-message-poller.ts";
import { isThreadSession } from "./persistence.ts";
import { registerThreadRenderers } from "./renderers.ts";
import { registerThreadPicker } from "./thread-picker.ts";
import { ThreadManager } from "./thread-manager.ts";
import { SEND_POLL_FLAG, SEND_POLL_INTERVAL_MS } from "./thread-subprocess.ts";
import { registerThreadTools } from "./tools/index.ts";

export * from "./types.ts";
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

export default function (pi: ExtensionAPI) {
	const threadManager = new ThreadManager(pi);
	registerThreadRenderers(pi);
	registerThreadTools(pi, threadManager);
	registerThreadPicker(pi, threadManager);

	pi.registerFlag(SEND_POLL_FLAG, {
		description: "Child thread session poll interval in milliseconds",
		type: "string",
		default: String(SEND_POLL_INTERVAL_MS),
	});

	pi.on("session_start", async (_event, ctx) => {
		threadManager.bindContext(ctx);

		if (isThreadSession(ctx.sessionManager)) {
			startChildMessagePoller(pi, ctx, {
				pollIntervalMs: parsePollIntervalMs(pi.getFlag(SEND_POLL_FLAG)),
			});
			return;
		}

		await threadManager.resume(ctx);
	});
}