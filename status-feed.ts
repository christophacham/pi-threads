import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { ThreadRuntimeStatus } from "./contracts.ts";
import type { StatusFeedEntry } from "./thread-manager.ts";
import type { ThreadCompletedStatus } from "./types.ts";

export const STATUS_FEED_WIDGET_ID = "pi-threads-status-feed";
export const MAX_STATUS_FEED_THREADS = 4;

export type StatusFeedIndicator = "running" | "done" | "error";

type Theme = ExtensionContext["ui"]["theme"];

export interface PiToolExecutionEvent {
	type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end";
	toolName?: string;
	args?: Record<string, unknown>;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function getTermWidth(): number {
	return process.stdout.columns || 120;
}

/**
 * Truncate a line to maxWidth, preserving ANSI styling through the ellipsis.
 *
 * pi-tui's truncateToWidth adds \x1b[0m before ellipsis which resets all styling,
 * causing background color bleed in the TUI. This implementation tracks active
 * ANSI styles and re-applies them before the ellipsis.
 */
function truncLine(text: string, maxWidth: number): string {
	if (visibleWidth(text) <= maxWidth) return text;

	const targetWidth = maxWidth - 1;
	let result = "";
	let currentWidth = 0;
	let activeStyles: string[] = [];
	let i = 0;

	while (i < text.length) {
		const ansiMatch = text.slice(i).match(/^\x1b\[[0-9;]*m/);
		if (ansiMatch) {
			const code = ansiMatch[0];
			result += code;

			if (code === "\x1b[0m" || code === "\x1b[m") {
				activeStyles = [];
			} else {
				activeStyles.push(code);
			}
			i += code.length;
			continue;
		}

		let end = i;
		while (end < text.length && !text.slice(end).match(/^\x1b\[[0-9;]*m/)) {
			end++;
		}

		const textPortion = text.slice(i, end);
		for (const seg of segmenter.segment(textPortion)) {
			const grapheme = seg.segment;
			const graphemeWidth = visibleWidth(grapheme);

			if (currentWidth + graphemeWidth > targetWidth) {
				return result + activeStyles.join("") + "…";
			}

			result += grapheme;
			currentWidth += graphemeWidth;
		}
		i = end;
	}

	return result + activeStyles.join("") + "…";
}

function themeBold(theme: Theme, text: string): string {
	return ((theme as { bold?: (value: string) => string }).bold?.(text)) ?? text;
}

function truncateInline(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength - 3)}...`;
}

function shortPath(value: unknown): string {
	if (typeof value !== "string" || !value) return "...";
	return value.replace(/^\/home\/[^/]+/, "~");
}

function depthIndent(depth: number | undefined): string {
	if (!depth || depth <= 1) return "";
	return "  ".repeat(depth - 1);
}

function fitWidgetLineBudget(lines: string[], theme: Theme, width: number, expanded: boolean): string[] {
	const rows = process.stdout.rows || 30;
	const budget = expanded
		? Math.max(12, Math.min(24, Math.floor(rows * 0.55)))
		: Math.max(10, Math.min(14, Math.floor(rows * 0.35)));
	if (lines.length <= budget) return lines;
	const visibleLines = Math.max(1, budget - 1);
	const hiddenCount = lines.length - visibleLines;
	const hint = expanded
		? `… ${hiddenCount} lines hidden`
		: `… ${hiddenCount} lines hidden · Ctrl+O expands`;
	return [...lines.slice(0, visibleLines), truncLine(theme.fg("dim", hint), width)];
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

export function statusFeedHasRunningThreads(feed: StatusFeedEntry[]): boolean {
	return feed.some((entry) => entry.status === "running");
}

/** Build themed widget lines for the live subagent status feed. */
export function buildStatusFeedWidgetLines(
	feed: StatusFeedEntry[],
	theme: Theme,
	width = getTermWidth(),
): string[] {
	const running = feed.filter((entry) => entry.status === "running");
	if (running.length === 0) return [];

	const lines: string[] = [
		truncLine(theme.fg("accent", "Sub-agents running"), width),
	];

	const items: string[][] = [];
	let hiddenRunning = 0;
	let slots = MAX_STATUS_FEED_THREADS;

	for (const entry of running) {
		if (slots <= 0) {
			hiddenRunning++;
			continue;
		}

		const indicator = statusFeedIndicatorGlyph(resolveStatusFeedIndicator(entry.status));
		const indent = depthIndent(entry.depth);
		const threadLine = `${indent}${indicator} ${themeBold(theme, entry.thread_name)}`;
		const activityLines = entry.lines.map((activity) => theme.fg("dim", `⎿  ${activity}`));
		items.push([threadLine, ...activityLines]);
		slots--;
	}

	if (hiddenRunning > 0) {
		items.push([theme.fg("dim", `+${hiddenRunning} more`)]);
	}

	for (let i = 0; i < items.length; i++) {
		const item = items[i]!;
		const last = i === items.length - 1;
		const branch = last ? "└─" : "├─";
		const continuation = last ? "   " : "│  ";
		lines.push(truncLine(`${theme.fg("dim", branch)} ${item[0]}`, width));
		for (const detail of item.slice(1)) {
			lines.push(truncLine(`${theme.fg("dim", continuation)} ${detail}`, width));
		}
	}

	return lines;
}

class StatusFeedWidgetComponent implements Component {
	constructor(
		private getFeed: () => StatusFeedEntry[],
		private getToolsExpanded: () => boolean,
		private theme: Theme,
	) {}

	invalidate(): void {}

	render(width: number): string[] {
		const feed = this.getFeed();
		const toolsExpanded = this.getToolsExpanded();
		const lines = buildStatusFeedWidgetLines(feed, this.theme, width);
		const container = new Container();
		for (const line of fitWidgetLineBudget(lines, this.theme, width, toolsExpanded)) {
			container.addChild(new Text(line, 1, 0));
		}
		return container.render(width);
	}
}

export function buildStatusFeedWidgetComponent(
	getFeed: () => StatusFeedEntry[],
	getToolsExpanded: () => boolean,
): (_tui: unknown, theme: Theme) => Component {
	return (_tui, theme) => new StatusFeedWidgetComponent(getFeed, getToolsExpanded, theme);
}

export function updateStatusFeedWidget(ctx: ExtensionContext, feed: StatusFeedEntry[]): void {
	if (!statusFeedHasRunningThreads(feed)) {
		clearStatusFeedWidget(ctx);
		return;
	}
	ctx.ui.setWidget(
		STATUS_FEED_WIDGET_ID,
		buildStatusFeedWidgetComponent(
			() => feed,
			() => ctx.ui.getToolsExpanded?.() ?? false,
		),
		{ placement: "belowEditor" },
	);
}

export function clearStatusFeedWidget(ctx: ExtensionContext): void {
	ctx.ui.setWidget(STATUS_FEED_WIDGET_ID, undefined);
}