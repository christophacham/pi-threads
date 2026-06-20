import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

export function toolError(message: string): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
		isError: true,
	} as AgentToolResult<unknown>;
}

export async function runTool<T>(
	fn: () => Promise<T>,
	format: (result: T) => AgentToolResult<unknown>,
): Promise<AgentToolResult<unknown>> {
	try {
		return format(await fn());
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return toolError(message);
	}
}