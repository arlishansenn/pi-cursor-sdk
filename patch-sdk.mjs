// Build-time patch: the SDK's local agent never sets RequestedModel.max_mode, so Cursor caps the context at 300k and
// compacts past it. This sets max_mode when the selection carries context=1m. Node loads dist/esm; a different SDK
// version or anything but exactly one match fails the build so the patch is re-verified on upgrade.
import { readFileSync, writeFileSync } from 'node:fs';

const sdk = new URL('./node_modules/@cursor/sdk/', import.meta.url);
const { version } = JSON.parse(readFileSync(new URL('package.json', sdk), 'utf8'));
if (version !== '1.0.32') throw Error(`patch-sdk.mjs is verified against @cursor/sdk 1.0.32, found ${version}`);
const file = new URL('dist/esm/34.js', sdk);
const source = readFileSync(file, 'utf8');
const pattern = /modelId:([A-Za-z_$][\w$]*)\.model\.id,parameters:/g;
const hits = [...source.matchAll(pattern)];
if (hits.length !== 1) throw Error(`Expected one unpatched RequestedModel construction in ${file.pathname}, found ${hits.length}`);
writeFileSync(file, source.replace(pattern, (_, v) => `modelId:${v}.model.id,maxMode:(${v}.model.params??[]).some(p=>p.id==="context"&&p.value==="1m"),parameters:`));
console.log(`patched ${file.pathname}`);
