import { describe, expect, it } from "vitest";
import {
	buildThreadCompletionKey,
	getGlobalSeenMap,
	markSeenWithTtl,
} from "./completion-dedupe.ts";

describe("markSeenWithTtl", () => {
	const ttlMs = 1000;

	it("returns false on first sight and true on repeat within TTL", () => {
		const seen = new Map<string, number>();
		expect(markSeenWithTtl(seen, "thread-1", 100, ttlMs)).toBe(false);
		expect(markSeenWithTtl(seen, "thread-1", 200, ttlMs)).toBe(true);
	});

	it("allows the same key again after TTL expires", () => {
		const seen = new Map<string, number>();
		expect(markSeenWithTtl(seen, "thread-1", 100, ttlMs)).toBe(false);
		expect(markSeenWithTtl(seen, "thread-1", 1201, ttlMs)).toBe(false);
	});
});

describe("getGlobalSeenMap", () => {
	it("returns the same map for a store key", () => {
		const a = getGlobalSeenMap("__pi_threads_completion_seen_test__");
		a.set("probe", 1);
		const b = getGlobalSeenMap("__pi_threads_completion_seen_test__");
		expect(b.get("probe")).toBe(1);
	});
});

describe("buildThreadCompletionKey", () => {
	it("prefixes thread ids", () => {
		expect(buildThreadCompletionKey("abc")).toBe("thread:abc");
	});
});