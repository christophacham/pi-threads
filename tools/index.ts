import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { StatusFeedWidgetController } from "../status-feed-widget.ts";
import type { ThreadManager } from "../thread-manager.ts";
import { registerCloseThreadTool } from "./close.ts";
import { registerInterruptThreadTool } from "./interrupt.ts";
import { registerListThreadsTool } from "./list.ts";
import { registerSendToThreadTool } from "./send.ts";
import { registerSpawnThreadTool } from "./spawn.ts";
import { registerWaitThreadTool } from "./wait.ts";

export function registerThreadTools(
	pi: ExtensionAPI,
	threadManager: ThreadManager,
	statusFeedWidget: StatusFeedWidgetController,
): void {
	registerSpawnThreadTool(pi, threadManager);
	registerWaitThreadTool(pi, threadManager, statusFeedWidget);
	registerSendToThreadTool(pi, threadManager);
	registerListThreadsTool(pi, threadManager);
	registerInterruptThreadTool(pi, threadManager);
	registerCloseThreadTool(pi, threadManager);
}