#!/usr/bin/env node
/**
 * Maintainer probe: measure first local Cursor *provider* turn cold-start timing
 * (streamCursor path: prep → bridge/store → create/resume → bootstrap → send).
 * Distinct from scripts/probe-mcp-coldstart.mjs (direct Agent.create).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { ensureBuilt } from "./lib/ensure-built.mjs";
import { apiKeySecretsFromProcess, defaultApiKeyFromEnv, parseArgv } from "./lib/cursor-cli-args.mjs";
import { createScriptFail } from "./lib/cursor-script-fail.mjs";
import { scrubSensitiveText } from "../shared/cursor-sensitive-text.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function isMainModule() {
	if (!process.argv[1]) return false;
	const invoked = resolve(process.argv[1]);
	return process.platform === "win32"
		? SCRIPT_PATH.toLowerCase() === invoked.toLowerCase()
		: SCRIPT_PATH === invoked;
}

const SCENARIOS = [
	{ label: "provider-all-settings", settingSources: "all", turns: 1 },
	{ label: "provider-no-setting-sources", settingSources: "none", turns: 1 },
	{ label: "provider-warm-second-turn", settingSources: "none", turns: 2 },
];

const exitWithFailure = createScriptFail("probe-provider-coldstart");

function fail(message, secrets) {
	const secretList = secrets === undefined ? [] : Array.isArray(secrets) ? secrets : [secrets];
	exitWithFailure(message, secretList.filter(Boolean));
}

function findScenario(label) {
	return SCENARIOS.find((scenario) => scenario.label === label);
}

function parseArgs(argv, env) {
	return parseArgv(argv, {
		defaults: {
			apiKey: defaultApiKeyFromEnv(env),
			scenario: undefined,
			outDir: undefined,
		},
		flags: {
			apiKey: { names: ["--api-key"], assign: (value) => value.trim() },
			scenario: { names: ["--scenario"], assign: (value) => value.trim() },
			outDir: { names: ["--out-dir"], assign: (value) => value.trim() },
		},
		fail: (message) => fail(message, defaultApiKeyFromEnv(env)),
	});
}

function printHelp() {
	console.log(`Measure Cursor provider-path first-turn cold-start timing.

Usage:
  CURSOR_API_KEY=... npm run debug:provider-coldstart
  node scripts/probe-provider-coldstart.mjs [options]

Options:
  --api-key <key>     Cursor API key. Prefer CURSOR_API_KEY.
  --scenario <label>  Run one scenario in this process (orchestrator child).
  --out-dir <path>    Write journals/summary under this directory.
  -h, --help          Show help without importing the Cursor SDK.

Scenarios (each cold scenario uses a fresh Node child before first SDK import):
  provider-all-settings         PI_CURSOR_SETTING_SOURCES=all, one turn
  provider-no-setting-sources   PI_CURSOR_SETTING_SOURCES=none, one turn
  provider-warm-second-turn     none sources, two turns in one process

Safety:
  - --help never performs live Cursor calls.
  - No prompt/result text is written to stdout artifacts (status/ids/timings only).`);
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

async function runScenarioInThisProcess(args, scenario) {
	ensureBuilt();
	const work = mkdtempSync(join(tmpdir(), `provider-coldstart-${scenario.label}-`));
	const actionsLog = join(work, "actions.jsonl");
	process.env.CURSOR_SDK_ACTIONS_LOG = actionsLog;
	process.env.PI_CURSOR_SETTING_SOURCES = scenario.settingSources;
	process.env.PI_CURSOR_SDK_EVENT_DEBUG = "0";

	const { resolveCursorRuntimeApiKey } = await import("../dist/cursor-api-key.js");
	const { discoverModels } = await import("../dist/model-discovery.js");
	const { streamCursor } = await import("../dist/cursor-provider.js");
	const { registerCursorSessionScope } = await import("../dist/cursor-session-scope.js");
	const { disposeAllSessionCursorAgents } = await import("../dist/cursor-session-agent.js");
	const { registerCursorSessionAgentLifecycle } = await import("../dist/cursor-session-agent-lifecycle.js");
	const { __testUtils: actionLog } = await import("../dist/cursor-actions-log.js");

	const apiKey = args.apiKey || (await resolveCursorRuntimeApiKey());
	if (!apiKey) fail("CURSOR_API_KEY is required", args.apiKey);

	const scopeHandlers = new Map();
	registerCursorSessionScope({ on: (event, handler) => scopeHandlers.set(event, handler) });
	registerCursorSessionAgentLifecycle({ on: () => undefined });
	await discoverModels({ apiKey });

	const modelId = "composer-2.5";
	const model = {
		id: modelId,
		name: modelId,
		api: "cursor-sdk",
		provider: "cursor",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16384,
	};

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

	const turns = [];
	try {
		const messages = [];
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
					const text = event.message?.content
						?.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("") ?? "";
					messages.push(event.message);
					void text;
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
				error: errorMessage ? scrubSensitiveText(errorMessage, apiKey) : null,
			});
			if (errorMessage) break;
		}
	} finally {
		await disposeAllSessionCursorAgents().catch(() => undefined);
	}

	const result = {
		label: scenario.label,
		settingSources: scenario.settingSources,
		population: "provider",
		model: modelId,
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
	}
	rmSync(work, { recursive: true, force: true });
}

function runScenarioChild(args, scenario, outDir) {
	return new Promise((resolve) => {
		const childArgs = [SCRIPT_PATH, "--scenario", scenario.label];
		if (outDir) childArgs.push("--out-dir", outDir);
		const child = spawn(process.execPath, childArgs, {
			cwd: REPO_ROOT,
			env: { ...process.env, CURSOR_API_KEY: args.apiKey },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("close", (code) => {
			const scrubbedStderr = scrubSensitiveText(stderr, args.apiKey);
			if (scrubbedStderr) {
				process.stderr.write(scrubbedStderr.endsWith("\n") ? scrubbedStderr : `${scrubbedStderr}\n`);
			}
			if (code === 0 && stdout.trim()) {
				process.stdout.write(stdout.endsWith("\n") ? stdout : `${stdout}\n`);
				resolve();
				return;
			}
			console.log(
				JSON.stringify({
					label: scenario.label,
					error: scrubSensitiveText(scrubbedStderr.trim() || `child exited ${code ?? "unknown"}`, args.apiKey),
				}),
			);
			resolve();
		});
	});
}

async function main(argv = process.argv.slice(2), env = process.env) {
	const args = parseArgs(argv, env);
	if (args.help) {
		printHelp();
		return;
	}
	if (!args.apiKey) fail("CURSOR_API_KEY is required. Set CURSOR_API_KEY or pass --api-key.");

	const scenario = args.scenario ? findScenario(args.scenario) : undefined;
	if (args.scenario && !scenario) fail(`unknown scenario: ${args.scenario}`, args.apiKey);

	if (scenario) {
		await runScenarioInThisProcess(args, scenario);
		return;
	}

	const outDir =
		args.outDir ??
		join(REPO_ROOT, ".artifacts", "perf-architect-2026-10-07", "probe", "provider-coldstart");
	mkdirSync(outDir, { recursive: true, mode: 0o700 });
	for (const scenarioToRun of SCENARIOS) {
		console.error(`probe-provider-coldstart: running ${scenarioToRun.label}`);
		await runScenarioChild(args, scenarioToRun, outDir);
	}
	console.error(`probe-provider-coldstart: artifacts under ${outDir}`);
}

if (isMainModule()) {
	main().catch((error) => {
		const message = error instanceof Error ? error.message : String(error);
		fail(message, apiKeySecretsFromProcess());
	});
}
