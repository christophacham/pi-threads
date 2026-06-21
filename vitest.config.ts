import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		exclude: [".pi/**", "node_modules/**"],
	},
});