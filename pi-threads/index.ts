import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerThreadRenderers } from "./renderers.ts";

export * from "./types.ts";
export * from "./persistence.ts";
export { registerThreadRenderers, getTranscriptContent } from "./renderers.ts";

export default function (pi: ExtensionAPI) {
	registerThreadRenderers(pi);
}