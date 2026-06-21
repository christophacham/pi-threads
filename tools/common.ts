import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { type ThreadToolErrorDetails, type ThreadToolErrorResult, toThreadToolErrorDetails } from "../thread-tool-error.ts";

export function toolError(details: ThreadToolErrorDetails): AgentToolResult<ThreadToolErrorResult> {
	return { content: [{ type: "text", text: details.message }], details: { error: details }, isError: true } as AgentToolResult<ThreadToolErrorResult>;
}

export async function runTool<T>(fn: () => Promise<T>, format: (result: T) => AgentToolResult<T>): Promise<AgentToolResult<T>> {
	try { return format(await fn()); } catch (error) { return toolError(toThreadToolErrorDetails(error)) as AgentToolResult<T>; }
}
