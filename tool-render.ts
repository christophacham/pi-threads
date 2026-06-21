/**
 * Rich TUI rendering for pi-threads tools.
 *
 * Plain text content is still returned for non-interactive/JSON callers;
 * these hooks only enhance Pi's interactive tool-call widget.
 */

import type { Usage } from "@earendil-works/pi-ai";
import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { statusFeedIndicatorGlyph, resolveStatusFeedIndicator } from "./status-feed.ts";
import type {
	CloseThreadResult,
	InterruptThreadResult,
	ListThreadsParams,
	SendToThreadParams,
	SendToThreadResult,
	SpawnThreadParams,
	SpawnThreadResult,
	ThreadRuntimeStatus,
	ThreadSummary,
	WaitThreadItem,
	WaitThreadParams,
	WaitThreadResult,
} from "./thread-manager.ts";
import { type ThreadToolErrorCode, type ThreadToolErrorDetails, type ThreadToolErrorResult } from "./thread-tool-error.ts";
import type { ThreadCompletedStatus } from "./types.ts";

const COLLAPSED_ACTIVITY_COUNT = 8;
const MAX_TASK_PREVIEW_CHARS = 72;
const MAX_MESSAGE_PREVIEW_CHARS = 60;
export type ThreadToolStatus = ThreadRuntimeStatus | ThreadCompletedStatus | "running";

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function taskPreview(task: unknown): string {
	if (typeof task !== "string" || !task.trim()) return "...";
	return truncate(task.replace(/\s+/g, " ").trim(), MAX_TASK_PREVIEW_CHARS);
}

function messagePreview(message: unknown): string {
	if (typeof message !== "string" || !message.trim()) return "...";
	return truncate(message.replace(/\s+/g, " ").trim(), MAX_MESSAGE_PREVIEW_CHARS);
}

function shortPath(value: unknown): string {
	if (typeof value !== "string" || !value) return "...";
	return value.replace(/^\/home\/[^/]+/, "~");
}

