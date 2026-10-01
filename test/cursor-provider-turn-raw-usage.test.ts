import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InteractionUpdateSchema, type SDKAgent } from "@cursor/sdk";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { afterEach, expect, it } from "vitest";
import { CursorSdkTurnCoordinator } from "../src/cursor-provider-turn-coordinator.js";
import { cursorLiveRuns } from "../src/cursor-provider-live-run-drain.js";
import { applyCursorUsage } from "../src/cursor-usage-accounting.js";
import { makeAssistantMessage, makeContext, makeModel } from "./helpers/pi-harness.js";

const dirs: string[] = [];
const previous = process.env.CURSOR_SDK_USAGE_LOG;
afterEach(() => {
	if (previous === undefined) delete process.env.CURSOR_SDK_USAGE_LOG;
	else process.env.CURSOR_SDK_USAGE_LOG = previous;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Removing independent callback capture must fail these tests, even if Pi stays isolated.
it.each(["direct", "timely", "ignored", "aborted", "error", "disposed"])("preserves every raw callback independent of %s occupancy/lifecycle", async (state) => {
	const dir = mkdtempSync(join(tmpdir(), "cursor-raw-")); dirs.push(dir);
	const path = join(dir, "usage.jsonl"); process.env.CURSOR_SDK_USAGE_LOG = path;
	const rows = () => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
	const liveRun = state === "direct" ? undefined : cursorLiveRuns.start({
		id: `raw-${state}`, agent: { agentId: "offline-agent" } as SDKAgent,
		sessionAgentScopeKey: `raw-${state}`, promptInputTokens: 10,
	});
	const coordinator = new CursorSdkTurnCoordinator({
		stream: createAssistantMessageEventStream(), partial: makeAssistantMessage(""), cwd: dir,
		useNativeToolReplay: false, nativeReplayId: "offline", textDeltas: [], liveRun,
	});
	coordinator.configureRawUsageLog(makeModel(), "local", { turnId: "offline-turn" });
	if (liveRun) {
		if (state === "ignored") cursorLiveRuns.ignoreFutureSdkTurnUsage(liveRun);
		if (state === "aborted") cursorLiveRuns.markCancelled(liveRun);
		if (state === "error") cursorLiveRuns.markError(liveRun, "offline error");
		if (state === "disposed") await cursorLiveRuns.release(liveRun);
	}
	const usage = { inputTokens: 309292.5, outputTokens: 2656, cacheReadTokens: 245504, cacheWriteTokens: 0 };
	const event = InteractionUpdateSchema.parse({ type: "turn-ended", usage, stepId: 42 });
	expect(event).not.toHaveProperty("stepId");
	coordinator.handleDelta(event);
	coordinator.handleDelta({ type: "turn-ended" });
	expect(rows()).toHaveLength(0); // no runId yet: buffer
	coordinator.attachRawUsageRun("offline-run");
	coordinator.handleDelta(event); // identical counts are a different received event, never value-deduped
	coordinator.attachRawUsageRun("offline-run"); // flush once
	const records = rows().filter((row) => row.source === "raw");
	expect(records).toHaveLength(2);
	expect(records.map((row) => row.usageEventIndex)).toEqual([1, 2]);
	for (const row of records) expect(row).toMatchObject({ ...usage, runId: "offline-run", turnId: "offline-turn", schemaVersion: 2, semantics: "sdk_raw_turn", stepIdentity: "unknown" });
	if (liveRun && ["ignored", "disposed"].includes(state)) expect(cursorLiveRuns.takeSdkTurnUsage(liveRun)).toBeUndefined();
	applyCursorUsage(makeAssistantMessage(""), makeModel(), makeContext(), 10, { runtime: "local", turn: coordinator.lastSdkTurnUsage, correlation: { runId: "offline-run" } });
	expect(rows().filter((row) => row.source === "raw")).toHaveLength(2);
	if (liveRun) await cursorLiveRuns.release(liveRun);
});

it("flushes pre-attach usage without inventing a run identity on send failure", () => {
	const dir = mkdtempSync(join(tmpdir(), "cursor-raw-failed-")); dirs.push(dir);
	const path = join(dir, "usage.jsonl"); process.env.CURSOR_SDK_USAGE_LOG = path;
	const coordinator = new CursorSdkTurnCoordinator({
		stream: createAssistantMessageEventStream(), partial: makeAssistantMessage(""), cwd: dir,
		useNativeToolReplay: false, nativeReplayId: "offline", textDeltas: [],
	});
	coordinator.configureRawUsageLog(makeModel(), "local", { turnId: "failed-turn" });
	coordinator.handleDelta({ type: "turn-ended", usage: { inputTokens: 1, outputTokens: 999999, cacheReadTokens: 3, cacheWriteTokens: 4 } });
	coordinator.handleDelta({ type: "turn-ended", usage: { inputTokens: NaN, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } });
	coordinator.handleDelta({ type: "turn-ended", usage: { inputTokens: -1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } });
	coordinator.flushRawUsageLog(); coordinator.flushRawUsageLog();
	coordinator.handleDelta({ type: "turn-ended", usage: { inputTokens: 1, outputTokens: 999999, cacheReadTokens: 3, cacheWriteTokens: 4 } });
	const rows = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	expect(rows).toHaveLength(2);
	expect(rows.map((row) => row.usageEventIndex)).toEqual([1, 2]);
	expect(rows[0]).toMatchObject({ source: "raw", turnId: "failed-turn", runIdentity: "unavailable", usageEventIndex: 1, cachePartitionValid: false, inputTokens: 1, outputTokens: 999999, cacheReadTokens: 3, cacheWriteTokens: 4 });
	expect(rows[0]).not.toHaveProperty("runId");
	expect(rows[0]).not.toHaveProperty("totalTokens");
});

it.each([false, true])("retains two late raw events after actual split timeout (bridge=%s)", async (bridge) => {
	const { drainCursorLiveRunTurn } = await import("../src/cursor-provider-live-run-drain.js");
	const dir = mkdtempSync(join(tmpdir(), "cursor-raw-split-")); dirs.push(dir);
	const path = join(dir, "usage.jsonl"); process.env.CURSOR_SDK_USAGE_LOG = path;
	const id = bridge ? "bridge-offline" : "native-offline";
	const bridgeRun = bridge ? {
		id, hasPendingPiToolCallId: () => true, hasPendingToolCalls: () => false,
		cancel: () => {}, dispose: async () => {},
	} as unknown as import("../src/cursor-pi-tool-bridge.js").CursorPiToolBridgeRun : undefined;
	const run = cursorLiveRuns.start({ id, agent: { agentId: "offline-agent" } as SDKAgent, sessionAgentScopeKey: id, promptInputTokens: 80, bridgeRun });
	const coordinator = new CursorSdkTurnCoordinator({ stream: createAssistantMessageEventStream(), partial: makeAssistantMessage(""), cwd: dir, useNativeToolReplay: true, nativeReplayId: id, textDeltas: [], liveRun: run });
	coordinator.configureRawUsageLog(makeModel(), "local", { turnId: id });
	coordinator.attachRawUsageRun(`${id}-sdk`);
	cursorLiveRuns.queueEvent(run, bridge ? { type: "bridge-tool", request: { runId: id, bridgeCallId: "offline-call", piToolCallId: "offline-tool", piToolName: "read", mcpToolName: "pi__read", args: {} } } : { type: "tool", tool: { id: `${id}-tool`, toolName: "read", args: {}, result: { content: [] }, isError: false } });
	try {
		await drainCursorLiveRunTurn(createAssistantMessageEventStream(), makeAssistantMessage(""), makeModel(), makeContext(), run, 0, { mode: "emit" });
		expect(run.ignoreFutureSdkTurnUsage).toBe(true);
		const usage = { inputTokens: 1000, outputTokens: 20, cacheReadTokens: 600, cacheWriteTokens: 100 };
		coordinator.handleDelta({ type: "turn-ended", usage });
		coordinator.handleDelta({ type: "turn-ended", usage });
		expect(cursorLiveRuns.takeSdkTurnUsage(run)).toBeUndefined();
		const rows = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(rows.filter((row) => row.source === "raw").map((row) => row.usageEventIndex)).toEqual([1, 2]);
		expect(rows.filter((row) => row.source === "turn")).toHaveLength(0);
	} finally { await cursorLiveRuns.release(run); }
});
