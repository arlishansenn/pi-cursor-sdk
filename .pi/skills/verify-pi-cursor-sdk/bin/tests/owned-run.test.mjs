import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownedRun, ownedEnv, userParityEnv, initBudget, reserveTurns, root, repo } from '../owned-run.mjs';
import { assertNativeRead, assertNestedReuse } from '../rpc-proof.mjs';

const secret = 'opaque-cursor-credential-123456';
process.env.CURSOR_API_KEY = secret;
const bridge = 'http://127.0.0.1:9999/cursor-pi-tool-bridge/secret-token/mcp';
const readAll = dir => readdirSync(dir, { withFileTypes: true }).map(item => item.isDirectory() ? readAll(join(dir, item.name)) : readFileSync(join(dir, item.name), 'utf8')).join('\n');

test('complete stdout, stderr, errors and sink copies scrub split secrets and bridge URLs', async () => {
  const feature = `offline-scrub-${process.pid}`;
  let dir;
  await assert.rejects(ownedRun(feature, async context => {
    dir = context.dir;
    await context.run(process.execPath, ['-e', `const fs=require('fs');const s=process.env.CURSOR_API_KEY;process.stdout.write(s.slice(0,9));setTimeout(()=>{process.stdout.write(s.slice(9)+' ${bridge}');process.stderr.write(s+' ${bridge}');fs.writeFileSync(process.env.CURSOR_SDK_ACTIONS_LOG,JSON.stringify({scopeId:'correlation-123',message:s+' ${bridge}'}));process.exit(2)},20)`]);
  }), /Child exit/);
  const all = readAll(dir);
  assert.ok(!all.includes(secret));
  assert.ok(!all.includes('secret-token'));
  assert.ok(all.includes('[redacted]'));
  assert.ok(all.includes('correlation-123'));
  assert.match(readFileSync(join(dir, 'result.txt'), 'utf8'), /^FAIL/);
  rmSync(join(root, 'evidence', feature), { recursive: true });
});

test('coldstart timeout retains actual partial journals without copying private temp siblings', { timeout: 12000 }, async () => {
  const feature = `offline-coldstart-timeout-${process.pid}`;
  let dir, scratch;
  try {
    await assert.rejects(ownedRun(feature, async context => {
      ({ dir, scratch } = context);
      await context.run(process.execPath, [join(import.meta.dirname, 'coldstart-timeout-fixture.mjs')], { timeoutMs: 1000 });
    }), /Deadline exceeded/);
    assert.equal(readFileSync(join(dir, '1.stdout.txt'), 'utf8'), 'READY\n');
    const status = JSON.parse(readFileSync(join(dir, '1.status.json'), 'utf8'));
    assert.equal(status.cleanupError, undefined);
    assert.equal(status.closed, true);
    assert.ok(!existsSync(scratch));
    assert.match(readFileSync(join(dir, 'result.txt'), 'utf8'), /^FAIL/);
    const partial = join(dir, 'sinks/partial-coldstart');
    const runs = readdirSync(partial);
    assert.equal(runs.length, 1);
    const work = join(partial, runs[0]);
    for (const [file, marker] of [
      [join(work, 'actions.jsonl'), 'partial-coldstart-action'],
      [join(work, 'debug-events/sessions/fixture/turn-001-fixture/provider-events.jsonl'), 'partial-coldstart-debug'],
    ]) {
      const row = JSON.parse(readFileSync(file, 'utf8'));
      assert.equal(row.marker, marker);
      assert.equal(row.secret, '[redacted]');
      assert.ok(!row.bridge.includes('private-fixture-token'));
    }
    assert.deepEqual(readdirSync(work).sort(), ['actions.jsonl', 'debug-events']);
    const all = readAll(dir);
    assert.ok(!all.includes(secret));
    assert.ok(!all.includes('private-fixture-token'));
    assert.ok(!all.includes('DO_NOT_COPY_'));
  } finally {
    rmSync(join(root, 'evidence', feature), { recursive: true, force: true });
  }
});

test('output environment is owned and native switches are pinned', () => {
  const scratch = '/owned';
  const env = ownedEnv(scratch, { PATH: '/bin', CURSOR_SDK_ACTIONS_LOG: '/outside/actions', CURSOR_SDK_USAGE_LOG: '/outside/usage', PI_CURSOR_SDK_EVENT_DEBUG_DIR: '/outside/debug', PI_CURSOR_SDK_EVENT_DEBUG: '1', PI_CURSOR_NATIVE_TOOL_DISPLAY: '0', PI_CURSOR_REGISTER_NATIVE_TOOLS: '0', PI_PACKAGE_DIR: '/outside/pi' });
  assert.equal(env.CURSOR_SDK_ACTIONS_LOG, '/owned/sinks/actions.jsonl');
  assert.equal(env.CURSOR_SDK_USAGE_LOG, '/owned/sinks/usage.jsonl');
  assert.equal(env.TMPDIR, '/owned/tmp');
  assert.equal(env.PI_CURSOR_NATIVE_TOOL_DISPLAY, '1');
  assert.equal(env.PI_CURSOR_REGISTER_NATIVE_TOOLS, '1');
  assert.equal(env.PI_CURSOR_SETTING_SOURCES, 'none');
  assert.equal(env.PI_PACKAGE_DIR, undefined);
  assert.ok(!Object.keys(env).some(key => key.startsWith('PI_CURSOR_SDK_EVENT_DEBUG')));
});

