/**
 * Offline cold-start attribution from action journals.
 * Schema-1 journals expose lifecycle/prompt/send durations only; first-text and
 * bridge/store spans are unavailable until the observation plane extends the journal.
 */
import { readFile } from "node:fs/promises";

export type StartupMetric =
	| "request_to_first_text"
	| "send_to_first_text"
	| "request_to_terminal"
	| "sdk_load"
	| "bridge_setup"
	| "store_open"
	| "agent_create"
	| "agent_resume"
	| "prompt_build"
	| "agent_send";

export type Measurement =
	| { kind: "measured"; milliseconds: number }
	| { kind: "unavailable"; reason: "missing" | "censored" | "invalid" };

export type AcquisitionAttempt =
	| { kind: "create"; duration: Measurement; outcome: "success" | "error" }
	| { kind: "resume"; duration: Measurement; outcome: "success" | "error" };

export type StartupVerdict =
	| { kind: "descriptive" }
	| { kind: "pass"; comparedSamples: number }
	| { kind: "regression"; breaches: readonly StartupMetric[] }
	| { kind: "insufficient"; reasons: readonly string[] }
	| { kind: "incomparable"; differences: readonly string[] };

export type StartupTurn = {
	readonly identity: {
		processId: string;
		turnId: string;
		scopeId: string;
		agentId?: string;
		instanceId?: number;
		runId?: string;
	};
	readonly population: "provider" | "direct-sdk" | "legacy-unknown";
	readonly attempts: readonly AcquisitionAttempt[];
	readonly metrics: Readonly<Record<StartupMetric, Measurement>>;
	readonly attribution: readonly {
		phase: string;
		milliseconds: number;
		coverage: "inclusive" | "exclusive";
	}[];
	readonly quality: "complete" | "partial" | "invalid";
};

export type StartupReport = {
	readonly turns: readonly StartupTurn[];
	readonly issues: readonly string[];
	readonly verdict: StartupVerdict;
};

export type StartupComparison = {
	readonly baselineJournals: readonly string[];
	readonly limits: readonly {
		metric: StartupMetric;
		maxMedianIncreaseMs: number;
	}[];
	readonly minimumSamples: number;
};

export type StartupInput = {
	readonly journals: readonly string[];
	readonly comparison: StartupComparison | null;
};

type JournalRow = {
	schemaVersion?: number;
	action?: string;
	phase?: string;
	durationMs?: number;
	turnId?: string;
	processId?: string;
	scopeId?: string;
	agentId?: string;
	instanceId?: number;
	runId?: string;
	operationId?: string;
	population?: string;
};

const METRICS: readonly StartupMetric[] = [
	"request_to_first_text",
	"send_to_first_text",
	"request_to_terminal",
	"sdk_load",
	"bridge_setup",
	"store_open",
	"agent_create",
	"agent_resume",
	"prompt_build",
	"agent_send",
];

const DURATION_ACTION_TO_METRIC: ReadonlyMap<string, StartupMetric> = new Map([
	["agent_create", "agent_create"],
	["agent_resume", "agent_resume"],
	["prompt_build", "prompt_build"],
	["agent_send", "agent_send"],
	["sdk_load", "sdk_load"],
	["bridge_setup", "bridge_setup"],
	["store_open", "store_open"],
	["first_text", "request_to_first_text"],
]);

function unavailable(reason: "missing" | "censored" | "invalid"): Measurement {
	return { kind: "unavailable", reason };
}

function measured(milliseconds: number): Measurement {
	if (!Number.isFinite(milliseconds) || milliseconds < 0) return unavailable("invalid");
	return { kind: "measured", milliseconds: Math.round(milliseconds) };
}

function emptyMetrics(): Record<StartupMetric, Measurement> {
	const metrics = {} as Record<StartupMetric, Measurement>;
	for (const metric of METRICS) metrics[metric] = unavailable("missing");
	return metrics;
}

function parseJournalLines(text: string): { rows: JournalRow[]; issues: string[] } {
	const issues: string[] = [];
	const rows: JournalRow[] = [];
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]?.trim();
		if (!line) continue;
		try {
			const row = JSON.parse(line) as JournalRow;
			if (row.schemaVersion !== undefined && row.schemaVersion !== 1) {
				issues.push(`unknown_schema:${row.schemaVersion}`);
			}
			rows.push(row);
		} catch {
			issues.push(`invalid_json:line_${index + 1}`);
		}
	}
	return { rows, issues };
}

function turnKey(processId: string, turnId: string): string {
	return `${processId}\0${turnId}`;
}

function durationFromPair(rows: readonly JournalRow[], action: string): { duration: Measurement; outcome: "success" | "error" } | null {
	const terminal = rows.find((row) => row.action === action && (row.phase === "success" || row.phase === "error"));
	if (!terminal) return null;
	const outcome = terminal.phase === "error" ? "error" : "success";
	if (typeof terminal.durationMs !== "number") {
		return { duration: unavailable("missing"), outcome };
	}
	return { duration: measured(terminal.durationMs), outcome };
}

