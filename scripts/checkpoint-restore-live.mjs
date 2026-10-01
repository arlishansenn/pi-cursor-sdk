#!/usr/bin/env node
/**
 * Live acceptance for default-on checkpoint restore through the production provider path.
 * Pi contexts drive streamCursor: ALPHA, then BETA, then a branch back to after ALPHA with the
 * pooled agent still live (context-divergence path). That branch must restore the ALPHA
 * checkpoint into a new agent and send incrementally (so an empty or bootstrap-replayed history
 * fails). Then the real /tree lifecycle handlers empty the pool and the BETA branch must restore
 * before any create (empty-pool path). The script never copies checkpoint data itself.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ensureBuilt } from "./lib/ensure-built.mjs";

ensureBuilt();

const root = mkdtempSync(join(tmpdir(), "cursor-checkpoint-live-"));
const sessionFile = join(root, "session.jsonl");
const actionsLog = join(root, "actions.jsonl");
delete process.env.PI_CURSOR_CHECKPOINT_RESTORE;
process.env.PI_CURSOR_SETTING_SOURCES = "none";
process.env.CURSOR_SDK_ACTIONS_LOG = actionsLog;

const { resolveCursorRuntimeApiKey } = await import("../dist/cursor-api-key.js");
const { discoverModels } = await import("../dist/model-discovery.js");
const { streamCursor } = await import("../dist/cursor-provider.js");
const { registerCursorSessionScope } = await import("../dist/cursor-session-scope.js");
const { disposeAllSessionCursorAgents } = await import("../dist/cursor-session-agent.js");
const { registerCursorSessionAgentLifecycle } = await import("../dist/cursor-session-agent-lifecycle.js");
const { __testUtils: actionLog } = await import("../dist/cursor-actions-log.js");
const { getDefaultSdkStateRoot } = await import("@cursor/sdk");

const apiKey = await resolveCursorRuntimeApiKey();
if (!apiKey) {
	rmSync(root, { recursive: true, force: true });
	console.error("checkpoint restore live verification: release-blocked, Cursor auth unavailable");
	process.exit(2);
}

const handlers = new Map();
registerCursorSessionScope({ on: (event, handler) => handlers.set(event, handler) });
await handlers.get("session_start")({}, {
	cwd: root,
	sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "checkpoint-live", getSessionName: () => undefined },
	isProjectTrusted: () => false,
});
const lifecycle = new Map();
registerCursorSessionAgentLifecycle({ on: (event, handler) => lifecycle.set(event, handler) });
/** Same pool effects as a real pi `/tree` navigation: invalidate, then reset. */
async function navigateTree() {
	await lifecycle.get("session_before_tree")({});
	await lifecycle.get("session_tree")({});
}
await discoverModels({ apiKey });
const model = {
	id: "grok-4.6:slow", name: "grok-4.6:slow", api: "cursor-sdk", provider: "cursor", baseUrl: "", reasoning: false,
	input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384,
};
const user = (content, timestamp) => ({ role: "user", content, timestamp });
const LIST = "List every code word I asked you to remember in this conversation, comma-separated, nothing else.";

async function turn(messages) {
	for await (const event of streamCursor(model, { messages }, { apiKey })) {
		if (event.type === "done") return event.message;
		if (event.type === "error") throw new Error(`Cursor turn failed: ${event.error?.errorMessage ?? "unknown"}`);
	}
	throw new Error("Cursor turn ended without a done event");
}
const textOf = (message) => message.content.filter((block) => block.type === "text").map((block) => block.text).join("");

async function journal() {
	await actionLog.flush();
	return readFileSync(actionsLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

/** Rows written after `from` must show a successful restore resume, no fallback, and an incremental send. */
function assertRestored(rows, from, label) {
	const window = rows.slice(from);
	const resumed = window.find((row) => row.action === "agent_resume" && row.phase === "success");
	if (!resumed) throw new Error(`${label}: no checkpoint resume`);
	if (window.some((row) => row.reason === "checkpoint_restore_fallback")) throw new Error(`${label}: restore fell back to create`);
	if (window.some((row) => row.action === "agent_create")) throw new Error(`${label}: created an agent instead of restoring`);
	const sends = window.filter((row) => row.action === "prompt_build");
	if (sends.at(-1)?.mode !== "incremental") throw new Error(`${label}: restored send was not incremental`);
	return resumed.agentId;
}

let failure;
try {
	const alpha = [user("Remember the code word ALPHA. Reply only OK.", 1)];
	const alphaReply = await turn(alpha);
	const beta = [...alpha, alphaReply, user("Also remember the code word BETA. Reply only OK.", 2)];
	const betaReply = await turn(beta);
	const sourceAgentId = (await journal()).find((row) => row.action === "agent_create" && row.phase === "success")?.agentId;

	let mark = (await journal()).length;
	const alphaBranch = textOf(await turn([...alpha, alphaReply, user(LIST, 3)])).toUpperCase();
	const alphaTarget = assertRestored(await journal(), mark, "ALPHA branch");
	if (alphaTarget === sourceAgentId) throw new Error("ALPHA branch resumed the source agent instead of a copy");
	if (!alphaBranch.includes("ALPHA") || alphaBranch.includes("BETA")) throw new Error(`ALPHA branch answer is wrong: ${alphaBranch}`);

	await navigateTree();
	mark = (await journal()).length;
	const betaBranch = textOf(await turn([...beta, betaReply, user(LIST, 4)])).toUpperCase();
	const betaTarget = assertRestored(await journal(), mark, "BETA branch");
	if (betaTarget === alphaTarget || betaTarget === sourceAgentId) throw new Error("BETA branch did not restore into a fresh copy");
	if (!betaBranch.includes("ALPHA") || !betaBranch.includes("BETA")) throw new Error(`BETA branch answer is wrong: ${betaBranch}`);

	console.log("checkpoint restore live verification: passed");
} catch (error) {
	failure = error;
} finally {
	await disposeAllSessionCursorAgents().catch(() => undefined);
	await actionLog.flush();
	// The SDK keeps this temp workspace's store and agent transcripts under a per-workspace project dir.
	const projectDir = dirname(dirname(await getDefaultSdkStateRoot(root)));
	if (!basename(projectDir).endsWith(basename(root))) throw new Error(`refusing to remove unexpected SDK project dir ${projectDir}`);
	rmSync(projectDir, { recursive: true, force: true });
	rmSync(root, { recursive: true, force: true });
}
if (failure) {
	console.error(`checkpoint restore live verification: failed: ${failure instanceof Error ? failure.message : String(failure)}`);
	process.exit(1);
}
