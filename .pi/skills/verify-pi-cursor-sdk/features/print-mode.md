# Print-mode one-shot Cursor turn

A user asks pi a single prompt (`-p` / `--print`) on a `cursor/*` model and gets assistant text on stdout, then the process exits.

## Sub-features

- **No-session print:** `--no-session -p "…"` with `--model cursor/grok-4.6` (or `cursor/grok-4.6:slow` when that variant exists).
- **Sessionful print:** `--session-dir` / `--session-id` when proving ledgers. not this inner-loop default.

## How to get to it (user POV)

`pi --approve -e . --model cursor/grok-4.6 --cursor-no-fast --no-session -p "hello"` after a build. Needs Cursor credentials.

## Driving it with verify-pi-cursor-sdk.mjs

After the numeric allowance setup in [SKILL.md](../SKILL.md), run:

```bash
node .pi/skills/verify-pi-cursor-sdk/bin/verify-pi-cursor-sdk.mjs drive-print
```

This reserves one turn and runs the child under a user-parity environment: disposable HOME and `PI_CODING_AGENT_DIR`, `PI_CURSOR_SETTING_SOURCES=none`, with behavioral overrides (`PI_CURSOR_PI_TOOL_BRIDGE`, native display/registration, builtin exposure) and actions/usage/debug log variables deleted so extension defaults apply, matching a real `pi -p` invocation. `pi --version` is captured beside the answer. Earlier sealed-env variants forced bridge/native flags and redirected `TMPDIR`/XDG; they did not reproduce the user path and hung before `agent_send`. Require zero exit and the standalone `VERIFY_PRINT_OK` answer. The helper rejects the session identity conflict message and captures complete scrubbed stdout and stderr. Do not replace this with an unbounded manual print command.

## Gotchas

- **Spends** Cursor quota. Skip unless asked.
- pi print mode reads a non-TTY stdin to EOF before dispatching; a spawned child with an open stdin pipe hangs until deadline. The helper closes stdin for the print child.
- Do not pipe stdout through `head`/`tail`.
- Cold startup can take minutes. Deadline failure is a failed sample, not permission for an unreserved retry.
- Compaction-window vs nested `/btw` isolation is a different feature (`nested-btw.md`).
