import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { findAllThreadSpawned, findFirstThreadMeta, listThreadSessions } from "./persistence.ts";
import { resolveStatusFeedIndicator, statusFeedIndicatorGlyph } from "./status-feed.ts";
import type { ThreadManager, ThreadRuntimeStatus } from "./thread-manager.ts";
import type { ThreadCompletedStatus } from "./types.ts";

export const THREAD_PICKER_STATUS_ID = "pi-threads-picker";

export interface ThreadNavigationEntry {
	path: string;
	thread_id: string | null;
	thread_name: string;
	agent_type?: string;
	status: "main" | ThreadRuntimeStatus | ThreadCompletedStatus;
}

export class ThreadNavigator {
	private entries: ThreadNavigationEntry[] = [];
	private currentIndex = 0;

	getEntries(): readonly ThreadNavigationEntry[] {
		return this.entries;
	}

	getCurrentIndex(): number {
		return this.currentIndex;
	}

	getCurrentEntry(): ThreadNavigationEntry | undefined {
		return this.entries[this.currentIndex];
	}

	async refresh(ctx: ExtensionContext, manager: ThreadManager): Promise<ThreadNavigationEntry[]> {
		const currentPath = ctx.sessionManager.getSessionFile();
		if (!currentPath) {
			this.entries = [];
			this.currentIndex = 0;
			return this.entries;
		}

		const currentMeta = findFirstThreadMeta(ctx.sessionManager.getEntries());
		let parentPath = currentPath;
		if (currentMeta) {
			const sessions = await SessionManager.list(ctx.cwd);
			const parentSession = sessions.find((session) => {
				const manager = SessionManager.open(session.path);
				return manager.getSessionId() === currentMeta.parent_id;
			});
			if (parentSession) parentPath = parentSession.path;
		}

		const threadSessions = await listThreadSessions(ctx.cwd);
		const parentSessionManager = SessionManager.open(parentPath);
		const spawnedOrder = findAllThreadSpawned(parentSessionManager.getEntries());
		const sessionById = new Map(threadSessions.map((session) => [session.meta.thread_id, session]));

		const orderedThreadIds: string[] = [];
		for (const spawned of spawnedOrder) {
			if (!orderedThreadIds.includes(spawned.thread_id)) {
				orderedThreadIds.push(spawned.thread_id);
			}
		}
		for (const session of threadSessions) {
			if (!orderedThreadIds.includes(session.meta.thread_id)) {
				orderedThreadIds.push(session.meta.thread_id);
			}
		}

		const previousPath = this.entries[this.currentIndex]?.path;
		this.entries = [
			{
				path: parentPath,
				thread_id: null,
				thread_name: "Main",
				status: "main",
			},
		];

		for (const threadId of orderedThreadIds) {
			const session = sessionById.get(threadId);
			if (!session) continue;

			const active = manager.getActiveThreads().get(threadId);
			const completionStatus = session.completion?.status;
			const status = active?.status ?? completionStatus ?? "running";

			this.entries.push({
				path: session.path,
				thread_id: session.meta.thread_id,
				thread_name: session.meta.thread_name,
				agent_type: session.meta.agent_type,
				status,
			});
		}

		if (previousPath) {
			const restoredIndex = this.entries.findIndex((entry) => entry.path === previousPath);
			this.currentIndex = restoredIndex >= 0 ? restoredIndex : 0;
		} else {
			const activeIndex = this.entries.findIndex((entry) => entry.path === currentPath);
			this.currentIndex = activeIndex >= 0 ? activeIndex : 0;
		}

		return this.entries;
	}

	formatStatusText(entry: ThreadNavigationEntry | undefined): string | undefined {
		if (!entry) return undefined;
		if (entry.status === "main") return "Main";
		const agentLabel = entry.agent_type ? ` [${entry.agent_type}]` : "";
		return `${entry.thread_name}${agentLabel}`;
	}

