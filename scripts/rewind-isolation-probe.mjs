#!/usr/bin/env node
/**
 * Live isolation probe for #18: does a same-agent rewind keep the discarded branch out of the
 * conversation the model continues from?
 *
 * One agent per sample, three code words with random suffixes:
 *   T1 remember W1 (head h1)   T2 remember W2 (head h2)
 *   rewind -> h1: list          must recall W1, not W2
 *                 remember W3, list   must recall W1 W3, not W2   (multi-turn after rewind, head h3)
 *   reopen store, rewind -> h2: list   must recall W1 W2, not W3   (back to the discarded branch)
 *   rewind -> h3: list          must recall W1 W3, not W2           (second rewind, alternation)
 * Every turn after a rewind also checks that blobs it newly wrote do not contain the discarded
 * branch's word. Output holds numbers and pass/fail flags only, never prompt text or agent ids.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { ensureBuilt } from "./lib/ensure-built.mjs";

ensureBuilt();

const { values: args } = parseArgs({ options: { samples: { type: "string" }, out: { type: "string" } } });
const samples = Number(args.samples ?? "3");
if (!Number.isInteger(samples) || samples < 1) throw new Error(`--samples must be a positive integer, got ${args.samples}`);
const out = args.out ?? join(".artifacts", "rewind-isolation", `results-${Date.now()}.json`);

const { resolveCursorRuntimeApiKey } = await import("../dist/cursor-api-key.js");
const { discoverModels, buildCursorModelSelection } = await import("../dist/model-discovery.js");
const { readCursorSdkTurnUsageFromUpdate } = await import("../dist/cursor-usage-accounting.js");
const { Agent, getDefaultSdkStateRoot } = await import("@cursor/sdk");
const { SqliteLocalAgentStore } = await import("@cursor/sdk/sqlite");

const apiKey = await resolveCursorRuntimeApiKey();
if (!apiKey) {
	console.error("rewind isolation probe: release-blocked, Cursor auth unavailable");
	process.exit(2);
}
await discoverModels({ apiKey });
const MODEL_ID = "grok-4.6:slow";
const selection = buildCursorModelSelection(MODEL_ID, "off");
const LIST = "List every code word I asked you to remember in this conversation, comma-separated, nothing else.";
const remember = (word) => `Remember the code word ${word}. Reply only OK.`;

/** Remove the SDK project dir it keeps for a temp workspace; refuse anything unexpected. */
async function removeSdkProjectDir(root) {
	const projectDir = dirname(dirname(await getDefaultSdkStateRoot(root)));
	if (!basename(projectDir).endsWith(basename(root))) throw new Error(`refusing to remove unexpected SDK project dir ${projectDir}`);
	rmSync(projectDir, { recursive: true, force: true });
	rmSync(root, { recursive: true, force: true });
}

async function blobIds(store, agentId) {
	const ids = new Set();
	let cursor;
	do {
		const page = await store.checkpoints.list({ filter: { agentIds: [agentId], ...(cursor ? { cursor } : {}) } });
		for (const blobId of page.items) ids.add(blobId);
		cursor = page.nextCursor;
	} while (cursor);
	return ids;
}

async function head(store, agentId) {
	const row = await store.agents.get({ agentId });
	const rootBlobId = row?.latestCheckpoint?.rootBlobId;
	if (!rootBlobId) throw new Error("agent has no checkpoint head");
	return rootBlobId;
}

async function rewind(store, agentId, rootBlobId) {
	const row = await store.agents.get({ agentId });
	if (!row) throw new Error("agent row missing");
	if (row.activeRunId) throw new Error("refusing to rewind an agent with an active run");
	await store.agents.update({ agent: { ...row, latestCheckpoint: { schemaVersion: 1, rootBlobId }, updatedAt: Date.now() } });
}

/** Send one turn; report answer flags, cache usage, and whether newly written blobs contain `forbidden`. */
async function turn(agent, store, text, expect) {
	const before = await blobIds(store, agent.agentId);
	const usages = [];
	const run = await agent.send(text, {
		model: selection,
		onDelta: ({ update }) => {
			const usage = readCursorSdkTurnUsageFromUpdate(update);
			if (usage) usages.push(usage);
		},
	});
	const result = await run.wait();
	const answer = String(result?.result ?? "").toUpperCase();
	let newBlobLeak = false;
	let newBlobs = 0;
	const written = new Set();
	for (const blobId of await blobIds(store, agent.agentId)) {
		if (before.has(blobId)) continue;
		newBlobs += 1;
		const bytes = Buffer.from(await store.checkpoints.get({ agentId: agent.agentId, blobId }));
		if (expect.absent.some((word) => bytes.includes(Buffer.from(word)))) newBlobLeak = true;
		for (const word of expect.written) if (bytes.includes(Buffer.from(word))) written.add(word);
	}
	const sum = (key) => usages.reduce((total, usage) => total + usage[key], 0);
	return {
		runStatus: result?.status ?? null,
		recalled: expect.present.every((word) => answer.includes(word)),
		leaked: expect.absent.some((word) => answer.includes(word)),
		newBlobs,
		newBlobLeak,
		// Positive control: the scan must see words this turn legitimately wrote, or a clean scan proves nothing.
		scanSawWritten: expect.written.every((word) => written.has(word)),
		inputTokens: usages.length ? sum("inputTokens") : null,
		cacheReadTokens: usages.length ? sum("cacheReadTokens") : null,
	};
}

