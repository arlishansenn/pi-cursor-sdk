import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { LocalAgentStore } from "@cursor/sdk";
import type { Context } from "@earendil-works/pi-ai";
import { shouldBootstrapCursorContext } from "./context.js";
import { randomUUID } from "node:crypto";
import { isCursorLocalAgentId } from "./cursor-session-agent-resume.js";
import { openCursorSessionStore, type CursorSessionStoreIdentity } from "./cursor-session-store.js";
import { asRecord } from "./cursor-record-utils.js";
import { getCursorSessionScopeKey } from "./cursor-session-scope.js";

export const CURSOR_CHECKPOINT_LEDGER_ENTRY_TYPE = "cursor-sdk-checkpoint-ledger";
export const CURSOR_CHECKPOINT_REWIND_ENTRY_TYPE = "cursor-sdk-checkpoint-rewind";

export interface CursorCheckpointLedgerPoint {
	version: 1;
	scopeKey: string;
	contextFingerprint: string;
	messageCount: number;
	sourceAgentId: string;
	blobIds: string[];
	headBlobId: string;
	storeIdentity: CursorSessionStoreIdentity;
	createdAt: string;
	unavailable?: boolean;
}

interface LedgerState {
	appendEntry?: ExtensionAPI["appendEntry"];
	points: CursorCheckpointLedgerPoint[];
	rewoundAgentIds: Set<string>;
}

const state: LedgerState = { points: [], rewoundAgentIds: new Set() };

function sameStore(left: CursorSessionStoreIdentity, right: CursorSessionStoreIdentity): boolean {
	return left.version === right.version && left.stateRoot === right.stateRoot;
}

export function parseCursorCheckpointLedgerPoint(value: unknown): CursorCheckpointLedgerPoint | undefined {
	const record = asRecord(value);
	if (!record || record.version !== 1) return undefined;
	if (typeof record.scopeKey !== "string" || typeof record.contextFingerprint !== "string") return undefined;
	if (typeof record.messageCount !== "number" || !isCursorLocalAgentId(record.sourceAgentId)) return undefined;
	if (typeof record.headBlobId !== "string" || typeof record.createdAt !== "string") return undefined;
	if (!Array.isArray(record.blobIds) || record.blobIds.some((blobId) => typeof blobId !== "string")) return undefined;
	const store = asRecord(record.storeIdentity);
	if (store?.version !== 1 || typeof store.stateRoot !== "string" || !store.stateRoot) return undefined;
	return {
		version: 1,
		scopeKey: record.scopeKey,
		contextFingerprint: record.contextFingerprint,
		messageCount: record.messageCount,
		sourceAgentId: record.sourceAgentId,
		blobIds: record.blobIds.filter((blobId): blobId is string => typeof blobId === "string"),
		headBlobId: record.headBlobId,
		storeIdentity: { version: 1, stateRoot: store.stateRoot },
		createdAt: record.createdAt,
		...(record.unavailable === true ? { unavailable: true } : {}),
	};
}

function remember(point: CursorCheckpointLedgerPoint): void {
	const index = state.points.findIndex((candidate) => candidate.scopeKey === point.scopeKey && candidate.contextFingerprint === point.contextFingerprint);
	if (index >= 0) state.points[index] = point;
	else state.points.push(point);
}

export function recordCursorCheckpointPoint(input: Omit<CursorCheckpointLedgerPoint, "version" | "createdAt">): void {
	const point: CursorCheckpointLedgerPoint = { ...input, version: 1, createdAt: new Date().toISOString() };
	remember(point);
	try {
		state.appendEntry?.<CursorCheckpointLedgerPoint>(CURSOR_CHECKPOINT_LEDGER_ENTRY_TYPE, point);
	} catch {
		// Ledger persistence is an optimization. The in-memory point still covers this process.
	}
}

/**
 * Usable point that `context` extends the way an incremental send would. A point's
 * fingerprint is the context it sent; its checkpoint also holds the reply to that context.
 */
export function findCursorCheckpointPoint(scopeKey: string, context: Context, storeIdentity: CursorSessionStoreIdentity): CursorCheckpointLedgerPoint | undefined {
	return state.points.find((point) => point.scopeKey === scopeKey && !point.unavailable && sameStore(point.storeIdentity, storeIdentity)
		&& !shouldBootstrapCursorContext({ bootstrapped: true, contextFingerprint: point.contextFingerprint }, context));
}

/**
 * True for any loaded ledger point belonging to this scope, including unavailable points.
 * Existence only: callers must not use this to infer a specific point, store, or context.
 */
export function hasCursorCheckpointHistory(scopeKey: string): boolean {
	return state.points.some((point) => point.scopeKey === scopeKey);
}

export function markCursorCheckpointPointUnavailable(scopeKey: string, contextFingerprint: string): void {
	const point = state.points.find((candidate) => candidate.scopeKey === scopeKey && candidate.contextFingerprint === contextFingerprint);
	if (!point) return;
	const unavailable = { ...point, unavailable: true };
	remember(unavailable);
	try {
		state.appendEntry?.<CursorCheckpointLedgerPoint>(CURSOR_CHECKPOINT_LEDGER_ENTRY_TYPE, unavailable);
	} catch {
		// The in-memory mark still prevents another attempt in this process.
	}
}