function reconstructTurn(processId: string, turnId: string, rows: readonly JournalRow[]): StartupTurn {
	const metrics = emptyMetrics();
	const scopeId = rows.find((row) => typeof row.scopeId === "string")?.scopeId ?? "unknown";
	const agentId = rows.find((row) => typeof row.agentId === "string")?.agentId;
	const instanceId = rows.find((row) => typeof row.instanceId === "number")?.instanceId;
	const runId = rows.find((row) => typeof row.runId === "string")?.runId;
	const populationHint = rows.find((row) => row.population === "provider" || row.population === "direct-sdk")?.population;
	const population: StartupTurn["population"] =
		populationHint === "provider" || populationHint === "direct-sdk" ? populationHint : "legacy-unknown";

	const pairs = [...DURATION_ACTION_TO_METRIC.keys()]
		.map((action) => ({ action, pair: durationFromPair(rows, action) }))
		.filter((entry): entry is { action: string; pair: NonNullable<ReturnType<typeof durationFromPair>> } => entry.pair !== null);

	for (const { action, pair } of pairs) {
		const metric = DURATION_ACTION_TO_METRIC.get(action);
		if (metric) metrics[metric] = pair.duration;
	}

	const attempts: AcquisitionAttempt[] = [];
	for (const { action, pair } of pairs) {
		if (action === "agent_create") attempts.push({ kind: "create", duration: pair.duration, outcome: pair.outcome });
		if (action === "agent_resume") attempts.push({ kind: "resume", duration: pair.duration, outcome: pair.outcome });
	}

	const attribution = pairs
		.filter((entry) => entry.pair.duration.kind === "measured")
		.map((entry) => ({
			phase: entry.action,
			milliseconds: (entry.pair.duration as { kind: "measured"; milliseconds: number }).milliseconds,
			coverage: "inclusive" as const,
		}));

	const hasLifecycle = attempts.length > 0;
	const hasSend = metrics.agent_send.kind === "measured";
	const hasFirstText = metrics.request_to_first_text.kind === "measured";
	const quality: StartupTurn["quality"] =
		rows.length === 0 ? "invalid" : hasLifecycle && hasSend && hasFirstText ? "complete" : "partial";

	return {
		identity: { processId, turnId, scopeId, agentId, instanceId, runId },
		population,
		attempts,
		metrics,
		attribution,
		quality,
	};
}

export function diagnoseCursorStartupRecords(
	rows: readonly JournalRow[],
	parseIssues: readonly string[],
): StartupReport {
	const issues = [...parseIssues];
	const byTurn = new Map<string, JournalRow[]>();
	for (const row of rows) {
		if (typeof row.processId !== "string" || typeof row.turnId !== "string") {
			issues.push("missing_turn_identity");
			continue;
		}
		const key = turnKey(row.processId, row.turnId);
		const bucket = byTurn.get(key);
		if (bucket) bucket.push(row);
		else byTurn.set(key, [row]);
	}

	const turns = [...byTurn.entries()].map(([key, turnRows]) => {
		const separator = key.indexOf("\0");
		return reconstructTurn(key.slice(0, separator), key.slice(separator + 1), turnRows);
	});

	return { turns, issues: [...new Set(issues)], verdict: { kind: "descriptive" } };
}

function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return sorted[mid]!;
	return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function measuredValues(turns: readonly StartupTurn[], metric: StartupMetric): number[] {
	return turns
		.map((turn) => turn.metrics[metric])
		.filter((value): value is { kind: "measured"; milliseconds: number } => value.kind === "measured")
		.map((value) => value.milliseconds);
}

function compareCohorts(
	candidate: readonly StartupTurn[],
	baseline: readonly StartupTurn[],
	comparison: StartupComparison,
): StartupVerdict {
	if (candidate.length < comparison.minimumSamples || baseline.length < comparison.minimumSamples) {
		return {
			kind: "insufficient",
			reasons: [
				`candidate_samples=${candidate.length}`,
				`baseline_samples=${baseline.length}`,
				`minimumSamples=${comparison.minimumSamples}`,
			],
		};
	}
	const breaches: StartupMetric[] = [];
	for (const limit of comparison.limits) {
		const candidateMedian = median(measuredValues(candidate, limit.metric));
		const baselineMedian = median(measuredValues(baseline, limit.metric));
		if (candidateMedian === null || baselineMedian === null) {
			return {
				kind: "insufficient",
				reasons: [`metric_unavailable:${limit.metric}`],
			};
		}
		if (candidateMedian - baselineMedian > limit.maxMedianIncreaseMs) {
			breaches.push(limit.metric);
		}
	}
	if (breaches.length > 0) return { kind: "regression", breaches };
	return { kind: "pass", comparedSamples: Math.min(candidate.length, baseline.length) };
}

async function readJournal(path: string): Promise<{ rows: JournalRow[]; issues: string[] }> {
	try {
		const text = await readFile(path, "utf8");
		return parseJournalLines(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { rows: [], issues: [`read_failed:${message}`] };
	}
}

export async function diagnoseCursorStartup(input: StartupInput): Promise<StartupReport> {
	const issues: string[] = [];
	const candidateRows: JournalRow[] = [];
	for (const journal of input.journals) {
		const parsed = await readJournal(journal);
		issues.push(...parsed.issues);
		candidateRows.push(...parsed.rows);
	}
	const candidate = diagnoseCursorStartupRecords(candidateRows, issues);

	if (input.comparison === null) {
		return { turns: candidate.turns, issues: candidate.issues, verdict: { kind: "descriptive" } };
	}

	const baselineRows: JournalRow[] = [];
	const baselineIssues: string[] = [];
	for (const journal of input.comparison.baselineJournals) {
		const parsed = await readJournal(journal);
		baselineIssues.push(...parsed.issues);
		baselineRows.push(...parsed.rows);
	}
	const baseline = diagnoseCursorStartupRecords(baselineRows, baselineIssues);
	const allIssues = [...new Set([...candidate.issues, ...baseline.issues])];
	return {
		turns: candidate.turns,
		issues: allIssues,
		verdict: compareCohorts(candidate.turns, baseline.turns, input.comparison),
	};
}
