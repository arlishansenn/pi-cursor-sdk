/**
 * Test fixture: a parent process that owns one hanging child through
 * probe-provider-coldstart's child lifecycle helper, so a test can interrupt the
 * parent and assert the child tree does not survive it. Prints the pid-file path
 * first; the hanging child writes its own pid there.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScenarioChildProcess } from "../probe-provider-coldstart.mjs";

const dir = mkdtempSync(join(tmpdir(), "probe-signal-fixture-"));
const pidFile = join(dir, "child.pid");
console.log(pidFile);
const result = await runScenarioChildProcess({
	command: process.execPath,
	args: [
		"-e",
		"require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);",
		pidFile,
	],
	env: { ...process.env },
	timeoutMs: 60_000,
});
console.log(JSON.stringify({ ok: result.ok, timedOut: result.timedOut }));
