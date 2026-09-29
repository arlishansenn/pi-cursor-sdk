import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { applyCursorUsage } from "../src/cursor-usage-accounting.js";
import { CURSOR_SDK_USAGE_LOG_ENV, __testUtils } from "../src/cursor-usage-log.js";
import { getCursorActionTurnId, traceCursorAction, withCursorActionTurn, __testUtils as actionLogTestUtils } from "../src/cursor-actions-log.js";
import { makeAssistantMessage, makeModel } from "./helpers/pi-harness.js";

function makeContext(): Context {
	return {
		systemPrompt: "Be helpful.",
		messages: [{ role: "user", content: "Hello", timestamp: 1 }],
	};
}

describe("cursor usage log", () => {
	const previousEnv = process.env[CURSOR_SDK_USAGE_LOG_ENV];
	const previousActionsEnv = process.env.CURSOR_SDK_ACTIONS_LOG;
	const tempDirs: string[] = [];

	function logPath(): string {
		const dir = mkdtempSync(join(tmpdir(), "cursor-usage-log-"));
		tempDirs.push(dir);
		return join(dir, "usage.jsonl");
	}

	afterEach(() => {
		if (previousEnv === undefined) delete process.env[CURSOR_SDK_USAGE_LOG_ENV];
		else process.env[CURSOR_SDK_USAGE_LOG_ENV] = previousEnv;
		if (previousActionsEnv === undefined) delete process.env.CURSOR_SDK_ACTIONS_LOG;
		else process.env.CURSOR_SDK_ACTIONS_LOG = previousActionsEnv;
		__testUtils.resetCursorUsageLogState();
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("appends one SDK-shaped JSONL line per applied turn usage", () => {
		const path = logPath();
		process.env[CURSOR_SDK_USAGE_LOG_ENV] = path;
		const model = makeModel();
		applyCursorUsage(makeAssistantMessage("Hi."), model, makeContext(), 7, {
			runtime: "local",
			turn: { inputTokens: 1_000, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 50 },
		});

		const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({
			model: model.id,
			provider: model.provider,
			runtime: "local",
			source: "turn",
			inputTokens: 1_000,
			outputTokens: 50,
			cacheReadTokens: 900,
			cacheWriteTokens: 50,
			totalTokens: 1_050,
		});
		expect(typeof lines[0].ts).toBe("string");
	});

	it("logs estimate source when no SDK usage is available", () => {
		const path = logPath();
		process.env[CURSOR_SDK_USAGE_LOG_ENV] = path;
		applyCursorUsage(makeAssistantMessage("Hi."), makeModel(), makeContext(), 120);

		const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ source: "estimate", cacheReadTokens: 0, cacheWriteTokens: 0 });
		expect(lines[0].inputTokens).toBeGreaterThan(0);
	});

	it("logs correlation fields with the same keys and values as the action journal send", async () => {
		const path = logPath();
		process.env[CURSOR_SDK_USAGE_LOG_ENV] = path;
		const actionDir = mkdtempSync(join(tmpdir(), "cursor-actions-x-"));
		tempDirs.push(actionDir);
		const actionPath = join(actionDir, "actions.jsonl");
		process.env.CURSOR_SDK_ACTIONS_LOG = actionPath;

		const correlation = await withCursorActionTurn(async () => {
			await traceCursorAction({ action: "agent_send", agentId: "agent-1", mode: "incremental" }, async () => "sent", () => ({ runId: "run-9" }));
			return { turnId: getCursorActionTurnId(), runId: "run-9", mode: "incremental" as const };
		});
		applyCursorUsage(makeAssistantMessage("Hi."), makeModel(), makeContext(), 7, {
			runtime: "local",
			turn: { inputTokens: 1_000, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 50 },
			correlation,
		});
		await actionLogTestUtils.flush();

		const usageLine = JSON.parse(readFileSync(path, "utf8").trim());
		const sendLines = readFileSync(actionPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		const agentSend = sendLines.filter((line) => line.action === "agent_send" && line.phase === "success");
		expect(agentSend).toHaveLength(1);
		expect(typeof agentSend[0].turnId).toBe("string");
		expect(agentSend[0].turnId.length).toBeGreaterThan(0);
		expect(usageLine.turnId).toBe(agentSend[0].turnId);
		expect(usageLine.runId).toBe(agentSend[0].runId);
		expect(usageLine.mode).toBe(agentSend[0].mode);
		expect(usageLine.mode).toBe("incremental");
	});

	it("omits correlation fields instead of fabricating them outside a turn", () => {
		const path = logPath();
		process.env[CURSOR_SDK_USAGE_LOG_ENV] = path;
		applyCursorUsage(makeAssistantMessage("Hi."), makeModel(), makeContext(), 7, {
			runtime: "local",
			turn: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 5, cacheWriteTokens: 2 },
		});

		const line = JSON.parse(readFileSync(path, "utf8").trim());
		expect("turnId" in line).toBe(false);
		expect("runId" in line).toBe(false);
		expect("mode" in line).toBe(false);
	});

	it("writes nothing when CURSOR_SDK_USAGE_LOG is disabled", () => {
		const path = logPath();
		process.env[CURSOR_SDK_USAGE_LOG_ENV] = "0";
		applyCursorUsage(makeAssistantMessage("Hi."), makeModel(), makeContext(), 7, {
			runtime: "local",
			turn: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 5, cacheWriteTokens: 2 },
		});
		expect(existsSync(path)).toBe(false);
	});
});
