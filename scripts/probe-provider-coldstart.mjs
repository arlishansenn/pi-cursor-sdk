#!/usr/bin/env node
/**
 * Maintainer probe: measure first local Cursor *provider* turn cold-start timing
 * (streamCursor path: prep → bridge/store → create/resume → bootstrap → send)
 * after a fixed preflight (model discovery + Cursor SDK preload) so every
 * scenario samples the same boundary regardless of host model-cache state.
 * Distinct from scripts/probe-mcp-coldstart.mjs (direct Agent.create).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { ensureBuilt } from "./lib/ensure-built.mjs";
import { apiKeySecretsFromProcess, defaultApiKeyFromEnv, parseArgv } from "./lib/cursor-cli-args.mjs";
import { CHILD_PROCESS_TREE_SPAWN_OPTIONS, terminateChild } from "./lib/cursor-child-process.mjs";
import {
	buildCursorSmokeEnv,
	CURSOR_SDK_EVENT_DEBUG_DIR_ENV,
	CURSOR_SDK_EVENT_DEBUG_ENV,
	CURSOR_SDK_EVENT_DEBUG_ENV_NAMES,
} from "./lib/cursor-smoke-env.mjs";
import { createScriptFail } from "./lib/cursor-script-fail.mjs";
import { scrubSensitiveText } from "../shared/cursor-sensitive-text.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_MODEL_ID = "composer-2.5";
const DEFAULT_SCENARIO_TIMEOUT_MS = 15 * 60_000;
const MAX_CHILD_OUTPUT_BYTES = 4 * 1024 * 1024;

function isMainModule() {
	if (!process.argv[1]) return false;
	const invoked = resolve(process.argv[1]);
	return process.platform === "win32"
		? SCRIPT_PATH.toLowerCase() === invoked.toLowerCase()
		: SCRIPT_PATH === invoked;
}

const SCENARIOS = [
	{ label: "provider-all-settings", settingSources: "all", turns: 1 },
	{ label: "provider-no-setting-sources", settingSources: "none", turns: 1, debugCapture: true },
	{ label: "provider-warm-second-turn", settingSources: "none", turns: 2 },
	{ label: "provider-warmup-first-prompt", settingSources: "none", turns: 1, warmup: true, debugCapture: true },
];

// Paid A/B equivalence arms: the no-setting-sources cold arm versus the warmup arm.
const WARM_EQUIVALENCE_COLD_LABEL = "provider-no-setting-sources";
const WARM_EQUIVALENCE_WARM_LABEL = "provider-warmup-first-prompt";
const WARMUP_POLL_INTERVAL_MS = 250;
const WARMUP_READY_TIMEOUT_MS = 30_000;

const liveChildren = new Set();
let signalCleanupInstalled = false;

/**
 * Parent-interrupt cleanup: terminating the orchestrator must not orphan the
 * detached scenario children it owns. Bounded so an interrupt always exits.
 */
function installSignalCleanup() {
	if (signalCleanupInstalled) return;
	signalCleanupInstalled = true;
	const shutdown = (exitCode) => {
		void Promise.race([
			Promise.allSettled([...liveChildren].map((child) => terminateChild(child))),
			new Promise((resolveExit) => setTimeout(resolveExit, 10_000)),
		]).finally(() => process.exit(exitCode));
	};
	process.once("SIGINT", () => shutdown(130));
	process.once("SIGTERM", () => shutdown(143));
}

const exitWithFailure = createScriptFail("probe-provider-coldstart");

function fail(message, secrets) {
	const secretList = secrets === undefined ? [] : Array.isArray(secrets) ? secrets : [secrets];
	exitWithFailure(message, secretList.filter(Boolean));
}

/** Canonical scrub over the full secret set this invocation can carry. */
function scrubAll(text, secrets) {
	return secrets.reduce(
		(scrubbed, secret) => (secret ? scrubSensitiveText(scrubbed, secret) : scrubbed),
		scrubSensitiveText(text),
	);
}

/** Sync the CLI-provided key into the child environment so warmup admission resolves the same credentials as the prompt turn. */
export function syncChildApiKeyEnv(apiKey, env = process.env) {
	if (apiKey) env.CURSOR_API_KEY = apiKey;
	return env;
}

