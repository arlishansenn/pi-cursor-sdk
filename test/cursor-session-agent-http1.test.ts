import { beforeEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import type { CursorResolvedSetting } from "../src/cursor-config.js";
import {
	acquireSessionCursorAgent,
	__testUtils as sessionAgentTestUtils,
} from "../src/cursor-session-agent.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { __testUtils as resumeTestUtils } from "../src/cursor-session-agent-resume.js";
import { runWithCursorSdkHttp1Lock, clearCursorSdkHttp1UnderLock, __testUtils as cursorHttp1TestUtils } from "../src/cursor-http1.js";
import { __testUtils as cursorPiToolBridgeTestUtils } from "../src/cursor-pi-tool-bridge.js";
import { registerCursorSdkSessionProcessErrorGuard, __testUtils as guardTestUtils } from "../src/cursor-sdk-process-error-guard.js";
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
	let storeMock: ReturnType<typeof installCursorSessionStoreMock>;
	beforeEach(async () => {
		await cursorPiToolBridgeTestUtils.resetRegisteredBridgeForTests();
		storeMock = installCursorSessionStoreMock();
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

	it.each(["new", "resume", "fork"] as const)("returns from %s before retired creation and preserves ordered reset", async (reason) => {
		const gate = Promise.withResolvers<ReturnType<typeof asMockSdkAgent>>();
		const createAgent = vi.fn(() => gate.promise);
		const pi = createEventHarness();
		registerCursorSessionAgentLifecycle(pi);
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/outgoing.jsonl");
		const acquire = acquireSessionCursorAgent({
			apiKey: "test-key", agentMode: "agent", cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" }, useHttp1ForAgent: http1Setting(true), createAgent,
		}).catch(() => undefined);
		await vi.waitFor(() => expect(createAgent).toHaveBeenCalledTimes(1));
		let switched = false;
		const shutdown = pi.runSessionShutdown({ reason }).then(() => { switched = true; });
		try {
			await vi.waitFor(() => expect(switched).toBe(true));
			expect(mockedConfigureCursor).toHaveBeenCalledTimes(1);
		} finally {
			gate.resolve(asMockSdkAgent({ agentId: "retired", send: vi.fn() }));
			await acquire;
			await shutdown;
		}
		expect(mockedConfigureCursor.mock.calls.map(([options]) => options.local?.useHttp1ForAgent)).toEqual([true, null]);
	});

	it.each(["quit", "reload"] as const)("awaits retired orphan disposal on %s after a switch", async (reason) => {
		const creation = Promise.withResolvers<ReturnType<typeof asMockSdkAgent>>();
		const disposal = Promise.withResolvers<void>();
		const storeDisposal = Promise.withResolvers<void>();
		const dispose = vi.fn(() => disposal.promise);
		const createAgent = vi.fn(() => creation.promise);
		const pi = createEventHarness();
		registerCursorSessionAgentLifecycle(pi);
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/retired.jsonl");
		const acquire = acquireSessionCursorAgent({
			apiKey: "test-key", agentMode: "agent", cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" }, useHttp1ForAgent: http1Setting(true), createAgent,
		}).catch(() => undefined);
		await vi.waitFor(() => expect(createAgent).toHaveBeenCalledOnce());
		storeMock.stores[0]!.dispose = vi.fn(() => storeDisposal.promise);
		await pi.runSessionShutdown({ reason: "new" });
		creation.resolve(asMockSdkAgent({ agentId: "retired", send: vi.fn(), [Symbol.asyncDispose]: dispose }));
		await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
		let finished = false;
		const shutdown = pi.runSessionShutdown({ reason }).then(() => { finished = true; });
		await clearCursorSdkHttp1UnderLock();
		await new Promise<void>((resolve) => setImmediate(resolve));
		try {
			expect(finished).toBe(false);
		} finally {
			disposal.resolve();
			await vi.waitFor(() => expect(storeMock.stores[0]!.dispose).toHaveBeenCalledOnce());
			expect(finished).toBe(false);
			storeDisposal.resolve();
			await acquire;
			await shutdown;
		}
		expect(finished).toBe(true);
	});

	it.each(["settle", "quit", "reload", "reject"] as const)("protects retired SDK work until full cleanup without incoming session_start (%s)", async (ending) => {
		const originalEmit = process.emit;
		const forwarded: unknown[] = [];
		const forwardEmit = originalEmit as (event: string | symbol, ...args: unknown[]) => boolean;
		process.emit = function (this: NodeJS.Process, event: string | symbol, ...args: unknown[]): boolean {
			if (event === "uncaughtException" || event === "unhandledRejection") {
				forwarded.push(args[0]);
				return true;
			}
			return forwardEmit.call(this, event, ...args);
		} as typeof process.emit;
		const creation = Promise.withResolvers<ReturnType<typeof asMockSdkAgent>>();
		const disposal = Promise.withResolvers<void>();
		const storeDisposal = Promise.withResolvers<void>();
		const dispose = vi.fn(() => disposal.promise);
		const createAgent = vi.fn(() => creation.promise);
		const pi = createEventHarness();
		registerCursorSessionAgentLifecycle(pi);
		registerCursorSdkSessionProcessErrorGuard(pi);
		await pi.runSessionStart();
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/guard-retired.jsonl");
		const acquire = acquireSessionCursorAgent({
			apiKey: "test-key", agentMode: "agent", cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" }, createAgent,
		}).catch(() => undefined);
		const closed = new Error("WritableIterable is closed");
		closed.name = "WriteIterableClosedError";
		closed.stack = "at /repo/node_modules/@cursor/sdk/dist/esm/index.js:1:1";
		const abort = new DOMException("This operation was aborted", "AbortError");
		abort.stack = closed.stack;
		const unrelated = new Error("unrelated");
		const probe = () => {
			forwarded.length = 0;
			process.emit("uncaughtException", closed);
			process.emit("unhandledRejection", abort, Promise.resolve());
			process.emit("uncaughtException", unrelated);
			expect(forwarded).toEqual([unrelated]);
		};
		let terminal: Promise<unknown> | undefined;
		try {
			await vi.waitFor(() => expect(createAgent).toHaveBeenCalledOnce());
			storeMock.stores[0]!.dispose = vi.fn(() => storeDisposal.promise);
			await pi.runSessionShutdown({ reason: "new" });
			probe();
			if (ending === "quit" || ending === "reload") terminal = pi.runSessionShutdown({ reason: ending });
			if (ending === "reject") creation.reject(new Error("creation failed"));
			else {
				creation.resolve(asMockSdkAgent({ agentId: "retired", send: vi.fn(), [Symbol.asyncDispose]: dispose }));
				await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
				probe();
			}
			disposal.resolve();
			await vi.waitFor(() => expect(storeMock.stores[0]!.dispose).toHaveBeenCalledOnce());
			probe();
			storeDisposal.resolve();
			await acquire;
			await terminal;
			await vi.waitFor(() => expect(guardTestUtils.activeSessionCount()).toBe(0));
			forwarded.length = 0;
			process.emit("uncaughtException", closed);
			expect(forwarded).toEqual([closed]);
		} finally {
			creation.resolve(asMockSdkAgent({ agentId: "retired", send: vi.fn(), [Symbol.asyncDispose]: dispose }));
			disposal.resolve();
			storeDisposal.resolve();
			await acquire;
			await terminal;
			guardTestUtils.resetLifecycleSessionGuard();
			process.emit = originalEmit;
		}
	});

	it("rejects stale creation at lock admission before configuring or opening resources", async () => {
		const gate = Promise.withResolvers<void>();
		const blocker = runWithCursorSdkHttp1Lock(() => gate.promise);
		const createAgent = vi.fn().mockResolvedValue(asMockSdkAgent({ agentId: "stale", send: vi.fn() }));
		const pi = createEventHarness();
		registerCursorSessionAgentLifecycle(pi);
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/stale.jsonl");
		const acquire = acquireSessionCursorAgent({
			apiKey: "test-key", agentMode: "agent", cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" }, useHttp1ForAgent: http1Setting(true), createAgent,
		}).catch(() => undefined);
		await new Promise<void>((resolve) => setImmediate(resolve));
		await pi.runSessionShutdown({ reason: "new" });
		gate.resolve();
		await blocker;
		await acquire;
		await pi.runSessionShutdown({ reason: "quit" });
		expect(createAgent).not.toHaveBeenCalled();
		expect(mockedConfigureCursor).not.toHaveBeenCalled();
		expect(storeMock.openSqliteStore).not.toHaveBeenCalled();
	});

	it("observes a rejected detached clear without logging SDK secrets or poisoning the queue", async () => {
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const pi = createEventHarness();
		registerCursorSessionAgentLifecycle(pi);
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/rejected-clear.jsonl");
		await acquireSessionCursorAgent({
			apiKey: "test-key", agentMode: "agent", cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" }, useHttp1ForAgent: http1Setting(true),
			createAgent: vi.fn().mockResolvedValue(asMockSdkAgent({ agentId: "clear", send: vi.fn() })),
		});
		mockedConfigureCursor.mockImplementationOnce(() => { throw new Error("Bearer secret-value"); });
		try {
			await pi.runSessionShutdown({ reason: "new" });
			await vi.waitFor(() => expect(errorLog).toHaveBeenCalledWith("[cursor] Deferred HTTP configuration cleanup failed."));
			await pi.runSessionShutdown({ reason: "quit" });
			expect(mockedConfigureCursor).toHaveBeenLastCalledWith({ local: { useHttp1ForAgent: null } });
		} finally {
			errorLog.mockRestore();
		}
	});

	it("drains rejected retired creation and accepts subsequent ordered work", async () => {
		const creation = Promise.withResolvers<ReturnType<typeof asMockSdkAgent>>();
		const createAgent = vi.fn(() => creation.promise);
		const pi = createEventHarness();
		registerCursorSessionAgentLifecycle(pi);
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/rejected-create.jsonl");
		const acquire = acquireSessionCursorAgent({
			apiKey: "test-key", agentMode: "agent", cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" }, useHttp1ForAgent: http1Setting(true), createAgent,
		}).catch(() => undefined);
		await vi.waitFor(() => expect(createAgent).toHaveBeenCalledOnce());
		await pi.runSessionShutdown({ reason: "new" });
		creation.reject(new Error("creation failed"));
		await acquire;
		await pi.runSessionShutdown({ reason: "quit" });
		expect(storeMock.stores[0]!.dispose).toHaveBeenCalledOnce();
		await expect(runWithCursorSdkHttp1Lock(async () => "usable")).resolves.toBe("usable");
	});

	it.each(["success", "bridge rejection", "agent rejection"] as const)("drains orphan bridge, agent and store disposal on reload (%s)", async (outcome) => {
		registerBridgeForProviderTest({
			active: ["mcp"], tools: [createTestToolInfo("mcp", Type.Object({}), "Call an MCP server")],
		});
		const bridge = cursorPiToolBridgeTestUtils.getRegisteredBridgeForTests()!;
		const run = await bridge.createRun();
		const bridgeDisposal = Promise.withResolvers<void>();
		const disposeRun = run.dispose.bind(run);
		const disposeBridge = vi.spyOn(run, "dispose").mockImplementation(async () => {
			await bridgeDisposal.promise;
			await disposeRun();
			if (outcome === "bridge rejection") throw new Error("bridge disposal failed");
		});
		vi.spyOn(bridge, "createRun").mockResolvedValue(run);
		const creation = Promise.withResolvers<ReturnType<typeof asMockSdkAgent>>();
		const createAgent = vi.fn(() => creation.promise);
		const disposeAgent = vi.fn(async () => {
			if (outcome === "agent rejection") throw new Error("agent disposal failed");
		});
		const pi = createEventHarness();
		registerCursorSessionAgentLifecycle(pi);
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/orphan-bridge.jsonl");
		const acquire = acquireSessionCursorAgent({
			apiKey: "test-key", agentMode: "agent", cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" }, createAgent,
		}).catch(() => undefined);
		await vi.waitFor(() => expect(createAgent).toHaveBeenCalledOnce());
		await pi.runSessionShutdown({ reason: "new" });
		creation.resolve(asMockSdkAgent({ agentId: "orphan-bridge", send: vi.fn(), [Symbol.asyncDispose]: disposeAgent }));
		await vi.waitFor(() => expect(disposeBridge).toHaveBeenCalledOnce());
		let finished = false;
		const shutdown = pi.runSessionShutdown({ reason: "reload" }).then(() => { finished = true; });
		await new Promise<void>((resolve) => setImmediate(resolve));
		try {
			expect(finished).toBe(false);
			expect(disposeAgent).not.toHaveBeenCalled();
		} finally {
			bridgeDisposal.resolve();
			await shutdown;
			await acquire;
		}
		expect(disposeAgent).toHaveBeenCalledOnce();
		expect(storeMock.stores[0]!.dispose).toHaveBeenCalledOnce();
	});

	it("drains a retired bridge setup rejection without poisoning HTTP ordering", async () => {
		registerBridgeForProviderTest({
			active: ["mcp"], tools: [createTestToolInfo("mcp", Type.Object({}), "Call an MCP server")],
		});
		const bridge = cursorPiToolBridgeTestUtils.getRegisteredBridgeForTests()!;
		const setup = Promise.withResolvers<Awaited<ReturnType<typeof bridge.createRun>>>();
		const createRun = vi.spyOn(bridge, "createRun").mockReturnValue(setup.promise);
		const pi = createEventHarness();
		registerCursorSessionAgentLifecycle(pi);
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/bridge-failure.jsonl");
		const acquire = acquireSessionCursorAgent({
			apiKey: "test-key", agentMode: "agent", cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" }, useHttp1ForAgent: http1Setting(true),
		}).catch(() => undefined);
		await vi.waitFor(() => expect(createRun).toHaveBeenCalledOnce());
		await pi.runSessionShutdown({ reason: "new" });
		setup.reject(new Error("bridge setup failed"));
		await acquire;
		await pi.runSessionShutdown({ reason: "quit" });
		expect(storeMock.openSqliteStore).not.toHaveBeenCalled();
		await expect(runWithCursorSdkHttp1Lock(async () => "usable")).resolves.toBe("usable");
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

	it("serializes opposite http1 configuration through each create", async () => {
		registerBridgeForProviderTest({
			active: ["mcp"],
			tools: [createTestToolInfo("mcp", Type.Object({}), "Call an MCP server")],
		});
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
			(agent as { observedHttp1?: boolean | null | undefined }).observedHttp1 = sdkHttp1Global;
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

		expect(events).toEqual(["configure:true", "create:true", "configure:false", "create:false"]);
		expect(leaseA.scopeKey).toBe(scopeA);
		expect(leaseB.scopeKey).toBe(scopeB);
		const entryA = sessionAgentTestUtils.getSessionCursorAgentPoolState(scopeA);
		const entryB = sessionAgentTestUtils.getSessionCursorAgentPoolState(scopeB);
		if (entryA.status !== "ready" || entryB.status !== "ready") {
			throw new Error(`expected ready entries, got ${entryA.status}/${entryB.status}`);
		}
		expect((entryA.agent as { observedHttp1?: boolean | null }).observedHttp1).toBe(true);
		expect((entryB.agent as { observedHttp1?: boolean | null }).observedHttp1).toBe(false);
		expect(entryA.poolKey).toContain("http1:on");
		expect(entryB.poolKey).toContain("http1:off");
	});

	it("defers shutdown http1 clear until an in-flight locked creation completes", async () => {
		registerBridgeForProviderTest({
			active: ["mcp"],
			tools: [createTestToolInfo("mcp", Type.Object({}), "Call an MCP server")],
		});
		const pi = createEventHarness();
		registerCursorSessionAgentLifecycle(pi);

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
			(agent as { observedHttp1?: boolean | null | undefined }).observedHttp1 = sdkHttp1Global;
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
		await vi.waitFor(() => expect(events).toEqual(["configure:true", "create:true", "configure:true"]));
		const shutdown = pi.runSessionShutdown({ reason: "quit" });
		await vi.waitFor(() => expect(sdkHttp1Global).toBe(true));

		releaseBridge!();
		await expect(acquireB).rejects.toThrow();
		await shutdown;

		expect(events).toEqual(["configure:true", "create:true", "configure:true", "create:true", "configure:null"]);
		expect(sessionAgentTestUtils.getSessionCursorAgentPoolState(scopeB).status).not.toBe("ready");
	});
});
