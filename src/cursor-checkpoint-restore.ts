import type { LocalAgentStore } from "@cursor/sdk";
import type { Context } from "@earendil-works/pi-ai";
import { appendCursorAction } from "./cursor-actions-log.js";
import {
	copyCursorCheckpointPoint,
	deleteCursorCheckpointTarget,
	findCursorCheckpointPoint,
	markCursorCheckpointPointUnavailable,
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
 * Copy `point` into a new agent and resume it. On any copy, resume, or store failure, mark the
 * point unavailable, delete the unused copy target, and create a new agent instead.
 * `beforeAcquire` runs once after the copy attempt so callers can release the copy store.
 */
export async function acquireCursorAgentFromCheckpoint(
	acquireParams: SessionCursorAgentAcquireParams,
	scopeKey: string,
	point: CursorCheckpointLedgerPoint,
	store: LocalAgentStore,
	sendState: SessionCursorAgentSendState,
	beforeAcquire: (copied: boolean) => Promise<void>,
): Promise<SessionCursorAgentLease> {
	let targetAgentId: string | undefined;
	try {
		targetAgentId = await copyCursorCheckpointPoint(store, point);
	} catch {
		markCursorCheckpointPointUnavailable(scopeKey, point.contextFingerprint);
	}
	await beforeAcquire(targetAgentId !== undefined);
	if (!targetAgentId) return acquireSessionCursorAgent({ ...acquireParams, forceCreate: true });
	try {
		return await acquireSessionCursorAgent({
			...acquireParams,
			forceCreate: false,
			resumeAgentId: targetAgentId,
			resumeStoreIdentity: point.storeIdentity,
			checkpointSendState: { ...sendState, contextFingerprint: point.contextFingerprint, bootstrapped: true },
		});
	} catch {
		markCursorCheckpointPointUnavailable(scopeKey, point.contextFingerprint);
		await releaseRetainedCursorSessionStore(scopeKey);
		try {
			await deleteCursorCheckpointTarget(acquireParams.cwd, { agentId: targetAgentId, storeIdentity: point.storeIdentity });
		} catch {
			appendCursorAction({ action: "checkpoint_restore_cleanup", phase: "error", scopeKey, agentId: targetAgentId, reason: "target_delete_failed" });
		}
		const lease = await acquireSessionCursorAgent({ ...acquireParams, forceCreate: true });
		appendCursorAction({ action: "agent_resume_policy", phase: "error", scopeKey, reason: "checkpoint_restore_fallback", resumed: false });
		return lease;
	}
}

/**
 * After pi `/tree` or a process restart the pool is empty, so the send plan would be `initial`.
 * For a persisted session, restore the matching checkpoint before any agent is created. This reuses
 * persisted agent state across an agent lifecycle boundary, so it requires local resume: a local
 * resume opt-out means a new agent bootstraps from the pi transcript. A matching local resume handle
 * wins: it resumes the same agent without a copy. Only the scope's own derived session store is
 * opened; ledger store identities are never trusted as paths.
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
