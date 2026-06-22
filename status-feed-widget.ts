import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	clearStatusFeedWidget,
	statusFeedHasRunningThreads,
	STATUS_FEED_WIDGET_ID,
	updateStatusFeedWidget,
} from "./status-feed.ts";
import type { StatusFeedEntry } from "./thread-manager.ts";
import { WAIT_POLL_INTERVAL_MS } from "./thread-subprocess.ts";

export interface StatusFeedWidgetController {
	bindContext(ctx: ExtensionContext): void;
	refresh(ctx?: ExtensionContext): boolean;
	reset(): void;
	stopPoller(): void;
	ensurePoller(): void;
}

export interface StatusFeedWidgetControllerOptions {
	getFeed: () => StatusFeedEntry[];
	pollIntervalMs?: number;
}

/** Stable serialization key for comparing status feed widget state. */
export function widgetRenderKey(feed: StatusFeedEntry[]): string {
	return JSON.stringify(
		feed.map((entry) => ({
			thread_id: entry.thread_id,
			thread_name: entry.thread_name,
			status: entry.status,
			lines: entry.lines,
		})),
	);
}

export function createStatusFeedWidgetController(
	options: StatusFeedWidgetControllerOptions,
): StatusFeedWidgetController {
	const getFeed = options.getFeed;
	const pollIntervalMs = options.pollIntervalMs ?? WAIT_POLL_INTERVAL_MS;

	let lastUiContext: ExtensionContext | null = null;
	let lastWidgetRenderKey: string | null = null;
	let poller: NodeJS.Timeout | null = null;

	const stopPoller = (): void => {
		if (!poller) return;
		clearInterval(poller);
		poller = null;
	};

	const renderIfChanged = (ctx: ExtensionContext, feed: StatusFeedEntry[]): boolean => {
		if (!ctx.hasUI) return false;

		const key = widgetRenderKey(feed);
		if (key === lastWidgetRenderKey) return false;

		lastWidgetRenderKey = key;
		if (!statusFeedHasRunningThreads(feed)) {
			clearStatusFeedWidget(ctx);
		} else {
			updateStatusFeedWidget(ctx, feed);
		}
		(ctx.ui as { requestRender?: () => void }).requestRender?.();
		return true;
	};

	const refresh = (ctx?: ExtensionContext): boolean => {
		const target = ctx ?? lastUiContext;
		if (!target) return false;
		return renderIfChanged(target, getFeed());
	};

	const ensurePoller = (): void => {
		if (poller) return;

		poller = setInterval(() => {
			const feed = getFeed();
			if (feed.length === 0) {
				if (lastUiContext) renderIfChanged(lastUiContext, feed);
				stopPoller();
				return;
			}
			if (lastUiContext) renderIfChanged(lastUiContext, feed);
		}, pollIntervalMs);
		poller.unref?.();
	};

	const bindContext = (ctx: ExtensionContext): void => {
		if (ctx !== lastUiContext) {
			lastWidgetRenderKey = null;
		}
		lastUiContext = ctx;
		refresh(ctx);
		if (getFeed().length > 0) ensurePoller();
	};

	const reset = (): void => {
		stopPoller();
		lastWidgetRenderKey = null;
		if (lastUiContext?.hasUI) {
			clearStatusFeedWidget(lastUiContext);
			(lastUiContext.ui as { requestRender?: () => void }).requestRender?.();
		}
		lastUiContext = null;
	};

	return {
		bindContext,
		refresh,
		reset,
		stopPoller,
		ensurePoller,
	};
}

export { STATUS_FEED_WIDGET_ID };