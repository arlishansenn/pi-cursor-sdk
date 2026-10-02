import type { ExtensionError, NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";
import { createDefaultSystemPromptOptions } from "./context-fixtures.js";
import {
	PI_PROJECT_INSTRUCTIONS_OPEN_PREFIX,
	serializePiProjectContextSection,
	serializePiProjectInstructionsBlock,
	type PiAgentsContextFile,
} from "../../src/cursor-agents-context.js";

export { PI_PROJECT_INSTRUCTIONS_OPEN_PREFIX, serializePiProjectContextSection, serializePiProjectInstructionsBlock };

export function makeSystemPromptOptions(
	contextFiles: PiAgentsContextFile[],
	cwd = "/repo",
): NormalizedBuildSystemPromptOptions {
	return { ...createDefaultSystemPromptOptions(cwd), contextFiles, selectedTools: [] };
}

/** Minimal pi-like system prompt containing only the project_context subset this feature owns. */
export function buildPiSystemPromptWithContextFiles(
	contextFiles: PiAgentsContextFile[],
	cwd = "/repo",
): string {
	let prompt =
		"You are an expert coding assistant operating inside pi, a coding agent harness.\n\nGuidelines:\n- Be concise in your responses";
	prompt += serializePiProjectContextSection(contextFiles);
	prompt += `\nCurrent date: 2026-01-01\nCurrent working directory: ${cwd}`;
	return prompt;
}

/** Run harness registrations through Pi's real dynamic getter and forced-prompt handling. */
export async function runHarnessBeforeAgentStartWithPi(
	pi: import("./pi-harness-types.js").PiHarness,
	options: import("@earendil-works/pi-coding-agent").BuildSystemPromptOptions,
	ctx: import("@earendil-works/pi-coding-agent").ExtensionContext,
) {
	const { ExtensionRunner } = await import("@earendil-works/pi-coding-agent");
	const { buildSystemPrompt } = await import(new URL("./core/system-prompt.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as {
		buildSystemPrompt(options: import("@earendil-works/pi-coding-agent").BuildSystemPromptOptions): string;
	};
	const calls: ReadonlyArray<readonly [string, unknown]> = pi.on.mock.calls;
	const handlers = calls.filter(([event]) => event === "before_agent_start").map(([, handler]) => handler);
	// Only the surrounding runner services are stubbed; event rendering/chaining is installed Pi code.
	const runner = {
		extensions: [{ path: "pi-harness", handlers: new Map([["before_agent_start", handlers]]) }],
		createContext: () => ctx,
		assertActive: () => {},
		emitError: (error: ExtensionError) => { throw new Error(error.error); },
	} as unknown as InstanceType<typeof ExtensionRunner>;
	const result = await ExtensionRunner.prototype.emitBeforeAgentStart.call(runner, "hello", undefined, options);
	return { options: result.systemPromptOptions, systemPrompt: buildSystemPrompt(result.systemPromptOptions) };
}
