import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CURSOR_SDK_EVENT_DEBUG_ENV_NAMES } from "../scripts/lib/cursor-smoke-env.mjs";
import { buildScenarioChildEnv, runScenarioChildProcess } from "../scripts/probe-provider-coldstart.mjs";

const SCRIPT = resolve("scripts/probe-provider-coldstart.mjs");
const SIGNAL_PARENT = resolve("scripts/fixtures/probe-child-signal-parent.mjs");
const REPO_ROOT = resolve(".");

function runProbe(argv: readonly string[], envOverrides: Record<string, string | undefined> = {}) {
	const env: NodeJS.ProcessEnv = { ...process.env, ...envOverrides };
	if (envOverrides.CURSOR_API_KEY === undefined) delete env.CURSOR_API_KEY;
	return spawnSync(process.execPath, [SCRIPT, ...argv], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		env,
		timeout: 60_000,
	});
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/** Node -e payload that spawns one detached descendant and prints its pid. */
function spawnDescendantScript(descendantScript: string, rootTail = ""): string {
	return `const { spawn } = require("node:child_process");
const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: "ignore" });
grandchild.unref();
console.log(grandchild.pid);
${rootTail}`;
}

function parseSpawnedPid(stdout: string): number {
	return Number.parseInt(stdout.trim(), 10);
}

