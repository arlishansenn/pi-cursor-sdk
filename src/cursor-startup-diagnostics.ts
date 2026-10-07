/**
 * Offline cold-start attribution from action journals.
 * Journals are untrusted input: a boundary parser validates each JSONL line into
 * a schema-1 row before any measurement is rebuilt from it. Turn-level metrics
 * sum every terminal span of the action within the turn (repeated operations
 * such as resume→create fallback each contribute their own duration and attempt).
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
	| { kind: "unavailable"; reason: "missing" };

export type AcquisitionAttempt =
	| { kind: "create"; duration: Measurement; outcome: "success" | "error" }
	| { kind: "resume"; duration: Measurement; outcome: "success" | "error" };

export type StartupVerdict =
	| { kind: "descriptive" }
	/** Minimum measured sample pair count that entered every limit's medians. */
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
	readonly quality: "complete" | "partial";
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

/** Schema-1 action journal row exactly as validated at the JSONL boundary. */
type JournalRow = {
	readonly schemaVersion: 1;
	readonly processId: string;
	readonly turnId: string;
	readonly action: string;
	readonly phase: "start" | "success" | "error" | "decision";
	readonly durationMs?: number;
	readonly scopeId?: string;
	readonly agentId?: string;
	readonly instanceId?: number;
	readonly runId?: string;
	readonly operationId?: string;
	readonly population?: "provider" | "direct-sdk";
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

const TERMINAL_PHASES: ReadonlySet<JournalRow["phase"]> = new Set(["success", "error"]);

function isJournalPhase(value: string): value is JournalRow["phase"] {
	return value === "start" || value === "success" || value === "error" || value === "decision";
}

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

const ATTEMPT_ACTIONS: ReadonlySet<string> = new Set(["agent_create", "agent_resume"]);

function unavailable(): Measurement {
	return { kind: "unavailable", reason: "missing" };
}

function measured(milliseconds: number): Measurement {
	return { kind: "measured", milliseconds: Math.round(milliseconds) };
}

function emptyMetrics(): Record<StartupMetric, Measurement> {
	const metrics = {} as Record<StartupMetric, Measurement>;
	for (const metric of METRICS) metrics[metric] = unavailable();
	return metrics;
}

/**
 * Boundary parser: bind the JSON.parse result to `unknown` and validate the root
 * object, the supported schema, and every consumed field. Rows that fail any
 * check are recorded as issues and never reach measurement reconstruction.
 */
function parseJournalRow(value: unknown, issues: string[], line: number): JournalRow | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		issues.push(`invalid_json_root:line_${line}`);
		return null;
	}
	const raw = value as Record<string, unknown>;
	if (raw.schemaVersion !== 1) {
		issues.push(
			raw.schemaVersion === undefined
				? `missing_schema_version:line_${line}`
				: `unsupported_schema:${String(raw.schemaVersion)}:line_${line}`,
		);
		return null;
	}
	let valid = true;
	const readString = (name: string): string | undefined => {
		const field = raw[name];
		if (field === undefined) return undefined;
		if (typeof field !== "string") {
			issues.push(`invalid_field:${name}:line_${line}`);
			valid = false;
			return undefined;
		}
		return field;
	};
	const readNumber = (name: string): number | undefined => {
		const field = raw[name];
		if (field === undefined) return undefined;
		if (typeof field !== "number" || !Number.isFinite(field) || field < 0) {
			issues.push(`invalid_field:${name}:line_${line}`);
			valid = false;
			return undefined;
		}
		return field;
	};
	const population = raw.population;
	if (population !== undefined && population !== "provider" && population !== "direct-sdk") {
		issues.push(`invalid_field:population:line_${line}`);
		valid = false;
	}
	if (!valid) return null;

	const processId = readString("processId");
	const turnId = readString("turnId");
	const action = readString("action");
	const phase = readString("phase");
	const durationMs = readNumber("durationMs");
	const scopeId = readString("scopeId");
	const agentId = readString("agentId");
	const runId = readString("runId");
	const operationId = readString("operationId");
	const instanceId = readNumber("instanceId");
	if (!valid) return null;
	if (processId === undefined || turnId === undefined || action === undefined || phase === undefined) {
		issues.push(`missing_required_field:line_${line}`);
		return null;
	}
	if (!isJournalPhase(phase)) {
		issues.push(`invalid_field:phase:line_${line}`);
		return null;
	}
	return {
		schemaVersion: 1,
		processId,
		turnId,
		action,
		phase,
		...(durationMs !== undefined ? { durationMs } : {}),
		...(scopeId !== undefined ? { scopeId } : {}),
		...(agentId !== undefined ? { agentId } : {}),
		...(runId !== undefined ? { runId } : {}),
		...(operationId !== undefined ? { operationId } : {}),
		...(instanceId !== undefined ? { instanceId } : {}),
		...(population !== undefined ? { population: population as "provider" | "direct-sdk" } : {}),
	};
}

