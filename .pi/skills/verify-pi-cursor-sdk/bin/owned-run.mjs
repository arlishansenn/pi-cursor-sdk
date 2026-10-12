import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildCursorSmokeEnv, clearCursorSdkEventDebugEnv } from '../../../../scripts/lib/cursor-smoke-env.mjs';
import { terminateChild, CHILD_PROCESS_TREE_SPAWN_OPTIONS } from '../../../../scripts/lib/cursor-child-process.mjs';
import { scrubSensitiveText } from '../../../../shared/cursor-sensitive-text.mjs';

export const repo = resolve(import.meta.dirname, '../../../..');
// Repo node_modules resolves 0.87.1 once ambient PI_PACKAGE_DIR is removed; point VERIFY_PI_BIN at the supported install.
export const pi = process.env.VERIFY_PI_BIN ? resolve(process.env.VERIFY_PI_BIN) : join(repo, 'node_modules/.bin/pi');
export const root = join(repo, '.artifacts/verify-pi-cursor-sdk');
export const scrub = (text) => scrubSensitiveText(String(text), process.env.CURSOR_API_KEY);
export function evidence(path, text) {
  mkdirSync(resolve(path, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(path, scrub(text), { mode: 0o600 });
}

export function initBudget(path, approved) {
  if (!Number.isSafeInteger(approved) || approved < 1) throw new Error('Approval must be a positive integer model-turn allowance');
  mkdirSync(resolve(path, '..'), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ approved, reservations: [] }, null, 2), { flag: 'wx', mode: 0o600 });
}
export function reserveTurns(count, feature, path = process.env.VERIFY_PI_CURSOR_BUDGET) {
  if (!count) return;
  if (process.env.VERIFY_PI_CURSOR_SDK_PAID !== '1' || !process.env.CURSOR_API_KEY?.trim() || !path) {
    throw new Error('Paid drive requires operator approval, CURSOR_API_KEY and VERIFY_PI_CURSOR_BUDGET');
  }
  const lock = `${path}.lock`;
  mkdirSync(lock, { mode: 0o700 });
  try {
    const budget = JSON.parse(readFileSync(path, 'utf8'));
    if (!Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(budget.approved) || budget.approved < 1 || !Array.isArray(budget.reservations) || budget.reservations.some(r => !Number.isSafeInteger(r.turns) || r.turns < 1)) throw new Error('Invalid budget ledger');
    const used = budget.reservations.reduce((sum, r) => sum + r.turns, 0);
    if (used + count > budget.approved) throw new Error(`Model-turn allowance exhausted (${used}/${budget.approved}; requested ${count})`);
    budget.reservations.push({ feature, turns: count, at: new Date().toISOString() });
    writeFileSync(`${path}.next`, JSON.stringify(budget, null, 2), { mode: 0o600 });
    renameSync(`${path}.next`, path);
  } finally { rmSync(lock, { recursive: true }); }
}

export function ownedEnv(scratch, baseEnv = process.env, settingSources = 'none') {
  const env = buildCursorSmokeEnv({ baseEnv, settingSources, nativeToolDisplay: true, registerNativeTools: true, bridge: true, exposeBuiltinTools: false });
  Object.assign(env, {
    HOME: join(scratch, 'home'), USERPROFILE: join(scratch, 'home'),
    PI_CODING_AGENT_DIR: join(scratch, 'home/.pi/agent'),
    TMPDIR: join(scratch, 'tmp'), TMP: join(scratch, 'tmp'), TEMP: join(scratch, 'tmp'),
    XDG_CONFIG_HOME: join(scratch, 'home/.config'), XDG_CACHE_HOME: join(scratch, 'home/.cache'), XDG_DATA_HOME: join(scratch, 'home/.local/share'),
    CURSOR_SDK_ACTIONS_LOG: join(scratch, 'sinks/actions.jsonl'),
    CURSOR_SDK_USAGE_LOG: join(scratch, 'sinks/usage.jsonl'),
  });
  delete env.PI_PACKAGE_DIR;
  return env;
}

