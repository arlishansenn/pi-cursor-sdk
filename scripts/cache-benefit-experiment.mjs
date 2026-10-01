#!/usr/bin/env node
/**
 * Measurement for #8: does session identity / checkpoint restore change Cursor backend cache use?
 *
 * Every group runs three turns on a fresh agent: T1 sends a large unique document plus ALPHA,
 * T2 adds BETA, T3 asks for the remembered words. Only T3 differs between groups:
 *   A  provider, incremental follow-up after BETA (no divergence)
 *   B  provider, branch back to after ALPHA, default checkpoint restore (copy to a new agentId)
 *   C  provider, same branch with PI_CURSOR_CHECKPOINT_RESTORE=0 (create + bootstrap replay)
 *   B' SDK, same raw texts, copy the T1 checkpoint into a new agentId, resume, send
 *   D  SDK, same raw texts, rewind the same agent's latestCheckpoint to the T1 head, resume, send
 * B' and D differ only in agentId. Each (sample, group) has its own document nonce, so no group can
 * read another group's cache. Usage is the SDK turn-ended usage (provider lane: usage log line).
 * Output holds numbers, ids, and pass/fail flags only, never prompt text.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { ensureBuilt } from "./lib/ensure-built.mjs";

ensureBuilt();

const { values: args } = parseArgs({ options: { samples: { type: "string" }, out: { type: "string" } } });
const samples = Number(args.samples ?? "3");
if (!Number.isInteger(samples) || samples < 1) throw new Error(`--samples must be a positive integer, got ${args.samples}`);
const out = args.out ?? join(".artifacts", "cache-benefit", `results-${Date.now()}.json`);

const logRoot = mkdtempSync(join(tmpdir(), "cursor-cache-benefit-logs-"));
const actionsLog = join(logRoot, "actions.jsonl");
const usageLog = join(logRoot, "usage.jsonl");
process.env.PI_CURSOR_SETTING_SOURCES = "none";
process.env.CURSOR_SDK_ACTIONS_LOG = actionsLog;
process.env.CURSOR_SDK_USAGE_LOG = usageLog;
delete process.env.PI_CURSOR_CHECKPOINT_RESTORE;

const { resolveCursorRuntimeApiKey } = await import("../dist/cursor-api-key.js");
const { discoverModels, buildCursorModelSelection } = await import("../dist/model-discovery.js");
const { streamCursor } = await import("../dist/cursor-provider.js");
const { registerCursorSessionScope } = await import("../dist/cursor-session-scope.js");
const { disposeAllSessionCursorAgents } = await import("../dist/cursor-session-agent.js");
const { registerCursorSessionAgentLifecycle } = await import("../dist/cursor-session-agent-lifecycle.js");
const { copyCursorCheckpointPoint } = await import("../dist/cursor-checkpoint-ledger.js");
const { readCursorSdkTurnUsageFromUpdate } = await import("../dist/cursor-usage-accounting.js");
const { __testUtils: actionLog } = await import("../dist/cursor-actions-log.js");
const { Agent, getDefaultSdkStateRoot } = await import("@cursor/sdk");
const { SqliteLocalAgentStore } = await import("@cursor/sdk/sqlite");

const apiKey = await resolveCursorRuntimeApiKey();
if (!apiKey) {
	rmSync(logRoot, { recursive: true, force: true });
	console.error("cache benefit experiment: release-blocked, Cursor auth unavailable");
	process.exit(2);
}

const scopeHandlers = new Map();
registerCursorSessionScope({ on: (event, handler) => scopeHandlers.set(event, handler) });
registerCursorSessionAgentLifecycle({ on: () => undefined });
await discoverModels({ apiKey });
const MODEL_ID = "grok-4.6:slow";
const selection = buildCursorModelSelection(MODEL_ID, "off");
const model = {
	id: MODEL_ID, name: MODEL_ID, api: "cursor-sdk", provider: "cursor", baseUrl: "", reasoning: false,
	input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384,
};

const ALPHA = "Remember the code word ALPHA. Reply only OK.";
const BETA = "Also remember the code word BETA. Reply only OK.";
const LIST = "List every code word I asked you to remember in this conversation, comma-separated, nothing else.";
const user = (content, timestamp) => ({ role: "user", content, timestamp });

/** About 6k tokens, unique per group so its prefix cannot be cached by any other group. */
function documentFor(nonce) {
	const lines = [`Reference ledger ${nonce}. Read it, you will not be asked about it.`];
	for (let i = 0; i < 300; i += 1) {
		const digest = createHash("sha256").update(`${nonce}:${i}`).digest("hex");
		lines.push(`Line ${i}: account ${digest.slice(0, 16)} moved ${parseInt(digest.slice(16, 20), 16)} units to ${digest.slice(20, 36)}.`);
	}
	return lines.join("\n");
}

