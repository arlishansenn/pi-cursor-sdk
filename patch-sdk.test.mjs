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
	writeFileSync(join(root, 'node_modules/@cursor/sdk/package.json'), JSON.stringify({ version, type: 'module' }));
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
