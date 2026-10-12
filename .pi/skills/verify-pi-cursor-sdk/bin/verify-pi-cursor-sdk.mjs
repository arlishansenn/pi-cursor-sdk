#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ownedRun, pi, piArgs, repo, root, reserveTurns, initBudget, scrub, cli, userParityEnv } from './owned-run.mjs';

const flags = ['--cursor-fast', '--cursor-no-fast', '--cursor-mode', '--cursor-local-resume'];
const probe = join(repo, 'scripts/probe-provider-coldstart.mjs');
const scenarios = {
  'provider-no-setting-sources': { turns: 1, settingSources: 'none' },
  'provider-all-settings': { turns: 1, settingSources: 'all' },
  'provider-warm-second-turn': { turns: 2, settingSources: 'none' },
  'provider-warmup-first-prompt': { turns: 1, settingSources: 'none' },
};

cli(async () => {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'budget-init') {
    assert.equal(args.length, 2, 'budget-init <ledger-path> <operator-approved-turns>');
    initBudget(resolve(args[0]), Number(args[1]));
    console.log(`Created allowance ledger ${resolve(args[0])}; no automatic replenishment`);
    return;
  }
  if (command === 'budget-status') {
    assert.equal(args.length, 1, 'budget-status <ledger-path>');
    const budget = JSON.parse(readFileSync(resolve(args[0]), 'utf8'));
    console.log(scrub(JSON.stringify({ ...budget, reserved: budget.reservations.reduce((sum, r) => sum + r.turns, 0) }, null, 2)));
    return;
  }
  if (command === 'cleanup') {
    const runs = join(root, 'runs');
    const retained = existsSync(runs) ? readdirSync(runs) : [];
    assert.equal(retained.length, 0, `Retained scratch needs manual process-tree verification before removal: ${retained.join(', ')}`);
    console.log('No retained scratch; evidence kept');
    return;
  }
  if (!['launch', 'doctor', 'drive-extension-load', 'drive-print', 'drive-provider-coldstart'].includes(command)) throw new Error('Choose launch, doctor, drive-extension-load, drive-print, drive-provider-coldstart, budget-init, budget-status or cleanup');
  let scenario;
  if (command === 'drive-provider-coldstart') {
    assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--scenario'), 'Use --scenario <label>');
    scenario = args[1] ?? 'provider-no-setting-sources';
    assert.ok(Object.hasOwn(scenarios, scenario), 'Unknown coldstart scenario');
    reserveTurns(scenarios[scenario].turns, scenario);
  } else {
    assert.equal(args.length, 0, 'Unexpected arguments');
    if (command === 'drive-print') reserveTurns(1, 'print-mode');
  }
  await ownedRun(command, async ({ run, scratch, write }) => {
    if (command === 'launch') {
      await run('npm', ['run', 'build']);
      assert.ok(existsSync(join(repo, 'dist/index.js')), 'Build did not produce dist/index.js');
      return;
    }
    assert.ok(existsSync(join(repo, 'dist/index.js')), 'Run launch first');
    if (command === 'doctor') {
      await run(pi, ['--version'], { timeoutMs: 30000 });
      const help = await run(process.execPath, [probe, '--help'], { timeoutMs: 30000 });
      assert.ok(help.stdout.includes('provider-no-setting-sources'), 'Probe scenario missing from help');
    }
    if (command === 'doctor' || command === 'drive-extension-load') {
      const help = await run(pi, [...piArgs, '--help'], { timeoutMs: 60000 });
      assert.ok(flags.every(flag => (help.stdout + help.stderr).includes(flag)), 'Cursor help flags missing');
      write('summary.txt', 'help.flags=true\n');
      if (command === 'drive-extension-load') {
        const models = await run(pi, [...piArgs, '--no-session', '--list-models', 'cursor']);
        assert.ok(models.stdout.split(/\r?\n/).some(line => /^\s*cursor\s+\S+/.test(line) || /^\s*cursor\/\S+/.test(line)), 'Successful Cursor model rows not observed');
        write('summary.txt', 'help.flags=true\nlist-models.hasCursorId=true\n');
      }
      return;
    }
    if (command === 'drive-print') {
      const parity = userParityEnv(scratch);
      const version = await run(pi, ['--version'], { timeoutMs: 30000, env: parity });
      write('pi-version.txt', version.stdout);
      const output = await run(pi, [...piArgs, '--model', 'cursor/grok-4.6:slow', '--no-session', '-p', 'Reply with exactly VERIFY_PRINT_OK. Do not use tools.'], { timeoutMs: 360000, env: parity, closeStdin: true });
      assert.ok(output.stdout.split(/\r?\n/).some(line => line.trim() === 'VERIFY_PRINT_OK'), 'Completed print answer missing');
      assert.ok(!/session_id_conflict|Cursor request session id does not match the pi session id/.test(output.stdout + output.stderr), 'Session identity conflict');
      return;
    }
    const out = join(scratch, 'sinks/probe');
    await run(process.execPath, [probe, '--scenario', scenario, '--out-dir', out, '--model', 'grok-4.6:slow'], { timeoutMs: 600000, settingSources: scenarios[scenario].settingSources });
    const journal = join(out, `${scenario}.actions.jsonl`);
    const rows = readFileSync(journal, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    const sample = JSON.parse(readFileSync(join(out, `${scenario}.json`), 'utf8'));
    assert.equal(sample.turns.length, scenarios[scenario].turns);
    assert.ok(sample.turns.every(turn => turn.error === null && turn.wall.requestToDoneMs !== null), 'Coldstart turn did not complete');
    assert.ok(rows.some(row => row.action === 'agent_create' || row.action === 'first_text'), 'Phase evidence missing');
    if (scenario === 'provider-warmup-first-prompt') {
      assert.equal(sample.warmReady, true);
      assert.equal(sample.sendsBeforeFirstTurn, 0);
    }
    const { diagnoseCursorStartup } = await import(join(repo, 'dist/cursor-startup-diagnostics.js'));
    write('diagnosis.json', JSON.stringify(await diagnoseCursorStartup({ journals: [journal], comparison: null }), null, 2));
    write('summary.txt', 'status=ok\nPhase availability only; no latency-budget assertion.\n');
  });
});
