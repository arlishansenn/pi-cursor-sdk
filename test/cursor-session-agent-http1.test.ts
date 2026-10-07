import { beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import type { CursorResolvedSetting } from "../src/cursor-config.js";
import {
	acquireSessionCursorAgent,
	__testUtils as sessionAgentTestUtils,
} from "../src/cursor-session-agent.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { __testUtils as resumeTestUtils } from "../src/cursor-session-agent-resume.js";
import { __testUtils as cursorHttp1TestUtils } from "../src/cursor-http1.js";
import { __testUtils as cursorPiToolBridgeTestUtils } from "../src/cursor-pi-tool-bridge.js";
import { registerCursorSessionAgentLifecycle } from "../src/cursor-session-agent-lifecycle.js";
import { createEventHarness } from "./helpers/pi-harness.js";
import {
	asMockSdkAgent,
	createTestToolInfo,
	mockedConfigureCursor,
	mockedCreate,
	registerBridgeForProviderTest,
} from "./helpers/cursor-provider-harness.js";
import { installCursorSessionStoreMock } from "./helpers/cursor-session-store.js";

/** Wrap a boolean the way an explicit environment/PI_CURSOR_HTTP_1_1 setting resolves. */
function http1Setting(value: boolean): CursorResolvedSetting<boolean> {
	return { value, source: "environment", trustLevel: "environment" };
}

describe("Cursor session agent HTTP/1.1 pooling", () => {
	beforeEach(async () => {
		await cursorPiToolBridgeTestUtils.resetRegisteredBridgeForTests();
		installCursorSessionStoreMock();
		cursorSessionScopeTestUtils.reset();
		resumeTestUtils.reset();
		await sessionAgentTestUtils.disposeAllSessionCursorAgents();
		cursorHttp1TestUtils.reset();
		vi.clearAllMocks();
	});

	it("clears extension-owned SDK transport after agent disposal on reload", async () => {
		let finishDispose: (() => void) | undefined;
		const dispose = vi.fn(() => new Promise<void>((resolve) => {
			finishDispose = resolve;
		}));
		const createAgent = vi.fn().mockResolvedValue({
			agentId: "agent-http1-reload",
			[Symbol.asyncDispose]: dispose,
		});
		const pi = createEventHarness();
		registerCursorSessionAgentLifecycle(pi);
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		await acquireSessionCursorAgent({
			apiKey: "test-key",
			agentMode: "agent",
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			useHttp1ForAgent: http1Setting(true),
			createAgent,
		});
		// The single create path configured the SDK global before Agent creation.
		expect(mockedConfigureCursor).toHaveBeenCalledTimes(1);
		expect(mockedConfigureCursor.mock.invocationCallOrder[0]).toBeLessThan(
			createAgent.mock.invocationCallOrder[0],
		);

		const shutdown = pi.runSessionShutdown({ reason: "reload" });
		await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
		finishDispose?.();
		await shutdown;

		expect(mockedConfigureCursor).toHaveBeenNthCalledWith(1, {
			local: { useHttp1ForAgent: true },
		});
		expect(mockedConfigureCursor).toHaveBeenNthCalledWith(2, {
			local: { useHttp1ForAgent: null },
		});
		expect(dispose.mock.invocationCallOrder[0]).toBeLessThan(
			mockedConfigureCursor.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
		);
	});

	it("splits default, HTTP/2, and HTTP/1.1 pool keys", () => {
		const baseParams = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
		};
		const poolKeys = [
			sessionAgentTestUtils.buildSessionAgentPoolKey("scope", baseParams),
			sessionAgentTestUtils.buildSessionAgentPoolKey("scope", {
				...baseParams,
				useHttp1ForAgent: http1Setting(false),
			}),
			sessionAgentTestUtils.buildSessionAgentPoolKey("scope", {
				...baseParams,
				useHttp1ForAgent: http1Setting(true),
			}),
		];

		expect(new Set(poolKeys).size).toBe(3);
	});

	it("disposes the previous transport pool before creating its replacement", async () => {
		let finishDispose: (() => void) | undefined;
		const firstDispose = vi.fn(() => new Promise<void>((resolve) => {
			finishDispose = resolve;
		}));
		const createAgent = vi.fn().mockImplementation(async () => ({
			agentId: `agent-${createAgent.mock.calls.length}`,
			[Symbol.asyncDispose]: createAgent.mock.calls.length === 1
				? firstDispose
				: vi.fn().mockResolvedValue(undefined),
		}));
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/test.jsonl");
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};
		await acquireSessionCursorAgent({ ...params, useHttp1ForAgent: http1Setting(true) });

		const replacement = acquireSessionCursorAgent({ ...params, useHttp1ForAgent: http1Setting(false) });
		await vi.waitFor(() => expect(firstDispose).toHaveBeenCalledTimes(1));
		expect(createAgent).toHaveBeenCalledTimes(1);

		finishDispose?.();
		await replacement;
		expect(createAgent).toHaveBeenCalledTimes(2);
	});

	it("serializes opposite http1 acquires so each published entry captures its own transport preference", async () => {
		registerBridgeForProviderTest({
			active: ["mcp"],
			tools: [createTestToolInfo("mcp", Type.Object({}), "Call an MCP server")],
		});
		// The SDK fake mirrors the installed contract: configure writes a global the
		// transport reads lazily, so Agent.create stamps whatever the global holds now.
		let sdkHttp1Global: boolean | null | undefined;
		const events: string[] = [];
		mockedConfigureCursor.mockImplementation((options) => {
			sdkHttp1Global = options.local?.useHttp1ForAgent ?? null;
			events.push(`configure:${String(sdkHttp1Global)}`);
		});
		mockedCreate.mockImplementation(async () => {
			events.push(`create:${String(sdkHttp1Global)}`);
			const agent = asMockSdkAgent({
				agentId: `agent-interleave-${mockedCreate.mock.calls.length}`,
				send: vi.fn(),
			});
			(agent as { capturedHttp1?: boolean | null | undefined }).capturedHttp1 = sdkHttp1Global;
			return agent;
		});
		// Hold the first acquire inside the lock at bridge setup; the second acquire queues.
		const bridge = cursorPiToolBridgeTestUtils.getRegisteredBridgeForTests()!;
		const realCreateRun = bridge.createRun.bind(bridge);
		let releaseBridge: (() => void) | undefined;
		const bridgeGate = new Promise<void>((resolve) => {
			releaseBridge = resolve;
		});
		let createRunCalls = 0;
		vi.spyOn(bridge, "createRun").mockImplementation(async (options) => {
			const run = await realCreateRun(options);
			createRunCalls += 1;
			if (createRunCalls === 1) await bridgeGate;
			return run;
		});

		const scopeA = "/tmp/sessions/http1-interleave-a.jsonl";
		const scopeB = "/tmp/sessions/http1-interleave-b.jsonl";
		cursorSessionScopeTestUtils.set("/tmp/project-a", scopeA);
		const acquireA = acquireSessionCursorAgent({
			apiKey: "test-key",
			agentMode: "agent",
			cwd: "/tmp/project-a",
			modelSelection: { id: "composer-2.5" },
			useHttp1ForAgent: http1Setting(true),
		});
		// A now holds the HTTP/1.1 lock, parked at bridge setup with configure(true) applied.
		await vi.waitFor(() => expect(events).toEqual(["configure:true"]));

		cursorSessionScopeTestUtils.set("/tmp/project-b", scopeB);
		const acquireB = acquireSessionCursorAgent({
			apiKey: "test-key",
			agentMode: "agent",
			cwd: "/tmp/project-b",
			modelSelection: { id: "composer-2.5" },
			useHttp1ForAgent: http1Setting(false),
		});

		releaseBridge!();
		const [leaseA, leaseB] = await Promise.all([acquireA, acquireB]);

		// configure and transport capture strictly alternate: no acquire ever captures
		// the other's configure.
		expect(events).toEqual(["configure:true", "create:true", "configure:false", "create:false"]);
		expect(leaseA.scopeKey).toBe(scopeA);
		expect(leaseB.scopeKey).toBe(scopeB);
		const entryA = sessionAgentTestUtils.getSessionCursorAgentPoolState(scopeA);
		const entryB = sessionAgentTestUtils.getSessionCursorAgentPoolState(scopeB);
		if (entryA.status !== "ready" || entryB.status !== "ready") {
			throw new Error(`expected ready entries, got ${entryA.status}/${entryB.status}`);
		}
		expect((entryA.agent as { capturedHttp1?: boolean | null }).capturedHttp1).toBe(true);
		expect((entryB.agent as { capturedHttp1?: boolean | null }).capturedHttp1).toBe(false);
		expect(entryA.poolKey).toContain("http1:on");
		expect(entryB.poolKey).toContain("http1:off");
	});

	it("defers shutdown http1 clear until an in-flight locked creation captures its transport", async () => {
		registerBridgeForProviderTest({
			active: ["mcp"],
			tools: [createTestToolInfo("mcp", Type.Object({}), "Call an MCP server")],
		});
		const pi = createEventHarness();
		registerCursorSessionAgentLifecycle(pi);
		// Same installed-contract fake as the interleave case: configure writes a global
		// the transport stamps onto the agent lazily at create time.
		let sdkHttp1Global: boolean | null | undefined;
		const events: string[] = [];
		mockedConfigureCursor.mockImplementation((options) => {
			sdkHttp1Global = options.local?.useHttp1ForAgent ?? null;
			events.push(`configure:${String(sdkHttp1Global)}`);
		});
		mockedCreate.mockImplementation(async () => {
			events.push(`create:${String(sdkHttp1Global)}`);
			const agent = asMockSdkAgent({
				agentId: `agent-shutdown-clear-${mockedCreate.mock.calls.length}`,
				send: vi.fn(),
			});
			(agent as { capturedHttp1?: boolean | null | undefined }).capturedHttp1 = sdkHttp1Global;
			return agent;
		});
		// Hold the second scope's creation inside the lock at bridge setup.
		const bridge = cursorPiToolBridgeTestUtils.getRegisteredBridgeForTests()!;
		const realCreateRun = bridge.createRun.bind(bridge);
		let releaseBridge: (() => void) | undefined;
		const bridgeGate = new Promise<void>((resolve) => {
			releaseBridge = resolve;
		});
		let createRunCalls = 0;
		vi.spyOn(bridge, "createRun").mockImplementation(async (options) => {
			const run = await realCreateRun(options);
			createRunCalls += 1;
			if (createRunCalls === 2) await bridgeGate;
			return run;
		});

		const scopeA = "/tmp/sessions/http1-shutdown-a.jsonl";
		const scopeB = "/tmp/sessions/http1-shutdown-b.jsonl";
		cursorSessionScopeTestUtils.set("/tmp/project-a", scopeA);
		await acquireSessionCursorAgent({
			apiKey: "test-key",
			agentMode: "agent",
			cwd: "/tmp/project-a",
			modelSelection: { id: "composer-2.5" },
			useHttp1ForAgent: http1Setting(true),
		});
		expect(events).toEqual(["configure:true", "create:true"]);

		cursorSessionScopeTestUtils.set("/tmp/project-b", scopeB);
		const acquireB = acquireSessionCursorAgent({
			apiKey: "test-key",
			agentMode: "agent",
			cwd: "/tmp/project-b",
			modelSelection: { id: "composer-2.5" },
			useHttp1ForAgent: http1Setting(true),
		});
		// B holds the lock parked at bridge with configure(true) applied; shutdown fires
		// now. Its clear must queue behind B's capture instead of flipping it.
		await vi.waitFor(() => expect(events).toEqual(["configure:true", "create:true", "configure:true"]));
		const shutdown = pi.runSessionShutdown({ reason: "quit" });
		await vi.waitFor(() => expect(sdkHttp1Global).toBe(true));

		releaseBridge!();
		await expect(acquireB).rejects.toThrow();
		await shutdown;

		// The clear lands only after B's create captured the still-configured value.
		expect(events).toEqual(["configure:true", "create:true", "configure:true", "create:true", "configure:null"]);
		expect(sessionAgentTestUtils.getSessionCursorAgentPoolState(scopeB).status).not.toBe("ready");
	});
});
