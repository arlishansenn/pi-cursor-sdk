import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { noteCursorActionFirstText, traceCursorAction, traceCursorSyncAction, withCursorActionTurn, __testUtils } from "../src/cursor-actions-log.js";
import { diagnoseCursorStartup } from "../src/cursor-startup-diagnostics.js";

const dirs: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeJournal(name: string, rows: readonly unknown[]): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "cursor-startup-"));
	dirs.push(dir);
	const path = join(dir, name);
	await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
	return path;
}

/** Distinct operation ids per span: the real writer allocates one per span. */
let operationSeq = 0;
function nextOperationId(): string {
	operationSeq += 1;
	return `op-${operationSeq}`;
}

function schema1Turn(overrides: {
	processId: string;
	turnId: string;
	createMs: number | null;
	sendMs: number;
}): Record<string, unknown>[] {
	const base = { schemaVersion: 1, processId: overrides.processId, turnId: overrides.turnId, scopeId: "scope-a" };
	const rows: Record<string, unknown>[] = [];
	if (overrides.createMs !== null) {
		const operationId = nextOperationId();
		rows.push({ ...base, action: "agent_create", phase: "start", operationId, seq: 1 });
		rows.push({
			...base, action: "agent_create", phase: "success", durationMs: overrides.createMs, agentId: "agent-1", operationId, seq: 2,
		});
	}
	rows.push({ ...base, action: "prompt_build", phase: "success", durationMs: 12, mode: "bootstrap", operationId: nextOperationId(), seq: 3 });
	const sendOperationId = nextOperationId();
	rows.push({ ...base, action: "agent_send", phase: "start", agentId: "agent-1", operationId: sendOperationId, seq: 4 });
	rows.push({
		...base, action: "agent_send", phase: "success", durationMs: overrides.sendMs, agentId: "agent-1", runId: "run-1", operationId: sendOperationId, seq: 5,
	});
	return rows;
}

