import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { BeforeAgentStartEvent, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_ACTIVATE_SKILL_MCP_NAME,
	CURSOR_ACTIVATE_SKILL_TOOL_NAME,
	formatCursorSkillsForPrompt,
	registerCursorSkillTool,
	resolveCursorSkillSystemPrompt,
} from "../src/cursor-skill-tool.js";
import { buildCursorPiToolBridgeSnapshot } from "../src/cursor-pi-tool-bridge.js";
import { runHarnessBeforeAgentStartWithPi } from "./helpers/pi-system-prompt.js";
import { registerCursorAgentsContextDedup } from "../src/cursor-agents-context-registration.js";
import { planCursorSessionSend } from "../src/cursor-session-send-policy.js";
import { computeCursorContextFingerprint, buildCursorPrompt } from "../src/context.js";
import {
	createDefaultSystemPromptOptions,
	createExtensionTestContext,
	createPiHarness,
	getHarnessRegisteredTool,
	makeModel,
} from "./helpers/pi-harness.js";

afterEach(() => {
	delete process.env.PI_CURSOR_RUNTIME;
	delete process.env.PI_CURSOR_PI_TOOL_BRIDGE;
});

function makeSkill(overrides: Partial<Skill> & Pick<Skill, "name" | "filePath">): Skill {
	return {
		description: `${overrides.name} description`,
		baseDir: overrides.filePath.slice(0, overrides.filePath.lastIndexOf("/")),
		sourceInfo: {
			source: "test",
			path: overrides.filePath,
			scope: "user",
			origin: "top-level",
		},
		disableModelInvocation: false,
		...overrides,
	};
}

describe("formatCursorSkillsForPrompt", () => {
	it("builds a Cursor-safe pi skill catalog and excludes explicit-only skills", () => {
		const prompt = formatCursorSkillsForPrompt([
			makeSkill({ name: "global-skill", description: "Use for global work", filePath: "/Users/me/.pi/agent/skills/global-skill/SKILL.md" }),
			makeSkill({ name: "manual-only", description: "Manual", filePath: "/skills/manual-only/SKILL.md", disableModelInvocation: true }),
		]);

		expect(prompt).toContain(CURSOR_ACTIVATE_SKILL_MCP_NAME);
		expect(prompt).toContain("<name>global-skill</name>");
		expect(prompt).toContain("/Users/me/.pi/agent/skills/global-skill/SKILL.md");
		expect(prompt).not.toContain("manual-only");
	});
});

describe("resolveCursorSkillSystemPrompt", () => {
	const cursorModel = makeModel("composer-2.5");
	const otherModel = { provider: "anthropic", id: "claude-sonnet-4-5" } as ReturnType<typeof makeModel>;
	const skill = makeSkill({ name: "global-skill", description: "Global pi skill", filePath: "/Users/me/.pi/agent/skills/global-skill/SKILL.md" });
	const piSkillSection = [
		"System prompt before skills.",
		"",
		"The following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"",
		"<available_skills>",
		"  <skill>",
		"    <name>global-skill</name>",
		"    <description>Global pi skill</description>",
		"    <location>/Users/me/.pi/agent/skills/global-skill/SKILL.md</location>",
		"  </skill>",
		"</available_skills>",
	].join("\n");

	it("replaces pi's raw read-based skill wording for Cursor models", () => {
		const resolved = resolveCursorSkillSystemPrompt(
			piSkillSection,
			cursorModel,
			{ ...createDefaultSystemPromptOptions("/repo"), skills: [skill] },
		);

		expect(resolved).toContain(CURSOR_ACTIVATE_SKILL_MCP_NAME);
		expect(resolved).toContain("<name>global-skill</name>");
		expect(resolved).not.toContain("Use the read tool to load a skill's file");
	});

	it("removes Pi skill metadata for cloud Cursor models", () => {
		const resolved = resolveCursorSkillSystemPrompt(
			piSkillSection,
			cursorModel,
			{ ...createDefaultSystemPromptOptions("/repo"), skills: [skill] },
			"cloud",
		);

		expect(resolved).toContain("System prompt before skills.");
		expect(resolved).not.toContain("<available_skills>");
		expect(resolved).not.toContain(CURSOR_ACTIVATE_SKILL_MCP_NAME);
		expect(resolved).not.toContain("/Users/me/.pi/agent/skills");
	});

	it("does not change prompts for non-Cursor models", () => {
		expect(
			resolveCursorSkillSystemPrompt(piSkillSection, otherModel, { ...createDefaultSystemPromptOptions("/repo"), skills: [skill] }),
		).toBe(piSkillSection);
	});

	it("preserves the rewritten catalog through buildCursorPrompt sanitization", () => {
		const resolved = resolveCursorSkillSystemPrompt(
			piSkillSection,
			cursorModel,
			{ ...createDefaultSystemPromptOptions("/repo"), skills: [skill] },
		);
		const prompt = buildCursorPrompt({ systemPrompt: resolved, messages: [] });

		expect(prompt.text).toContain(CURSOR_ACTIVATE_SKILL_MCP_NAME);
		expect(prompt.text).toContain("global-skill");
	});
});

