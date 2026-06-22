function pruneSeenMap(seen: Map<string, number>, now: number, ttlMs: number): void {
	for (const [key, ts] of seen.entries()) {
		if (now - ts > ttlMs) seen.delete(key);
	}
}

/** Returns true when the key was already seen within the TTL window. */
export function markSeenWithTtl(seen: Map<string, number>, key: string, now: number, ttlMs: number): boolean {
	pruneSeenMap(seen, now, ttlMs);
	if (seen.has(key)) return true;
	seen.set(key, now);
	return false;
}

export function getGlobalSeenMap(storeKey: string): Map<string, number> {
	const globalStore = globalThis as Record<string, unknown>;
	const existing = globalStore[storeKey];
	if (existing instanceof Map) return existing as Map<string, number>;
	const map = new Map<string, number>();
	globalStore[storeKey] = map;
	return map;
}

export function buildThreadCompletionKey(threadId: string): string {
	return `thread:${threadId}`;
}