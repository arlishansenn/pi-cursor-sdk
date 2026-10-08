import { toNamespacedPath, join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { __testUtils as actionLog } from "../src/cursor-actions-log.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { computeCursorContextFingerprint } from "../src/context.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { __testUtils as resumeTestUtils } from "../src/cursor-session-agent-resume.js";
import {
	acquireSessionCursorAgent,
	__testUtils as sessionAgentTestUtils,
} from "../src/cursor-session-agent.js";
import { makeContext } from "./helpers/pi-harness.js";
import { installCursorSessionStoreMock } from "./helpers/cursor-session-store.js";
import { buildCursorSessionStateRoot } from "../src/cursor-session-store.js";

describe("cursor-session-agent local resume", () => {
	let actionDir: string;
	let actionPath: string;
	afterEach(async () => {
		await actionLog.flush();
		vi.unstubAllEnvs();
		rmSync(actionDir, { recursive: true, force: true });
	});
	beforeEach(async () => {
		installCursorSessionStoreMock();
		cursorSessionScopeTestUtils.reset();
		resumeTestUtils.reset();
		await sessionAgentTestUtils.disposeAllSessionCursorAgents();
		vi.clearAllMocks();
		actionDir = mkdtempSync(join(tmpdir(), "cursor-resume-actions-"));
		actionPath = join(actionDir, "actions.jsonl");
		vi.stubEnv("CURSOR_SDK_ACTIONS_LOG", actionPath);
	});

	it("resumes a recorded local SDK agent from its versioned session store", async () => {
		const storeMock = installCursorSessionStoreMock();
		const scopeKey = "/tmp/sessions/test.jsonl";
		const stateRoot = buildCursorSessionStateRoot("/tmp/cursor-sdk-state", scopeKey, true);
		const sendState = {
			bootstrapped: true,
			contextFingerprint: computeCursorContextFingerprint(makeContext()),
			incrementalSendCount: 3,
		};
		const resumedAgent = { agentId: "agent-recorded", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) };
		const createAgent = vi.fn().mockResolvedValue({ agentId: "agent-new", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });
		const resumeAgent = vi.fn().mockResolvedValue(resumedAgent);
		cursorSessionScopeTestUtils.set("/tmp/project", scopeKey);
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			localResume: true,
			createAgent,
			resumeAgent,
		};
		const poolKey = sessionAgentTestUtils.buildSessionAgentPoolKey(scopeKey, params);
		resumeTestUtils.set({
			scopeKey,
			sessionFile: scopeKey,
			cwd: "/tmp/project",
			repoRoot: undefined,
			branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
			compactionGeneration: 0,
			activeHandle: {
				version: 2,
				runtime: "local",
				agentId: "agent-recorded",
				scopeKey,
				sessionFile: scopeKey,
				cwd: "/tmp/project",
				poolKey,
				branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
				compactionGeneration: 0,
				sendState,
				createdAt: "2026-07-07T00:00:00.000Z",
				storeIdentity: { version: 1, stateRoot },
			},
		});

		const lease = await acquireSessionCursorAgent(params);

		expect(lease.created).toBe(true);
		expect(lease.resumed).toBe(true);
		expect(lease.agent).toBe(resumedAgent);
		expect(lease.sendState).toEqual(sendState);
		expect(storeMock.openSqliteStore).toHaveBeenCalledWith({ workspaceRef: "/tmp/project", stateRoot: toNamespacedPath(stateRoot) });
		expect(resumeAgent).toHaveBeenCalledWith(
			"agent-recorded",
			expect.objectContaining({
				apiKey: "test-key",
				model: { id: "composer-2.5" },
				mode: "agent",
				local: expect.objectContaining({ cwd: "/tmp/project", store: storeMock.stores[0] }),
			}),
		);
		expect(createAgent).not.toHaveBeenCalled();
		await actionLog.flush();
		const rows = readFileSync(actionPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(rows.filter((row) => row.action === "agent_resume").map((row) => row.phase)).toEqual(["start", "success"]);
		expect(rows.some((row) => row.action === "agent_create")).toBe(false);
	});

	it("resumes a legacy default-store agent before force-creating its session-store replacement", async () => {
		const storeMock = installCursorSessionStoreMock();
		const scopeKey = "/tmp/sessions/test.jsonl";
		const context = makeContext([{ role: "user", content: "Replacement", timestamp: 1 }]);
		const createAgent = vi.fn().mockResolvedValue({ agentId: "agent-new", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });
		const resumeAgent = vi.fn().mockResolvedValue({ agentId: "agent-recorded", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });
		cursorSessionScopeTestUtils.set("/tmp/project", scopeKey);
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			localResume: true,
			createAgent,
			resumeAgent,
		};
		resumeTestUtils.set({
			scopeKey,
			sessionFile: scopeKey,
			cwd: "/tmp/project",
			branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
			compactionGeneration: 0,
			activeHandle: {
				version: 1,
				runtime: "local",
				agentId: "agent-recorded",
				scopeKey,
				sessionFile: scopeKey,
				cwd: "/tmp/project",
				poolKey: sessionAgentTestUtils.buildSessionAgentPoolKey(scopeKey, params),
				branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
				compactionGeneration: 0,
				sendState: { bootstrapped: true, contextFingerprint: "old", incrementalSendCount: 5 },
				createdAt: "2026-07-07T00:00:00.000Z",
			},
		});

		const legacyLease = await acquireSessionCursorAgent(params);
		expect(legacyLease.resumed).toBe(true);
		expect(legacyLease.storeIdentity).toEqual({ version: 1, stateRoot: "/tmp/cursor-sdk-state" });
		expect(resumeAgent.mock.calls[0][1]?.local?.store).toBe(storeMock.stores[0]);

		sessionAgentTestUtils.invalidateSessionAgent(scopeKey);
		const lease = await acquireSessionCursorAgent({ ...params, forceCreate: true });
		lease.commitSend(context, true);

		expect(createAgent).toHaveBeenCalledTimes(1);
		expect(createAgent.mock.calls[0][0].local?.store).toBe(storeMock.stores[1]);
		expect(storeMock.openedOptions).toEqual([
			{ workspaceRef: "/tmp/project", stateRoot: toNamespacedPath("/tmp/cursor-sdk-state") },
			{
				workspaceRef: "/tmp/project",
				stateRoot: toNamespacedPath(buildCursorSessionStateRoot("/tmp/cursor-sdk-state", scopeKey, true)),
			},
		]);
		expect(lease.resumed).toBe(false);
		expect(lease.sendState).toMatchObject({ bootstrapped: true, incrementalSendCount: 0 });
		expect(resumeTestUtils.state.pendingHandle).toMatchObject({
			agentId: "agent-new",
			poolKey: lease.poolKey,
		});
	});

	it("does not resume recorded agents unless local resume is enabled", async () => {
		const scopeKey = "/tmp/sessions/test.jsonl";
		const createAgent = vi.fn().mockResolvedValue({ agentId: "agent-new", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });
		const resumeAgent = vi.fn().mockResolvedValue({ agentId: "agent-recorded", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });
		cursorSessionScopeTestUtils.set("/tmp/project", scopeKey);
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
			resumeAgent,
		};
		resumeTestUtils.set({
			scopeKey,
			sessionFile: scopeKey,
			cwd: "/tmp/project",
			branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
			compactionGeneration: 0,
			activeHandle: {
				version: 1,
				runtime: "local",
				agentId: "agent-recorded",
				scopeKey,
				sessionFile: scopeKey,
				cwd: "/tmp/project",
				poolKey: sessionAgentTestUtils.buildSessionAgentPoolKey(scopeKey, params),
				branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
				compactionGeneration: 0,
				sendState: { bootstrapped: true, contextFingerprint: computeCursorContextFingerprint(makeContext()), incrementalSendCount: 0 },
				createdAt: "2026-07-07T00:00:00.000Z",
			},
		});

		const lease = await acquireSessionCursorAgent(params);

		expect(lease.resumed).toBe(false);
		expect(lease.agent.agentId).toBe("agent-new");
		expect(resumeAgent).not.toHaveBeenCalled();
		expect(createAgent).toHaveBeenCalledTimes(1);
	});

	it.each(["store open", "Agent.resume"] as const)(
		"falls back from a legacy default store to the per-session store when %s fails",
		async (failure) => {
			const storeMock = installCursorSessionStoreMock();
			if (failure === "store open") storeMock.openSqliteStore.mockRejectedValueOnce(new Error("legacy index.db is locked"));
			const scopeKey = "/tmp/sessions/test.jsonl";
			const createAgent = vi.fn().mockResolvedValue({ agentId: "agent-new", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });
			const resumeAgent = vi.fn().mockRejectedValue(new Error("Agent agent-recorded not found"));
			cursorSessionScopeTestUtils.set("/tmp/project", scopeKey);
			const params = {
				apiKey: "test-key",
				agentMode: "agent" as const,
				cwd: "/tmp/project",
				modelSelection: { id: "composer-2.5" },
				localResume: true,
				createAgent,
				resumeAgent,
			};
			resumeTestUtils.set({
				scopeKey,
				sessionFile: scopeKey,
				cwd: "/tmp/project",
				branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
				compactionGeneration: 0,
				activeHandle: {
					version: 1,
					runtime: "local",
					agentId: "agent-recorded",
					scopeKey,
					sessionFile: scopeKey,
					cwd: "/tmp/project",
					poolKey: sessionAgentTestUtils.buildSessionAgentPoolKey(scopeKey, params),
					branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
					compactionGeneration: 0,
					sendState: { bootstrapped: true, contextFingerprint: computeCursorContextFingerprint(makeContext()), incrementalSendCount: 0 },
					createdAt: "2026-07-07T00:00:00.000Z",
				},
			});

			const lease = await acquireSessionCursorAgent(params);

			expect(storeMock.openSqliteStore).toHaveBeenNthCalledWith(1, {
				workspaceRef: "/tmp/project",
				stateRoot: toNamespacedPath("/tmp/cursor-sdk-state"),
			});
			expect(storeMock.openSqliteStore).toHaveBeenNthCalledWith(2, {
				workspaceRef: "/tmp/project",
				stateRoot: toNamespacedPath(buildCursorSessionStateRoot("/tmp/cursor-sdk-state", scopeKey, true)),
			});
			if (failure === "Agent.resume") {
				expect(resumeAgent.mock.calls[0][1]?.local?.store).toBe(storeMock.stores[0]);
			} else {
				expect(resumeAgent).not.toHaveBeenCalled();
			}
			const createdStore = storeMock.stores[failure === "Agent.resume" ? 1 : 0];
			expect(createAgent.mock.calls[0][0].local?.store).toBe(createdStore);
			expect(lease.store).toBe(createdStore);
			expect(lease.resumed).toBe(false);
			expect(lease.resumeNotice).toContain("Could not resume prior Cursor agent");
			expect(lease.sendState.bootstrapped).toBe(false);
		},
	);

	it("never opens a legacy shared store with fileless removal ownership", async () => {
		const storeMock = installCursorSessionStoreMock();
		const sessionId = "ephemeral";
		const scopeKey = `${cursorSessionScopeTestUtils.EPHEMERAL_SESSION_SCOPE_PREFIX}${sessionId}`;
		const createAgent = vi.fn().mockResolvedValue({ agentId: "agent-new", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });
		const resumeAgent = vi.fn();
		cursorSessionScopeTestUtils.set("/tmp/project", undefined, sessionId);
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			localResume: true,
			createAgent,
			resumeAgent,
		};
		resumeTestUtils.set({
			scopeKey,
			sessionId,
			cwd: "/tmp/project",
			branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
			compactionGeneration: 0,
			activeHandle: {
				version: 1,
				runtime: "local",
				agentId: "agent-recorded",
				scopeKey,
				sessionId,
				cwd: "/tmp/project",
				poolKey: sessionAgentTestUtils.buildSessionAgentPoolKey(scopeKey, params),
				branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
				compactionGeneration: 0,
				sendState: { bootstrapped: true, contextFingerprint: "old", incrementalSendCount: 1 },
				createdAt: "2026-07-07T00:00:00.000Z",
			},
		});

		const lease = await acquireSessionCursorAgent(params);

		expect(storeMock.openSqliteStore).toHaveBeenCalledTimes(1);
		expect(storeMock.openedOptions[0].stateRoot).toContain("pi-sessions");
		expect(storeMock.openedOptions[0].stateRoot).not.toBe(toNamespacedPath("/tmp/cursor-sdk-state"));
		expect(resumeAgent).not.toHaveBeenCalled();
		expect(createAgent.mock.calls[0][0].local?.store).toBe(storeMock.stores[0]);
		expect(lease.resumeNotice).toBeUndefined();
	});

	it("creates in the current session store and reports continuity when a recorded store identity is stale", async () => {
		const scopeKey = "/tmp/sessions/test.jsonl";
		const createAgent = vi.fn().mockResolvedValue({ agentId: "agent-new", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });
		const resumeAgent = vi.fn().mockResolvedValue({ agentId: "agent-recorded", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });
		cursorSessionScopeTestUtils.set("/tmp/project", scopeKey);
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			localResume: true,
			createAgent,
			resumeAgent,
		};
		resumeTestUtils.set({
			scopeKey,
			sessionFile: scopeKey,
			cwd: "/tmp/project",
			branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
			compactionGeneration: 0,
			activeHandle: {
				version: 2,
				runtime: "local",
				agentId: "agent-recorded",
				scopeKey,
				sessionFile: scopeKey,
				cwd: "/tmp/project",
				poolKey: sessionAgentTestUtils.buildSessionAgentPoolKey(scopeKey, params),
				branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
				compactionGeneration: 0,
				sendState: { bootstrapped: true, contextFingerprint: computeCursorContextFingerprint(makeContext()), incrementalSendCount: 0 },
				createdAt: "2026-07-07T00:00:00.000Z",
				storeIdentity: { version: 1, stateRoot: "/tmp/stale-sdk-root" },
			},
		});

		const lease = await acquireSessionCursorAgent(params);

		expect(lease.resumed).toBe(false);
		expect(lease.resumeNotice).toContain("Could not resume prior Cursor agent");
		expect(resumeAgent).not.toHaveBeenCalled();
		expect(createAgent).toHaveBeenCalledTimes(1);
	});

	it("refreshes resume persistence on a pooled agent across false, true, and false leases", async () => {
		const createAgent = vi.fn().mockResolvedValue({ agentId: "agent-1", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });
		const scopeKey = "/tmp/sessions/test.jsonl";
		cursorSessionScopeTestUtils.set("/tmp/project", scopeKey);
		resumeTestUtils.set({
			scopeKey,
			sessionFile: scopeKey,
			cwd: "/tmp/project",
			branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
			compactionGeneration: 0,
		});
		const context = makeContext([{ role: "user", content: "Hello", timestamp: 1 }]);
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			createAgent,
		};

		const disabled = await acquireSessionCursorAgent({ ...params, localResume: false });
		disabled.commitSend(context, true);
		expect(resumeTestUtils.state.pendingHandle).toBeUndefined();

		const enabled = await acquireSessionCursorAgent({ ...params, localResume: true });
		enabled.commitSend(context, false);
		expect(resumeTestUtils.state.pendingHandle).toMatchObject({ agentId: "agent-1" });
		resumeTestUtils.state.pendingHandle = undefined;
		enabled.trackRunCompletion(Promise.resolve());

		const disabledAgain = await acquireSessionCursorAgent({ ...params, localResume: false });
		disabledAgain.commitSend(context, false);
		expect(resumeTestUtils.state.pendingHandle).toBeUndefined();
		expect(disabled.agent).toBe(enabled.agent);
		expect(enabled.agent).toBe(disabledAgain.agent);
		expect(createAgent).toHaveBeenCalledTimes(1);
	});

	it("carries the process-resume obligation to deferred concurrent joiners", async () => {
		installCursorSessionStoreMock();
		const scopeKey = "/tmp/sessions/test.jsonl";
		const stateRoot = buildCursorSessionStateRoot("/tmp/cursor-sdk-state", scopeKey, true);
		const sendState = {
			bootstrapped: true,
			contextFingerprint: computeCursorContextFingerprint(makeContext()),
			incrementalSendCount: 3,
		};
		const resumedAgent = { agentId: "agent-recorded", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) };
		let resolveResume: (agent: unknown) => void = () => {};
		const resumeAgent = vi.fn().mockImplementation(
			() => new Promise((resolve) => {
				resolveResume = resolve;
			}),
		);
		const createAgent = vi.fn().mockResolvedValue({ agentId: "agent-new", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });
		cursorSessionScopeTestUtils.set("/tmp/project", scopeKey);
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			localResume: true,
			createAgent,
			resumeAgent,
		};
		const poolKey = sessionAgentTestUtils.buildSessionAgentPoolKey(scopeKey, params);
		resumeTestUtils.set({
			scopeKey,
			sessionFile: scopeKey,
			cwd: "/tmp/project",
			repoRoot: undefined,
			branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
			compactionGeneration: 0,
			activeHandle: {
				version: 2,
				runtime: "local",
				agentId: "agent-recorded",
				scopeKey,
				sessionFile: scopeKey,
				cwd: "/tmp/project",
				poolKey,
				branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
				compactionGeneration: 0,
				sendState,
				createdAt: "2026-07-07T00:00:00.000Z",
				storeIdentity: { version: 1, stateRoot },
			},
		});

		const creatorPromise = acquireSessionCursorAgent(params);
		await vi.waitFor(() => expect(resumeAgent).toHaveBeenCalledTimes(1));
		const joinerPromise = acquireSessionCursorAgent(params);
		resolveResume(resumedAgent);
		const [creator, joiner] = await Promise.all([creatorPromise, joinerPromise]);

		expect(creator.created).toBe(true);
		expect(joiner.created).toBe(false);
		expect(creator.agent).toBe(joiner.agent);
		expect(resumeAgent).toHaveBeenCalledTimes(1);
		// The obligation must follow the entry, not the creator's `created` flag: a
		// concurrent joiner must not skip the conservative process_resume bootstrap.
		expect(creator.requiresProcessResumeBootstrap).toBe(true);
		expect(joiner.requiresProcessResumeBootstrap).toBe(true);
	});

	it("does not owe process_resume after an explicit checkpoint resume", async () => {
		installCursorSessionStoreMock();
		const scopeKey = "/tmp/sessions/test.jsonl";
		const resumedAgent = { agentId: "agent-checkpoint", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) };
		const resumeAgent = vi.fn().mockResolvedValue(resumedAgent);
		const createAgent = vi.fn().mockResolvedValue({ agentId: "agent-new", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });
		cursorSessionScopeTestUtils.set("/tmp/project", scopeKey);

		const lease = await acquireSessionCursorAgent({
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			localResume: true,
			resumeAgentId: "agent-checkpoint",
			resumeStoreIdentity: { version: 1, stateRoot: "/tmp/cursor-sdk-state" },
			createAgent,
			resumeAgent,
		});

		expect(lease.resumed).toBe(true);
		expect(lease.requiresProcessResumeBootstrap).toBe(false);
		expect(resumeAgent).toHaveBeenCalledTimes(1);
	});

	it("clears the process-resume obligation only via the owning entry's bootstrap commit", async () => {
		installCursorSessionStoreMock();
		const scopeKey = "/tmp/sessions/test.jsonl";
		const stateRoot = buildCursorSessionStateRoot("/tmp/cursor-sdk-state", scopeKey, true);
		const resumedAgent = { agentId: "agent-recorded", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) };
		const resumeAgent = vi.fn().mockResolvedValue(resumedAgent);
		const createAgent = vi.fn().mockResolvedValue({ agentId: "agent-new", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });
		cursorSessionScopeTestUtils.set("/tmp/project", scopeKey);
		const params = {
			apiKey: "test-key",
			agentMode: "agent" as const,
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			localResume: true,
			createAgent,
			resumeAgent,
		};
		const poolKey = sessionAgentTestUtils.buildSessionAgentPoolKey(scopeKey, params);
		resumeTestUtils.set({
			scopeKey,
			sessionFile: scopeKey,
			cwd: "/tmp/project",
			branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
			compactionGeneration: 0,
			activeHandle: {
				version: 2,
				runtime: "local",
				agentId: "agent-recorded",
				scopeKey,
				sessionFile: scopeKey,
				cwd: "/tmp/project",
				poolKey,
				branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
				compactionGeneration: 0,
				sendState: { bootstrapped: true, contextFingerprint: computeCursorContextFingerprint(makeContext()), incrementalSendCount: 0 },
				createdAt: "2026-07-07T00:00:00.000Z",
				storeIdentity: { version: 1, stateRoot },
			},
		});
		const context = makeContext([{ role: "user", content: "Hello", timestamp: 1 }]);

		const first = await acquireSessionCursorAgent(params);
		expect(first.requiresProcessResumeBootstrap).toBe(true);
		// An incremental (or failed-send) commit keeps the obligation alive.
		await first.commitSend(context, false);
		expect((await acquireSessionCursorAgent(params)).requiresProcessResumeBootstrap).toBe(true);

		// A replacement entry owes its own bootstrap; a stale commit from the old
		// instance must not discharge the current entry's obligation.
		sessionAgentTestUtils.invalidateSessionAgent(scopeKey);
		const second = await acquireSessionCursorAgent(params);
		expect(second.requiresProcessResumeBootstrap).toBe(true);
		await first.commitSend(context, true);
		expect((await acquireSessionCursorAgent(params)).requiresProcessResumeBootstrap).toBe(true);

		await second.commitSend(context, true);
		expect((await acquireSessionCursorAgent(params)).requiresProcessResumeBootstrap).toBe(false);
	});

	it("schedules a local resume handle only after a successful send commit", async () => {
		const appendEntry = vi.fn();
		const createAgent = vi.fn().mockResolvedValue({ agentId: "agent-1", [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });
		const scopeKey = "/tmp/sessions/test.jsonl";
		cursorSessionScopeTestUtils.set("/tmp/project", scopeKey);
		resumeTestUtils.set({
			appendEntry,
			scopeKey,
			sessionFile: scopeKey,
			cwd: "/tmp/project",
			branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
			compactionGeneration: 0,
		});
		const context = makeContext([{ role: "user", content: "Hello", timestamp: 1 }]);

		const lease = await acquireSessionCursorAgent({
			apiKey: "test-key",
			agentMode: "agent",
			cwd: "/tmp/project",
			modelSelection: { id: "composer-2.5" },
			localResume: true,
			createAgent,
		});
		lease.commitSend(context, true);

		expect(appendEntry).not.toHaveBeenCalled();
		expect(resumeTestUtils.state.pendingHandle).toMatchObject({
			runtime: "local",
			agentId: "agent-1",
			poolKey: lease.poolKey,
			sendState: expect.objectContaining({
				bootstrapped: true,
				contextFingerprint: computeCursorContextFingerprint(context),
				incrementalSendCount: 0,
			}),
		});
	});

});