test('user parity env isolates identity only and deletes behavioral overrides', () => {
  const scratch = '/owned';
  const env = userParityEnv(scratch, { PATH: '/usr/bin:/bin', TMPDIR: '/user/tmp', CURSOR_SDK_ACTIONS_LOG: '/outside/actions', CURSOR_SDK_USAGE_LOG: '/outside/usage', PI_CURSOR_SDK_EVENT_DEBUG: '1', PI_CURSOR_SDK_EVENT_DEBUG_DIR: '/outside/debug', PI_CURSOR_PI_TOOL_BRIDGE: '0', PI_CURSOR_NATIVE_TOOL_DISPLAY: '0', PI_CURSOR_REGISTER_NATIVE_TOOLS: '0', PI_CURSOR_EXPOSE_BUILTIN_TOOLS: '1', PI_CURSOR_PI_TOOL_BRIDGE_DEBUG: '1', PI_CURSOR_PI_TOOL_BRIDGE_DEBUG_FILE: '/outside/bridge.log', PI_PACKAGE_DIR: '/outside/pi' });
  assert.equal(env.HOME, '/owned/home');
  assert.equal(env.PI_CODING_AGENT_DIR, '/owned/home/.pi/agent');
  assert.equal(env.PI_CURSOR_SETTING_SOURCES, 'none');
  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.equal(env.TMPDIR, '/user/tmp');
  for (const name of ['CURSOR_SDK_ACTIONS_LOG', 'CURSOR_SDK_USAGE_LOG', 'PI_CURSOR_PI_TOOL_BRIDGE', 'PI_CURSOR_NATIVE_TOOL_DISPLAY', 'PI_CURSOR_REGISTER_NATIVE_TOOLS', 'PI_CURSOR_EXPOSE_BUILTIN_TOOLS', 'PI_CURSOR_PI_TOOL_BRIDGE_DEBUG', 'PI_CURSOR_PI_TOOL_BRIDGE_DEBUG_FILE', 'PI_PACKAGE_DIR']) assert.equal(env[name], undefined, name);
  assert.ok(!Object.keys(env).some(key => key.startsWith('PI_CURSOR_SDK_EVENT_DEBUG')));
});

test('closeStdin lets a stdin-reading child see EOF instead of hanging', { timeout: 15000 }, async () => {
  const feature = `offline-stdin-${process.pid}`;
  try {
    await ownedRun(feature, async context => {
      const output = await context.run(process.execPath, ['-e', 'process.stdin.resume();process.stdin.once("end",()=>{process.stdout.write("STDIN_EOF");process.exit(0)})'], { timeoutMs: 5000, closeStdin: true });
      if (!output.stdout.includes('STDIN_EOF')) throw new Error('child never observed stdin EOF');
      throw new Error('intentional marker');
    });
  } catch (error) {
    assert.match(String(error), /intentional marker/);
  } finally {
    rmSync(join(root, 'evidence', feature), { recursive: true, force: true });
  }
});

test('read proof rejects failed reads, wrong paths, absent content and failed assistant results', () => {
  const events = [
    { type: 'tool_execution_start', toolName: 'read', toolCallId: 'cursor-replay-1', args: { path: 'package.json' } },
    { type: 'tool_execution_end', toolName: 'read', toolCallId: 'cursor-replay-1', isError: false, result: { content: [{ type: 'text', text: '{"name":"pi-cursor-sdk"}' }] } },
    { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'pi-cursor-sdk' }] } },
  ];
  assertNativeRead(events, 'pi-cursor-sdk');
  for (const alter of [e => { e[1].isError = true; }, e => { e[0].args.path = '/wrong/package.json'; }, e => { e[1].result.content = []; }, e => { e[2].message.stopReason = 'error'; }]) {
    const changed = structuredClone(events); alter(changed);
    assert.throws(() => assertNativeRead(changed, 'pi-cursor-sdk'));
  }
  assert.throws(() => assertNestedReuse([{ action: 'session_id_conflict' }]), /conflict/);
});

test('allowance reserves exact turns, rejects overrun and never overwrites approval', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verify-budget-'));
  const ledger = join(dir, 'budget.json');
  const paid = process.env.VERIFY_PI_CURSOR_SDK_PAID;
  process.env.VERIFY_PI_CURSOR_SDK_PAID = '1';
  try {
    initBudget(ledger, 6);
    assert.throws(() => initBudget(ledger, 6));
    reserveTurns(2, 'nested-btw', ledger);
    reserveTurns(2, 'warm-second', ledger);
    reserveTurns(1, 'read', ledger);
    reserveTurns(1, 'print', ledger);
    assert.throws(() => reserveTurns(1, 'retry', ledger), /exhausted/);
    assert.equal(JSON.parse(readFileSync(ledger)).reservations.reduce((sum, r) => sum + r.turns, 0), 6);
  } finally {
    if (paid === undefined) delete process.env.VERIFY_PI_CURSOR_SDK_PAID; else process.env.VERIFY_PI_CURSOR_SDK_PAID = paid;
    rmSync(dir, { recursive: true });
  }
});

