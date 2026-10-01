# Raw usage journal (schemaVersion 2)

The existing `CURSOR_SDK_USAGE_LOG` sink now records valid received `turn-ended.usage` callbacks independently of Pi message emission. Logging remains best-effort and can be disabled; this is not a durable billing ledger or a Cursor charge measurement.

## Raw record

- `schemaVersion: 2`, `source: "raw"`, `semantics: "sdk_raw_turn"`.
- `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`: original finite non-negative numeric counts, without rounding. Missing/invalid counts produce no raw record. A boundary without usage produces no record.
- `usageEventIndex`: starts at 1 per SDK send/coordinator, increments for each valid usage callback. Identical counts do **not** imply duplicates. No SDK step ID is inferred: `stepIdentity: "unknown"`.
- `runId`: SDK run ID; `runIdentity: "sdk_run"`. Callbacks before send returns are buffered and flushed once it returns. If send fails without returning an ID, flush with `runIdentity: "unavailable"` and no `runId`; subsequent callbacks are also immediately logged. Such records cannot prove a run identity.
- `turnId`, `mode`: initiating action/send correlation, retained across split Pi turns. `ts` is callback receipt time (not flush time). `session`, `model`, `provider`, `runtime` retain existing meanings.
- `inputSemantics`: `"full_prompt"` for local (observed local contract), `"unknown"` for cloud. Cache partition validity is recorded as `cachePartitionValid`, never used to suppress raw counts.
- Raw records have **no `totalTokens`**. Raw sums are not current context occupancy; neither raw nor reference-price estimates are billed charges.

Capture precedes live disposed/ignore/single-slot logic and bypasses context-window, output-budget, and cache-partition guards. Pi occupancy mapping, timeout isolation, estimates, and billed selection remain unchanged. Received callbacks after cancellation/error/release are retained; callbacks never delivered, process crashes, disk errors, and logging disabled remain coverage gaps. Nested-task updates are not automatically treated as top-level turn usage.

## Consumer compatibility / deduplication

Applied `source=turn|billed|estimate` records now have `schemaVersion: 2`, `semantics: "pi_usage_mapping"`; existing numeric fields and Pi behavior are unchanged. `turn` is the legacy mapping of a received raw measurement, **not additional spend**.

For raw measurement analysis:

1. Keep distinct raw events by `(runId, usageEventIndex)`. Deduplicate repeated imports of that identity, not equal counts or `(turnId,runId)` alone; conflicting records for one identity are an error, not last-write-wins.
2. For a run containing raw records, use only its raw stream for raw token/cache/reference-cost totals. Do not also add its legacy `source=turn` mappings. Suppress all same-run turn mappings even if they have a different Pi turnId. Do not mix raw with billed totals: billed is a separate authoritative-charge view if available.
3. For legacy runs with no raw records, the prior `billed > turn > estimate` selection may remain as a compatibility fallback, explicitly distinguished from raw coverage. `estimate` is never measured spend or a zero-cost substitute.
4. No-run records are incomplete identity: retain with provenance/import-line identity and `(turnId,usageEventIndex)` as a send-local hint only. Never merge all missing-run records or invent a reliable SDK step ID. Raw coverage does not prove that every model step was delivered.
5. Local reference pricing can partition `inputTokens - cacheReadTokens - cacheWriteTokens` only when `inputSemantics=full_prompt` and `cachePartitionValid=true`. Cloud/invalid partitions and unknown prices remain unknown, not zero.

Old consumers must explicitly ignore `source=raw` until upgraded; treating every source as additive or selecting an arbitrary first line is not compatible. This patch does not change token-lens. No release readiness is claimed without the paid platform gate and independent review.
