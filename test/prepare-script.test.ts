import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const prepare = fileURLToPath(new URL("../scripts/prepare.mjs", import.meta.url));
const adapter = fileURLToPath(new URL("./fixtures/prepare-process-adapter.cjs", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "prepare lifecycle "));
	dirs.push(cwd);
	copyFileSync(prepare, join(cwd, "prepare.mjs"));
	return cwd;
}

function run(cwd: string, failure: string) {
	const result = spawnSync(process.execPath, ["--require", adapter, join(cwd, "prepare.mjs")], {
		cwd,
		timeout: 5_000,
		killSignal: "SIGKILL",
		encoding: "utf8",
		env: { ...process.env, NODE_OPTIONS: "", npm_execpath: join(cwd, "npm cli.js"), PREPARE_FAILURE: failure },
	});
	expect(result.error).toBeUndefined();
	expect(result.signal).toBeNull();
	return result;
}

function events(cwd: string) {
	return readFileSync(join(cwd, "events.txt"), "utf8").trim().split("\n");
}

describe("source prepare lifecycle at the execFile boundary", () => {
	it("fails acquisition loudly, then rebuilds and prunes on retry", () => {
		const cwd = fixture();
		const failed = run(cwd, "acquire");
		expect(failed.status).toBe(1);
		expect(failed.stderr).toContain("acquisition diagnostic");
		expect(existsSync(join(cwd, "dist/index.js"))).toBe(false);
		expect(events(cwd)).toEqual(["install --include=dev --ignore-scripts"]);
		const retry = run(cwd, "");
		expect(retry.status).toBe(0);
		expect(readFileSync(join(cwd, "dist/index.js"), "utf8")).toBe("built by process adapter\n");
		expect(existsSync(join(cwd, "node_modules/typescript/package.json"))).toBe(false);
		expect(events(cwd)).toEqual([
			"install --include=dev --ignore-scripts",
			"install --include=dev --ignore-scripts",
			"build",
			"prune --omit=dev --ignore-scripts",
		]);
	});

	it("reports the build diagnostic before a cleanup failure", () => {
		const cwd = fixture();
		const result = run(cwd, "build-and-prune");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("build diagnostic");
		expect(result.stderr).toContain("npm prune failed after a failed build: prune diagnostic");
		expect(result.stderr.indexOf("build diagnostic")).toBeLessThan(result.stderr.indexOf("prune diagnostic"));
		expect(events(cwd)).toEqual(["install --include=dev --ignore-scripts", "build", "prune --omit=dev --ignore-scripts"]);
	});
});
