import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { __testUtils as actionLog } from "../src/cursor-actions-log.js";
import {
	asMockSdkAgent,
	collectEvents,
	makeModel,
	mockCreatedAgent,
	mockedConfigureCursor,
	mockedCreate,
	mockedResume,
	resetCursorProviderTestState,
} from "./helpers/cursor-provider-harness.js";
import { createEventHarness, createPiHarness, makeContext } from "./helpers/pi-harness.js";
import { installCursorSessionStoreMock } from "./helpers/cursor-session-store.js";
import { readInstalledPackageVersion, resolveInstalledPackageRoot } from "./helpers/installed-package.js";
import { Type } from "typebox";
import { streamCursor } from "../src/cursor-provider.js";
import { __testUtils as cursorPiToolBridgeTestUtils } from "../src/cursor-pi-tool-bridge.js";
import type { CursorResolvedSetting } from "../src/cursor-config.js";
import {
	createTestToolInfo,
	registerBridgeForProviderTest,
} from "./helpers/cursor-provider-harness.js";
import { __testUtils as cursorSessionScopeTestUtils, registerCursorSessionScope } from "../src/cursor-session-scope.js";
import { __testUtils as resumeTestUtils } from "../src/cursor-session-agent-resume.js";
import { __testUtils as ledgerTestUtils, recordCursorCheckpointPoint } from "../src/cursor-checkpoint-ledger.js";
import {
	acquireSessionCursorAgent,
	scheduleSessionCursorAgentWarmup,
	__testUtils as sessionAgentTestUtils,
} from "../src/cursor-session-agent.js";
import { registerCursorSessionAgentLifecycle } from "../src/cursor-session-agent-lifecycle.js";
import { registerCursorRuntimeControls, __testUtils as cursorStateTestUtils, getEffectiveFastForModelId } from "../src/cursor-state.js";
import { registerCursorModelLifecycle } from "../src/cursor-model-lifecycle.js";
import { isCursorModel } from "../src/cursor-model.js";
import { buildCursorModelSelection } from "../src/model-discovery.js";
import { getEffectiveCursorSettingSources } from "../src/cursor-setting-sources.js";
import { buildCursorSessionStateRoot } from "../src/cursor-session-store.js";
import { computeCursorContextFingerprint } from "../src/context.js";

const SCOPE_KEY = "/tmp/sessions/warm-session.jsonl";
const CWD = "/tmp/warm-project";
const MODEL_ID = "gpt-5.5@1m";

/** Wrap a boolean the way an explicit environment/PI_CURSOR_HTTP_1_1 setting resolves. */
function http1Setting(value: boolean): CursorResolvedSetting<boolean> {
	return { value, source: "environment", trustLevel: "environment" };
}

/** Acquire params shaped exactly like prepareCursorLocalProviderTurn's demand assembly. */
function demandParams(overrides: Record<string, unknown> = {}) {
	return {
		apiKey: "test-key",
		agentMode: "agent" as const,
		cwd: CWD,
		modelSelection: buildCursorModelSelection(MODEL_ID, "off", getEffectiveFastForModelId(MODEL_ID)),
		settingSources: getEffectiveCursorSettingSources(),
		localSafety: { autoReview: false, sandboxEnabled: false },
		...overrides,
	};
}

function deferredWarmCreate(agentId: string) {
	const agent = asMockSdkAgent({ agentId, send: vi.fn() });
	let release: (value: void) => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	mockedCreate.mockImplementation(() => gate.then(() => agent));
	return { agent, release: () => release() };
}

function poolEntry() {
	const state = sessionAgentTestUtils.getSessionCursorAgentPoolState(SCOPE_KEY);
	return state.status === "ready" ? state : undefined;
}