const SCRUBBED_TEXT_EXTENSIONS = new Set([".ndjson", ".txt", ".md", ".log"]);

/** Scrub every string leaf of a parsed JSON value and re-serialize: raw-text replacement can corrupt JSON when a secret spans quote or brace characters. */
function scrubJsonValue(value, secrets) {
	if (typeof value === "string") return scrubAll(value, secrets);
	if (Array.isArray(value)) return value.map((item) => scrubJsonValue(item, secrets));
	if (value && typeof value === "object") {
		const scrubbed = {};
		for (const [key, item] of Object.entries(value)) scrubbed[key] = scrubJsonValue(item, secrets);
		return scrubbed;
	}
	return value;
}

function scrubDebugTextFile(from, to, secrets) {
	const text = readFileSync(from, "utf8");
	if (extname(from).toLowerCase() === ".json") {
		try {
			writeFileSync(to, `${JSON.stringify(scrubJsonValue(JSON.parse(text), secrets), null, 2)}\n`);
			return;
		} catch {
			// Fall through to raw scrubbing for non-JSON files with a .json extension.
		}
	}
	writeFileSync(to, scrubAll(text, secrets));
}

/** Copy debug artifacts into a fresh destination, scrubbing text files at the boundary: the sink records raw error text that may echo credentials. */
export function copyDebugEventsScrubbed(source, destination, secrets) {
	rmSync(destination, { recursive: true, force: true });
	mkdirSync(destination, { recursive: true, mode: 0o700 });
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		const from = join(source, entry.name);
		const to = join(destination, entry.name);
		if (entry.isDirectory()) {
			copyDebugEventsScrubbed(from, to, secrets);
			continue;
		}
		if (!entry.isFile()) continue;
		if (SCRUBBED_TEXT_EXTENSIONS.has(extname(from).toLowerCase()) || extname(from).toLowerCase() === ".json") {
			scrubDebugTextFile(from, to, secrets);
			continue;
		}
		copyFileSync(from, to);
	}
}

function findScenario(label) {
	return SCENARIOS.find((scenario) => scenario.label === label);
}

function parseArgs(argv, env, secrets) {
	return parseArgv(argv, {
		defaults: {
			apiKey: defaultApiKeyFromEnv(env),
			scenario: undefined,
			outDir: undefined,
			model: undefined,
			timeoutMs: DEFAULT_SCENARIO_TIMEOUT_MS,
		},
		flags: {
			apiKey: { names: ["--api-key"], assign: (value) => value.trim() },
			scenario: { names: ["--scenario"], assign: (value) => value.trim() },
			outDir: { names: ["--out-dir"], assign: (value) => value.trim() },
			model: { names: ["--model"], assign: (value) => value.trim() },
			timeoutMs: {
				names: ["--timeout-ms"],
				assign: (value) => {
					const parsed = Number(value);
					if (!Number.isFinite(parsed) || parsed <= 0) fail("--timeout-ms must be a positive number of milliseconds", secrets);
					return Math.trunc(parsed);
				},
			},
		},
		fail: (message) => fail(message, secrets),
	});
}

function printHelp() {
	console.log(`Measure Cursor provider-path first-turn cold-start timing.

Sampled boundary: every scenario runs the same preflight (model discovery plus an
explicit Cursor SDK preload) in a fresh child process, then samples the first
provider turn(s) after that preflight (prep → bridge/store → create/resume →
bootstrap → send → first text). Host model-cache state cannot change what a
sample covers; sdk_load inside a sampled turn measures an already-preloaded SDK.

Usage:
  CURSOR_API_KEY=... npm run debug:provider-coldstart
  node scripts/probe-provider-coldstart.mjs [options]

Options:
  --api-key <key>     Cursor API key. Prefer CURSOR_API_KEY.
  --scenario <label>  Run one scenario in this process (orchestrator child).
  --model <id>        Model id from the discovery output (default: composer-2.5,
                      else the first discovered model).
  --out-dir <path>    Write journals/summary under this directory.
  --timeout-ms <ms>   Per-scenario child wall-clock deadline (default 900000).
  -h, --help          Show help without building or importing the Cursor SDK.

Scenarios (each runs in a fresh child process; the probe exits non-zero when any
scenario fails to sample):
  provider-all-settings         PI_CURSOR_SETTING_SOURCES=all, one turn
  provider-no-setting-sources   PI_CURSOR_SETTING_SOURCES=none, one turn,
                                debug capture
  provider-warm-second-turn     none sources, two turns in one process
  provider-warmup-first-prompt  none sources, same-key agent warmup before the
                                first prompt, one turn, debug capture

When both debug-capture arms finish, their first-turn prompt text and send
payloads are compared (work dir and scenario label normalized) and the verdict
is written to <out-dir>/equivalence.json.

Safety:
  - --help never builds, imports the SDK, or performs live Cursor calls.
  - No prompt/result text is written to stdout artifacts (status/ids/timings only).
  - debugCapture scenarios copy raw provider debug events (may contain prompt
    text, tool results, and local paths) to <out-dir>/<label>.debug-events.`);
}

