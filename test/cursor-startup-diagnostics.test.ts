import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diagnoseCursorStartup } from "../src/cursor-startup-diagnostics.js";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeJournal(name: string, rows: readonly Record<string, unknown>[]): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "cursor-startup-"));
	dirs.push(dir);
	const path = join(dir, name);
	await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	return path;
}

function schema1Turn(overrides: {
	processId: string;
	turnId: string;
	createMs: number;
	sendMs: number;
}): Record<string, unknown>[] {
	const base = {
		schemaVersion: 1,
		processId: overrides.processId,
		turnId: overrides.turnId,
		scopeId: "scope-a",
		operationId: "op-1",
	};
	return [
		{ ...base, action: "agent_create", phase: "start", seq: 1 },
		{ ...base, action: "agent_create", phase: "success", durationMs: overrides.createMs, agentId: "agent-1", seq: 2 },
		{ ...base, action: "prompt_build", phase: "success", durationMs: 12, mode: "bootstrap", seq: 3 },
		{ ...base, action: "agent_send", phase: "start", agentId: "agent-1", seq: 4 },
		{ ...base, action: "agent_send", phase: "success", durationMs: overrides.sendMs, agentId: "agent-1", runId: "run-1", seq: 5 },
	];
}

describe("diagnoseCursorStartup", () => {
	it("reconstructs create/send durations and maps first_text to request_to_first_text", async () => {
		const journal = await writeJournal(
			"candidate.jsonl",
			[
				...schema1Turn({ processId: "p1", turnId: "t1", createMs: 1000, sendMs: 200 }),
				{
					schemaVersion: 1,
					processId: "p1",
					turnId: "t1",
					scopeId: "scope-a",
					action: "sdk_load",
					phase: "success",
					durationMs: 50,
					seq: 6,
				},
				{
					schemaVersion: 1,
					processId: "p1",
					turnId: "t1",
					scopeId: "scope-a",
					action: "bridge_setup",
					phase: "success",
					durationMs: 80,
					seq: 7,
				},
				{
					schemaVersion: 1,
					processId: "p1",
					turnId: "t1",
					scopeId: "scope-a",
					action: "store_open",
					phase: "success",
					durationMs: 40,
					seq: 8,
				},
				{
					schemaVersion: 1,
					processId: "p1",
					turnId: "t1",
					scopeId: "scope-a",
					action: "first_text",
					phase: "success",
					durationMs: 3500,
					seq: 9,
				},
			],
		);
		const report = await diagnoseCursorStartup({ journals: [journal], comparison: null });
		expect(report.verdict).toEqual({ kind: "descriptive" });
		expect(report.turns).toHaveLength(1);
		expect(report.turns[0]?.metrics.agent_create).toEqual({ kind: "measured", milliseconds: 1000 });
		expect(report.turns[0]?.metrics.agent_send).toEqual({ kind: "measured", milliseconds: 200 });
		expect(report.turns[0]?.metrics.sdk_load).toEqual({ kind: "measured", milliseconds: 50 });
		expect(report.turns[0]?.metrics.bridge_setup).toEqual({ kind: "measured", milliseconds: 80 });
		expect(report.turns[0]?.metrics.store_open).toEqual({ kind: "measured", milliseconds: 40 });
		expect(report.turns[0]?.metrics.request_to_first_text).toEqual({ kind: "measured", milliseconds: 3500 });
		expect(report.turns[0]?.quality).toBe("complete");
	});

	it("detects a deliberate regression on agent_create median", async () => {
		const baseline = await writeJournal(
			"baseline.jsonl",
			[
				...schema1Turn({ processId: "b1", turnId: "t1", createMs: 1000, sendMs: 100 }),
				...schema1Turn({ processId: "b2", turnId: "t2", createMs: 1100, sendMs: 100 }),
				...schema1Turn({ processId: "b3", turnId: "t3", createMs: 900, sendMs: 100 }),
			],
		);
		const candidate = await writeJournal(
			"slow.jsonl",
			[
				...schema1Turn({ processId: "c1", turnId: "t1", createMs: 5000, sendMs: 100 }),
				...schema1Turn({ processId: "c2", turnId: "t2", createMs: 5100, sendMs: 100 }),
				...schema1Turn({ processId: "c3", turnId: "t3", createMs: 4900, sendMs: 100 }),
			],
		);
		const report = await diagnoseCursorStartup({
			journals: [candidate],
			comparison: {
				baselineJournals: [baseline],
				limits: [{ metric: "agent_create", maxMedianIncreaseMs: 100 }],
				minimumSamples: 3,
			},
		});
		expect(report.verdict).toEqual({ kind: "regression", breaches: ["agent_create"] });
	});

	it("returns insufficient when sample count is below the gate", async () => {
		const baseline = await writeJournal(
			"baseline.jsonl",
			schema1Turn({ processId: "b1", turnId: "t1", createMs: 1000, sendMs: 100 }),
		);
		const candidate = await writeJournal(
			"candidate.jsonl",
			schema1Turn({ processId: "c1", turnId: "t1", createMs: 5000, sendMs: 100 }),
		);
		const report = await diagnoseCursorStartup({
			journals: [candidate],
			comparison: {
				baselineJournals: [baseline],
				limits: [{ metric: "agent_create", maxMedianIncreaseMs: 100 }],
				minimumSamples: 3,
			},
		});
		expect(report.verdict.kind).toBe("insufficient");
	});
});
