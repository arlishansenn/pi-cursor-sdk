import type { CursorSdkModule } from "./cursor-sdk-runtime.js";
import type { CursorResolvedSetting } from "./cursor-config.js";
import { installCursorSdkSessionProcessErrorGuard } from "./cursor-sdk-process-error-guard.js";
import { asRecord } from "./cursor-record-utils.js";

export const CURSOR_HTTP1_ENTRY_TYPE = "cursor-http1-state";

export interface CursorHttp1EntryData {
	enabled: boolean;
}

type CursorHttp1Sdk = {
	Cursor: Pick<CursorSdkModule["Cursor"], "configure">;
};

let sessionCursorHttp1Enabled: boolean | undefined;
let globalPreferenceAuthoritative = false;

interface CursorHttpCleanupState {
	tail: Promise<unknown>;
	configured: Set<CursorHttp1Sdk["Cursor"]>;
	retired: Set<Promise<void>>;
}

// Pi re-evaluates extensions on cwd changes while native SDK imports retain identity.
const cleanupKey = Symbol.for("pi-cursor-sdk.http-cleanup.v1");
const processState = globalThis as typeof globalThis & { [cleanupKey]?: CursorHttpCleanupState };
const cleanup = processState[cleanupKey] ??= {
	tail: Promise.resolve(),
	configured: new Set(),
	retired: new Set(),
};

export function trackRetiredCursorCreation(creation: Promise<unknown>): void {
	const guard = installCursorSdkSessionProcessErrorGuard();
	const completion = creation.then(() => undefined, () => undefined).finally(() => guard.dispose());
	cleanup.retired.add(completion);
	void completion.then(() => cleanup.retired.delete(completion));
}

export async function drainRetiredCursorCreations(): Promise<void> {
	while (cleanup.retired.size > 0) await Promise.all([...cleanup.retired]);
}

export function reportCursorHttpCleanupFailure(): void {
	console.error("[cursor] Deferred HTTP configuration cleanup failed.");
}

export function isCursorHttp1EntryData(value: unknown): value is CursorHttp1EntryData {
	return typeof asRecord(value)?.enabled === "boolean";
}

export function getStoredCursorHttp1Enabled(): boolean | undefined {
	return sessionCursorHttp1Enabled;
}

export function setStoredCursorHttp1Enabled(enabled: boolean | undefined): void {
	sessionCursorHttp1Enabled = enabled;
}

export function getResolvedSessionCursorHttp1Enabled(): boolean | undefined {
	return globalPreferenceAuthoritative ? undefined : sessionCursorHttp1Enabled;
}

export function setCursorHttp1GlobalPreferenceAuthoritative(authoritative: boolean): void {
	globalPreferenceAuthoritative = authoritative;
}

export function clearCursorSdkHttp1(): void {
	for (const cursor of cleanup.configured) {
		cursor.configure({ local: { useHttp1ForAgent: null } });
		cleanup.configured.delete(cursor);
	}
}

/** Only non-builtin settings configure the SDK global. */
export function resolveCursorSdkHttp1ForAgent(setting: CursorResolvedSetting<boolean>): boolean | undefined {
	return setting.source !== "builtin" ? setting.value : undefined;
}

export function configureCursorSdkHttp1(
	sdk: CursorHttp1Sdk,
	setting: CursorResolvedSetting<boolean>,
): boolean | undefined {
	const useHttp1ForAgent = resolveCursorSdkHttp1ForAgent(setting);
	if (useHttp1ForAgent !== undefined) {
		sdk.Cursor.configure({ local: { useHttp1ForAgent } });
		cleanup.configured.add(sdk.Cursor);
		return useHttp1ForAgent;
	}
	if (cleanup.configured.has(sdk.Cursor)) {
		sdk.Cursor.configure({ local: { useHttp1ForAgent: null } });
		cleanup.configured.delete(sdk.Cursor);
	}
	return undefined;
}

// This orders extension writes and create/resume work, not lazy first-send transport acquisition.
export function runWithCursorSdkHttp1Lock<T>(fn: () => Promise<T>): Promise<T> {
	const run = cleanup.tail.then(fn, fn);
	cleanup.tail = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/** Clear extension-owned SDK configuration after queued creation work. */
export function clearCursorSdkHttp1UnderLock(): Promise<void> {
	return runWithCursorSdkHttp1Lock(() => {
		clearCursorSdkHttp1();
		return Promise.resolve();
	});
}

export const __testUtils = {
	reset(): void {
		sessionCursorHttp1Enabled = undefined;
		globalPreferenceAuthoritative = false;
		cleanup.configured.clear();
		cleanup.retired.clear();
		cleanup.tail = Promise.resolve();
	},
};