function copyScrubbed(source, destination) {
  for (const item of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, item.name), to = join(destination, item.name);
    if (item.isDirectory()) copyScrubbed(from, to);
    else if (item.isFile()) evidence(to, readFileSync(from, 'utf8'));
    else throw new Error(`Refusing nonregular evidence ${from}`);
  }
}

// Print mode proves the user's own invocation; only identity-bearing state is isolated.
const USER_PARITY_DELETED_ENV = ['PI_PACKAGE_DIR', 'CURSOR_SDK_ACTIONS_LOG', 'CURSOR_SDK_USAGE_LOG', 'PI_CURSOR_NATIVE_TOOL_DISPLAY', 'PI_CURSOR_REGISTER_NATIVE_TOOLS', 'PI_CURSOR_PI_TOOL_BRIDGE', 'PI_CURSOR_EXPOSE_BUILTIN_TOOLS', 'PI_CURSOR_SETTING_SOURCES', 'PI_CURSOR_PI_TOOL_BRIDGE_DEBUG', 'PI_CURSOR_PI_TOOL_BRIDGE_DEBUG_FILE'];
export function userParityEnv(scratch, baseEnv = process.env) {
  const env = clearCursorSdkEventDebugEnv({ ...baseEnv });
  env.HOME = join(scratch, 'home'); env.USERPROFILE = join(scratch, 'home');
  env.PI_CODING_AGENT_DIR = join(scratch, 'home/.pi/agent');
  env.PI_CURSOR_SETTING_SOURCES = 'none';
  for (const name of USER_PARITY_DELETED_ENV) delete env[name];
  env.PI_CURSOR_SETTING_SOURCES = 'none';
  return env;
}

export const piArgs = ['--approve', '--offline', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '-e', join(repo, 'dist/index.js')];

