import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import {
	formatClosedTranscriptContent,
	formatInterruptedTranscriptContent,
	formatSendTranscriptContent,
	formatSpawnedTranscriptContent,
	formatWaitTranscriptContent,
} from "./persistence.ts";
import {
	THREAD_TRANSCRIPT_TYPES,
	type SubAgentActivityEvent,
	type ThreadClosedActivity,
	type ThreadInterruptedActivity,
	type ThreadSendActivity,
	type ThreadSpawnedActivity,
	type ThreadWaitActivity,
} from "./types.ts";

function renderBulletLine(
	theme: Theme,
	color: "success" | "warning" | "error" | "muted" | "accent",
	text: string,
): Text {
	return new Text(`${theme.fg(color, "•")} ${text}`, 0, 0);
}

function wrapInBox(theme: Theme, child: Text): Box {
	const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
	box.addChild(child);
	return box;
}

export function registerThreadRenderers(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<ThreadSpawnedActivity>(THREAD_TRANSCRIPT_TYPES.SPAWNED, (message, _options, theme) => {
		const details = message.details;
		const content = details ? formatSpawnedTranscriptContent(details) : String(message.content);
		const text = renderBulletLine(theme, "success", content);
		return wrapInBox(theme, text);
	});

	pi.registerMessageRenderer<ThreadSendActivity>(THREAD_TRANSCRIPT_TYPES.SEND, (message, _options, theme) => {
		const details = message.details;
		const content = details ? formatSendTranscriptContent(details) : String(message.content);
		const text = renderBulletLine(theme, "accent", content);
		return wrapInBox(theme, text);
	});

	pi.registerMessageRenderer<ThreadWaitActivity>(THREAD_TRANSCRIPT_TYPES.WAIT, (message, _options, theme) => {
		const details = message.details;
		const content = details ? formatWaitTranscriptContent(details) : String(message.content);
		const color = details?.phase === "finished" ? "success" : "warning";
		const text = renderBulletLine(theme, color, content);
		return wrapInBox(theme, text);
	});

	pi.registerMessageRenderer<ThreadInterruptedActivity>(
		THREAD_TRANSCRIPT_TYPES.INTERRUPTED,
		(message, _options, theme) => {
			const details = message.details;
			const content = details ? formatInterruptedTranscriptContent(details) : String(message.content);
			const text = renderBulletLine(theme, "error", content);
			return wrapInBox(theme, text);
		},
	);

	pi.registerMessageRenderer<ThreadClosedActivity>(THREAD_TRANSCRIPT_TYPES.CLOSED, (message, _options, theme) => {
		const details = message.details;
		const content = details ? formatClosedTranscriptContent(details) : String(message.content);
		const text = renderBulletLine(theme, "muted", content);
		return wrapInBox(theme, text);
	});
}

export function getTranscriptContent(event: SubAgentActivityEvent): string {
	switch (event.customType) {
		case THREAD_TRANSCRIPT_TYPES.SPAWNED:
			return formatSpawnedTranscriptContent(event);
		case THREAD_TRANSCRIPT_TYPES.SEND:
			return formatSendTranscriptContent(event);
		case THREAD_TRANSCRIPT_TYPES.WAIT:
			return formatWaitTranscriptContent(event);
		case THREAD_TRANSCRIPT_TYPES.INTERRUPTED:
			return formatInterruptedTranscriptContent(event);
		case THREAD_TRANSCRIPT_TYPES.CLOSED:
			return formatClosedTranscriptContent(event);
	}
}