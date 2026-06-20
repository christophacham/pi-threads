import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

export function toolError<T = unknown>(message: string): AgentToolResult<T> {
	return {
		content: [{ type: "text", text: message }],
		details: {} as T,
		isError: true,
	} as AgentToolResult<T>;
}

export async function runTool<T>(
	fn: () => Promise<T>,
	format: (result: T) => AgentToolResult<T>,
): Promise<AgentToolResult<T>> {
	try {
		return format(await fn());
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return toolError(message);
	}
}