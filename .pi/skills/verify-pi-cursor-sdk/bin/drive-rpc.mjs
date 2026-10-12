#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { ownedRun, pi, piArgs, repo, reserveTurns, cli } from './owned-run.mjs';
import { assertNativeRead, assertNestedReuse } from './rpc-proof.mjs';

cli(async () => {
  const feature = process.argv[2];
  const costs = { 'slash-cursor-tools': 0, 'native-replay': 1, 'nested-btw': 2 };
  if (!Object.hasOwn(costs, feature)) throw new Error('Choose slash-cursor-tools, native-replay or nested-btw');
  reserveTurns(costs[feature], feature);
  await ownedRun(feature, async ({ run, env, write }) => {
    const args = [...piArgs, '--mode', 'rpc', '--session-dir', join(env.HOME, 'sessions'), '--model', 'cursor/grok-4.6:slow'];
    if (feature === 'nested-btw') args.push('-e', process.env.VERIFY_PI_BTW_EXTENSION ?? join(homedir(), '.pi/agent/npm/node_modules/pi-btw/extensions/btw.ts'));
    const events = [];
    try {
      await run(pi, args, { timeoutMs: 360000, drive: async child => {
        const reader = createInterface({ input: child.stdout });
        const pending = new Set();
        let n = 0;
        reader.on('line', line => {
          try { events.push(JSON.parse(line)); } catch { return; }
          for (const check of pending) check();
        });
        const wait = predicate => new Promise(resolveWait => {
          const check = () => { const match = events.find(predicate); if (match) { pending.delete(check); resolveWait(match); } };
          pending.add(check); check();
        });
        const request = async (type, extra = {}) => {
          const id = `verify-${++n}`;
          const done = wait(event => event.type === 'response' && event.id === id);
          await new Promise((resolveWrite, reject) => child.stdin.write(JSON.stringify({ id, type, ...extra }) + '\n', error => error ? reject(error) : resolveWrite()));
          const reply = await done;
          if (!reply.success) throw new Error(JSON.stringify(reply));
          return reply;
        };
        try {
          await request('get_state');
          const commands = await request('get_commands');
          if (!commands.data.commands.some(command => command.name === 'cursor-tools')) throw new Error('cursor-tools missing');
          if (feature === 'slash-cursor-tools') {
            await request('prompt', { message: '/cursor-tools' });
            await wait(event => event.type === 'extension_ui_request' && event.method === 'notify' && event.message.includes('Cursor tool surfaces'));
          } else if (feature === 'nested-btw') {
            for (const marker of ['FIRST', 'SECOND']) {
              const start = events.length;
              await request('prompt', { message: `/btw:ask Reply with exactly ${marker}. Do not use tools.` });
              await wait(event => events.indexOf(event) >= start && event.type === 'message_end' && event.message?.customType === 'btw-note' && event.message.details?.answer?.trim() === marker);
            }
          } else {
            await request('prompt', { message: 'Use your file read tool to read package.json. Do not use shell. Then reply with the package name.' });
            await wait(event => event.type === 'agent_end');
            assertNativeRead(events, JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).name);
          }
        } finally { reader.close(); pending.clear(); }
      } });
      const actionsText = existsSync(env.CURSOR_SDK_ACTIONS_LOG) ? readFileSync(env.CURSOR_SDK_ACTIONS_LOG, 'utf8') : '';
      if (/session_id_conflict|Cursor request session id does not match the pi session id/.test(JSON.stringify(events) + actionsText)) throw new Error('Session identity conflict');
      if (feature === 'nested-btw') assertNestedReuse(actionsText.trim().split('\n').filter(Boolean).map(JSON.parse));
    } finally { write('events.json', JSON.stringify(events, null, 2)); }
  });
});
