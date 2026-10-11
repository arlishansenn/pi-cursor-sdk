import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadExtensionsCached, clearExtensionCache } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

const directory = mkdtempSync(join(tmpdir(), "cursor-http-loader-"));
const fixture = join(directory, "extension.ts");
const sdkUrl = pathToFileURL(resolve("node_modules/@cursor/sdk/dist/esm/index.js")).href;
const httpPath = resolve("src/cursor-http1.ts");
const guardPath = resolve("src/cursor-sdk-process-error-guard.ts");
const key = Symbol.for("pi-cursor-sdk.loader-contract");
globalThis[key] = [];
writeFileSync(fixture, `
import * as http from ${JSON.stringify(httpPath)};
import * as guard from ${JSON.stringify(guardPath)};
const identity = {};
export default async function () {
 const sdk = await import(${JSON.stringify(sdkUrl)});
 globalThis[Symbol.for("pi-cursor-sdk.loader-contract")].push({ identity, cursor: sdk.Cursor, http, guard });
}`);
try {
	clearExtensionCache();
	for (const cwd of [directory, directory, join(directory, "other")]) {
		const loaded = await loadExtensionsCached([fixture], cwd);
		assert.deepEqual(loaded.errors, []);
	}
	const [first, sameCwd, changedCwd] = globalThis[key];
	assert.equal(first.identity, sameCwd.identity);
	assert.notEqual(first.identity, changedCwd.identity);
	assert.equal(first.cursor, sameCwd.cursor);
	assert.equal(first.cursor, changedCwd.cursor);
	assert.notEqual(first.http.runWithCursorSdkHttp1Lock, changedCwd.http.runWithCursorSdkHttp1Lock);

	const events = [];
	const sdk = { Cursor: { configure: (options) => events.push(options.local.useHttp1ForAgent) } };
	const gate = Promise.withResolvers();
	const entered = Promise.withResolvers();
	const outgoing = first.http.runWithCursorSdkHttp1Lock(async () => {
		first.http.configureCursorSdkHttp1(sdk, { value: true, source: "environment" });
		entered.resolve();
		await gate.promise;
	});
	await entered.promise;
	const clear = first.http.clearCursorSdkHttp1UnderLock();
	const incoming = changedCwd.http.runWithCursorSdkHttp1Lock(async () => {
		changedCwd.http.configureCursorSdkHttp1(sdk, { value: false, source: "environment" });
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(events, [true]);
	gate.resolve();
	await Promise.all([outgoing, clear, incoming]);
	assert.deepEqual(events, [true, null, false]);
	changedCwd.http.configureCursorSdkHttp1(sdk, { value: false, source: "builtin" });
	assert.deepEqual(events, [true, null, false, null]);
	const retired = Promise.withResolvers();
	first.http.trackRetiredCursorCreation(retired.promise);
	let drained = false;
	const drain = changedCwd.http.drainRetiredCursorCreations().then(() => { drained = true; });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(drained, false);
	retired.resolve();
	await drain;
	assert.equal(drained, true);
	const originalEmit = process.emit;
	const forwarded = [];
	const forwardEmit = function (event, ...args) {
		if (event === "uncaughtException" || event === "unhandledRejection") {
			forwarded.push(args[0]);
			return true;
		}
		return originalEmit.call(this, event, ...args);
	};
	process.emit = forwardEmit;
	try {
		for (const releaseRetirementFirst of [true, false]) {
			const pending = Promise.withResolvers();
			first.http.trackRetiredCursorCreation(pending.promise);
			const incoming = changedCwd.guard.installCursorSdkSessionProcessErrorGuard();
			const closed = new Error("WritableIterable is closed");
			closed.name = "WriteIterableClosedError";
			closed.stack = "at /repo/node_modules/@cursor/sdk/dist/esm/index.js:1:1";
			const unrelated = new Error("unrelated");
			if (releaseRetirementFirst) {
				pending.resolve();
				await changedCwd.http.drainRetiredCursorCreations();
			} else incoming.dispose();
			forwarded.length = 0;
			process.emit("uncaughtException", closed);
			process.emit("uncaughtException", unrelated);
			assert.deepEqual(forwarded, [unrelated]);
			incoming.dispose();
			pending.resolve();
			await changedCwd.http.drainRetiredCursorCreations();
			assert.equal(process.emit, forwardEmit);
			assert.equal(first.guard.__testUtils.activeSessionCount(), 0);
			assert.equal(changedCwd.guard.__testUtils.activeSessionCount(), 0);
		}
	} finally {
		process.emit = originalEmit;
	}
	console.log("Same cwd reuses extension; changed cwd replaces extension; SDK identity persists; cleanup ordering and retirement survive replacement; guard leases release across both module disposal orders.");
} finally {
	clearExtensionCache();
	delete globalThis[key];
	rmSync(directory, { recursive: true, force: true });
}
