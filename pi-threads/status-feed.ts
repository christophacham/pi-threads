import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { StatusFeedEntry, ThreadRuntimeStatus } from "./thread-manager.ts";
import type { ThreadCompletedStatus } from "./types.ts";

export const STATUS_FEED_WIDGET_ID = "pi-threads-status-feed";

export type StatusFeedIndicator = "running" | "done" | "error";

export interface PiToolExecutionEvent {
	type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
	toolName?: string;
	args?: Record<string, unknown>;
}

function truncateInline(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength - 3)}...`;
}

function shortPath(value: unknown): string {
	if (typeof value !== "string" || !value) return "...";
	return value.replace(/^\/home\/[^/]+/, "~");
}

/** Format a child subprocess tool call as a compact activity line. */
export function formatToolActivityLine(toolName: string, args?: Record<string, unknown>): string {
	switch (toolName) {
		case "bash": {
			const command = typeof args?.command === "string" ? args.command : "...";
			return `$ ${truncateInline(command.replace(/\s+/g, " ").trim(), 80)}`;
		}
		case "read":
			return `read ${shortPath(args?.path ?? args?.file_path)}`;
		case "edit":
			return `edit ${shortPath(args?.path ?? args?.file_path)}`;
		case "grep": {
			const pattern = typeof args?.pattern === "string" ? args.pattern : "...";
			return `grep ${truncateInline(pattern, 60)}`;
		}
		default:
			return toolName;
	}
}

/** Parse a child pi JSON-mode stdout line into an activity summary, if applicable. */
export function parseChildStdoutLine(line: string): string | null {
	const trimmed = line.trim();
	if (!trimmed.startsWith("{")) return null;

	let event: PiToolExecutionEvent;
	try {
		event = JSON.parse(trimmed) as PiToolExecutionEvent;
	} catch {
		return null;
	}

	if (event.type !== "tool_execution_start" || typeof event.toolName !== "string") {
		return null;
	}

	return formatToolActivityLine(event.toolName, event.args);
}

export function resolveStatusFeedIndicator(
	status: ThreadRuntimeStatus | ThreadCompletedStatus,
): StatusFeedIndicator {
	if (status === "running") return "running";
	if (status === "completed" || status === "closed") return "done";
	return "error";
}

export function statusFeedIndicatorGlyph(indicator: StatusFeedIndicator): string {
	switch (indicator) {
		case "running":
			return "⏳";
		case "done":
			return "✓";
		case "error":
			return "✗";
	}
}

/** Build widget lines for the live subagent status feed. */
export function formatStatusFeedWidgetLines(feed: StatusFeedEntry[]): string[] {
	const running = feed.filter((entry) => entry.status === "running");
	if (running.length === 0) return [];

	const lines = ["Sub-agents running"];
	for (const entry of running) {
		const indicator = statusFeedIndicatorGlyph(resolveStatusFeedIndicator(entry.status));
		lines.push(`${indicator} ${entry.thread_name}`);
		for (const activity of entry.lines) {
			lines.push(`  ${activity}`);
		}
	}
	return lines;
}

export function updateStatusFeedWidget(ctx: ExtensionContext, feed: StatusFeedEntry[]): void {
	const lines = formatStatusFeedWidgetLines(feed);
	if (lines.length === 0) {
		clearStatusFeedWidget(ctx);
		return;
	}
	ctx.ui.setWidget(STATUS_FEED_WIDGET_ID, lines, { placement: "belowEditor" });
}

export function clearStatusFeedWidget(ctx: ExtensionContext): void {
	ctx.ui.setWidget(STATUS_FEED_WIDGET_ID, undefined);
}