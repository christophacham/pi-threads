import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	createThreadClosedActivity,
	createThreadInterruptedActivity,
	createThreadSendActivity,
	createThreadSpawnedActivity,
	createThreadWaitActivity,
	formatClosedTranscriptContent,
	formatInterruptedTranscriptContent,
	formatSendTranscriptContent,
	formatSpawnedTranscriptContent,
	formatWaitTranscriptContent,
} from "./persistence.ts";
import { getTranscriptContent, registerThreadRenderers } from "./renderers.ts";
import { THREAD_TRANSCRIPT_TYPES } from "./types.ts";

function createTheme(): Theme {
	const fg = (color: string, text: string) => `[${color}]${text}[/]`;
	return {
		fg,
		bg: (_color: string, text: string) => text,
	} as unknown as Theme;
}

describe("registerThreadRenderers", () => {
	const transcriptTypes = [
		THREAD_TRANSCRIPT_TYPES.SPAWNED,
		THREAD_TRANSCRIPT_TYPES.SEND,
		THREAD_TRANSCRIPT_TYPES.WAIT,
		THREAD_TRANSCRIPT_TYPES.INTERRUPTED,
		THREAD_TRANSCRIPT_TYPES.CLOSED,
	];

	it("registers all five transcript message renderers", () => {
		const registered = new Map<string, (message: { content: string; details?: unknown }, _options: unknown, theme: Theme) => unknown>();
		const pi = {
			registerMessageRenderer: vi.fn((customType: string, renderer: (message: { content: string; details?: unknown }, _options: unknown, theme: Theme) => unknown) => {
				registered.set(customType, renderer);
			}),
		} as unknown as ExtensionAPI;

		registerThreadRenderers(pi);

		expect(pi.registerMessageRenderer).toHaveBeenCalledTimes(5);
		for (const customType of transcriptTypes) {
			expect(registered.has(customType)).toBe(true);
		}
	});

	it("renders Codex-style bullets with theme colors", () => {
		const registered = new Map<
			string,
			(message: { content: string; details?: unknown }, _options: unknown, theme: Theme) => unknown
		>();
		const pi = {
			registerMessageRenderer: vi.fn(
				(
					customType: string,
					renderer: (message: { content: string; details?: unknown }, _options: unknown, theme: Theme) => unknown,
				) => {
					registered.set(customType, renderer);
				},
			),
		} as unknown as ExtensionAPI;
		registerThreadRenderers(pi);

		function renderWithColors(
			customType: string,
			details: unknown,
		): { colors: string[]; text: string } {
			const colors: string[] = [];
			const theme = {
				fg: (color: string, text: string) => {
					colors.push(color);
					return `[${color}]${text}[/]`;
				},
				bg: (_color: string, text: string) => text,
			} as unknown as Theme;
			registered.get(customType)!({ content: "", details }, {}, theme);
			return { colors, text: formatSpawnedTranscriptContent(details as never) };
		}

		const spawned = createThreadSpawnedActivity({
			thread_id: "t1",
			thread_name: "worker",
			agent_type: "researcher",
			task: "scan the repo",
		});
		expect(renderWithColors(THREAD_TRANSCRIPT_TYPES.SPAWNED, spawned).colors).toContain("success");

		const send = createThreadSendActivity({
			thread_id: "t1",
			thread_name: "worker",
			message_preview: "continue",
		});
		const sendColors: string[] = [];
		const theme = createTheme();
		registered.get(THREAD_TRANSCRIPT_TYPES.SEND)!({ content: "", details: send }, {}, {
			...theme,
			fg: (color, text) => {
				sendColors.push(color);
				return theme.fg(color, text);
			},
		} as Theme);
		expect(sendColors).toContain("accent");
		expect(formatSendTranscriptContent(send)).toBe("Sent input to worker: continue");

		const waitStarted = createThreadWaitActivity({
			thread_id: "t1",
			thread_name: "worker",
			phase: "started",
			status: "Running",
		});
		const waitStartedColors: string[] = [];
		registered.get(THREAD_TRANSCRIPT_TYPES.WAIT)!({ content: "", details: waitStarted }, {}, {
			fg: (color: string, text: string) => {
				waitStartedColors.push(color);
				return text;
			},
			bg: (_color: string, text: string) => text,
		} as unknown as Theme);
		expect(waitStartedColors).toContain("warning");
		expect(formatWaitTranscriptContent(waitStarted)).toBe("Waiting for worker: Running");

		const waitFinished = createThreadWaitActivity({
			thread_id: "t1",
			thread_name: "worker",
			phase: "finished",
			status: "completed",
		});
		const waitFinishedColors: string[] = [];
		registered.get(THREAD_TRANSCRIPT_TYPES.WAIT)!({ content: "", details: waitFinished }, {}, {
			fg: (color: string, text: string) => {
				waitFinishedColors.push(color);
				return text;
			},
			bg: (_color: string, text: string) => text,
		} as unknown as Theme);
		expect(waitFinishedColors).toContain("success");
		expect(formatWaitTranscriptContent(waitFinished)).toBe("Finished waiting → worker: completed");

		const interrupted = createThreadInterruptedActivity({
			thread_id: "t1",
			thread_name: "worker",
		});
		const interruptedColors: string[] = [];
		registered.get(THREAD_TRANSCRIPT_TYPES.INTERRUPTED)!({ content: "", details: interrupted }, {}, {
			fg: (color: string, text: string) => {
				interruptedColors.push(color);
				return text;
			},
			bg: (_color: string, text: string) => text,
		} as unknown as Theme);
		expect(interruptedColors).toContain("error");
		expect(formatInterruptedTranscriptContent(interrupted)).toBe("Interrupted worker");

		const closed = createThreadClosedActivity({
			thread_id: "t1",
			thread_name: "worker",
		});
		const closedColors: string[] = [];
		registered.get(THREAD_TRANSCRIPT_TYPES.CLOSED)!({ content: "", details: closed }, {}, {
			fg: (color: string, text: string) => {
				closedColors.push(color);
				return text;
			},
			bg: (_color: string, text: string) => text,
		} as unknown as Theme);
		expect(closedColors).toContain("muted");
		expect(formatClosedTranscriptContent(closed)).toBe("Closed worker");
	});
});

describe("getTranscriptContent", () => {
	it("formats all transcript event types", () => {
		expect(
			getTranscriptContent(
				createThreadSpawnedActivity({
					thread_id: "t1",
					thread_name: "worker",
					agent_type: "worker",
					task: "do work",
				}),
			),
		).toBe("Spawned worker [worker]: do work");

		expect(
			getTranscriptContent(
				createThreadSendActivity({
					thread_id: "t1",
					thread_name: "worker",
					message_preview: "hello",
				}),
			),
		).toBe("Sent input to worker: hello");

		expect(
			getTranscriptContent(
				createThreadWaitActivity({
					thread_id: "t1",
					thread_name: "worker",
					phase: "started",
					status: "Running",
				}),
			),
		).toBe("Waiting for worker: Running");

		expect(
			getTranscriptContent(
				createThreadInterruptedActivity({
					thread_id: "t1",
					thread_name: "worker",
				}),
			),
		).toBe("Interrupted worker");

		expect(
			getTranscriptContent(
				createThreadClosedActivity({
					thread_id: "t1",
					thread_name: "worker",
				}),
			),
		).toBe("Closed worker");
	});
});