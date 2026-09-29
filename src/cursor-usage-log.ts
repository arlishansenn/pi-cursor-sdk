import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { parseOptionalEnvBoolean } from "./cursor-env-boolean.js";

/**
 * One JSONL line per applied SDK turn usage. Numbers and identifiers only — never
 * prompt text, tool args, or keys — so it stays safe to keep always-on.
 *
 * CURSOR_SDK_USAGE_LOG: unset → default path; a path → that file; "0"/"false"/"off" → disabled.
 */
export const CURSOR_SDK_USAGE_LOG_ENV = "CURSOR_SDK_USAGE_LOG";

const DEFAULT_CURSOR_USAGE_LOG_PATH = resolve(homedir(), ".pi/agent/data/pi-cursor-sdk/usage.jsonl");

export type CursorUsageLogSource = "billed" | "turn" | "estimate";

/** Correlates a usage line with the action-log send that produced it. Keys match the actions log. */
export interface CursorUsageLogCorrelation {
	turnId?: string;
	runId?: string;
	mode?: "bootstrap" | "incremental";
}

export interface CursorUsageLogRecord extends CursorUsageLogCorrelation {
	ts: string;
	session?: string;
	model: string;
	provider: string;
	runtime: string;
	source: CursorUsageLogSource;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
}

let ensuredLogDirs = new Set<string>();

function resolveCursorUsageLogPath(env: Record<string, string | undefined>): string | undefined {
	const raw = env[CURSOR_SDK_USAGE_LOG_ENV]?.trim();
	if (!raw) return DEFAULT_CURSOR_USAGE_LOG_PATH;
	if (parseOptionalEnvBoolean(raw) === false) return undefined;
	return resolve(raw);
}

export function appendCursorUsageLog(
	record: CursorUsageLogRecord,
	env: Record<string, string | undefined> = process.env,
): void {
	try {
		const path = resolveCursorUsageLogPath(env);
		if (!path) return;
		const dir = dirname(path);
		if (!ensuredLogDirs.has(dir)) {
			mkdirSync(dir, { recursive: true });
			ensuredLogDirs.add(dir);
		}
		appendFileSync(path, `${JSON.stringify(record)}\n`);
	} catch {
		// Usage logging must never affect provider execution.
	}
}

export const __testUtils = {
	resetCursorUsageLogState(): void {
		ensuredLogDirs = new Set();
	},
};
