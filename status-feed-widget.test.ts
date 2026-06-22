import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STATUS_FEED_WIDGET_ID } from "./status-feed.ts";
import {
	createStatusFeedWidgetController,
	widgetRenderKey,
} from "./status-feed-widget.ts";
import type { StatusFeedEntry } from "./thread-manager.ts";

function createTheme(): Theme {
	const fg = (color: string, text: string) => `[${color}]${text}[/]`;
	return {
		fg,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => `**${text}**`,
	} as unknown as Theme;
}

function renderWidgetFactory(
	factory: ((_tui: unknown, theme: Theme) => Component) | undefined,
	width = 120,
): string {
	if (!factory) return "";
	const component = factory(undefined, createTheme());
	return component.render(width).join("\n");
}

function createUiContext(options?: { toolsExpanded?: boolean }): {
	ctx: ExtensionContext;
	setWidget: ReturnType<typeof vi.fn>;
	requestRender: ReturnType<typeof vi.fn>;
} {
	const setWidget = vi.fn();
	const requestRender = vi.fn();
	const ctx = {
		hasUI: true,
		ui: {
			setWidget,
			requestRender,
			getToolsExpanded: options?.toolsExpanded === undefined ? undefined : () => options.toolsExpanded,
		},
	} as unknown as ExtensionContext;
	return { ctx, setWidget, requestRender };
}

const runningFeed: StatusFeedEntry[] = [
	{
		thread_id: "t1",
		thread_name: "worker",
		status: "running",
		lines: ["read src/index.ts"],
	},
];

describe("status-feed-widget", () => {
	let intervalCount = 0;

	beforeEach(() => {
		const originalSetInterval = globalThis.setInterval.bind(globalThis);
		const originalClearInterval = globalThis.clearInterval.bind(globalThis);

		vi.spyOn(globalThis, "setInterval").mockImplementation((handler, timeout, ...args) => {
			intervalCount++;
			return originalSetInterval(handler, timeout, ...args);
		});
		vi.spyOn(globalThis, "clearInterval").mockImplementation((id) => {
			intervalCount--;
			originalClearInterval(id);
		});
	});

	afterEach(() => {
		vi.mocked(globalThis.setInterval).mockRestore();
		vi.mocked(globalThis.clearInterval).mockRestore();
		intervalCount = 0;
		vi.clearAllMocks();
	});

	it("widgetRenderKey changes when feed activity changes", () => {
		const first = widgetRenderKey(runningFeed);
		const second = widgetRenderKey([
			{
				...runningFeed[0]!,
				lines: ["$ git status"],
			},
		]);
		expect(first).not.toEqual(second);
	});

	it("refresh is a no-op when widget state is unchanged", () => {
		const getFeed = vi.fn(() => runningFeed);
		const controller = createStatusFeedWidgetController({ getFeed });
		const { ctx, setWidget, requestRender } = createUiContext();

		expect(controller.refresh(ctx)).toBe(true);
		expect(setWidget).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);

		setWidget.mockClear();
		requestRender.mockClear();

		expect(controller.refresh(ctx)).toBe(false);
		expect(setWidget).not.toHaveBeenCalled();
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("bindContext shows widget when threads are running and starts poll", () => {
		const getFeed = vi.fn(() => runningFeed);
		const controller = createStatusFeedWidgetController({ getFeed });
		const { ctx, setWidget } = createUiContext();

		controller.bindContext(ctx);

		expect(setWidget).toHaveBeenCalledWith(
			STATUS_FEED_WIDGET_ID,
			expect.any(Function),
			{ placement: "belowEditor" },
		);

		const rendered = renderWidgetFactory(setWidget.mock.calls[0]?.[1]);
		expect(rendered).toContain("Sub-agents running");
		expect(rendered).toContain("worker");
		expect(intervalCount).toBe(1);
	});

	it("passes tools-expanded state into the widget component factory", () => {
		const getFeed = vi.fn(() => runningFeed);
		const controller = createStatusFeedWidgetController({ getFeed });
		const { ctx, setWidget } = createUiContext({ toolsExpanded: true });

		controller.bindContext(ctx);

		const rendered = renderWidgetFactory(setWidget.mock.calls[0]?.[1]);
		expect(rendered).toContain("Sub-agents running");
		expect(rendered).toContain("worker");
	});

	it("poll no-op does not redraw when feed is unchanged", async () => {
		vi.useFakeTimers();
		try {
			const getFeed = vi.fn(() => runningFeed);
			const controller = createStatusFeedWidgetController({
				getFeed,
				pollIntervalMs: 100,
			});
			const { ctx, setWidget, requestRender } = createUiContext();

			controller.bindContext(ctx);
			setWidget.mockClear();
			requestRender.mockClear();

			await vi.advanceTimersByTimeAsync(250);

			expect(setWidget).not.toHaveBeenCalled();
			expect(requestRender).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("clears widget and stops poll when no threads remain", async () => {
		vi.useFakeTimers();
		try {
			let feed = runningFeed;
			const getFeed = vi.fn(() => feed);
			const controller = createStatusFeedWidgetController({
				getFeed,
				pollIntervalMs: 100,
			});
			const { ctx, setWidget } = createUiContext();

			controller.bindContext(ctx);
			setWidget.mockClear();

			feed = [];
			await vi.advanceTimersByTimeAsync(100);

			expect(setWidget).toHaveBeenCalledWith(STATUS_FEED_WIDGET_ID, undefined);
		} finally {
			vi.useRealTimers();
		}
	});

	it("reset clears widget and stops polling", () => {
		const getFeed = vi.fn(() => runningFeed);
		const controller = createStatusFeedWidgetController({ getFeed });
		const { ctx, setWidget } = createUiContext();

		controller.bindContext(ctx);
		controller.reset();

		expect(setWidget).toHaveBeenLastCalledWith(STATUS_FEED_WIDGET_ID, undefined);
		expect(intervalCount).toBe(0);
	});

	it("reset clears lastUiContext so refresh is a no-op until bindContext", () => {
		const getFeed = vi.fn(() => runningFeed);
		const controller = createStatusFeedWidgetController({ getFeed });
		const { ctx, setWidget } = createUiContext();

		controller.bindContext(ctx);
		controller.reset();
		setWidget.mockClear();

		expect(controller.refresh()).toBe(false);
		expect(setWidget).not.toHaveBeenCalled();
	});

	it("bindContext renders on new context after session_shutdown even when feed key is unchanged", () => {
		const getFeed = vi.fn(() => runningFeed);
		const controller = createStatusFeedWidgetController({ getFeed });
		const first = createUiContext();
		const second = createUiContext();

		controller.bindContext(first.ctx);
		controller.reset();

		// Simulate status feed listener firing before bindContext on session_start.
		controller.refresh();
		first.setWidget.mockClear();

		controller.bindContext(second.ctx);

		expect(second.setWidget).toHaveBeenCalledWith(
			STATUS_FEED_WIDGET_ID,
			expect.any(Function),
			{ placement: "belowEditor" },
		);

		const rendered = renderWidgetFactory(second.setWidget.mock.calls[0]?.[1]);
		expect(rendered).toContain("Sub-agents running");
		expect(rendered).toContain("worker");
		expect(first.setWidget).not.toHaveBeenCalled();
	});
});