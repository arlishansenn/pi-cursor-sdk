// Build-time patch: the SDK's local agent never sets RequestedModel.max_mode, so Cursor caps the context at 300k and
// compacts past it. This sets max_mode when the selection carries context=1m or context=500k (grok-4.7 rejects 500k
// without max_mode). Node loads dist/esm; a different SDK
// version or anything but exactly one match fails the build so the patch is re-verified on upgrade.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// Resolve through node's algorithm so both layouts work: a git checkout has
// ./node_modules/@cursor/sdk next to this file, while a packed npm install
// hoists @cursor/sdk to the project root above node_modules/pi-cursor-sdk.
// The SDK's exports map hides package.json and its require condition lands in
// dist/cjs (which carries its own {type:commonjs} manifest), so locate the
// package root by name instead of stopping at the first manifest.
const require = createRequire(import.meta.url);
let sdkDir = dirname(require.resolve('@cursor/sdk'));
for (;;) {
	const manifest = join(sdkDir, 'package.json');
	if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === '@cursor/sdk') break;
	const parent = dirname(sdkDir);
	if (parent === sdkDir) throw Error('@cursor/sdk package root not found from ' + require.resolve('@cursor/sdk'));
	sdkDir = parent;
}
const { version } = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8'));
if (version !== '1.0.32') throw Error(`patch-sdk.mjs is verified against @cursor/sdk 1.0.32, found ${version}`);
const file = join(sdkDir, 'dist/esm/34.js');
const source = readFileSync(file, 'utf8');
const pattern = /modelId:([A-Za-z_$][\w$]*)\.model\.id,parameters:/g;
const hits = [...source.matchAll(pattern)];
if (hits.length !== 1) throw Error(`Expected one unpatched RequestedModel construction in ${file}, found ${hits.length}`);
writeFileSync(file, source.replace(pattern, (_, v) => `modelId:${v}.model.id,maxMode:(${v}.model.params??[]).some(p=>p.id==="context"&&(p.value==="1m"||p.value==="500k")),parameters:`));
console.log(`patched ${file}`);