describe("diagnoseCursorStartup", () => {
	it("reconstructs create/send durations and maps first_text to request_to_first_text", async () => {
		const journal = await writeJournal("candidate.jsonl", [
			...schema1Turn({ processId: "p1", turnId: "t1", createMs: 1000, sendMs: 200 }),
			{ schemaVersion: 1, processId: "p1", turnId: "t1", scopeId: "scope-a", action: "sdk_load", phase: "success", durationMs: 50, operationId: nextOperationId(), seq: 6 },
			{ schemaVersion: 1, processId: "p1", turnId: "t1", scopeId: "scope-a", action: "bridge_setup", phase: "success", durationMs: 80, operationId: nextOperationId(), seq: 7 },
			{ schemaVersion: 1, processId: "p1", turnId: "t1", scopeId: "scope-a", action: "store_open", phase: "success", durationMs: 40, operationId: nextOperationId(), seq: 8 },
			{ schemaVersion: 1, processId: "p1", turnId: "t1", scopeId: "scope-a", action: "first_text", phase: "success", durationMs: 3500, seq: 9 },
		]);
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
		const baseline = await writeJournal("baseline.jsonl", [
			...schema1Turn({ processId: "b1", turnId: "t1", createMs: 1000, sendMs: 100 }),
			...schema1Turn({ processId: "b2", turnId: "t2", createMs: 1100, sendMs: 100 }),
			...schema1Turn({ processId: "b3", turnId: "t3", createMs: 900, sendMs: 100 }),
		]);
		const candidate = await writeJournal("slow.jsonl", [
			...schema1Turn({ processId: "c1", turnId: "t1", createMs: 5000, sendMs: 100 }),
			...schema1Turn({ processId: "c2", turnId: "t2", createMs: 5100, sendMs: 100 }),
			...schema1Turn({ processId: "c3", turnId: "t3", createMs: 4900, sendMs: 100 }),
		]);
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

	it("gates on measured samples per metric, not on cohort turn counts", async () => {
		// Three turns per cohort, but only the first turn ever measured agent_create.
		// The previous cohort-size gate let this pass as if three samples existed.
		const cohort = (prefix: string, createMs: number) => [
			...schema1Turn({ processId: `${prefix}1`, turnId: "t1", createMs, sendMs: 100 }),
			...schema1Turn({ processId: `${prefix}2`, turnId: "t2", createMs: null, sendMs: 100 }),
			...schema1Turn({ processId: `${prefix}3`, turnId: "t3", createMs: null, sendMs: 100 }),
		];
		const baseline = await writeJournal("baseline.jsonl", cohort("b", 1000));
		const candidate = await writeJournal("candidate.jsonl", cohort("c", 5000));
		const report = await diagnoseCursorStartup({
			journals: [candidate],
			comparison: {
				baselineJournals: [baseline],
				limits: [{ metric: "agent_create", maxMedianIncreaseMs: 100 }],
				minimumSamples: 3,
			},
		});
		expect(report.verdict).toEqual({
			kind: "insufficient",
			reasons: [
				"metric_samples:agent_create:candidate=1",
				"metric_samples:agent_create:baseline=1",
				"minimumSamples=3",
			],
		});
	});

	it("counts error-phase durations as measured samples and keeps attempt outcomes", async () => {
		const errorTurn = (processId: string, resumeMs: number): Record<string, unknown>[] => [
			{
				schemaVersion: 1, processId, turnId: "t1", scopeId: "scope-a",
				action: "agent_resume", phase: "error", durationMs: resumeMs, agentId: "agent-old", operationId: nextOperationId(),
			},
			{
				schemaVersion: 1, processId, turnId: "t1", scopeId: "scope-a",
				action: "agent_create", phase: "success", durationMs: 300, agentId: "agent-new", operationId: nextOperationId(),
			},
		];
		const journal = await writeJournal("resume-errors.jsonl", [
			...errorTurn("p1", 120),
			...errorTurn("p2", 140),
			...errorTurn("p3", 160),
		]);
		const baseline = await writeJournal("baseline.jsonl", [
			...errorTurn("b1", 100),
			...errorTurn("b2", 110),
			...errorTurn("b3", 120),
		]);
		const report = await diagnoseCursorStartup({
			journals: [journal],
			comparison: {
				baselineJournals: [baseline],
				limits: [{ metric: "agent_resume", maxMedianIncreaseMs: 50 }],
				minimumSamples: 3,
			},
		});
		expect(report.verdict).toEqual({ kind: "pass", comparedSamples: 3 });
		for (const turn of report.turns) {
			expect(turn.attempts).toEqual([
				{ kind: "resume", duration: expect.objectContaining({ kind: "measured" }), outcome: "error" },
				{ kind: "create", duration: expect.objectContaining({ kind: "measured" }), outcome: "success" },
			]);
		}
	});

	it("reports insufficient with zero samples when the metric is fully missing", async () => {
		const baseline = await writeJournal("baseline.jsonl", schema1Turn({ processId: "b1", turnId: "t1", createMs: 1000, sendMs: 100 }));
		const candidate = await writeJournal("candidate.jsonl", schema1Turn({ processId: "c1", turnId: "t1", createMs: null, sendMs: 100 }));
		const report = await diagnoseCursorStartup({
			journals: [candidate],
			comparison: {
				baselineJournals: [baseline],
				limits: [{ metric: "agent_create", maxMedianIncreaseMs: 100 }],
				minimumSamples: 1,
			},
		});
		expect(report.verdict).toEqual({
			kind: "insufficient",
			reasons: ["metric_samples:agent_create:candidate=0", "metric_samples:agent_create:baseline=1", "minimumSamples=1"],
		});
	});

	it("keeps untrusted rows out of measurements and verdicts", async () => {
		const untrusted = await writeJournal("untrusted.jsonl", [
			42,
			[1, 2, 3],
			null,
			{ schemaVersion: 1, processId: "p9", turnId: "t1", action: "agent_create", phase: "success", durationMs: "300" },
			{ schemaVersion: 1, processId: 7, turnId: "t1", action: "agent_create", phase: "success", durationMs: 300 },
			{ schemaVersion: 99, processId: "p9", turnId: "t2", action: "agent_create", phase: "success", durationMs: 500, scopeId: "scope-a" },
			{ processId: "p9", turnId: "t3", action: "agent_create", phase: "success", durationMs: 500 },
		]);
		const report = await diagnoseCursorStartup({
			journals: [untrusted],
			comparison: {
				baselineJournals: [untrusted],
				limits: [{ metric: "agent_create", maxMedianIncreaseMs: 1000 }],
				minimumSamples: 1,
			},
		});
		expect(report.turns).toEqual([]);
		expect(report.issues).toEqual(expect.arrayContaining([
			"invalid_json_root:line_1",
			"invalid_json_root:line_2",
			"invalid_json_root:line_3",
			"invalid_field:durationMs:line_4",
			"invalid_field:processId:line_5",
			"unsupported_schema:99:line_6",
			"missing_schema_version:line_7",
		]));
		expect(report.verdict).toEqual({
			kind: "insufficient",
			reasons: ["metric_samples:agent_create:candidate=0", "metric_samples:agent_create:baseline=0", "minimumSamples=1"],
		});
	});
});

describe("diagnoseCursorStartup journal contract (real writer)", () => {
	it("rebuilds resume→create fallback and repeated operations from a real journal", async () => {
		const dir = await mkdtemp(join(tmpdir(), "cursor-startup-e2e-"));
		dirs.push(dir);
		const journal = join(dir, "actions.jsonl");
		vi.stubEnv("CURSOR_SDK_ACTIONS_LOG", journal);

		await withCursorActionTurn(async () => {
			await expect(
				traceCursorAction({ action: "agent_resume", runtime: "local", agentId: "agent-old" }, async () => {
					throw new Error("resume rejected");
				}),
			).rejects.toThrow("resume rejected");
			await traceCursorAction({ action: "agent_create", runtime: "local" }, async () => ({ agentId: "agent-new" }), (created) => ({ agentId: created.agentId }));
			// Same turn reacquires and creates again: a second, later operation.
			await traceCursorAction({ action: "agent_create", runtime: "local", forceCreate: true }, async () => ({ agentId: "agent-new-2" }), (created) => ({ agentId: created.agentId }));
			traceCursorSyncAction({ action: "prompt_build", runtime: "local", mode: "bootstrap" }, () => "prompt");
			noteCursorActionFirstText();
			await traceCursorAction({ action: "agent_send", runtime: "local" }, async () => ({ runId: "run-1" }), (run) => ({ runId: run.runId }));
		});
		await __testUtils.flush();

		const report = await diagnoseCursorStartup({ journals: [journal], comparison: null });
		expect(report.issues).toEqual([]);
		expect(report.turns).toHaveLength(1);
		const turn = report.turns[0]!;
		expect(turn.attempts.map((attempt) => [attempt.kind, attempt.outcome])).toEqual([
			["resume", "error"],
			["create", "success"],
			["create", "success"],
		]);
		for (const attempt of turn.attempts) {
			expect(attempt.duration.kind).toBe("measured");
		}
		// Turn-level agent_create sums both create spans; each attempt keeps its own duration.
		const createDurations = turn.attempts
			.filter((attempt) => attempt.kind === "create" && attempt.duration.kind === "measured")
			.map((attempt) => (attempt.duration as { kind: "measured"; milliseconds: number }).milliseconds);
		expect(turn.metrics.agent_create).toEqual({
			kind: "measured",
			milliseconds: createDurations.reduce((total, value) => total + value, 0),
		});
		expect(turn.metrics.agent_resume.kind).toBe("measured");
		expect(turn.metrics.prompt_build.kind).toBe("measured");
		expect(turn.metrics.agent_send.kind).toBe("measured");
		expect(turn.metrics.request_to_first_text.kind).toBe("measured");
		expect(turn.quality).toBe("complete");
		expect(turn.attribution.map((entry) => entry.phase)).toEqual([
			"agent_resume",
			"agent_create",
			"agent_create",
			"prompt_build",
			"first_text",
			"agent_send",
		]);
	});
});
