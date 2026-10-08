import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Gate only the first SDK load in this file: the warmup under test must be parked
// inside loadCursorSdk when the shutdown lands.
const sdkLoad = vi.hoisted(() => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let gated = true;
	return {
		gate,
		releaseFirst: () => {
			gated = false;
			release?.();
		},
		consumeGate: () => {
			if (!gated) return Promise.resolve();
			return gate;
		},
	};
});

vi.mock("../src/cursor-sdk-runtime.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/cursor-sdk-runtime.js")>();
	return {
		loadCursorSdk: vi.fn(async (...args: Parameters<typeof actual.loadCursorSdk>) => {
			await sdkLoad.consumeGate();
			return actual.loadCursorSdk(...args);
		}),
	};
});

import { __testUtils as actionLog } from "../src/cursor-actions-log.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { __testUtils as resumeTestUtils } from "../src/cursor-session-agent-resume.js";
import { __testUtils as ledgerTestUtils } from "../src/cursor-checkpoint-ledger.js";
import { loadCursorSdk } from "../src/cursor-sdk-runtime.js";
import {
	scheduleSessionCursorAgentWarmup,
	__testUtils as sessionAgentTestUtils,
} from "../src/cursor-session-agent.js";
import { registerCursorSessionAgentLifecycle } from "../src/cursor-session-agent-lifecycle.js";
import { createEventHarness } from "./helpers/pi-harness.js";
import { mockedConfigureCursor, mockedCreate, resetCursorProviderTestState } from "./helpers/cursor-provider-harness.js";

const SCOPE_KEY = "/tmp/sessions/warm-sdkload.jsonl";
const CWD = "/tmp/warm-sdkload-project";
const MODEL_ID = "gpt-5.5@1m";

describe("cursor-session-agent warmup deferred SDK load", () => {
	let actionDir: string;
	let actionPath: string;

	beforeEach(async () => {
		await resetCursorProviderTestState();
		ledgerTestUtils.reset();
		resumeTestUtils.reset();
		await sessionAgentTestUtils.disposeAllSessionCursorAgents();
		cursorSessionScopeTestUtils.set(CWD, SCOPE_KEY);
		actionDir = mkdtempSync(join(tmpdir(), "cursor-warm-sdkload-"));
		actionPath = join(actionDir, "actions.jsonl");
		vi.stubEnv("CURSOR_SDK_ACTIONS_LOG", actionPath);
		vi.stubEnv("CURSOR_API_KEY", "test-key");
	});

	afterEach(async () => {
		await actionLog.flush();
		vi.unstubAllEnvs();
		rmSync(actionDir, { recursive: true, force: true });
		await sessionAgentTestUtils.disposeAllSessionCursorAgents();
	});

	it("never reaches configure or create when a shutdown lands while the SDK load is still pending", async () => {
		const mockedLoadCursorSdk = vi.mocked(loadCursorSdk);
		scheduleSessionCursorAgentWarmup(MODEL_ID);
		await vi.waitFor(() => expect(mockedLoadCursorSdk).toHaveBeenCalledTimes(1));

		const pi = createEventHarness();
		registerCursorSessionAgentLifecycle(pi);
		await pi.runSessionShutdown({ reason: "reload" });
		sdkLoad.releaseFirst();

		await vi.waitFor(async () => {
			const rows = readFileSync(actionPath, "utf8").trim().split("\n").filter(Boolean);
			const warm = rows
				.map((line) => JSON.parse(line) as Record<string, unknown>)
				.filter((row) => row.action === "agent_warm")
				.map((row) => `${row.phase}:${row.reason ?? ""}`);
			expect(warm).toContain("decision:skip_stale");
		});
		expect(mockedCreate).not.toHaveBeenCalled();
		expect(mockedConfigureCursor).not.toHaveBeenCalled();
		expect(sessionAgentTestUtils.getSessionCursorAgentPoolState(SCOPE_KEY).status).toBe("empty");
	});
});
