import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyCursorConnectError, isCursorSdkAbortConnectError, isCursorSdkConnectionStalledError } from "./cursor-provider-errors.js";

interface CursorSdkProcessErrorGuardToken {
	suppressAbortErrors: boolean;
}

interface CursorSdkSessionProcessErrorGuardToken {}

export interface CursorSdkProcessErrorGuard {
	suppressAbortErrors(): void;
	dispose(): void;
}

export interface CursorSdkSessionProcessErrorGuard {
	dispose(): void;
}

type GenericProcessEmit = (event: string | symbol, ...args: unknown[]) => boolean;

// Cursor SDK controlled-exec tasks can reject after their originating provider turn
// has ended. The exact closed-writable failure is therefore session-scoped; existing
// ConnectRPC suppression remains scoped to active provider turns.
interface CursorSdkProcessErrorGuardState {
	activeProviderTurns: Set<CursorSdkProcessErrorGuardToken>;
	activeSessions: Set<CursorSdkSessionProcessErrorGuardToken>;
	originalProcessEmit?: GenericProcessEmit;
	cursorProcessEmit?: GenericProcessEmit;
	bunUnhandledRejectionListener?: (error: unknown) => void;
}

// Retired SDK work can outlive the extension module that installed its guard.
const guardKey = Symbol.for("pi-cursor-sdk.process-error-guard.v1");
const processState = globalThis as typeof globalThis & { [guardKey]?: CursorSdkProcessErrorGuardState };
const guards = processState[guardKey] ??= {
	activeProviderTurns: new Set<CursorSdkProcessErrorGuardToken>(),
	activeSessions: new Set<CursorSdkSessionProcessErrorGuardToken>(),
};
let activeLifecycleSessionGuard: CursorSdkSessionProcessErrorGuard | undefined;

function hasActiveGuard(): boolean {
	return guards.activeProviderTurns.size > 0 || guards.activeSessions.size > 0;
}

function hasActiveAbortSuppression(): boolean {
	for (const turn of guards.activeProviderTurns) {
		if (turn.suppressAbortErrors) return true;
	}
	return false;
}

function isCursorProvenance(source: string): boolean {
	return source === "cursor-sdk-stack" || source === "cursor-extension-connect-stack" || source === "cursor-backend-details";
}

function isCursorSdkWriteIterableClosedError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.name === "WriteIterableClosedError" &&
		error.message === "WritableIterable is closed" &&
		/(?:^|[\\/])node_modules[\\/]@cursor[\\/]sdk[\\/]dist[\\/]/.test(error.stack ?? "")
	);
}

// The Cursor SDK aborts an in-flight controlled-exec turn via its internal
// `AbortController.abort()` (user interrupt or stall-detector cancellation),
// which surfaces as a raw `DOMException [AbortError]` rather than a
// `ConnectError`. `classifyCursorConnectError` returns undefined for it, so it
// otherwise falls through the emit patch and terminates the process. A
// DOMException is not `instanceof Error`, so match structurally on the
// `AbortError` name plus the same `@cursor/sdk/dist` stack provenance the
// WriteIterableClosedError recognizer uses, keeping unrelated AbortErrors fatal.
function isCursorSdkAbortError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const { name, stack } = error as { name?: unknown; stack?: unknown };
	return (
		name === "AbortError" &&
		typeof stack === "string" &&
		/(?:^|[\\/])node_modules[\\/]@cursor[\\/]sdk[\\/]dist[\\/]/.test(stack)
	);
}

function shouldSuppressProcessError(event: string | symbol, args: readonly unknown[]): boolean {
	if (event !== "uncaughtException" && event !== "unhandledRejection") return false;
	const error = args[0];
	if (isCursorSdkWriteIterableClosedError(error)) return guards.activeSessions.size > 0;
	// SDK stall timers and inter-turn teardown aborts never call suppressAbortErrors();
	// any active provider turn or session is enough — stack provenance already gates SDK-only AbortErrors.
	if (isCursorSdkAbortError(error)) return hasActiveGuard();
	// RetriableError "Connection stalled" / "Connection stalled repeatedly" is not a ConnectError; suppress during active turns only.
	if (isCursorSdkConnectionStalledError(error)) return guards.activeProviderTurns.size > 0;
	const classification = classifyCursorConnectError(error);
	if (!classification) return false;
	if (classification.kind === "abort") return hasActiveAbortSuppression();
	if (guards.activeProviderTurns.size === 0) return false;
	if (classification.kind === "network") return isCursorProvenance(classification.source) || classification.source === "connect-node-stack";
	return isCursorProvenance(classification.source);
}

