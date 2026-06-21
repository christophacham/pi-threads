import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type {
	CloseThreadResult,
	InterruptThreadResult,
	SendToThreadResult,
	SpawnThreadResult,
	ThreadSummary,
	WaitThreadItem,
	WaitThreadResult,
} from "./contracts.ts";
import { THREAD_TOOL_ERROR_CODES } from "./thread-tool-error.ts";
import { toolError } from "./tools/common.ts";
import {
	fmtThreadUsage,
	formatListThreadLine,
	formatSpawnScope,
	renderCloseThreadResult,
	renderInterruptThreadResult,
	renderListThreadsResult,
	renderSendToThreadResult,
	renderSpawnThreadResult,
	renderWaitThreadResult,
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

function renderComponentText(component: Component, width = 120): string {
	return component.render(width).join("\n");
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

	it("promotes orphan and cyclic threads instead of dropping them from tree order", () => {
		const threads: ThreadSummary[] = [
			{
				thread_id: "alpha",
				thread_name: "alpha",
				parent_id: "beta",
				depth: 2,
				status: "running",
				task: "alpha task",
			},
			{
				thread_id: "beta",
				thread_name: "beta",
				parent_id: "alpha",
				depth: 2,
				status: "completed",
				task: "beta task",
			},
		];

		expect(sortThreadsTree(threads).map((thread) => thread.thread_id)).toEqual(["alpha", "beta"]);
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

	it("renderResult handlers return fallback text and hints on tool errors", () => {
		const theme = createTheme();
		const errorMessage = "Thread not found: abc123";
		const errorResult = toolError({ code: THREAD_TOOL_ERROR_CODES.THREAD_NOT_FOUND, message: errorMessage, thread_id: "abc123" }) as AgentToolResult<unknown>;
		const spawnArgs = {
			task: "scan repo",
			thread_name: "worker",
			agent_type: "researcher",
		};

		const cases = [
			renderSpawnThreadResult(errorResult as AgentToolResult<SpawnThreadResult>, { expanded: false }, theme, {
				args: spawnArgs,
				isError: true,
			}),
			renderWaitThreadResult(
				errorResult as AgentToolResult<WaitThreadResult | { waiting: WaitThreadItem[] }>,
				{ expanded: false, isPartial: false },
				theme,
				{ isError: true },
			),
			renderListThreadsResult(errorResult as AgentToolResult<{ threads: ThreadSummary[] }>, { expanded: false }, theme, {
				isError: true,
			}),
			renderSendToThreadResult(errorResult as AgentToolResult<SendToThreadResult>, { expanded: false, isPartial: false }, theme, {
				isError: true,
			}),
			renderInterruptThreadResult(
				errorResult as AgentToolResult<InterruptThreadResult>,
				{ expanded: false, isPartial: false },
				theme,
				{ isError: true },
			),
			renderCloseThreadResult(errorResult as AgentToolResult<CloseThreadResult>, { expanded: false, isPartial: false }, theme, {
				isError: true,
			}),
		];

		for (const component of cases) { const text = renderComponentText(component); expect(text).toContain(errorMessage); expect(text).toContain("Use list_threads to find valid thread IDs"); }

		const spawnViaToolResultFlag = renderSpawnThreadResult(
			toolError({ code: THREAD_TOOL_ERROR_CODES.UNKNOWN, message: "spawn failed" }) as unknown as AgentToolResult<SpawnThreadResult>,
			{ expanded: true },
			theme,
			{ args: spawnArgs },
		);
		const spawnErrorText = renderComponentText(spawnViaToolResultFlag); expect(spawnErrorText).toContain("spawn failed"); expect(spawnErrorText).toContain("Retry the operation"); expect(spawnErrorText).not.toContain("spawned");
	});

	it("renders timed-out wait_thread results as partial success with guidance", () => {
		const theme = createTheme();
		const result: WaitThreadResult = {
			timedOut: true,
			threads: [
				{
					thread_id: "fast",
					thread_name: "fast",
					agent_type: "worker",
					task: "done",
					status: "completed",
				},
				{
					thread_id: "slow",
					thread_name: "slow",
					agent_type: "worker",
					task: "still going",
					status: "running",
				},
			],
		};
		const toolResult = {
			content: [{ type: "text", text: "partial" }],
			details: result,
		} as AgentToolResult<WaitThreadResult>;

		const expanded = renderComponentText(
			renderWaitThreadResult(toolResult, { expanded: true, isPartial: false }, theme),
		);

		expect(expanded).toContain("fast");
		expect(expanded).toContain("slow");
		expect(expanded).toContain("timed out (partial)");
		expect(expanded).toContain("partial results");
		expect(expanded).toContain("Call wait_thread again");
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