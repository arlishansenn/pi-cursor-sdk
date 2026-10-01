# Cursor ambient context-mode on the SDK local agent — 2026-10-01

Evidence for whether a machine-local Cursor **context-mode** install affects pi-cursor-sdk’s `@cursor/sdk` local agent. Wayfinder map: [arlishansenn/pi-cursor-sdk#10](https://github.com/arlishansenn/pi-cursor-sdk/issues/10). Fact rollup: [#15](https://github.com/arlishansenn/pi-cursor-sdk/issues/15).

**Verdict:** Yes on both layers under default `PI_CURSOR_SETTING_SOURCES=all`. Both layers turn off with `PI_CURSOR_SETTING_SOURCES=none` (empty `settingSources`).

| Layer | What | Gate | Config files |
| --- | --- | --- | --- |
| A — plugin MCP | `ctx_*` tools (e.g. `ctx_doctor`) | `plugins` or `all` | `~/.cursor/plugins/local/context-mode/.cursor-plugin/plugin.json` (`mcpServers`) |
| B — file hooks | `context-mode hook cursor …` | `user` / `project` / `mdm` or `all` | **`~/.cursor/hooks.json`** (SDK user path); plugin copy at `…/context-mode/hooks/cursor/hooks.json` |

context-mode is **not** required in `~/.cursor/mcp.json` (user MCP). That file is a separate `"user"` MCP layer.

## Packages / machine

| Item | Value |
| --- | --- |
| `@cursor/sdk` | `1.0.32` |
| pi gate | `PI_CURSOR_SETTING_SOURCES` → `shared/cursor-setting-sources.mjs` (default `["all"]`) |
| Plugin | `~/.cursor/plugins/local/context-mode` v1.0.169 |
| User hooks | `~/.cursor/hooks.json` (includes context-mode `preToolUse` / `postToolUse` / `sessionStart` / `afterAgentResponse` / `stop`) |

## Contract (docs + installed SDK)

- Official TypeScript SDK docs: local agents load plugin MCP when `local.settingSources` includes `"plugins"`; `"all"` includes plugins. User/project MCP files are separate layers. File hooks load from `~/.cursor/hooks.json` / project `.cursor/hooks.json`, gated by setting sources. Sources: [#11](https://github.com/arlishansenn/pi-cursor-sdk/issues/11), [#12](https://github.com/arlishansenn/pi-cursor-sdk/issues/12); research notes under `.artifacts/wayfinder-context-mode/` (local, not published).

## Live probes (same `Agent.create` `settingSources` gate pi-cursor-sdk passes)

Throwaway scripts (not package scripts): `.artifacts/wayfinder-context-mode/probe-ctx-tools.mjs`, `probe-hooks.mjs`. Model: `composer-2`.

### Layer A — `ctx_doctor`

| `settingSources` | Result |
| --- | --- |
| `["all"]` | `HAS_CTX=yes`; tool `ctx_doctor` |
| `["plugins"]` | same |
| `[]` | `HAS_CTX=no`; no `ctx_*` |

Ticket: [#13](https://github.com/arlishansenn/pi-cursor-sdk/issues/13).

### Layer B — hooks

Isolated `CONTEXT_MODE_DIR` plus temporary project stamp hooks.

| `settingSources` | Project stamps | context-mode session DB under `CONTEXT_MODE_DIR` |
| --- | --- | --- |
| `[]` | no | no |
| `["user"]` | no (project layer off) | yes (`session_meta` with SDK `agent-*` id) — user hooks / `sessionStart`, not plugin MCP |
| `["all"]` | `sessionStart` + `preToolUse` | yes |

Ticket: [#14](https://github.com/arlishansenn/pi-cursor-sdk/issues/14).

## Operator meaning

- Default pi Cursor runs **do** pick up a machine-local context-mode plugin and user hooks.
- Minimal surface (no ambient Cursor layers): `PI_CURSOR_SETTING_SOURCES=none`.
- Debug: `/cursor-tools` shows effective `PI_CURSOR_SETTING_SOURCES`. See [Cursor tool surfaces](../cursor-tool-surfaces.md).

## Out of scope here

Product default changes, runbooks beyond the paths/gates above, and other plugin assets (rules / `.mdc`) were not part of this evidence.
