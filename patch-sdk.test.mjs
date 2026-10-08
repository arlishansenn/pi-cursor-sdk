// Seams (agreed for #558):
// 1) pin 1.0.32 + exactly one unpatched construction → writes maxMode from context=1m or context=500k
// 2) version !== 1.0.32 → throws
// 3) rerun on an already-patched tree is a successful no-op; a legacy 1m-only patch is upgraded; a shape matching neither → throws (#41)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PATCH = fileURLToPath(new URL('./patch-sdk.mjs', import.meta.url));
const FIXTURE = 'export const build=t=>({modelId:t.model.id,parameters:t.model.params});';

function setup(version, content) {
	const root = mkdtempSync(join(tmpdir(), 'patch-sdk-'));
	mkdirSync(join(root, 'node_modules/@cursor/sdk/dist/esm'), { recursive: true });
	mkdirSync(join(root, 'node_modules/@cursor/sdk/dist/cjs'), { recursive: true });
	writeFileSync(join(root, 'node_modules/@cursor/sdk/package.json'), JSON.stringify({
		name: '@cursor/sdk',
		version,
		type: 'module',
		exports: { '.': { require: './dist/cjs/index.js', import: './dist/esm/34.js' } },
	}));
	writeFileSync(join(root, 'node_modules/@cursor/sdk/dist/cjs/package.json'), JSON.stringify({ type: 'commonjs' }));
	writeFileSync(join(root, 'node_modules/@cursor/sdk/dist/cjs/index.js'), 'module.exports = {};');
	writeFileSync(join(root, 'node_modules/@cursor/sdk/dist/esm/34.js'), content);
	cpSync(PATCH, join(root, 'patch-sdk.mjs'));
	return root;
}

function run(root) {
	return spawnSync(process.execPath, ['patch-sdk.mjs'], { cwd: root, encoding: 'utf8' });
}

test('sets maxMode only for context=1m or context=500k', async () => {
	const root = setup('1.0.32', FIXTURE);
	const r = run(root);
	assert.equal(r.status, 0, r.stderr + r.stdout);
	const { build } = await import(pathToFileURL(join(root, 'node_modules/@cursor/sdk/dist/esm/34.js')).href);
	const maxMode = params => build({ model: { id: 'm', params } }).maxMode;
	assert.equal(maxMode([{ id: 'context', value: '1m' }]), true);
	assert.equal(maxMode([{ id: 'context', value: '500k' }]), true);
	assert.equal(maxMode([{ id: 'context', value: '256k' }]), false);
	assert.equal(maxMode(undefined), false);
});

test('fails when SDK version is wrong', () => {
	const root = setup('1.0.33', FIXTURE);
	const r = run(root);
	assert.notEqual(r.status, 0);
	assert.match(r.stderr + r.stdout, /1\.0\.32/);
});

test('rerun on an already-patched tree is a successful no-op', () => {
	const root = setup('1.0.32', FIXTURE);
	assert.equal(run(root).status, 0);
	const first = readFileSync(join(root, 'node_modules/@cursor/sdk/dist/esm/34.js'), 'utf8');
	const r = run(root);
	assert.equal(r.status, 0, r.stderr + r.stdout);
	assert.match(r.stdout, /already patched/);
	assert.equal(readFileSync(join(root, 'node_modules/@cursor/sdk/dist/esm/34.js'), 'utf8'), first);
});

test('upgrades a legacy context=1m-only patch to the current 1m-or-500k shape', async () => {
	const legacy = 'export const build=t=>({modelId:t.model.id,maxMode:(t.model.params??[]).some(p=>p.id==="context"&&p.value==="1m"),parameters:t.model.params});';
	const root = setup('1.0.32', legacy);
	const r = run(root);
	assert.equal(r.status, 0, r.stderr + r.stdout);
	assert.match(r.stdout, /repatched legacy/);
	const { build } = await import(pathToFileURL(join(root, 'node_modules/@cursor/sdk/dist/esm/34.js')).href);
	assert.equal(build({ model: { id: 'm', params: [{ id: 'context', value: '500k' }] } }).maxMode, true);
});

test('fails when the tree matches neither the unpatched nor the patched shape', () => {
	const drifted = 'export const build=t=>({modelId:t.model.id,maxMode:custom(t),parameters:t.model.params});';
	const root = setup('1.0.32', drifted);
	const r = run(root);
	assert.notEqual(r.status, 0);
	assert.match(r.stderr + r.stdout, /unpatched/);
});

test('fails without writing when mixed or duplicated shapes are present', () => {
	const current = (v) => `export const a${v}=t=>({modelId:t.model.id,maxMode:(t.model.params??[]).some(p=>p.id==="context"&&(p.value==="1m"||p.value==="500k")),parameters:t.model.params});`;
	const legacy = (v) => `export const b${v}=t=>({modelId:t.model.id,maxMode:(t.model.params??[]).some(p=>p.id==="context"&&p.value==="1m"),parameters:t.model.params});`;
	const unpatched = (v) => `export const c${v}=t=>({modelId:t.model.id,parameters:t.model.params});`;
	for (const content of [`${current(1)}${legacy(1)}`, `${current(1)}${current(2)}`, `${legacy(1)}${legacy(2)}`, `${unpatched(1)}${unpatched(2)}${current(1)}`]) {
		const root = setup('1.0.32', content);
		const before = readFileSync(join(root, 'node_modules/@cursor/sdk/dist/esm/34.js'), 'utf8');
		const r = run(root);
		assert.notEqual(r.status, 0, content);
		assert.equal(readFileSync(join(root, 'node_modules/@cursor/sdk/dist/esm/34.js'), 'utf8'), before);
	}
});

// npm hoists @cursor/sdk to the project root when the package is installed from a
// tarball, so the patch must resolve through node's algorithm instead of assuming
// a nested node_modules layout (packed install postinstall, see #574 gate).
test('patches from a packed-install layout where @cursor/sdk is hoisted', async () => {
	const root = mkdtempSync(join(tmpdir(), 'patch-sdk-packed-'));
	mkdirSync(join(root, 'node_modules/@cursor/sdk/dist/esm'), { recursive: true });
	mkdirSync(join(root, 'node_modules/@cursor/sdk/dist/cjs'), { recursive: true });
	writeFileSync(join(root, 'node_modules/@cursor/sdk/package.json'), JSON.stringify({
		name: '@cursor/sdk',
		version: '1.0.32',
		type: 'module',
		exports: { '.': { require: './dist/cjs/index.js', import: './dist/esm/34.js' } },
	}));
	writeFileSync(join(root, 'node_modules/@cursor/sdk/dist/cjs/package.json'), JSON.stringify({ type: 'commonjs' }));
	writeFileSync(join(root, 'node_modules/@cursor/sdk/dist/cjs/index.js'), 'module.exports = {};');
	writeFileSync(join(root, 'node_modules/@cursor/sdk/dist/esm/34.js'), FIXTURE);
	mkdirSync(join(root, 'node_modules/pi-cursor-sdk'), { recursive: true });
	cpSync(PATCH, join(root, 'node_modules/pi-cursor-sdk/patch-sdk.mjs'));
	const r = spawnSync(process.execPath, ['patch-sdk.mjs'], { cwd: join(root, 'node_modules/pi-cursor-sdk'), encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr + r.stdout);
	const { build } = await import(pathToFileURL(join(root, 'node_modules/@cursor/sdk/dist/esm/34.js')).href);
	assert.equal(build({ model: { id: 'm', params: [{ id: 'context', value: '1m' }] } }).maxMode, true);
});