function readJsonl(path) {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

function actionDuration(rows, action) {
	const row = rows.find((entry) => entry.action === action && (entry.phase === "success" || entry.phase === "error"));
	if (!row || typeof row.durationMs !== "number") return null;
	return Math.round(row.durationMs);
}

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Poll the scenario journal until the scheduled warmup publishes its agent, its
 * terminal decision/error row lands (no success can follow), or the cap hits.
 */
async function waitForSessionAgentWarmup(actionsLogPath, flush, timeoutMs = WARMUP_READY_TIMEOUT_MS, intervalMs = WARMUP_POLL_INTERVAL_MS) {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		await flush();
		const rows = readJsonl(actionsLogPath);
		if (rows.some((row) => row.action === "agent_warm" && row.phase === "success")) return true;
		if (rows.some((row) => row.action === "agent_warm" && (row.phase === "decision" || row.phase === "error"))) return false;
		if (Date.now() >= deadline) return false;
		await new Promise((resolveSleep) => setTimeout(resolveSleep, intervalMs));
	}
}

function findFirstArtifactPath(rootDir, fileName) {
	const matches = [];
	const stack = [rootDir];
	while (stack.length > 0) {
		const current = stack.pop();
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const path = join(current, entry.name);
			if (entry.isDirectory()) stack.push(path);
			else if (entry.isFile() && entry.name === fileName) matches.push(path);
		}
	}
	matches.sort();
	return matches[0];
}

/** First provider debug-event turn of one arm: send meta plus the raw send payload. */
function readProbeArmEvidence(arm, debugEventsDir, artifacts) {
	const metadataPath = findFirstArtifactPath(debugEventsDir, artifacts.metadata);
	if (!metadataPath) {
		return { promptText: "", imageCount: null, sendPayloadText: "", missing: [{ arm, file: artifacts.metadata }] };
	}
	let send;
	try {
		send = JSON.parse(readFileSync(metadataPath, "utf8"))?.send;
	} catch {
		send = undefined;
	}
	if (!send || typeof send.promptText !== "string" || typeof send.imageCount !== "number") {
		return { promptText: "", imageCount: null, sendPayloadText: "", missing: [{ arm, file: artifacts.metadata }] };
	}
	const payloadPath = join(dirname(metadataPath), artifacts.sendPayload);
	let payload;
	if (existsSync(payloadPath)) {
		try {
			payload = JSON.parse(readFileSync(payloadPath, "utf8"));
		} catch {
			payload = undefined;
		}
	}
	if (payload === undefined) {
		return {
			promptText: send.promptText,
			imageCount: send.imageCount,
			sendPayloadText: "",
			missing: [{ arm, file: artifacts.sendPayload }],
		};
	}
	return {
		promptText: send.promptText,
		imageCount: send.imageCount,
		sendPayloadText: JSON.stringify(payload),
		missing: [],
	};
}

function probeArmSummary(result) {
	return {
		label: typeof result?.label === "string" ? result.label : null,
		sendMode: result?.turns?.[0]?.journal?.sendMode ?? null,
		promptChars: typeof result?.promptChars === "number" ? result.promptChars : null,
		sendsBeforeFirstTurn: typeof result?.sendsBeforeFirstTurn === "number" ? result.sendsBeforeFirstTurn : null,
		warmReady: typeof result?.warmReady === "boolean" ? result.warmReady : null,
	};
}

