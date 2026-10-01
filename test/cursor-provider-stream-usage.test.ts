import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	resetCursorProviderTestState,
	makeModel,
	makeContext,
	collectEvents,
	getDoneEvent,
	getErrorEvent,
	type CursorDeltaHandler,
	mockCreatedAgent,
	asMockCursorRun,
} from "./helpers/cursor-provider-harness.js";
import { streamCursor } from "../src/cursor-provider.js";
import { __testUtils as actionLogTestUtils } from "../src/cursor-actions-log.js";

describe("streamCursor usage accounting", () => {
	beforeEach(resetCursorProviderTestState);

	it("ignores returned RunResult usage when no turn-ended usage was applied", async () => {
		const mockSend = vi.fn().mockResolvedValue(asMockCursorRun({
			id: "run-1",
			agentId: "agent-1",
			status: "finished",
			wait: vi.fn().mockResolvedValue({
				id: "run-1",
				status: "finished",
				result: "done",
				usage: {
					inputTokens: 1_125_429,
					outputTokens: 7_049,
					cacheReadTokens: 1_015_493,
					cacheWriteTokens: 0,
					totalTokens: 2_147_971,
				},
			}),
		}));
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);
		const done = getDoneEvent(events);

		expect(done.message.usage.cacheRead).toBe(0);
		expect(done.message.usage.cacheWrite).toBe(0);
		expect(done.message.usage.input).toBeLessThan(1_125_429);
		expect(done.message.usage.totalTokens).toBeLessThan(1_125_429);
	});

	it("uses real per-turn SDK usage instead of prompt estimates or RunResult usage", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "text-delta", text: "done" } });
			opts.onDelta({
				update: {
					type: "turn-ended",
					usage: {
						inputTokens: 25_432,
						outputTokens: 612,
						cacheReadTokens: 24_000,
						cacheWriteTokens: 123,
					},
				},
			});
			return asMockCursorRun({
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({
					id: "run-1",
					status: "finished",
					usage: {
						inputTokens: 6_746_960,
						outputTokens: 17_701,
						cacheReadTokens: 6_559_232,
						cacheWriteTokens: 0,
						totalTokens: 6_764_661,
					},
				}),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			});
		});
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);
		const done = getDoneEvent(events);

		expect(done.message.usage.input).toBe(25_432 - 24_000 - 123);
		expect(done.message.usage.output).toBe(612);
		expect(done.message.usage.cacheRead).toBe(24_000);
		expect(done.message.usage.cacheWrite).toBe(123);
		expect(done.message.usage.totalTokens).toBe(25_432 + 612);
	});

	it("logs usage correlation matching the action journal agent_send line", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cursor-usage-correlation-"));
		vi.stubEnv("CURSOR_SDK_USAGE_LOG", join(dir, "usage.jsonl"));
		vi.stubEnv("CURSOR_SDK_ACTIONS_LOG", join(dir, "actions.jsonl"));
		try {
			const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
				opts.onDelta({ update: { type: "text-delta", text: "done" } });
				opts.onDelta({ update: { type: "turn-ended", usage: { inputTokens: 1_000, outputTokens: 40, cacheReadTokens: 900, cacheWriteTokens: 20 } } });
				return asMockCursorRun({
					id: "run-42",
					agentId: "agent-1",
					status: "finished",
					wait: vi.fn().mockResolvedValue({ id: "run-42", status: "finished", result: "done" }),
					cancel: vi.fn(),
					supports: () => true,
					unsupportedReason: () => undefined,
				});
			});
			mockCreatedAgent({ send: mockSend, [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined) });

			const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
			expect(getDoneEvent(events).reason).toBe("stop");
			await actionLogTestUtils.flush();

			const usageLines = readFileSync(join(dir, "usage.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
			const usageLine = usageLines.find((line) => line.source === "turn");
			expect(usageLines.filter((line) => line.source === "raw")).toHaveLength(1);
			expect(usageLines.find((line) => line.source === "raw")).toMatchObject({ runId: "run-42", usageEventIndex: 1, semantics: "sdk_raw_turn" });
			const sendLines = readFileSync(join(dir, "actions.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
			const agentSend = sendLines.filter((line) => line.action === "agent_send" && line.phase === "success");
			expect(agentSend).toHaveLength(1);
			expect(typeof agentSend[0].turnId).toBe("string");
			expect(agentSend[0].turnId.length).toBeGreaterThan(0);
			expect(usageLine).toMatchObject({ runId: "run-42", mode: "bootstrap", source: "turn", turnId: agentSend[0].turnId });
		} finally {
			vi.unstubAllEnvs();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("falls back to bounded estimates when SDK turn usage exceeds the model window", async () => {
		const mockSend = vi.fn().mockImplementation(async (_msg: unknown, opts: { onDelta: CursorDeltaHandler }) => {
			opts.onDelta({ update: { type: "text-delta", text: "done" } });
			opts.onDelta({
				update: {
					type: "turn-ended",
					usage: {
						inputTokens: 1_125_429,
						outputTokens: 7_049,
						cacheReadTokens: 1_015_493,
						cacheWriteTokens: 0,
					},
				},
			});
			return asMockCursorRun({
				id: "run-1",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
			});
		});
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const events = await collectEvents(streamCursor(makeModel(), makeContext(), { apiKey: "test-key" }));
		const done = getDoneEvent(events);

		expect(done.message.usage.cacheRead).toBe(0);
		expect(done.message.usage.cacheWrite).toBe(0);
		expect(done.message.usage.input).toBeLessThan(1_125_429);
		expect(done.message.usage.totalTokens).toBeLessThan(1_125_429);
	});

	it("keeps failed runs with no SDK usage on the current zero-usage error path", async () => {
		const mockSend = vi.fn().mockResolvedValue(asMockCursorRun({
			id: "run-1",
			agentId: "agent-1",
			status: "error",
			wait: vi.fn().mockResolvedValue({
				id: "run-1",
				status: "error",
				error: { message: "boom" },
			}),
		}));
		mockCreatedAgent({
			send: mockSend,
			[Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
		});

		const stream = streamCursor(makeModel(), makeContext(), { apiKey: "test-key" });
		const events = await collectEvents(stream);
		const error = getErrorEvent(events);

		expect(error.error.usage).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
	});
});
