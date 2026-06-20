import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerThreadRenderers } from "./renderers.ts";
import { ThreadManager } from "./thread-manager.ts";
import { registerThreadTools } from "./tools/index.ts";

export * from "./types.ts";
export * from "./persistence.ts";
export * from "./thread-manager.ts";
export { registerThreadRenderers, getTranscriptContent } from "./renderers.ts";
export { registerThreadTools } from "./tools/index.ts";

export default function (pi: ExtensionAPI) {
	const threadManager = new ThreadManager(pi);
	registerThreadRenderers(pi);
	registerThreadTools(pi, threadManager);

	pi.on("session_start", async (_event, ctx) => {
		threadManager.bindContext(ctx);
		await threadManager.resume(ctx);
	});
}