/**
 * Normalize per-arm nondeterminism before comparing: the mkdtemp work dir
 * (tmpdir + provider-coldstart-<label>-XXXXXX) becomes WORK, then each arm's
 * label literal becomes SESSION. Work dir first: its path contains the label.
 */
function buildProbeArmTextNormalizer(labels, tmpRoot = tmpdir()) {
	const validLabels = labels.filter((label) => typeof label === "string" && label.length > 0);
	const workDirPatterns = validLabels.map((label) =>
		new RegExp(`${escapeRegExp(join(tmpRoot, `provider-coldstart-${label}-`))}[A-Za-z0-9]+`, "g"));
	const labelPatterns = validLabels.map((label) => new RegExp(escapeRegExp(label), "g"));
	return (text) => {
		let normalized = text;
		for (const pattern of workDirPatterns) normalized = normalized.replace(pattern, "WORK");
		for (const pattern of labelPatterns) normalized = normalized.replace(pattern, "SESSION");
		return normalized;
	};
}

function formatEquivalenceFlag(value) {
	return value === true ? "equal" : value === false ? "differs" : "missing";
}

/**
 * Compare the cold and warm arms' first provider debug-event turn for paid A/B
 * prompt equivalence. Writes <parent-of-coldDir>/equivalence.json, logs a one
 * line summary, and returns the report. Missing evidence is reported, never thrown.
 */
export async function compareWarmupPromptEquivalence({ coldDir, warmDir, coldResult, warmResult }) {
	const { ARTIFACTS } = await import("../dist/cursor-sdk-event-debug-constants.js");
	const coldArm = probeArmSummary(coldResult);
	const warmArm = probeArmSummary(warmResult);
	const normalize = buildProbeArmTextNormalizer([coldArm.label, warmArm.label]);
	const coldEvidence = readProbeArmEvidence("cold", coldDir, ARTIFACTS);
	const warmEvidence = readProbeArmEvidence("warm", warmDir, ARTIFACTS);
	const missing = [...coldEvidence.missing, ...warmEvidence.missing];
	const comparable = missing.length === 0;
	const report = {
		compared: comparable,
		missing,
		promptTextEqual: comparable ? normalize(coldEvidence.promptText) === normalize(warmEvidence.promptText) : null,
		sendPayloadEqual: comparable ? normalize(coldEvidence.sendPayloadText) === normalize(warmEvidence.sendPayloadText) : null,
		imageCountEqual: comparable ? coldEvidence.imageCount === warmEvidence.imageCount : null,
		cold: coldArm,
		warm: warmArm,
	};
	const outDir = dirname(coldDir);
	mkdirSync(outDir, { recursive: true, mode: 0o700 });
	writeFileSync(join(outDir, "equivalence.json"), `${JSON.stringify(report, null, 2)}\n`);
	const describeArm = (arm) =>
		`${arm.sendMode ?? "?"} send, ${arm.promptChars ?? "?"} chars, ${arm.sendsBeforeFirstTurn ?? "?"} pre-turn sends, warmReady=${arm.warmReady ?? "n/a"}`;
	console.log(
		`probe-provider-coldstart: warm-arm equivalence promptText=${formatEquivalenceFlag(report.promptTextEqual)}` +
			` sendPayload=${formatEquivalenceFlag(report.sendPayloadEqual)}` +
			` imageCount=${formatEquivalenceFlag(report.imageCountEqual)}` +
			`; cold: ${describeArm(report.cold)}; warm: ${describeArm(report.warm)}`,
	);
	return report;
}

/** Select the sampled model from canonical discovery output; never hand-write metadata. */
function selectModelConfig(models, requestedId) {
	if (models.length === 0) throw new Error("model discovery returned no models to sample");
	if (requestedId) {
		const exact = models.find((model) => model.id === requestedId);
		if (!exact) throw new Error(`model not present in discovery output: ${requestedId}`);
		return exact;
	}
	const preferred = models.find((model) => model.id === DEFAULT_MODEL_ID) ?? models[0];
	if (preferred.id !== DEFAULT_MODEL_ID) {
		console.error(`probe-provider-coldstart: default model ${DEFAULT_MODEL_ID} absent from catalog; sampling ${preferred.id}`);
	}
	return preferred;
}

