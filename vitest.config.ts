import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		maxWorkers: 4,
		setupFiles: ["./test/setup-env.ts"],
		include: ["test/**/*.test.ts"],
		exclude: ["test/**/*.compile.test.ts"],
	},
});
