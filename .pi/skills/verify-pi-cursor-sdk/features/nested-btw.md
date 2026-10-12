# Nested /btw on cursor/*

A user on a sessionful `cursor/*` model runs `/btw …` (pi-btw). The side session must complete a Cursor provider turn instead of `Cursor request session id does not match the pi session id`.

## Sub-features

- **Isolation:** mismatched request `sessionId` is a nested Cursor run (`__request__:` pool); parent agent untouched.
- **Reuse:** same BTW child session id keeps the nested Cursor agent across turns (compaction one-shot ids still reset).
- **Composer:** bare `/btw` needs pi TUI; RPC/SDK must pass the question inline.

## How to get to it (user POV)

In pi TUI with `cursor/*` selected: `/btw 北京天气如何` or `/btw:ask …`. `~/.pi/agent/btw.json` `extensions: ["npm:pi-web-access"]` opts in `web_search` for `/btw`/`/side`/`/btw:tangent` after `/btw:clear`. `/btw:ask` never loads that file.

## Driving it with verify-pi-cursor-sdk.mjs

After the numeric allowance setup in [SKILL.md](../SKILL.md), reserve two turns with the owned isolated RPC drive. `VERIFY_PI_CURSOR_SDK_PAID=1 node .pi/skills/verify-pi-cursor-sdk/bin/drive-rpc.mjs nested-btw`. It loads installed pi-btw from `~/.pi/agent/npm/node_modules/pi-btw/extensions/btw.ts`; override with `VERIFY_PI_BTW_EXTENSION` if installed elsewhere. pi-btw and usable Cursor credentials are prerequisites. Offline pin: `npx vitest run test/cursor-provider-session-identity.test.ts`. Live (authorized):

- User action: RPC `prompt` `/btw:ask ping` with `--model cursor/grok-4.6` and an isolated session directory.
- Observable: successful RPC acknowledgement and `message_end` carrying `customType: btw-note` with the expected `details.answer`. The info notification only says the answer was displayed and does not contain its text. Separately inspect actions.jsonl `session_identity` reason `nested_request`; **no** `session_id_conflict`. Acknowledgement alone does not prove answer completion.
- User action: second `/btw` in the same child session after keep-pool is loaded in **this** pi process.
- Observable: second turn has no `agent_create` for that nested `scopeId` (first still may).

## Gotchas

- A running process must reload or restart to use updated extension code. Explicit nested-pool disposal on shutdown is not established by this feature; process exit is separate from scoped agent disposal.
- First `/btw` still pays agent creation and parent-transcript bootstrap. Reuse helps later turns, not the first turn.
- `web_search` is not a Cursor SDK default; it is pi-btw opt-in via `btw.json`.
- Do not prove this feature with `--help` flags.