async function runScenarioInThisProcess(args, scenario, secrets) {
	ensureBuilt();
	// Resolve everything that can fail before creating the temp work dir, so
	// process.exit paths never leak it; later failures unwind through finally.
	const { resolveCursorRuntimeApiKey } = await import("../dist/cursor-api-key.js");
	const { discoverModels } = await import("../dist/model-discovery.js");
	const { loadCursorSdk } = await import("../dist/cursor-sdk-runtime.js");
	const { streamCursor } = await import("../dist/cursor-provider.js");
	const { registerCursorSessionScope } = await import("../dist/cursor-session-scope.js");
	const disposeModule = await import("../dist/cursor-session-agent.js");
	const { registerCursorSessionAgentLifecycle } = await import("../dist/cursor-session-agent-lifecycle.js");
	const { __testUtils: actionLog } = await import("../dist/cursor-actions-log.js");
	const disposeAllSessionCursorAgents = disposeModule.disposeAllSessionCursorAgents;
	const scheduleSessionCursorAgentWarmup = disposeModule.scheduleSessionCursorAgentWarmup;

	const apiKey = args.apiKey || (await resolveCursorRuntimeApiKey());
	if (!apiKey) throw new Error("CURSOR_API_KEY is required");
	// Direct `--scenario --api-key` invocations carry the key only in argv, but the
	// warmup admission resolves credentials from the environment; sync it so the
	// warm arm pre-creates with the same key the prompt turn will use.
	syncChildApiKeyEnv(apiKey);

	const work = mkdtempSync(join(tmpdir(), `provider-coldstart-${scenario.label}-`));
	try {
		const actionsLog = join(work, "actions.jsonl");
		process.env.CURSOR_SDK_ACTIONS_LOG = actionsLog;
		process.env.PI_CURSOR_SETTING_SOURCES = scenario.settingSources;
		for (const name of CURSOR_SDK_EVENT_DEBUG_ENV_NAMES) delete process.env[name];
		const debugEventsDir = join(work, "debug-events");
		if (scenario.debugCapture) {
			process.env[CURSOR_SDK_EVENT_DEBUG_ENV] = "1";
			process.env[CURSOR_SDK_EVENT_DEBUG_DIR_ENV] = debugEventsDir;
		}

		const scopeHandlers = new Map();
		registerCursorSessionScope({ on: (event, handler) => scopeHandlers.set(event, handler) });
		registerCursorSessionAgentLifecycle({ on: () => undefined });
		// Identical preflight for every scenario: discovery (which may warm the host
		// model cache) plus an explicit SDK preload, so the sampled turn always
		// starts from "models discovered, SDK loaded" regardless of cache state.
		const models = await discoverModels({
			apiKey,
			onFallback: (issue) => console.error(`probe-provider-coldstart: model discovery fell back (${issue.reason})`),
		});
		await loadCursorSdk();
		const modelConfig = selectModelConfig(models, args.model);
		const model = { ...modelConfig, api: "cursor-sdk", provider: "cursor" };
		const modelId = modelConfig.id;

		const sessionFile = join(work, "session.jsonl");
		await scopeHandlers.get("session_start")({}, {
			cwd: work,
			sessionManager: {
				getSessionFile: () => sessionFile,
				getSessionId: () => `provider-coldstart-${scenario.label}`,
				getSessionName: () => undefined,
			},
			isProjectTrusted: () => false,
		});

		// Warm arm: explicit same-key create-ahead, exactly as the extension's
		// session_start/model_select hook would schedule it. The probe wires
		// scope/lifecycle by hand without the extension default, so nothing fires it.
		let warmReady = null;
		if (scenario.warmup) {
			scheduleSessionCursorAgentWarmup(modelId);
			warmReady = await waitForSessionAgentWarmup(actionsLog, () => actionLog.flush());
		}
		// Warm must never touch the upstream before the first real prompt: both
		// arms are expected to hold zero agent_send rows here.
		await actionLog.flush();
		const sendsBeforeFirstTurn = readJsonl(actionsLog).filter((row) => row.action === "agent_send").length;

		const turns = [];
		const messages = [];
		try {
			for (let turnIndex = 0; turnIndex < scenario.turns; turnIndex++) {
				await actionLog.flush();
				const mark = readJsonl(actionsLog).length;
				const t0 = performance.now();
				let firstTextMs;
				let doneMs;
				let errorMessage;
				messages.push({
					role: "user",
					content: turnIndex === 0 ? "Reply with exactly: pong" : "Reply with exactly: pong2",
					timestamp: turnIndex + 1,
				});
				for await (const event of streamCursor(model, { messages }, { apiKey })) {
					if (event.type === "text_delta" && firstTextMs === undefined) {
						const delta = typeof event.delta === "string" ? event.delta : "";
						if (delta.length > 0) firstTextMs = Math.round(performance.now() - t0);
					}
					if (event.type === "done") {
						doneMs = Math.round(performance.now() - t0);
						messages.push(event.message);
					}
					if (event.type === "error") {
						errorMessage = event.error?.errorMessage ?? "unknown";
					}
				}
				await actionLog.flush();
				const actions = readJsonl(actionsLog).slice(mark);
				turns.push({
					turnIndex,
					wall: {
						requestToFirstTextMs: firstTextMs ?? null,
						requestToDoneMs: doneMs ?? null,
					},
					journal: {
						agentCreateMs: actionDuration(actions, "agent_create"),
						agentResumeMs: actionDuration(actions, "agent_resume"),
						promptBuildMs: actionDuration(actions, "prompt_build"),
						agentSendMs: actionDuration(actions, "agent_send"),
						sendMode: actions.filter((row) => row.action === "prompt_build").at(-1)?.mode ?? null,
						created: actions.some((row) => row.action === "agent_create" && row.phase === "success"),
						resumed: actions.some((row) => row.action === "agent_resume" && row.phase === "success"),
						agentId: actions.find((row) => row.action === "agent_send" && row.phase === "start")?.agentId ?? null,
					},
					error: errorMessage ? scrubAll(errorMessage, secrets) : null,
				});
				if (errorMessage) break;
			}
		} finally {
			await disposeAllSessionCursorAgents().catch(() => undefined);
		}

		await actionLog.flush();
		const promptChars = readJsonl(actionsLog).find(
			(row) => row.action === "prompt_build" && typeof row.promptChars === "number",
		)?.promptChars ?? null;

		const result = {
			label: scenario.label,
			settingSources: scenario.settingSources,
			population: "provider",
			model: modelId,
			warmup: scenario.warmup === true,
			warmReady,
			sendsBeforeFirstTurn,
			promptChars,
			actionsLog,
			turns,
		};
		console.log(JSON.stringify(result));
		if (args.outDir) {
			mkdirSync(args.outDir, { recursive: true, mode: 0o700 });
			const destActions = join(args.outDir, `${scenario.label}.actions.jsonl`);
			const destSummary = join(args.outDir, `${scenario.label}.json`);
			if (existsSync(actionsLog)) {
				writeFileSync(destActions, readFileSync(actionsLog));
			}
			writeFileSync(destSummary, `${JSON.stringify(result, null, 2)}\n`);
			const destDebug = join(args.outDir, `${scenario.label}.debug-events`);
			// Fresh per run unconditionally: a reusable out-dir must never let a previous
			// run's (or a failed sample's) artifacts participate in a later equivalence
			// comparison, so a failed or capture-less run still clears the stale directory.
			rmSync(destDebug, { recursive: true, force: true });
			if (existsSync(debugEventsDir) && !turns.some((turn) => turn.error !== null)) {
				copyDebugEventsScrubbed(debugEventsDir, destDebug, secrets);
			}
		}
		// A sampled turn that errored is a failed sample: exit non-zero so the
		// orchestrator cannot fold a failed scenario into an overall success.
		if (turns.some((turn) => turn.error !== null)) process.exitCode = 1;
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

/**
 * Spawn a scenario child with the canonical process-tree options, a sealed smoke
 * environment, a wall-clock deadline, and bounded output capture. The resolved
 * result always reports failure for non-zero exits, signals, spawn errors, and
 * deadline breaches; the child tree is terminated on timeout.
 */
export async function runScenarioChildProcess({
	command,
	args,
	env,
	cwd = REPO_ROOT,
	timeoutMs = DEFAULT_SCENARIO_TIMEOUT_MS,
	maxOutputBytes = MAX_CHILD_OUTPUT_BYTES,
}) {
	const child = spawn(command, args, {
		cwd,
		env,
		stdio: ["ignore", "pipe", "pipe"],
		...CHILD_PROCESS_TREE_SPAWN_OPTIONS,
	});
	const pid = child.pid;
	installSignalCleanup();
	liveChildren.add(child);
	const buffers = { stdout: "", stderr: "" };
	let truncated = false;
	let timedOut = false;
	const capture = (stream) => (chunk) => {
		const text = String(chunk);
		const room = maxOutputBytes - buffers[stream].length;
		if (room <= 0) {
			truncated = true;
			return;
		}
		if (text.length > room) truncated = true;
		buffers[stream] += text.slice(0, room);
	};
	child.stdout?.on("data", capture("stdout"));
	child.stderr?.on("data", capture("stderr"));

	const outcome = await new Promise((resolveOutcome) => {
		let settled = false;
		const settle = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveOutcome(value);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			settle({ kind: "timeout" });
		}, timeoutMs);
		child.once("error", (error) => settle({ kind: "spawn-error", message: error instanceof Error ? error.message : String(error) }));
		child.once("close", (code, signal) => settle({ kind: "closed", code, signal }));
	});

	// Every terminal path waits for canonical process-tree cleanup before the
	// child is deregistered and the result is returned: descendants must not
	// survive the root's exit (normal, non-zero, or deadline), and a cleanup
	// verification failure is a failed sample rather than a silent orphan.
	let cleanupError;
	try {
		await terminateChild(child);
	} catch (error) {
		cleanupError = error instanceof Error ? error.message : String(error);
	}
	liveChildren.delete(child);

	return {
		ok:
			cleanupError === undefined &&
			!timedOut &&
			outcome.kind === "closed" &&
			outcome.code === 0 &&
			outcome.signal === null,
		timedOut,
		truncated,
		stdout: buffers.stdout,
		stderr: buffers.stderr,
		exitCode: outcome.kind === "closed" ? outcome.code : null,
		signal: outcome.kind === "closed" ? outcome.signal : null,
		spawnError: outcome.kind === "spawn-error" ? outcome.message : undefined,
		...(cleanupError !== undefined ? { cleanupError } : {}),
		pid,
	};
}