function installProcessEmitPatch(): void {
	if (guards.cursorProcessEmit) {
		if (process.emit === guards.cursorProcessEmit) return;
		if (process.emit !== guards.originalProcessEmit) return;
		guards.cursorProcessEmit = undefined;
		guards.originalProcessEmit = undefined;
	}
	const forwardEmit = process.emit as GenericProcessEmit;
	guards.originalProcessEmit = forwardEmit;
	guards.cursorProcessEmit = function patchedCursorSdkProcessErrorEmit(this: NodeJS.Process, event: string | symbol, ...args: unknown[]): boolean {
		if (shouldSuppressProcessError(event, args)) return true;
		return forwardEmit.call(this, event, ...args);
	};
	process.emit = guards.cursorProcessEmit as typeof process.emit;
}

function isBunRuntime(): boolean {
	return typeof (process.versions as { bun?: string }).bun === "string";
}

function handleBunUnhandledRejection(error: unknown): void {
	if (shouldSuppressProcessError("unhandledRejection", [error])) return;
	// Without another rejection listener, retain Bun's default fatal behavior.
	if (process.listenerCount("unhandledRejection") === 1) throw error;
}

function installBunUnhandledRejectionListener(): void {
	if (!isBunRuntime() || guards.bunUnhandledRejectionListener) return;
	process.prependListener("unhandledRejection", handleBunUnhandledRejection);
	guards.bunUnhandledRejectionListener = handleBunUnhandledRejection;
}

function uninstallBunUnhandledRejectionListenerIfIdle(): void {
	if (hasActiveGuard() || !guards.bunUnhandledRejectionListener) return;
	process.off("unhandledRejection", guards.bunUnhandledRejectionListener);
	guards.bunUnhandledRejectionListener = undefined;
}

function uninstallProcessHooksIfIdle(): void {
	if (hasActiveGuard()) return;
	uninstallBunUnhandledRejectionListenerIfIdle();
	if (!guards.originalProcessEmit || !guards.cursorProcessEmit || process.emit !== guards.cursorProcessEmit) return;
	process.emit = guards.originalProcessEmit as typeof process.emit;
	guards.originalProcessEmit = undefined;
	guards.cursorProcessEmit = undefined;
}

function installProcessHooks(): void {
	installProcessEmitPatch();
	installBunUnhandledRejectionListener();
}

export const __testUtils = {
	activeProviderTurnCount: (): number => guards.activeProviderTurns.size,
	activeSessionCount: (): number => guards.activeSessions.size,
	resetLifecycleSessionGuard(): void {
		activeLifecycleSessionGuard?.dispose();
		activeLifecycleSessionGuard = undefined;
	},
};

export { isCursorSdkAbortConnectError };

export function installCursorSdkProcessErrorGuard(): CursorSdkProcessErrorGuard {
	const token: CursorSdkProcessErrorGuardToken = { suppressAbortErrors: false };
	guards.activeProviderTurns.add(token);
	installProcessHooks();
	let disposed = false;
	return {
		suppressAbortErrors(): void {
			if (disposed) return;
			token.suppressAbortErrors = true;
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			guards.activeProviderTurns.delete(token);
			uninstallProcessHooksIfIdle();
		},
	};
}

export function installCursorSdkSessionProcessErrorGuard(): CursorSdkSessionProcessErrorGuard {
	const token: CursorSdkSessionProcessErrorGuardToken = {};
	guards.activeSessions.add(token);
	installProcessHooks();
	let disposed = false;
	return {
		dispose(): void {
			if (disposed) return;
			disposed = true;
			guards.activeSessions.delete(token);
			uninstallProcessHooksIfIdle();
		},
	};
}

export function registerCursorSdkSessionProcessErrorGuard(pi: Pick<ExtensionAPI, "on">): void {
	pi.on("session_start", () => {
		activeLifecycleSessionGuard?.dispose();
		activeLifecycleSessionGuard = installCursorSdkSessionProcessErrorGuard();
	});
	pi.on("session_shutdown", () => {
		activeLifecycleSessionGuard?.dispose();
		activeLifecycleSessionGuard = undefined;
	});
}
