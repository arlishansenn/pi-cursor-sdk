# Pi sessionId and Cursor SDK identity — 2026-09-30

Research only. No new identity behavior was added for this note. The existing uncommitted Issue #3 diff remains.

## Loaded packages

| Package | Loaded version | Path |
| --- | --- | --- |
| `@earendil-works/pi-coding-agent` | 0.87.1 | `node_modules/@earendil-works/pi-coding-agent` |
| nested `@earendil-works/pi-agent-core` | 0.87.1 | `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core` |
| nested `@earendil-works/pi-ai` | 0.87.1 | `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai` |
| `@cursor/sdk` | 1.0.32 | `node_modules/@cursor/sdk` |

Pi coding-agent declares both Pi dependencies as `^0.87.1`. There is no second loaded Pi copy on this path.

## Identity mapping

| Value | Owner | Used for | Not used for |
| --- | --- | --- | --- |
| Pi `sessionId` | `SessionManager` header `id` | Pi agent stream `options.sessionId`; provider attribution headers; OpenAI-compatible `prompt_cache_key` and affinity headers when that adapter and retention allow it | Cursor agent id, checkpoint id, request id, or a cache-hit proof |
| Cursor `agentId` | SDK `Agent.create` / `Agent.resume` | Local agent row and resume | Pi session id. Public create options also have a caller-supplied `agentId`, separate from Pi's id |
| SDK `conversationId` | Internal protobuf message fields in `dist/esm/index.js` | Internal conversation records | Public `AgentOptions`. It is not a provider option |
| SDK `requestId` | Run creation and HTTP error context | One run/request | A session cache key. `prompt_cache`, `cacheRetention`, and `x-session` are absent from the installed SDK bundle |
| Checkpoint `rootBlobId` | Local agent row and run rows | Latest local conversation head | Pi message id or cache identity |

## Pi sessionId lifecycle

Evidence is installed `session-manager.js` and `agent-session.js`.

| Event | sessionId |
| --- | --- |
| `newSession` | New id, or an explicit valid id. Header stores it. |
| Open file | Header id replaces the in-memory id. |
| Reload | Same `SessionManager`; id stays with the file header. |
| `/tree` navigation | Same file and same session id. |
| Compaction | Same session id. `_runDefaultCompaction` calls `compact(..., sessionId=undefined)`, so the summary request does not reuse the session cache id. |
| Fork / branch copy | New session id. Tree navigation does not. |
| Provider stream | `Agent.sessionId` is copied into `createLoopConfig().sessionId`, then `streamFunction` receives it. |

`cacheRetention: "none"` drops `options.sessionId` before the OpenAI-compatible client creates affinity headers. Other retention values keep it. `prompt_cache_key` is set only for OpenAI-compatible requests when the base URL is OpenAI and retention is not `none`, or retention is `long` and the model supports it. Cursor's provider is not that adapter.

## Current diff assumptions

| Assumption | Result |
| --- | --- |
| Pi `options.sessionId` reaches this provider | Established by the installed agent loop and the Pi contract test. |
| A stable Pi session id proves a Cursor cache hit | False. The SDK bundle has no prompt-cache key or retention field. |
| Pi session id can be sent as Cursor `agentId` or `idempotencyKey` | Not done, and not supported by the public types. |
| Request/lifecycle id mismatch must fail before send | Implemented for the initial check and for a later lifecycle-scope generation change. |
| Request-only calls isolate by Pi session id | Implemented only as a local pool scope. This is not SDK session support. |

## `sendSessionAffinityHeaders: true` consumption

Loaded code: nested `@earendil-works/pi-ai` 0.87.1 under `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist`. This is the chain for an explicit `true`, not merely the header names.

### Compat merge

`models.json` is applied by `provider-composer.js`:

1. Built-in model `compat`.
2. Provider-level `models.json` `compat`, shallow-merged over the model.
3. A custom model definition's `compat`, shallow-merged over the provider compat.
4. Extension model replacement. This copies the extension model and does not run `mergeCompat`.
5. `models.json` `modelOverrides[model.id].compat`, shallow-merged last.

