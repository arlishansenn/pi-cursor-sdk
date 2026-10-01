import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalAgentStore } from "@cursor/sdk";
import { SqliteLocalAgentStore } from "@cursor/sdk/sqlite";
import type { Context } from "@earendil-works/pi-ai";
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
	mockedCreate,
	mockedResume,
	resetCursorProviderTestState,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "../src/cursor-provider.js";
import { __testUtils as cursorSessionAgentTestUtils, invalidateSessionAgent, resetSessionCursorAgent } from "../src/cursor-session-agent.js";
import { __testUtils as resumeTestUtils } from "../src/cursor-session-agent-resume.js";
import { computeCursorContextFingerprint } from "../src/context.js";
import { buildCursorModelSelection } from "../src/model-discovery.js";
import { __testUtils as ledgerTestUtils } from "../src/cursor-checkpoint-ledger.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { __testUtils as storeTestUtils, hashCursorSessionStoreScope } from "../src/cursor-session-store.js";

type SqliteStore = LocalAgentStore & { dispose(): Promise<void> };

const SCOPE_KEY = "/tmp/checkpoint-restore-session.jsonl";
const ALPHA = makeContext([{ role: "user", content: "Remember ALPHA", timestamp: 1 }]);
const BETA = makeContext([...ALPHA.messages, makeAssistantMessage("ok ALPHA", 2), { role: "user", content: "Remember BETA", timestamp: 3 }]);
const BACK_TO_ALPHA = makeContext([...ALPHA.messages, makeAssistantMessage("ok ALPHA", 2), { role: "user", content: "Which word?", timestamp: 4 }]);

function blobIdFor(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * SDK agent double that persists each send as one checkpoint blob plus a head
 * advance in the real store passed through `local.store`, like a finished local run.
 */
function storeWritingAgent(agentId: string, store: SqliteStore, sends: string[], result: string) {
	return asMockSdkAgent({
		agentId,
		send: vi.fn().mockImplementation(async (message: { text?: string }) => {
			const text = message.text ?? "";
			sends.push(text);
			const blobId = blobIdFor(`${agentId}:${text}`);
			await store.checkpoints.create({ agentId, blobId, data: Buffer.from(text) });
			const current = await store.agents.get({ agentId });
			await store.agents.update({ agent: { ...current!, latestCheckpoint: { schemaVersion: 1, rootBlobId: blobId }, updatedAt: Date.now() } });
			return asMockCursorRun({
				id: `run-${sends.length}`,
				agentId,
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: `run-${sends.length}`, status: "finished", result }),
			});
		}),
	});
}

function storeOf(options: unknown): SqliteStore {
	return (options as { local: { store: SqliteStore } }).local.store;
}

