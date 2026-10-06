import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __testUtils as actionLog } from "../src/cursor-actions-log.js";
import { computeCursorContextFingerprint } from "../src/context.js";
import { streamCursor } from "../src/cursor-provider.js";
import { __testUtils as cursorSessionAgentTestUtils } from "../src/cursor-session-agent.js";
import { __testUtils as resumeTestUtils } from "../src/cursor-session-agent-resume.js";
import { getCursorSessionFile, getCursorSessionScopeKey, __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { __testUtils as cursorSessionTurnQueueTestUtils } from "../src/cursor-session-turn-queue.js";
import { buildCursorModelSelection } from "../src/model-discovery.js";
import {
	asMockCursorRun,
	asMockSdkAgent,
	collectEvents,
	makeContext,
	makeModel,
	holdDefaultCursorAgentSend,
	mockedCreate,
	mockedResume,
	resetCursorProviderTestState,
} from "./helpers/cursor-provider-harness.js";
import { disposeAllSessionCursorAgents } from "../src/cursor-session-agent.js";
import { cursorLiveRuns } from "../src/cursor-provider-live-run-drain.js";

function finishedRun(id: string, agentId: string) {
	return asMockCursorRun({
		id,
		agentId,
		status: "finished",
		wait: vi.fn().mockResolvedValue({ id, status: "finished", result: "ok" }),
	});
}

describe("streamCursor session identity", () => {
	let actionDir: string;
	let actionPath: string;

	beforeEach(async () => {
		await disposeAllSessionCursorAgents();
		await resetCursorProviderTestState();
		actionDir = mkdtempSync(join(tmpdir(), "cursor-session-identity-"));
		actionPath = join(actionDir, "actions.jsonl");
		vi.stubEnv("CURSOR_SDK_ACTIONS_LOG", actionPath);
	});

	afterEach(async () => {
		await actionLog.flush();
		vi.unstubAllEnvs();
		rmSync(actionDir, { recursive: true, force: true });
	});

	async function journal() {
		await actionLog.flush();
		if (!existsSync(actionPath)) return [];
		return readFileSync(actionPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
	}

	it("keeps one agent across 23 total sends, past the old 20-incremental boundary", async () => {
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/long.jsonl", "lifecycle-long");
		const send = vi.fn().mockImplementation(async () => finishedRun("run-long", "agent-long"));
		mockedCreate.mockResolvedValue(asMockSdkAgent({ agentId: "agent-long", send }));
		const messages = [{ role: "user" as const, content: "Hello", timestamp: 1 }];

		for (let turn = 0; turn < 23; turn += 1) {
			if (turn > 0) messages.push({ role: "user", content: `Follow ${turn}`, timestamp: turn + 1 });
			const events = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext([...messages]), {
				apiKey: "test-key",
				sessionId: "lifecycle-long",
			}));
			expect(events.some((event) => event.type === "error")).toBe(false);
		}

		expect(mockedCreate).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledTimes(23);
		const rows = await journal();
		expect(rows.some((row) => row.reason === "incremental_threshold")).toBe(false);
		expect(rows.filter((row) => row.action === "send_plan" && row.reason === "incremental")).toHaveLength(22);
		const turns = rows.filter((row) => row.action === "session_identity" || row.action === "agent_create" || row.action === "agent_send");
		expect(new Set(turns.map((row) => row.turnId)).size).toBe(23);
		expect(turns.every((row) => typeof row.turnId === "string" && row.turnId.length > 0)).toBe(true);
	});

	it("does not share an agent across different request session ids when no lifecycle scope exists", async () => {
		const sendA = vi.fn().mockImplementation(async () => finishedRun("run-a", "agent-a"));
		const sendB = vi.fn().mockImplementation(async () => finishedRun("run-b", "agent-b"));
		mockedCreate
			.mockResolvedValueOnce(asMockSdkAgent({ agentId: "agent-a", send: sendA }))
			.mockResolvedValueOnce(asMockSdkAgent({ agentId: "agent-b", send: sendB }));
		const context = makeContext();

		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), context, { apiKey: "test-key", sessionId: "direct-a" }));
		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), context, { apiKey: "test-key", sessionId: "direct-b" }));

		expect(mockedCreate).toHaveBeenCalledTimes(2);
		expect(sendA).toHaveBeenCalledTimes(1);
		expect(sendB).toHaveBeenCalledTimes(1);
		expect(getCursorSessionScopeKey()).toBe(cursorSessionScopeTestUtils.ANONYMOUS_SESSION_SCOPE_KEY);
	});

	it("keeps overlapping direct calls on their own request scopes, including an omitted id", async () => {
		let releaseA!: () => void;
		const gateA = new Promise<void>((resolve) => {
			releaseA = resolve;
		});
		const scopes: string[] = [];
		const sendA = vi.fn().mockImplementation(async () => {
			scopes.push(`A-send:${getCursorSessionScopeKey()}`);
			await gateA;
			scopes.push(`A-after:${getCursorSessionScopeKey()}`);
			return finishedRun("run-a", "agent-a");
		});
		const sendB = vi.fn().mockImplementation(async () => {
			scopes.push(`B-send:${getCursorSessionScopeKey()}`);
			return finishedRun("run-b", "agent-b");
		});
		const sendAnon = vi.fn().mockImplementation(async () => {
			scopes.push(`anon-send:${getCursorSessionScopeKey()}`);
			return finishedRun("run-anon", "agent-anon");
		});
		const createAgent = vi.fn().mockImplementation(async () => {
			scopes.push(`create:${getCursorSessionScopeKey()}`);
			const next = [sendA, sendB, sendAnon][createAgent.mock.calls.length - 1] ?? sendAnon;
			const id = ["agent-a", "agent-b", "agent-anon"][createAgent.mock.calls.length - 1] ?? "agent-x";
			return asMockSdkAgent({ agentId: id, send: next });
		});
		mockedCreate.mockImplementation(createAgent);
		const context = makeContext();
		const streamA = streamCursor(makeModel("gpt-5.5@1m"), context, { apiKey: "test-key", sessionId: "direct-a" });
		const eventsA = collectEvents(streamA);
		await vi.waitFor(() => expect(sendA).toHaveBeenCalledTimes(1));
		const streamB = streamCursor(makeModel("gpt-5.5@1m"), context, { apiKey: "test-key", sessionId: "direct-b" });
		const eventsB = collectEvents(streamB);
		await vi.waitFor(() => expect(sendB).toHaveBeenCalledTimes(1));
		const streamAnon = streamCursor(makeModel("gpt-5.5@1m"), context, { apiKey: "test-key" });
		const eventsAnon = collectEvents(streamAnon);
		await vi.waitFor(() => expect(sendB).toHaveBeenCalledTimes(1));
		scopes.push(`outside:${getCursorSessionScopeKey()}`);
		releaseA();
		const doneA = await eventsA;
		try {
			await vi.waitFor(() => expect(sendAnon).toHaveBeenCalledTimes(1));
		} catch (error) {
			throw new Error(`${scopes.join(",")} calls=${mockedCreate.mock.calls.length}`, { cause: error });
		}
		expect(doneA.some((event) => event.type === "error")).toBe(false);
		expect((await eventsB).some((event) => event.type === "error")).toBe(false);
		expect((await eventsAnon).some((event) => event.type === "error")).toBe(false);
		expect(scopes).toEqual([
			"create:__request__:direct-a",
			"A-send:__request__:direct-a",
			"create:__request__:direct-b",
			"B-send:__request__:direct-b",
			"outside:__anonymous__",
			"A-after:__request__:direct-a",
			"create:__anonymous__",
			"anon-send:__anonymous__",
		]);
		expect(mockedCreate).toHaveBeenCalledTimes(3);
		expect(getCursorSessionScopeKey()).toBe(cursorSessionScopeTestUtils.ANONYMOUS_SESSION_SCOPE_KEY);
	});

	it("fails a queued request when its lifecycle scope changes before acquire", async () => {
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/A.jsonl", "A");
		let releaseHold!: () => void;
		const hold = new Promise<void>((resolve) => {
			releaseHold = resolve;
		});
		const holdSend = vi.fn().mockImplementation(async () => {
			await hold;
			return finishedRun("run-hold", "agent-hold");
		});
		const queuedSend = vi.fn().mockImplementation(async () => finishedRun("run-queued", "agent-queued"));
		mockedCreate
			.mockResolvedValueOnce(asMockSdkAgent({ agentId: "agent-hold", send: holdSend }))
			.mockResolvedValueOnce(asMockSdkAgent({ agentId: "agent-b", send: queuedSend }));
		const context = makeContext();
		const holding = collectEvents(streamCursor(makeModel("gpt-5.5@1m"), context, { apiKey: "test-key", sessionId: "A" }));
		await vi.waitFor(() => expect(holdSend).toHaveBeenCalledTimes(1));
		const queued = collectEvents(streamCursor(makeModel("gpt-5.5@1m"), context, { apiKey: "test-key", sessionId: "A" }));
		await vi.waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/B.jsonl", "B");
		releaseHold();
		expect((await holding).some((event) => event.type === "error")).toBe(false);
		expect((await queued).some((event) => event.type === "error")).toBe(true);
		expect(queuedSend).not.toHaveBeenCalled();
		expect(mockedCreate).toHaveBeenCalledTimes(1);
	});

	it("fails before acquire when the lifecycle scope changes during pre-send drain", async () => {
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/A.jsonl", "A");
		const { __testUtils: drainTestUtils } = await import("../src/cursor-provider-live-run-drain.js");
		drainTestUtils.setBeforeLiveRunDrain(() => {
			cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/B.jsonl", "B");
		});
		const send = vi.fn().mockImplementation(async () => finishedRun("run-after-drain", "agent-after-drain"));
		mockedCreate.mockResolvedValue(asMockSdkAgent({ agentId: "agent-after-drain", send }));
		try {
			const events = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), {
				apiKey: "test-key",
				sessionId: "A",
			}));
			expect(events.some((event) => event.type === "error")).toBe(true);
			expect(send).not.toHaveBeenCalled();
			expect(mockedCreate).not.toHaveBeenCalled();
		} finally {
			drainTestUtils.setBeforeLiveRunDrain(undefined);
		}
	});

	it("routes a summarization request with mismatched id to an isolated request scope inside the compaction window", async () => {
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/summary.jsonl", "lifecycle-summary");
		const send = vi.fn().mockImplementation(async () => finishedRun("run-summary", "agent-summary"));
		mockedCreate.mockResolvedValue(asMockSdkAgent({ agentId: "agent-summary", send }));
		cursorSessionScopeTestUtils.beginSummarizationWindow();

		const events = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), {
			apiKey: "test-key",
			sessionId: "summary-routing-id",
		}));

		expect(events.some((event) => event.type === "error")).toBe(false);
		expect(mockedCreate).toHaveBeenCalledTimes(1);
		const rows = await journal();
		const isolatedScopeId = createHash("sha256").update("__request__:summary-routing-id").digest("hex").slice(0, 16);
		expect(rows.some((row) => row.action === "session_identity" && row.reason === "summarization_request" && row.scopeId === isolatedScopeId)).toBe(true);
		expect(rows.some((row) => row.action === "agent_lease" && row.scopeId === isolatedScopeId)).toBe(true);
		// The summarization id never repeats: its isolated agent must be disposed after the turn,
		// so repeated compaction cannot accumulate SDK resources.
		expect(cursorSessionAgentTestUtils.getSessionCursorAgentPoolState("__request__:summary-routing-id").status).toBe("empty");
	});

	it("does not accumulate isolated summarization agents across consecutive compaction requests", async () => {
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/summary4.jsonl", "lifecycle-summary4");
		mockedCreate.mockImplementation(async () => asMockSdkAgent({
			agentId: `agent-summary-${mockedCreate.mock.calls.length}`,
			send: vi.fn().mockImplementation(async () => finishedRun(`run-${mockedCreate.mock.calls.length}`, `agent-summary-${mockedCreate.mock.calls.length}`)),
		}));
		for (const routingId of ["summary-routing-a", "summary-routing-b"]) {
			cursorSessionScopeTestUtils.beginSummarizationWindow();
			const events = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), {
				apiKey: "test-key",
				sessionId: routingId,
			}));
			expect(events.some((event) => event.type === "error")).toBe(false);
			expect(cursorSessionAgentTestUtils.getSessionCursorAgentPoolState(`__request__:${routingId}`).status).toBe("empty");
		}
		expect(mockedCreate).toHaveBeenCalledTimes(2);
	});

	it("isolates a mismatched request id after the compaction window ends (nested extension sessions)", async () => {
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/summary2.jsonl", "lifecycle-summary2");
		const send = vi.fn().mockImplementation(async () => finishedRun("run-summary2", "agent-summary2"));
		mockedCreate.mockResolvedValue(asMockSdkAgent({ agentId: "agent-summary2", send }));
		cursorSessionScopeTestUtils.beginSummarizationWindow();
		const windowed = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), {
			apiKey: "test-key",
			sessionId: "summary-routing-id-2",
		}));
		expect(windowed.some((event) => event.type === "error")).toBe(false);

		cursorSessionScopeTestUtils.endSummarizationWindow();
		const sendAfter = vi.fn().mockImplementation(async () => finishedRun("run-after", "agent-after"));
		mockedCreate.mockResolvedValue(asMockSdkAgent({ agentId: "agent-after", send: sendAfter }));
		const after = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), {
			apiKey: "test-key",
			sessionId: "summary-routing-id-2",
		}));

		expect(after.some((event) => event.type === "error")).toBe(false);
		expect(sendAfter).toHaveBeenCalledTimes(1);
		expect(cursorSessionAgentTestUtils.getSessionCursorAgentPoolState("__request__:summary-routing-id-2").status).toBe("ready");
		const rows = await journal();
		expect(rows.some((row) => row.action === "session_identity" && row.reason === "nested_request")).toBe(true);
		expect(rows.some((row) => row.action === "session_identity" && row.reason === "session_id_conflict")).toBe(false);
	});

	it("clears the summarization window when a request carries the lifecycle session id", async () => {
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/summary3.jsonl", "lifecycle-summary3");
		const send = vi.fn().mockImplementation(async () => finishedRun("run-normal", "agent-normal"));
		mockedCreate.mockResolvedValue(asMockSdkAgent({ agentId: "agent-normal", send }));
		cursorSessionScopeTestUtils.beginSummarizationWindow();

		const normal = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), {
			apiKey: "test-key",
			sessionId: "lifecycle-summary3",
		}));
		expect(normal.some((event) => event.type === "error")).toBe(false);
		expect(cursorSessionScopeTestUtils.isSummarizationWindow()).toBe(false);
	});

	it("isolates a nested request id from the parent lifecycle agent and reuses that nested agent on the next turn", async () => {
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/owned.jsonl", "lifecycle-owned");
		const parentSend = vi.fn().mockImplementation(async () => finishedRun("run-parent", "agent-parent"));
		const nestedSend = vi.fn().mockImplementation(async () => {
			expect(getCursorSessionScopeKey()).toBe("__request__:btw-nested-id");
			return finishedRun("run-nested", "agent-nested");
		});
		mockedCreate
			.mockResolvedValueOnce(asMockSdkAgent({ agentId: "agent-parent", send: parentSend }))
			.mockResolvedValueOnce(asMockSdkAgent({ agentId: "agent-nested", send: nestedSend }));

		const parentContext = makeContext();
		const parentFirst = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), parentContext, {
			apiKey: "test-key",
			sessionId: "lifecycle-owned",
		}));
		expect(parentFirst.some((event) => event.type === "error")).toBe(false);
		expect(parentSend).toHaveBeenCalledTimes(1);

		const nestedContext = makeContext();
		const nested = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), nestedContext, {
			apiKey: "test-key",
			sessionId: "btw-nested-id",
		}));
		expect(nested.some((event) => event.type === "error")).toBe(false);
		expect(nestedSend).toHaveBeenCalledTimes(1);
		expect(parentSend).toHaveBeenCalledTimes(1);
		expect(cursorSessionAgentTestUtils.getSessionCursorAgentPoolState("__request__:btw-nested-id").status).toBe("ready");

		const nestedAgain = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), {
			...nestedContext,
			messages: [...nestedContext.messages, { role: "user", content: "Second nested turn", timestamp: 2 }],
		}, {
			apiKey: "test-key",
			sessionId: "btw-nested-id",
		}));
		expect(nestedAgain.some((event) => event.type === "error")).toBe(false);
		expect(nestedSend).toHaveBeenCalledTimes(2);
		expect(mockedCreate).toHaveBeenCalledTimes(2);

		const parentAgain = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), {
			...parentContext,
			messages: [...parentContext.messages, { role: "user", content: "Back on parent", timestamp: 3 }],
		}, {
			apiKey: "test-key",
			sessionId: "lifecycle-owned",
		}));
		expect(parentAgain.some((event) => event.type === "error")).toBe(false);
		expect(parentSend).toHaveBeenCalledTimes(2);
		expect(mockedCreate).toHaveBeenCalledTimes(2);

		const rows = await journal();
		const nestedScopeId = createHash("sha256").update("__request__:btw-nested-id").digest("hex").slice(0, 16);
		expect(rows.some((row) => row.action === "session_identity" && row.reason === "nested_request" && row.scopeId === nestedScopeId)).toBe(true);
		expect(rows.some((row) => row.action === "session_identity" && row.reason === "session_id_conflict")).toBe(false);
		expect(JSON.stringify(rows)).not.toContain("test-key");
	});

	it("isolates a request-only id that no longer matches after a lifecycle scope starts", async () => {
		const release = holdDefaultCursorAgentSend();
		const context = makeContext();
		const first = collectEvents(streamCursor(makeModel("gpt-5.5@1m"), context, { apiKey: "test-key", sessionId: "direct-a" }));
		await vi.waitFor(() => expect(mockedCreate).toHaveBeenCalledTimes(1));
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/B.jsonl", "B");
		const nestedSend = vi.fn().mockImplementation(async () => finishedRun("run-nested-direct", "agent-nested-direct"));
		mockedCreate.mockResolvedValueOnce(asMockSdkAgent({ agentId: "agent-nested-direct", send: nestedSend }));
		const second = collectEvents(streamCursor(makeModel("gpt-5.5@1m"), context, { apiKey: "test-key", sessionId: "direct-a" }));
		release();
		expect((await first).some((event) => event.type === "error")).toBe(false);
		expect((await second).some((event) => event.type === "error")).toBe(false);
		expect(nestedSend).toHaveBeenCalledTimes(1);
		expect(cursorSessionAgentTestUtils.getSessionCursorAgentPoolState("__request__:direct-a").status).toBe("ready");
	});

	it("does not reset a nested pool when a queued same-id call aborts before acquiring the turn", async () => {
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/nested-queue.jsonl", "lifecycle-nested-queue");
		let releaseSend!: () => void;
		const sendGate = new Promise<void>((resolve) => {
			releaseSend = resolve;
		});
		const nestedSend = vi.fn().mockImplementation(async () => {
			await sendGate;
			return finishedRun("run-nested-owner", "agent-nested-owner");
		});
		mockedCreate.mockResolvedValue(asMockSdkAgent({ agentId: "agent-nested-owner", send: nestedSend }));

		const nestedScopeKey = "__request__:btw-shared-nested";
		const owner = collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), {
			apiKey: "test-key",
			sessionId: "btw-shared-nested",
		}));
		await vi.waitFor(() => expect(nestedSend).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(cursorSessionTurnQueueTestUtils.activeCount(nestedScopeKey)).toBe(1));

		const controller = new AbortController();
		const waiter = collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext([
			{ role: "user", content: "Queued nested", timestamp: 2 },
		]), {
			apiKey: "test-key",
			sessionId: "btw-shared-nested",
			signal: controller.signal,
		}));
		// Same scope keeps Map size 1; activeCount tracks owner + queued waiter.
		await vi.waitFor(() => expect(cursorSessionTurnQueueTestUtils.activeCount(nestedScopeKey)).toBe(2));
		controller.abort();
		expect((await waiter).some((event) => event.type === "error")).toBe(true);
		expect(nestedSend).toHaveBeenCalledTimes(1);
		// Critical: aborting the waiter must not clear the owner's nested pool while the owner still holds the turn.
		expect(cursorSessionAgentTestUtils.getSessionCursorAgentPoolState(nestedScopeKey).status).not.toBe("empty");

		releaseSend();
		expect((await owner).some((event) => event.type === "error")).toBe(false);
		expect(cursorSessionAgentTestUtils.getSessionCursorAgentPoolState(nestedScopeKey).status).toBe("ready");
	});

	it("keeps the existing session-file scope when the request omits sessionId", async () => {
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "0";
		cursorSessionScopeTestUtils.set("/tmp/project", "/tmp/sessions/legacy.jsonl", "lifecycle-legacy");
		const first = makeContext();
		const firstEvents = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), first, { apiKey: "test-key" }));
		const secondEvents = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), {
			...first,
			messages: [...first.messages, { role: "user", content: "Follow up", timestamp: 2 }],
		}, { apiKey: "test-key" }));
		const errors = [firstEvents, secondEvents].flatMap((events) => events.flatMap((event) => event.type === "error" && "error" in event ? [event.error.errorMessage ?? ""] : []));
		const created = await mockedCreate.mock.results[0]?.value;

		expect(errors).toEqual([]);
		expect(getCursorSessionFile()).toBe("/tmp/sessions/legacy.jsonl");
		expect(getCursorSessionScopeKey()).toBe("/tmp/sessions/legacy.jsonl");
		expect(mockedCreate).toHaveBeenCalledTimes(1);
		expect(created?.send).toHaveBeenCalledTimes(2);
	});

	it("resumes a persisted agent whose recorded session id matches the request", async () => {
		process.env.PI_CURSOR_LOCAL_RESUME = "1";
		const scopeKey = "/tmp/sessions/resume-match.jsonl";
		cursorSessionScopeTestUtils.set(process.cwd(), scopeKey, "resume-match");
		const context = makeContext();
		const modelSelection = buildCursorModelSelection("gpt-5.5@1m", "off", false);
		const poolKey = cursorSessionAgentTestUtils.buildSessionAgentPoolKey(scopeKey, {
			apiKey: "test-key",
			agentMode: "agent",
			cwd: process.cwd(),
			modelSelection,
			settingSources: ["all"],
			localSafety: { autoReview: false, sandboxEnabled: false },
			localResume: true,
		});
		resumeTestUtils.set({
			scopeKey,
			sessionFile: scopeKey,
			sessionId: "resume-match",
			cwd: process.cwd(),
			branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
			compactionGeneration: 0,
			activeHandle: {
				version: 1,
				runtime: "local",
				agentId: "agent-matched",
				scopeKey,
				sessionFile: scopeKey,
				sessionId: "resume-match",
				cwd: process.cwd(),
				poolKey,
				branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
				compactionGeneration: 0,
				sendState: {
					bootstrapped: true,
					contextFingerprint: computeCursorContextFingerprint(context),
					incrementalSendCount: 21,
				},
				createdAt: "2026-07-07T00:00:00.000Z",
			},
		});
		const send = vi.fn().mockImplementation(async () => finishedRun("run-matched", "agent-matched"));
		mockedResume.mockResolvedValueOnce(asMockSdkAgent({ agentId: "agent-matched", send }));

		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext([
			...context.messages,
			{ role: "user", content: "Follow up", timestamp: 2 },
		]), { apiKey: "test-key", sessionId: "resume-match" }));

		expect(mockedResume).toHaveBeenCalledTimes(1);
		expect(mockedCreate).not.toHaveBeenCalled();
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("does not resume a persisted agent whose session id cannot be proven", async () => {
		process.env.PI_CURSOR_LOCAL_RESUME = "1";
		const scopeKey = "/tmp/sessions/resume-unproven.jsonl";
		cursorSessionScopeTestUtils.set(process.cwd(), scopeKey, "proven-session");
		const context = makeContext();
		const modelSelection = buildCursorModelSelection("gpt-5.5@1m", "off", false);
		const poolKey = cursorSessionAgentTestUtils.buildSessionAgentPoolKey(scopeKey, {
			apiKey: "test-key",
			agentMode: "agent",
			cwd: process.cwd(),
			modelSelection,
			settingSources: ["all"],
			localSafety: { autoReview: false, sandboxEnabled: false },
			localResume: true,
		});
		resumeTestUtils.set({
			scopeKey,
			sessionFile: scopeKey,
			sessionId: "proven-session",
			cwd: process.cwd(),
			branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
			compactionGeneration: 0,
			activeHandle: {
				version: 1,
				runtime: "local",
				agentId: "agent-unproven",
				scopeKey,
				sessionFile: scopeKey,
				cwd: process.cwd(),
				poolKey,
				branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
				compactionGeneration: 0,
				sendState: {
					bootstrapped: true,
					contextFingerprint: computeCursorContextFingerprint(context),
					incrementalSendCount: 1,
				},
				createdAt: "2026-07-07T00:00:00.000Z",
			},
		});
		const send = vi.fn().mockImplementation(async () => finishedRun("run-fresh", "agent-fresh"));
		mockedCreate.mockResolvedValue(asMockSdkAgent({ agentId: "agent-fresh", send }));

		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext([
			...context.messages,
			{ role: "user", content: "Follow up", timestamp: 2 },
		]), { apiKey: "test-key", sessionId: "proven-session" }));

		expect(mockedResume).not.toHaveBeenCalled();
		expect(mockedCreate).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledTimes(1);
	});
});