function parseJournalLines(text: string): { rows: JournalRow[]; issues: string[] } {
	const issues: string[] = [];
	const rows: JournalRow[] = [];
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]?.trim();
		if (!line) continue;
		try {
			const row = parseJournalRow(JSON.parse(line), issues, index + 1);
			if (row) rows.push(row);
		} catch {
			issues.push(`invalid_json:line_${index + 1}`);
		}
	}
	return { rows, issues };
}

function turnKey(processId: string, turnId: string): string {
	return `${processId}\0${turnId}`;
}

type TerminalOperation = {
	readonly action: string;
	readonly outcome: "success" | "error";
	readonly duration: Measurement;
};

/**
 * Single ordered pass over one turn's validated rows. Every terminal row that
 * carries an operationId marks the end of one operation span; standalone
 * terminals without an operationId (e.g. first_text) count as their own entry.
 * Order is journal append order, which preserves the real attempt sequence
 * (resume failure before create fallback, repeated operations intact).
 */
function collectTerminalOperations(rows: readonly JournalRow[]): TerminalOperation[] {
	const seenOperationIds = new Set<string>();
	const operations: TerminalOperation[] = [];
	for (const row of rows) {
		if (!TERMINAL_PHASES.has(row.phase)) continue;
		if (row.operationId !== undefined) {
			if (seenOperationIds.has(row.operationId)) continue;
			seenOperationIds.add(row.operationId);
		}
		operations.push({
			action: row.action,
			outcome: row.phase === "error" ? "error" : "success",
			duration: row.durationMs === undefined ? unavailable() : measured(row.durationMs),
		});
	}
	return operations;
}

function reconstructTurn(processId: string, turnId: string, rows: readonly JournalRow[]): StartupTurn {
	const metrics = emptyMetrics();
	const scopeId = rows.find((row) => row.scopeId !== undefined)?.scopeId ?? "unknown";
	const agentId = rows.find((row) => row.agentId !== undefined)?.agentId;
	const instanceId = rows.find((row) => row.instanceId !== undefined)?.instanceId;
	const runId = rows.find((row) => row.runId !== undefined)?.runId;
	const populationHint = rows.find((row) => row.population !== undefined)?.population;
	const population: StartupTurn["population"] = populationHint ?? "legacy-unknown";

	const operations = collectTerminalOperations(rows);

	// Turn-level metric semantics: the sum of every measured terminal duration of
	// that action within the turn. Repeated spans (retry after error, re-acquire)
	// each contribute; the metric stays unavailable until at least one measures.
	const durationsByAction = new Map<string, number[]>();
	for (const operation of operations) {
		if (!DURATION_ACTION_TO_METRIC.has(operation.action)) continue;
		if (operation.duration.kind !== "measured") continue;
		const bucket = durationsByAction.get(operation.action);
		if (bucket) bucket.push(operation.duration.milliseconds);
		else durationsByAction.set(operation.action, [operation.duration.milliseconds]);
	}
	for (const [action, values] of durationsByAction) {
		const metric = DURATION_ACTION_TO_METRIC.get(action);
		if (metric) metrics[metric] = measured(values.reduce((total, value) => total + value, 0));
	}

	const attempts: AcquisitionAttempt[] = operations
		.filter((operation) => ATTEMPT_ACTIONS.has(operation.action))
		.map((operation) => ({
			kind: operation.action === "agent_create" ? ("create" as const) : ("resume" as const),
			duration: operation.duration,
			outcome: operation.outcome,
		}));

	const attribution = operations
		.filter((operation) => operation.duration.kind === "measured")
		.map((operation) => ({
			phase: operation.action,
			milliseconds: (operation.duration as { kind: "measured"; milliseconds: number }).milliseconds,
			coverage: "inclusive" as const,
		}));

	const hasLifecycle = attempts.length > 0;
	const hasSend = metrics.agent_send.kind === "measured";
	const hasFirstText = metrics.request_to_first_text.kind === "measured";
	const quality: StartupTurn["quality"] = hasLifecycle && hasSend && hasFirstText ? "complete" : "partial";

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

function median(values: readonly number[]): number {
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
	const breaches: StartupMetric[] = [];
	let comparedSamples = Number.POSITIVE_INFINITY;
	for (const limit of comparison.limits) {
		// Gate and median share the same measured-value arrays: the gate counts
		// samples that actually enter each median, never raw cohort turn counts.
		const candidateValues = measuredValues(candidate, limit.metric);
		const baselineValues = measuredValues(baseline, limit.metric);
		if (candidateValues.length < comparison.minimumSamples || baselineValues.length < comparison.minimumSamples) {
			return {
				kind: "insufficient",
				reasons: [
					`metric_samples:${limit.metric}:candidate=${candidateValues.length}`,
					`metric_samples:${limit.metric}:baseline=${baselineValues.length}`,
					`minimumSamples=${comparison.minimumSamples}`,
				],
			};
		}
		comparedSamples = Math.min(comparedSamples, candidateValues.length, baselineValues.length);
		if (median(candidateValues) - median(baselineValues) > limit.maxMedianIncreaseMs) {
			breaches.push(limit.metric);
		}
	}
	if (breaches.length > 0) return { kind: "regression", breaches };
	return { kind: "pass", comparedSamples: comparedSamples === Number.POSITIVE_INFINITY ? 0 : comparedSamples };
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
