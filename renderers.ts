import type { ExtensionAPI, MessageRenderOptions, MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import {
	formatClosedTranscriptContent,
	formatCompletedTranscriptContent,
	formatInterruptedTranscriptContent,
	formatSendTranscriptContent,
	formatSpawnedTranscriptContent,
	formatWaitTranscriptContent,
} from "./persistence.ts";
import { fmtThreadUsage } from "./tool-render.ts";
import {
	THREAD_TRANSCRIPT_TYPES,
	type SubAgentActivityEvent,
	type ThreadClosedActivity,
	type ThreadCompletedActivity,
	type ThreadInterruptedActivity,
	type ThreadSendActivity,
	type ThreadSpawnedActivity,
	type ThreadWaitActivity,
} from "./types.ts";

const PREVIEW_MAX_LENGTH = 80;

function expandHintText(): string {
	try {
		return keyHint("app.tools.expand", "for details");
	} catch {
		return "Ctrl+O for details";
	}
}

type TranscriptColor = "success" | "warning" | "error" | "muted" | "accent";

function isPreviewTruncated(text: string): boolean {
	const singleLine = text.replace(/\s+/g, " ").trim();
	return singleLine.length > PREVIEW_MAX_LENGTH;
}

function renderTranscriptBullet(
	theme: Theme,
	color: TranscriptColor,
	options: MessageRenderOptions,
	params: {
		collapsed: string;
		expandedLines: string[];
		showExpandHint?: boolean;
		collapsedHint?: string;
	},
): Box {
	const fg = theme.fg.bind(theme);
	const lines: string[] = [];

	if (options.expanded) {
		const [headline, ...detailLines] = params.expandedLines;
		lines.push(`${fg(color, "•")} ${headline ?? params.collapsed}`);
		for (const line of detailLines) {
			if (line.trim()) {
				lines.push(fg("dim", line));
			}
		}
	} else {
		lines.push(`${fg(color, "•")} ${params.collapsed}`);
		if (params.collapsedHint) {
			lines.push(fg("muted", params.collapsedHint));
		} else if (params.showExpandHint) {
			lines.push(fg("muted", `(${expandHintText()})`));
		}
	}

	const text = new Text(lines.join("\n"), 0, 0);
	return wrapInBox(theme, text);
}

function wrapInBox(theme: Theme, child: Text): Box {
	const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
	box.addChild(child);
	return box;
}

function detailLine(label: string, value: string | undefined): string | undefined {
	if (!value?.trim()) return undefined;
	return `${label}: ${value}`;
}

function messageFallbackContent(content: string | unknown): string {
	return typeof content === "string" ? content : String(content);
}

const renderSpawned: MessageRenderer<ThreadSpawnedActivity> = (message, options, theme) => {
	const details = message.details;
	const collapsed = details ? formatSpawnedTranscriptContent(details) : messageFallbackContent(message.content);
	if (!details) {
		return renderTranscriptBullet(theme, "success", options, { collapsed, expandedLines: [collapsed] });
	}

	const expandedLines = [
		`Spawned ${details.thread_name}`,
		detailLine("agent", details.agent_type),
		detailLine("task", details.task),
		detailLine("thread", details.thread_id),
	].filter((line): line is string => Boolean(line));

	return renderTranscriptBullet(theme, "success", options, {
		collapsed,
		expandedLines,
		showExpandHint: isPreviewTruncated(details.task) || Boolean(details.agent_type),
	});
};

const renderSend: MessageRenderer<ThreadSendActivity> = (message, options, theme) => {
	const details = message.details;
	const collapsed = details ? formatSendTranscriptContent(details) : messageFallbackContent(message.content);
	if (!details) {
		return renderTranscriptBullet(theme, "accent", options, { collapsed, expandedLines: [collapsed] });
	}

	const expandedLines = [
		`Sent input to ${details.thread_name}`,
		detailLine("agent", details.agent_type),
		detailLine("message", details.message_preview),
		detailLine("thread", details.thread_id),
	].filter((line): line is string => Boolean(line));

	return renderTranscriptBullet(theme, "accent", options, {
		collapsed,
		expandedLines,
		showExpandHint: isPreviewTruncated(details.message_preview) || Boolean(details.agent_type),
	});
};

const renderWait: MessageRenderer<ThreadWaitActivity> = (message, options, theme) => {
	const details = message.details;
	const collapsed = details ? formatWaitTranscriptContent(details) : messageFallbackContent(message.content);
	if (!details) {
		return renderTranscriptBullet(theme, "warning", options, { collapsed, expandedLines: [collapsed] });
	}

	const color = details.phase === "finished" ? "success" : "warning";
	const expandedLines = [
		details.phase === "started"
			? `Waiting for ${details.thread_name}`
			: `Finished waiting → ${details.thread_name}`,
		detailLine("status", details.status ?? (details.phase === "started" ? "Running" : "Completed")),
		detailLine("agent", details.agent_type),
		detailLine("thread", details.thread_id),
	].filter((line): line is string => Boolean(line));

	return renderTranscriptBullet(theme, color, options, {
		collapsed,
		expandedLines,
		collapsedHint: details.phase === "started" && !options.expanded ? "(live)" : undefined,
		showExpandHint: details.phase === "finished" && Boolean(details.agent_type || details.status),
	});
};

const renderCompleted: MessageRenderer<ThreadCompletedActivity> = (message, options, theme) => {
	const details = message.details;
	const collapsed = details ? formatCompletedTranscriptContent(details) : messageFallbackContent(message.content);
	if (!details) {
		return renderTranscriptBullet(theme, "success", options, { collapsed, expandedLines: [collapsed] });
	}

	const color =
		details.status === "completed" ? "success" : details.status === "error" ? "error" : "warning";
	const usage = fmtThreadUsage(details.usage, details.model);
	const expandedLines = [
		`Background thread finished → ${details.thread_name}`,
		detailLine("status", details.status),
		detailLine("agent", details.agent_type),
		details.result_preview ? `result: ${details.result_preview}` : undefined,
		usage ? `usage: ${usage}` : undefined,
		detailLine("thread", details.thread_id),
	].filter((line): line is string => Boolean(line));

	return renderTranscriptBullet(theme, color, options, {
		collapsed,
		expandedLines,
		showExpandHint: Boolean(
			details.result_preview && isPreviewTruncated(details.result_preview),
		) || Boolean(details.usage) || Boolean(details.agent_type),
	});
};

const renderInterrupted: MessageRenderer<ThreadInterruptedActivity> = (message, options, theme) => {
	const details = message.details;
	const collapsed = details ? formatInterruptedTranscriptContent(details) : messageFallbackContent(message.content);
	if (!details) {
		return renderTranscriptBullet(theme, "error", options, { collapsed, expandedLines: [collapsed] });
	}

	const expandedLines = [
		`Interrupted ${details.thread_name}`,
		detailLine("agent", details.agent_type),
		detailLine("thread", details.thread_id),
	].filter((line): line is string => Boolean(line));

	return renderTranscriptBullet(theme, "error", options, {
		collapsed,
		expandedLines,
		showExpandHint: Boolean(details.agent_type),
	});
};

const renderClosed: MessageRenderer<ThreadClosedActivity> = (message, options, theme) => {
	const details = message.details;
	const collapsed = details ? formatClosedTranscriptContent(details) : messageFallbackContent(message.content);
	if (!details) {
		return renderTranscriptBullet(theme, "muted", options, { collapsed, expandedLines: [collapsed] });
	}

	const usage = fmtThreadUsage(details.usage, details.model);
	const expandedLines = [
		`Closed ${details.thread_name}`,
		detailLine("agent", details.agent_type),
		usage ? `usage: ${usage}` : undefined,
		detailLine("thread", details.thread_id),
	].filter((line): line is string => Boolean(line));

	return renderTranscriptBullet(theme, "muted", options, {
		collapsed,
		expandedLines,
		showExpandHint: Boolean(details.usage) || Boolean(details.agent_type),
	});
};

export function registerThreadRenderers(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<ThreadSpawnedActivity>(THREAD_TRANSCRIPT_TYPES.SPAWNED, renderSpawned);
	pi.registerMessageRenderer<ThreadSendActivity>(THREAD_TRANSCRIPT_TYPES.SEND, renderSend);
	pi.registerMessageRenderer<ThreadWaitActivity>(THREAD_TRANSCRIPT_TYPES.WAIT, renderWait);
	pi.registerMessageRenderer<ThreadCompletedActivity>(THREAD_TRANSCRIPT_TYPES.COMPLETED, renderCompleted);
	pi.registerMessageRenderer<ThreadInterruptedActivity>(THREAD_TRANSCRIPT_TYPES.INTERRUPTED, renderInterrupted);
	pi.registerMessageRenderer<ThreadClosedActivity>(THREAD_TRANSCRIPT_TYPES.CLOSED, renderClosed);
}

export function getTranscriptContent(event: SubAgentActivityEvent): string {
	switch (event.customType) {
		case THREAD_TRANSCRIPT_TYPES.SPAWNED:
			return formatSpawnedTranscriptContent(event);
		case THREAD_TRANSCRIPT_TYPES.SEND:
			return formatSendTranscriptContent(event);
		case THREAD_TRANSCRIPT_TYPES.WAIT:
			return formatWaitTranscriptContent(event);
		case THREAD_TRANSCRIPT_TYPES.COMPLETED:
			return formatCompletedTranscriptContent(event);
		case THREAD_TRANSCRIPT_TYPES.INTERRUPTED:
			return formatInterruptedTranscriptContent(event);
		case THREAD_TRANSCRIPT_TYPES.CLOSED:
			return formatClosedTranscriptContent(event);
	}
}