function readJsonl(path) {
	return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

/** Remove the SDK project dir it keeps for a temp workspace; refuse anything unexpected. */
async function removeSdkProjectDir(root) {
	const projectDir = dirname(dirname(await getDefaultSdkStateRoot(root)));
	if (!basename(projectDir).endsWith(basename(root))) throw new Error(`refusing to remove unexpected SDK project dir ${projectDir}`);
	rmSync(projectDir, { recursive: true, force: true });
	rmSync(root, { recursive: true, force: true });
}

const answerFlags = (text) => ({ alpha: /ALPHA/i.test(text), beta: /BETA/i.test(text) });

async function providerTurn(messages) {
	await actionLog.flush();
	const actionMark = readJsonl(actionsLog).length;
	const usageMark = readJsonl(usageLog).length;
	const start = performance.now();
	let message;
	for await (const event of streamCursor(model, { messages }, { apiKey })) {
		if (event.type === "done") message = event.message;
		if (event.type === "error") throw new Error(`Cursor turn failed: ${event.error?.errorMessage ?? "unknown"}`);
	}
	if (!message) throw new Error("Cursor turn ended without a done event");
	const ms = Math.round(performance.now() - start);
	await actionLog.flush();
	const actions = readJsonl(actionsLog).slice(actionMark);
	const usage = readJsonl(usageLog).slice(usageMark).at(-1);
	const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
	return {
		message,
		record: {
			ms,
			usageSource: usage?.source ?? null,
			inputTokens: usage?.inputTokens ?? null,
			cacheReadTokens: usage?.cacheReadTokens ?? null,
			cacheWriteTokens: usage?.cacheWriteTokens ?? null,
			outputTokens: usage?.outputTokens ?? null,
			created: actions.filter((row) => row.action === "agent_create" && row.phase === "success").length,
			resumed: actions.filter((row) => row.action === "agent_resume" && row.phase === "success").length,
			sendMode: actions.filter((row) => row.action === "prompt_build").at(-1)?.mode ?? null,
			agentId: actions.filter((row) => row.action === "agent_send" && row.phase === "start").at(-1)?.agentId ?? null,
			answer: answerFlags(text),
		},
	};
}

async function providerGroup(group, sample) {
	const root = mkdtempSync(join(tmpdir(), `cursor-cache-${group}-`));
	if (group === "C") process.env.PI_CURSOR_CHECKPOINT_RESTORE = "0";
	else delete process.env.PI_CURSOR_CHECKPOINT_RESTORE;
	const sessionFile = join(root, "session.jsonl");
	await scopeHandlers.get("session_start")({}, {
		cwd: root,
		sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => `cache-${group}-${sample}`, getSessionName: () => undefined },
		isProjectTrusted: () => false,
	});
	try {
		const alpha = [user(`${documentFor(randomUUID())}\n\n${ALPHA}`, 1)];
		const t1 = await providerTurn(alpha);
		const beta = [...alpha, t1.message, user(BETA, 2)];
		const t2 = await providerTurn(beta);
		const t3Context = group === "A" ? [...beta, t2.message, user(LIST, 3)] : [...alpha, t1.message, user(LIST, 3)];
		const t3 = await providerTurn(t3Context);
		return { t1: t1.record, t2: t2.record, t3: t3.record };
	} finally {
		await disposeAllSessionCursorAgents().catch(() => undefined);
		delete process.env.PI_CURSOR_CHECKPOINT_RESTORE;
		await removeSdkProjectDir(root);
	}
}

async function sdkTurn(agent, text) {
	const usages = [];
	const start = performance.now();
	const run = await agent.send(text, {
		model: selection,
		onDelta: ({ update }) => {
			const usage = readCursorSdkTurnUsageFromUpdate(update);
			if (usage) usages.push(usage);
		},
	});
	const result = await run.wait();
	const ms = Math.round(performance.now() - start);
	const sum = (key) => (usages.length ? usages.reduce((total, usage) => total + usage[key], 0) : null);
	return {
		ms,
		usageSource: usages.length ? "turn" : null,
		turnEndedCount: usages.length,
		inputTokens: sum("inputTokens"),
		cacheReadTokens: sum("cacheReadTokens"),
		cacheWriteTokens: sum("cacheWriteTokens"),
		outputTokens: sum("outputTokens"),
		runStatus: result?.status ?? null,
		agentId: agent.agentId,
		answer: answerFlags(String(result?.result ?? "")),
	};
}

