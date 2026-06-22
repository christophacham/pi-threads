import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
	buildStatusFeedWidgetComponent,
	buildStatusFeedWidgetLines,
	formatToolActivityLine,
	MAX_STATUS_FEED_THREADS,
	parseChildStdoutLine,
	resolveStatusFeedIndicator,
	statusFeedHasRunningThreads,
	statusFeedIndicatorGlyph,
} from "./status-feed.ts";
import type { StatusFeedEntry } from "./thread-manager.ts";

function createTheme(): Theme {
	const fg = (color: string, text: string) => `[${color}]${text}[/]`;
	return {
		fg,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => `**${text}**`,
	} as unknown as Theme;
}

function renderWidgetText(factory: (_tui: unknown, theme: Theme) => Component, width = 120): string {
	const component = factory(undefined, createTheme());
	return component.render(width).join("\n");
}

describe("status-feed", () => {
	it("formats tool activity lines per AC", () => {
		expect(formatToolActivityLine("read", { path: "/home/user/src/index.ts" })).toBe("read ~/src/index.ts");
		expect(formatToolActivityLine("bash", { command: "git status" })).toBe("$ git status");
		expect(formatToolActivityLine("edit", { path: "foo.ts" })).toBe("edit foo.ts");
		expect(formatToolActivityLine("grep", { pattern: "TODO" })).toBe("grep TODO");
	});

	it("parses tool_execution_start JSON stdout lines", () => {
		const line = JSON.stringify({
			type: "tool_execution_start",
			toolCallId: "call_1",
			toolName: "read",
			args: { path: "src/index.ts" },
		});
		expect(parseChildStdoutLine(line)).toBe("read src/index.ts");
		expect(parseChildStdoutLine("not json")).toBeNull();
		expect(parseChildStdoutLine(JSON.stringify({ type: "agent_end" }))).toBeNull();
	});

	it("builds themed widget lines with header, tree layout, and activity", () => {
		const feed: StatusFeedEntry[] = [
			{
				thread_id: "t1",
				thread_name: "worker",
				status: "running",
				lines: ["read src/index.ts", "$ git status"],
			},
			{
				thread_id: "t2",
				thread_name: "done-agent",
				status: "completed",
				lines: ["edit foo.ts"],
			},
		];

		const lines = buildStatusFeedWidgetLines(feed, createTheme(), 120);
		expect(lines).toEqual([
			"[accent]Sub-agents running[/]",
			"[dim]└─[/] ⏳ **worker**",
			"[dim]   [/] [dim]⎿  read src/index.ts[/]",
			"[dim]   [/] [dim]⎿  $ git status[/]",
		]);
	});

	it("indents nested threads when depth is greater than 1", () => {
		const feed: StatusFeedEntry[] = [
			{
				thread_id: "t1",
				thread_name: "nested-worker",
				status: "running",
				depth: 2,
				lines: ["read src/index.ts"],
			},
		];

		const lines = buildStatusFeedWidgetLines(feed, createTheme(), 120);
		expect(lines[1]).toContain("  ⏳ **nested-worker**");
	});

	it("shows +N more when running threads exceed the visible budget", () => {
		const feed: StatusFeedEntry[] = Array.from({ length: MAX_STATUS_FEED_THREADS + 2 }, (_, index) => ({
			thread_id: `t${index}`,
			thread_name: `worker-${index}`,
			status: "running" as const,
			lines: [],
		}));

		const lines = buildStatusFeedWidgetLines(feed, createTheme(), 120);
		expect(lines.some((line) => line.includes("+2 more"))).toBe(true);
	});

	it("returns empty widget lines when no running threads", () => {
		const feed: StatusFeedEntry[] = [
			{
				thread_id: "t1",
				thread_name: "done-agent",
				status: "completed",
				lines: [],
			},
		];
		expect(buildStatusFeedWidgetLines(feed, createTheme())).toEqual([]);
		expect(statusFeedHasRunningThreads(feed)).toBe(false);
	});

	it("maps runtime statuses to indicator glyphs", () => {
		expect(resolveStatusFeedIndicator("running")).toBe("running");
		expect(resolveStatusFeedIndicator("completed")).toBe("done");
		expect(resolveStatusFeedIndicator("error")).toBe("error");
		expect(statusFeedIndicatorGlyph("running")).toBe("⏳");
		expect(statusFeedIndicatorGlyph("done")).toBe("✓");
		expect(statusFeedIndicatorGlyph("error")).toBe("✗");
	});

	it("buildStatusFeedWidgetComponent renders a pi-tui Component", () => {
		const feed: StatusFeedEntry[] = [
			{
				thread_id: "t1",
				thread_name: "worker",
				status: "running",
				lines: ["read src/index.ts"],
			},
		];

		const text = renderWidgetText(buildStatusFeedWidgetComponent(() => feed, () => false));
		expect(text).toContain("Sub-agents running");
		expect(text).toContain("worker");
		expect(text).toContain("read src/index.ts");
	});

	it("re-reads tools-expanded state on each render for line budget", () => {
		const feed: StatusFeedEntry[] = [
			{
				thread_id: "t1",
				thread_name: "worker",
				status: "running",
				lines: Array.from({ length: 12 }, (_, index) => `activity-${index}`),
			},
		];

		const originalRows = process.stdout.rows;
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 30 });
		try {
			let toolsExpanded = false;
			const factory = buildStatusFeedWidgetComponent(() => feed, () => toolsExpanded);
			const component = factory(undefined, createTheme());

			const collapsed = component.render(120);
			expect(collapsed.some((line) => line.includes("Ctrl+O expands"))).toBe(true);
			expect(collapsed.length).toBe(10);

			toolsExpanded = true;
			const expanded = component.render(120);
			expect(expanded.some((line) => line.includes("Ctrl+O expands"))).toBe(false);
			expect(expanded.length).toBeGreaterThan(collapsed.length);
		} finally {
			if (originalRows === undefined) {
				Reflect.deleteProperty(process.stdout, "rows");
			} else {
				Object.defineProperty(process.stdout, "rows", { configurable: true, value: originalRows });
			}
		}
	});

	it("truncates long lines safely to terminal width", () => {
		const feed: StatusFeedEntry[] = [
			{
				thread_id: "t1",
				thread_name: "worker",
				status: "running",
				lines: ["x".repeat(200)],
			},
		];

		const lines = buildStatusFeedWidgetLines(feed, createTheme(), 40);
		for (const line of lines) {
			expect(line.length).toBeLessThanOrEqual(80);
		}
		expect(lines.at(-1)?.endsWith("…")).toBe(true);
	});
});