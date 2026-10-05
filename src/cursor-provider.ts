import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
	cursorLiveRuns,
	DEFAULT_CURSOR_NATIVE_REPLAY_IDLE_DISPOSE_MS,
	getPendingCursorLiveRun,
	hasTrailingUserMessagesAfterToolResults,
	releaseAllPendingCursorLiveRunsForTests,
	resetCursorNativeReplayIdleDisposeMs,
	setCursorNativeReplayIdleDisposeMs,
} from "./cursor-provider-live-run-drain.js";
import { disposeAllSessionCursorAgents, resetSessionCursorAgent } from "./cursor-session-agent.js";
import { attachCursorSdkEventDebugPiStreamTap, type CursorSdkEventDebugSink } from "./cursor-sdk-event-debug.js";
import { installCursorSdkProcessErrorGuard } from "./cursor-sdk-process-error-guard.js";
import { sanitizeCursorProviderError } from "./cursor-provider-errors.js";
import { resolveCursorApiKey } from "./cursor-api-key.js";
import { CursorProviderTurnRunner } from "./cursor-provider-turn-runner.js";
import { appendCursorAction, withCursorActionTurn } from "./cursor-actions-log.js";
import {
	assertCursorRequestScope,
	endCursorSummarizationWindow,
	getCursorSessionId,
	getCursorSessionScopeGeneration,
	getCursorSessionScopeKey,
	isCursorSummarizationWindow,
	runWithCursorRequestIsolation,
	runWithCursorRequestSession,
} from "./cursor-session-scope.js";
import { runExclusiveCursorSessionTurn, __testUtils as cursorSessionTurnQueueTestUtils } from "./cursor-session-turn-queue.js";

function makeInitialMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

export function streamCursor(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const sdkEventDebugRef: { current?: CursorSdkEventDebugSink } = {};
	attachCursorSdkEventDebugPiStreamTap(stream, sdkEventDebugRef);

	(async () => {
		const partial = makeInitialMessage(model);

		const runner = new CursorProviderTurnRunner({
			model,
			context,
			stream,
			partial,
			options,
			sdkEventDebugRef,
		});

		try {
			stream.push({ type: "start", partial });
			const requestSessionId = options?.sessionId;
			await withCursorActionTurn(async () => {
				const lifecycleSessionId = getCursorSessionId();
				if (requestSessionId && lifecycleSessionId && requestSessionId === lifecycleSessionId) {
					// A normal turn for the active session means any stale summarization window is over.
					endCursorSummarizationWindow();
				}
				const mismatchedRequest = Boolean(requestSessionId && lifecycleSessionId && requestSessionId !== lifecycleSessionId);
				// Mismatched request ids are nested Cursor runs (pi compaction summarization, pi-btw
				// `/btw` child sessions, etc.): isolate on `__request__:` and dispose after the turn.
				const nestedRequest = mismatchedRequest;
				const summarizationRequest = nestedRequest && isCursorSummarizationWindow();
				// Only the call that acquires exclusive turn ownership may reset the nested pool.
				// A queued same-id abort must not clear another in-flight nested turn's agent.
				let nestedOwnedScopeKey: string | undefined;
				const invokeScoped = () => runWithCursorRequestSession(requestSessionId, async () => {
					if (requestSessionId) {
						appendCursorAction({
							action: "session_identity",
							phase: "decision",
							reason: nestedRequest
								? (summarizationRequest ? "summarization_request" : "nested_request")
								: "bound",
							requestSessionId,
							...(lifecycleSessionId ? { lifecycleSessionId } : {}),
						});
					}
					const acceptedScopeKey = getCursorSessionScopeKey();
					const acceptedGeneration = getCursorSessionScopeGeneration(acceptedScopeKey);
					await runExclusiveCursorSessionTurn(
						acceptedScopeKey,
						() => {
							nestedOwnedScopeKey = acceptedScopeKey;
							assertCursorRequestScope(acceptedScopeKey, acceptedGeneration);
							return runner.run(installCursorSdkProcessErrorGuard(), () => {
								assertCursorRequestScope(acceptedScopeKey, acceptedGeneration);
							});
						},
						options?.signal,
					);
				});
				if (nestedRequest) {
					try {
						await runWithCursorRequestIsolation(requestSessionId!, invokeScoped);
					} finally {
						if (nestedOwnedScopeKey) {
							// Drop the one-shot nested agent/store without terminal-closing the request
							// scope, so a reused nested id (pi-btw child session) can acquire again.
							await resetSessionCursorAgent(nestedOwnedScopeKey, "explicit_reset").catch(() => undefined);
						}
					}
				} else {
					await invokeScoped();
				}
			});
		} catch (error) {
			await runner.handleOuterCatch(error);
		}

		stream.end();
	})().catch((error: unknown) => {
		const partial = makeInitialMessage(model);
		partial.stopReason = "error";
		partial.errorMessage = sanitizeCursorProviderError(error, resolveCursorApiKey(options?.apiKey));
		stream.push({ type: "error", reason: "error", error: partial });
		stream.end();
	});

	return stream;
}

export const __testUtils = {
	DEFAULT_CURSOR_NATIVE_REPLAY_IDLE_DISPOSE_MS,
	pendingCursorNativeRunCount: cursorLiveRuns.count,
	getPendingCursorLiveRun,
	getActiveCursorLiveRunForScope: cursorLiveRuns.getActiveForScope,
	hasTrailingUserMessagesAfterToolResults,
	setCursorNativeReplayIdleDisposeMs,
	resetCursorNativeReplayIdleDisposeMs,
	releaseAllPendingCursorLiveRunsForTests,
	resetSessionCursorAgents: () => disposeAllSessionCursorAgents(),
	resetSessionTurnQueue: cursorSessionTurnQueueTestUtils.reset,
};
