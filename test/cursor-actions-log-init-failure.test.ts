import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Observation-plane regression guard: span initialization (UUID/scope/timer) is
// outside appendCursorAction's own try/catch, so a failing crypto primitive must
// not stop the wrapped SDK operation or change its result/exception identity.
vi.mock("node:crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	let randomUuidFails = false;
	return {
		...actual,
		randomUUID: () => {
			if (randomUuidFails) throw new Error("observation UUID failure");
			return actual.randomUUID();
		},
		__setRandomUuidFailure: (value: boolean) => {
			randomUuidFails = value;
		},
	};
});

type CryptoMock = { __setRandomUuidFailure: (value: boolean) => void };

async function setRandomUuidFailure(value: boolean): Promise<void> {
	const mock = (await import("node:crypto")) as unknown as CryptoMock;
	mock.__setRandomUuidFailure(value);
}

import { appendCursorAction, noteCursorActionFirstText, traceCursorAction, traceCursorSyncAction, withCursorActionTurn, __testUtils } from "../src/cursor-actions-log.js";
import { getCursorActionTurnId } from "../src/cursor-actions-log.js";

const dirs: string[] = [];
async function destination(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "cursor-actions-init-"));
	dirs.push(dir);
	const path = join(dir, "actions.jsonl");
	vi.stubEnv("CURSOR_SDK_ACTIONS_LOG", path);
	return path;
}

afterEach(async () => {
	await __testUtils.flush();
	vi.unstubAllEnvs();
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("action journal best-effort initialization", () => {
	it("runs the operation and preserves its result when span initialization fails", async () => {
		const path = await destination();
		await setRandomUuidFailure(true);
		try {
			await expect(traceCursorAction({ action: "store_open", runtime: "local" }, async () => "sdk-store")).resolves.toBe("sdk-store");
			expect(traceCursorSyncAction({ action: "sdk_load", runtime: "local" }, () => 42)).toBe(42);
			expect(withCursorActionTurn(() => "turn-result")).toBe("turn-result");
			expect(() => noteCursorActionFirstText()).not.toThrow();
			expect(() => appendCursorAction({ action: "send_plan", phase: "decision" })).not.toThrow();
		} finally {
			await setRandomUuidFailure(false);
		}
		// The failed spans recorded nothing, but direct appends still landed; later
		// rows surface the initialization failures through writeFailures.
		await __testUtils.flush();
		const failedPhaseRows = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { action: string; writeFailures: number });
		expect(failedPhaseRows.map((row) => row.action)).toEqual(["send_plan"]);
		expect(failedPhaseRows[0]!.writeFailures).toBeGreaterThan(0);
		appendCursorAction({ action: "send_plan", phase: "decision" });
		await __testUtils.flush();
		const recoveredRows = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { action: string });
		expect(recoveredRows).toHaveLength(2);
	});

	it("preserves the business exception identity when span initialization fails", async () => {
		await destination();
		await setRandomUuidFailure(true);
		const failure = new Error("sdk resumed to a corrupt store");
		try {
			await expect(
				traceCursorAction({ action: "agent_resume", agentId: "agent-old", runtime: "local" }, async () => {
					throw failure;
				}),
			).rejects.toBe(failure);
			expect(() =>
				traceCursorSyncAction({ action: "bridge_setup", runtime: "local" }, () => {
					throw failure;
				}),
			).toThrow(failure);
		} finally {
			await setRandomUuidFailure(false);
		}
	});

	it("keeps turn correlation optional when turn initialization fails", async () => {
		await setRandomUuidFailure(true);
		try {
			let seenInsideTurn: string | undefined;
			const result = withCursorActionTurn(() => {
				seenInsideTurn = getCursorActionTurnId();
				return "ok";
			});
			expect(result).toBe("ok");
			expect(seenInsideTurn).toBeUndefined();
		} finally {
			await setRandomUuidFailure(false);
		}
	});
});
