import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseOptionalEnvBoolean } from "./cursor-env-boolean.js";
import { getCursorSessionScopeKey } from "./cursor-session-scope.js";

// Metadata only: never pass SDK options, errors, prompt text, or raw pool keys.
type Action = "agent_create" | "agent_resume" | "agent_resume_policy" | "agent_lease" |
	"agent_invalidate" | "agent_reset" | "agent_dispose" | "agent_warm" | "send_state_commit" |
	"send_plan" | "prompt_build" | "agent_send" | "session_identity" | "checkpoint_restore" | "checkpoint_restore_cleanup" |
	"sdk_load" | "bridge_setup" | "store_open" | "first_text";
interface ActionFields {
	action: Action;
	scopeKey?: string;
	operationId?: string;
	agentId?: string;
	runId?: string;
	instanceId?: number;
	model?: string;
	runtime?: "local" | "cloud";
	mode?: "bootstrap" | "incremental";
	reason?: string;
	resetAgent?: boolean;
	incrementalSendCount?: number;
	promptChars?: number;
	imageCount?: number;
	messageCount?: number;
	created?: boolean;
	resumed?: boolean;
	resumeEligible?: boolean;
	hasResumeHandle?: boolean;
	resumeAttemptAllowed?: boolean;
	resumeFallback?: boolean;
	forceCreate?: boolean;
	requestSessionId?: string;
	lifecycleSessionId?: string;
}
type ActionRecord = ActionFields & { phase: "start" | "success" | "error" | "decision"; durationMs?: number };
type ActionTurnStore = { turnId: string; startedAt: number; firstTextRecorded: boolean };
const actionTurn = new AsyncLocalStorage<ActionTurnStore>();

export function withCursorActionTurn<T>(operation: () => T): T {
	const current = actionTurn.getStore();
	if (current) return operation();
	let store: ActionTurnStore;
	try {
		store = { turnId: randomUUID(), startedAt: performance.now(), firstTextRecorded: false };
	} catch {
		// Observation must never break the provider: run without turn correlation.
		writeFailures++;
		return operation();
	}
	return actionTurn.run(store, operation);
}

/** Record turn-start → first non-empty assistant text once. Never stores text content. */
export function noteCursorActionFirstText(): void {
	try {
		const store = actionTurn.getStore();
		if (!store || store.firstTextRecorded) return;
		store.firstTextRecorded = true;
		appendCursorAction({
			action: "first_text",
			phase: "success",
			durationMs: performance.now() - store.startedAt,
		});
	} catch {
		writeFailures++;
	}
}

/** Turn id of the action-log turn this code runs in, for correlating other logs (e.g. usage). */
export function getCursorActionTurnId(): string | undefined {
	return actionTurn.getStore()?.turnId;
}

const processId = randomUUID();
const defaultPath = join(homedir(), ".pi", "agent", "data", "pi-cursor-sdk", "actions.jsonl");
let tail = Promise.resolve();
let pending = 0;
let seq = 0;
let dropped = 0;
let writeFailures = 0;

export function appendCursorAction(record: ActionRecord): void {
	try {
		if (pending >= 1024) { dropped++; return; }
		const { scopeKey = getCursorSessionScopeKey(), ...fields } = record;
		const line = JSON.stringify({
			...fields, turnId: actionTurn.getStore()?.turnId, schemaVersion: 1, ts: new Date().toISOString(), pid: process.pid, processId, seq: ++seq,
			scopeId: createHash("sha256").update(scopeKey).digest("hex").slice(0, 16),
			dropped, writeFailures,
		}) + "\n";
		pending++;
		// Resolve the destination at write time. A caller can install CURSOR_SDK_ACTIONS_LOG
		// after this function schedules the line, and the line must follow that destination.
		tail = tail.then(async () => {
			const raw = process.env.CURSOR_SDK_ACTIONS_LOG?.trim();
			if (parseOptionalEnvBoolean(raw) === false) return;
			const path = raw ? resolve(raw) : defaultPath;
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			await appendFile(path, line, { mode: 0o600 });
		}).catch(() => { writeFailures++; }).finally(() => { pending--; });
	} catch {
		// Diagnostic failures must not change the provider's result or error.
		writeFailures++;
	}
}

export function traceCursorSyncAction<T>(
	fields: ActionFields,
	operation: () => T,
	resultFields?: (result: T) => Pick<ActionFields, "promptChars" | "imageCount">,
): T {
	const finish = startCursorAction(fields, resultFields);
	try {
		const result = operation();
		finish.success(result);
		return result;
	} catch (error) {
		finish.error();
		throw error;
	}
}

type CursorActionSpan<T> = {
	readonly success: (result: T) => void;
	readonly error: () => void;
};

function startCursorAction<T>(
	fields: ActionFields,
	resultFields?: (result: T) => Pick<ActionFields, "agentId" | "runId" | "promptChars" | "imageCount">,
): CursorActionSpan<T> {
	// Span initialization and finish recording are best-effort: a failure here must
	// not prevent the wrapped operation from running or change its result or error.
	let snapshot: ActionFields & { scopeKey: string; operationId: string };
	let start: number;
	try {
		snapshot = { ...fields, scopeKey: fields.scopeKey ?? getCursorSessionScopeKey(), operationId: randomUUID() };
		start = performance.now();
		appendCursorAction({ ...snapshot, phase: "start" });
	} catch {
		writeFailures++;
		const noopSuccess = (_result: T): void => undefined;
		return { success: noopSuccess, error: () => undefined };
	}
	const recorded = snapshot;
	const beganAt = start;
	return {
		success(result: T) {
			try {
				appendCursorAction({ ...recorded, ...resultFields?.(result), phase: "success", durationMs: performance.now() - beganAt });
			} catch {
				writeFailures++;
			}
		},
		error() {
			try {
				appendCursorAction({ ...recorded, phase: "error", durationMs: performance.now() - beganAt });
			} catch {
				writeFailures++;
			}
		},
	};
}

export async function traceCursorAction<T>(
	fields: ActionFields,
	operation: () => T | PromiseLike<T>,
	resultFields?: (result: T) => Pick<ActionFields, "agentId" | "runId" | "promptChars" | "imageCount">,
): Promise<T> {
	const finish = startCursorAction(fields, resultFields);
	try {
		const result = await operation();
		finish.success(result);
		return result;
	} catch (error) {
		finish.error();
		throw error;
	}
}

export const __testUtils = { flush: () => tail };