describe("streamCursor checkpoint restore on a real SQLite store", () => {
	let stateRoot: string;
	let actionDir: string;
	let actionPath: string;
	let knobs: { failOpenCall?: number; failAgentsDelete: boolean };
	let sourceSends: string[];

	beforeEach(async () => {
		await resetCursorProviderTestState();
		ledgerTestUtils.reset();
		stateRoot = mkdtempSync(join(tmpdir(), "cursor-restore-state-"));
		actionDir = mkdtempSync(join(tmpdir(), "cursor-checkpoint-restore-journal-"));
		actionPath = join(actionDir, "actions.jsonl");
		knobs = { failAgentsDelete: false };
		let openCalls = 0;
		storeTestUtils.setSdkOperations({
			getDefaultStateRoot: () => stateRoot,
			openSqliteStore: async (options) => {
				openCalls += 1;
				if (knobs.failOpenCall === openCalls) throw new Error("simulated store open failure");
				const store = await SqliteLocalAgentStore.open(options);
				if (knobs.failAgentsDelete) store.agents.delete = async () => { throw new Error("simulated agents.delete failure"); };
				return store;
			},
		});
		vi.stubEnv("CURSOR_SDK_ACTIONS_LOG", actionPath);
		delete process.env.PI_CURSOR_CHECKPOINT_RESTORE;
		cursorSessionScopeTestUtils.set(process.cwd(), SCOPE_KEY);
		sourceSends = [];
		let created = 0;
		mockedCreate.mockImplementation(async (options) => {
			const store = storeOf(options);
			created += 1;
			const agentId = created === 1 ? "agent-source" : "agent-fallback";
			const now = Date.now();
			await store.agents.create({ agent: { agentId, cwd: process.cwd(), status: "idle", createdAt: now, updatedAt: now, latestCheckpoint: null } });
			return storeWritingAgent(agentId, store, created === 1 ? sourceSends : [], created === 1 ? "source-done" : "fallback-done");
		});
	});
	afterEach(async () => {
		await actionLog.flush();
		await resetCursorProviderTestState();
		storeTestUtils.setSdkOperations(undefined);
		vi.unstubAllEnvs();
		rmSync(actionDir, { recursive: true, force: true });
		rmSync(stateRoot, { recursive: true, force: true });
	});

	async function journal() {
		await actionLog.flush();
		return readFileSync(actionPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	}

	async function send(context: Context) {
		const events = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), context, { apiKey: "test-key" }));
		return JSON.stringify(getDoneEvent(events).message.content);
	}

	/** Two committed turns on one source agent: ALPHA, then BETA. Ledger points come from production capture. */
	async function runAlphaThenBeta() {
		expect(await send(ALPHA)).toContain("source-done");
		expect(await send(BETA)).toContain("source-done");
		expect(sourceSends).toHaveLength(2);
	}

	async function openSessionStore(): Promise<SqliteStore> {
		const sessionRoot = join(stateRoot, "pi-sessions", hashCursorSessionStoreScope(SCOPE_KEY));
		return SqliteLocalAgentStore.open({ workspaceRef: process.cwd(), stateRoot: sessionRoot });
	}

	async function agentIdsInStore(): Promise<string[]> {
		const store = await openSessionStore();
		try {
			return (await store.agents.list()).items.map((agent) => agent.agentId).sort();
		} finally {
			await store.dispose();
		}
	}

	function alphaPoint() {
		return ledgerTestUtils.points().find((point) => point.messageCount === ALPHA.messages.length);
	}

	it("restores the pre-divergence checkpoint into a new agent and continues incrementally after /tree", async () => {
		await runAlphaThenBeta();
		const targetSends: string[] = [];
		mockedResume.mockImplementationOnce(async (agentId, options) => storeWritingAgent(agentId, storeOf(options), targetSends, "restored-done"));

		expect(await send(BACK_TO_ALPHA)).toContain("restored-done");

		expect(mockedCreate).toHaveBeenCalledTimes(1);
		const targetAgentId = mockedResume.mock.calls[0]?.[0] as string;
		expect(targetAgentId).toMatch(/^agent-/);
		expect(targetAgentId).not.toBe("agent-source");
		expect(targetSends).toHaveLength(1);
		expect(targetSends[0]).toContain("Which word?");
		expect(targetSends[0]).not.toContain("Remember ALPHA");

		const store = await openSessionStore();
		try {
			const alphaHead = blobIdFor(`agent-source:${sourceSends[0]}`);
			const betaHead = blobIdFor(`agent-source:${sourceSends[1]}`);
			const targetBlobs = (await store.checkpoints.list({ filter: { agentIds: [targetAgentId] } })).items;
			expect(targetBlobs).toContain(alphaHead);
			expect(targetBlobs).not.toContain(betaHead);
			expect((await store.agents.get({ agentId: "agent-source" }))?.latestCheckpoint?.rootBlobId).toBe(betaHead);
			expect((await store.checkpoints.list({ filter: { agentIds: ["agent-source"] } })).items).toEqual(expect.arrayContaining([alphaHead, betaHead]));
		} finally {
			await store.dispose();
		}
		const rows = await journal();
		expect(rows.find((row) => row.action === "prompt_build" && row.messageCount === BACK_TO_ALPHA.messages.length && row.reason !== "context_divergence")).toMatchObject({ mode: "incremental" });
		expect(rows.some((row) => row.reason === "checkpoint_restore_fallback")).toBe(false);
	});

	it("restores into an empty pool after the /tree lifecycle reset instead of creating and bootstrapping", async () => {
		await runAlphaThenBeta();
		invalidateSessionAgent();
		await resetSessionCursorAgent();
		const targetSends: string[] = [];
		mockedResume.mockImplementationOnce(async (agentId, options) => storeWritingAgent(agentId, storeOf(options), targetSends, "restored-done"));

		expect(await send(BACK_TO_ALPHA)).toContain("restored-done");

		expect(mockedCreate).toHaveBeenCalledTimes(1);
		expect(mockedResume.mock.calls[0]?.[0]).not.toBe("agent-source");
		expect(targetSends).toHaveLength(1);
		expect(targetSends[0]).toContain("Which word?");
		expect(targetSends[0]).not.toContain("Remember ALPHA");
		const rows = await journal();
		expect(rows.filter((row) => row.action === "send_plan").at(-1)).toMatchObject({ mode: "incremental" });
	});

	it("lets a matching local resume handle resume the same agent after a restart instead of copying a checkpoint", async () => {
		await runAlphaThenBeta();
		invalidateSessionAgent();
		await resetSessionCursorAgent();
		vi.stubEnv("PI_CURSOR_LOCAL_RESUME", "1");
		const poolKey = cursorSessionAgentTestUtils.buildSessionAgentPoolKey(SCOPE_KEY, {
			apiKey: "test-key",
			agentMode: "agent",
			cwd: process.cwd(),
			modelSelection: buildCursorModelSelection("gpt-5.5@1m", "off", false),
			settingSources: ["all"],
			localSafety: { autoReview: false, sandboxEnabled: false },
			localResume: true,
		});
		resumeTestUtils.set({
			scopeKey: SCOPE_KEY,
			sessionFile: SCOPE_KEY,
			cwd: process.cwd(),
			branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
			compactionGeneration: 0,
			activeHandle: {
				version: 2,
				runtime: "local",
				agentId: "agent-source",
				scopeKey: SCOPE_KEY,
				sessionFile: SCOPE_KEY,
				cwd: process.cwd(),
				poolKey,
				branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
				compactionGeneration: 0,
				sendState: { bootstrapped: true, contextFingerprint: computeCursorContextFingerprint(BETA), incrementalSendCount: 0 },
				createdAt: "2026-10-01T00:00:00.000Z",
				storeIdentity: { version: 1, stateRoot: join(stateRoot, "pi-sessions", hashCursorSessionStoreScope(SCOPE_KEY)) },
			},
		});
		mockedResume.mockImplementationOnce(async (agentId, options) => storeWritingAgent(agentId, storeOf(options), [], "resumed-done"));
		const afterBeta = makeContext([...BETA.messages, makeAssistantMessage("ok BETA", 4), { role: "user", content: "Which words?", timestamp: 5 }]);

		expect(await send(afterBeta)).toContain("resumed-done");

		expect(mockedResume).toHaveBeenCalledTimes(1);
		expect(mockedResume.mock.calls[0]?.[0]).toBe("agent-source");
		expect(await agentIdsInStore()).toEqual(["agent-source"]);
	});

	it("creates and bootstraps into an empty pool when local resume is off", async () => {
		vi.stubEnv("PI_CURSOR_LOCAL_RESUME", "0");
		await runAlphaThenBeta();
		invalidateSessionAgent();
		await resetSessionCursorAgent();

		expect(await send(BACK_TO_ALPHA)).toContain("fallback-done");

		expect(mockedResume).not.toHaveBeenCalled();
		expect(mockedCreate).toHaveBeenCalledTimes(2);
		expect(await agentIdsInStore()).toEqual(["agent-fallback", "agent-source"]);
	});

	it("creates and bootstraps after /tree when PI_CURSOR_CHECKPOINT_RESTORE=0", async () => {
		vi.stubEnv("PI_CURSOR_CHECKPOINT_RESTORE", "0");
		await runAlphaThenBeta();

		expect(await send(BACK_TO_ALPHA)).toContain("fallback-done");

		expect(mockedResume).not.toHaveBeenCalled();
		expect(mockedCreate).toHaveBeenCalledTimes(2);
		expect(alphaPoint()?.unavailable).toBeUndefined();
		expect(await agentIdsInStore()).toEqual(["agent-fallback", "agent-source"]);
	});

	it("keeps a restored target durable across store reopen with only the pre-divergence branch", async () => {
		await runAlphaThenBeta();
		mockedResume.mockImplementationOnce(async (agentId, options) => storeWritingAgent(agentId, storeOf(options), [], "restored-done"));
		await send(BACK_TO_ALPHA);
		const targetAgentId = mockedResume.mock.calls[0]?.[0] as string;
		await resetCursorProviderTestState();

		const reopened = await openSessionStore();
		try {
			const target = await reopened.agents.get({ agentId: targetAgentId });
			expect(target?.activeRunId ?? null).toBeNull();
			const head = target?.latestCheckpoint?.rootBlobId;
			const blobs = (await reopened.checkpoints.list({ filter: { agentIds: [targetAgentId] } })).items;
			expect(head && blobs.includes(head)).toBe(true);
			for (const blobId of blobs) {
				const bytes = Buffer.from((await reopened.checkpoints.get({ agentId: targetAgentId, blobId }))!);
				expect(bytes.includes(Buffer.from("Remember BETA"))).toBe(false);
			}
		} finally {
			await reopened.dispose();
		}
	});

	it("marks the point unavailable, deletes the copy target, and keeps the source when the target resume rejects", async () => {
		await runAlphaThenBeta();
		mockedResume.mockRejectedValueOnce(new Error("simulated checkpoint target resume failure"));

		expect(await send(BACK_TO_ALPHA)).toContain("fallback-done");

		expect(mockedResume).toHaveBeenCalledTimes(1);
		expect(alphaPoint()?.unavailable).toBe(true);
		expect(await agentIdsInStore()).toEqual(["agent-fallback", "agent-source"]);
		const rows = await journal();
		expect(rows.some((row) => row.action === "agent_resume" && row.phase === "error")).toBe(true);
		expect(rows.some((row) => row.action === "agent_resume_policy" && row.reason === "checkpoint_restore_fallback")).toBe(true);
	});

	it("falls back with unavailable marking and target cleanup when the restore store open rejects", async () => {
		await runAlphaThenBeta();
		knobs.failOpenCall = 2;

		expect(await send(BACK_TO_ALPHA)).toContain("fallback-done");

		expect(mockedResume).not.toHaveBeenCalled();
		expect(alphaPoint()?.unavailable).toBe(true);
		expect(await agentIdsInStore()).toEqual(["agent-fallback", "agent-source"]);
		const rows = await journal();
		expect(rows.some((row) => row.action === "agent_resume_policy" && row.reason === "checkpoint_restore_fallback")).toBe(true);
		expect(rows.some((row) => row.action === "checkpoint_restore_cleanup")).toBe(false);
	});

	it("keeps the force-create fallback when unused target cleanup rejects, logging a diagnosable error", async () => {
		await runAlphaThenBeta();
		mockedResume.mockRejectedValueOnce(new Error("simulated checkpoint target resume failure"));
		knobs.failAgentsDelete = true;

		expect(await send(BACK_TO_ALPHA)).toContain("fallback-done");

		const targetAgentId = mockedResume.mock.calls[0]?.[0] as string;
		expect(alphaPoint()?.unavailable).toBe(true);
		knobs.failAgentsDelete = false;
		expect(await agentIdsInStore()).toEqual(["agent-fallback", "agent-source", targetAgentId].sort());
		const rows = await journal();
		expect(rows.some((row) => row.action === "checkpoint_restore_cleanup" && row.phase === "error")).toBe(true);
		expect(rows.some((row) => row.action === "agent_resume_policy" && row.reason === "checkpoint_restore_fallback")).toBe(true);
	});
});
