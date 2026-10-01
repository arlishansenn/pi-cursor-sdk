import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalAgentStore } from "@cursor/sdk";
import { __testUtils as actionLog } from "../src/cursor-actions-log.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	asMockCursorRun,
	asMockSdkAgent,
	collectEvents,
	getDoneEvent,
	makeAssistantMessage,
	makeContext,
	makeModel,
	mockCreatedAgent,
	mockedCreate,
	mockedResume,
	resetCursorProviderTestState,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "../src/cursor-provider.js";
import { __testUtils as ledgerTestUtils, recordCursorCheckpointPoint } from "../src/cursor-checkpoint-ledger.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { __testUtils as cursorSessionAgentTestUtils } from "../src/cursor-session-agent.js";
import { __testUtils as resumeTestUtils } from "../src/cursor-session-agent-resume.js";
import { __testUtils as storeTestUtils, hashCursorSessionStoreScope } from "../src/cursor-session-store.js";
import { computeCursorContextFingerprint } from "../src/context.js";
import { buildCursorModelSelection } from "../src/model-discovery.js";

type FakeAgentDoc = {
	agentId: string;
	cwd: string;
	status: string;
	createdAt: number;
	updatedAt: number;
	latestCheckpoint: { schemaVersion: number; rootBlobId: string } | null;
};

/**
 * In-memory LocalAgentStore backend keyed by stateRoot, so multiple open handles
 * (retained store, transferred ownership, cleanup re-open) observe one data set
 * like sqlite handles on one directory would. `knobs` injects failures.
 */
function installCheckpointRestoreStoreBackend() {
	const defaultStateRoot = "/tmp/cursor-restore-test-state";
	const roots = new Map<string, { agents: Map<string, FakeAgentDoc>; checkpoints: Map<string, Buffer> }>();
	const knobs = { failOpenCall: undefined as number | undefined, failAgentsDelete: false };
	let openCalls = 0;
	const rootOf = (stateRoot: string) => {
		let root = roots.get(stateRoot);
		if (!root) {
			root = { agents: new Map(), checkpoints: new Map() };
			roots.set(stateRoot, root);
		}
		return root;
	};
	const openSqliteStore = vi.fn(async (options: { workspaceRef: string; stateRoot: string }) => {
		openCalls += 1;
		if (knobs.failOpenCall === openCalls) throw new Error("simulated store open failure");
		const root = rootOf(options.stateRoot);
		const store = {
			agents: {
				get: async ({ agentId }: { agentId: string }) => root.agents.get(agentId) ?? null,
				create: async ({ agent }: { agent: FakeAgentDoc }) => {
					root.agents.set(agent.agentId, { ...agent });
				},
				update: async ({ agent }: { agent: FakeAgentDoc }) => {
					root.agents.set(agent.agentId, { ...agent });
				},
				delete: async ({ filter }: { filter: { agentIds?: string[] } }) => {
					if (knobs.failAgentsDelete) throw new Error("simulated agents.delete failure");
					for (const agentId of filter.agentIds ?? []) root.agents.delete(agentId);
				},
			},
			checkpoints: {
				get: async ({ agentId, blobId }: { agentId: string; blobId: string }) =>
					root.checkpoints.get(`${agentId}\0${blobId}`) ?? null,
				create: async ({ agentId, blobId, data }: { agentId: string; blobId: string; data: Buffer }) => {
					root.checkpoints.set(`${agentId}\0${blobId}`, data);
				},
				delete: async ({ filter }: { filter: { agentIds?: string[]; blobIds?: string[] } }) => {
					for (const key of [...root.checkpoints.keys()]) {
						const [agentId, blobId] = key.split("\0") as [string, string];
						if (filter.agentIds && !filter.agentIds.includes(agentId)) continue;
						if (filter.blobIds && !filter.blobIds.includes(blobId)) continue;
						root.checkpoints.delete(key);
					}
				},
				list: async ({ filter }: { filter?: { agentIds?: string[] } }) => ({
					items: [...root.checkpoints.keys()]
						.filter((key) => !filter?.agentIds || filter.agentIds.includes(key.split("\0")[0] as string))
						.map((key) => key.split("\0")[1]),
				}),
			},
			runs: {},
			runEvents: {},
			dispose: vi.fn(async () => {}),
		};
		return store as unknown as LocalAgentStore & { dispose(): Promise<void> };
	});
	storeTestUtils.setSdkOperations({ getDefaultStateRoot: () => defaultStateRoot, openSqliteStore });
	return {
		knobs,
		sessionIdentityFor: (scopeKey: string) => ({
			version: 1 as const,
			stateRoot: join(defaultStateRoot, "pi-sessions", hashCursorSessionStoreScope(scopeKey)),
		}),
		seedSourceAgent: (stateRoot: string) => {
			const root = rootOf(stateRoot);
			const head = "aa".repeat(32);
			const child = "bb".repeat(32);
			root.agents.set("agent-source", {
				agentId: "agent-source",
				cwd: process.cwd(),
				status: "idle",
				createdAt: 0,
				updatedAt: 0,
				latestCheckpoint: { schemaVersion: 1, rootBlobId: head },
			});
			root.checkpoints.set(`agent-source\0${head}`, Buffer.from("ALPHA"));
			root.checkpoints.set(`agent-source\0${child}`, Buffer.from("child"));
		},
		getAgent: (stateRoot: string, agentId: string) => rootOf(stateRoot).agents.get(agentId) ?? null,
		blobIdsFor: (stateRoot: string, agentId: string) =>
			[...rootOf(stateRoot).checkpoints.keys()]
				.filter((key) => key.startsWith(`${agentId}\0`))
				.map((key) => key.split("\0")[1]),
		copyTargetIds: (stateRoot: string) =>
			[...rootOf(stateRoot).agents.keys()].filter((agentId) => agentId.startsWith("agent-") && agentId !== "agent-source"),
	};
}

