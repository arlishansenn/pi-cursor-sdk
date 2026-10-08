import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareWarmupPromptEquivalence, copyDebugEventsScrubbed, syncChildApiKeyEnv } from "../scripts/probe-provider-coldstart.mjs";

const COLD_LABEL = "provider-no-setting-sources";
const WARM_LABEL = "provider-warmup-first-prompt";

function armResult(label: string, warmReady: boolean) {
	return {
		label,
		turns: [{ journal: { sendMode: "bootstrap" } }],
		warmup: warmReady,
		warmReady,
		sendsBeforeFirstTurn: 0,
		promptChars: 11,
	};
}

function writeArmDebugEvents(
	dir: string,
	prompt: string,
	payload: { cwd: string; session: string; messages: Array<{ role: string; content: string }> },
) {
	const turnDir = join(dir, "pi-session", "turn-000-20260101T000000-000");
	mkdirSync(turnDir, { recursive: true });
	writeFileSync(
		join(turnDir, "metadata.json"),
		`${JSON.stringify({ send: { mode: "bootstrap", promptText: prompt, imageCount: 0 } }, null, 2)}\n`,
	);
	writeFileSync(join(turnDir, "send-payload.json"), `${JSON.stringify(payload, null, 2)}\n`);
}

function workDirFor(label: string, suffix: string) {
	return join(tmpdir(), `provider-coldstart-${label}-${suffix}`);
}

describe("warm-arm helper boundaries", () => {
	it("syncs a CLI-provided key into the child env and leaves it alone when absent", () => {
		const env: Record<string, string | undefined> = {};
		expect(syncChildApiKeyEnv("cli-key", env)).toBe(env);
		expect(env.CURSOR_API_KEY).toBe("cli-key");
		const untouched: Record<string, string | undefined> = { CURSOR_API_KEY: "env-key" };
		syncChildApiKeyEnv("", untouched);
		expect(untouched.CURSOR_API_KEY).toBe("env-key");
	});

	it("copies debug events freshly, scrubbing text artifacts and preserving structure", () => {
		const root = mkdtempSync(join(tmpdir(), "probe-debug-copy-"));
		const source = join(root, "source");
		const destination = join(root, "dest");
		mkdirSync(join(source, "pi-session", "turn-1"), { recursive: true });
		writeFileSync(
			join(source, "pi-session", "turn-1", "metadata.json"),
			`${JSON.stringify({ send: { promptText: "prefix syntheticScrubKey9c suffix", error: 'cookie priv"ate{cookie' } })}\n`,
		);
		writeFileSync(join(source, "pi-session", "turn-1", "notes.txt"), "error: bearer syntheticScrubKey9c\n");
		// A stale previous-run artifact in the destination must not survive the fresh copy.
		mkdirSync(join(destination, "pi-session", "stale-turn"), { recursive: true });
		writeFileSync(join(destination, "pi-session", "stale-turn", "metadata.json"), "{}\n");

		copyDebugEventsScrubbed(source, destination, ["syntheticScrubKey9c", 'priv"ate{cookie']);

		expect(existsSync(join(destination, "pi-session", "stale-turn"))).toBe(false);
		const copiedMeta = readFileSync(join(destination, "pi-session", "turn-1", "metadata.json"), "utf8");
		// A secret spanning quote/brace characters must be scrubbed as a JSON string
		// value, leaving the document parseable.
		const parsed = JSON.parse(copiedMeta) as { send: { promptText: string; error: string } };
		expect(parsed.send.promptText).not.toContain("syntheticScrubKey9c");
		expect(parsed.send.promptText).toContain("[redacted]");
		expect(parsed.send.error).toContain("[redacted]");
		expect(parsed.send.error).not.toContain('priv"ate{cookie');
		expect(readFileSync(join(destination, "pi-session", "turn-1", "notes.txt"), "utf8")).not.toContain("syntheticScrubKey9c");
		rmSync(root, { recursive: true, force: true });
	});
});

