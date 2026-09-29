import { describe, expect, it } from "vitest";
import { scanForSecrets } from "../scripts/platform-smoke/artifact-secrets.mjs";

describe("scanForSecrets credential-bearing SCP URL", () => {
	it("keeps reporting real SCP-style credentials", () => {
		expect(scanForSecrets("deploy via user:secretpw@example.com:/srv/data")).toContain("potential credential-bearing SCP URL");
		expect(scanForSecrets("rsync -e ssh admin:hunter2@10.0.0.1:/var/www ")).toContain("potential credential-bearing SCP URL");
	});

	it("does not flag package coordinates with versions from pi --list output", () => {
		expect(scanForSecrets("  npm:pi-subagents@0.70.0 (filtered)\n  git:github.com/a/b@abcdef123 ")).toEqual([]);
		expect(scanForSecrets("dependency pkg@1.2 resolved")).toEqual([]);
	});
});