`mergeCompat` spreads the override over the base. A later explicit `false` replaces an earlier `true`. Nested routing objects are deep-merged. `sendSessionAffinityHeaders` is a boolean, so the last explicit value wins.

### Adapter defaults

| API | Explicit compat absent | `sessionAffinityFormat` absent |
| --- | --- | --- |
| `openai-completions` | `true` only when provider is `openrouter` or base URL contains `openrouter.ai`; otherwise `false` | OpenRouter gets `openrouter`; every other detected endpoint gets `openai` |
| `anthropic-messages` | same OpenRouter detection, otherwise `false` | OpenRouter gets `openrouter`; otherwise the format is unset |
| `openai-responses` | no boolean flag is read | OpenRouter detection returns `openrouter`; otherwise `openai` |
| `openai-codex-responses`, Azure, Bedrock, Mistral, pi-messages, faux | flag is not read | not applicable |

`PI_CACHE_RETENTION=long` changes the default retention to `long` when the call omits `cacheRetention`. An explicit `none`, `short`, or `long` wins.

### Header and body gates

`cacheRetention=none` removes `options.sessionId` before `createClient` for OpenAI completions, OpenAI responses, Anthropic, and Codex. `short` and `long` pass the original id through. The body uses the original option directly in the completions and responses adapters.

| API and `sendSessionAffinityHeaders: true` | `none` | `short` or `long` |
| --- | --- | --- |
| OpenAI completions, format `openrouter` | no session headers | `x-session-id: options.sessionId` |
| OpenAI completions, format `openai` | no session headers | `session_id`, `x-client-request-id`, and `x-session-affinity`, each set to `options.sessionId` |
| OpenAI completions, format `openai-nosession` | no session headers | `x-client-request-id` and `x-session-affinity`; no `session_id` |
| OpenAI completions body | no `prompt_cache_key` from this flag | `prompt_cache_key` only when base URL contains `api.openai.com`, or retention is `long` and `supportsLongCacheRetention` is true. `long` can also add `prompt_cache_retention: "24h"` |
| Anthropic, format `openrouter` | no session header | `x-session-id` |
| Anthropic, format unset or any non-`openrouter` value | no session header | `x-session-affinity` |
| OpenAI responses | no session headers and no `prompt_cache_key` | no boolean check. `openrouter` sends `x-session-id`; `openai` sends `session_id` and `x-client-request-id`; `openai-nosession` sends only `x-client-request-id`. Body `prompt_cache_key` uses the original session id |
| Codex responses | no Codex session id | no boolean check. The clamped session id becomes `prompt_cache_key`, SSE `session_id`, and the WebSocket request id |
| Azure responses | no flag and no retention gate in the installed body builder | `prompt_cache_key` is always clamped from `options.sessionId` |
| Mistral conversations | no flag | `promptCacheKey` when retention is not `none` and session id is present |
| Bedrock | no session id consumption | retention changes cache-point TTL only |
| pi-messages | no flag | forwards `cacheRetention` and the original `options.sessionId` in the JSON payload |
| faux provider | no flag | uses the original session id as an in-memory prefix-cache key when retention is not `none` |

`options.headers` are assigned after generated session headers in the OpenAI completions, OpenAI responses, and Anthropic client builders. A caller can replace `x-session-id`, `session_id`, `x-client-request-id`, or `x-session-affinity`. Anthropic OAuth returns before this API-key branch, so this flag does not add its header on that OAuth path.

### Custom `cursor-sdk` adapter

`src/index.ts` registers `api: "cursor-sdk"` and `streamSimple: streamCursorLazy`. Pi's generic agent loop still supplies the raw `options.sessionId` and the model object. The Cursor adapter does not read `model.compat.sendSessionAffinityHeaders`, `sessionAffinityFormat`, `cacheRetention`, or `options.headers`. Setting the flag to `true` on a Cursor model therefore does not create an HTTP session header or a Cursor cache key. The raw session id remains available to `streamCursor` separately from the flag.

## Not established

No cache-hit rate was measured. No SDK request was inspected for a hidden cache header. The authenticated checkpoint copy remains a temp-store result, not provider behavior.
