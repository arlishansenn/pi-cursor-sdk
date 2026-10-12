import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runRecoveryProcess } from "../scripts/lib/source-install-recovery-process.mjs";

const options = { cwd: tmpdir(), env: { PATH: "/usr/bin:/bin" }, timeoutMs: 2_000, graceMs: 100 };
const posix = { skip: process.platform === "win32" };

test("captures output and nonzero exit without losing cleanup confirmation", posix, async () => {
  const result = await runRecoveryProcess(process.execPath, ["-e", "console.log('out'); console.error('err'); process.exitCode=7"], options);
  assert.equal(result.status, 7);
  assert.equal(result.stdout, "out\n");
  assert.equal(result.stderr, "err\n");
  assert.equal(result.cleanupSafe, true);
  assert.equal(result.error, undefined);
});

test("missing executable returns its error and confirms no spawned child", posix, async () => {
  const result = await runRecoveryProcess("/nonexistent/recovery-command", [], options);
  assert.equal(result.error.code, "ENOENT");
  assert.equal(result.cleanupSafe, true);
});

test("timeout kills a resistant grandchild or refuses workspace cleanup", posix, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "recovery-timeout-test-"));
  const pidFile = join(cwd, "grandchild.pid");
  const grandchild = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 100);`;
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {stdio:'ignore'}); process.on('SIGTERM', () => {}); setInterval(() => {}, 100);`;
  const result = await runRecoveryProcess(process.execPath, ["-e", parent], { ...options, cwd, timeoutMs: 1_000 });
  assert(existsSync(pidFile), "grandchild actually started before timeout");
  const pid = Number(readFileSync(pidFile, "utf8"));
  let gone = false;
  try { process.kill(pid, 0); } catch (error) { gone = error.code === "ESRCH"; }
  assert(result.error, "timeout must fail the command");
  if (result.cleanupSafe) {
    assert(gone, "cleanup requires descendant exit evidence");
    rmSync(cwd, { recursive: true, force: true });
  } else {
    assert.match(result.error.message, /termination unconfirmed/);
    assert(existsSync(cwd), "uncertain child status retains scratch");
    console.error(`Unconfirmed descendant termination; scratch retained at ${cwd}`);
  }
});

test("signal exit is not reported as ordinary success", posix, async () => {
  const result = await runRecoveryProcess(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], options);
  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.status, null);
  assert.equal(result.cleanupSafe, true);
});

test("bounded output failure terminates the child group", posix, async () => {
  const result = await runRecoveryProcess(process.execPath, ["-e", "for (;;) require('node:fs').writeSync(1, 'x'.repeat(1024 * 1024))"], options);
  assert.match(result.error.message, /output exceeded/);
  assert.equal(result.cleanupSafe, true);
  assert(result.stdout.length <= 32 * 1024 * 1024);
});
