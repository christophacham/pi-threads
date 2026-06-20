import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { ThreadSummary, WaitThreadItem } from "./thread-manager.ts";
import {
	fmtThreadUsage,
	formatListThreadLine,
	formatSpawnScope,
	sortThreadsTree,
} from "./tool-render.ts";

function createTheme(): Theme {
	const fg = (color: string, text: string) => `[${color}]${text}[/]`;
	return {
		fg,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => `**${text}**`,
	} as unknown as Theme;
}

describe("tool-render helpers", () => {
	it("formats spawn scope from fork_turns, tools, model, and cwd", () => {
		expect(
			formatSpawnScope({
				task: "scan",
				thread_name: "worker",
				agent_type: "researcher",
				fork_turns: 3,
				tools: ["read", "bash"],
				model: "claude-sonnet",
				cwd: "/home/user/proj",
			}),
		).toBe("fork:3 tools:read,bash model:claude-sonnet cwd:~/proj");
	});

	it("sorts threads into depth-first tree order", () => {
		const threads: ThreadSummary[] = [
			{
				thread_id: "child",
				thread_name: "child",
				parent_id: "root",
				depth: 2,
				status: "running",
				task: "child task",
			},
			{
				thread_id: "root",
				thread_name: "root",
				parent_id: "missing-parent",
				depth: 1,
				status: "completed",
				task: "root task",
			},
			{
				thread_id: "sibling",
				thread_name: "sibling",
				parent_id: "root",
				depth: 2,
				status: "error",
				task: "sibling task",
			},
		];

		expect(sortThreadsTree(threads).map((thread) => thread.thread_id)).toEqual([
			"root",
			"child",
			"sibling",
		]);
	});

	it("formats list thread lines with depth indentation and theme colors", () => {
		const theme = createTheme();
		const line = formatListThreadLine(
			{
				thread_id: "t1",
				thread_name: "worker",
				parent_id: "p1",
				depth: 2,
				status: "running",
				task: "do work",
			},
			theme.fg.bind(theme),
			theme.bold.bind(theme),
		);

		expect(line).toContain("[warning]⏳[/]");
		expect(line).toContain("**worker**");
		expect(line).toContain("do work");
		expect(line.startsWith(" ")).toBe(true);
	});

	it("formats per-thread usage stats", () => {
		expect(
			fmtThreadUsage(
				{
					input: 1200,
					output: 340,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1540,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0042 },
				},
				"claude-sonnet",
			),
		).toBe("↑1.2k ↓340 $0.0042 claude-sonnet");
	});

	it("models wait thread item shape used by renderers", () => {
		const item: WaitThreadItem = {
			thread_id: "t1",
			thread_name: "worker",
			agent_type: "researcher",
			task: "scan repo",
			status: "completed",
			activities: ["read src/index.ts", "$ git status"],
			output: "done",
			usage: {
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 150,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
			},
		};

		expect(item.activities).toHaveLength(2);
		expect(item.output).toBe("done");
	});
});