/** Sealed child environment per scenario, built with the canonical smoke-env builder. */
export function buildScenarioChildEnv(scenario, apiKey, baseEnv = process.env, nodePath = process.execPath) {
	const env = buildCursorSmokeEnv({
		baseEnv,
		nodePath,
		settingSources: scenario.settingSources,
	});
	env.CURSOR_API_KEY = apiKey;
	return env;
}

async function runScenarioChild(args, scenario, outDir, secrets) {
	// Clear this scenario's reusable artifacts before spawning: a child that dies in
	// preflight or hits the deadline must not leave a previous run's debug events or
	// summary where the equivalence comparison could pick them up.
	for (const stale of [`${scenario.label}.debug-events`, `${scenario.label}.json`, `${scenario.label}.actions.jsonl`]) {
		rmSync(join(outDir, stale), { recursive: true, force: true });
	}
	const childArgs = [SCRIPT_PATH, "--scenario", scenario.label, "--out-dir", outDir];
	if (args.model) childArgs.push("--model", args.model);
	const result = await runScenarioChildProcess({
		command: process.execPath,
		args: childArgs,
		env: buildScenarioChildEnv(scenario, args.apiKey),
		timeoutMs: args.timeoutMs,
	});
	const scrubbedStderr = scrubAll(result.stderr, secrets);
	if (scrubbedStderr) {
		process.stderr.write(scrubbedStderr.endsWith("\n") ? scrubbedStderr : `${scrubbedStderr}\n`);
	}
	if (result.ok && result.stdout.trim()) {
		process.stdout.write(result.stdout.endsWith("\n") ? result.stdout : `${result.stdout}\n`);
		return { ok: true };
	}
	const detail = result.timedOut
		? `scenario ${scenario.label} exceeded its ${args.timeoutMs}ms deadline`
		: result.spawnError !== undefined
			? `failed to spawn scenario child: ${result.spawnError}`
		: result.cleanupError !== undefined
			? `child exited ${result.exitCode ?? "unknown"} but process-tree cleanup failed: ${result.cleanupError}`
			: `child exited ${result.exitCode ?? "unknown"}${result.signal ? ` (${result.signal})` : ""}`;
	console.log(JSON.stringify({ label: scenario.label, error: scrubAll(scrubbedStderr.trim() || detail, secrets) }));
	return { ok: false };
}