	updateStatusBar(ctx: ExtensionContext): void {
		const text = this.formatStatusText(this.getCurrentEntry());
		ctx.ui.setStatus(THREAD_PICKER_STATUS_ID, text);
	}

	clearStatusBar(ctx: ExtensionContext): void {
		ctx.ui.setStatus(THREAD_PICKER_STATUS_ID, undefined);
	}

	formatEntryLabel(entry: ThreadNavigationEntry): string {
		if (entry.status === "main") return "⏳ Main";
		const indicator = statusFeedIndicatorGlyph(resolveStatusFeedIndicator(entry.status));
		return `${indicator} ${entry.thread_name}`;
	}

	async switchToEntry(ctx: ExtensionCommandContext, entry: ThreadNavigationEntry): Promise<boolean> {
		const result = await ctx.switchSession(entry.path, {
			withSession: async (replacementCtx) => {
				const index = this.entries.findIndex((item) => item.path === entry.path);
				if (index >= 0) this.currentIndex = index;
				this.updateStatusBar(replacementCtx);
			},
		});
		return !result.cancelled;
	}

	async cycle(ctx: ExtensionCommandContext, direction: -1 | 1, manager: ThreadManager): Promise<void> {
		if (this.entries.length === 0) {
			await this.refresh(ctx, manager);
		}
		if (this.entries.length <= 1) return;

		this.currentIndex = (this.currentIndex + direction + this.entries.length) % this.entries.length;
		const entry = this.entries[this.currentIndex];
		if (!entry) return;
		await this.switchToEntry(ctx, entry);
	}

	async showPicker(ctx: ExtensionCommandContext, manager: ThreadManager): Promise<void> {
		const entries = await this.refresh(ctx, manager);
		const threadEntries = entries.filter((entry) => entry.status !== "main");
		if (threadEntries.length === 0) {
			ctx.ui.notify("No thread sessions found", "info");
			return;
		}

		const labels = threadEntries.map((entry) => this.formatEntryLabel(entry));
		const choice = await ctx.ui.select("Thread sessions:", labels);
		if (!choice) return;

		const selectedIndex = labels.indexOf(choice);
		const selected = selectedIndex >= 0 ? threadEntries[selectedIndex] : undefined;
		if (!selected) return;
		await this.switchToEntry(ctx, selected);
	}
}

function sendThreadPickerShortcut(pi: ExtensionAPI, ctx: ExtensionContext, command: string): void {
	if (ctx.isIdle()) {
		pi.sendUserMessage(command);
	} else {
		pi.sendUserMessage(command, { deliverAs: "followUp" });
	}
}

export function registerThreadPicker(pi: ExtensionAPI, manager: ThreadManager): ThreadNavigator {
	const navigator = new ThreadNavigator();

	pi.registerCommand("threads", {
		description: "Switch between main and subagent thread sessions",
		handler: async (_args, ctx) => {
			await navigator.showPicker(ctx, manager);
		},
	});

	pi.registerCommand("threads-prev", {
		description: "Previous thread session",
		handler: async (_args, ctx) => {
			await navigator.cycle(ctx, -1, manager);
		},
	});

	pi.registerCommand("threads-next", {
		description: "Next thread session",
		handler: async (_args, ctx) => {
			await navigator.cycle(ctx, 1, manager);
		},
	});

	pi.registerShortcut("alt+left", {
		description: "Previous thread session",
		handler: (ctx) => {
			sendThreadPickerShortcut(pi, ctx, "/threads-prev");
		},
	});

	pi.registerShortcut("alt+right", {
		description: "Next thread session",
		handler: (ctx) => {
			sendThreadPickerShortcut(pi, ctx, "/threads-next");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await navigator.refresh(ctx, manager);
		navigator.updateStatusBar(ctx);
	});

	pi.on("session_shutdown", () => {
		// Status is cleared automatically when the runtime shuts down.
	});

	return navigator;
}