import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@cursor/sdk";
import { SqliteLocalAgentStore } from "@cursor/sdk/sqlite";
import { describe, expect, it } from "vitest";
import { readInstalledPackageVersion, resolveInstalledPackageRoot } from "./helpers/installed-package.js";

describe("installed Cursor SDK checkpoint contract", () => {
	it("resumes by agent id only and exposes checkpoint refs without a history selector", () => {
		expect(readInstalledPackageVersion("@cursor/sdk")).toBe("1.0.32");
		const root = resolveInstalledPackageRoot("@cursor/sdk");
		const stubs = readFileSync(join(root, "dist/esm/stubs.d.ts"), "utf8");
		const agent = readFileSync(join(root, "dist/esm/agent.d.ts"), "utf8");
		const runs = readFileSync(join(root, "dist/esm/run-store-public-types.d.ts"), "utf8");
		const localStore = readFileSync(join(root, "dist/esm/store/local-agent-store.d.ts"), "utf8");

		expect(stubs).toContain("static resume(agentId: string, options?: Partial<AgentOptions>): Promise<SDKAgent>");
		expect(stubs).not.toMatch(/static resume\([^)]*checkpoint/i);
		expect(agent).not.toMatch(/checkpoint/i);
		expect(runs).toContain("export type SdkConversationStateStructure = unknown");
		expect(runs).toContain("loadLatest(agentId: string)");
		expect(runs).toContain("saveCheckpoint(agentId: string, checkpoint: SdkConversationStateStructure)");
		expect(localStore).toContain("rootBlobId: string");
		expect(localStore).toContain("latestCheckpoint?: LocalAgentCheckpointRef | null");
		expect(localStore).not.toMatch(/restore|rewind|checkout/i);
	});

	it("keeps a seeded null checkpoint head unchanged when Agent.create rejects a fake key", async () => {
		const stateRoot = mkdtempSync(join(tmpdir(), "cursor-ckpt-contract-"));
		const store = await SqliteLocalAgentStore.open({ workspaceRef: stateRoot, stateRoot });
		try {
			const agentId = "agent-probecontract";
			const created = await store.agents.create({
				agent: { agentId, cwd: stateRoot, status: "idle", createdAt: 1, updatedAt: 1, latestCheckpoint: null },
			});
			expect(created.latestCheckpoint ?? null).toBeNull();
			const before = {
				agents: (await store.agents.list()).items.map((agent) => agent.agentId),
				checkpoints: (await store.checkpoints.list()).items,
				runs: (await store.runs.list()).items.map((run) => run.runId),
			};
			await expect(Agent.create({
				apiKey: "invalid-user-api-key",
				model: { id: "composer-2.5" },
				local: { cwd: stateRoot, store, settingSources: [] },
			})).rejects.toThrow(/Invalid User API Key/);
			expect((await store.agents.get({ agentId }))?.latestCheckpoint ?? null).toBeNull();
			expect({
				agents: (await store.agents.list()).items.map((agent) => agent.agentId),
				checkpoints: (await store.checkpoints.list()).items,
				runs: (await store.runs.list()).items.map((run) => run.runId),
			}).toEqual(before);
		} finally {
			await store.dispose();
			rmSync(stateRoot, { recursive: true, force: true });
		}
	});
});
