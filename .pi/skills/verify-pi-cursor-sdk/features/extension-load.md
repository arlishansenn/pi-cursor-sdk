# Extension load (Cursor flags on pi --help)

The checkout is loaded as a pi extension so the CLI grows Cursor-owned flags without calling a model.

## Sub-features

- **Help flags:** `--cursor-fast`, `--cursor-no-fast`, `--cursor-mode`, `--cursor-local-resume` appear in `pi --approve -e . --help`.
- **List Cursor models:** `pi --approve -e . --no-session --list-models cursor` prints rows with separate `cursor` provider and model columns when the explicit environment key works. Listing can contact the catalog API. Listing failure fails this drive without invalidating the separately recorded help proof.

## How to get to it (user POV)

From the repo, after a build, run pi with `-e .`. Users see extra flags in `--help` and Cursor models in `--list-models cursor`.

## Driving it with verify-pi-cursor-sdk.mjs

- Launch: `node .pi/skills/verify-pi-cursor-sdk/bin/verify-pi-cursor-sdk.mjs launch`
- Doctor: `…mjs doctor`. isolated `--help` must contain the four flags.
- Drive: `…mjs drive-extension-load`
  - User action: load this extension → helper runs `pi --approve -e . --help` in a throwaway HOME.
  - Observable: `1.stdout.txt` contains `--cursor-no-fast` (and the other three); `summary.txt` has `help.flags=true`.
  - User action: list Cursor models → helper runs `--list-models cursor`.
  - Observable: `list-models.hasCursorId=true`, or a failed result if the command fails or returns no Cursor model rows.

## Gotchas

- Without `npm run build`, `-e .` loads stale or missing `dist/index.js`.
- Workspace `node_modules/.bin/pi` may resolve 0.87.1 once ambient `PI_PACKAGE_DIR` is removed; set `VERIFY_PI_BIN` to the supported install (see SKILL.md).
- `PI_CURSOR_SETTING_SOURCES=none` in isolated HOME so ambient plugins do not change `--help`.
- Never treat help-flag success as proof that `--list-models cursor` worked.
