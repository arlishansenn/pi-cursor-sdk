// Seams (agreed for #558):
// 1) pin 1.0.32 + exactly one unpatched construction → writes maxMode from context=1m
// 2) version !== 1.0.32 → throws
// 3) hit count !== 1 (including already-patched = 0) → throws
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PATCH = fileURLToPath(new URL('./patch-sdk.mjs', import.meta.url));
const UNPATCHED = 'x=modelId:t.model.id,parameters:y';
const PATCHED =
	'x=modelId:t.model.id,maxMode:(t.model.params??[]).some(p=>p.id==="context"&&p.value==="1m"),parameters:y';

function setup(version, content) {
	const root = mkdtempSync(join(tmpdir(), 'patch-sdk-'));
	mkdirSync(join(root, 'node_modules/@cursor/sdk/dist/esm'), { recursive: true });
	writeFileSync(join(root, 'node_modules/@cursor/sdk/package.json'), JSON.stringify({ version }));
	writeFileSync(join(root, 'node_modules/@cursor/sdk/dist/esm/34.js'), content);
	cpSync(PATCH, join(root, 'patch-sdk.mjs'));
	return root;
}

function run(root) {
	return spawnSync(process.execPath, ['patch-sdk.mjs'], { cwd: root, encoding: 'utf8' });
}

test('patches when pin and one unpatched construction', () => {
	const root = setup('1.0.32', UNPATCHED);
	const r = run(root);
	assert.equal(r.status, 0, r.stderr + r.stdout);
	assert.equal(readFileSync(join(root, 'node_modules/@cursor/sdk/dist/esm/34.js'), 'utf8'), PATCHED);
});

test('fails when SDK version is wrong', () => {
	const root = setup('1.0.33', UNPATCHED);
	const r = run(root);
	assert.notEqual(r.status, 0);
	assert.match(r.stderr + r.stdout, /1\.0\.32/);
});

test('fails when hit count is not exactly one', () => {
	const root = setup('1.0.32', PATCHED);
	const r = run(root);
	assert.notEqual(r.status, 0);
	assert.match(r.stderr + r.stdout, /Expected one unpatched/);
});
