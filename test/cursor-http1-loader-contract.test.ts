import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("preserves HTTP cleanup ownership across installed Pi loader module replacement offline", () => {
	const output = execFileSync(process.execPath, ["test/helpers/cursor-http1-loader-contract.mjs"], {
		cwd: process.cwd(), encoding: "utf8", timeout: 30_000,
	});
	expect(output).toContain("cleanup ordering and retirement survive replacement");
});
