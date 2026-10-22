import type {
	ExtensionHandler,
	SessionBeforeTreeEvent,
	SessionCompactEvent,
	SessionShutdownEvent,
	SessionTreeEvent,
} from "@earendil-works/pi-coding-agent";
import { appendCursorAction } from "./cursor-actions-log.js";
import { clearCursorSdkHttp1UnderLock, drainRetiredCursorCreations, reportCursorHttpCleanupFailure } from "./cursor-http1.js";
import { onCursorSessionScopeKeyChange } from "./cursor-session-scope.js";
import {
	disposeSessionCursorAgent,
	invalidateSessionAgent,
	resetSessionCursorAgent,
} from "./cursor-session-agent.js";

export interface CursorSessionAgentLifecycleExtensionApi {
	on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
	on(event: "session_compact", handler: ExtensionHandler<SessionCompactEvent>): void;
	on(event: "session_before_tree", handler: ExtensionHandler<SessionBeforeTreeEvent>): void;
	on(event: "session_tree", handler: ExtensionHandler<SessionTreeEvent>): void;
	on(event: "model_select", handler: () => Promise<void> | void): void;
}

// pi awaits session_shutdown handlers with no timeout, and @cursor/sdk local agent
// disposal alone can block for its 2000ms telemetry-flush deadline plus pending
// attribution waits. Quitting is user-perceived exit latency, so bound the whole
// terminal cleanup instead of waiting out the SDK's slowest paths. Healthy-network
// disposal measures ~124ms (PR #53 live A/B; today's long-session repro ~360ms total
// quit), so 250ms covers the healthy path with headroom while cutting the slow tail
// from a full second to a quarter.
const terminalQuitShutdownTimeoutMs = 250;

export function registerCursorSessionAgentLifecycle(pi: CursorSessionAgentLifecycleExtensionApi): void {
	onCursorSessionScopeKeyChange(async (previousScopeKey) => {
		await disposeSessionCursorAgent(previousScopeKey);
	});
	pi.on("session_shutdown", async (event) => {
		const runShutdownCleanup = async () => {
			try {
				if (event.reason === "reload") {
					await resetSessionCursorAgent();
					return;
				}
				await disposeSessionCursorAgent();
			} finally {
				if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
					void clearCursorSdkHttp1UnderLock().catch(reportCursorHttpCleanupFailure);
				} else {
					await drainRetiredCursorCreations();
					await clearCursorSdkHttp1UnderLock();
				}
			}
		};
		if (event.reason !== "quit") {
			await runShutdownCleanup();
			return;
		}
		// The raced-away cleanup keeps running until process exit; swallow its rejection
		// so a late failure can never surface as an unhandled rejection during shutdown.
		const cleanup = runShutdownCleanup().catch(() => undefined);
		let deadlineExceeded = false;
		await Promise.race([
			cleanup,
			new Promise<void>((resolve) => {
				setTimeout(resolve, terminalQuitShutdownTimeoutMs).unref?.();
			}).then(() => {
				deadlineExceeded = true;
			}),
		]);
		if (deadlineExceeded) {
			appendCursorAction({ action: "agent_dispose", phase: "decision", reason: "quit_deadline_exceeded" });
		}
	});
	pi.on("session_compact", () => {
		invalidateSessionAgent();
	});
	pi.on("session_before_tree", () => {
		invalidateSessionAgent();
	});
	pi.on("session_tree", async () => {
		await resetSessionCursorAgent();
	});
	pi.on("model_select", () => {
		invalidateSessionAgent();
	});
}
