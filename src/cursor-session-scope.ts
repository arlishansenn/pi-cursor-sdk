import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import { parseArgs } from "@earendil-works/pi-coding-agent";
import type {
	ExtensionHandler,
	ProjectTrustHandler,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
	SessionCompactFailedEvent,
	SessionInfoChangedEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { truncateCursorDisplayLine } from "./cursor-display-text.js";

interface CursorSessionScopeExtensionApi {
	on(event: "project_trust", handler: ProjectTrustHandler): void;
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
	on(event: "session_info_changed", handler: ExtensionHandler<SessionInfoChangedEvent>): void;
	on(event: "session_before_compact", handler: ExtensionHandler<SessionBeforeCompactEvent>): void;
	on(event: "session_compact", handler: ExtensionHandler<SessionCompactEvent>): void;
	on(event: "session_compact_failed", handler: ExtensionHandler<SessionCompactFailedEvent>): void;
}

const ANONYMOUS_SESSION_SCOPE_KEY = "__anonymous__";
const EPHEMERAL_SESSION_SCOPE_PREFIX = "__ephemeral__:";
const REQUEST_SESSION_SCOPE_PREFIX = "__request__:";
export const MAX_CURSOR_SESSION_NAME_LENGTH = 100;

type CursorSessionScopeChangeHandler = (previousScopeKey: string) => Promise<void> | void;

const state = {
	sessionCwd: process.cwd(),
	sessionFile: undefined as string | undefined,
	sessionId: undefined as string | undefined,
	sessionName: undefined as string | undefined,
	projectTrusted: false,
	sessionGeneration: 0,
};

const requestSession = new AsyncLocalStorage<string | undefined>();

const scopeGenerations = new Map<string, number>([[ANONYMOUS_SESSION_SCOPE_KEY, state.sessionGeneration]]);
const projectTrustResolutionCwds = new Set<string>();
let nextSessionGeneration = 1;
let scopeChangeHandler: CursorSessionScopeChangeHandler | undefined;

// Pi compaction summarization requests carry a fresh random session id by design
// (pi core fills `sessionId: options.sessionId ?? uuidv7()`); the window set by
// session_before_compact lets identity validation route them instead of rejecting them.
let summarizationWindowActive = false;
const requestIsolation = new AsyncLocalStorage<boolean>();

export function isCursorSummarizationWindow(): boolean {
	return summarizationWindowActive;
}

export function beginCursorSummarizationWindow(): void {
	summarizationWindowActive = true;
}

export function endCursorSummarizationWindow(): void {
	summarizationWindowActive = false;
}

/**
 * Pi session file when known; used to scope reused Cursor SDK agents to one pi session.
 */
export function getCursorSessionFile(): string | undefined {
	return state.sessionFile;
}

/**
 * Stable scope key for session-agent pooling. Falls back to a process-local anonymous key
 * before the first session_start (tests and early startup).
 */
export function getCursorSessionId(): string | undefined {
	return state.sessionId;
}

function lifecycleScopeKey(): string {
	if (state.sessionFile) return state.sessionFile;
	if (state.sessionId) return `${EPHEMERAL_SESSION_SCOPE_PREFIX}${state.sessionId}`;
	return ANONYMOUS_SESSION_SCOPE_KEY;
}

export function getCursorSessionScopeKey(): string {
	if (requestIsolation.getStore() === true) {
		const isolated = requestSession.getStore();
		if (isolated) return `${REQUEST_SESSION_SCOPE_PREFIX}${isolated}`;
	}
	const lifecycleKey = lifecycleScopeKey();
	if (lifecycleKey !== ANONYMOUS_SESSION_SCOPE_KEY) return lifecycleKey;
	const requestSessionId = requestSession.getStore();
	if (requestSessionId) return `${REQUEST_SESSION_SCOPE_PREFIX}${requestSessionId}`;
	return ANONYMOUS_SESSION_SCOPE_KEY;
}

export class CursorSessionIdentityConflictError extends Error {
	constructor() {
		super("Cursor request session id does not match the pi session id");
		this.name = "CursorSessionIdentityConflictError";
	}
}

/**
 * Run one provider call with its request session id. Lifecycle scope wins.
 * A request id only isolates calls that have no lifecycle session file or id.
 */
export function runWithCursorRequestSession<T>(sessionId: string | undefined, operation: () => T): T {
	if (sessionId && !scopeGenerations.has(`${REQUEST_SESSION_SCOPE_PREFIX}${sessionId}`)) {
		scopeGenerations.set(`${REQUEST_SESSION_SCOPE_PREFIX}${sessionId}`, nextSessionGeneration++);
	}
	return requestSession.run(sessionId, operation);
}

/**
 * Force request-only scope for one provider call even when a lifecycle session exists.
 * Used for pi compaction summarization, whose stream options carry a distinct id by design.
 */
export function runWithCursorRequestIsolation<T>(sessionId: string, operation: () => T): T {
	return requestIsolation.run(true, () => requestSession.run(sessionId, operation));
}

export function assertCursorRequestScope(scopeKey: string, generation: number): void {
	if (getCursorSessionScopeKey() !== scopeKey || getCursorSessionScopeGeneration(scopeKey) !== generation) {
		throw new CursorSessionIdentityConflictError();
	}
}

export function getCursorSessionScopeGeneration(scopeKey: string = getCursorSessionScopeKey()): number {
	return scopeGenerations.get(scopeKey) ?? 0;
}

/**
 * Pi session cwd when known; falls back to process.cwd() before session_start.
 * Updated on session_start only until pi threads cwd into streamSimple—mid-session cwd
 * changes without a new session_start event are not reflected here.
 */
export function getCursorSessionCwd(): string {
	return state.sessionCwd;
}

export function getCursorSessionProjectTrusted(): boolean {
	return state.projectTrusted;
}

export function getCursorSessionName(): string | undefined {
	return state.sessionName;
}

function normalizeCursorSessionName(name: string | undefined): string | undefined {
	if (name === undefined) return undefined;
	return truncateCursorDisplayLine(name, MAX_CURSOR_SESSION_NAME_LENGTH) || undefined;
}

function setCursorSessionScope(
	cwd: string,
	sessionFile: string | undefined,
	sessionId?: string,
	projectTrusted = false,
	sessionName?: string,
): void {
	state.sessionCwd = cwd;
	state.sessionFile = sessionFile;
	state.sessionId = sessionId;
	state.sessionName = normalizeCursorSessionName(sessionName);
	state.projectTrusted = projectTrusted;
	summarizationWindowActive = false;
	state.sessionGeneration = nextSessionGeneration;
	nextSessionGeneration += 1;
	scopeGenerations.set(getCursorSessionScopeKey(), state.sessionGeneration);
}

function recordProjectTrustResolution(cwd: string): void {
	projectTrustResolutionCwds.add(resolve(cwd));
}

function isCliProjectTrustApproved(args = process.argv.slice(2)): boolean {
	return parseArgs(args).projectTrustOverride === true;
}

function resetCursorSessionScope(): void {
	state.sessionCwd = process.cwd();
	state.sessionFile = undefined;
	state.sessionId = undefined;
	state.sessionName = undefined;
	state.projectTrusted = false;
	state.sessionGeneration = 0;
	summarizationWindowActive = false;
	nextSessionGeneration = 1;
	scopeGenerations.clear();
	scopeGenerations.set(ANONYMOUS_SESSION_SCOPE_KEY, state.sessionGeneration);
	requestSession.exit(() => undefined);
	projectTrustResolutionCwds.clear();
}

export function onCursorSessionScopeKeyChange(handler: CursorSessionScopeChangeHandler): void {
	scopeChangeHandler = handler;
}

export function registerCursorSessionScope(pi: CursorSessionScopeExtensionApi): void {
	pi.on("project_trust", (event) => {
		recordProjectTrustResolution(event.cwd);
		return { trusted: "undecided" };
	});
	pi.on("session_start", async (_event, ctx) => {
		const previousScopeKey = getCursorSessionScopeKey();
		setCursorSessionScope(
			ctx.cwd,
			ctx.sessionManager?.getSessionFile?.() ?? undefined,
			ctx.sessionManager?.getSessionId?.() ?? undefined,
			ctx.isProjectTrusted?.() === true
				&& (projectTrustResolutionCwds.has(resolve(ctx.cwd)) || isCliProjectTrustApproved()),
			ctx.sessionManager?.getSessionName?.() ?? undefined,
		);
		if (previousScopeKey !== getCursorSessionScopeKey()) {
			await scopeChangeHandler?.(previousScopeKey);
		}
	});
	pi.on("session_info_changed", (event) => {
		state.sessionName = normalizeCursorSessionName(event.name);
	});
	pi.on("session_before_compact", () => {
		beginCursorSummarizationWindow();
	});
	pi.on("session_compact", () => {
		endCursorSummarizationWindow();
	});
	pi.on("session_compact_failed", () => {
		endCursorSummarizationWindow();
	});
}

export const __testUtils = {
	ANONYMOUS_SESSION_SCOPE_KEY,
	EPHEMERAL_SESSION_SCOPE_PREFIX,
	REQUEST_SESSION_SCOPE_PREFIX,
	set: setCursorSessionScope,
	recordProjectTrustResolution,
	isCliProjectTrustApproved,
	reset: resetCursorSessionScope,
	beginSummarizationWindow: beginCursorSummarizationWindow,
	endSummarizationWindow: endCursorSummarizationWindow,
	isSummarizationWindow: isCursorSummarizationWindow,
};
