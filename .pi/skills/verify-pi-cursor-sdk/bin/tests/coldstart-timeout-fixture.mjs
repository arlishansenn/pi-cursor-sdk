import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const work = mkdtempSync(join(process.env.TMPDIR, 'provider-coldstart-provider-no-setting-sources-'));
const debug = join(work, 'debug-events/sessions/fixture/turn-001-fixture');
mkdirSync(debug, { recursive: true });
const secret = process.env.CURSOR_API_KEY;
for (const [file, marker] of [
  [join(work, 'actions.jsonl'), 'partial-coldstart-action'],
  [join(debug, 'provider-events.jsonl'), 'partial-coldstart-debug'],
]) {
  writeFileSync(file, `{"marker":"${marker}","secret":"${secret.slice(0, 9)}`);
  appendFileSync(file, `${secret.slice(9)}","bridge":"http://127.0.0.1:9999/cursor-pi-tool-bridge/private-fixture-token/mcp"}\n`);
}
writeFileSync(join(work, 'auth.json'), 'DO_NOT_COPY_CREDENTIALS');
mkdirSync(join(work, 'node_modules'), { recursive: true });
writeFileSync(join(work, 'node_modules/dependency.js'), 'DO_NOT_COPY_DEPENDENCIES');
mkdirSync(join(process.env.TMPDIR, 'unrelated'), { recursive: true });
writeFileSync(join(process.env.TMPDIR, 'unrelated/actions.jsonl'), 'DO_NOT_COPY_UNRELATED');
process.stdout.write('READY\n');
setInterval(() => {}, 1000);
