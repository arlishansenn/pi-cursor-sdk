---
name: verify-pi-cursor-sdk
description: Verify pi-cursor-sdk through isolated CLI and RPC commands, Cursor flags, print answers, native read replay, nested BTW reuse, and provider startup journals without attaching to the operator's live session.
---

# Verify pi-cursor-sdk

Use this repository skill to verify the checkout through its installed Pi CLI. Run commands from the repository root. Build before driving the extension. Never attach to the operator's live `~/.pi/agent/sessions` tree.

## Prepare

```bash
node .pi/skills/verify-pi-cursor-sdk/bin/verify-pi-cursor-sdk.mjs launch
node .pi/skills/verify-pi-cursor-sdk/bin/verify-pi-cursor-sdk.mjs doctor
node .pi/skills/verify-pi-cursor-sdk/bin/drive-rpc.mjs slash-cursor-tools
```

Launch runs a bounded build. Doctor checks the installed Pi version, provider probe help, and all four Cursor flags. These commands do not request model turns. `drive-extension-load` additionally lists Cursor models and requires successful provider/model rows. Model discovery may contact Cursor's catalog API. Catalog access is separate from the model-turn allowance.

Set `VERIFY_PI_BIN` to the supported Pi executable before driving. Without ambient `PI_PACKAGE_DIR`, the repo `node_modules/.bin/pi` launcher resolves the repository's own 0.87.1 dev dependency, not the supported 1.1.0 install; an operator shell inside pi inherits `PI_PACKAGE_DIR` and masks this. Every paid drive requires an explicit supported binary; `drive-print` records the resolved `pi --version` in its evidence, which is how this trap was caught.

Use the [complete feature map](features/README.md) to choose the required proof. CLI and RPC evidence do not establish rendered TUI state. This skill does not automate PTY rendering or screenshots.

## Authorize paid drives

The parent operator must approve a numeric aggregate model-turn allowance before any paid invocation. Do not invent a dollar budget. The following initialization is for the explicitly approved six additional turns in this publication run. Other runs need their own explicit approval.

```bash
export VERIFY_PI_CURSOR_BUDGET="$PWD/.artifacts/verify-pi-cursor-sdk/evidence/publication-budget.json"
node .pi/skills/verify-pi-cursor-sdk/bin/verify-pi-cursor-sdk.mjs budget-init "$VERIFY_PI_CURSOR_BUDGET" 6
export VERIFY_PI_CURSOR_SDK_PAID=1
# Supply CURSOR_API_KEY through the operator's existing secret environment.
node .pi/skills/verify-pi-cursor-sdk/bin/verify-pi-cursor-sdk.mjs budget-status "$VERIFY_PI_CURSOR_BUDGET"
```

Initialization refuses to overwrite a ledger. Every paid drive atomically reserves its full requested count before spawning. Reservations remain consumed after failures, timeouts, or interruptions. There is no refund or automatic replenishment. A concurrent reservation fails closed while the ledger lock exists. After a crash, inspect the ledger and `.next` file before resolving a stale `.lock` directory. Never reset the ledger to retry.

The allowance counts requested model turns, not upstream HTTP retries, tool calls, dollars, or tokens. Deadline and request-count limits are not a dollar or token guarantee. Children in this repair task run zero paid requests. The parent owns live proof.

## Run bounded proof

Each command below uses the same approved ledger and a key already present in the environment.

```bash
node .pi/skills/verify-pi-cursor-sdk/bin/verify-pi-cursor-sdk.mjs drive-print
node .pi/skills/verify-pi-cursor-sdk/bin/drive-rpc.mjs native-replay
node .pi/skills/verify-pi-cursor-sdk/bin/drive-rpc.mjs nested-btw
node .pi/skills/verify-pi-cursor-sdk/bin/verify-pi-cursor-sdk.mjs drive-provider-coldstart
node .pi/skills/verify-pi-cursor-sdk/bin/verify-pi-cursor-sdk.mjs budget-status "$VERIFY_PI_CURSOR_BUDGET"
```

Print reserves one turn. Native RPC reserves one turn and requires a successful matching `package.json` read plus an assistant package-name answer. BTW reserves two turns and requires two exact answers, the same nested scope, one successful agent creation, and no session identity conflict. Set `VERIFY_PI_BTW_EXTENSION` to override the default under the operator's home directory.

Coldstart reserves one turn by default. `--scenario provider-all-settings` and `--scenario provider-warmup-first-prompt` each reserve one. `--scenario provider-warm-second-turn` reserves two. The default sequence above consumes five of the six approved turns. The removed PTY drive consumes none. Do not spend the remaining turn without a reason within the approved task.

Print and RPC have a six-minute process deadline. Coldstart has a ten-minute deadline. Cleanup adds bounded grace periods through the product's `terminateChild` helper. Coldstart uses the direct selected scenario only inside this managed process group, with isolated environment and temporary directories. `status=ok` proves completed turns and phase availability, not a latency budget.

## Inspect evidence and cleanup

Each invocation writes `.artifacts/verify-pi-cursor-sdk/evidence/<feature>/run-*/`. Numbered command, stdout, stderr, and status files record each child. RPC also saves `events.json`. Action, usage, and probe/debug evidence is copied under `sinks/`. The canonical scrubber processes complete captures with the exact API key and bridge endpoint redaction. Assertions use raw in-memory or private scratch data before evidence scrubbing.

Private HOME, sessions, temporary files, and log sinks live under `.artifacts/verify-pi-cursor-sdk/runs/run-*/`. No auth files are copied from the operator's home. All model drives require the explicit key. Native replay switches are pinned, ambient settings default to `none`, and inherited SDK debug overrides are cleared. The coldstart `all` scenario explicitly enables its settings contrast within the isolated home, not the operator's settings.

PASS is written only after child-tree verification, evidence capture, and scratch removal. Failed cleanup retains private scratch and reports FAIL with its path. Treat retained scratch as sensitive. Do not delete it until the owned process tree is confirmed dead. The cleanup command refuses to delete retained scratch blindly.

```bash
node .pi/skills/verify-pi-cursor-sdk/bin/verify-pi-cursor-sdk.mjs cleanup
node --test .pi/skills/verify-pi-cursor-sdk/bin/tests/*.test.mjs
```

Offline tests use local child fixtures only. They do not call Pi models. Real model behavior remains unverified until the parent runs the authorized commands. This skill is an inner-loop check, not the macOS/Ubuntu release gate in `docs/platform-smoke.md`.