for (const kind of ['spawn-error', 'early-exit', 'timeout-tree']) {
  test(`${kind} persists failure and bounds verified cleanup`, { timeout: 12000 }, async () => {
    const feature = `offline-${kind}-${process.pid}`;
    let dir, scratch;
    await assert.rejects(ownedRun(feature, async context => {
      ({ dir, scratch } = context);
      if (kind === 'spawn-error') await context.run('/nonexistent/verify-command', []);
      else if (kind === 'early-exit') await context.run(process.execPath, ['-e', 'process.exit(0)'], { drive: () => new Promise(() => {}) });
      else await context.run(process.execPath, ['-e', `const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write(String(c.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`], { timeoutMs: 200 });
    }));
    assert.match(readFileSync(join(dir, 'result.txt'), 'utf8'), /^FAIL/);
    const status = JSON.parse(readFileSync(join(dir, '1.status.json'), 'utf8'));
    if (status.cleanupError) {
      assert.ok(existsSync(scratch));
      assert.match(readFileSync(join(dir, 'result.txt'), 'utf8'), /cleanup uncertain/);
    } else assert.ok(!existsSync(scratch));
    if (kind === 'timeout-tree') {
      const pid = Number(readFileSync(join(dir, '1.stdout.txt'), 'utf8'));
      assert.ok(pid > 0);
      assert.throws(() => process.kill(pid, 0), /ESRCH/);
    }
    rmSync(join(root, 'evidence', feature), { recursive: true });
  });
}

test('interrupts fail after cleanup and retain scrubbed failure evidence', { timeout: 12000 }, async () => {
  const feature = `offline-interrupt-${process.pid}`;
  await ownedRun(`offline-controller-${process.pid}`, async ({ run }) => {
    await assert.rejects(run(process.execPath, [join(import.meta.dirname, 'interrupt-fixture.mjs'), feature], {
      drive: async child => {
        await new Promise(resolveReady => child.stdout.on('data', chunk => { if (String(chunk).includes('READY')) resolveReady(); }));
        child.kill('SIGINT');
        await new Promise(() => {});
      },
    }), /Premature child exit/);
  });
  const dir = join(root, 'evidence', feature);
  const all = readAll(dir);
  assert.match(all, /Interrupted by SIGINT/);
  assert.match(all, /FAIL/);
  assert.ok(!all.includes('cleanup uncertain'));
  rmSync(dir, { recursive: true });
  rmSync(join(root, 'evidence', `offline-controller-${process.pid}`), { recursive: true });
});

test('stdin errors fail through evidence path', async () => {
  const feature = `offline-stdin-${process.pid}`;
  let dir;
  await assert.rejects(ownedRun(feature, async context => {
    dir = context.dir;
    await context.run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      drive: child => {
        child.stdin.destroy(new Error(`stdin failure ${secret}`));
        return new Promise(() => {});
      },
    });
  }), /stdin failure/);
  const all = readAll(dir);
  assert.match(all, /stdin failure \[redacted\]/);
  assert.ok(!all.includes(secret));
  rmSync(join(root, 'evidence', feature), { recursive: true });
});

test('installed Pi event declarations match the RPC proof contract', () => {
  const types = readFileSync(join(repo, 'node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts'), 'utf8');
  const start = types.match(/export interface ToolExecutionStartEvent \{([^}]+)\}/)?.[1];
  const end = types.match(/export interface ToolExecutionEndEvent \{([^}]+)\}/)?.[1];
  assert.match(start, /type: "tool_execution_start"/);
  assert.match(start, /toolCallId: string/);
  assert.match(start, /args: any/);
  assert.match(end, /type: "tool_execution_end"/);
  assert.match(end, /result: any/);
  assert.match(end, /isError: boolean/);
});

test('normal root exit still terminates descendants before PASS', { timeout: 12000 }, async () => {
  const feature = `offline-normal-tree-${process.pid}`;
  let scratch;
  const dir = await ownedRun(feature, async context => {
    scratch = context.scratch;
    await context.run(process.execPath, ['-e', `const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.stdout.write(String(c.pid));c.unref()`]);
    assert.ok(!existsSync(join(context.dir, 'result.txt')));
  });
  const pid = Number(readFileSync(join(dir, '1.stdout.txt'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  assert.equal(readFileSync(join(dir, 'result.txt'), 'utf8'), 'PASS\n');
  assert.ok(!existsSync(scratch));
  rmSync(join(root, 'evidence', feature), { recursive: true });
});