describe("probe-provider-coldstart launcher CLI surface", () => {
	it("shows --help without credentials and without the build/import/live path", () => {
		const started = Date.now();
		const result = runProbe(["--help"]);
		expect(result.status).toBe(0);
		// No credentials were provided; help must not need them.
		expect(result.stderr.trim()).toBe("");
		expect(result.stdout).toContain("Usage:");
		expect(result.stdout).toContain("provider-no-setting-sources");
		expect(result.stdout).toContain("provider-warmup-first-prompt");
		expect(result.stdout).toContain("equivalence.json");
		expect(result.stdout).toContain("Sampled boundary");
		expect(result.stdout.startsWith("Measure Cursor provider-path")).toBe(true);
		// Help must not rebuild dist/ (ensureBuilt) or import the SDK; both take
		// far longer than argument parsing.
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	it("fails with a non-zero exit when auth is missing", () => {
		const result = runProbe([]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("CURSOR_API_KEY is required");
	});

	it("fails on an unknown scenario without reaching the live path", () => {
		const key = "synthetic-launcher-key-4f0a";
		const result = runProbe(["--api-key", key, "--scenario", "no-such-scenario"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("unknown scenario: no-such-scenario");
		expect(result.stderr).not.toContain(key);
	});

	it("scrubs a --api-key value echoed back by an unknown argument", () => {
		const key = "syntheticCliSecret7f3a";
		const result = runProbe(["--api-key", key, key]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("unknown argument");
		expect(result.stderr).toContain("[redacted]");
		expect(result.stderr).not.toContain(key);
		expect(result.stdout.trim()).toBe("");
	});

	it("scrubs a --api-key=value echoed back by an unknown argument", () => {
		const key = "syntheticEqualsSecret9c22";
		const result = runProbe([`--api-key=${key}`, key]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("unknown argument");
		expect(result.stderr).toContain("[redacted]");
		expect(result.stderr).not.toContain(key);
	});

	it("scrubs env and CLI keys at the same time when they differ", () => {
		const envKey = "syntheticEnvSecret51aa";
		const cliKey = "syntheticCliSecret77e0";
		const viaCli = runProbe(["--api-key", cliKey, cliKey], { CURSOR_API_KEY: envKey });
		expect(viaCli.status).toBe(1);
		expect(viaCli.stderr).toContain("[redacted]");
		expect(viaCli.stderr).not.toContain(cliKey);
		expect(viaCli.stderr).not.toContain(envKey);

		const viaEnv = runProbe([envKey], { CURSOR_API_KEY: envKey });
		expect(viaEnv.status).toBe(1);
		expect(viaEnv.stderr).toContain("unknown argument");
		expect(viaEnv.stderr).toContain("[redacted]");
		expect(viaEnv.stderr).not.toContain(envKey);
	});

	it("scrubs every repeated --api-key value, not only the effective one", () => {
		const firstKey = "syntheticDupFirst9d31";
		const secondKey = "syntheticDupSecond0e57";
		const result = runProbe(["--api-key", firstKey, "--api-key", secondKey, secondKey]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("unknown argument");
		expect(result.stderr).toContain("[redacted]");
		expect(result.stderr).not.toContain(firstKey);
		expect(result.stderr).not.toContain(secondKey);

		const mixed = runProbe([`--api-key=${firstKey}`, "--api-key", secondKey, firstKey]);
		expect(mixed.status).toBe(1);
		expect(mixed.stderr).toContain("[redacted]");
		expect(mixed.stderr).not.toContain(firstKey);
		expect(mixed.stderr).not.toContain(secondKey);
	});
});

describe("probe-provider-coldstart child lifecycle", () => {
	it("propagates child success with captured output", async () => {
		const result = await runScenarioChildProcess({
			command: process.execPath,
			args: ["-e", "console.log('child-ok')"],
			env: { ...process.env },
			timeoutMs: 30_000,
		});
		expect(result.ok).toBe(true);
		expect(result.timedOut).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("child-ok");
	});

	it("propagates a non-zero child exit as failure", async () => {
		const result = await runScenarioChildProcess({
			command: process.execPath,
			args: ["-e", "process.exit(3)"],
			env: { ...process.env },
			timeoutMs: 30_000,
		});
		expect(result.ok).toBe(false);
		expect(result.timedOut).toBe(false);
		expect(result.exitCode).toBe(3);
	});

	it("enforces the wall-clock deadline and terminates the child tree", async () => {
		const result = await runScenarioChildProcess({
			command: process.execPath,
			args: ["-e", "setInterval(() => {}, 1000)"],
			env: { ...process.env },
			timeoutMs: 500,
		});
		expect(result.ok).toBe(false);
		expect(result.timedOut).toBe(true);
		if (result.pid !== undefined) {
			expect(processExists(result.pid)).toBe(false);
		}
	}, 15_000);

	it("reports spawn errors as failures", async () => {
		const result = await runScenarioChildProcess({
			command: join(dirname(process.execPath), "definitely-missing-binary-3f7c"),
			args: [],
			env: { ...process.env },
			timeoutMs: 10_000,
		});
		expect(result.ok).toBe(false);
		expect(result.timedOut).toBe(false);
		expect(result.spawnError).toEqual(expect.any(String));
	});

	it("bounds captured output instead of accumulating without limit", async () => {
		const result = await runScenarioChildProcess({
			command: process.execPath,
			args: ["-e", "process.stdout.write('a'.repeat(64 * 1024))"],
			env: { ...process.env },
			timeoutMs: 30_000,
			maxOutputBytes: 4096,
		});
		expect(result.ok).toBe(true);
		expect(result.truncated).toBe(true);
		expect(result.stdout.length).toBeLessThanOrEqual(4096);
	});

	it("cleans up surviving descendants after the root exits successfully", async () => {
		const result = await runScenarioChildProcess({
			command: process.execPath,
			args: ["-e", spawnDescendantScript("setInterval(() => {}, 1000);")],
			env: { ...process.env },
			timeoutMs: 30_000,
		});
		expect(result.ok).toBe(true);
		expect(result.cleanupError).toBeUndefined();
		const grandchildPid = parseSpawnedPid(result.stdout);
		expect(Number.isInteger(grandchildPid)).toBe(true);
		// The helper must not return while an orphaned descendant is still alive.
		expect(processExists(grandchildPid)).toBe(false);
	}, 15_000);

	it("cleans up surviving descendants after a non-zero root exit", async () => {
		const result = await runScenarioChildProcess({
			command: process.execPath,
			args: ["-e", spawnDescendantScript("setInterval(() => {}, 1000);", "setTimeout(() => process.exit(3), 50);")],
			env: { ...process.env },
			timeoutMs: 30_000,
		});
		expect(result.ok).toBe(false);
		expect(result.exitCode).toBe(3);
		const grandchildPid = parseSpawnedPid(result.stdout);
		expect(Number.isInteger(grandchildPid)).toBe(true);
		expect(processExists(grandchildPid)).toBe(false);
	}, 15_000);

	it("waits out a TERM-ignoring descendant when the deadline hits", async () => {
		const result = await runScenarioChildProcess({
			command: process.execPath,
			args: [
				"-e",
				spawnDescendantScript(
					'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);',
					"setInterval(() => {}, 1000);",
				),
			],
			env: { ...process.env },
			timeoutMs: 500,
		});
		expect(result.ok).toBe(false);
		expect(result.timedOut).toBe(true);
		const grandchildPid = parseSpawnedPid(result.stdout);
		expect(Number.isInteger(grandchildPid)).toBe(true);
		// Escalation to SIGKILL must complete before the helper returns.
		expect(processExists(grandchildPid)).toBe(false);
	}, 15_000);

	it("terminates the child tree when the parent is interrupted", async () => {
		const fixtureEnv: NodeJS.ProcessEnv = { ...process.env };
		delete fixtureEnv.CURSOR_API_KEY;
		const parent = spawn(process.execPath, [SIGNAL_PARENT], {
			cwd: REPO_ROOT,
			env: fixtureEnv,
			stdio: ["ignore", "pipe", "inherit"],
		});
		let parentStdout = "";
		parent.stdout?.on("data", (chunk) => {
			parentStdout += String(chunk);
		});
		// The fixture prints a pid-file path; the hanging child writes its own pid
		// there, so receiving a live pid means the child tree is running.
		const childPid = await new Promise<number>((resolvePid) => {
			const poll = setInterval(() => {
				const pidFile = parentStdout.split("\n")[0]?.trim();
				if (!pidFile) return;
				try {
					const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
					if (Number.isInteger(pid) && processExists(pid)) {
						clearInterval(poll);
						resolvePid(pid);
					}
				} catch {
					// pid file not written yet
				}
			}, 25);
		});
		parent.kill("SIGINT");
		const parentExited = await new Promise<boolean>((resolveExited) => {
			const deadline = Date.now() + 15_000;
			const poll = setInterval(() => {
				if (!processExists(parent.pid!) || Date.now() > deadline) {
					clearInterval(poll);
					resolveExited(!processExists(parent.pid!));
				}
			}, 25);
		});
		expect(parentExited).toBe(true);
		// The interrupted parent must not orphan its detached scenario child.
		await new Promise<void>((resolveGone) => {
			const deadline = Date.now() + 10_000;
			const poll = setInterval(() => {
				if (!processExists(childPid) || Date.now() > deadline) {
					clearInterval(poll);
					resolveGone();
				}
			}, 25);
		});
		expect(processExists(childPid)).toBe(false);
	}, 30_000);
});

describe("probe-provider-coldstart scenario child environment", () => {
	it("seals the scenario child env with canonical smoke-env semantics", () => {
		const baseEnv: NodeJS.ProcessEnv = {
			...process.env,
			CURSOR_API_KEY: "synthetic-parent-key",
			[CURSOR_SDK_EVENT_DEBUG_ENV_NAMES[0]!]: "1",
		};
		const all = buildScenarioChildEnv(
			{ label: "provider-all-settings", settingSources: "all", turns: 1 },
			"synthetic-child-key",
			baseEnv,
		);
		expect(all.CURSOR_API_KEY).toBe("synthetic-child-key");
		expect(all.PI_CURSOR_SETTING_SOURCES).toBe("all");
		for (const name of CURSOR_SDK_EVENT_DEBUG_ENV_NAMES) {
			expect(all[name]).toBeUndefined();
		}
		expect(all.PATH!.startsWith(dirname(process.execPath))).toBe(true);

		const none = buildScenarioChildEnv(
			{ label: "provider-no-setting-sources", settingSources: "none", turns: 1 },
			"synthetic-child-key",
			baseEnv,
		);
		expect(none.PI_CURSOR_SETTING_SOURCES).toBe("none");
	});
});
