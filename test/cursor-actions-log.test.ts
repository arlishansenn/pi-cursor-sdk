import * as fs from "node:fs/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendCursorAction, traceCursorAction, withCursorActionTurn, __testUtils } from "../src/cursor-actions-log.js";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, appendFile: vi.fn(actual.appendFile) };
});

const dirs: string[] = [];
async function destination() {
	const dir = await mkdtemp(join(tmpdir(), "cursor-actions-"));
	dirs.push(dir);
	const path = join(dir, "nested", "actions.jsonl");
	vi.stubEnv("CURSOR_SDK_ACTIONS_LOG", path);
	return path;
}
afterEach(async () => {
	await __testUtils.flush();
	vi.unstubAllEnvs();
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("async action journal", () => {
	it("returns without waiting for disk and preserves event order in real JSONL", async () => {
		const path = await destination();
		for (let i = 0; i < 20; i++) {
			expect(appendCursorAction({ action: "send_plan", phase: "decision", instanceId: i })).toBeUndefined();
		}
		await __testUtils.flush();
		const rows = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		expect(rows.map((row) => row.instanceId)).toEqual(Array.from({ length: 20 }, (_, i) => i));
		expect(new Set(rows.map((row) => row.processId)).size).toBe(1);
		expect(rows[19].seq - rows[0].seq).toBe(19);
	});

	it("records attempt and failure without leaking an SDK error or changing its identity", async () => {
		const path = await destination();
		const failure = new Error("secret-api-key and prompt text");
		await expect(traceCursorAction({ action: "agent_resume", agentId: "agent-old" }, async () => {
			throw failure;
		})).rejects.toBe(failure);
		await __testUtils.flush();
		const text = await readFile(path, "utf8");
		const rows = text.trim().split("\n").map((line) => JSON.parse(line));
		expect(rows.map((row) => row.phase)).toEqual(["start", "error"]);
		expect(rows[0].operationId).toBe(rows[1].operationId);
		expect(text).not.toContain("secret-api-key");
	});

	it("logging failure cannot change the operation result and later writes still work", async () => {
		const path = await destination();
		const blocker = join(dirs[dirs.length - 1], "file");
		await writeFile(blocker, "not a directory");
		vi.stubEnv("CURSOR_SDK_ACTIONS_LOG", join(blocker, "actions.jsonl"));
		expect(await traceCursorAction({ action: "agent_create" }, async () => 42)).toBe(42);
		await __testUtils.flush();
		vi.stubEnv("CURSOR_SDK_ACTIONS_LOG", path);
		appendCursorAction({ action: "send_plan", phase: "decision" });
		await __testUtils.flush();
		const row = JSON.parse((await readFile(path, "utf8")).trim());
		expect(row.writeFailures).toBeGreaterThan(0);
	});

	it("bounds queued records and reports dropped records", async () => {
		const path = await destination();
		for (let i = 0; i < 1200; i++) appendCursorAction({ action: "send_plan", phase: "decision" });
		await __testUtils.flush();
		appendCursorAction({ action: "send_plan", phase: "decision" });
		await __testUtils.flush();
		const rows = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		expect(rows.length).toBeLessThan(1201);
		expect(rows.at(-1).dropped).toBeGreaterThan(0);
	});

	it("a stalled disk write does not delay the SDK operation", async () => {
		await destination();
		let release = () => {};
		const blocked = new Promise<void>((resolve) => { release = resolve; });
		const writer = vi.spyOn(fs, "appendFile").mockImplementation(async () => blocked);
		try {
			expect(await traceCursorAction({ action: "agent_send" }, async () => "sdk-result")).toBe("sdk-result");
			await vi.waitFor(() => expect(writer).toHaveBeenCalled());
		} finally {
			release();
			await __testUtils.flush();
			writer.mockRestore();
		}
	});

	it("keeps overlapping turns and operation attempts independently correlated", async () => {
		const path = await destination();
		let release = () => {};
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const first = withCursorActionTurn(async () => {
			appendCursorAction({ action: "send_plan", phase: "decision", instanceId: 1 });
			await gate;
			await traceCursorAction({ action: "agent_send", instanceId: 1 }, async () => "first");
		});
		await withCursorActionTurn(async () => {
			appendCursorAction({ action: "send_plan", phase: "decision", instanceId: 2 });
			await traceCursorAction({ action: "agent_send", instanceId: 2 }, async () => "second");
		});
		release();
		await first;
		await __testUtils.flush();
		const rows = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
		expect(new Set(rows.map((row) => row.turnId)).size).toBe(2);
		for (const id of [1, 2]) {
			const turn = rows.filter((row) => row.instanceId === id);
			expect(new Set(turn.map((row) => row.turnId)).size).toBe(1);
			expect(turn[0].turnId).toEqual(expect.any(String));
			expect(turn[1].operationId).toBe(turn[2].operationId);
		}
	});

	it("does not expose a sensitive session filename", async () => {
		const path = await destination();
		appendCursorAction({ action: "send_plan", phase: "decision", scopeKey: "/private/customer-secret.jsonl" });
		await __testUtils.flush();
		const text = await readFile(path, "utf8");
		expect(text).not.toContain("customer-secret");
		expect(JSON.parse(text).scopeId).toEqual(expect.any(String));
	});

	it("supports disabling the journal", async () => {
		const path = await destination();
		vi.stubEnv("CURSOR_SDK_ACTIONS_LOG", "0");
		appendCursorAction({ action: "send_plan", phase: "decision" });
		await __testUtils.flush();
		await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
