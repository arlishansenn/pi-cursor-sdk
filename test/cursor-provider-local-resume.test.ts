import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testUtils as actionLog } from "../src/cursor-actions-log.js";
import { Type } from "typebox";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
	asMockCursorRun,
	asMockSdkAgent,
	collectEvents,
	collectThinkingDeltas,
	createTestToolInfo,
	getDoneEvent,
	makeAssistantMessage,
	makeContext,
	makeModel,
	mockCreatedAgent,
	mockedCreate,
	mockedResume,
	registerBridgeForProviderTest,
	registerNativeToolDisplayForTest,
	resetCursorProviderTestState,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "../src/cursor-provider.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { __testUtils as cursorSessionAgentTestUtils } from "../src/cursor-session-agent.js";
import { __testUtils as resumeTestUtils } from "../src/cursor-session-agent-resume.js";
import { computeCursorContextFingerprint } from "../src/context.js";
import { buildCursorModelSelection } from "../src/model-discovery.js";

describe("streamCursor local resume", () => {
	let actionDir: string;
	let actionPath: string;
	beforeEach(async () => {
		await resetCursorProviderTestState();
		actionDir = mkdtempSync(join(tmpdir(), "cursor-resume-journal-"));
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
		return readFileSync(actionPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	}

	function seedResumeHandle(
		scopeKey: string,
		contextFingerprint = "{}",
		agentId = "agent-old",
		incrementalSendCount = 0,
	): void {
		cursorSessionScopeTestUtils.set(process.cwd(), scopeKey);
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
			cwd: process.cwd(),
			branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
			compactionGeneration: 0,
			activeHandle: {
				version: 1,
				runtime: "local",
				agentId,
				scopeKey,
				sessionFile: scopeKey,
				cwd: process.cwd(),
				poolKey,
				branchPathHash: resumeTestUtils.EMPTY_BRANCH_HASH,
				compactionGeneration: 0,
				sendState: { bootstrapped: true, contextFingerprint, incrementalSendCount },
				createdAt: "2026-07-07T00:00:00.000Z",
			},
		});
	}

	it("resumes with current bridge MCP and bootstraps the current Pi transcript", async () => {
		process.env.PI_CURSOR_LOCAL_RESUME = "1";
		registerBridgeForProviderTest({
			active: ["mcp", "subagent"],
			tools: [
				createTestToolInfo("mcp", Type.Object({}), "Call an MCP server"),
				createTestToolInfo("subagent", Type.Object({}), "Delegate to a pi subagent"),
			],
		});
		const priorContext = makeContext();
		const resumedContext = makeContext([
			...priorContext.messages,
			makeAssistantMessage("Prior answer"),
			{ role: "user", content: "Follow up", timestamp: 3 },
		]);
		const mockSend = vi.fn().mockImplementation(async (message: { text?: string }) =>
			asMockCursorRun({
				id: "run-resumed",
				agentId: "agent-old",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-resumed", status: "finished", result: message.text ?? "" }),
			}),
		);
		mockedResume.mockResolvedValueOnce(asMockSdkAgent({ agentId: "agent-old", send: mockSend }));
		seedResumeHandle("/tmp/resume-bridge-session.jsonl", computeCursorContextFingerprint(priorContext));

		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), resumedContext, { apiKey: "test-key" }));

		expect(mockedCreate).not.toHaveBeenCalled();
		expect(mockedResume).toHaveBeenCalledTimes(1);
		expect(mockedResume.mock.calls[0]?.[0]).toBe("agent-old");
		expect(mockedResume.mock.calls[0]?.[1]).toMatchObject({
			mcpServers: { pi_tools: { type: "http" } },
		});
		const prompt = mockSend.mock.calls[0]?.[0] as { text?: string };
		expect(prompt.text).toContain("User: Follow up");
		expect(prompt.text).toContain("User: Hello");
		expect(prompt.text).toContain("prefer pi__mcp for MCP work and pi__subagent for delegation");
		const rows = await journal();
		expect(rows.find((row) => row.action === "send_plan")).toMatchObject({ reason: "process_resume", resetAgent: false });
		expect(new Set(rows.map((row) => row.turnId)).size).toBe(1);
		expect(rows.every((row) => typeof row.turnId === "string")).toBe(true);
	});

	it("replaces a resumed agent with Agent.create for context_divergence while preserving resume persistence", async () => {
		process.env.PI_CURSOR_LOCAL_RESUME = "1";
		const context = makeContext();
		const oldDispose = vi.fn().mockResolvedValue(undefined);
		mockedResume.mockResolvedValueOnce(asMockSdkAgent({
			agentId: "agent-old",
			send: vi.fn(),
			[Symbol.asyncDispose]: oldDispose,
		}));
		const newSend = vi.fn().mockResolvedValue(asMockCursorRun({
			id: "run-new",
			agentId: "agent-new",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-new", status: "finished", result: "done" }),
		}));
		mockCreatedAgent({ agentId: "agent-new", send: newSend });
		seedResumeHandle("/tmp/reset-0.jsonl", "stale-context", "agent-old", 0);

		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), context, { apiKey: "test-key" }));

		expect(mockedResume).toHaveBeenCalledTimes(1);
		expect(oldDispose).toHaveBeenCalledTimes(1);
		expect(mockedCreate).toHaveBeenCalledTimes(1);
		expect(newSend).toHaveBeenCalledTimes(1);
		expect(resumeTestUtils.state.pendingHandle).toMatchObject({ agentId: "agent-new" });
		const rows = await journal();
		const decision = rows.findIndex((row) => row.action === "send_plan" && row.reason === "context_divergence");
		const create = rows.findIndex((row) => row.action === "agent_create" && row.phase === "start");
		const send = rows.findIndex((row) => row.action === "agent_send" && row.phase === "start");
		expect(decision).toBeGreaterThan(-1);
		expect(create).toBeGreaterThan(decision);
		expect(send).toBeGreaterThan(create);
		expect(rows[send].turnId).toBe(rows[decision].turnId);
		expect(rows[send].agentId).toBe("agent-new");
	});

	it("does not pass a crafted cloud agent ID to local Agent.resume", async () => {
		process.env.PI_CURSOR_LOCAL_RESUME = "1";
		mockCreatedAgent({
			agentId: "agent-new",
			send: vi.fn().mockResolvedValue(asMockCursorRun({
				id: "run-new",
				agentId: "agent-new",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-new", status: "finished", result: "done" }),
			})),
		});
		seedResumeHandle("/tmp/reject-cloud-resume-session.jsonl", "{}", "bc-cloud-agent");

		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

		expect(mockedResume).not.toHaveBeenCalled();
		expect(mockedCreate).toHaveBeenCalledTimes(1);
	});

	it("falls back from local Agent.resume with a display-only continuity note", async () => {
		process.env.PI_CURSOR_LOCAL_RESUME = "1";
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-new",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "done" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockedResume.mockRejectedValueOnce(new Error("Agent agent-old not found"));
		mockCreatedAgent({ agentId: "agent-new", send: mockSend });
		seedResumeHandle("/tmp/resume-session.jsonl");

		const events = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));
		const followUpEvents = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

		expect(mockedResume).toHaveBeenCalledTimes(1);
		expect(mockedCreate).toHaveBeenCalledTimes(1);
		expect(collectThinkingDeltas(events)).toContain("Could not resume prior Cursor agent");
		expect(JSON.stringify(getDoneEvent(events).message.content)).not.toContain("Could not resume prior Cursor agent");
		expect(collectThinkingDeltas(followUpEvents)).not.toContain("Could not resume prior Cursor agent");
		const rows = await journal();
		const failure = rows.findIndex((row) => row.action === "agent_resume" && row.phase === "error");
		const create = rows.findIndex((row) => row.action === "agent_create" && row.phase === "start");
		expect(failure).toBeGreaterThan(-1);
		expect(create).toBeGreaterThan(failure);
		expect(rows[create].turnId).toBe(rows[failure].turnId);
		expect(rows.filter((row) => row.action === "agent_send" && row.phase === "start").map((row) => row.agentId)).toEqual(["agent-new", "agent-new"]);
	});

	it("emits the resume fallback continuity note on the live native replay path", async () => {
		process.env.PI_CURSOR_LOCAL_RESUME = "1";
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		await registerNativeToolDisplayForTest([]);
		const mockSend = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "agent-new",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "done" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockedResume.mockRejectedValueOnce(new Error("Agent agent-old not found"));
		mockCreatedAgent({ agentId: "agent-new", send: mockSend });
		seedResumeHandle("/tmp/resume-live-session.jsonl");

		const events = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

		expect(collectThinkingDeltas(events)).toContain("Could not resume prior Cursor agent");
		expect(JSON.stringify(getDoneEvent(events).message.content)).not.toContain("Could not resume prior Cursor agent");
	});
});
