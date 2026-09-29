// Seams (agreed for #558):
// 1) pin 1.0.32 + exactly one unpatched construction → writes maxMode from context=1m or context=500k
// 2) version !== 1.0.32 → throws
// 3) hit count !== 1 (including already-patched = 0) → throws
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

test('fails when rerun on an already-patched tree', () => {
	const root = setup('1.0.32', FIXTURE);
	assert.equal(run(root).status, 0);
	const r = run(root);
	assert.notEqual(r.status, 0);
	assert.match(r.stderr + r.stdout, /Expected one unpatched/);
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
