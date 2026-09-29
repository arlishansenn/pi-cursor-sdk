import { describe, expect, it } from "vitest";
import type { CursorPiToolBridgeSnapshot } from "../src/cursor-pi-tool-bridge-types.js";
import { CursorPiToolBridgeRunImpl, type CursorPiToolBridgeRunHost } from "../src/cursor-pi-tool-bridge-run.js";
import { isCursorPiBridgeToolCallId } from "../src/cursor-pi-tool-bridge-constants.js";

const EMPTY_SNAPSHOT = {
	tools: [],
	mcpToolNameToPiToolName: new Map(),
	piToolNameToMcpToolName: new Map(),
} as unknown as CursorPiToolBridgeSnapshot;

function makeRunId(): string {
	const host = {} as unknown as CursorPiToolBridgeRunHost;
	return new CursorPiToolBridgeRunImpl(host, {}, EMPTY_SNAPSHOT, false).id;
}

describe("pi tool bridge call-id length", () => {
	it("keeps piToolCallId within the OpenAI Responses 64-char call_id limit for any counter", () => {
		const runId = makeRunId();
		// toolCallCounter is a plain instance counter; bound by MAX_SAFE_INTEGER digits.
		const worstCase = `${runId}-tool-${String(Number.MAX_SAFE_INTEGER)}`;
		expect(worstCase.length).toBeLessThanOrEqual(64);
	});

	it("recognizes new-format bridge ids", () => {
		const runId = makeRunId();
		expect(isCursorPiBridgeToolCallId(`${runId}-tool-0`)).toBe(true);
		expect(isCursorPiBridgeToolCallId(`${runId}-tool-10`)).toBe(true);
	});

	it("still recognizes legacy uuid run ids stored in existing sessions", () => {
		const legacy = "cursor-pi-bridge-run-0123abcd-45ef-6789-abcd-0123456789ab-tool-10";
		expect(legacy.length).toBe(65); // the exact poison shape recorded in real sessions (counter >= 10)
		expect(isCursorPiBridgeToolCallId(legacy)).toBe(true);
	});

	it("rejects non-bridge ids and bridge-internal routing ids", () => {
		expect(isCursorPiBridgeToolCallId("call_pMx4A")).toBe(false);
		expect(isCursorPiBridgeToolCallId(`${makeRunId()}-bridge-1`)).toBe(false);
	});
});
