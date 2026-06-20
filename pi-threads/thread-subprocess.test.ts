import { describe, expect, it } from "vitest";
import {
	buildThreadPiArgs,
	createRingBuffer,
	getRingBufferTail,
	pushRingBufferLine,
	resolvePiSpawn,
} from "./thread-subprocess.ts";

describe("thread subprocess helpers", () => {
	it("buildThreadPiArgs includes session, prompt, model, tools, and extension", () => {
		const args = buildThreadPiArgs({
			sessionFile: "/tmp/thread.jsonl",
			prompt: "[From root to worker]: Do task",
			model: "claude-sonnet",
			tools: ["read", "bash"],
			extensionEntry: "/ext/pi-threads/index.ts",
			argv: ["node", "/usr/bin/pi", "--extension", "/parent/ext.ts"],
		});

		expect(args).toContain("--mode");
		expect(args).toContain("json");
		expect(args).toContain("--session");
		expect(args).toContain("/tmp/thread.jsonl");
		expect(args).toContain("-p");
		expect(args).toContain("[From root to worker]: Do task");
		expect(args).toContain("--model");
		expect(args).toContain("claude-sonnet");
		expect(args).toContain("--tools");
		expect(args).toContain("read,bash");
		expect(args).toContain("--no-extensions");
		expect(args).toContain("--extension");
		expect(args).toContain("/ext/pi-threads/index.ts");
		expect(args).toContain("/parent/ext.ts");
	});

	it("buildThreadPiArgs omits -p prompt when resuming", () => {
		const args = buildThreadPiArgs({
			sessionFile: "/tmp/thread.jsonl",
			prompt: "ignored",
			resume: true,
			extensionEntry: "/ext/pi-threads/index.ts",
		});

		expect(args).not.toContain("-p");
		expect(args).not.toContain("ignored");
	});

	it("resolvePiSpawn uses node/bun entry script when available", () => {
		const result = resolvePiSpawn(["/usr/bin/node", "/path/to/pi.js", "--help"]);
		expect(result.command).toBe("/usr/bin/node");
		expect(result.prefixArgs).toEqual(["/path/to/pi.js"]);
	});

	it("ring buffer keeps only the most recent lines", () => {
		const buffer = createRingBuffer(3);
		pushRingBufferLine(buffer, "one\ntwo\n");
		pushRingBufferLine(buffer, "three\nfour\n");
		expect(getRingBufferTail(buffer, 10)).toEqual(["two", "three", "four"]);
	});
});