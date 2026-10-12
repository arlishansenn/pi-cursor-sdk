# Provider cold-start phase timing (observation plane)

A maintainer measures the first local Cursor **provider** turn so slowdowns can be attributed to phases (`sdk_load`, `bridge_setup`, `store_open`, `agent_create` / resume, `agent_send`, `first_text`), not guessed from wall clock alone. Discovery and explicit SDK preload happen before sampling, so this does not measure total process startup or initial SDK module load. This is the PR #38 observation plane path, not a latency fix.

## Sub-features

- **Default scenario:** `provider-no-setting-sources` (`PI_CURSOR_SETTING_SOURCES=none`, one turn) via `scripts/probe-provider-coldstart.mjs`.
- **Ambient contrast:** `--scenario provider-all-settings` (`settingSources=all`).
- **Warm second turn:** `--scenario provider-warm-second-turn` (none sources, two turns in one process).
- **Warm-arm A/B (PR #43):** `--scenario provider-warmup-first-prompt` schedules the same-key create-ahead exactly as the extension's session_start hook would, waits for `warmReady`, then samples one prompt. Running the full probe (no `--scenario`) also emits `equivalence.json` comparing the cold and warm arms' captured send prompt/payload after normalizing work-dir paths and labels. This helper does not run the full comparison.
- **Offline diagnose:** after a journal exists, helper runs `diagnoseCursorStartup({ journals, comparison: null })` into `diagnosis.json`.

## How to get to it (user POV)

Users feel "first Cursor provider turn is slow." Maintainers do not feel it in `--help`. They run the provider coldstart probe (or this verify drive) with a Cursor key and inspect journals / diagnosis under evidence.

## Driving it with verify-pi-cursor-sdk.mjs

Paid and opt-in only. Complete the numeric allowance setup in [SKILL.md](../SKILL.md). Missing authorization fails before spawning. The default scenario reserves one turn. Warm-second-turn reserves two.

```bash
node .pi/skills/verify-pi-cursor-sdk/bin/verify-pi-cursor-sdk.mjs launch
node .pi/skills/verify-pi-cursor-sdk/bin/verify-pi-cursor-sdk.mjs doctor
VERIFY_PI_CURSOR_SDK_PAID=1 CURSOR_API_KEY="…" \
  node .pi/skills/verify-pi-cursor-sdk/bin/verify-pi-cursor-sdk.mjs drive-provider-coldstart
# optional: --scenario provider-all-settings | provider-warmup-first-prompt
node .pi/skills/verify-pi-cursor-sdk/bin/verify-pi-cursor-sdk.mjs cleanup
```

- User/maintainer action: authorize paid provider coldstart → helper runs `probe-provider-coldstart.mjs --scenario … --out-dir <evidence>`.
- Observable: `summary.txt` has `status=ok`; `sinks/probe/*.actions.jsonl` present; inspect journal actions for `sdk_load`, `store_open`, `agent_create`, `agent_send`, and `first_text` (`bridge_setup` may be absent when the probe does not mount the pi tool bridge).
- Observable: `diagnosis.json` with `verdict.kind="descriptive"`, because this helper always passes `comparison:null`. `status=ok` records available phases, not a latency-budget pass. Warm-arm proof additionally requires `warmReady=true` and `sendsBeforeFirstTurn=0` in the scenario JSON.
- Without approval, ledger allowance, or `CURSOR_API_KEY`, the helper fails before spawning. Do not claim phase timings.

## Gotchas

- **Spends** Cursor quota. Never default in doctor or extension-load.
- Probe path uses the extension provider (`streamCursor`), not a full interactive pi TUI. Still the real provider prepare/create/send/first-text chain.
- This probe often has **no** `bridge_setup` span (no pi tool bridge). Absence is not a failed create/send proof.
- The `all` scenario loads settings from the isolated home, not the operator home.
- Missing authorization is not a phase-budget pass.
- Distinct from direct SDK `npm run debug:mcp-coldstart` (no provider wrapper).