describe("runHarnessBeforeAgentStartWithPi", () => {
	it("preserves handler failure text from the installed runner", async () => {
		const pi = createPiHarness();
		pi.on("before_agent_start", () => { throw new Error("sentinel handler failure"); });
		await expect(runHarnessBeforeAgentStartWithPi(
			pi,
			createDefaultSystemPromptOptions("/repo"),
			createExtensionTestContext({ cwd: "/repo" }),
		)).rejects.toThrow("sentinel handler failure");
	});
});

describe("registerCursorSkillTool", () => {
	it("renders the skill tool in the first forced prompt and keeps the follow-up incremental", async () => {
		const pi = createPiHarness({ activeTools: ["read"] });
		registerCursorSkillTool(pi);
		registerCursorAgentsContextDedup(pi);
		const ctx = createExtensionTestContext({ model: makeModel("composer-2.5"), cwd: "/repo" });
		const tool = getHarnessRegisteredTool(pi._tools, CURSOR_ACTIVATE_SKILL_TOOL_NAME);
		const render = () => runHarnessBeforeAgentStartWithPi(pi, {
			...createDefaultSystemPromptOptions("/repo"),
			selectedTools: pi.getActiveTools(),
			toolSnippets: { [tool.name]: tool.promptSnippet! },
			toolGuidelines: { [tool.name]: tool.promptGuidelines! },
			skills: [makeSkill({ name: "global-skill", filePath: "/skills/global-skill/SKILL.md" })],
		}, ctx);
		const first = await render();
		const second = await render();
		expect(first.systemPrompt).toContain(tool.promptSnippet);
		for (const guideline of tool.promptGuidelines!) expect(first.systemPrompt).toContain(guideline);
		expect(first.options.selectedTools).toContain(tool.name);
		expect(first.options.forceSystemPrompt).toBe(first.systemPrompt);
		expect(second.systemPrompt).toBe(first.systemPrompt);
		const initial = { systemPrompt: first.systemPrompt, messages: [{ role: "user" as const, content: "hello", timestamp: 1 }] };
		expect(planCursorSessionSend({ bootstrapped: false, contextFingerprint: "", incrementalSendCount: 0 }, initial))
			.toEqual({ mode: "bootstrap", reason: "initial", resetAgent: false });
		const state = { bootstrapped: true, contextFingerprint: computeCursorContextFingerprint(initial), incrementalSendCount: 0 };
		const followup = { systemPrompt: second.systemPrompt, messages: [...initial.messages, { role: "user" as const, content: "follow up", timestamp: 2 }] };
		expect(planCursorSessionSend(state, followup)).toEqual({ mode: "incremental", reason: "incremental", resetAgent: false });
		expect(planCursorSessionSend(state, { ...followup, systemPrompt: `${second.systemPrompt} changed` }))
			.toEqual({ mode: "bootstrap", reason: "context_divergence", resetAgent: true });
	});

	it.each(["disabled", "selection-disabled", "bridge-off", "cloud", "other-model", "no-skills"])(
		"keeps skill tool declarations inactive for %s",
		async (boundary) => {
			if (boundary === "bridge-off") process.env.PI_CURSOR_PI_TOOL_BRIDGE = "0";
			if (boundary === "cloud") process.env.PI_CURSOR_RUNTIME = "cloud";
			const pi = createPiHarness({ activeTools: boundary === "disabled" ? [] : ["read"] });
			registerCursorSkillTool(pi);
			const tool = getHarnessRegisteredTool(pi._tools, CURSOR_ACTIVATE_SKILL_TOOL_NAME);
			const selectedTools = boundary === "selection-disabled" ? [] : pi.getActiveTools();
			const result = await runHarnessBeforeAgentStartWithPi(pi, {
				...createDefaultSystemPromptOptions("/repo"), selectedTools,
				toolSnippets: { [tool.name]: tool.promptSnippet! },
				toolGuidelines: { [tool.name]: tool.promptGuidelines! },
				skills: boundary === "no-skills" ? [] : [makeSkill({ name: "global-skill", filePath: "/skills/global-skill/SKILL.md" })],
			}, createExtensionTestContext({
				cwd: "/repo", model: boundary === "other-model" ? { ...makeModel(), provider: "anthropic", api: "anthropic-messages" } : makeModel(),
			}));
			expect(pi.getActiveTools()).not.toContain(tool.name);
			expect(result.options.selectedTools).toEqual(selectedTools);
			expect(result.systemPrompt).not.toContain(tool.promptSnippet);
			for (const guideline of tool.promptGuidelines!) expect(result.systemPrompt).not.toContain(guideline);
			if (boundary === "no-skills" || boundary === "cloud") expect(result.systemPrompt).not.toContain("<available_skills>");
		},
	);

	it("preserves an earlier handler's explicit selection rather than copying all active tools", async () => {
		const pi = createPiHarness({ activeTools: ["read", "bash"] });
		pi.on("before_agent_start", (event) => { event.systemPromptOptions.selectedTools = ["read"]; });
		registerCursorSkillTool(pi);
		const result = await runHarnessBeforeAgentStartWithPi(pi, {
			...createDefaultSystemPromptOptions("/repo"), selectedTools: pi.getActiveTools(),
			skills: [makeSkill({ name: "global-skill", filePath: "/skills/global-skill/SKILL.md" })],
		}, createExtensionTestContext({ cwd: "/repo", model: makeModel() }));
		expect(result.options.selectedTools).toEqual(["read", CURSOR_ACTIVATE_SKILL_TOOL_NAME]);
	});

	it("adds a bridgeable activation tool for Cursor runs with visible pi skills", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-cursor-skill-"));
		const skillDir = join(dir, "global-skill");
		await mkdir(join(skillDir, "references"), { recursive: true });
		const skillPath = join(skillDir, "SKILL.md");
		await writeFile(skillPath, "---\nname: global-skill\ndescription: Global skill\n---\n# Global Skill\nFollow this skill.");
		await writeFile(join(skillDir, "references", "guide.md"), "Reference details");
		const skill = makeSkill({ name: "global-skill", description: "Global skill", filePath: skillPath });
		const pi = createPiHarness({ activeTools: ["read"] });
		registerCursorSkillTool(pi);

		const result = await pi.invokeEvent(
			"before_agent_start",
			{
				type: "before_agent_start",
				prompt: "hello",
				systemPrompt: "System prompt.",
				systemPromptOptions: { ...createDefaultSystemPromptOptions(dir), skills: [skill] },
			} satisfies BeforeAgentStartEvent,
			{ model: makeModel("composer-2.5"), cwd: dir },
		);

		expect(result?.systemPrompt).toContain(CURSOR_ACTIVATE_SKILL_MCP_NAME);
		expect(pi._activeToolNames()).toContain(CURSOR_ACTIVATE_SKILL_TOOL_NAME);
		expect(buildCursorPiToolBridgeSnapshot(pi).piToolNameToMcpToolName.get(CURSOR_ACTIVATE_SKILL_TOOL_NAME)).toBe(CURSOR_ACTIVATE_SKILL_MCP_NAME);

		const tool = getHarnessRegisteredTool(pi._tools, CURSOR_ACTIVATE_SKILL_TOOL_NAME);
		const toolResult = await tool.execute("call-1", { name: "global-skill" }, undefined, undefined, createExtensionTestContext({ model: makeModel("composer-2.5"), cwd: dir }));
		const text = toolResult.content?.[0]?.type === "text" ? toolResult.content[0].text : "";

		expect(toolResult).not.toMatchObject({ isError: true });
		expect(text).toContain("<skill_content name=\"global-skill\">");
		expect(text).toContain("# Global Skill");
		expect(text).toContain("references/guide.md");
	});

	it("keeps the activation tool exposed through Cursor turn_start after prompt rewrite", async () => {
		const skill = makeSkill({ name: "global-skill", description: "Global skill", filePath: "/repo/global-skill/SKILL.md" });
		const pi = createPiHarness({ activeTools: ["read"] });
		const model = makeModel("composer-2.5");
		registerCursorSkillTool(pi);

		await pi.invokeEvent(
			"before_agent_start",
			{
				type: "before_agent_start",
				prompt: "hello",
				systemPrompt: "System prompt.",
				systemPromptOptions: { ...createDefaultSystemPromptOptions("/repo"), skills: [skill] },
			} satisfies BeforeAgentStartEvent,
			{ model, cwd: "/repo" },
		);
		expect(pi._activeToolNames()).toContain(CURSOR_ACTIVATE_SKILL_TOOL_NAME);

		await pi.runTurnStart({ model, cwd: "/repo" });

		expect(pi._activeToolNames()).toContain(CURSOR_ACTIVATE_SKILL_TOOL_NAME);
		expect(buildCursorPiToolBridgeSnapshot(pi).piToolNameToMcpToolName.get(CURSOR_ACTIVATE_SKILL_TOOL_NAME)).toBe(CURSOR_ACTIVATE_SKILL_MCP_NAME);
	});

	it("keeps the activation tool inactive and omits the catalog in cloud runtime", async () => {
		process.env.PI_CURSOR_RUNTIME = "cloud";
		const skill = makeSkill({ name: "global-skill", description: "Global skill", filePath: "/repo/global-skill/SKILL.md" });
		const pi = createPiHarness({ activeTools: ["read"] });
		registerCursorSkillTool(pi);

		const result = await pi.invokeEvent(
			"before_agent_start",
			{
				type: "before_agent_start",
				prompt: "hello",
				systemPrompt: [
					"System prompt.",
					"",
					"The following skills provide specialized instructions for specific tasks.",
					"<available_skills><skill><name>global-skill</name><location>/repo/global-skill/SKILL.md</location></skill></available_skills>",
				].join("\n"),
				systemPromptOptions: { ...createDefaultSystemPromptOptions("/repo"), skills: [skill] },
			} satisfies BeforeAgentStartEvent,
			{ model: makeModel("composer-2.5"), cwd: "/repo" },
		);

		expect(result?.systemPrompt).not.toContain("<available_skills>");
		expect(result?.systemPrompt).not.toContain("/repo/global-skill/SKILL.md");
		expect(pi._activeToolNames()).not.toContain(CURSOR_ACTIVATE_SKILL_TOOL_NAME);
	});

	it("ignores invalid Cursor runtime overrides for non-Cursor models", async () => {
		process.env.PI_CURSOR_RUNTIME = "remote";
		const pi = createPiHarness({ activeTools: ["read"] });
		registerCursorSkillTool(pi);
		const model = { provider: "anthropic", id: "claude-sonnet-4-5" } as ExtensionContext["model"];

		const result = await pi.invokeEvent(
			"before_agent_start",
			{
				type: "before_agent_start",
				prompt: "hello",
				systemPrompt: "System prompt.",
				systemPromptOptions: createDefaultSystemPromptOptions("/repo"),
			} satisfies BeforeAgentStartEvent,
			{ model, cwd: "/repo" },
		);

		expect(result).toBeUndefined();
		expect(pi._activeToolNames()).not.toContain(CURSOR_ACTIVATE_SKILL_TOOL_NAME);
	});

	it("does not expose the activation tool when no visible skills are available", async () => {
		const pi = createPiHarness({ activeTools: ["read"] });
		registerCursorSkillTool(pi);
		await pi.invokeEvent(
			"before_agent_start",
			{
				type: "before_agent_start",
				prompt: "hello",
				systemPrompt: "System prompt.",
				systemPromptOptions: createDefaultSystemPromptOptions("/repo"),
			} satisfies BeforeAgentStartEvent,
			{ model: makeModel("composer-2.5"), cwd: "/repo" },
		);

		expect(pi._activeToolNames()).not.toContain(CURSOR_ACTIVATE_SKILL_TOOL_NAME);
	});
});
