import { CursorLiveRunAbortError } from "./cursor-live-run-coordinator.js";

const turnQueuesByScope = new Map<string, Promise<void>>();
/** Callers that have entered `runExclusiveCursorSessionTurn` for a scope (running or waiting). */
const activeEntriesByScope = new Map<string, number>();

async function waitForPreviousTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
	if (!signal) {
		await previous.catch(() => undefined);
		return;
	}
	if (signal.aborted) throw new CursorLiveRunAbortError();
	await new Promise<void>((resolve, reject) => {
		const onAbort = (): void => {
			reject(new CursorLiveRunAbortError());
		};
		signal.addEventListener("abort", onAbort, { once: true });
		previous.catch(() => undefined).then(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		});
	});
}

export async function runExclusiveCursorSessionTurn<T>(scopeKey: string, body: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	activeEntriesByScope.set(scopeKey, (activeEntriesByScope.get(scopeKey) ?? 0) + 1);
	const previous = turnQueuesByScope.get(scopeKey);
	let releaseCurrent!: () => void;
	const current = new Promise<void>((resolve) => {
		releaseCurrent = resolve;
	});
	const tail = (previous ?? Promise.resolve()).catch(() => undefined).then(() => current);
	turnQueuesByScope.set(scopeKey, tail);
	void tail.finally(() => {
		if (turnQueuesByScope.get(scopeKey) === tail) {
			turnQueuesByScope.delete(scopeKey);
		}
	});

	try {
		if (previous) await waitForPreviousTurn(previous, signal);
		return await body();
	} finally {
		releaseCurrent();
		const remaining = (activeEntriesByScope.get(scopeKey) ?? 1) - 1;
		if (remaining <= 0) activeEntriesByScope.delete(scopeKey);
		else activeEntriesByScope.set(scopeKey, remaining);
	}
}

export const __testUtils = {
	reset(): void {
		turnQueuesByScope.clear();
		activeEntriesByScope.clear();
	},
	count(): number {
		return turnQueuesByScope.size;
	},
	activeCount(scopeKey: string): number {
		return activeEntriesByScope.get(scopeKey) ?? 0;
	},
};
