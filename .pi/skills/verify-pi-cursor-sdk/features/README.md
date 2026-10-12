# Feature map

Verification source for **pi-cursor-sdk** as a pi extension (CLI/RPC, with manual TUI limits). Drive with `.pi/skills/verify-pi-cursor-sdk/bin/verify-pi-cursor-sdk.mjs` and `./node_modules/.bin/pi --approve -e .`. Isolated `HOME` only.

## Baseline

- `npm run build` so `dist/index.js` exists.
- Doctor is green (`…mjs doctor`).
- `PI_CURSOR_SETTING_SOURCES=none` in isolated runs unless a feature file says to load ambient Cursor plugins/hooks.
- Do not attach to `~/.pi/agent/sessions/` of a live operator session.
- Live `cursor/*` prompts and `drive-provider-coldstart` spend money; skip unless the operator asked (numeric allowance ledger, `VERIFY_PI_CURSOR_SDK_PAID=1`, and `CURSOR_API_KEY`; see [SKILL.md](../SKILL.md)).

## Driving conventions

- Prefer `--help` / `--list-models` / RPC `get_commands` over TUI screenshots.
- Stable handles: flag names, slash command names, JSONL `type` / `customType`, coldstart journal `action` names.
- Print-mode: redirect stdout to a file; do not pipe through `head`/`tail` (they buffer until exit).
- Coldstart: use `drive-provider-coldstart` (wraps `npm run debug:provider-coldstart` / `scripts/probe-provider-coldstart.mjs`), not a hand-rolled fake journal.

## Proof / skip

- **Proven:** command + captured stdout/stderr + status in `evidence/`.
- **Skip:** name the missing auth/resource and what was *not* claimed (for example, missing approval or credentials).

## Features

| File | User-facing |
| --- | --- |
| [extension-load.md](./extension-load.md) | Extension registers Cursor CLI flags |
| [print-mode.md](./print-mode.md) | One-shot `-p` Cursor turn |
| [slash-cursor-tools.md](./slash-cursor-tools.md) | `/cursor-tools` (RPC or TUI) |
| [nested-btw.md](./nested-btw.md) | `/btw` nested Cursor session |
| [native-replay.md](./native-replay.md) | Native replay cards vs MCP activity |
| [provider-coldstart.md](./provider-coldstart.md) | Provider first-turn phase timing (observation plane) |
