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
import { disposeAllSessionCursorAgents } from "./cursor-session-agent.js";
import { attachCursorSdkEventDebugPiStreamTap, type CursorSdkEventDebugSink } from "./cursor-sdk-event-debug.js";
import { installCursorSdkProcessErrorGuard } from "./cursor-sdk-process-error-guard.js";
import { sanitizeCursorProviderError } from "./cursor-provider-errors.js";
import { resolveCursorApiKey } from "./cursor-api-key.js";
import { CursorProviderTurnRunner } from "./cursor-provider-turn-runner.js";
import { appendCursorAction, withCursorActionTurn } from "./cursor-actions-log.js";
import {
	assertCursorRequestScope,
	CursorSessionIdentityConflictError,
	endCursorSummarizationWindow,
	getCursorSessionId,
	getCursorSessionScopeGeneration,
	getCursorSessionScopeKey,
	isCursorSummarizationWindow,
	runWithCursorRequestIsolation,
	runWithCursorRequestSession,
} from "./cursor-session-scope.js";
import { runExclusiveCursorSessionTurn, __testUtils as cursorSessionTurnQueueTestUtils } from "./cursor-session-turn-queue.js";
import { disposeSessionCursorAgent } from "./cursor-session-agent.js";

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
				// Pi compaction summarization carries a random per-request id by design; inside the
				// compaction window such requests run isolated instead of failing identity validation.
				const summarizationRequest = mismatchedRequest && isCursorSummarizationWindow();
				const sessionConflict = mismatchedRequest && !summarizationRequest;
				let summarizationScopeKey: string | undefined;
				const invokeScoped = () => runWithCursorRequestSession(sessionConflict ? undefined : requestSessionId, async () => {
					if (sessionConflict) {
						appendCursorAction({
							action: "session_identity",
							phase: "error",
							reason: "session_id_conflict",
							requestSessionId,
							lifecycleSessionId,
						});
						throw new CursorSessionIdentityConflictError();
					}
					if (requestSessionId) {
						appendCursorAction({
							action: "session_identity",
							phase: "decision",
							reason: summarizationRequest ? "summarization_request" : "bound",
							requestSessionId,
							...(lifecycleSessionId ? { lifecycleSessionId } : {}),
						});
					}
					const acceptedScopeKey = getCursorSessionScopeKey();
					summarizationScopeKey = acceptedScopeKey;
					const acceptedGeneration = getCursorSessionScopeGeneration(acceptedScopeKey);
					await runExclusiveCursorSessionTurn(
						acceptedScopeKey,
						() => {
							assertCursorRequestScope(acceptedScopeKey, acceptedGeneration);
							return runner.run(installCursorSdkProcessErrorGuard(), () => {
								assertCursorRequestScope(acceptedScopeKey, acceptedGeneration);
							});
						},
						options?.signal,
					);
				});
				if (summarizationRequest) {
					try {
						await runWithCursorRequestIsolation(requestSessionId!, invokeScoped);
					} finally {
						if (summarizationScopeKey) {
							// The summarization id never repeats; release its isolated agent and store so
							// repeated compaction does not accumulate SDK resources.
							await disposeSessionCursorAgent(summarizationScopeKey).catch(() => undefined);
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
