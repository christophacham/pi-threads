import type { Message } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ForkTurns } from "./contracts.ts";

export interface SessionBranchSource {
	getBranch(): SessionEntry[];
}

/** Snapshot the active parent branch (pi-fork buildForkSessionSnapshotJsonl entries). */
export function getParentBranchEntries(sessionManager: SessionBranchSource): SessionEntry[] {
	return sessionManager.getBranch();
}

export function normalizeForkTurns(forkTurns?: ForkTurns): ForkTurns {
	if (forkTurns === undefined || forkTurns === "none") {
		return "none";
	}
	if (forkTurns === "all") {
		return "all";
	}
	if (typeof forkTurns === "number" && Number.isFinite(forkTurns) && forkTurns > 0) {
		return Math.floor(forkTurns);
	}
	return "none";
}

function isTurnStartEntry(entry: SessionEntry): boolean {
	if (entry.type === "branch_summary" || entry.type === "custom_message") {
		return true;
	}
	if (entry.type === "message") {
		const role = entry.message.role;
		return role === "user" || role === "bashExecution";
	}
	return false;
}

function findTurnStartIndices(branch: SessionEntry[]): number[] {
	const starts: number[] = [];
	for (let i = 0; i < branch.length; i++) {
		if (isTurnStartEntry(branch[i])) {
			starts.push(i);
		}
	}
	return starts;
}

/** Select branch entries to copy based on fork_turns. */
export function selectEntriesForFork(branch: SessionEntry[], forkTurns: ForkTurns): SessionEntry[] {
	if (forkTurns === "none" || branch.length === 0) {
		return [];
	}

	if (forkTurns === "all") {
		return [...branch];
	}

	const turnStarts = findTurnStartIndices(branch);
	if (turnStarts.length === 0) {
		return [];
	}

	const count = Math.min(forkTurns, turnStarts.length);
	const firstTurnIndex = turnStarts[turnStarts.length - count] ?? 0;
	return branch.slice(firstTurnIndex);
}

export function childSessionHasAssistant(session: SessionManager): boolean {
	return session
		.getEntries()
		.some((entry) => entry.type === "message" && entry.message.role === "assistant");
}

/** Replay a single branch entry onto the child session leaf chain. */
export function replayEntryOntoSession(session: SessionManager, entry: SessionEntry): void {
	switch (entry.type) {
		case "message":
			session.appendMessage(entry.message as Message);
			return;
		case "thinking_level_change":
			session.appendThinkingLevelChange(entry.thinkingLevel);
			return;
		case "model_change":
			session.appendModelChange(entry.provider, entry.modelId);
			return;
		case "compaction":
			session.appendCompaction(
				entry.summary,
				entry.firstKeptEntryId,
				entry.tokensBefore,
				entry.details,
				entry.fromHook,
			);
			return;
		case "custom":
			session.appendCustomEntry(entry.customType, entry.data);
			return;
		case "custom_message":
			session.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
			return;
		case "session_info":
			if (entry.name !== undefined) {
				session.appendSessionInfo(entry.name);
			}
			return;
		case "branch_summary": {
			const leafId = session.getLeafId();
			if (!leafId) return;
			session.branchWithSummary(leafId, entry.summary, entry.details, entry.fromHook);
			return;
		}
		case "label":
			// Labels reference source entry ids and are not part of LLM context.
			return;
	}
}

/** Copy selected parent branch entries into a child session before its initial prompt. */
export function applyForkedContext(childSession: SessionManager, entries: SessionEntry[]): void {
	for (const entry of entries) {
		replayEntryOntoSession(childSession, entry);
	}
}

export function forkParentContextIntoChild(
	parentSession: SessionBranchSource,
	childSession: SessionManager,
	forkTurns?: ForkTurns,
): SessionEntry[] {
	const normalized = normalizeForkTurns(forkTurns);
	if (normalized === "none") {
		return [];
	}

	const branch = getParentBranchEntries(parentSession);
	const selected = selectEntriesForFork(branch, normalized);
	if (selected.length > 0) {
		applyForkedContext(childSession, selected);
	}
	return selected;
}