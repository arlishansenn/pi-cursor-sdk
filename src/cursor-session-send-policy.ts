import { traceCursorSyncAction } from "./cursor-actions-log.js";
import type { Context } from "@earendil-works/pi-ai";
import {
	buildCursorIncrementalPrompt,
	buildCursorPrompt,
	shouldBootstrapCursorContext,
	type CursorPrompt,
	type CursorPromptOptions,
} from "./context.js";
import type { SessionCursorAgentSendState } from "./cursor-session-agent.js";

export type CursorSessionSendMode = "bootstrap" | "incremental";

export type CursorSessionSendReason = "initial" | "context_divergence" | "process_resume" | "incremental";

export interface CursorSessionSendPlan {
	mode: CursorSessionSendMode;
	resetAgent: boolean;
	reason: CursorSessionSendReason;
}

export function planCursorSessionSend(sendState: SessionCursorAgentSendState, context: Context): CursorSessionSendPlan {
	if (!sendState.bootstrapped) {
		return { mode: "bootstrap", resetAgent: false, reason: "initial" };
	}
	if (shouldBootstrapCursorContext(sendState, context)) {
		return { mode: "bootstrap", resetAgent: true, reason: "context_divergence" };
	}
	return { mode: "incremental", resetAgent: false, reason: "incremental" };
}

export function buildCursorSessionSendPrompt(
	context: Context,
	options: CursorPromptOptions,
	plan: CursorSessionSendPlan,
): CursorPrompt {
	return traceCursorSyncAction(
		{ action: "prompt_build", mode: plan.mode, reason: plan.reason, messageCount: context.messages.length },
		() => plan.mode === "bootstrap" ? buildCursorPrompt(context, options) : buildCursorIncrementalPrompt(context, options),
		(prompt) => ({ promptChars: prompt.text.length, imageCount: prompt.images.length }),
	);
}