function readScenarioSummary(path) {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

async function runWarmupEquivalenceIfAvailable(outDir, secrets, scenarioOk) {
	const coldOk = scenarioOk.get(WARM_EQUIVALENCE_COLD_LABEL) === true;
	const warmOk = scenarioOk.get(WARM_EQUIVALENCE_WARM_LABEL) === true;
	if (!coldOk || !warmOk) {
		if (coldOk || warmOk) console.error("probe-provider-coldstart: warm-arm equivalence skipped (one arm failed this run)");
		return;
	}
	const coldDir = join(outDir, `${WARM_EQUIVALENCE_COLD_LABEL}.debug-events`);
	const warmDir = join(outDir, `${WARM_EQUIVALENCE_WARM_LABEL}.debug-events`);
	if (!existsSync(coldDir) || !existsSync(warmDir)) return;
	const coldResult = readScenarioSummary(join(outDir, `${WARM_EQUIVALENCE_COLD_LABEL}.json`));
	const warmResult = readScenarioSummary(join(outDir, `${WARM_EQUIVALENCE_WARM_LABEL}.json`));
	if (!coldResult || !warmResult) {
		console.error("probe-provider-coldstart: warm-arm equivalence skipped (missing scenario summary)");
		return;
	}
	try {
		await compareWarmupPromptEquivalence({ coldDir, warmDir, coldResult, warmResult });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`probe-provider-coldstart: warm-arm equivalence failed: ${scrubAll(message, secrets)}`);
	}
}

