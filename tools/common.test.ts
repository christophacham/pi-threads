import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { ThreadToolError, THREAD_TOOL_ERROR_CODES } from "../thread-tool-error.ts";
import { runTool, toolError } from "./common.ts";

describe("runTool", () => {
	it("returns structured error details for ThreadToolError", async () => {
		const result = await runTool(async () => { throw new ThreadToolError(THREAD_TOOL_ERROR_CODES.THREAD_NOT_FOUND, "Thread not found: abc123", { thread_id: "abc123" }); }, (v) => ({ content: [{ type: "text", text: String(v) }], details: v as never }));
		expect((result as AgentToolResult<unknown> & { isError?: boolean }).isError).toBe(true);
		expect(result.details).toEqual({ error: { code: THREAD_TOOL_ERROR_CODES.THREAD_NOT_FOUND, message: "Thread not found: abc123", thread_id: "abc123" } });
	});
	it("wraps unknown errors with UNKNOWN code", async () => {
		const result = await runTool(async () => { throw new Error("disk full"); }, (v) => ({ content: [{ type: "text", text: String(v) }], details: v as never }));
		expect(result.details).toEqual({ error: { code: THREAD_TOOL_ERROR_CODES.UNKNOWN, message: "disk full" } });
	});
	it("toolError populates details instead of an empty object", () => {
		const result = toolError({ code: THREAD_TOOL_ERROR_CODES.THREAD_NOT_RUNNING, message: "Thread is not running: worker-1", thread_id: "worker-1", status: "completed" });
		expect(result.details.error.code).toBe(THREAD_TOOL_ERROR_CODES.THREAD_NOT_RUNNING);
	});
});