describe("streamCursor checkpoint restore", () => {
	let actionDir: string;
	let actionPath: string;
	let backend: ReturnType<typeof installCheckpointRestoreStoreBackend>;
	let scopeKey: string;
	let identity: { version: 1; stateRoot: string };
	let fingerprint: string;

	beforeEach(async () => {
		await resetCursorProviderTestState();
		ledgerTestUtils.reset();
		backend = installCheckpointRestoreStoreBackend();
		actionDir = mkdtempSync(join(tmpdir(), "cursor-checkpoint-restore-journal-"));
		actionPath = join(actionDir, "actions.jsonl");
		vi.stubEnv("CURSOR_SDK_ACTIONS_LOG", actionPath);
		vi.stubEnv("PI_CURSOR_LOCAL_RESUME", "1");
		vi.stubEnv("PI_CURSOR_CHECKPOINT_RESTORE", "1");
	});
	afterEach(async () => {
		await actionLog.flush();
		storeTestUtils.setSdkOperations(undefined);
		vi.unstubAllEnvs();
		rmSync(actionDir, { recursive: true, force: true });
	});
	async function journal() {
		await actionLog.flush();
		return readFileSync(actionPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	}

	/**
	 * Seeds a persistent scope whose first acquire resumes `agent-old` with a stale
	 * context fingerprint, so the send plan diverges and the checkpoint restore
	 * transaction runs against a recorded source point.
	 */
	function seedRestoreScope() {
		scopeKey = "/tmp/checkpoint-restore-session.jsonl";
		cursorSessionScopeTestUtils.set(process.cwd(), scopeKey);
		identity = backend.sessionIdentityFor(scopeKey);
		const modelSelection = buildCursorModelSelection("gpt-5.5@1m", "off", false);
		const poolKey = cursorSessionAgentTestUtils.buildSessionAgentPoolKey(scopeKey, {
			apiKey: "test-key",
			agentMode: "agent",
			cwd: process.cwd(),
			modelSelection,
			settingSources: ["all"],
			localSafety: { autoReview: false, sandboxEnabled: false },
			localResume: true,
		});
		resumeTestUtils.set({
			scopeKey,
			sessionFile: scopeKey,
			cwd: process.cwd(),
			branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
			compactionGeneration: 0,
			activeHandle: {
				version: 1,
				runtime: "local",
				agentId: "agent-old",
				scopeKey,
				sessionFile: scopeKey,
				cwd: process.cwd(),
				poolKey,
				branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
				compactionGeneration: 0,
				sendState: { bootstrapped: true, contextFingerprint: "stale-context", incrementalSendCount: 0 },
				createdAt: "2026-07-07T00:00:00.000Z",
				storeIdentity: identity,
			},
		});
		const priorContext = makeContext();
		const restoreContext = makeContext([
			...priorContext.messages,
			makeAssistantMessage("Prior answer"),
			{ role: "user", content: "Follow up", timestamp: 3 },
		]);
		fingerprint = computeCursorContextFingerprint(restoreContext);
		backend.seedSourceAgent(identity.stateRoot);
		recordCursorCheckpointPoint({
			scopeKey,
			contextFingerprint: fingerprint,
			messageCount: 3,
			sourceAgentId: "agent-source",
			blobIds: ["aa".repeat(32), "bb".repeat(32)],
			headBlobId: "aa".repeat(32),
			storeIdentity: identity,
		});
		return restoreContext;
	}

	function pointForFingerprint() {
		return ledgerTestUtils.points().find((point) => point.contextFingerprint === fingerprint);
	}

	it("marks the checkpoint unavailable, cleans the copy target, and falls back to create when the target resume rejects", async () => {
		const context = seedRestoreScope();
		mockedResume.mockResolvedValueOnce(asMockSdkAgent({ agentId: "agent-old", send: vi.fn() }));
		mockedResume.mockRejectedValueOnce(new Error("simulated checkpoint target resume failure"));
		const fallbackSend = vi.fn().mockResolvedValue(asMockCursorRun({
			id: "run-fallback",
			agentId: "agent-new",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-fallback", status: "finished", result: "fallback-done" }),
		}));
		mockCreatedAgent({ agentId: "agent-new", send: fallbackSend });

		const events = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), context, { apiKey: "test-key" }));

		expect(JSON.stringify(getDoneEvent(events).message.content)).toContain("fallback-done");
		expect(mockedResume).toHaveBeenCalledTimes(2);
		const targetAgentId = mockedResume.mock.calls[1]?.[0];
		expect(targetAgentId).toMatch(/^agent-/);
		expect(targetAgentId).not.toBe("agent-source");
		expect(pointForFingerprint()?.unavailable).toBe(true);
		expect(backend.getAgent(identity.stateRoot, targetAgentId as string)).toBeNull();
		expect(backend.blobIdsFor(identity.stateRoot, targetAgentId as string)).toEqual([]);
		expect(backend.copyTargetIds(identity.stateRoot)).toEqual([]);
		expect(mockedCreate).toHaveBeenCalledTimes(1);
		expect(fallbackSend).toHaveBeenCalledTimes(1);
		const rows = await journal();
		expect(rows.some((row) => row.action === "agent_resume" && row.phase === "error")).toBe(true);
		expect(rows.some((row) => row.action === "agent_resume_policy" && row.reason === "checkpoint_restore_fallback")).toBe(true);
	});

	it("falls back with unavailable marking and target cleanup when the restore store open rejects", async () => {
		const context = seedRestoreScope();
		backend.knobs.failOpenCall = 2;
		mockedResume.mockResolvedValueOnce(asMockSdkAgent({ agentId: "agent-old", send: vi.fn() }));
		const fallbackSend = vi.fn().mockResolvedValue(asMockCursorRun({
			id: "run-fallback",
			agentId: "agent-new",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-fallback", status: "finished", result: "fallback-done" }),
		}));
		mockCreatedAgent({ agentId: "agent-new", send: fallbackSend });

		const events = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), context, { apiKey: "test-key" }));

		expect(JSON.stringify(getDoneEvent(events).message.content)).toContain("fallback-done");
		expect(mockedResume).toHaveBeenCalledTimes(1);
		expect(pointForFingerprint()?.unavailable).toBe(true);
		expect(backend.copyTargetIds(identity.stateRoot)).toEqual([]);
		expect(mockedCreate).toHaveBeenCalledTimes(1);
		expect(fallbackSend).toHaveBeenCalledTimes(1);
		const rows = await journal();
		expect(rows.some((row) => row.action === "agent_resume_policy" && row.reason === "checkpoint_restore_fallback")).toBe(true);
		expect(rows.some((row) => row.action === "checkpoint_restore_cleanup" && row.phase === "error")).toBe(false);
	});

	it("keeps the force-create fallback when unused target cleanup rejects, logging a diagnosable error", async () => {
		const context = seedRestoreScope();
		mockedResume.mockResolvedValueOnce(asMockSdkAgent({ agentId: "agent-old", send: vi.fn() }));
		mockedResume.mockRejectedValueOnce(new Error("simulated checkpoint target resume failure"));
		backend.knobs.failAgentsDelete = true;
		const fallbackSend = vi.fn().mockResolvedValue(asMockCursorRun({
			id: "run-fallback",
			agentId: "agent-new",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-fallback", status: "finished", result: "fallback-done" }),
		}));
		mockCreatedAgent({ agentId: "agent-new", send: fallbackSend });

		const events = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), context, { apiKey: "test-key" }));

		expect(JSON.stringify(getDoneEvent(events).message.content)).toContain("fallback-done");
		const targetAgentId = mockedResume.mock.calls[1]?.[0] as string;
		expect(pointForFingerprint()?.unavailable).toBe(true);
		expect(mockedCreate).toHaveBeenCalledTimes(1);
		expect(fallbackSend).toHaveBeenCalledTimes(1);
		expect(backend.blobIdsFor(identity.stateRoot, targetAgentId)).toEqual([]);
		expect(backend.getAgent(identity.stateRoot, targetAgentId)).not.toBeNull();
		const rows = await journal();
		expect(rows.some((row) => row.action === "checkpoint_restore_cleanup" && row.phase === "error")).toBe(true);
		expect(rows.some((row) => row.action === "agent_resume_policy" && row.reason === "checkpoint_restore_fallback")).toBe(true);
	});

	it("resumes the copied checkpoint target and sends incrementally when restore succeeds", async () => {
		const context = seedRestoreScope();
		mockedResume.mockResolvedValueOnce(asMockSdkAgent({ agentId: "agent-old", send: vi.fn() }));
		const targetSend = vi.fn().mockResolvedValue(asMockCursorRun({
			id: "run-restored",
			agentId: "agent-target",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-restored", status: "finished", result: "restored-done" }),
		}));
		mockedResume.mockResolvedValueOnce(asMockSdkAgent({ agentId: "agent-target", send: targetSend }));

		const events = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), context, { apiKey: "test-key" }));

		expect(JSON.stringify(getDoneEvent(events).message.content)).toContain("restored-done");
		expect(mockedCreate).not.toHaveBeenCalled();
		expect(targetSend).toHaveBeenCalledTimes(1);
		const prompt = targetSend.mock.calls[0]?.[0] as { text?: string };
		expect(prompt.text).toContain("Follow up");
		expect(prompt.text).not.toContain("User: Hello");
		expect(prompt.text).not.toContain("Prior answer");
		expect(pointForFingerprint()?.unavailable).toBeUndefined();
		const rows = await journal();
		expect(rows.some((row) => row.reason === "checkpoint_restore_fallback")).toBe(false);
	});
});