describe("compareWarmupPromptEquivalence", () => {
	it("normalizes windows-style backslash paths, including JSON-escaped payload text", async () => {
		const winRoot = "C:\\Users\\runner\\AppData\\Local\\Temp";
		const winWorkDir = (label: string, suffix: string) => `${winRoot}\\provider-coldstart-${label}-${suffix}`;
		const root = mkdtempSync(join(tmpdir(), "probe-equivalence-win-"));
		const coldDir = join(root, `${COLD_LABEL}.debug-events`);
		const warmDir = join(root, `${WARM_LABEL}.debug-events`);
		writeArmDebugEvents(
			coldDir,
			`context ${winWorkDir(COLD_LABEL, "Wx12")}\\AGENTS.md session provider-coldstart-${COLD_LABEL}\nReply with exactly: pong`,
			{
				cwd: winWorkDir(COLD_LABEL, "Wx12"),
				session: `provider-coldstart-${COLD_LABEL}`,
				messages: [{ role: "user", content: "Reply with exactly: pong" }],
			},
		);
		writeArmDebugEvents(
			warmDir,
			`context ${winWorkDir(WARM_LABEL, "Qz77")}\\AGENTS.md session provider-coldstart-${WARM_LABEL}\nReply with exactly: pong`,
			{
				cwd: winWorkDir(WARM_LABEL, "Qz77"),
				session: `provider-coldstart-${WARM_LABEL}`,
				messages: [{ role: "user", content: "Reply with exactly: pong" }],
			},
		);

		const report = await compareWarmupPromptEquivalence({
			coldDir,
			warmDir,
			coldResult: armResult(COLD_LABEL, false),
			warmResult: armResult(WARM_LABEL, true),
			tmpRoot: winRoot,
		});

		expect(report.compared).toBe(true);
		expect(report.promptTextEqual).toBe(true);
		// The payload is compared as serialized JSON, where backslashes double; the
		// separator class must still swallow them (the windows-latest CI failure).
		expect(report.sendPayloadEqual).toBe(true);
	});

	it("reports equality when arms differ only by work dir and scenario label", async () => {
		const root = mkdtempSync(join(tmpdir(), "probe-equivalence-"));
		const coldDir = join(root, `${COLD_LABEL}.debug-events`);
		const warmDir = join(root, `${WARM_LABEL}.debug-events`);
		writeArmDebugEvents(
			coldDir,
			`context ${workDirFor(COLD_LABEL, "Ab12Cd")}/AGENTS.md session provider-coldstart-${COLD_LABEL}\nReply with exactly: pong`,
			{
				cwd: workDirFor(COLD_LABEL, "Ab12Cd"),
				session: `provider-coldstart-${COLD_LABEL}`,
				messages: [{ role: "user", content: "Reply with exactly: pong" }],
			},
		);
		writeArmDebugEvents(
			warmDir,
			`context ${workDirFor(WARM_LABEL, "Xy98Zw")}/AGENTS.md session provider-coldstart-${WARM_LABEL}\nReply with exactly: pong`,
			{
				cwd: workDirFor(WARM_LABEL, "Xy98Zw"),
				session: `provider-coldstart-${WARM_LABEL}`,
				messages: [{ role: "user", content: "Reply with exactly: pong" }],
			},
		);

		const report = await compareWarmupPromptEquivalence({
			coldDir,
			warmDir,
			coldResult: armResult(COLD_LABEL, false),
			warmResult: armResult(WARM_LABEL, true),
		});

		expect(report.compared).toBe(true);
		expect(report.missing).toEqual([]);
		expect(report.promptTextEqual).toBe(true);
		expect(report.sendPayloadEqual).toBe(true);
		expect(report.imageCountEqual).toBe(true);
		expect(report.cold).toEqual({
			label: COLD_LABEL,
			sendMode: "bootstrap",
			promptChars: 11,
			sendsBeforeFirstTurn: 0,
			warmReady: false,
		});
		expect(report.warm.warmReady).toBe(true);
		const persisted = JSON.parse(readFileSync(join(root, "equivalence.json"), "utf8"));
		expect(persisted.promptTextEqual).toBe(true);
		expect(persisted.sendPayloadEqual).toBe(true);
	});

	it("reports differences when arm content diverges", async () => {
		const root = mkdtempSync(join(tmpdir(), "probe-equivalence-"));
		const coldDir = join(root, `${COLD_LABEL}.debug-events`);
		const warmDir = join(root, `${WARM_LABEL}.debug-events`);
		writeArmDebugEvents(
			coldDir,
			`context ${workDirFor(COLD_LABEL, "Ab12Cd")}/AGENTS.md\nReply with exactly: pong`,
			{ cwd: workDirFor(COLD_LABEL, "Ab12Cd"), session: "s", messages: [{ role: "user", content: "Reply with exactly: pong" }] },
		);
		writeArmDebugEvents(
			warmDir,
			`context ${workDirFor(WARM_LABEL, "Xy98Zw")}/AGENTS.md\nReply with exactly: pong2`,
			{ cwd: workDirFor(WARM_LABEL, "Xy98Zw"), session: "s", messages: [{ role: "user", content: "Reply with exactly: pong2" }] },
		);

		const report = await compareWarmupPromptEquivalence({
			coldDir,
			warmDir,
			coldResult: armResult(COLD_LABEL, false),
			warmResult: armResult(WARM_LABEL, true),
		});

		expect(report.compared).toBe(true);
		expect(report.promptTextEqual).toBe(false);
		expect(report.sendPayloadEqual).toBe(false);
		expect(report.imageCountEqual).toBe(true);
	});

	it("reports missing evidence without throwing", async () => {
		const root = mkdtempSync(join(tmpdir(), "probe-equivalence-"));
		const coldDir = join(root, `${COLD_LABEL}.debug-events`);
		const warmDir = join(root, `${WARM_LABEL}.debug-events`);
		writeArmDebugEvents(
			coldDir,
			`context ${workDirFor(COLD_LABEL, "Ab12Cd")}/AGENTS.md\nReply with exactly: pong`,
			{ cwd: workDirFor(COLD_LABEL, "Ab12Cd"), session: "s", messages: [{ role: "user", content: "Reply with exactly: pong" }] },
		);
		mkdirSync(warmDir, { recursive: true });

		const report = await compareWarmupPromptEquivalence({
			coldDir,
			warmDir,
			coldResult: armResult(COLD_LABEL, false),
			warmResult: armResult(WARM_LABEL, true),
		});

		expect(report.compared).toBe(false);
		expect(report.missing).toEqual([{ arm: "warm", file: "metadata.json" }]);
		expect(report.promptTextEqual).toBe(null);
		expect(report.sendPayloadEqual).toBe(null);
		expect(report.imageCountEqual).toBe(null);
		expect(existsSync(join(root, "equivalence.json"))).toBe(true);
	});
});
