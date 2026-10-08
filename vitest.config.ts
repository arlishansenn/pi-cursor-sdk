import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		maxWorkers: 4,
		setupFiles: ["./test/setup-env.ts"],
		include: ["test/**/*.test.ts"],
		exclude: ["test/**/*.compile.test.ts"],
		// Always externalize the Pi packages: an operator-level install of a newer
		// @earendil-works/pi-coding-agent under $HOME can otherwise get inlined by a
		// fork worker under load, mixing theme code with the pinned 0.87.1 checkout
		// and failing initTheme on okhsl vars that do not exist here (#46). This
		// covers module identity only; the PI_PACKAGE_DIR resource-path override is
		// neutralized in test/setup-env.ts because externalization cannot reach it.
		server: { deps: { external: [/@earendil-works\//] } },
	},
});
