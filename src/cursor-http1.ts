import type { CursorSdkModule } from "./cursor-sdk-runtime.js";
import type { CursorResolvedSetting } from "./cursor-config.js";
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
let configuredCursor: CursorHttp1Sdk["Cursor"] | undefined;

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
	if (configuredCursor === undefined) return;
	configuredCursor.configure({ local: { useHttp1ForAgent: null } });
	configuredCursor = undefined;
}

/** Resolve the effective per-agent HTTP/1.1 value a create/resume captures: only non-builtin settings configure the SDK global. */
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
		configuredCursor = sdk.Cursor;
		return useHttp1ForAgent;
	}
	if (configuredCursor === sdk.Cursor) clearCursorSdkHttp1();
	else configuredCursor = undefined;
	return undefined;
}

// The SDK's HTTP/1.1 preference is global state the transport reads lazily at creation,
// so one acquire's configure and another's capture must never interleave. This promise
// chain is the single structural serializer for that window; nothing here may await it.
// Tradeoff: a hung create/resume inside a critical section blocks every scope's next
// creation until it settles. Lifecycle resets take the same lock so they can never flip
// a mid-flight capture.
let cursorSdkHttp1LockTail: Promise<unknown> = Promise.resolve();

/** Serialize a critical section that spans Cursor HTTP/1.1 configure and the SDK transport capture (Agent.create/resume). */
export function runWithCursorSdkHttp1Lock<T>(fn: () => Promise<T>): Promise<T> {
	const run = cursorSdkHttp1LockTail.then(fn, fn);
	cursorSdkHttp1LockTail = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/** Lifecycle reset path: clear extension-owned SDK transport config without racing an in-flight capture. */
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
		configuredCursor = undefined;
		cursorSdkHttp1LockTail = Promise.resolve();
	},
};
