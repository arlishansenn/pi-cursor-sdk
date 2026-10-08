# Context: pi-cursor-sdk

Single-context repo. Glossary below; decisions live in `docs/adr/`. Anchors point to source of truth. Keep entries verifiable: cite the file that defines the behavior, not chat notes.

## Glossary

| Term | Meaning | Anchor |
| --- | --- | --- |
| ambient | Settings the Cursor SDK loads from the machine's Cursor configuration (user/project MCP, plugins, rules, file hooks), gated by the `settingSources` option on `Agent.create`. Default **none** (the option is omitted entirely); `PI_CURSOR_SETTING_SOURCES=all` restores ambient loading. Flipped from `all` in PR #39 to cut first-send latency. | `shared/cursor-setting-sources.mjs`, `src/cursor-session-agent.ts` |
| session agent | One Cursor SDK agent owned by a Pi session scope, held in the session pool with its store, bridge run, and send state. | `src/cursor-session-agent.ts` |
| session pool | `sessionAgentsByScope`: per-scope `creating`/`ready`/`busy` entries. Pool hit reuses the agent; empty pool may create or resume. | `src/cursor-session-agent.ts` |
| pool key | Identity of a pool entry: scopeKey, cwd, model selection, settingSources, local safety, http1, apiKey fingerprint, bridge surface signature. A changed key replaces the entry. | `buildSessionAgentPoolKey` in `src/cursor-session-agent.ts` |
| Pi scope / scopeKey | The extension's isolation and queue identity. Normally the lifecycle session; nested requests use `__request__:<requestSessionId>`. | `src/cursor-session-scope.ts` |
| nested Cursor run | A request whose sessionId differs from the lifecycle id (pi-btw `/btw` child, compaction summarization). Isolated on its own request pool; never borrows the parent agent. Compaction ids are one-shot; reused `/btw` ids keep their agent. | `src/cursor-provider.ts`, `docs/adr/0001` |
| first text | Turn start to the first non-empty `text-delta`. Journaled as action `first_text`; no text content is stored. | `src/cursor-actions-log.ts` |
| bootstrap / incremental send | First send carries full Pi context (system, transcript, tool boundary); compatible later sends carry only the latest user message. Governed by send state and context fingerprint. | `src/cursor-session-send-policy.ts`, `src/context.ts` |
| send state | `{ bootstrapped, contextFingerprint, incrementalSendCount }` per pool entry. Only a finished run commits it. | `src/cursor-session-agent.ts` |
| checkpoint restore | Restore a prior conversation position: prefer rewinding the same idle agent to a saved head; copy blobs to a new agent as fallback. Default on. | `src/cursor-checkpoint-restore.ts`, `docs/adr/0001` |
| rewind marker | Custom entry marking an agent whose head was rewound; persisted resume handles for a marked agent are refused. | `src/cursor-checkpoint-ledger.ts` |
| pi tool bridge | The extension's own loopback MCP exposing active pi tools as `pi__*`. Distinct from ambient MCP: disabling ambient does not remove bridge tools. | `src/cursor-pi-tool-bridge.ts`, `docs/cursor-tool-surfaces.md` |
| observation plane | PR #38's measurement surface: journal spans (`sdk_load`, `bridge_setup`, `store_open`, `first_text`, …), offline `diagnoseCursorStartup`, and `debug:provider-coldstart`. No latency behavior change. PR #43 added the warm-arm scenario and the two-arm `compareWarmupPromptEquivalence` (send-side byte equality, zero pre-prompt upstream sends). | `src/cursor-startup-diagnostics.ts`, `scripts/probe-provider-coldstart.mjs` |
| same-key create-ahead | PR #40's warmup: `session_start`/`model_select` asynchronously publish one pool entry under the key the next prompt is expected to acquire (`scheduleSessionCursorAgentWarmup`). First prompt joins ready/in-flight creation; skipped for cloud, invalid mode, missing key, occupied pools, and any scope with checkpoint history. Journaled as `agent_warm` with one `warm_hit_*` per warmed entry, recorded by the first demand lease. | `src/cursor-session-agent.ts`, `src/index.ts` |
| process-resume obligation | `requiresProcessResumeBootstrap` on a lease: a pool entry resumed from a persisted handle owes one conservative bootstrap send regardless of which acquire leased it (fixes the concurrent-joiner hole). Cleared only by that entry's successful bootstrap commit; checkpoint-target resumes never set it. | `src/cursor-session-agent.ts`, `src/cursor-provider-turn-prepare.ts` |
| HTTP/1.1 capture lock | The SDK reads its HTTP/1.1 preference lazily when constructing a transport, so every local create/resume runs `configureCursorSdkHttp1` → bridge → store → create under `runWithCursorSdkHttp1Lock`; lifecycle resets take the same lock. Pool-key value and SDK configure share `resolveCursorSdkHttp1ForAgent`. | `src/cursor-http1.ts`, `src/cursor-session-agent.ts` |