async function main(argv = process.argv.slice(2), env = process.env) {
	// Collect every secret this invocation can carry (env + argv, both flag forms)
	// before any failure path can echo argv text back to the operator.
	const secrets = apiKeySecretsFromProcess(argv, env);
	const args = parseArgs(argv, env, secrets);
	if (args.help) {
		printHelp();
		return;
	}
	if (!args.apiKey) fail("CURSOR_API_KEY is required. Set CURSOR_API_KEY or pass --api-key.", secrets);

	const scenario = args.scenario ? findScenario(args.scenario) : undefined;
	if (args.scenario && !scenario) fail(`unknown scenario: ${args.scenario}`, secrets);

	if (scenario) {
		await runScenarioInThisProcess(args, scenario, secrets);
		return;
	}

	const outDir =
		args.outDir ??
		join(REPO_ROOT, ".artifacts", "perf-architect-2026-10-07", "probe", "provider-coldstart");
	mkdirSync(outDir, { recursive: true, mode: 0o700 });
	let failures = 0;
	const scenarioOk = new Map();
	for (const scenarioToRun of SCENARIOS) {
		console.error(`probe-provider-coldstart: running ${scenarioToRun.label}`);
		const childResult = await runScenarioChild(args, scenarioToRun, outDir, secrets);
		scenarioOk.set(scenarioToRun.label, childResult.ok);
		if (!childResult.ok) failures++;
	}
	await runWarmupEquivalenceIfAvailable(outDir, secrets, scenarioOk);
	console.error(`probe-provider-coldstart: artifacts under ${outDir}`);
	if (failures > 0) {
		console.error(`probe-provider-coldstart: ${failures}/${SCENARIOS.length} scenario(s) failed`);
		// A failed sample must fail the probe: never fold child failures into success.
		process.exitCode = 1;
	}
}

if (isMainModule()) {
	main().catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		fail(message, apiKeySecretsFromProcess());
	});
}
