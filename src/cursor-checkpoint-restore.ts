import type { LocalAgentStore } from "@cursor/sdk";
import type { Context } from "@earendil-works/pi-ai";
import { appendCursorAction } from "./cursor-actions-log.js";
import {
	canRewindCursorCheckpointSource,
	copyCursorCheckpointPoint,
	deleteCursorCheckpointTarget,
	findCursorCheckpointPoint,
	markCursorCheckpointPointUnavailable,
	recordCursorCheckpointRewind,
	rewindCursorCheckpointSource,
	type CursorCheckpointLedgerPoint,
} from "./cursor-checkpoint-ledger.js";
import { parseEnvBoolean } from "./cursor-env-boolean.js";
import {
	acquireSessionCursorAgent,
	willSessionCursorAgentAcquireCreate,
	type SessionCursorAgentLease,
	type SessionCursorAgentSendState,
} from "./cursor-session-agent.js";
import { getCursorSessionFile } from "./cursor-session-scope.js";
import { getCursorSessionStoreIdentities, openCursorSessionStore, releaseRetainedCursorSessionStore } from "./cursor-session-store.js";

type SessionCursorAgentAcquireParams = Parameters<typeof acquireSessionCursorAgent>[0];

export function isCursorCheckpointRestoreEnabled(): boolean {
	return parseEnvBoolean(process.env.PI_CURSOR_CHECKPOINT_RESTORE, true);
}

/**
 * Restore `point` and resume it. Prefer rewinding the point's own source agent, because Cursor's
 * backend cache follows agentId continuity and a copy starts cold. When the source is busy or
 * lacks the head blob, copy the point into a new agent instead. On any rewind, copy, resume, or
 * store failure, mark the point unavailable, delete an unused copy target, and create a new agent.
 * `beforeAcquire` runs once before the source row changes (rewind) or after the copy attempt, so
 * callers can release the pooled agent and the copy store; `true` asks to keep the store.
 */
export async function acquireCursorAgentFromCheckpoint(
	acquireParams: SessionCursorAgentAcquireParams,
	scopeKey: string,
	point: CursorCheckpointLedgerPoint,
	store: LocalAgentStore,
	sendState: SessionCursorAgentSendState,
	beforeAcquire: (keepStore: boolean) => Promise<void>,
): Promise<SessionCursorAgentLease> {
	if (await canRewindCursorCheckpointSource(store, point).catch(() => false)) {
		await beforeAcquire(true);
		try {
			recordCursorCheckpointRewind(point.sourceAgentId);
			await rewindCursorCheckpointSource(acquireParams.cwd, point);
		} catch {
			markCursorCheckpointPointUnavailable(scopeKey, point.contextFingerprint);
			await releaseRetainedCursorSessionStore(scopeKey);
			return createAfterRestoreFailure(acquireParams, scopeKey);
		}
		appendCursorAction({ action: "checkpoint_restore", phase: "decision", scopeKey, agentId: point.sourceAgentId, reason: "rewind" });
		return resumeRestoredAgent(acquireParams, scopeKey, point, sendState, point.sourceAgentId, async () => undefined);
	}
	let targetAgentId: string | undefined;
	try {
		targetAgentId = await copyCursorCheckpointPoint(store, point);
	} catch {
		markCursorCheckpointPointUnavailable(scopeKey, point.contextFingerprint);
	}
	await beforeAcquire(targetAgentId !== undefined);
	if (!targetAgentId) return acquireSessionCursorAgent({ ...acquireParams, forceCreate: true });
	const copyTargetId = targetAgentId;
	appendCursorAction({ action: "checkpoint_restore", phase: "decision", scopeKey, agentId: copyTargetId, reason: "copy" });
	return resumeRestoredAgent(acquireParams, scopeKey, point, sendState, copyTargetId, async () => {
		try {
			await deleteCursorCheckpointTarget(acquireParams.cwd, { agentId: copyTargetId, storeIdentity: point.storeIdentity });
		} catch {
			appendCursorAction({ action: "checkpoint_restore_cleanup", phase: "error", scopeKey, agentId: copyTargetId, reason: "target_delete_failed" });
		}
	});
}

async function resumeRestoredAgent(
	acquireParams: SessionCursorAgentAcquireParams,
	scopeKey: string,
	point: CursorCheckpointLedgerPoint,
	sendState: SessionCursorAgentSendState,
	agentId: string,
	cleanupOnFailure: () => Promise<void>,
): Promise<SessionCursorAgentLease> {
	try {
		return await acquireSessionCursorAgent({
			...acquireParams,
			forceCreate: false,
			resumeAgentId: agentId,
			resumeStoreIdentity: point.storeIdentity,
			checkpointSendState: { ...sendState, contextFingerprint: point.contextFingerprint, bootstrapped: true },
		});
	} catch {
		markCursorCheckpointPointUnavailable(scopeKey, point.contextFingerprint);
		await releaseRetainedCursorSessionStore(scopeKey);
		await cleanupOnFailure();
		return createAfterRestoreFailure(acquireParams, scopeKey);
	}
}

async function createAfterRestoreFailure(acquireParams: SessionCursorAgentAcquireParams, scopeKey: string): Promise<SessionCursorAgentLease> {
	const lease = await acquireSessionCursorAgent({ ...acquireParams, forceCreate: true });
	appendCursorAction({ action: "agent_resume_policy", phase: "error", scopeKey, reason: "checkpoint_restore_fallback", resumed: false });
	return lease;
}

/**
 * After pi `/tree` or a process restart the pool is empty, so the send plan would be `initial`.
 * For a persisted session, restore the matching checkpoint before any agent is created. This reuses
 * persisted agent state across an agent lifecycle boundary, so it requires local resume: a local
 * resume opt-out means a new agent bootstraps from the pi transcript. A matching local resume handle
 * of a never-rewound agent wins: it resumes the same agent as recorded. Only the scope's own derived
 * session store is opened; ledger store identities are never trusted as paths.
 */
export async function acquireEmptyPoolCursorAgentFromCheckpoint(
	acquireParams: SessionCursorAgentAcquireParams,
	scopeKey: string,
	context: Context,
): Promise<SessionCursorAgentLease | undefined> {
	if (!isCursorCheckpointRestoreEnabled() || acquireParams.localResume !== true || getCursorSessionFile() === undefined) return undefined;
	if (!willSessionCursorAgentAcquireCreate(scopeKey, acquireParams)) return undefined;
	const { sessionStore } = await getCursorSessionStoreIdentities(acquireParams.cwd, scopeKey, true);
	const point = findCursorCheckpointPoint(scopeKey, context, sessionStore);
	if (!point) return undefined;
	const copyStore = await openCursorSessionStore(acquireParams.cwd, point.storeIdentity);
	return acquireCursorAgentFromCheckpoint(
		acquireParams,
		scopeKey,
		point,
		copyStore.store,
		{ bootstrapped: true, contextFingerprint: point.contextFingerprint, incrementalSendCount: 0 },
		() => copyStore.dispose().catch(() => undefined),
	);
}