export async function ownedRun(feature, work) {
  mkdirSync(join(root, 'evidence', feature), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, 'runs'), { recursive: true, mode: 0o700 });
  const dir = mkdtempSync(join(root, 'evidence', feature, 'run-'));
  const scratch = mkdtempSync(join(root, 'runs', 'run-'));
  const env = ownedEnv(scratch);
  for (const path of [env.PI_CODING_AGENT_DIR, env.TMPDIR, join(scratch, 'sinks')]) mkdirSync(path, { recursive: true, mode: 0o700 });
  writeFileSync(join(env.PI_CODING_AGENT_DIR, 'settings.json'), JSON.stringify({ packages: [], defaultProjectTrust: 'always' }), { mode: 0o600 });
  let cleanupUncertain = false, evidenceIncomplete = false, failure;
  let sequence = 0;
  async function run(command, args, { timeoutMs = 180000, drive, settingSources = 'none', env, closeStdin } = {}) {
    const prefix = `${++sequence}`;
    evidence(join(dir, `${prefix}.command.json`), JSON.stringify({ command, args, timeoutMs }));
    const child = spawn(command, args, { cwd: repo, env: env ?? ownedEnv(scratch, process.env, settingSources), ...CHILD_PROCESS_TREE_SPAWN_OPTIONS, stdio: ['pipe', 'pipe', 'pipe'] });
    const buffers = { stdout: [], stderr: [] };
    let rejectFailure;
    const failed = new Promise((_, reject) => { rejectFailure = reject; });
    let runtimeError;
    const onError = error => { runtimeError ??= error; rejectFailure(error); };
    child.on('error', onError);
    child.stdin.on('error', onError);
    child.stdout.on('data', b => buffers.stdout.push(b));
    child.stderr.on('data', b => buffers.stderr.push(b));
    // pi print mode reads a non-TTY stdin to EOF before dispatching; an open pipe hangs it.
    if (closeStdin) child.stdin.end();
    let status = null, signal = null, closed = false;
    const outputClosed = new Promise(resolveClose => child.once('close', () => { closed = true; resolveClose(); }));
    const exited = new Promise(resolveExit => child.once('exit', (code, sig) => { status = code; signal = sig; resolveExit(); }));
    let interruption;
    const interrupted = sig => { interruption = new Error(`Interrupted by ${sig}`); onError(interruption); };
    const onInt = () => interrupted('SIGINT'), onTerm = () => interrupted('SIGTERM');
    process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
    const timer = setTimeout(() => onError(new Error(`Deadline exceeded (${timeoutMs}ms)`)), timeoutMs);
    let error, cleanupError;
    const text = () => Object.fromEntries(Object.entries(buffers).map(([key, chunks]) => [key, Buffer.concat(chunks).toString('utf8')]));
    try {
      const operation = drive ? Promise.race([drive(child, text), exited.then(() => { throw new Error(`Premature child exit (${status}, ${signal})`); })]) : exited;
      await Promise.race([operation, failed]);
      if (!drive && (status !== 0 || signal)) throw new Error(`Child exit (${status}, ${signal})`);
    } catch (cause) { error = cause; }
    finally {
      clearTimeout(timer);
      try { await terminateChild(child, { graceMs: 1000 }); }
      catch (cause) { cleanupUncertain = true; cleanupError = String(cause); }
      if (!closed) {
        let closeTimer;
        await Promise.race([outputClosed, new Promise(resolveClose => { closeTimer = setTimeout(resolveClose, 1000); })]);
        clearTimeout(closeTimer);
        if (!closed) error ??= new Error('Output streams did not close; capture incomplete');
      }
      error ??= interruption ?? runtimeError;
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
      const output = text();
      const captures = {
        'stdout.txt': output.stdout,
        'stderr.txt': output.stderr,
        'status.json': JSON.stringify({ status, signal, closed, error: error ? String(error) : null, cleanupError }),
      };
      for (const [name, body] of Object.entries(captures)) {
        try { evidence(join(dir, `${prefix}.${name}`), body); }
        catch (cause) { evidenceIncomplete = true; error = new Error(`${error ?? ''}; evidence ${name} failed: ${cause}`); }
      }
    }
    if (cleanupError || error) throw new Error([error && String(error), cleanupError].filter(Boolean).join('; '));
    return text();
  }
  try { await work({ run, env, scratch, dir, write: (name, text) => evidence(join(dir, name), text) }); }
  catch (error) { failure = error; }
  finally {
    try {
      copyScrubbed(join(scratch, 'sinks'), join(dir, 'sinks'));
      // The probe copies these only after its turns finish; termination skips that copy.
      for (const work of readdirSync(env.TMPDIR, { withFileTypes: true })) {
        if (!/^provider-coldstart-provider-(?:no-setting-sources|all-settings|warm-second-turn|warmup-first-prompt)-[A-Za-z0-9]{6}$/.test(work.name)) continue;
        if (!work.isDirectory()) throw new Error(`Refusing non-directory coldstart evidence ${work.name}`);
        const source = join(env.TMPDIR, work.name);
        const destination = join(dir, 'sinks/partial-coldstart', work.name);
        for (const item of readdirSync(source, { withFileTypes: true })) {
          if (item.name === 'actions.jsonl' && item.isFile()) evidence(join(destination, item.name), readFileSync(join(source, item.name), 'utf8'));
          else if (item.name === 'debug-events' && item.isDirectory()) copyScrubbed(join(source, item.name), join(destination, item.name));
          else if (item.name === 'actions.jsonl' || item.name === 'debug-events') throw new Error(`Refusing nonregular coldstart evidence ${item.name}`);
        }
      }
    }
    catch (error) { evidenceIncomplete = true; failure = new Error(`${failure ?? ''}; evidence persistence failed: ${error}`); }
    if (!cleanupUncertain && !evidenceIncomplete) {
      try { rmSync(scratch, { recursive: true, force: true }); }
      catch (error) { failure = new Error(`${failure ?? ''}; scratch removal failed: ${error}`); }
    } else failure = new Error(`${failure ?? ''}; ${cleanupUncertain ? 'cleanup uncertain' : 'evidence incomplete'}; private scratch retained at ${scratch}`);
    evidence(join(dir, 'result.txt'), failure ? `FAIL ${failure}\n` : 'PASS\n');
  }
  if (failure) throw new Error(`${failure}; evidence=${dir}`);
  console.log(`PASS ${feature}; evidence=${dir}`);
  return dir;
}

export function cli(main) {
  main().catch(error => { console.error(scrub(error?.stack ?? error)); process.exitCode = 1; });
}
