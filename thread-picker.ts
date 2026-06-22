import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	findAllThreadSpawned,
	findFirstThreadMeta,
	listThreadSessions,
	type ThreadSessionInfo,
} from "./persistence.ts";
import { resolveStatusFeedIndicator, statusFeedIndicatorGlyph } from "./status-feed.ts";
import type { ThreadRuntimeStatus } from "./contracts.ts";
import type { ThreadManager } from "./thread-manager.ts";
import type { ThreadCompletedStatus } from "./types.ts";

export const THREAD_PICKER_STATUS_ID = "pi-threads-picker";

const TASK_PREVIEW_MAX_LENGTH = 45;

function truncateTaskPreview(task: string, maxLength = TASK_PREVIEW_MAX_LENGTH): string {
	const trimmed = task.trim();
	if (trimmed.length <= maxLength) return trimmed;
	return `${trimmed.slice(0, maxLength - 3)}...`;
}

export interface ThreadNavigationEntry {
	path: string;
	thread_id: string | null;
	thread_name: string;
	agent_type?: string;
	task?: string;
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

	async refresh(
		ctx: ExtensionContext,
		manager: ThreadManager,
		threadSessions?: ThreadSessionInfo[],
	): Promise<ThreadNavigationEntry[]> {
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

		const sessions = threadSessions ?? (await listThreadSessions(ctx.cwd));
		const parentSessionManager = SessionManager.open(parentPath);
		const spawnedOrder = findAllThreadSpawned(parentSessionManager.getEntries());
		const sessionById = new Map(sessions.map((session) => [session.meta.thread_id, session]));

		const orderedThreadIds: string[] = [];
		for (const spawned of spawnedOrder) {
			if (!orderedThreadIds.includes(spawned.thread_id)) {
				orderedThreadIds.push(spawned.thread_id);
			}
		}
		for (const session of sessions) {
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
				task: session.meta.task,
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
		let label = `${indicator} ${entry.thread_name}`;
		if (entry.agent_type) {
			label += ` [${entry.agent_type}]`;
		}
		if (entry.task) {
			label += ` — ${truncateTaskPreview(entry.task)}`;
		}
		return label;
	}

	private lastCommandCtx?: ExtensionCommandContext;

	async switchToEntry(ctx: ExtensionContext, entry: ThreadNavigationEntry): Promise<boolean> {
		let commandCtx: ExtensionCommandContext | undefined;
		if ("switchSession" in ctx && typeof (ctx as any).switchSession === "function") {
			commandCtx = ctx as ExtensionCommandContext;
			this.lastCommandCtx = commandCtx;
		} else if (this.lastCommandCtx && typeof this.lastCommandCtx.switchSession === "function") {
			commandCtx = this.lastCommandCtx;
		}

		if (!commandCtx) {
			ctx.ui.notify(
				"Session switching is not supported by this shortcut/context. Please run /threads command once to initialize session navigation shortcuts.",
				"error",
			);
			return false;
		}

		try {
			const result = await commandCtx.switchSession(entry.path, {
				withSession: async (replacementCtx) => {
					const index = this.entries.findIndex((item) => item.path === entry.path);
					if (index >= 0) this.currentIndex = index;
					this.updateStatusBar(replacementCtx);
				},
			});
			if (result.cancelled) {
				ctx.ui.notify("Session switch cancelled", "warning");
				return false;
			}
			return true;
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(`Failed to switch session: ${errMsg}`, "error");
			return false;
		}
	}

	async cycle(ctx: ExtensionContext, direction: -1 | 1, manager: ThreadManager): Promise<void> {
		if ("switchSession" in ctx && typeof (ctx as any).switchSession === "function") {
			this.lastCommandCtx = ctx as ExtensionCommandContext;
		}
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
		this.lastCommandCtx = ctx;
		const entries = await this.refresh(ctx, manager);
		const currentPath = ctx.sessionManager.getSessionFile();
		const selectableEntries = entries.filter((entry) => entry.path !== currentPath);
		if (selectableEntries.length === 0) {
			ctx.ui.notify("No other thread sessions found", "info");
			return;
		}

		const labels = selectableEntries.map((entry) => this.formatEntryLabel(entry));
		const choice = await ctx.ui.select("Thread sessions:", labels);
		if (!choice) return;

		const selectedIndex = labels.indexOf(choice);
		const selected = selectedIndex >= 0 ? selectableEntries[selectedIndex] : undefined;
		if (!selected) return;
		await this.switchToEntry(ctx, selected);
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
		description: "Previous thread session (default: alt+,)",
		handler: async (_args, ctx) => {
			await navigator.cycle(ctx, -1, manager);
		},
	});

	pi.registerCommand("threads-next", {
		description: "Next thread session (default: alt+.)",
		handler: async (_args, ctx) => {
			await navigator.cycle(ctx, 1, manager);
		},
	});

	// alt+left/alt+right collide with pi tree navigation (app.tree.foldOrUp / unfoldOrDown).
	const cycleShortcut = (direction: -1 | 1) => async (ctx: ExtensionContext) => {
		await navigator.cycle(ctx, direction, manager);
	};

	pi.registerShortcut("alt+,", {
		description: "Previous thread session",
		handler: cycleShortcut(-1),
	});

	pi.registerShortcut("alt+.", {
		description: "Next thread session",
		handler: cycleShortcut(1),
	});

	return navigator;
}