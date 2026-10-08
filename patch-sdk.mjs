// Build-time patch: the SDK's local agent never sets RequestedModel.max_mode, so Cursor caps the context at 300k and
// compacts past it. This sets max_mode when the selection carries context=1m or context=500k (grok-4.7 rejects 500k
// without max_mode). Node loads dist/esm; a different SDK version or anything but exactly one match fails the build
// so the patch is re-verified on upgrade. Reruns on an already-patched tree are a successful no-op (#41).
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
// Recognize this script's own output so a repeat `npm install` on an already
// patched tree is idempotent instead of reporting SDK-shape drift. A legacy
// patch (context=1m only, before 500k support) is upgraded to the current shape.
const currentPattern = /modelId:([A-Za-z_$][\w$]*)\.model\.id,maxMode:\(\1\.model\.params\?\?\[\]\)\.some\(p=>p\.id==="context"&&\(p\.value==="1m"\|\|p\.value==="500k"\)\),parameters:/g;
const legacyPattern = /modelId:([A-Za-z_$][\w$]*)\.model\.id,maxMode:\(\1\.model\.params\?\?\[\]\)\.some\(p=>p\.id==="context"&&p\.value==="1m"\),parameters:/g;
const replaceWithCurrent = (_, v) => `modelId:${v}.model.id,maxMode:(${v}.model.params??[]).some(p=>p.id==="context"&&(p.value==="1m"||p.value==="500k")),parameters:`;
// Count every shape first: only the three singleton vectors are actionable. Mixed
// or duplicated shapes (e.g. a partial repatch or a drifted SDK) must hard-fail
// without touching the file.
const unpatchedCount = hits.length;
const currentCount = (source.match(currentPattern) ?? []).length;
const legacyCount = (source.match(legacyPattern) ?? []).length;
if (unpatchedCount === 1 && currentCount === 0 && legacyCount === 0) {
	writeFileSync(file, source.replace(pattern, replaceWithCurrent));
	console.log(`patched ${file}`);
} else if (unpatchedCount === 0 && currentCount === 1 && legacyCount === 0) {
	console.log(`already patched ${file}`);
} else if (unpatchedCount === 0 && currentCount === 0 && legacyCount === 1) {
	writeFileSync(file, source.replace(legacyPattern, replaceWithCurrent));
	console.log(`repatched legacy context=1m-only patch in ${file}`);
} else {
	throw Error(`Expected exactly one RequestedModel construction shape in ${file}, found ${unpatchedCount} unpatched / ${currentCount} current / ${legacyCount} legacy`);
}
