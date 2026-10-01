import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
function readPackage(path: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}
const piEntry = join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/package.json");
const piPackage = readPackage(piEntry) as {
	name?: string;
	version?: string;
	dependencies?: Record<string, string>;
};
// Resolve agent-core from the installed pi-coding-agent entry so nested and hoisted
// layouts both work; a resolution failure must fail the contract, not pass silently.
const piRequire = createRequire(piEntry);
const agentCorePackageJsonPath = piRequire.resolve("@earendil-works/pi-agent-core/package.json");
// The dist entry is not in agent-core's exports map, so build the path from the
// resolved package root instead of require.resolve.
const agentCoreEntry = join(dirname(agentCorePackageJsonPath), "dist/agent.js");
const agentCorePackage = readPackage(agentCorePackageJsonPath) as { version?: string };

function model(): Model<Api> {
	return {
		id: "contract-model",
		name: "Contract",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "http://127.0.0.1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

// The nested pi-agent-core package is not a declared dependency of this repo, so its
// types cannot be referenced by name (the packed-install typecheck resolves only
// declared deps). Keep a structural contract instead.
type ContractAgentCtor = new (options: {
	sessionId: string;
	initialState: { model: Model<Api>; systemPrompt: string };
	streamFn: (model: Model<Api>, context: unknown, options?: { sessionId?: string }) => unknown;
}) => {
	subscribe: (listener: (event: { type: string; error?: unknown }) => void) => void;
	prompt: (text: string) => Promise<unknown>;
};

describe("installed Pi stream session id contract", () => {
	it("passes the agent session id on stream options with affinity on and off", async () => {
		expect(piPackage.name).toBe("@earendil-works/pi-coding-agent");
		expect(piPackage.version).toBe("0.87.1");
		expect(piPackage.dependencies?.["@earendil-works/pi-agent-core"]).toBe("^0.87.1");
		expect(agentCorePackage.version).toBe("0.87.1");
		const { Agent } = await import(agentCoreEntry) as { Agent: ContractAgentCtor };
		const seen: Array<{ sessionId?: string; affinity?: boolean }> = [];
		for (const sendSessionAffinityHeaders of [true, false]) {
			const agent = new Agent({
				sessionId: "pi-session-contract",
				initialState: {
					model: { ...model(), compat: { sendSessionAffinityHeaders } },
					systemPrompt: "contract",
				},
				streamFn: (_model, _context, options) => {
					seen.push({
						sessionId: options?.sessionId,
						affinity: _model.compat && "sendSessionAffinityHeaders" in _model.compat
							? _model.compat.sendSessionAffinityHeaders
							: undefined,
					});
					const error = new Error("stop-before-network");
					return {
						async *[Symbol.asyncIterator]() {
							throw error;
						},
						result: () => Promise.reject(error),
					} as never;
				},
			});
			agent.subscribe((event) => {
				if (event.type === "agent_end" && "error" in event && event.error) throw event.error;
			});
			await agent.prompt("hello");
		}
		expect(seen).toEqual([
			{ sessionId: "pi-session-contract", affinity: true },
			{ sessionId: "pi-session-contract", affinity: false },
		]);
	});
});
