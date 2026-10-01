import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteLocalAgentStore } from "@cursor/sdk/sqlite";
import {
	copyCursorCheckpointPoint,
	findCursorCheckpointPoint,
	markCursorCheckpointPointUnavailable,
	recordCursorCheckpointPoint,
	registerCursorCheckpointLedger,
	__testUtils,
} from "../src/cursor-checkpoint-ledger.js";
import { captureCommittedCursorCheckpoint } from "../src/cursor-session-agent.js";
import { releaseRetainedCursorSessionStore, retainCursorSessionStore } from "../src/cursor-session-store.js";
import { computeCursorContextFingerprint } from "../src/context.js";
import { createPiHarness, makeAssistantMessage, makeContext } from "./helpers/pi-harness.js";

const roots: string[] = [];
const POINT_CONTEXT = makeContext([{ role: "user", content: "Remember ALPHA", timestamp: 1 }]);
const POINT_FINGERPRINT = computeCursorContextFingerprint(POINT_CONTEXT);
const NEXT_CONTEXT = makeContext([...POINT_CONTEXT.messages, makeAssistantMessage("ok", 2), { role: "user", content: "Which word?", timestamp: 3 }]);

afterEach(() => {
	__testUtils.reset();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function storeWithPoint() {
	const root = mkdtempSync(join(tmpdir(), "cursor-ledger-"));
	roots.push(root);
	const store = await SqliteLocalAgentStore.open({ workspaceRef: root, stateRoot: root });
	const now = Date.now();
	await store.agents.create({ agent: { agentId: "agent-source", cwd: root, status: "idle", createdAt: now, updatedAt: now, latestCheckpoint: null } });
	await store.checkpoints.create({ agentId: "agent-source", blobId: "aa".repeat(32), data: Buffer.from("ALPHA") });
	await store.checkpoints.create({ agentId: "agent-source", blobId: "bb".repeat(32), data: Buffer.from("child") });
	const identity = { version: 1 as const, stateRoot: root };
	const point = {
		scopeKey: "/tmp/session.jsonl",
		contextFingerprint: POINT_FINGERPRINT,
		messageCount: 1,
		sourceAgentId: "agent-source",
		blobIds: ["aa".repeat(32), "bb".repeat(32)],
		headBlobId: "aa".repeat(32),
		storeIdentity: identity,
	};
	recordCursorCheckpointPoint(point);
	return { store, identity, point };
}

describe("cursor checkpoint ledger", () => {
	it("persists and reloads points through the extension registration", async () => {
		const pi = createPiHarness();
		registerCursorCheckpointLedger(pi);
		const point = {
			scopeKey: "/tmp/session.jsonl",
			contextFingerprint: POINT_FINGERPRINT,
			messageCount: 1,
			sourceAgentId: "agent-source",
			blobIds: ["aa".repeat(32)],
			headBlobId: "aa".repeat(32),
			storeIdentity: { version: 1 as const, stateRoot: "/tmp/store" },
		};
		const entries: unknown[] = [];
		pi.appendEntry.mockImplementation((_type: string, data: unknown) => {
			entries.push({ type: "custom", customType: "cursor-sdk-checkpoint-ledger", data });
		});
		recordCursorCheckpointPoint(point);
		expect(entries).toHaveLength(1);
		__testUtils.reset();
		const reloaded = createPiHarness();
		registerCursorCheckpointLedger(reloaded);
		const handler = reloaded.on.mock.calls.find((call) => String(call[0]) === "session_start")?.[1] as ((event: unknown, ctx: { sessionManager: { getEntries(): unknown[] } }) => void);
		handler({}, { sessionManager: { getEntries: () => entries } });
		expect(__testUtils.points()[0]).toMatchObject(point);
		expect(findCursorCheckpointPoint(point.scopeKey, NEXT_CONTEXT, point.storeIdentity)).toMatchObject(point);
		__testUtils.reset();
		registerCursorCheckpointLedger(reloaded);
		reloaded.appendEntry.mockImplementation((_type: string, data: unknown) => {
			entries.push({ type: "custom", customType: "cursor-sdk-checkpoint-ledger", data });
		});
		recordCursorCheckpointPoint(point);
		markCursorCheckpointPointUnavailable(point.scopeKey, point.contextFingerprint);
		expect(entries).toHaveLength(3);
		__testUtils.reset();
		registerCursorCheckpointLedger(reloaded);
		handler({}, { sessionManager: { getEntries: () => entries } });
		expect(findCursorCheckpointPoint(point.scopeKey, NEXT_CONTEXT, point.storeIdentity)).toBeUndefined();
	});

	it("keeps a successful turn when checkpoint reads reject", async () => {
		const entry = {
			scopeKey: "/tmp/session.jsonl",
			agent: { agentId: "agent-source" },
			sendState: { bootstrapped: true, contextFingerprint: "fingerprint-a", incrementalSendCount: 1 },
			sessionStore: {
				identity: { version: 1, stateRoot: "/tmp/store" },
				store: {
					agents: { get: async () => { throw new Error("second get failed"); } },
					checkpoints: { list: async () => { throw new Error("list failed"); } },
				},
			},
		};
		await expect(captureCommittedCursorCheckpoint(entry as never, { messages: [] } as never)).resolves.toBeUndefined();
	});

	it("releases a retained ephemeral store through its disposer", async () => {
		let disposed = 0;
		retainCursorSessionStore("/tmp/session.jsonl", {
			identity: { version: 1, stateRoot: "/tmp/store" },
			store: {} as never,
			dispose: async () => { disposed += 1; },
		});
		await releaseRetainedCursorSessionStore("/tmp/session.jsonl");
		expect(disposed).toBe(1);
		await releaseRetainedCursorSessionStore("/tmp/session.jsonl");
		expect(disposed).toBe(1);
	});

	it("keeps a rejecting retained disposer contained", async () => {
		retainCursorSessionStore("/tmp/session-reject.jsonl", {
			identity: { version: 1, stateRoot: "/tmp/store-reject" },
			store: {} as never,
			dispose: async () => { throw new Error("disposer boom"); },
		});
		await expect(releaseRetainedCursorSessionStore("/tmp/session-reject.jsonl")).resolves.toBeUndefined();
	});

	it("copies the complete blob set and leaves the source unchanged", async () => {
		const { store, identity } = await storeWithPoint();
		try {
			const point = findCursorCheckpointPoint("/tmp/session.jsonl", NEXT_CONTEXT, identity);
			const target = await copyCursorCheckpointPoint(store, point!);
			const targetAgent = await store.agents.get({ agentId: target });
			const targetBlobs = (await store.checkpoints.list({ filter: { agentIds: [target] } })).items;
			expect(target).not.toBe("agent-source");
			expect(targetAgent?.latestCheckpoint?.rootBlobId).toBe("aa".repeat(32));
			expect(targetBlobs).toEqual(expect.arrayContaining(["aa".repeat(32), "bb".repeat(32)]));
			expect((await store.agents.get({ agentId: "agent-source" }))?.latestCheckpoint ?? null).toBeNull();
			expect((await store.checkpoints.list({ filter: { agentIds: ["agent-source"] } })).items).toEqual(expect.arrayContaining(["aa".repeat(32), "bb".repeat(32)]));
		} finally {
			await store.dispose();
		}
	});

	it("refuses a source with an active run and removes a partial copy", async () => {
		const { store, identity } = await storeWithPoint();
		try {
			const source = await store.agents.get({ agentId: "agent-source" });
			await store.agents.update({ agent: { ...source!, activeRunId: "run-active", updatedAt: Date.now() } });
			const point = findCursorCheckpointPoint("/tmp/session.jsonl", NEXT_CONTEXT, identity)!;
			await expect(copyCursorCheckpointPoint(store, point)).rejects.toThrow(/active run/);
			point.blobIds = ["aa".repeat(32), "cc".repeat(32)];
			await store.agents.update({ agent: { ...source!, activeRunId: null, updatedAt: Date.now() } });
			const copiedTo = new Set<string>();
			const create = store.checkpoints.create.bind(store.checkpoints);
			store.checkpoints.create = async (input) => {
				copiedTo.add(input.agentId);
				return create(input);
			};
			await expect(copyCursorCheckpointPoint(store, point)).rejects.toThrow(/missing/);
			const [target] = [...copiedTo];
			expect(target).toMatch(/^agent-/);
			expect((await store.checkpoints.list({ filter: { agentIds: [target!] } })).items).toEqual([]);
			const agents = (await store.agents.list()).items.map((agent) => agent.agentId);
			expect(agents).toEqual(["agent-source"]);
			expect((await store.checkpoints.list({ filter: { agentIds: ["agent-source"] } })).items).toEqual(expect.arrayContaining(["aa".repeat(32), "bb".repeat(32)]));
		} finally {
			await store.dispose();
		}
	});

	it("copies exactly the recorded point while a second store handle advances the source", async () => {
		const { store, identity, point } = await storeWithPoint();
		const writer = await SqliteLocalAgentStore.open({ workspaceRef: identity.stateRoot, stateRoot: identity.stateRoot });
		const later = ["dd".repeat(32), "ee".repeat(32), "ff".repeat(32)];
		const advance = async (blobId: string) => {
			await writer.checkpoints.create({ agentId: "agent-source", blobId, data: Buffer.from("BETA") });
			const source = await writer.agents.get({ agentId: "agent-source" });
			await writer.agents.update({ agent: { ...source!, latestCheckpoint: { schemaVersion: 1, rootBlobId: blobId }, updatedAt: Date.now() } });
		};
		try {
			await advance(later[0]!);
			const [target] = await Promise.all([
				copyCursorCheckpointPoint(store, findCursorCheckpointPoint(point.scopeKey, NEXT_CONTEXT, identity)!),
				(async () => { for (const blobId of later.slice(1)) await advance(blobId); })(),
			]);
			expect((await store.agents.get({ agentId: target }))?.latestCheckpoint?.rootBlobId).toBe(point.headBlobId);
			expect([...(await store.checkpoints.list({ filter: { agentIds: [target] } })).items].sort()).toEqual([...point.blobIds].sort());
			expect((await store.agents.get({ agentId: "agent-source" }))?.latestCheckpoint?.rootBlobId).toBe(later[2]);
			expect((await store.checkpoints.list({ filter: { agentIds: ["agent-source"] } })).items).toEqual(expect.arrayContaining([...point.blobIds, ...later]));
		} finally {
			await writer.dispose();
			await store.dispose();
		}
	});

	it("reopens the copied head from the same store and hides unavailable points", async () => {
		const { store, identity, point } = await storeWithPoint();
		const root = identity.stateRoot;
		try {
			const target = await copyCursorCheckpointPoint(store, findCursorCheckpointPoint(point.scopeKey, NEXT_CONTEXT, identity)!);
			await store.dispose();
			const reopened = await SqliteLocalAgentStore.open({ workspaceRef: root, stateRoot: root });
			try {
				expect((await reopened.agents.get({ agentId: target }))?.latestCheckpoint?.rootBlobId).toBe("aa".repeat(32));
			} finally {
				await reopened.dispose();
			}
			markCursorCheckpointPointUnavailable(point.scopeKey, point.contextFingerprint);
			expect(findCursorCheckpointPoint(point.scopeKey, NEXT_CONTEXT, identity)).toBeUndefined();
		} catch (error) {
			await store.dispose().catch(() => undefined);
			throw error;
		}
	});
});