async function sample(index) {
	const suffix = () => randomBytes(3).toString("hex").toUpperCase();
	const [w1, w2, w3] = [`ALPHA${suffix()}`, `BETA${suffix()}`, `GAMMA${suffix()}`];
	const root = mkdtempSync(join(tmpdir(), "cursor-rewind-isolation-"));
	let store = await SqliteLocalAgentStore.open({ workspaceRef: root, stateRoot: root });
	const options = () => ({ apiKey, model: selection, local: { cwd: root, store, settingSources: [] } });
	let agent;
	const checks = {};
	try {
		agent = await Agent.create(options());
		const agentId = agent.agentId;
		const none = { present: [], absent: [], written: [] };
		await turn(agent, store, remember(w1), none);
		const h1 = await head(store, agentId);
		await turn(agent, store, remember(w2), none);
		const h2 = await head(store, agentId);
		await agent[Symbol.asyncDispose]();

		await rewind(store, agentId, h1);
		agent = await Agent.resume(agentId, options());
		checks.rewindToW1 = await turn(agent, store, LIST, { present: [w1], absent: [w2], written: [w1] });
		checks.rememberW3 = await turn(agent, store, remember(w3), { present: [], absent: [w2], written: [w3] });
		const h3 = await head(store, agentId);
		checks.listAfterW3 = await turn(agent, store, LIST, { present: [w1, w3], absent: [w2], written: [w1, w3] });
		await agent[Symbol.asyncDispose]();

		await store.dispose();
		store = await SqliteLocalAgentStore.open({ workspaceRef: root, stateRoot: root });
		await rewind(store, agentId, h2);
		agent = await Agent.resume(agentId, options());
		checks.reopenRewindToW2 = await turn(agent, store, LIST, { present: [w1, w2], absent: [w3], written: [w1, w2] });
		await agent[Symbol.asyncDispose]();

		await rewind(store, agentId, h3);
		agent = await Agent.resume(agentId, options());
		checks.rewindToW3 = await turn(agent, store, LIST, { present: [w1, w3], absent: [w2], written: [w1, w3] });
		await agent[Symbol.asyncDispose]();
		agent = undefined;

		const runs = (await store.runs.list({ filter: { agentIds: [agentId] } })).items;
		return {
			sample: index,
			checks,
			blobCount: (await blobIds(store, agentId)).size,
			runCount: runs.length,
			activeRunAfter: (await store.agents.get({ agentId }))?.activeRunId ?? null,
		};
	} finally {
		await agent?.[Symbol.asyncDispose]().catch(() => undefined);
		await store.dispose().catch(() => undefined);
		await removeSdkProjectDir(root);
	}
}

const results = [];
let failure;
try {
	for (let index = 0; index < samples; index += 1) {
		const result = await sample(index);
		results.push(result);
		const flags = Object.entries(result.checks).map(([name, check]) => `${name}=${check.recalled && !check.leaked && !check.newBlobLeak && check.scanSawWritten ? "ok" : "FAIL"}`);
		console.error(`[rewind-isolation] sample ${index}: ${flags.join(" ")}`);
	}
} catch (error) {
	failure = error;
}

const passed = results.length === samples && results.every((result) => Object.values(result.checks)
	.every((check) => check.runStatus === "finished" && check.recalled && !check.leaked && !check.newBlobLeak && check.scanSawWritten));
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ model: MODEL_ID, selection, samples, results, passed, failure: failure ? String(failure.message ?? failure) : null }, null, "\t")}\n`);
console.error(`[rewind-isolation] raw results: ${out}`);
if (failure) {
	console.error(`rewind isolation probe: failed: ${failure instanceof Error ? failure.message : String(failure)}`);
	process.exit(1);
}
console.log(`rewind isolation probe: ${passed ? "passed" : "isolation not shown"}`);
process.exit(passed ? 0 : 1);
