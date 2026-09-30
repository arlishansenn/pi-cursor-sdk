import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@cursor/sdk";
import { SqliteLocalAgentStore } from "@cursor/sdk/sqlite";
import { resolveCursorRuntimeApiKey } from "../src/cursor-api-key.ts";

const apiKey = await resolveCursorRuntimeApiKey();
if (!apiKey) {
	console.error("checkpoint restore live verification: release-blocked, Cursor auth unavailable");
	process.exit(2);
}
const root = mkdtempSync(join(tmpdir(), "cursor-checkpoint-live-"));
let store;
try {
	store = await SqliteLocalAgentStore.open({ workspaceRef: root, stateRoot: root });
	const model = { id: "grok-4.6", params: [{ id: "fast", value: "false" }] };
	const agent = await Agent.create({ apiKey, model, local: { cwd: root, store, settingSources: [] } });
	await (await agent.send("Reply with the single word ALPHA.")).wait();
	const source = await store.agents.get({ agentId: agent.agentId });
	const head = source?.latestCheckpoint?.rootBlobId;
	const blobs = (await store.checkpoints.list({ filter: { agentIds: [agent.agentId] } })).items;
	if (!head || !blobs.includes(head)) throw new Error("checkpoint head missing");
	const copied = [];
	for (const blobId of blobs) copied.push({ blobId, data: await store.checkpoints.get({ agentId: agent.agentId, blobId }) });
	await (await agent.send("Reply with the single word BETA.")).wait();
	await agent[Symbol.asyncDispose]();
	const targetId = "agent-livecheckpointrestore";
	await store.agents.create({ agent: { agentId: targetId, cwd: root, status: "idle", createdAt: Date.now(), updatedAt: Date.now(), latestCheckpoint: null } });
	for (const blob of copied) await store.checkpoints.create({ agentId: targetId, blobId: blob.blobId, data: blob.data });
	await store.agents.update({ agent: { ...(await store.agents.get({ agentId: targetId })), latestCheckpoint: { schemaVersion: 1, rootBlobId: head }, updatedAt: Date.now() } });
	await store.dispose();
	store = await SqliteLocalAgentStore.open({ workspaceRef: root, stateRoot: root });
	const resumed = await Agent.resume(targetId, { apiKey, model, local: { cwd: root, store, settingSources: [] } });
	const result = String((await (await resumed.send("Reply with the single word GAMMA.")).wait())?.result ?? "");
	const targetBlobs = (await store.checkpoints.list({ filter: { agentIds: [targetId] } })).items;
	let hasBeta = false;
	for (const blobId of targetBlobs) {
		const bytes = Buffer.from(await store.checkpoints.get({ agentId: targetId, blobId }));
		if (bytes.includes(Buffer.from("BETA"))) hasBeta = true;
	}
	if (!result.includes("GAMMA") || hasBeta) throw new Error("checkpoint restore live verification failed");
	await resumed[Symbol.asyncDispose]();
	console.log("checkpoint restore live verification: passed");
} finally {
	await store?.dispose?.().catch(() => undefined);
	rmSync(root, { recursive: true, force: true });
}