describe("cursor-session-agent warmup (same-key create-ahead)", () => {
	let actionDir: string;
	let actionPath: string;

	beforeEach(async () => {
		await resetCursorProviderTestState();
		ledgerTestUtils.reset();
		resumeTestUtils.reset();
		await sessionAgentTestUtils.disposeAllSessionCursorAgents();
		cursorSessionScopeTestUtils.set(CWD, SCOPE_KEY);
		actionDir = mkdtempSync(join(tmpdir(), "cursor-warmup-journal-"));
		actionPath = join(actionDir, "actions.jsonl");
		vi.stubEnv("CURSOR_SDK_ACTIONS_LOG", actionPath);
		vi.stubEnv("CURSOR_API_KEY", "test-key");
	});
	afterEach(async () => {
		await actionLog.flush();
		vi.unstubAllEnvs();
		rmSync(actionDir, { recursive: true, force: true });
		await sessionAgentTestUtils.disposeAllSessionCursorAgents();
	});

	async function journalRows() {
		await actionLog.flush();
		return readFileSync(actionPath, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	}

	async function warmReasons() {
		const rows = await journalRows();
		return rows
			.filter((row) => row.action === "agent_warm")
			.map((row) => `${row.phase}:${row.reason ?? ""}`);
	}

	it("publishes one ready entry and the first demand acquire joins it exactly once", async () => {
		scheduleSessionCursorAgentWarmup(MODEL_ID);

		await vi.waitFor(() => expect(poolEntry()?.status).toBe("ready"));

		const lease = await acquireSessionCursorAgent(demandParams());
		const entry = poolEntry();
		expect(lease.created).toBe(false);
		expect(lease.agent).toBe(entry?.agent);
		expect(lease.requiresProcessResumeBootstrap).toBe(false);
		expect(mockedCreate).toHaveBeenCalledTimes(1);
		const reasons = await warmReasons();
		expect(reasons).toContain("start:");
		expect(reasons).toContain("success:ready");
		expect(reasons.filter((reason) => reason === "success:warm_hit_ready")).toHaveLength(1);
	});

	it("joins an in-flight warm creation and journals warm_hit_creating once", async () => {
		const { agent, release } = deferredWarmCreate("agent-warm");
		scheduleSessionCursorAgentWarmup(MODEL_ID);
		await vi.waitFor(() => expect(sessionAgentTestUtils.getSessionCursorAgentPoolState(SCOPE_KEY).status).toBe("creating"));

		const acquirePromise = acquireSessionCursorAgent(demandParams());
		await vi.waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
		release();
		const lease = await acquirePromise;

		expect(lease.created).toBe(false);
		expect(lease.agent).toBe(agent);
		expect(mockedCreate).toHaveBeenCalledTimes(1);
		const reasons = await warmReasons();
		expect(reasons).toContain("success:ready");
		expect(reasons.filter((reason) => reason === "success:warm_hit_creating")).toHaveLength(1);
	});

	it("disposes the warmed entry and creates a second agent when the first prompt's reasoning differs", async () => {
		const warmAgent = asMockSdkAgent({ agentId: "agent-warm", send: vi.fn() });
		const demandAgent = asMockSdkAgent({ agentId: "agent-demand", send: vi.fn() });
		let createCount = 0;
		mockedCreate.mockImplementation(() => {
			createCount += 1;
			return Promise.resolve(createCount === 1 ? warmAgent : demandAgent);
		});
		const predicted = demandParams();
		const actual = demandParams({
			modelSelection: buildCursorModelSelection(MODEL_ID, "high", getEffectiveFastForModelId(MODEL_ID)),
		});
		expect(sessionAgentTestUtils.buildSessionAgentPoolKey(SCOPE_KEY, actual))
			.not.toBe(sessionAgentTestUtils.buildSessionAgentPoolKey(SCOPE_KEY, predicted));

		scheduleSessionCursorAgentWarmup(MODEL_ID);
		await vi.waitFor(() => expect(poolEntry()?.status).toBe("ready"));
		const warmAgentRef = poolEntry()?.agent;

		const lease = await acquireSessionCursorAgent(actual);

		expect(lease.created).toBe(true);
		expect(lease.agent).toBe(demandAgent);
		expect(lease.agent).not.toBe(warmAgentRef);
		expect(mockedCreate).toHaveBeenCalledTimes(2);
		expect(warmAgent[Symbol.asyncDispose] as Mock).toHaveBeenCalledTimes(1);
		// The superseded warm entry never replaces the newer demand entry.
		expect(poolEntry()?.agent).toBe(demandAgent);
		const reasons = await warmReasons();
		expect(reasons).not.toContain("success:warm_hit_ready");
		expect(reasons).not.toContain("success:warm_hit_creating");
	});

	it("separates each create dimension in the pool key while ignoring mode and disabled safety", () => {
		// Coverage note: this pins pool-key discrimination only. Warm/demand assembly
		// parity is asserted against the real prepare and warm builders in the parity
		// test below, not by this hand-written fixture.
		const params = demandParams();
		const key = sessionAgentTestUtils.buildSessionAgentPoolKey(SCOPE_KEY, params);
		expect(sessionAgentTestUtils.buildSessionAgentPoolKey(SCOPE_KEY, demandParams())).toBe(key);
		for (const changed of [
			{ ...params, cwd: "/tmp/other-project" },
			{ ...params, settingSources: ["all" as const] },
			{ ...params, localSafety: { autoReview: true, sandboxEnabled: false } },
			{ ...params, useHttp1ForAgent: http1Setting(true) },
			{ ...params, useHttp1ForAgent: http1Setting(false) },
			{ ...params, apiKey: "another-key" },
			{ ...params, modelSelection: buildCursorModelSelection(MODEL_ID, "high", getEffectiveFastForModelId(MODEL_ID)) },
			{ ...params, modelSelection: buildCursorModelSelection(MODEL_ID, "off", true) },
		]) {
			expect(sessionAgentTestUtils.buildSessionAgentPoolKey(SCOPE_KEY, changed)).not.toBe(key);
		}
		// Disabled local safety normalizes to the same key as an omitted value, and the
		// SDK mode never enters the key.
		expect(sessionAgentTestUtils.buildSessionAgentPoolKey(SCOPE_KEY, demandParams({ localSafety: undefined })))
			.toBe(sessionAgentTestUtils.buildSessionAgentPoolKey(SCOPE_KEY, demandParams({ localSafety: { autoReview: false, sandboxEnabled: false } })));
		expect(sessionAgentTestUtils.buildSessionAgentPoolKey(SCOPE_KEY, demandParams({ agentMode: "plan" }))).toBe(key);
	});

	it("re-warms through the model-lifecycle hooks after model_select invalidation", async () => {
		// The hooks below re-register what src/index.ts registers for session_start and
		// model_select; this file does not drive the extension factory itself.
		const pi = createEventHarness();
		registerCursorSessionScope(pi);
		registerCursorSessionAgentLifecycle(pi);
		registerCursorModelLifecycle(pi, {
			sessionStart: (_event, ctx) => {
				const model = ctx.model;
				if (model && isCursorModel(model)) scheduleSessionCursorAgentWarmup(model.id);
			},
			modelSelect: (_event, ctx) => {
				const model = ctx.model;
				if (model && isCursorModel(model)) scheduleSessionCursorAgentWarmup(model.id);
			},
		});
		await pi.runSessionStart({
			cwd: CWD,
			model: makeModel(MODEL_ID),
			sessionManager: { getSessionFile: () => SCOPE_KEY },
		});
		await vi.waitFor(() => expect(poolEntry()?.status).toBe("ready"));
		const firstAgent = poolEntry()?.agent;
		expect(firstAgent).toBeDefined();

		await pi.runModelSelect(makeModel(MODEL_ID));

		await vi.waitFor(() => expect(poolEntry()?.agent).not.toBe(firstAgent));
		expect(firstAgent?.[Symbol.asyncDispose] as Mock).toHaveBeenCalledTimes(1);
		expect(mockedCreate).toHaveBeenCalledTimes(2);
		// The warm cleanup replaced the invalidated entry one-for-one; no extra entries.
		expect(sessionAgentTestUtils.sessionAgentsByScope.size).toBe(1);
		expect(sessionAgentTestUtils.getSessionCursorAgentPoolState(SCOPE_KEY).status).toBe("ready");
	});

	it("skips and disposes a warm create superseded by a tree reset before its create resolves", async () => {
		const { agent, release } = deferredWarmCreate("agent-warm-late");
		const pi = createEventHarness();
		registerCursorSessionAgentLifecycle(pi);
		scheduleSessionCursorAgentWarmup(MODEL_ID);
		await vi.waitFor(() => expect(sessionAgentTestUtils.getSessionCursorAgentPoolState(SCOPE_KEY).status).toBe("creating"));
		mockedConfigureCursor.mockClear();

		await pi.runSessionTree();
		release();

		await vi.waitFor(async () => expect(await warmReasons()).toContain("decision:superseded"));
		expect(sessionAgentTestUtils.getSessionCursorAgentPoolState(SCOPE_KEY).status).toBe("empty");
		expect(agent[Symbol.asyncDispose] as Mock).toHaveBeenCalledTimes(1);
		expect(mockedConfigureCursor).not.toHaveBeenCalled();
		expect(mockedCreate).toHaveBeenCalledTimes(1);
	});

	it("keeps one entry per scope when warmup is scheduled repeatedly", async () => {
		const { release } = deferredWarmCreate("agent-warm-once");
		scheduleSessionCursorAgentWarmup(MODEL_ID);
		await vi.waitFor(() => expect(sessionAgentTestUtils.getSessionCursorAgentPoolState(SCOPE_KEY).status).toBe("creating"));
		scheduleSessionCursorAgentWarmup(MODEL_ID);
		release();
		await vi.waitFor(() => expect(poolEntry()?.status).toBe("ready"));

		expect(mockedCreate).toHaveBeenCalledTimes(1);
		const reasons = await warmReasons();
		expect(reasons.filter((reason) => reason === "decision:skip_occupied")).toHaveLength(1);
		expect(reasons.filter((reason) => reason === "success:ready")).toHaveLength(1);
	});

	it("never evicts a live demand entry", async () => {
		const demandAgent = asMockSdkAgent({ agentId: "agent-demand-live", send: vi.fn() });
		mockedCreate.mockResolvedValue(demandAgent);
		const lease = await acquireSessionCursorAgent(demandParams());
		expect(lease.created).toBe(true);

		scheduleSessionCursorAgentWarmup(MODEL_ID);

		await vi.waitFor(async () => expect(await warmReasons()).toContain("decision:skip_occupied"));
		expect(poolEntry()?.agent).toBe(demandAgent);
		expect(mockedCreate).toHaveBeenCalledTimes(1);
		expect(demandAgent[Symbol.asyncDispose] as Mock).not.toHaveBeenCalled();
	});

	it("rebinds bridge callbacks on the first demand lease of a warmed entry", async () => {
		registerBridgeForProviderTest({
			active: ["mcp"],
			tools: [createTestToolInfo("mcp", Type.Object({}), "Call an MCP server")],
		});
		scheduleSessionCursorAgentWarmup(MODEL_ID);
		await vi.waitFor(() => expect(poolEntry()?.status).toBe("ready"));
		const entry = poolEntry();
		expect(entry?.bridgeRun).toBeDefined();
		const setOnToolRequest = vi.spyOn(entry!.bridgeRun!, "setOnToolRequest");

		const onBridgeToolRequest = vi.fn();
		const lease = await acquireSessionCursorAgent({ ...demandParams(), onBridgeToolRequest });

		expect(setOnToolRequest).toHaveBeenCalledWith(onBridgeToolRequest);
		expect(lease.bridgeRun).toBe(entry?.bridgeRun);
		expect(lease.agent).toBe(entry?.agent);
	});

	it("keeps the pool physically empty when the scope has checkpoint history", async () => {
		recordCursorCheckpointPoint({
			scopeKey: SCOPE_KEY,
			contextFingerprint: "fp",
			messageCount: 1,
			sourceAgentId: "agent-history",
			blobIds: ["blob-1"],
			headBlobId: "blob-1",
			storeIdentity: { version: 1, stateRoot: "/tmp/warm-state" },
		});
		// Even a predicted-key resume handle must not soften the skip.
		seedResumeHandle();

		scheduleSessionCursorAgentWarmup(MODEL_ID);

		await vi.waitFor(async () => expect(await warmReasons()).toContain("decision:skip_checkpoint_history"));
		expect(sessionAgentTestUtils.getSessionCursorAgentPoolState(SCOPE_KEY).status).toBe("empty");
		expect(mockedCreate).not.toHaveBeenCalled();
		expect(mockedResume).not.toHaveBeenCalled();
	});

	it("warms a persisted-handle resume and hands the obligation to the first demand lease", async () => {
		seedResumeHandle();
		const resumedAgent = asMockSdkAgent({ agentId: "agent-recorded", send: vi.fn() });
		mockedResume.mockResolvedValueOnce(resumedAgent);
		const storeMock = installCursorSessionStoreMock();

		scheduleSessionCursorAgentWarmup(MODEL_ID);
		await vi.waitFor(() => expect(poolEntry()?.status).toBe("ready"));
		expect(mockedResume).toHaveBeenCalledTimes(1);
		expect(mockedCreate).not.toHaveBeenCalled();
		expect(storeMock.openSqliteStore).toHaveBeenCalledTimes(1);

		const lease = await acquireSessionCursorAgent(demandParams({ localResume: true }));
		expect(lease.created).toBe(false);
		expect(lease.resumed).toBe(true);
		expect(lease.requiresProcessResumeBootstrap).toBe(true);
		const reasons = await warmReasons();
		expect(reasons).toContain("success:ready");
		expect(reasons.filter((reason) => reason === "success:warm_hit_ready")).toHaveLength(1);

		// The obligation survives until this entry's own bootstrap commit.
		const second = await acquireSessionCursorAgent(demandParams({ localResume: true }));
		expect(second.requiresProcessResumeBootstrap).toBe(true);
		await lease.commitSend(makeContext(), true);
		const third = await acquireSessionCursorAgent(demandParams({ localResume: true }));
		expect(third.requiresProcessResumeBootstrap).toBe(false);
	});

	it("keeps a fresh session file without ledger points warmable", async () => {
		// A persisted session file alone must not trigger the checkpoint-history skip.
		const freshScopeKey = "/tmp/sessions/no-history.jsonl";
		cursorSessionScopeTestUtils.set(CWD, freshScopeKey);
		scheduleSessionCursorAgentWarmup(MODEL_ID);
		await vi.waitFor(() => {
			const state = sessionAgentTestUtils.getSessionCursorAgentPoolState(freshScopeKey);
			expect(state.status).toBe("ready");
		});
		expect(mockedCreate).toHaveBeenCalledTimes(1);
	});

	it("journals a bounded failure and leaves the pool retryable when the warm create rejects", async () => {
		const rejections: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => rejections.push(reason);
		process.on("unhandledRejection", onUnhandledRejection);
		mockedCreate.mockRejectedValue(new Error("ConnectError: [unavailable] read ETIMEDOUT"));

		scheduleSessionCursorAgentWarmup(MODEL_ID);

		await vi.waitFor(async () => expect(await warmReasons()).toContain("error:failed"));
		expect(sessionAgentTestUtils.getSessionCursorAgentPoolState(SCOPE_KEY).status).toBe("empty");

		const demandAgent = asMockSdkAgent({ agentId: "agent-demand-retry", send: vi.fn() });
		mockedCreate.mockResolvedValueOnce(demandAgent);
		const lease = await acquireSessionCursorAgent(demandParams());
		expect(lease.created).toBe(true);
		expect(lease.agent).toBe(demandAgent);

		const text = readFileSync(actionPath, "utf8");
		expect(text).not.toContain("ConnectError");
		expect(text).not.toContain("test-key");
		await Promise.resolve();
		expect(rejections).toEqual([]);
		process.off("unhandledRejection", onUnhandledRejection);
	});

	it.each([
		["skip_missing_key", () => {
			vi.stubEnv("CURSOR_API_KEY", "");
		}],
		["skip_cloud", () => {
			vi.stubEnv("PI_CURSOR_RUNTIME", "cloud");
		}],
		["skip_invalid_mode", async () => {
			const pi = createPiHarness({ flagValues: { "cursor-mode": "review" } });
			registerCursorRuntimeControls(pi);
			await pi.runSessionStart({ hasUI: false });
		}],
	])("skips warmup with a bounded reason when admission fails (%s)", async (reason, makeInvalid) => {
		await makeInvalid();
		scheduleSessionCursorAgentWarmup(MODEL_ID);

		await vi.waitFor(async () => expect(await warmReasons()).toContain(`decision:${reason}`));
		expect(sessionAgentTestUtils.getSessionCursorAgentPoolState(SCOPE_KEY).status).toBe("empty");
		expect(mockedCreate).not.toHaveBeenCalled();
		cursorStateTestUtils.resetCursorModeStateForTests();
	});

	it("keeps the lazy HTTP/1.1 global read shape in the installed SDK package", () => {
		expect(readInstalledPackageVersion("@cursor/sdk")).toBe("1.0.32");
		const source = readFileSync(
			join(resolveInstalledPackageRoot("@cursor/sdk"), "dist/esm/index.js"),
			"utf8",
		);
		// Package-shape check only: Cursor.configure persists useHttp1ForAgent into
		// module-scoped state, and transports read that state through a lazily evaluated
		// getter. This is the premise the configure→capture lock depends on; it is NOT
		// proof of the capture contract, which the serialized-interleave regression in
		// test/cursor-session-agent-http1.test.ts covers behaviorally.
		expect(source).toMatch(/useHttp1ForAgent"\s*in\s*\w+\.local/);
		const binding = source.match(/([A-Za-z_$][\w$]*)\s*=\s*e\("\.\/src\/agent\/sdk-config\.ts"\)/);
		expect(binding).toBeDefined();
		const getterCall = new RegExp(`${binding![1]}\\.it\\)`, "g");
		const getterCalls = source.match(getterCall) ?? [];
		expect(getterCalls.length).toBeGreaterThanOrEqual(2);
		const lazyTransportRead = [...source.matchAll(getterCall)]
			.some((match) => source.slice(match.index!, match.index! + 400).includes("httpVersion:"));
		expect(lazyTransportRead).toBe(true);
	});

	it("keeps the real prepare assembly and the warm snapshot assembly on one pool key", async () => {
		// Demand side: one real provider turn; the pool key prepare published is the
		// demand assembly's own output, not a hand-written fixture.
		const send = vi.fn().mockResolvedValue({
			id: "run-parity",
			agentId: "agent-parity",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-parity", status: "finished" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockCreatedAgent({ agentId: "agent-parity", send });
		await collectEvents(streamCursor(makeModel(MODEL_ID), makeContext(), { apiKey: "test-key" }));
		const demandKey = poolEntry()?.poolKey;
		expect(demandKey).toBeDefined();

		// Warm side: the real snapshot builder plus the warm acquire-params builder.
		const snapshot = sessionAgentTestUtils.buildSessionCursorAgentWarmupSnapshot(MODEL_ID);
		expect(snapshot).toBeDefined();
		const warmKey = sessionAgentTestUtils.buildSessionAgentPoolKey(
			SCOPE_KEY,
			sessionAgentTestUtils.buildSessionCursorAgentWarmupAcquireParams(snapshot!),
		);
		expect(warmKey).toBe(demandKey);
	});

	it("exits occupied when a demand acquire preempts the warm cleanup of an invalidated entry", async () => {
		let finishDispose: (() => void) | undefined;
		const gatedDispose = vi.fn(() => new Promise<void>((resolve) => {
			finishDispose = resolve;
		}));
		mockedCreate.mockResolvedValue(asMockSdkAgent({
			agentId: "agent-preempt-old",
			send: vi.fn(),
			[Symbol.asyncDispose]: gatedDispose,
		}));
		await acquireSessionCursorAgent(demandParams());
		sessionAgentTestUtils.invalidateSessionAgent(SCOPE_KEY);

		scheduleSessionCursorAgentWarmup(MODEL_ID);
		await vi.waitFor(() => expect(gatedDispose).toHaveBeenCalledTimes(1));

		const demandAgent = asMockSdkAgent({ agentId: "agent-preempt-demand", send: vi.fn() });
		mockedCreate.mockResolvedValue(demandAgent);
		const demand = acquireSessionCursorAgent(demandParams());
		await vi.waitFor(() => expect(poolEntry()?.agent).toBe(demandAgent));

		finishDispose?.();
		await vi.waitFor(async () => expect(await warmReasons()).toContain("decision:skip_occupied"));
		// Warm never evicted or replaced the demand entry it yielded to.
		expect(poolEntry()?.agent).toBe(demandAgent);
		expect(mockedCreate).toHaveBeenCalledTimes(2);
	});

	it("supersedes and disposes a warm create whose bridge surface changed before publish", async () => {
		const bridgeActive = ["mcp"];
		const bridgeTools = [createTestToolInfo("mcp", Type.Object({}), "Call an MCP server")];
		registerBridgeForProviderTest({ active: bridgeActive, tools: bridgeTools });
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

		const { agent, release } = deferredWarmCreate("agent-warm-surface");
		scheduleSessionCursorAgentWarmup(MODEL_ID);
		// The placeholder key was built with the one-tool surface; grow the surface while
		// the create is parked at bridge setup so the publish key can no longer match.
		await vi.waitFor(() => expect(createRunCalls).toBe(1));
		bridgeActive.push("mcp-second");
		bridgeTools.push(createTestToolInfo("mcp-second", Type.Object({}), "Second MCP server"));
		releaseBridge!();
		release();

		await vi.waitFor(async () => expect(await warmReasons()).toContain("decision:superseded"));
		expect(sessionAgentTestUtils.getSessionCursorAgentPoolState(SCOPE_KEY).status).toBe("empty");
		expect(agent[Symbol.asyncDispose] as Mock).toHaveBeenCalledTimes(1);
	});

	it("recovers a demand acquire whose bridge surface changed before publish", async () => {
		const bridgeActive = ["mcp"];
		const bridgeTools = [createTestToolInfo("mcp", Type.Object({}), "Call an MCP server")];
		registerBridgeForProviderTest({ active: bridgeActive, tools: bridgeTools });
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
		const staleAgent = asMockSdkAgent({ agentId: "agent-surface-stale", send: vi.fn() });
		const freshAgent = asMockSdkAgent({ agentId: "agent-surface-fresh", send: vi.fn() });
		let releaseFirstCreate: (() => void) | undefined;
		const firstCreateGate = new Promise<void>((resolve) => {
			releaseFirstCreate = resolve;
		});
		let createCalls = 0;
		mockedCreate.mockImplementation(() => {
			createCalls += 1;
			return createCalls === 1 ? firstCreateGate.then(() => staleAgent) : Promise.resolve(freshAgent);
		});

		const demand = acquireSessionCursorAgent(demandParams());
		await vi.waitFor(() => expect(createRunCalls).toBe(1));
		bridgeActive.push("mcp-second");
		bridgeTools.push(createTestToolInfo("mcp-second", Type.Object({}), "Second MCP server"));
		releaseBridge!();
		releaseFirstCreate!();

		const lease = await demand;
		expect(lease.created).toBe(true);
		expect(lease.agent).toBe(freshAgent);
		expect(staleAgent[Symbol.asyncDispose] as Mock).toHaveBeenCalledTimes(1);
		expect(mockedCreate).toHaveBeenCalledTimes(2);
		// The published entry carries the grown surface's key.
		expect(poolEntry()?.bridgeRun).toBeDefined();
	});

	/** Persisted local-resume handle matching the warm-predicted pool key (reasoning off). */
	function seedResumeHandle(): void {
		const params = demandParams({ localResume: true });
		const poolKey = sessionAgentTestUtils.buildSessionAgentPoolKey(SCOPE_KEY, params);
		resumeTestUtils.set({
			scopeKey: SCOPE_KEY,
			sessionFile: SCOPE_KEY,
			cwd: CWD,
			branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
			compactionGeneration: 0,
			activeHandle: {
				version: 2,
				runtime: "local",
				agentId: "agent-recorded",
				scopeKey: SCOPE_KEY,
				sessionFile: SCOPE_KEY,
				cwd: CWD,
				poolKey,
				branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
				compactionGeneration: 0,
				sendState: {
					bootstrapped: true,
					contextFingerprint: computeCursorContextFingerprint(makeContext()),
					incrementalSendCount: 0,
				},
				createdAt: "2026-10-01T00:00:00.000Z",
				storeIdentity: { version: 1, stateRoot: buildCursorSessionStateRoot("/tmp/cursor-sdk-state", SCOPE_KEY, true) },
			},
		});
	}
});