function fmtCount(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1000) return String(Math.round(n));
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtThreadUsage(usage?: Usage, model?: string): string {
	if (!usage) return "";
	const parts: string[] = [];
	if (usage.input) parts.push(`↑${fmtCount(usage.input)}`);
	if (usage.output) parts.push(`↓${fmtCount(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${fmtCount(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${fmtCount(usage.cacheWrite)}`);
	if (usage.cost?.total) parts.push(`$${usage.cost.total.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function getFallbackText(toolResult: AgentToolResult<unknown>): string {
	const content = toolResult?.content;
	if (!Array.isArray(content)) return "(no output)";
	for (const part of content) {
		if (part?.type === "text" && "text" in part && typeof part.text === "string") {
			return part.text;
		}
	}
	return "(no output)";
}

type AgentToolResultWithError<T> = AgentToolResult<T> & { isError?: boolean };

function isToolResultError<T>(
	toolResult: AgentToolResult<T>,
	context?: { isError?: boolean },
): boolean {
	const result = toolResult as AgentToolResultWithError<T>;
	return Boolean(result.isError || context?.isError);
}

const THREAD_TOOL_ERROR_HINTS: Record<ThreadToolErrorCode, string> = { THREAD_NOT_FOUND: "Use list_threads to find valid thread IDs in this workspace.", THREAD_NOT_RUNNING: "Wait for the thread to finish or use interrupt_thread if it is stuck.", THREAD_STILL_RUNNING: "Use interrupt_thread to stop the thread before closing it.", THREAD_NOT_COMPLETED: "Wait until the thread completes successfully before closing it.", SESSION_CREATE_FAILED: "Check workspace permissions and available disk space, then retry.", TIMEOUT: "Increase timeout, wait on fewer threads, or interrupt slow threads.", UNKNOWN: "Retry the operation or inspect extension logs for more detail." };
function getThreadToolErrorDetails(toolResult: AgentToolResult<unknown>): ThreadToolErrorDetails | undefined { return (toolResult.details as ThreadToolErrorResult | undefined)?.error; }
function renderErrorFallback(toolResult: AgentToolResult<unknown>, theme: Theme): Text { const fg = theme.fg.bind(theme); const errorDetails = getThreadToolErrorDetails(toolResult); const message = errorDetails?.message ?? getFallbackText(toolResult); const hint = errorDetails ? THREAD_TOOL_ERROR_HINTS[errorDetails.code] : undefined; const lines = [fg("error", message)]; if (hint) lines.push(fg("muted", hint)); return new Text(lines.join("\n"), 0, 0); }

function statusIcon(status: ThreadToolStatus, fg: Theme["fg"]): string {
	const indicator = resolveStatusFeedIndicator(status);
	return fg(
		indicator === "running" ? "warning" : indicator === "done" ? "success" : "error",
		statusFeedIndicatorGlyph(indicator),
	);
}

function statusLabel(status: ThreadToolStatus): string {
	if (status === "running") return "running";
	if (status === "completed" || status === "closed") return "completed";
	if (status === "aborted") return "aborted";
	return "failed";
}

export function formatSpawnScope(args: SpawnThreadParams): string {
	const parts: string[] = [];
	if (args.fork_turns !== undefined && args.fork_turns !== "none") {
		parts.push(`fork:${args.fork_turns}`);
	}
	if (args.tools?.length) parts.push(`tools:${args.tools.join(",")}`);
	if (args.model) parts.push(`model:${args.model}`);
	if (args.cwd) parts.push(`cwd:${shortPath(args.cwd)}`);
	return parts.length > 0 ? parts.join(" ") : "";
}

function addSection(container: Container, title: string, child: Text | Markdown, fg: Theme["fg"]) {
	container.addChild(new Spacer(1));
	container.addChild(new Text(fg("muted", title), 0, 0));
	container.addChild(child);
}

function formatActivityLines(activities: string[] | undefined, limit?: number): string {
	if (!activities?.length) return "";
	const toShow = limit ? activities.slice(-limit) : activities;
	const skipped = limit ? Math.max(0, activities.length - toShow.length) : 0;
	const lines: string[] = [];
	if (skipped > 0) {
		lines.push(`... ${skipped} earlier activit${skipped === 1 ? "y" : "ies"}`);
	}
	for (const activity of toShow) {
		lines.push(activity);
	}
	return lines.join("\n").trimEnd();
}

function renderThreadBlock(
	thread: WaitThreadItem,
	expanded: boolean,
	fg: Theme["fg"],
	bold: Theme["bold"],
): string {
	const icon = statusIcon(thread.status, fg);
	const header = `${icon} ${fg("toolTitle", bold(thread.thread_name))}`;
	const lines = [header];

	if (expanded && thread.task) {
		lines.push(fg("dim", thread.task));
	}

	const activityText = formatActivityLines(
		thread.activities,
		expanded ? undefined : COLLAPSED_ACTIVITY_COUNT,
	);
	if (activityText) {
		lines.push(fg("toolOutput", activityText));
	} else if (thread.status === "running") {
		lines.push(fg("muted", "(running...)"));
	}

	const usage = fmtThreadUsage(thread.usage);
	if (usage) {
		lines.push(fg("dim", usage));
	}

	return lines.join("\n");
}

export function sortThreadsTree(threads: ThreadSummary[]): ThreadSummary[] {
	const byId = new Map(threads.map((thread) => [thread.thread_id, thread]));
	const children = new Map<string, ThreadSummary[]>();
	const roots: ThreadSummary[] = [];

	for (const thread of threads) {
		const parentId = thread.parent_id;
		if (!parentId || parentId === thread.thread_id || !byId.has(parentId)) {
			roots.push(thread);
			continue;
		}
		const list = children.get(parentId) ?? [];
		list.push(thread);
		children.set(parentId, list);
	}

	const sorted: ThreadSummary[] = [];
	const visited = new Set<string>();
	const visit = (node: ThreadSummary) => {
		if (visited.has(node.thread_id)) return;
		visited.add(node.thread_id);
		sorted.push(node);
		const childList = (children.get(node.thread_id) ?? []).sort((a, b) =>
			a.thread_name.localeCompare(b.thread_name),
		);
		for (const child of childList) visit(child);
	};

	for (const root of roots.sort((a, b) => a.thread_name.localeCompare(b.thread_name))) {
		visit(root);
	}

	for (const thread of threads) {
		if (!visited.has(thread.thread_id)) {
			visit(thread);
		}
	}

	return sorted;
}

export function formatListThreadLine(thread: ThreadSummary, fg: Theme["fg"], bold: Theme["bold"]): string {
	const indent = "  ".repeat(Math.max(0, thread.depth - 1));
	const icon = statusIcon(thread.status, fg);
	const task = taskPreview(thread.task);
	return `${indent}${icon} ${fg("toolTitle", bold(thread.thread_name))} ${fg("dim", task)}`;
}

export function renderSpawnThreadCall(args: SpawnThreadParams, theme: Theme) {
	const fg = theme.fg.bind(theme);
	const agentType =
		typeof args.agent_type === "string" && args.agent_type.trim()
			? ` ${fg("accent", `[${args.agent_type}]`)}`
			: "";
	const scope = formatSpawnScope(args);
	const scopeText = scope ? ` ${fg("muted", `[${scope}]`)}` : "";
	const text = `${fg("toolTitle", theme.bold("spawn_thread"))}${agentType}${scopeText} ${fg("dim", taskPreview(args.task))}`;
	return new Text(text, 0, 0);
}

export function renderSpawnThreadResult(
	toolResult: AgentToolResult<SpawnThreadResult>,
	{ expanded }: { expanded: boolean },
	theme: Theme,
	context: { args: SpawnThreadParams; isError?: boolean },
) {
	if (isToolResultError(toolResult, context)) return renderErrorFallback(toolResult, theme);

	const result = toolResult.details;
	const fg = theme.fg.bind(theme);
	if (!result) return renderErrorFallback(toolResult, theme);

	const task = result.task ?? context.args.task;
	const icon = statusIcon("running", fg);
	const preview = taskPreview(task);

	if (expanded) {
		const container = new Container();
		container.addChild(new Spacer(1));
		container.addChild(
			new Text(`${icon} ${fg("toolTitle", theme.bold("spawned"))} ${fg("accent", result.thread_name)}`, 0, 0),
		);
		addSection(container, "─── Thread ───", new Text(fg("dim", `${result.thread_id}`), 0, 0), fg);
		if (task) {
			addSection(container, "─── Task ───", new Text(fg("dim", task), 0, 0), fg);
		}
		return container;
	}

	const text = `${icon} ${fg("toolTitle", theme.bold(result.thread_name))}\n${fg("dim", result.thread_id)}\n${fg("toolOutput", preview)}`;
	return new Text(text, 0, 0);
}

export function renderWaitThreadCall(args: WaitThreadParams, theme: Theme) {
	const fg = theme.fg.bind(theme);
	const count = args.thread_ids?.length ?? 0;
	const label = count === 1 ? "1 thread" : `${count} threads`;
	const timeout =
		typeof args.timeout === "number" ? ` ${fg("muted", `[timeout:${args.timeout}s]`)}` : "";
	const text = `${fg("toolTitle", theme.bold("wait_thread"))}${timeout} ${fg("dim", label)}`;
	return new Text(text, 0, 0);
}

export function renderWaitThreadResult(
	toolResult: AgentToolResult<WaitThreadResult | { waiting: WaitThreadItem[] }>,
	{ expanded, isPartial }: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context?: { isError?: boolean },
) {
	if (isToolResultError(toolResult, context)) return renderErrorFallback(toolResult, theme);

	const fg = theme.fg.bind(theme);
	const details = toolResult.details;
	if (!details) return renderErrorFallback(toolResult, theme);

	const threads = "threads" in details ? details.threads : details.waiting;
	if (!Array.isArray(threads) || threads.length === 0) {
		return new Text(fg("muted", "(no threads)"), 0, 0);
	}

	const mdTheme = getMarkdownTheme();

	if (expanded) {
		const container = new Container();
		container.addChild(new Spacer(1));
		const overallStatus = isPartial || threads.some((thread) => thread.status === "running")
			? "running"
			: threads.every((thread) => thread.status === "completed" || thread.status === "closed")
				? "completed"
				: "error";
		container.addChild(
			new Text(
				`${statusIcon(overallStatus, fg)} ${fg("toolTitle", theme.bold(statusLabel(overallStatus)))}`,
				0,
				0,
			),
		);

		for (const thread of threads) {
			addSection(
				container,
				`─── ${thread.thread_name} ───`,
				new Text(renderThreadBlock(thread, true, fg, theme.bold.bind(theme)), 0, 0),
				fg,
			);
			if (thread.output) {
				addSection(
					container,
					"─── Output ───",
					new Markdown(thread.output.trim(), 0, 0, mdTheme),
					fg,
				);
			} else if (thread.status !== "running") {
				addSection(container, "─── Output ───", new Text(fg("muted", "(no output)"), 0, 0), fg);
			}
		}

		return container;
	}

	const blocks = threads.map((thread) => renderThreadBlock(thread, false, fg, theme.bold.bind(theme)));
	let text = blocks.join("\n\n");

	const hasOutput = threads.some((thread) => thread.output);
	const stillRunning = isPartial || threads.some((thread) => thread.status === "running");
	if (!expanded && (stillRunning || hasOutput || threads.some((thread) => (thread.activities?.length ?? 0) > COLLAPSED_ACTIVITY_COUNT))) {
		text += `\n${fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`;
	}

	return new Text(text, 0, 0);
}

export function renderListThreadsCall(args: ListThreadsParams, theme: Theme) {
	const fg = theme.fg.bind(theme);
	const filter = args.status ? ` ${fg("muted", `[${args.status}]`)}` : "";
	const text = `${fg("toolTitle", theme.bold("list_threads"))}${filter}`;
	return new Text(text, 0, 0);
}

export function renderListThreadsResult(
	toolResult: AgentToolResult<{ threads: ThreadSummary[] }>,
	{ expanded }: { expanded: boolean },
	theme: Theme,
	context?: { isError?: boolean },
) {
	if (isToolResultError(toolResult, context)) return renderErrorFallback(toolResult, theme);

	const fg = theme.fg.bind(theme);
	const threads = toolResult.details?.threads;
	if (!Array.isArray(threads)) return renderErrorFallback(toolResult, theme);
	if (threads.length === 0) return new Text(fg("muted", "No threads match the requested filter."), 0, 0);

	const tree = sortThreadsTree(threads);
	const lines = tree.map((thread) => formatListThreadLine(thread, fg, theme.bold.bind(theme)));

	if (expanded) {
		const container = new Container();
		container.addChild(new Spacer(1));
		container.addChild(new Text(fg("toolTitle", theme.bold(`${threads.length} thread(s)`)), 0, 0));
		addSection(container, "─── Threads ───", new Text(lines.join("\n"), 0, 0), fg);
		for (const thread of tree) {
			const usage = fmtThreadUsage(thread.usage, thread.model);
			if (!usage) continue;
			addSection(
				container,
				`─── ${thread.thread_name} usage ───`,
				new Text(fg("dim", usage), 0, 0),
				fg,
			);
		}
		return container;
	}

	let text = lines.join("\n");
	if (threads.some((thread) => thread.usage || thread.task.length > MAX_TASK_PREVIEW_CHARS)) {
		text += `\n${fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`;
	}
	return new Text(text, 0, 0);
}

export function renderSendToThreadCall(args: SendToThreadParams, theme: Theme) {
	const fg = theme.fg.bind(theme);
	const text = `${fg("toolTitle", theme.bold("send_to_thread"))} ${fg("accent", args.thread_id)} ${fg("dim", messagePreview(args.message))}`;
	return new Text(text, 0, 0);
}

export function renderSendToThreadResult(
	toolResult: AgentToolResult<SendToThreadResult>,
	_options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context?: { isError?: boolean },
) {
	if (isToolResultError(toolResult, context)) return renderErrorFallback(toolResult, theme);

	const result = toolResult.details;
	const fg = theme.fg.bind(theme);
	if (!result) return renderErrorFallback(toolResult, theme);
	const icon = statusIcon("running", fg);
	const text = `${icon} ${fg("toolTitle", theme.bold("sent"))} ${fg("accent", result.thread_name)} ${fg("dim", `(${result.thread_id})`)}`;
	return new Text(text, 0, 0);
}

export function renderInterruptThreadCall(args: { thread_id: string }, theme: Theme) {
	const fg = theme.fg.bind(theme);
	const text = `${fg("toolTitle", theme.bold("interrupt_thread"))} ${fg("accent", args.thread_id)}`;
	return new Text(text, 0, 0);
}

export function renderInterruptThreadResult(
	toolResult: AgentToolResult<InterruptThreadResult>,
	_options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context?: { isError?: boolean },
) {
	if (isToolResultError(toolResult, context)) return renderErrorFallback(toolResult, theme);

	const result = toolResult.details;
	const fg = theme.fg.bind(theme);
	if (!result) return renderErrorFallback(toolResult, theme);
	const icon = statusIcon("aborted", fg);
	const text = `${icon} ${fg("toolTitle", theme.bold("interrupted"))} ${fg("accent", result.thread_name)} ${fg("dim", `(${result.thread_id})`)}`;
	return new Text(text, 0, 0);
}

export function renderCloseThreadCall(args: { thread_id: string }, theme: Theme) {
	const fg = theme.fg.bind(theme);
	const text = `${fg("toolTitle", theme.bold("close_thread"))} ${fg("accent", args.thread_id)}`;
	return new Text(text, 0, 0);
}

export function renderCloseThreadResult(
	toolResult: AgentToolResult<CloseThreadResult>,
	_options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
	context?: { isError?: boolean },
) {
	if (isToolResultError(toolResult, context)) return renderErrorFallback(toolResult, theme);

	const result = toolResult.details;
	const fg = theme.fg.bind(theme);
	if (!result) return renderErrorFallback(toolResult, theme);
	const icon = statusIcon("closed", fg);
	const text = `${icon} ${fg("toolTitle", theme.bold("closed"))} ${fg("accent", result.thread_name)} ${fg("dim", `(${result.thread_id})`)}`;
	return new Text(text, 0, 0);
}