export async function copyCursorCheckpointPoint(store: LocalAgentStore, point: CursorCheckpointLedgerPoint): Promise<string> {
	const targetAgentId = `agent-${randomUUID()}`;
	const now = Date.now();
	const source = await store.agents.get({ agentId: point.sourceAgentId });
	if (source?.activeRunId) throw new Error("Cursor checkpoint source has an active run");
	await store.agents.create({
		agent: { agentId: targetAgentId, cwd: source?.cwd ?? "", status: "idle", createdAt: now, updatedAt: now, latestCheckpoint: null },
	});
	const copied: string[] = [];
	try {
		for (const blobId of point.blobIds) {
			const data = await store.checkpoints.get({ agentId: point.sourceAgentId, blobId });
			if (!data) throw new Error("Cursor checkpoint blob is missing");
			await store.checkpoints.create({ agentId: targetAgentId, blobId, data });
			copied.push(blobId);
		}
		const created = await store.agents.get({ agentId: targetAgentId });
		if (!created) throw new Error("Cursor checkpoint target agent is missing");
		await store.agents.update({
			agent: { ...created, latestCheckpoint: { schemaVersion: 1, rootBlobId: point.headBlobId }, updatedAt: Date.now() },
		});
		return targetAgentId;
	} catch (error) {
		try {
			await store.checkpoints.delete({ filter: { agentIds: [targetAgentId], blobIds: copied } });
			await store.agents.delete({ filter: { agentIds: [targetAgentId] } });
		} catch (cleanupError) {
			throw new Error("Cursor checkpoint copy cleanup failed", { cause: cleanupError });
		}
		throw error;
	}
}

/**
 * Record that `agentId` is about to be rewound. Its head can then belong to any pi branch, so a
 * persisted resume handle from another branch must not resume it; only a ledger point, which
 * names its head, may. The marker spans all branches of the session.
 */
export function recordCursorCheckpointRewind(agentId: string): void {
	state.rewoundAgentIds.add(agentId);
	try {
		state.appendEntry?.(CURSOR_CHECKPOINT_REWIND_ENTRY_TYPE, { version: 1, agentId });
	} catch {
		// The in-memory mark still covers this process.
	}
}

export function isCursorCheckpointAgentRewound(agentId: string): boolean {
	return state.rewoundAgentIds.has(agentId);
}

/** True when the point's own source agent is idle and still holds the point's head blob. */
export async function canRewindCursorCheckpointSource(store: LocalAgentStore, point: CursorCheckpointLedgerPoint): Promise<boolean> {
	const source = await store.agents.get({ agentId: point.sourceAgentId });
	if (!source || source.activeRunId) return false;
	return (await store.checkpoints.get({ agentId: point.sourceAgentId, blobId: point.headBlobId })) !== null;
}

/** Point the source agent's head back at the point's head. Its blobs, including later branches, stay. */
export async function rewindCursorCheckpointSource(cwd: string, point: CursorCheckpointLedgerPoint): Promise<void> {
	const opened = await openCursorSessionStore(cwd, point.storeIdentity);
	try {
		const source = await opened.store.agents.get({ agentId: point.sourceAgentId });
		if (!source) throw new Error("Cursor checkpoint source agent is missing");
		if (source.activeRunId) throw new Error("Cursor checkpoint source has an active run");
		await opened.store.agents.update({
			agent: { ...source, latestCheckpoint: { schemaVersion: 1, rootBlobId: point.headBlobId }, updatedAt: Date.now() },
		});
	} finally {
		await opened.dispose().catch(() => undefined);
	}
}

/** Delete an unused restore copy target (agent row + checkpoint blobs) from its store. */
export async function deleteCursorCheckpointTarget(
	cwd: string,
	target: { agentId: string; storeIdentity: CursorSessionStoreIdentity },
): Promise<void> {
	const opened = await openCursorSessionStore(cwd, target.storeIdentity);
	try {
		await opened.store.checkpoints.delete({ filter: { agentIds: [target.agentId] } });
		await opened.store.agents.delete({ filter: { agentIds: [target.agentId] } });
	} finally {
		await opened.dispose().catch(() => undefined);
	}
}

function restore(entries: readonly SessionEntry[]): void {
	state.points = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== CURSOR_CHECKPOINT_LEDGER_ENTRY_TYPE) continue;
		const point = parseCursorCheckpointLedgerPoint(entry.data);
		if (point) remember(point);
	}
}

function restoreRewoundAgents(allEntries: readonly SessionEntry[]): void {
	state.rewoundAgentIds = new Set();
	for (const entry of allEntries) {
		if (entry.type !== "custom" || entry.customType !== CURSOR_CHECKPOINT_REWIND_ENTRY_TYPE) continue;
		const record = asRecord(entry.data);
		if (record?.version === 1 && isCursorLocalAgentId(record.agentId)) state.rewoundAgentIds.add(record.agentId);
	}
}

export function registerCursorCheckpointLedger(pi: { appendEntry: ExtensionAPI["appendEntry"]; on: ExtensionAPI["on"] }): void {
	state.appendEntry = pi.appendEntry;
	pi.on("session_start", (_event, ctx) => {
		restore(ctx.sessionManager.getEntries());
		restoreRewoundAgents(ctx.sessionManager.getEntries());
	});
	pi.on("session_tree", (_event, ctx) => {
		restore(ctx.sessionManager.getBranch());
		restoreRewoundAgents(ctx.sessionManager.getEntries());
	});
}

export const __testUtils = {
	reset(): void {
		state.appendEntry = undefined;
		state.points = [];
		state.rewoundAgentIds = new Set();
		void getCursorSessionScopeKey();
	},
	points: () => state.points.map((point) => ({ ...point, blobIds: [...point.blobIds] })),
};
