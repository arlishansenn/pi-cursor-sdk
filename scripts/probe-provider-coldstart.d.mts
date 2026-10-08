export declare function buildScenarioChildEnv(
	scenario: {
		label: string;
		settingSources: string;
		turns: number;
		/** Warm arm: schedule same-key agent warmup before the first prompt. */
		warmup?: boolean;
		/** Capture provider debug events under the scenario work dir and copy them to the out dir. */
		debugCapture?: boolean;
	},
	apiKey: string,
	baseEnv?: NodeJS.ProcessEnv,
	nodePath?: string,
): NodeJS.ProcessEnv;

export declare function runScenarioChildProcess(options: {
	command: string;
	args: readonly string[];
	env: NodeJS.ProcessEnv;
	cwd?: string;
	timeoutMs?: number;
	maxOutputBytes?: number;
}): Promise<{
	ok: boolean;
	timedOut: boolean;
	truncated: boolean;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: string | null;
	spawnError?: string;
	/** Present when canonical process-tree cleanup failed; ok is false. */
	cleanupError?: string;
	pid: number | undefined;
}>;

/** Scenario summary JSON a child writes as <out-dir>/<label>.json. */
export interface ProbeScenarioSummary {
	label: string;
	settingSources?: string;
	population?: string;
	model?: string;
	warmup?: boolean;
	warmReady?: boolean | null;
	sendsBeforeFirstTurn?: number;
	promptChars?: number | null;
	turns?: Array<{
		journal?: {
			sendMode?: string | null;
		};
	}>;
}

export interface ProbeWarmupEquivalenceArm {
	label: string | null;
	sendMode: string | null;
	promptChars: number | null;
	sendsBeforeFirstTurn: number | null;
	warmReady: boolean | null;
}

/**
 * Verdict over the cold and warm arms' first provider debug-event turn. Null
 * equality flags mean the evidence to compare was missing, not that it differed.
 */
export interface ProbeWarmupPromptEquivalenceReport {
	compared: boolean;
	missing: Array<{ arm: "cold" | "warm"; file: string }>;
	promptTextEqual: boolean | null;
	sendPayloadEqual: boolean | null;
	imageCountEqual: boolean | null;
	cold: ProbeWarmupEquivalenceArm;
	warm: ProbeWarmupEquivalenceArm;
}

/**
 * Compare the first provider debug-event turn of both paid A/B arms after
 * normalizing each arm's mkdtemp work dir (WORK) and scenario labels (SESSION).
 * Reads <arm>/metadata.json .send plus the sibling send payload, writes
 * <parent-of-coldDir>/equivalence.json, logs one summary line, and returns the
 * report. Missing evidence is reported in the report, never thrown.
 */
export declare function compareWarmupPromptEquivalence(options: {
	coldDir: string;
	warmDir: string;
	coldResult: ProbeScenarioSummary;
	warmResult: ProbeScenarioSummary;
	/** Overrides the temp root the work-dir normalizer matches under; tests inject Windows-style roots. */
	tmpRoot?: string;
}): Promise<ProbeWarmupPromptEquivalenceReport>;

/** Sync a CLI-provided Cursor key into the child process env so warmup admission resolves the same credentials. */
export declare function syncChildApiKeyEnv(apiKey: string, env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;

/** Copy debug artifacts into a fresh destination, scrubbing text files (json/ndjson/txt/md/log) at the boundary. */
export declare function copyDebugEventsScrubbed(source: string, destination: string, secrets: ReadonlyArray<string | undefined>): void;
