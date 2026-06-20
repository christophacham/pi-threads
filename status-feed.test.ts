import { describe, expect, it } from "vitest";
import {
	formatStatusFeedWidgetLines,
	formatToolActivityLine,
	parseChildStdoutLine,
	resolveStatusFeedIndicator,
	statusFeedIndicatorGlyph,
} from "./status-feed.ts";
import type { StatusFeedEntry } from "./thread-manager.ts";

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

	it("builds widget lines with header, indicators, and indented activity", () => {
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

		expect(formatStatusFeedWidgetLines(feed)).toEqual([
			"Sub-agents running",
			"⏳ worker",
			"  read src/index.ts",
			"  $ git status",
		]);
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
		expect(formatStatusFeedWidgetLines(feed)).toEqual([]);
	});

	it("maps runtime statuses to indicator glyphs", () => {
		expect(resolveStatusFeedIndicator("running")).toBe("running");
		expect(resolveStatusFeedIndicator("completed")).toBe("done");
		expect(resolveStatusFeedIndicator("error")).toBe("error");
		expect(statusFeedIndicatorGlyph("running")).toBe("⏳");
		expect(statusFeedIndicatorGlyph("done")).toBe("✓");
		expect(statusFeedIndicatorGlyph("error")).toBe("✗");
	});
});