async function sdkGroup(group, sample) {
	const root = mkdtempSync(join(tmpdir(), `cursor-cache-${group === "B'" ? "Bsdk" : group}-`));
	const store = await SqliteLocalAgentStore.open({ workspaceRef: root, stateRoot: root });
	const options = { apiKey, model: selection, local: { cwd: root, store, settingSources: [] } };
	let resumed;
	try {
		const source = await Agent.create(options);
		const t1 = await sdkTurn(source, `${documentFor(randomUUID())}\n\n${ALPHA}`);
		const t1Head = (await store.agents.get({ agentId: source.agentId }))?.latestCheckpoint?.rootBlobId;
		const t1Blobs = [...(await store.checkpoints.list({ filter: { agentIds: [source.agentId] } })).items];
		if (!t1Head || !t1Blobs.includes(t1Head)) throw new Error(`${group} sample ${sample}: T1 checkpoint head missing`);
		const t2 = await sdkTurn(source, BETA);
		await source[Symbol.asyncDispose]();
		let targetAgentId;
		if (group === "D") {
			const row = await store.agents.get({ agentId: source.agentId });
			await store.agents.update({ agent: { ...row, latestCheckpoint: { schemaVersion: 1, rootBlobId: t1Head }, updatedAt: Date.now() } });
			targetAgentId = source.agentId;
		} else {
			targetAgentId = await copyCursorCheckpointPoint(store, {
				version: 1, scopeKey: `cache-${sample}`, contextFingerprint: "", messageCount: 1, sourceAgentId: source.agentId,
				blobIds: t1Blobs, headBlobId: t1Head, storeIdentity: { version: 1, stateRoot: root }, createdAt: new Date().toISOString(),
			});
		}
		resumed = await Agent.resume(targetAgentId, options);
		const t3 = await sdkTurn(resumed, LIST);
		return { t1, t2, t3, sourceAgentId: source.agentId };
	} finally {
		await resumed?.[Symbol.asyncDispose]().catch(() => undefined);
		await store.dispose().catch(() => undefined);
		await removeSdkProjectDir(root);
	}
}

const GROUPS = ["A", "B", "C", "B'", "D"];
const runs = [];
let failure;
try {
	for (let sample = 0; sample < samples; sample += 1) {
		// Rotate group order per sample so no group always runs first or last.
		const order = [...GROUPS.slice(sample % GROUPS.length), ...GROUPS.slice(0, sample % GROUPS.length)];
		for (const group of order) {
			const started = new Date().toISOString();
			const result = group === "B'" || group === "D" ? await sdkGroup(group, sample) : await providerGroup(group, sample);
			runs.push({ sample, group, started, ...result });
			const t3 = result.t3;
			console.error(`[cache-benefit] sample ${sample} ${group}: T3 input=${t3.inputTokens} cacheRead=${t3.cacheReadTokens} cacheWrite=${t3.cacheWriteTokens} ms=${t3.ms}`);
		}
	}
} catch (error) {
	failure = error;
} finally {
	await disposeAllSessionCursorAgents().catch(() => undefined);
	rmSync(logRoot, { recursive: true, force: true });
}

const median = (values) => {
	const sorted = values.filter((value) => typeof value === "number").sort((a, b) => a - b);
	if (!sorted.length) return null;
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const summary = Object.fromEntries(GROUPS.map((group) => {
	const groupRuns = runs.filter((run) => run.group === group);
	const turn = (key) => ({
		inputTokens: median(groupRuns.map((run) => run[key].inputTokens)),
		cacheReadTokens: median(groupRuns.map((run) => run[key].cacheReadTokens)),
		cacheWriteTokens: median(groupRuns.map((run) => run[key].cacheWriteTokens)),
		ms: median(groupRuns.map((run) => run[key].ms)),
	});
	return [group, { n: groupRuns.length, t1: turn("t1"), t2: turn("t2"), t3: turn("t3") }];
}));

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ model: MODEL_ID, selection, samples, runs, summary, failure: failure ? String(failure.message ?? failure) : null }, null, "\t")}\n`);
console.log(JSON.stringify(summary, null, 2));
console.error(`[cache-benefit] raw results: ${out}`);
if (failure) {
	console.error(`cache benefit experiment: failed: ${failure instanceof Error ? failure.message : String(failure)}`);
	process.exit(1);
}
